import json
import os
import re
import time
from io import BytesIO
from uuid import uuid4

from PIL import Image

import requests

from ocr_service import _get_mime_type
from observability.ocr_request_capture import record_batch_ocr_request
from observability.raw_response_capture import save_raw_student_ocr_response


_EXTRACT_URL = "https://www.datalab.to/api/v1/extract"
_MAX_POLLS = 150
_POLL_SECONDS = 2

_STUDENT_OCR_SCHEMA = json.dumps({
    "type": "object",
    "title": "StudentScript",
    "description": "Separates a student's handwritten answer from printed exam material",
    "properties": {
        "handwritten_work": {
            "type": "string",
            "description": (
                "The student's own handwritten work on the document, transcribed "
                "verbatim exactly as written. Preserve the original wording, "
                "spelling, punctuation and paragraph breaks. Include any crossings-out "
                "or corrections the student made. Do NOT include printed or typed text "
                "from the exam paper."
            ),
        },
        "printed_text": {
            "type": "string",
            "description": (
                "All printed or machine-typed text on the document that is not the "
                "student's handwriting — for example the exam question, mark allocations "
                "such as '(15)', question numbers, page headers and footers."
            ),
        },
        "other": {
            "type": "string",
            "description": (
                "Any content that is neither the student's handwritten work nor printed "
                "or machine-typed exam material. Return an empty string when there is no "
                "such content."
            ),
        },
    },
    "required": ["handwritten_work", "printed_text", "other"],
})


def _extract_student_ocr_result(
    file_bytes: bytes, filename: str, deadline: float | None = None,
    schema: str = _STUDENT_OCR_SCHEMA,
    monitor: dict | None = None,
) -> tuple[dict, dict]:
    api_key = os.getenv("DATALAB_API_KEY")
    if not api_key:
        raise ValueError("DATALAB_API_KEY not found in environment variables")

    def remaining_time() -> float:
        if deadline is None:
            return 300.0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Student marking OCR exceeded its processing deadline")
        return remaining

    timeout = (min(10, remaining_time()), remaining_time())
    started = time.monotonic()
    request_id = uuid4().hex
    if monitor is not None:
        monitor["request_id"] = request_id

    def capture(phase: str, **details) -> None:
        if monitor is not None:
            record_batch_ocr_request(monitor["run_key"], {
                "request_id": request_id,
                "batch_key": monitor["batch_key"],
                "user_slot": monitor["user_slot"],
                "file_count": monitor["file_count"],
                "phase": phase,
                "duration_ms": round((time.monotonic() - started) * 1000),
                **details,
            })

    capture("started")
    try:
        response = requests.post(
            _EXTRACT_URL,
            files={
                "file": (filename, file_bytes, _get_mime_type(filename)),
                "page_schema": (None, schema),
            },
            data={"output_format": "json"},
            headers={"X-Api-Key": api_key},
            timeout=timeout,
        )
        capture("accepted" if response.status_code == 200 else "rejected",
                http_status=response.status_code)
        if response.status_code != 200:
            raise Exception(f"Datalab Extract API error: {response.status_code} {response.text}")

        check_url = response.json().get("request_check_url")
        if not check_url:
            raise Exception("No check URL returned from Datalab Extract API")

        for _ in range(_MAX_POLLS):
            time.sleep(min(_POLL_SECONDS, remaining_time()))
            result = requests.get(
                check_url, headers={"X-Api-Key": api_key},
                timeout=(min(10, remaining_time()), remaining_time()),
            )
            if result.status_code != 200:
                raise Exception(f"Datalab Extract polling error: {result.status_code} {result.text}")

            result_data = result.json()
            if result_data.get("status") == "complete":
                capture("completed", page_count=result_data.get("page_count"))
                extracted = result_data.get("extraction_schema_json")
                structured_ocr = json.loads(extracted) if isinstance(extracted, str) else (extracted or {})
                return structured_ocr, result_data

            if result_data.get("status") == "failed":
                raise Exception(f"Datalab Extract failed: {result_data.get('error', 'unknown error')}")

        raise Exception("Datalab Extract timed out after 300 seconds")
    except Exception as error:
        capture("failed", error_type=type(error).__name__, error=str(error)[:250])
        raise


