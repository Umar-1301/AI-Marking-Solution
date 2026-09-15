import json
import os
import time

import requests

from ocr_service import _get_mime_type


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


def _extract_student_ocr_response(file_bytes: bytes, filename: str) -> tuple[dict, dict]:
    api_key = os.getenv("DATALAB_API_KEY")
    if not api_key:
        raise ValueError("DATALAB_API_KEY not found in environment variables")

    response = requests.post(
        _EXTRACT_URL,
        files={
            "file": (filename, file_bytes, _get_mime_type(filename)),
            "page_schema": (None, _STUDENT_OCR_SCHEMA),
        },
        data={"output_format": "json"},
        headers={"X-Api-Key": api_key},
    )

    if response.status_code != 200:
        raise Exception(f"Datalab Extract API error: {response.status_code} {response.text}")

    check_url = response.json().get("request_check_url")
    if not check_url:
        raise Exception("No check URL returned from Datalab Extract API")

    for _ in range(_MAX_POLLS):
        time.sleep(_POLL_SECONDS)
        result = requests.get(check_url, headers={"X-Api-Key": api_key})
        if result.status_code != 200:
            raise Exception(f"Datalab Extract polling error: {result.status_code} {result.text}")

        result_data = result.json()
        if result_data.get("status") == "complete":
            extracted = result_data.get("extraction_schema_json")
            structured_ocr = json.loads(extracted) if isinstance(extracted, str) else (extracted or {})
            raw_ocr = result_data.get("json") or {}
            return structured_ocr, raw_ocr

        if result_data.get("status") == "failed":
            raise Exception(f"Datalab Extract failed: {result_data.get('error', 'unknown error')}")

    raise Exception("Datalab Extract timed out after 300 seconds")


def extract_student_ocr(file_bytes: bytes, filename: str) -> dict:
    structured_ocr, _ = _extract_student_ocr_response(file_bytes, filename)
    return structured_ocr


def extract_student_ocr_with_raw(file_bytes: bytes, filename: str) -> tuple[dict, dict]:
    return _extract_student_ocr_response(file_bytes, filename)
