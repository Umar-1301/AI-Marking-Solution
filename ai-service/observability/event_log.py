# Central console logging for ai-service. Descriptor comparisons also go to a
# local debug file; a durable remote log destination is not configured here.
#
# Named per-event functions (mirroring backend/src/logging/'s convention —
# logOcrStart, logOcrDone, etc.) rather than one generic log(message) — keeps
# call sites self-documenting and gives a natural place to add structured
# fields later without changing every call site's signature at once.
#
# Uses the real stdlib logging module — this is exactly why the folder is
# called observability and not logging: a local module named logging would
# have shadowed this same import for everything else in ai-service.

import logging
import sys
import json
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

logger = logging.getLogger("ai-service")
logger.setLevel(logging.INFO)
_mark_scheme_context: ContextVar[tuple[str, str, str] | None] = ContextVar(
    "mark_scheme_context", default=None
)
_MARK_SCHEME_STEPS = {
    "ocr": "3a",
    "extraction": "3b",
    "descriptor_shape": "3c",
    "descriptor_content": "3d",
    "descriptor_ids": "3e",
    "mark_totals": "3f",
    "thread_extraction": "3g",
}


class _ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        context = _mark_scheme_context.get()
        message = record.getMessage()
        if context is None:
            return message
        job_id, attempt_id, stage = context
        step = _MARK_SCHEME_STEPS.get(stage)
        step_label = f" step={step}" if step else ""
        return f"[MARK SCHEME job={job_id} attempt={attempt_id}]{step_label} {message}"

_DESCRIPTOR_DEBUG_LOG_PATH = Path(__file__).with_name(
    "descriptor_validation_debug.txt"
)

if not logger.handlers:
    # Explicit stdout — StreamHandler() defaults to stderr, but the print()
    # calls this replaces all went to stdout. Pinned so behavior matches
    # exactly, not just visually.
    _handler = logging.StreamHandler(stream=sys.stdout)
    _handler.setFormatter(_ConsoleFormatter())
    logger.addHandler(_handler)
    logger.propagate = False


@contextmanager
def mark_scheme_log_context(job_id: str | None, attempt_id: str | None):
    # ContextVar keeps concurrent /ocr requests from mixing identifiers.
    token = _mark_scheme_context.set((job_id or "-", attempt_id or "-", "start"))
    try:
        yield
    finally:
        _mark_scheme_context.reset(token)


def log_mark_scheme_stage(stage: str, status: str, detail: str = "") -> None:
    context = _mark_scheme_context.get()
    if context is not None:
        _mark_scheme_context.set((context[0], context[1], stage))
    suffix = f" {detail}" if detail else ""
    logger.info(f"stage={stage} status={status}{suffix}")


def log_mark_scheme_failure(error: Exception) -> None:
    context = _mark_scheme_context.get()
    stage = context[2] if context is not None else "unknown"
    detail = " ".join(str(error).split())[:200]
    logger.error(
        "stage=%s status=failed error=%s detail=%s",
        stage, type(error).__name__, detail or "-",
    )


# ── OCR events ────────────────────────────────────────────────────────────

def log_ocr_sending(filename: str) -> None:
    logger.info(f"[OCR] Sending {filename} to Datalab API...")


def log_ocr_job_submitted() -> None:
    logger.info("[OCR] Job submitted, polling for results...")


def log_ocr_polling(attempt: int, max_attempts: int) -> None:
    if _mark_scheme_context.get() is not None:
        return
    logger.info(f"[OCR] Still processing... attempt {attempt}/{max_attempts}")


def log_ocr_done(char_count: int) -> None:
    logger.info(f"[OCR] Done — extracted {char_count} characters")


def log_student_ocr_done(char_count: int) -> None:
    logger.info(f"[STUDENT OCR] Done — extracted {char_count} handwritten-work characters")


# ── Security events ───────────────────────────────────────────────────────

def log_security_stripped(matches: list[str]) -> None:
    if _mark_scheme_context.get() is not None:
        logger.warning("[SECURITY] Stripped %s delimiter-shaped patterns", len(matches))
        return
    logger.warning(
        f"[SECURITY] Stripped delimiter-shaped content before it could reach the LLM: {matches}"
    )


# ── Extraction events ─────────────────────────────────────────────────────

def log_extraction_refusal(reason: str) -> None:
    if _mark_scheme_context.get() is not None:
        return  # /ocr logs one stage-specific failure when the exception reaches it.
    logger.error(f"[EXTRACTION] Model refused to extract mark scheme: {reason}")


def log_extraction_truncated(detail: str) -> None:
    if _mark_scheme_context.get() is not None:
        return
    logger.error(f"[EXTRACTION] Response truncated before completion (hit length limit): {detail}")


