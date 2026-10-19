import os
import sys
import json as _json
import time
from datetime import datetime, timezone
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
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

# Add parent directory to path so we can find llm_service and ocr_service
sys.path.append(str(Path(__file__).parent))

from llm_service import (
    DescriptorContentIntegrityError,
    DescriptorValidationError,
    ExtractionError,
    FinalMarkingValidationError,
    extract_mark_scheme,
    generate_aggregation_response,
    generate_final_marking_response,
    generate_thread_description_response,
    generate_llm_response,
)
from ocr_service import extract_text_from_file
from student_ocr_service import extract_student_ocr_with_raw
from rag_service import add_exemplar, get_similar, list_exemplars, delete_exemplar
from security import ms_ocr_sanitisation
from validation.descriptor_id_enrichment import add_descriptor_ids
from validation.descriptor_integrity_validation import (
    validate_descriptor_content_integrity,
)
from validation.descriptor_validation import validate_descriptor_shapes
from validation.mark_int_validation import validate_mark_totals
from transformations.segment_transormation import transform_segment_mark_scheme
from aggregation.next_band_threads import get_next_band_threads
from final_marking.context import build_final_marking_context
from observability.event_log import (
    log_descriptor_validation_issues,
    log_mark_scheme_failure,
    log_mark_scheme_stage,
    log_mark_total_validation_event,
    log_security_stripped,
    log_student_ocr_done,
    mark_scheme_log_context,
)
from observability.raw_response_capture import save_raw_student_ocr_response

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
def ocr_file(
    file: UploadFile = File(...),
    x_mark_scheme_deadline: str | None = Header(default=None),
    x_mark_scheme_job_id: str | None = Header(default=None),
    x_mark_scheme_attempt_id: str | None = Header(default=None),
):
    with mark_scheme_log_context(x_mark_scheme_job_id, x_mark_scheme_attempt_id):
        started = time.monotonic()
        log_mark_scheme_stage("request", "start", f"file={file.filename}")
        try:
            result = _process_mark_scheme_ocr(file, x_mark_scheme_deadline)
        except HTTPException as exc:
            log_mark_scheme_failure(exc)
            raise
        except Exception as exc:
            log_mark_scheme_failure(exc)
            raise HTTPException(status_code=500, detail="Mark scheme processing failed") from exc
        log_mark_scheme_stage(
            "request", "complete", f"elapsed_ms={round((time.monotonic() - started) * 1000)}"
        )
        return result


