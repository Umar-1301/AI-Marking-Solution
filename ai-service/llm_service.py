import os
from openai import OpenAI, LengthFinishReasonError, ContentFilterFinishReasonError
from dotenv import load_dotenv
from prompts import SYSTEM_PROMPT, build_user_prompt, EXTRACTION_SYSTEM_PROMPT, build_extraction_prompt
from security.ms_ocr_sanitisation import verify_token
from schemas.ms_schema import MarkSchemeExtraction
from schemas.marking_result_schema import MarkingResult
from validation.mark_int_validation import validate_mark_totals
from observability.event_log import (
    log_extraction_refusal,
    log_extraction_truncated,
    log_extraction_filtered,
    log_extraction_empty,
    log_mark_total_corrections,
    log_marking_refusal,
    log_marking_truncated,
    log_marking_filtered,
    log_marking_empty,
)

class ExtractionError(Exception):
    """Common base for every way an extraction call can fail to produce a
    trustworthy result. Lets a caller catch all of them at once with
    `except ExtractionError`, or a specific one when it wants to respond
    differently per failure type."""
    pass


class ExtractionRefusedError(ExtractionError):
    """Raised when the model declines to fulfil an extraction request (e.g.
    for safety reasons) instead of returning a Structured Outputs result.
    With response_format set, a refusal does not populate message.parsed —
    it populates message.refusal instead, so this must be checked before
    .parsed is touched at all. Left uncaught by the caller, same as
    TokenMismatchError: a refusal means there is no result to trust, so the
    request should fail rather than return something absent or partial."""
    pass


class ExtractionTruncatedError(ExtractionError):
    """Raised when the response hit its length limit before finishing. The
    SDK itself detects this and raises LengthFinishReasonError from inside
    .parse() — this wraps that so callers only need to know about our own
    exception types, not OpenAI's SDK-internal ones."""
    pass


class ExtractionFilteredError(ExtractionError):
    """Raised when OpenAI's content filter blocked the response, independent
    of anything the model itself decided — distinct from ExtractionRefusedError,
    which is the model explicitly declining. The SDK raises
    ContentFilterFinishReasonError from inside .parse(); this wraps that the
    same way ExtractionTruncatedError wraps the length error."""
    pass


class ExtractionIncompleteError(ExtractionError):
    """Raised when there is no parsed result and none of the above explain
    why — message.parsed came back None without a refusal, truncation, or
    content-filter signal. A backstop so this fails loudly with a clear
    reason instead of crashing later with an unrelated AttributeError the
    first time something tries to use the missing result."""
    pass

# This line reads the .env file and loads the variables in the enviroment 
# Without this, python has no idea my API key exists 
load_dotenv()

# This creates the OpenAI client object 
# It automatically looks for OPEN_AI_KEY in your enviroment variables 
# This is why the key is never hardcoded - it is pulled securly from .env
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def extract_mark_scheme(scheme_text, expected_token):
    user_prompt = build_extraction_prompt(scheme_text)

    # The SDK checks finish_reason itself and raises these two directly from
    # inside .parse() — they never reach the .refusal check below, so they
    # need their own try/except around the call itself, not a field check
    # on the response afterward.
    try:
        response = client.chat.completions.parse(
            model="gpt-4o",
            temperature=0,
            messages=[
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt}
            ],
            response_format=MarkSchemeExtraction,
        )
    except LengthFinishReasonError as e:
        log_extraction_truncated(str(e))
        raise ExtractionTruncatedError(str(e)) from e
    except ContentFilterFinishReasonError as e:
        log_extraction_filtered()
        raise ExtractionFilteredError(str(e)) from e

    message = response.choices[0].message

    # A refusal does not populate .parsed — checked first, before anything
    # downstream assumes a result exists at all.
    if message.refusal:
        log_extraction_refusal(message.refusal)
        raise ExtractionRefusedError(message.refusal)

    result = message.parsed

    # Backstop: none of the checks above explain why, but there's still no
    # result. Fails loudly here with a clear reason instead of crashing a
    # few lines further down with an unrelated-looking AttributeError.
    if result is None:
        log_extraction_empty()
        raise ExtractionIncompleteError(
            "No parsed result, refusal, truncation, or content-filter signal was returned"
        )

    # delimiter_token is an integrity check, not part of the mark scheme
    # structure the rest of the app expects back. Raises TokenMismatchError
    # on failure, which the caller does not catch — a mismatch means we
    # can't trust this result reflects the genuine boundary, so the request
    # should fail rather than return something unverified.
    verify_token(expected_token, result.delimiter_token)

    structured_scheme = result.model_dump(exclude={"delimiter_token"})

    # Deterministic post-extraction check that question-level marks are
    # consistent with their AO allocations, correcting the known pattern
    # where one AO's allocation is captured as the question total
    # (see validation/mark_int_validation.py).
    structured_scheme, corrections = validate_mark_totals(structured_scheme)
    if corrections:
        log_mark_total_corrections(corrections)

    return structured_scheme


def generate_llm_response(question, essay, rubric, expected_token, max_score=6, exemplars=None):
    user_prompt = build_user_prompt(question, essay, rubric, exemplars=exemplars)

    # Structured Outputs + delimiter-token verification, same setup as
    # extract_mark_scheme() above: the SDK checks finish_reason itself and
    # raises these two directly from inside .parse() — they never reach the
    # .refusal check below, so they need their own try/except around the
    # call itself, not a field check on the response afterward.
    try:
        response = client.chat.completions.parse(
            model="gpt-4o",
            temperature=0.0,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt}
            ],
            response_format=MarkingResult,
        )
    except LengthFinishReasonError as e:
        log_marking_truncated(str(e))
        raise ExtractionTruncatedError(str(e)) from e
    except ContentFilterFinishReasonError as e:
        log_marking_filtered()
        raise ExtractionFilteredError(str(e)) from e

    message = response.choices[0].message

    # A refusal does not populate .parsed — checked first, before anything
    # downstream assumes a result exists at all.
    if message.refusal:
        log_marking_refusal(message.refusal)
        raise ExtractionRefusedError(message.refusal)

    result = message.parsed

    # Backstop: none of the checks above explain why, but there's still no
    # result. Fails loudly here with a clear reason instead of crashing a
    # few lines further down with an unrelated-looking AttributeError.
    if result is None:
        log_marking_empty()
        raise ExtractionIncompleteError(
            "No parsed result, refusal, truncation, or content-filter signal was returned"
        )

    # delimiter_token is an integrity check, not part of the marking result
    # the rest of the app expects back. Raises TokenMismatchError on failure,
    # which the caller does not catch — a mismatch means we can't trust this
    # result reflects the genuine student-response boundary, so the request
    # should fail rather than return something unverified.
    verify_token(expected_token, result.delimiter_token)

    results = result.model_dump(exclude={"delimiter_token"})

    detected_max = results.get("max_score_detected") or max_score
    breakdown = results.get("rubric_breakdown", [])
    results["score"]    = min(
        sum(min(ao.get("score_awarded", 0), ao.get("max_marks", detected_max)) for ao in breakdown),
        detected_max
    )
    results["maxScore"] = detected_max

    return results
