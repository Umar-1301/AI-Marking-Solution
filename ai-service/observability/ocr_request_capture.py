"""Local run monitor for calls made from the AI service to Datalab /extract."""

import json
import os
import re
from datetime import datetime, timezone

from observability.raw_response_capture import RAW_DATA_DIR


def record_batch_ocr_request(run_key: str, record: dict) -> None:
    if not re.fullmatch(r"[A-Za-z0-9-]+", run_key):
        raise ValueError("Invalid local OCR run key")
    RAW_DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = RAW_DATA_DIR / f"ocr-provider-{run_key}.ndjson"
    payload = {
        "event": "datalab_extract_request",
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "run_key": run_key,
        **record,
    }
    line = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)
