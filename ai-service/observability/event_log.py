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

logger = logging.getLogger("ai-service")
logger.setLevel(logging.INFO)

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