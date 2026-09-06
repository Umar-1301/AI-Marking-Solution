import json
import os
from openai import OpenAI, LengthFinishReasonError, ContentFilterFinishReasonError
from dotenv import load_dotenv
from prompts import SYSTEM_PROMPT, build_user_prompt, EXTRACTION_SYSTEM_PROMPT, build_extraction_prompt
from segmentation.seg_prompt import SYSTEM_PROMPT as SEGMENTATION_SYSTEM_PROMPT, build_segmentation_user_prompt
from transformations.thread_description_prompt import (
    SYSTEM_PROMPT as THREAD_DESCRIPTION_SYSTEM_PROMPT,
    build_thread_description_prompt,
)
from security.ms_ocr_sanitisation import verify_token
from schemas.ms_schema import MarkSchemeExtraction
from schemas.marking_result_schema import MarkingResult
from schemas.segmented_result import SegmentationResult
from schemas.thread_description_result import ThreadDescriptionResult
from observability.event_log import (
    log_extraction_refusal,
    log_extraction_truncated,
    log_extraction_filtered,
    log_extraction_empty,
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


class DescriptorValidationError(ExtractionError):
    """Raised when extracted descriptor bullets cannot be verified safely."""
    pass


class DescriptorContentIntegrityError(DescriptorValidationError):
    """Raised when descriptor-list content differs from its raw descriptor."""
    pass

# This line reads the .env file and loads the variables in the enviroment 
# Without this, python has no idea my API key exists 
load_dotenv()

# This creates the OpenAI client object 
# It automatically looks for OPEN_AI_KEY in your enviroment variables 
# This is why the key is never hardcoded - it is pulled securly from .env
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def _marking_rubric_without_constraints(rubric):
    """Remove extraction-only constraints from the rubric sent to marking LLMs."""
    if isinstance(rubric, str):
        try:
            parsed_rubric = json.loads(rubric)
        except json.JSONDecodeError:
            return rubric
    elif isinstance(rubric, dict):
        parsed_rubric = rubric
    else:
        return rubric

    if not isinstance(parsed_rubric, dict):
        return rubric

    marking_rubric = dict(parsed_rubric)
    marking_rubric.pop("band_constraints", None)
    return json.dumps(marking_rubric, ensure_ascii=False)


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

    return structured_scheme


def generate_thread_description_response(scheme_text, expected_token):
    user_prompt = build_thread_description_prompt(scheme_text)
    print("[THREAD EXTRACTION] Thread-description LLM request started", flush=True)

    try:
        response = client.chat.completions.parse(
            model="gpt-4o-mini",
            temperature=0.0,
            messages=[
                {"role": "system", "content": THREAD_DESCRIPTION_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=ThreadDescriptionResult,
        )
    except LengthFinishReasonError as e:
        log_extraction_truncated(str(e))
        raise ExtractionTruncatedError(str(e)) from e
    except ContentFilterFinishReasonError as e:
        log_extraction_filtered()
        raise ExtractionFilteredError(str(e)) from e

    message = response.choices[0].message
    if message.refusal:
        log_extraction_refusal(message.refusal)
        raise ExtractionRefusedError(message.refusal)

    result = message.parsed
    if result is None:
        log_extraction_empty()
        raise ExtractionIncompleteError(
            "No parsed thread-description result, refusal, truncation, or "
            "content-filter signal was returned"
        )

    verify_token(expected_token, result.delimiter_token)
    list_result = result.model_dump(exclude={"delimiter_token"})
    print(
        "[THREAD EXTRACTION] Thread-description LLM returned list response\n"
        f"{json.dumps(list_result, ensure_ascii=False, indent=2, default=str)}\n",
        flush=True,
    )
    return _thread_description_lists_to_keyed_scheme(result)


def _thread_description_lists_to_keyed_scheme(result: ThreadDescriptionResult):
    """Restore the application's keyed thread-scheme shape after parsing the
    list-only Structured Outputs response required by OpenAI."""
    questions = {}

    for question in result.questions:
        assessment_objectives = {}

        for assessment_objective in question.assessment_objectives:
            threads = {
                thread.thread_key: {
                    "thread_id": thread.thread_id,
                    "thread_description": thread.thread_description,
                    "levels": [level.model_dump() for level in thread.levels],
                }
                for thread in assessment_objective.threads
            }

            assessment_objectives[assessment_objective.ao] = {
                "marks_available": assessment_objective.marks_available,
                "band_marks": [
                    band_mark.model_dump()
                    for band_mark in assessment_objective.band_marks
                ],
                "threads": threads,
            }

        questions[question.question] = {
            "marks_available": question.marks_available,
            "assessment_objectives": assessment_objectives,
        }

    return {"questions": questions}


def generate_llm_response(question, essay, rubric, expected_token, max_score=6, exemplars=None):
    marking_rubric = _marking_rubric_without_constraints(rubric)
    user_prompt = build_user_prompt(
        question,
        essay,
        marking_rubric,
        exemplars=exemplars,
    )

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


def generate_segmentation_response(
    question,
    essay,
    thread_extraction,
    expected_token,
    max_score=6,
    exemplars=None,
):
    del exemplars

    if thread_extraction is None or (
        isinstance(thread_extraction, str) and not thread_extraction.strip()
    ):
        raise ValueError(
            "Segmentation requires thread_extraction for the selected mark scheme"
        )

    try:
        selected_thread_extraction = (
            json.loads(thread_extraction)
            if isinstance(thread_extraction, str)
            else thread_extraction
        )
    except json.JSONDecodeError as e:
        raise ValueError(
            "Segmentation requires a valid JSON thread_extraction for the selected question"
        ) from e

    if not isinstance(selected_thread_extraction, dict):
        raise ValueError(
            "Segmentation requires a selected-question thread_extraction object"
        )

    assessment_objectives = selected_thread_extraction.get("assessment_objectives")
    if not isinstance(assessment_objectives, dict) or not assessment_objectives:
        raise ValueError(
            "Segmentation requires assessment_objectives in the selected thread_extraction"
        )

    has_descriptor_thread = any(
        isinstance(assessment_objective, dict)
        and isinstance(assessment_objective.get("threads"), dict)
        and assessment_objective["threads"]
        for assessment_objective in assessment_objectives.values()
    )
    if not has_descriptor_thread:
        raise ValueError(
            "Segmentation requires at least one descriptor thread in the selected thread_extraction"
        )

    marks_available = selected_thread_extraction.get("marks_available")
    if not isinstance(marks_available, int):
        marks_available = max_score

    user_prompt = build_segmentation_user_prompt(
        question=question,
        marks_available=marks_available,
        thread_extraction=json.dumps(selected_thread_extraction, ensure_ascii=False),
        essay=essay,
    )

    try:
        response = client.chat.completions.parse(
            model="gpt-4o-mini",
            temperature=0.0,
            messages=[
                {"role": "system", "content": SEGMENTATION_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format=SegmentationResult,
        )
    except LengthFinishReasonError as e:
        log_marking_truncated(str(e))
        raise ExtractionTruncatedError(str(e)) from e
    except ContentFilterFinishReasonError as e:
        log_marking_filtered()
        raise ExtractionFilteredError(str(e)) from e

    message = response.choices[0].message

    if message.refusal:
        log_marking_refusal(message.refusal)
        raise ExtractionRefusedError(message.refusal)

    result = message.parsed
    if result is None:
        log_marking_empty()
        raise ExtractionIncompleteError(
            "No segmentation result, refusal, truncation, or content-filter signal was returned"
        )

    verify_token(expected_token, result.delimiter_token)

    return result.model_dump(exclude={"delimiter_token"})