def log_extraction_filtered() -> None:
    if _mark_scheme_context.get() is not None:
        return
    logger.error("[EXTRACTION] Response blocked by OpenAI's content filter")


def log_extraction_empty() -> None:
    if _mark_scheme_context.get() is not None:
        return
    logger.error("[EXTRACTION] No parsed result and no refusal, truncation, or filter reported — unexplained empty response")


def log_descriptor_validation_comparison(
    *,
    question_number: object,
    ao: object,
    band: object,
    descriptor: object,
    model_descriptors: list[str],
    application_descriptors: list[str],
    normalised_application_descriptors: list[str],
    normalised_model_descriptors: list[str],
    shape_matches: bool,
) -> None:
    """Save the detailed descriptor boundary comparison to the local file."""
    payload = {
        "question": question_number,
        "ao": ao,
        "band": band,
        "descriptor": descriptor,
        "model_descriptors": model_descriptors,
        "application_descriptors": application_descriptors,
        "application_descriptor_count": len(application_descriptors),
        "model_descriptor_count": len(model_descriptors),
        "normalised_application_descriptors": (
            normalised_application_descriptors
        ),
        "normalised_model_descriptors": normalised_model_descriptors,
        "shape_matches": shape_matches,
    }
    _write_descriptor_debug("Shape integrity", payload)


def log_descriptor_integrity_comparison(
    *,
    question_number: object,
    ao: object,
    band: object,
    descriptor: object,
    model_descriptors: list[str],
    flattened_model_descriptors: str,
    normalised_descriptor: str,
    normalised_flattened_model_descriptors: str,
    content_matches: bool,
) -> None:
    """Save the detailed descriptor content comparison to the local file."""
    payload = {
        "question": question_number,
        "ao": ao,
        "band": band,
        "descriptor": descriptor,
        "model_descriptors": model_descriptors,
        "flattened_model_descriptors": flattened_model_descriptors,
        "normalised_descriptor": normalised_descriptor,
        "normalised_flattened_model_descriptors": (
            normalised_flattened_model_descriptors
        ),
        "content_matches": content_matches,
    }
    _write_descriptor_debug("Content integrity", payload)


def _write_descriptor_debug(label: str, payload: dict) -> None:
    """Keep detailed comparisons in the local debug file, off the console."""
    rendered_payload = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    try:
        with _DESCRIPTOR_DEBUG_LOG_PATH.open("a", encoding="utf-8") as debug_file:
            debug_file.write(f"[DESCRIPTOR DEBUG] {label}\n")
            debug_file.write(rendered_payload)
            debug_file.write("\n\n")
    except OSError as error:
        # Debug logging must never prevent mark-scheme extraction from running.
        logger.warning(
            "[DESCRIPTOR DEBUG] Could not write comparison file "
            f"{_DESCRIPTOR_DEBUG_LOG_PATH}: {error}"
        )


def log_descriptor_validation_issues(issues: list[dict]) -> None:
    """Log the failed rule and location without printing source text."""
    for issue in issues:
        payload = dict(issue)
        _write_descriptor_debug("Validation issue", payload)
        logger.warning(
            "[VALIDATION] status=failed rule=%s question=%s ao=%s band=%s reason=%s",
            payload.get("rule", "unknown"),
            payload.get("question_number", "-"),
            payload.get("ao", "-"),
            payload.get("band", "-"),
            payload.get("reason", "-"),
        )


# ── Marking events ────────────────────────────────────────────────────────

def log_marking_refusal(reason: str) -> None:
    logger.error(f"[MARKING] Model refused to mark student response: {reason}")


def log_marking_truncated(detail: str) -> None:
    logger.error(f"[MARKING] Response truncated before completion (hit length limit): {detail}")


def log_marking_filtered() -> None:
    logger.error("[MARKING] Response blocked by OpenAI's content filter")


def log_marking_empty() -> None:
    logger.error("[MARKING] No parsed result and no refusal, truncation, or filter reported — unexplained empty response")

def log_mark_total_validation_event(event: dict) -> None:
    """Log one structured decision from deterministic mark-total validation."""
    if not isinstance(event, dict):
        return

    status = str(event.get("status", "info")).casefold()
    if _mark_scheme_context.get() is not None and status not in {"fail", "corrected"}:
        return
    rendered = json.dumps(
        {
            "message": event.get("message"),
            "question": event.get("question"),
            "status": event.get("status", "info"),
        },
        ensure_ascii=False,
        default=str,
    )
    message = f"[MARK TOTAL VALIDATION] {rendered}"

    if status in {"fail", "corrected"}:
        logger.warning(message)
    else:
        logger.info(message)
