import requests
import os
import time
from observability.event_log import log_ocr_sending, log_ocr_job_submitted, log_ocr_polling, log_ocr_done

def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    """
    Takes raw file bytes and returns extracted text.
    Uses Datalab Chandra OCR API.
    
    This replaces the local Tesseract implementation.
    Same interface — everything else in the codebase stays the same.
    """
    
    api_key = os.getenv("DATALAB_API_KEY")
    
    if not api_key:
        raise ValueError("DATALAB_API_KEY not found in environment variables")
    
    log_ocr_sending(filename)
    
    # Send the file to Datalab's OCR endpoint
    response = requests.post(
        "https://www.datalab.to/api/v1/marker",
        files={
            "file": (filename, file_bytes, _get_mime_type(filename)),
        },
        data={
            "output_format": "markdown",
            "use_llm":       False,
        },
        headers={"X-Api-Key": api_key},
    )
    
    # Check it worked
    if response.status_code != 200:
        raise Exception(f"Datalab API error: {response.status_code} {response.text}")
    
    data = response.json()
    
    # Datalab returns a request_check_url to poll for results
    # OCR is async — we need to wait for it to finish
    check_url = data.get("request_check_url")
    
    if not check_url:
        raise Exception("No check URL returned from Datalab API")
    
    log_ocr_job_submitted()
    
    # Poll until done
    max_attempts = 20
    for attempt in range(max_attempts):
        time.sleep(2)  # wait 2 seconds between checks
        
        result = requests.get(
            check_url,
            headers={"X-Api-Key": api_key}
        )
        
        result_data = result.json()
        
        if result_data.get("status") == "complete":
            text = result_data.get("markdown", "")
            log_ocr_done(len(text))
            return text

        log_ocr_polling(attempt + 1, max_attempts)
    
    raise Exception("Datalab OCR timed out after 40 seconds")


def _get_mime_type(filename: str) -> str:
    """Work out the MIME type from the filename."""
    filename_lower = filename.lower()
    if filename_lower.endswith(".pdf"):
        return "application/pdf"
    elif filename_lower.endswith(".png"):
        return "image/png"
    elif filename_lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    else:
        return "application/octet-stream"