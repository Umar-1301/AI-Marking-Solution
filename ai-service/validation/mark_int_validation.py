# Deterministic post-extraction validation of mark totals.
#
# Runs after:
# 1. OpenAI Structured Output
# 2. Pydantic shape/type validation
# 3. Delimiter-token verification
#
# Its scope is intentionally narrow: correcting the known failure pattern
# where question.marks contains one AO allocation instead of the combined
# total of the question's assessment objectives.

from copy import deepcopy
from typing import Any


NOT_FOUND = "value not found"
CORRECTION_RULE = "question_marks_matched_single_ao"


def _is_valid_mark(value: object) -> bool:
    """
    Return True only for non-negative integers.

    bool is explicitly excluded because it subclasses int in Python.
    """
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
    )


def _get_ao_allocations(
    assessment_objectives: object,
) -> list[dict[str, Any]] | None:
    """
    Return validated AO allocations.

    None is returned when:

    - fewer than two AOs are present;
    - an AO entry is malformed;
    - an AO name is empty or unavailable;
    - an allocation is not a usable integer; or
    - the same AO appears more than once.

    Duplicate AOs are rejected because summing them could count the same
    allocation twice and create an incorrect question total.
    """
    if (
        not isinstance(assessment_objectives, list)
        or len(assessment_objectives) < 2
    ):
        return None

    allocations: list[dict[str, Any]] = []
    seen_aos: set[str] = set()

    for objective in assessment_objectives:
        if not isinstance(objective, dict):
            return None

        ao_name = objective.get("ao")
        marks_available = objective.get("marks_available")

        if (
            not isinstance(ao_name, str)
            or not ao_name.strip()
            or ao_name.strip().casefold() == NOT_FOUND
        ):
            return None

        if not _is_valid_mark(marks_available):
            return None

        cleaned_ao_name = ao_name.strip()
        normalised_ao_name = cleaned_ao_name.casefold()

        if normalised_ao_name in seen_aos:
            return None

        seen_aos.add(normalised_ao_name)

        allocations.append({
            "ao": cleaned_ao_name,
            "marks_available": marks_available,
        })

    return allocations


def validate_mark_totals(
    structured_scheme: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Validate question-level marks against their AO allocations.

    A question is corrected only when all of the following are true:

    - it contains at least two valid, distinct AOs;
    - every AO has a non-negative integer marks_available value;
    - question.marks is a non-negative integer;
    - question.marks differs from the sum of the AO allocations; and
    - question.marks exactly matches one individual AO allocation.

    Exact matching provides stronger evidence that the extraction copied one
    AO allocation into question.marks. A value merely lower than an AO is not
    considered sufficient evidence for an automatic correction.

    The supplied dictionary is never modified.

    Returns:
        corrected_scheme:
            A deep-copied scheme containing any safe corrections.

        corrections:
            An audit list describing every correction. The caller is
            responsible for passing this list to the application logger.
    """
    if not isinstance(structured_scheme, dict):
        raise TypeError("structured_scheme must be a dictionary")

    corrected_scheme = deepcopy(structured_scheme)
    corrections: list[dict[str, Any]] = []

    questions = corrected_scheme.get("questions")

    if not isinstance(questions, list):
        return corrected_scheme, corrections

    for question in questions:
        if not isinstance(question, dict):
            continue

        declared_marks = question.get("marks")

        if not _is_valid_mark(declared_marks):
            continue

        allocations = _get_ao_allocations(
            question.get("assessment_objectives")
        )

        if allocations is None:
            continue

        individual_marks = [
            allocation["marks_available"]
            for allocation in allocations
        ]
        computed_total = sum(individual_marks)

        # The question is already internally consistent.
        if declared_marks == computed_total:
            continue

        # Only correct the recognised failure pattern: question.marks must
        # exactly equal one of the individual AO allocations.
        if declared_marks not in individual_marks:
            continue

        question["marks"] = computed_total

        corrections.append({
            "rule": CORRECTION_RULE,
            "question_number": question.get("question_number"),
            "declared_marks": declared_marks,
            "computed_marks": computed_total,
            "assessment_objectives": allocations,
            "reason": (
                "Declared question marks matched one individual AO "
                "allocation but did not equal the sum of all AO allocations."
            ),
        })

    return corrected_scheme, corrections