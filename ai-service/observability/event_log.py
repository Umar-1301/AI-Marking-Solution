# Central console logging for ai-service — errors and general events, not
# just exceptions. Console-only for now, on purpose: file/remote destinations
# are a planned expansion, not implemented here yet.
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
from pathlib import Path

logger = logging.getLogger("ai-service")
logger.setLevel(logging.INFO)

_DESCRIPTOR_DEBUG_LOG_PATH = Path(__file__).with_name(
    "descriptor_validation_debug.txt"
)

if not logger.handlers:
    # Explicit stdout — StreamHandler() defaults to stderr, but the print()
    # calls this replaces all went to stdout. Pinned so behavior matches
    # exactly, not just visually.
    _handler = logging.StreamHandler(stream=sys.stdout)
    _handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(_handler)
    logger.propagate = False


# ── OCR events ────────────────────────────────────────────────────────────

def log_ocr_sending(filename: str) -> None:
    logger.info(f"[OCR] Sending {filename} to Datalab API...")


def log_ocr_job_submitted() -> None:
    logger.info("[OCR] Job submitted, polling for results...")


def log_ocr_polling(attempt: int, max_attempts: int) -> None:
    logger.info(f"[OCR] Still processing... attempt {attempt}/{max_attempts}")


def log_ocr_done(char_count: int) -> None:
    logger.info(f"[OCR] Done — extracted {char_count} characters")


# ── Security events ───────────────────────────────────────────────────────

def log_security_stripped(matches: list[str]) -> None:
    logger.warning(
        f"[SECURITY] Stripped delimiter-shaped content before it could reach the LLM: {matches}"
    )


# ── Extraction events ─────────────────────────────────────────────────────

def log_extraction_refusal(reason: str) -> None:
    logger.error(f"[EXTRACTION] Model refused to extract mark scheme: {reason}")


def log_extraction_truncated(detail: str) -> None:
    logger.error(f"[EXTRACTION] Response truncated before completion (hit length limit): {detail}")


def log_extraction_filtered() -> None:
    logger.error("[EXTRACTION] Response blocked by OpenAI's content filter")


def log_extraction_empty() -> None:
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
    """Temporary verbose output for descriptor boundary validation."""
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
    """Temporary verbose output for descriptor content-integrity checks."""
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
    """Write temporary descriptor validation diagnostics to console and disk."""
    rendered_payload = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    logger.info(
        f"[DESCRIPTOR DEBUG] {label}\n"
        f"{rendered_payload}"
    )

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
    """Log descriptor-validation failures for human verification."""
    for issue in issues:
        payload = dict(issue)
        payload["question"] = payload.pop("question_number", None)
        logger.warning(
            "[VALIDATION] Descriptor validation failed | "
            f"details={json.dumps(payload, ensure_ascii=False)}"
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

def log_mark_total_corrections(
    corrections: list[dict],
) -> None:
    """
    Log deterministic mark-total corrections without logging mark-scheme
    descriptions or other unnecessary source content.
    """
    for correction in corrections:
        allocations = correction.get(
            "assessment_objectives",
            [],
        )

        allocation_summary = ", ".join(
            (
                f"{str(allocation.get('ao', 'unknown'))[:40]!r}="
                f"{allocation.get('marks_available')!r}"
            )
            for allocation in allocations
            if isinstance(allocation, dict)
        )

        logger.warning(
            "[VALIDATION] Corrected extracted question marks "
            f"| rule={correction.get('rule')!r} "
            f"| question={correction.get('question_number')!r} "
            f"| declared={correction.get('declared_marks')!r} "
            f"| corrected={correction.get('computed_marks')!r} "
            f"| ao_allocations=[{allocation_summary}]"
        )