def _process_mark_scheme_ocr(file: UploadFile, x_mark_scheme_deadline: str | None):
    # This endpoint performs blocking Datalab and OpenAI calls. FastAPI runs a
    # synchronous path function in its thread pool, allowing concurrent jobs.
    remaining_seconds = 180.0
    if x_mark_scheme_deadline:
        try:
            requested_deadline = datetime.fromisoformat(
                x_mark_scheme_deadline.replace("Z", "+00:00")
            )
            if requested_deadline.tzinfo is None:
                raise ValueError("deadline must include timezone")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid mark scheme deadline") from exc
        remaining_seconds = min(
            remaining_seconds,
            (requested_deadline - datetime.now(timezone.utc)).total_seconds(),
        )
    if remaining_seconds <= 0:
        raise HTTPException(status_code=504, detail="Mark scheme processing timed out")
    deadline = time.monotonic() + remaining_seconds

    def time_left() -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HTTPException(status_code=504, detail="Mark scheme processing timed out")
        return remaining

    file_bytes  = file.file.read()
    log_mark_scheme_stage("ocr", "start", f"bytes={len(file_bytes)}")
    raw_text    = extract_text_from_file(file_bytes, file.filename, deadline=deadline)
    log_mark_scheme_stage("ocr", "pass", f"characters={len(raw_text)}")

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
    log_mark_scheme_stage("extraction", "start")
    structured_scheme   = extract_mark_scheme(
        wrapped_text, token, timeout_seconds=time_left()
    )
    log_mark_scheme_stage("extraction", "pass")

    # Keep descriptor validation as deliberately separate layers. The boundary
    # check verifies that the application and model found the same points;
    # content integrity verifies that joining the model points preserves the
    # complete raw descriptor text. Only then can deterministic IDs be added.
    log_mark_scheme_stage("descriptor_shape", "start")
    descriptor_shape_issues = validate_descriptor_shapes(structured_scheme)
    if descriptor_shape_issues:
        log_descriptor_validation_issues(descriptor_shape_issues)
        raise DescriptorValidationError(
            "Extracted descriptor boundaries did not match the source descriptor"
        )
    log_mark_scheme_stage("descriptor_shape", "pass")

    log_mark_scheme_stage("descriptor_content", "start")
    descriptor_content_issues = validate_descriptor_content_integrity(
        structured_scheme
    )
    if descriptor_content_issues:
        log_descriptor_validation_issues(descriptor_content_issues)
        raise DescriptorContentIntegrityError(
            "Extracted descriptor content did not match the raw descriptor"
        )
    log_mark_scheme_stage("descriptor_content", "pass")

    log_mark_scheme_stage("descriptor_ids", "start")
    structured_scheme, descriptor_id_issues = add_descriptor_ids(
        structured_scheme
    )
    if descriptor_id_issues:
        log_descriptor_validation_issues(descriptor_id_issues)
        raise DescriptorValidationError(
            "Descriptor provenance IDs could not be generated safely"
        )
    log_mark_scheme_stage("descriptor_ids", "pass")

    # This operates after all descriptor transformations so the object returned
    # by /ocr has passed every deterministic post-extraction validation.
    log_mark_scheme_stage("mark_totals", "start")
    structured_scheme, corrections = validate_mark_totals(
        structured_scheme,
        event_handler=log_mark_total_validation_event,
    )
    log_mark_scheme_stage("mark_totals", "complete", f"corrections={len(corrections)}")

    log_mark_scheme_stage("thread_extraction", "start")
    thread_scheme_input = transform_segment_mark_scheme(structured_scheme)

    thread_scheme_text = _json.dumps(thread_scheme_input, ensure_ascii=False)
    thread_scheme_text, lookalikes = (
        ms_ocr_sanitisation.strip_delimiter_like_patterns(thread_scheme_text)
    )
    if lookalikes:
        log_security_stripped(lookalikes)

    wrapped_thread_scheme, thread_token = ms_ocr_sanitisation.wrap_for_prompt(
        thread_scheme_text
    )
    thread_scheme = generate_thread_description_response(
        wrapped_thread_scheme,
        thread_token,
        timeout_seconds=time_left(),
    )
    time_left()
    log_mark_scheme_stage("thread_extraction", "pass")

    return {
        "text": clean_text,
        "structured_scheme": structured_scheme,
        "thread_scheme": thread_scheme,
    }

def _question_number_from_scheme(scheme_text: str):
    try:
        parsed = _json.loads(scheme_text)
        return parsed.get("question_number")
    except Exception:
        return None


def _assessment_objective_descriptions_from_scheme(
    scheme_text: str,
) -> list[str]:
    try:
        parsed = _json.loads(scheme_text)
    except (TypeError, _json.JSONDecodeError):
        return []

    if not isinstance(parsed, dict):
        return []

    assessment_objectives = parsed.get("assessment_objectives")
    if not isinstance(assessment_objectives, list):
        return []

    descriptions = []
    for objective in assessment_objectives:
        if not isinstance(objective, dict):
            continue

        description = objective.get("description")
        if not isinstance(description, str) or not description.strip():
            continue

        descriptions.append(description.strip())

    return descriptions

# ── POST /mark-with-scheme-text ───────────────────────────────────────────────
# Like /mark but accepts the mark scheme as pre-extracted text rather than a
# file — avoids re-OCRing the scheme on every student submission.
@app.post("/mark-with-scheme-text")
async def mark_with_scheme_text(
    student_work:      UploadFile = File(...),
    scheme_text:       str        = Form(...),
    thread_extraction: str        = Form(default=''),
    x_student_marking_deadline: str | None = Header(default=None),
):
    # Blocking OCR and LLM calls run in FastAPI's thread pool. The deadline
    # travels from the worker and bounds each third-party request.
    remaining_seconds = 300.0
    if isinstance(x_student_marking_deadline, str) and x_student_marking_deadline:
        try:
            requested_deadline = datetime.fromisoformat(
                x_student_marking_deadline.replace("Z", "+00:00")
            )
            if requested_deadline.tzinfo is None:
                raise ValueError("deadline must include timezone")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid student marking deadline") from exc
        remaining_seconds = min(
            remaining_seconds,
            (requested_deadline - datetime.now(timezone.utc)).total_seconds(),
        )
    if remaining_seconds <= 0:
        raise HTTPException(status_code=504, detail="Student marking timed out")
    deadline = time.monotonic() + remaining_seconds

    student_bytes = await student_work.read()
    return await run_in_threadpool(
        _process_student_marking, student_bytes, student_work.filename,
        scheme_text, thread_extraction, deadline,
    )


