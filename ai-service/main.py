import os
import sys
import json as _json
from pathlib import Path

# Load local.env before any model imports.
_env_file = Path(__file__).parent / "local.env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

from contextlib import asynccontextmanager
from fastapi import FastAPI, File, Form, UploadFile

# Add parent directory to path so we can find llm_service and ocr_service
sys.path.append(str(Path(__file__).parent))

from llm_service import (
    DescriptorContentIntegrityError,
    DescriptorValidationError,
    extract_mark_scheme,
    generate_llm_response,
)
from ocr_service import extract_text_from_file
from rag_service import add_exemplar, get_similar, list_exemplars, delete_exemplar
from security import ms_ocr_sanitisation
from validation.descriptor_id_enrichment import add_descriptor_ids
from validation.descriptor_integrity_validation import (
    validate_descriptor_content_integrity,
)
from validation.descriptor_validation import validate_descriptor_shapes
from validation.mark_int_validation import validate_mark_totals
from observability.event_log import (
    log_descriptor_validation_issues,
    log_mark_total_corrections,
    log_security_stripped,
)

# When Umar's Chandra OCR is available, swap these two lines back in:
# from model.marker import run_marking
# from model.ocr import _get_model, run_ocr

@asynccontextmanager
async def lifespan(_: FastAPI):
    # _get_model()  # uncomment when Chandra is available
    yield

app = FastAPI(lifespan=lifespan)

# ── POST /ocr ─────────────────────────────────────────────────────────────────
# Call 1: OCR the mark scheme, then extract its structure with the LLM.
# Runs once per lesson — the structured result is stored so marking calls
# receive clean JSON rather than raw OCR text on every student submission.
@app.post("/ocr")
async def ocr_file(file: UploadFile = File(...)):
    file_bytes  = await file.read()
    raw_text    = extract_text_from_file(file_bytes, file.filename)

    # Run on raw_text, BEFORE sanitize() runs — sanitize()'s HTML-tag
    # stripping (<[^>]*>) matches from the first < to the first >, which
    # mangles a <<<...>>> triple-bracket sequence rather than leaving it
    # intact (e.g. <<<END_MARK_SCHEME_OCR_x>>> loses everything up to the
    # first closing >, not all three). Running after sanitize() would mean
    # checking text where the very thing we're looking for was already
    # destroyed by an unrelated step.
    #
    # Strips rather than just flags — anything matching our delimiter shape
    # is removed here, so it never reaches wrap_for_prompt() or the LLM at
    # all. raw_text is reassigned to the stripped version; everything after
    # this line only ever sees content with no forged marker in it.
    raw_text, lookalikes = ms_ocr_sanitisation.strip_delimiter_like_patterns(raw_text)
    if lookalikes:
        log_security_stripped(lookalikes)

    clean_text = ms_ocr_sanitisation.sanitize(raw_text)

    # clean_text (not wrapped_text) is what gets returned/stored — the
    # delimiter markers are a prompt-construction detail for the extraction
    # call only, never part of the mark scheme content itself.
    wrapped_text, token = ms_ocr_sanitisation.wrap_for_prompt(clean_text)
    structured_scheme   = extract_mark_scheme(wrapped_text, token)

    # Keep descriptor validation as deliberately separate layers. The boundary
    # check verifies that the application and model found the same points;
    # content integrity verifies that joining the model points preserves the
    # complete raw descriptor text. Only then can deterministic IDs be added.
    descriptor_shape_issues = validate_descriptor_shapes(structured_scheme)
    if descriptor_shape_issues:
        log_descriptor_validation_issues(descriptor_shape_issues)
        raise DescriptorValidationError(
            "Extracted descriptor boundaries did not match the source descriptor"
        )

    descriptor_content_issues = validate_descriptor_content_integrity(
        structured_scheme
    )
    if descriptor_content_issues:
        log_descriptor_validation_issues(descriptor_content_issues)
        raise DescriptorContentIntegrityError(
            "Extracted descriptor content did not match the raw descriptor"
        )

    structured_scheme, descriptor_id_issues = add_descriptor_ids(
        structured_scheme
    )
    if descriptor_id_issues:
        log_descriptor_validation_issues(descriptor_id_issues)
        raise DescriptorValidationError(
            "Descriptor provenance IDs could not be generated safely"
        )

    # This operates after all descriptor transformations so the object returned
    # by /ocr has passed every deterministic post-extraction validation.
    structured_scheme, corrections = validate_mark_totals(structured_scheme)
    if corrections:
        log_mark_total_corrections(corrections)

    return {"text": clean_text, "structured_scheme": structured_scheme}

