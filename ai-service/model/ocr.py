import gc
import io
import os
import time
import torch
import filetype as ft
from PIL import Image
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from chandra.model.hf import load_model, generate_hf
from chandra.model.schema import BatchInputItem
from chandra.output import parse_markdown
from chandra.settings import settings

# Cap CPU threads before the model loads. Defaults match the local M3 Pro tuning
# (leaves cores free for the OS/browser); in a container set these to the
# replica's vCPU count via TORCH_NUM_THREADS so torch doesn't oversubscribe the
# cgroup CPU limit. A value of 0 leaves torch's own default in place.
_n_threads = int(os.environ.get("TORCH_NUM_THREADS", "6"))
_n_interop = int(os.environ.get("TORCH_INTEROP_THREADS", "3"))
if _n_threads > 0:
    torch.set_num_threads(_n_threads)
if _n_interop > 0:
    torch.set_num_interop_threads(_n_interop)

# chandra's internal cap is 3072×2048 (~34 GiB attention on M3 Pro).
# 1280 on the long side → ~6 k tokens → ~4.4 GiB attention, safely within 18 GB unified memory.
_MAX_LONG_SIDE = 1280

_model = None


def _get_model():
    global _model
    if _model is None:
        print("[OCR] Loading chandra model...")
        _model = load_model()
        print("[OCR] Model ready")
    return _model


def model_loaded() -> bool:
    """True once the weights are resident — used by the /health readiness probe."""
    return _model is not None


def _cap_image(image: Image.Image) -> tuple[Image.Image, bool]:
    """Downscale if the long side exceeds _MAX_LONG_SIDE. Returns (image, was_downscaled)."""
    long_side = max(image.width, image.height)
    if long_side > _MAX_LONG_SIDE:
        scale = _MAX_LONG_SIDE / long_side
        image = image.resize(
            (int(image.width * scale), int(image.height * scale)),
            Image.Resampling.LANCZOS,
        )
        print(f"[OCR] Downscaled to {image.width}×{image.height} (memory cap)")
        return image, True
    return image, False


def cleanup_mps():
    """Force Python GC then drain and release the MPS cache."""
    gc.collect()
    if torch.backends.mps.is_available():
        try:
            torch.mps.synchronize()
            torch.mps.empty_cache()
        except Exception as e:
            print(f"[OCR] MPS cleanup warning: {e}")
    gc.collect()


def _flatten_page(page):
    rc = pdfium_c.FPDFPage_Flatten(page, pdfium_c.FLAT_NORMALDISPLAY)
    if rc == pdfium_c.FLATTEN_FAIL:
        print("[OCR] Warning: failed to flatten annotations on page")


def _ocr_image(image: Image.Image, model, label: str) -> tuple[str, dict]:
    """OCR a single PIL image. Cleans up GPU memory before, during, and after."""
    cleanup_mps()

    t = time.time()
    batch = [BatchInputItem(image=image, prompt_type="ocr")]
    with torch.inference_mode():
        results = generate_hf(batch, model)

    cleanup_mps()

    text = "".join(parse_markdown(r.raw) for r in results)
    stage = {"label": label, "ms": _ms(t)}

    del batch, results
    cleanup_mps()

    return text, stage


def run_ocr(file_bytes: bytes) -> dict:
    """
    Run OCR on file bytes. Returns:
      text       — full markdown string
      stages     — list of timing entries for the flow panel
      meta       — file type, page count, per-page dims and char counts
    """
    stages = []
    page_metas = []
    model = _get_model()
    pages = []

    kind = ft.guess(file_bytes)
    is_pdf = kind and kind.extension == "pdf"
    file_type = "pdf" if is_pdf else "image"
    print(f"[OCR] File type: {file_type} ({len(file_bytes)} bytes)")

    if is_pdf:
        doc = pdfium.PdfDocument(file_bytes)
        doc.init_forms()
        page_count = len(doc)
        print(f"[OCR] PDF has {page_count} page(s)")

        for i in range(page_count):
            page = doc[i]
            min_dim = min(page.get_width(), page.get_height())
            scale_dpi = max((settings.MIN_PDF_IMAGE_DIM / min_dim) * 72, settings.IMAGE_DPI)
            _flatten_page(page)
            image = doc[i].render(scale=scale_dpi / 72).to_pil().convert("RGB")

            original_width, original_height = image.width, image.height
            print(f"[OCR] Page {i + 1} rendered at {original_width}×{original_height}")

            image, downscaled = _cap_image(image)
            model_width, model_height = image.width, image.height

            text, stage = _ocr_image(image, model, f"OCR page {i + 1} of {page_count}")
            char_count = len(text)
            print(f"[OCR] Page {i + 1} → {char_count} chars in {stage['ms']} ms")

            pages.append(text)
            stages.append(stage)
            page_metas.append({
                "index":           i + 1,
                "original_width":  original_width,
                "original_height": original_height,
                "model_width":     model_width,
                "model_height":    model_height,
                "downscaled":      downscaled,
                "char_count":      char_count,
                "ms":              stage["ms"],
            })

            del image
            cleanup_mps()

        doc.close()

    else:
        image = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        original_width, original_height = image.width, image.height
        print(f"[OCR] Image dimensions: {original_width}×{original_height}")

        min_dim = settings.MIN_IMAGE_DIM
        if image.width < min_dim or image.height < min_dim:
            scale = min_dim / min(image.width, image.height)
            image = image.resize(
                (int(image.width * scale), int(image.height * scale)),
                Image.Resampling.LANCZOS,
            )

        image, downscaled = _cap_image(image)
        model_width, model_height = image.width, image.height

        text, stage = _ocr_image(image, model, "OCR page 1 of 1")
        char_count = len(text)
        print(f"[OCR] Extracted {char_count} chars in {stage['ms']} ms")

        pages.append(text)
        stages.append(stage)
        page_metas.append({
            "index":           1,
            "original_width":  original_width,
            "original_height": original_height,
            "model_width":     model_width,
            "model_height":    model_height,
            "downscaled":      downscaled,
            "char_count":      char_count,
            "ms":              stage["ms"],
        })

        del image
        cleanup_mps()

    t = time.time()
    text = "\n\n---\n\n".join(pages)
    stages.append({"label": "Assembled markdown output", "ms": _ms(t)})

    total_chars = sum(p["char_count"] for p in page_metas)
    print(f"[OCR] Done — {len(pages)} page(s), {total_chars} total chars")

    return {
        "text":   text,
        "stages": stages,
        "meta": {
            "file_type":   file_type,
            "page_count":  len(pages),
            "total_chars": total_chars,
            "pages":       page_metas,
        },
    }


def _ms(start: float) -> int:
    return int((time.time() - start) * 1000)