def _process_student_marking(student_bytes, filename, scheme_text, thread_extraction, deadline):

    def time_left() -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HTTPException(status_code=504, detail="Student marking timed out")
        return remaining

    structured_ocr, raw_ocr = extract_student_ocr_with_raw(
        student_bytes,
        filename,
        deadline=deadline,
    )
    time_left()
    save_raw_student_ocr_response(structured_ocr, raw_ocr)
    raw_text       = structured_ocr.get("handwritten_work", "")
    log_student_ocr_done(len(raw_text))

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
    # here — scheme_text has already passed through its own sanitisation via
    # /ocr by the time it reaches this endpoint.
    student_text                        = ms_ocr_sanitisation.sanitize(raw_text)
    wrapped_student_text, expected_token = ms_ocr_sanitisation.wrap_for_prompt(student_text)

    question_number = _question_number_from_scheme(scheme_text)
    assessment_focus = _assessment_objective_descriptions_from_scheme(scheme_text)
    exemplars       = get_similar(
        student_text, question_number, n=3, timeout_seconds=time_left()
    )

    raw = generate_llm_response(
        # Holistic marking receives the complete selected-question scheme,
        # including its AO descriptions, and derives the task from that rubric.
        question="",
        essay=wrapped_student_text,
        rubric=scheme_text,
        expected_token=expected_token,
        max_score=100,
        exemplars=exemplars or None,
        timeout_seconds=time_left(),
    )
    time_left()

    try:
        rubric_breakdown = raw.get("rubric_breakdown", [])
        if not rubric_breakdown:
            raise ValueError("Aggregation requires an awarded rubric band")

        awarded_band = rubric_breakdown[0].get("awarded_band")
        if not awarded_band:
            raise ValueError("Aggregation requires an awarded rubric band")
        if not assessment_focus:
            raise ValueError(
                "Aggregation requires assessment-objective descriptions "
                "from the selected scheme"
            )

        selected_thread_extraction = _json.loads(thread_extraction)
        next_band_threads = get_next_band_threads(
            awarded_band,
            selected_thread_extraction,
        )

        aggregation_mark_scheme = {
            "awarded_band": awarded_band,
            "thread_extraction": selected_thread_extraction,
            "next_band_context": next_band_threads,
        }

        aggregation_result = generate_aggregation_response(
            assessment_focus=assessment_focus,
            student_response=wrapped_student_text,
            extracted_result=raw,
            mark_scheme_extraction=aggregation_mark_scheme,
            expected_token=expected_token,
            timeout_seconds=time_left(),
        )
        aggregation = {
            "status": "complete",
            "result": aggregation_result,
        }
    except (ValueError, TypeError, _json.JSONDecodeError) as e:
        aggregation = {
            "status": "skipped",
            "reason": str(e),
        }
    except (ExtractionError, ms_ocr_sanitisation.TokenMismatchError) as e:
        aggregation = {
            "status": "failed",
            "reason": str(e),
        }

    try:
        final_context = build_final_marking_context(
            aggregation, _json.loads(scheme_text), _json.loads(thread_extraction)
        )
        final_input, lookalikes = ms_ocr_sanitisation.strip_delimiter_like_patterns(
            _json.dumps(final_context, ensure_ascii=False)
        )
        if lookalikes:
            log_security_stripped(lookalikes)
        wrapped_final_input, final_token = ms_ocr_sanitisation.wrap_for_prompt(
            ms_ocr_sanitisation.sanitize(final_input)
        )
        final_result = {
            "status": "complete",
            "result": generate_final_marking_response(
                wrapped_final_input, final_token, final_context,
                timeout_seconds=time_left(),
            ),
        }
    except (ValueError, TypeError) as e:
        final_result = {"status": "skipped", "reason": str(e)}
        print("[FINAL MARKING] Skipped: required inputs unavailable", flush=True)
    except FinalMarkingValidationError as e:
        final_result = {
            "status": "failed",
            "reason": str(e),
            "model_result": e.model_result,
        }
        print("[FINAL MARKING] Failed validation; model result retained", flush=True)
    except (ExtractionError, ms_ocr_sanitisation.TokenMismatchError) as e:
        final_result = {"status": "failed", "reason": str(e)}
        print("[FINAL MARKING] Failed: result could not be verified", flush=True)

    time_left()
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
        "aggregation":              aggregation,
        "final_result":             final_result,
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