def _question_number_from_scheme(scheme_text: str):
    try:
        parsed = _json.loads(scheme_text)
        return parsed.get("question_number")
    except Exception:
        return None

# ── POST /mark-with-scheme-text ───────────────────────────────────────────────
# Like /mark but accepts the mark scheme as pre-extracted text rather than a
# file — avoids re-OCRing the scheme on every student submission.
@app.post("/mark-with-scheme-text")
async def mark_with_scheme_text(
    student_work: UploadFile = File(...),
    scheme_text:  str        = Form(...),
    question:     str        = Form(default='')
):
    student_bytes = await student_work.read()
    raw_text      = extract_text_from_file(student_bytes, student_work.filename)

    # Same treatment as /ocr gives the mark scheme, run BEFORE sanitize() for
    # the same reason: sanitize()'s HTML-tag stripping (<[^>]*>) matches from
    # the first < to the first >, which mangles a <<<...>>> triple-bracket
    # sequence rather than leaving it intact. Strips rather than just flags —
    # anything matching our delimiter shape is removed here, so it never
    # reaches wrap_for_prompt() or the LLM at all.
    raw_text, lookalikes = ms_ocr_sanitisation.strip_delimiter_like_patterns(raw_text)
    if lookalikes:
        log_security_stripped(lookalikes)

    # Post-OCR sanitisation + delimiting for the student's raw OCR text, same
    # as /ocr does for the mark scheme. Only student_work goes through this
    # here — scheme_text and question have already passed through their own
    # sanitisation earlier in the pipeline (scheme_text via /ocr) by the time
    # they reach this endpoint.
    student_text                        = ms_ocr_sanitisation.sanitize(raw_text)
    wrapped_student_text, expected_token = ms_ocr_sanitisation.wrap_for_prompt(student_text)

    question_number = _question_number_from_scheme(scheme_text)
    exemplars       = get_similar(student_text, question_number, n=3)

    raw = generate_llm_response(
        question=question,
        essay=wrapped_student_text,
        rubric=scheme_text,
        expected_token=expected_token,
        max_score=100,
        exemplars=exemplars or None,
    )

    return {
        "score":                    raw.get("score", 0),
        "maxScore":                 raw.get("maxScore"),
        "strengths":                raw.get("strengths", []),
        "improvements":             raw.get("improvements", []),
        "actionable_steps":         raw.get("actionable_steps", []),
        "rubric_breakdown":         raw.get("rubric_breakdown", []),
        "student_ocr_text":         student_text,
        "teacher_review_required":  raw.get("teacher_review_required", False),
        "question_mismatch":        raw.get("question_mismatch", False),
        "question_mismatch_reason": raw.get("question_mismatch_reason", None),
        "annotations":              raw.get("annotations", []),
    }

# ── Exemplar management ───────────────────────────────────────────────────────

@app.post("/exemplars")
async def create_exemplar(
    file:            UploadFile = File(...),
    question_number: str        = Form(...),
    score:           int        = Form(...),
    max_marks:       int        = Form(...),
    band:            int        = Form(default=None),
    source:          str        = Form(default=""),
):
    file_bytes  = await file.read()
    essay_text  = extract_text_from_file(file_bytes, file.filename)
    exemplar_id = add_exemplar(
        essay_text=essay_text,
        question_number=question_number,
        score=score,
        max_marks=max_marks,
        band=band,
        source=source,
    )
    return {"id": exemplar_id, "question_number": question_number, "score": score, "max_marks": max_marks}

@app.get("/exemplars")
async def get_exemplars():
    return {"exemplars": list_exemplars()}

@app.delete("/exemplars/{exemplar_id}")
async def remove_exemplar(exemplar_id: int):
    deleted = delete_exemplar(exemplar_id)
    if not deleted:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Exemplar not found")
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