def _extract_student_ocr_response(
    file_bytes: bytes, filename: str, deadline: float | None = None
) -> tuple[dict, dict]:
    structured, result = _extract_student_ocr_result(file_bytes, filename, deadline)
    return structured, result.get("json") or {}


def build_student_pdf_batch(jpegs: list[bytes]) -> bytes:
    """Pillow writes each JPEG as one page of a single combined PDF."""
    pages = []
    try:
        for jpeg in jpegs:
            image = Image.open(BytesIO(jpeg))
            # iPhone portrait JPEGs can identify as MPO; the first frame is
            # the ordinary photo used by this local marking test.
            if image.format not in ("JPEG", "MPO"):
                image.close()
                raise ValueError("Batch mode requires JPEG student files")
            image.seek(0)
            rgb = image.convert("RGB")
            pages.append(rgb.resize((max(1, rgb.width * 2 // 3),
                                     max(1, rgb.height * 2 // 3))))
            rgb.close()
            image.close()
        output = BytesIO()
        # These local JPEGs need a smaller merged upload: at full size the
        # six-page Datalab POST timed out, while this size completed.
        pages[0].save(output, format="PDF", save_all=True,
                      append_images=pages[1:], quality=50)
        return output.getvalue()
    finally:
        for page in pages:
            page.close()


def extract_student_ocr_batch(
    jpegs: list[bytes], deadline: float, monitor: dict | None = None
) -> list[str | None]:
    count = len(jpegs)
    if not 1 <= count <= 6:
        raise ValueError("OCR batch must contain 1 to 6 JPEGs")
    return extract_student_ocr_pdf(build_student_pdf_batch(jpegs), count, deadline, monitor)


def extract_student_ocr_pdf(
    pdf_bytes: bytes, count: int, deadline: float,
    monitor: dict | None = None,
) -> list[str | None]:
    if not 1 <= count <= 6:
        raise ValueError("OCR request must contain 1 to 6 pages")
    fields = {}
    for index in range(count):
        fields[f"handwritten_work_page_{index}"] = {
            "type": "string",
            "description": (
                f"Transcribe ONLY the student's handwritten answer on PDF page "
                f"{index + 1} (zero-based page index {index}). Preserve the "
                "student's wording and paragraph breaks. Exclude printed text."
            ),
        }
    schema = json.dumps({
        "type": "object", "title": "StudentBatch", "properties": fields,
        "required": list(fields),
    })
    structured, result = _extract_student_ocr_result(
        pdf_bytes, "student-batch.pdf", deadline, schema, monitor
    )
    save_raw_student_ocr_response(structured, result)

    def capture_validation(phase: str, error: str | None = None) -> None:
        if monitor is not None and monitor.get("request_id"):
            record_batch_ocr_request(monitor["run_key"], {
                "request_id": monitor["request_id"],
                "batch_key": monitor["batch_key"],
                "user_slot": monitor["user_slot"],
                "file_count": monitor["file_count"],
                "phase": phase,
                "page_count": result.get("page_count"),
                **({"error": error} if error else {}),
            })

    try:
        if result.get("page_count") != count or (result.get("metadata") or {}).get("failed_pages"):
            raise ValueError("Datalab did not process every batch page")

        texts = []
        for index in range(count):
            field = f"handwritten_work_page_{index}"
            value = structured.get(field)
            if not isinstance(value, str):
                raise ValueError(f"Could not map OCR text to batch page {index}")
            if not value.strip():
                texts.append(None)
                continue
            citations = structured.get(f"{field}_citations") or (
                structured.get(f"{field}_meta") or {}
            ).get("citations") or []
            cited_pages = [
                match.group(1) if (match := re.match(r"^/page/(\d+)/", str(citation)))
                else None for citation in citations
            ]
            if (not cited_pages or any(page != str(index) for page in cited_pages)):
                raise ValueError(f"Could not map OCR text to batch page {index}")
            texts.append(value)
    except ValueError as error:
        capture_validation("validation_failed", str(error))
        raise
    capture_validation("validated")
    return texts


def extract_student_ocr(file_bytes: bytes, filename: str, deadline: float | None = None) -> dict:
    structured_ocr, _ = _extract_student_ocr_response(file_bytes, filename, deadline)
    return structured_ocr


def extract_student_ocr_with_raw(
    file_bytes: bytes, filename: str, deadline: float | None = None
) -> tuple[dict, dict]:
    return _extract_student_ocr_response(file_bytes, filename, deadline)
