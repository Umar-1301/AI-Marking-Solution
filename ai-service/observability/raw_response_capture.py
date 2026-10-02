"""Keep unmodified model and OCR responses for local diagnosis."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from observability.event_log import logger


RAW_DATA_DIR = Path(__file__).resolve().parents[1] / "raw data"


def save_raw_student_ocr_response(
    structured_ocr: dict,
    raw_ocr: dict,
) -> Path | None:
    """Save both Datalab student-OCR outputs before either is consumed."""
    captured_at = datetime.now(timezone.utc)
    record = {
        "captured_at_utc": captured_at.isoformat(),
        "structured_ocr": structured_ocr,
        "raw_ocr": raw_ocr,
    }
    filename = f"student-ocr-{captured_at:%Y%m%dT%H%M%S%fZ}-{uuid4().hex}.json"
    destination = RAW_DATA_DIR / filename

    try:
        RAW_DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        RAW_DATA_DIR.chmod(0o700)
        rendered = json.dumps(record, ensure_ascii=False, indent=2)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(rendered)
            output.write("\n")
    except (OSError, TypeError) as error:
        logger.warning("[STUDENT OCR] Could not save raw response: %s", error)
        return None

    logger.info("[STUDENT OCR] Raw responses saved to %s", destination)
    return destination


def save_raw_final_marking_response(
    raw_content: str | None,
    *,
    response_id: str | None = None,
    model: str | None = None,
    finish_reason: str | None = None,
) -> Path | None:
    """Save the model text before application validation or worker sanitisation."""
    if not isinstance(raw_content, str):
        logger.warning("[FINAL MARKING] Raw response content was unavailable to save")
        return None

    captured_at = datetime.now(timezone.utc)
    try:
        model_output = json.loads(raw_content)
    except json.JSONDecodeError:
        model_output = None

    record = {
        "captured_at_utc": captured_at.isoformat(),
        "response_id": response_id,
        "model": model,
        "finish_reason": finish_reason,
        "raw_content": raw_content,
        "model_output": model_output,
    }
    filename = f"final-marker-{captured_at:%Y%m%dT%H%M%S%fZ}-{uuid4().hex}.json"
    destination = RAW_DATA_DIR / filename

    try:
        RAW_DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        RAW_DATA_DIR.chmod(0o700)
        rendered = json.dumps(record, ensure_ascii=False, indent=2)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(rendered)
            output.write("\n")
    except OSError as error:
        logger.warning("[FINAL MARKING] Could not save raw response: %s", error)
        return None

    logger.info("[FINAL MARKING] Raw response saved to %s", destination)
    return destination
