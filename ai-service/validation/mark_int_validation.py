# Deterministic post-extraction validation of mark totals.
#
# Runs after:
# 1. OpenAI Structured Output
# 2. Pydantic shape/type validation
# 3. Delimiter-token verification
#
# Its scope is intentionally narrow: deriving unavailable question marks from
# validated AO allocations, and correcting the known failure pattern where
# question.marks contains one AO allocation instead of the combined total.

from copy import deepcopy
from typing import Any, Callable


NOT_FOUND = "value not found"
CORRECTION_RULE = "question_marks_matched_single_ao"
DERIVATION_RULE = "question_marks_derived_from_ao_total"
ValidationEventHandler = Callable[[dict[str, Any]], None]


def _emit(
    event_handler: ValidationEventHandler | None,
    *,
    check: str,
    status: str,
    message: str,
    **details: Any,
) -> None:
    if event_handler is None:
        return
    event_handler({
        "check": check,
        "status": status,
        "message": message,
        **details,
    })


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
    *,
    minimum_ao_count: int = 2,
    event_handler: ValidationEventHandler | None = None,
    question_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """
    Return validated AO allocations.

    None is returned when:

    - fewer than the required number of AOs are present;
    - an AO entry is malformed;
    - an AO name is empty or unavailable;
    - an allocation is not a usable integer; or
    - the same AO appears more than once.

    Duplicate AOs are rejected because summing them could count the same
    allocation twice and create an incorrect question total.
    """
    context = question_context or {}
    if not isinstance(assessment_objectives, list):
        _emit(
            event_handler,
            check="assessment_objectives_shape",
            status="fail",
            message="assessment_objectives is not a list; mark-total validation cannot continue for this question",
            received_type=type(assessment_objectives).__name__,
            **context,
        )
        return None

    _emit(
        event_handler,
        check="assessment_objectives_shape",
        status="pass",
        message="assessment_objectives is a list",
        ao_count=len(assessment_objectives),
        **context,
    )

    if len(assessment_objectives) < minimum_ao_count:
        if minimum_ao_count == 1:
            count_message = "no AOs were supplied; question marks cannot be derived"
        else:
            count_message = "fewer than two AOs were supplied; this validator does not check single-AO totals"
        _emit(
            event_handler,
            check="minimum_ao_count",
            status="skip",
            message=count_message,
            ao_count=len(assessment_objectives),
            **context,
        )
        return None

    _emit(
        event_handler,
        check="minimum_ao_count",
        status="pass",
        message=(
            "at least one AO is available for deriving question marks"
            if minimum_ao_count == 1
            else "at least two AOs are available for total comparison"
        ),
        ao_count=len(assessment_objectives),
        **context,
    )

    allocations: list[dict[str, Any]] = []
    seen_aos: set[str] = set()

    for ao_index, objective in enumerate(assessment_objectives, start=1):
        ao_context = {**context, "ao_index": ao_index}
        if not isinstance(objective, dict):
            _emit(
                event_handler,
                check="ao_entry_shape",
                status="fail",
                message="AO entry is not an object; mark-total validation cannot continue for this question",
                received_type=type(objective).__name__,
                **ao_context,
            )
            return None
        _emit(
            event_handler,
            check="ao_entry_shape",
            status="pass",
            message="AO entry is an object",
            **ao_context,
        )

        ao_name = objective.get("ao")
        marks_available = objective.get("marks_available")

        if (
            not isinstance(ao_name, str)
            or not ao_name.strip()
            or ao_name.strip().casefold() == NOT_FOUND
        ):
            _emit(
                event_handler,
                check="ao_name",
                status="fail",
                message="AO name is missing, empty, or unavailable; mark-total validation cannot continue for this question",
                ao=ao_name,
                **ao_context,
            )
            return None
        cleaned_ao_name = ao_name.strip()
        ao_context["ao"] = cleaned_ao_name
        _emit(
            event_handler,
            check="ao_name",
            status="pass",
            message="AO name is usable",
            **ao_context,
        )

        if not _is_valid_mark(marks_available):
            _emit(
                event_handler,
                check="ao_marks_available",
                status="fail",
                message="AO marks_available is not a non-negative integer; mark-total validation cannot continue for this question",
                marks_available=marks_available,
                **ao_context,
            )
            return None
        _emit(
            event_handler,
            check="ao_marks_available",
            status="pass",
            message="AO marks_available is a non-negative integer",
            marks_available=marks_available,
            **ao_context,
        )

        normalised_ao_name = cleaned_ao_name.casefold()

        if normalised_ao_name in seen_aos:
            _emit(
                event_handler,
                check="unique_ao_name",
                status="fail",
                message="duplicate AO name detected; summing could double-count an allocation",
                **ao_context,
            )
            return None
        _emit(
            event_handler,
            check="unique_ao_name",
            status="pass",
            message="AO name is unique within the question",
            **ao_context,
        )

        seen_aos.add(normalised_ao_name)

        allocations.append({
            "ao": cleaned_ao_name,
            "marks_available": marks_available,
        })

    _emit(
        event_handler,
        check="ao_allocations",
        status="pass",
        message="all AO allocations are valid and can be summed",
        assessment_objectives=allocations,
        **context,
    )
    return allocations


def validate_mark_totals(
    structured_scheme: dict[str, Any],
    *,
    event_handler: ValidationEventHandler | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Validate question-level marks against their AO allocations.

    A question with unavailable or invalid marks is corrected when:

    - it contains at least one valid AO; and
    - every AO has a non-negative integer marks_available value.

    In that case, question.marks is derived from the sum of the validated AO
    allocations. For a question that already has valid integer marks, it is
    corrected only when all of the following are true:

    - it contains at least two valid, distinct AOs;
    - every AO has a non-negative integer marks_available value;
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
            An audit list describing every correction.
    """
    if not isinstance(structured_scheme, dict):
        _emit(
            event_handler,
            check="structured_scheme_shape",
            status="fail",
            message="structured_scheme is not an object",
            received_type=type(structured_scheme).__name__,
        )
        raise TypeError("structured_scheme must be a dictionary")

    _emit(
        event_handler,
        check="structured_scheme_shape",
        status="pass",
        message="structured_scheme is an object",
    )

    corrected_scheme = deepcopy(structured_scheme)
    corrections: list[dict[str, Any]] = []

    questions = corrected_scheme.get("questions")

    if not isinstance(questions, list):
        _emit(
            event_handler,
            check="questions_shape",
            status="fail",
            message="structured_scheme.questions is not a list; no question totals were checked",
            received_type=type(questions).__name__,
        )
        return corrected_scheme, corrections

    _emit(
        event_handler,
        check="questions_shape",
        status="pass",
        message="structured_scheme.questions is a list",
        question_count=len(questions),
    )

    for question_index, question in enumerate(questions, start=1):
        question_context = {
            "question_index": question_index,
            "question": question.get("question_number") if isinstance(question, dict) else None,
        }
        if not isinstance(question, dict):
            _emit(
                event_handler,
                check="question_entry_shape",
                status="fail",
                message="question entry is not an object; this question was not checked",
                received_type=type(question).__name__,
                **question_context,
            )
            continue

        _emit(
            event_handler,
            check="question_entry_shape",
            status="pass",
            message="question entry is an object",
            **question_context,
        )

        declared_marks = question.get("marks")

        declared_marks_are_valid = _is_valid_mark(declared_marks)

        if not declared_marks_are_valid:
            _emit(
                event_handler,
                check="declared_question_marks",
                status="fail",
                message="question.marks is unavailable or invalid; attempting to derive it from AO allocations",
                declared_marks=declared_marks,
                **question_context,
            )
        else:
            _emit(
                event_handler,
                check="declared_question_marks",
                status="pass",
                message="question.marks is a non-negative integer",
                declared_marks=declared_marks,
                **question_context,
            )

        allocations = _get_ao_allocations(
            question.get("assessment_objectives"),
            minimum_ao_count=1 if not declared_marks_are_valid else 2,
            event_handler=event_handler,
            question_context=question_context,
        )

        if allocations is None:
            continue

        individual_marks = [
            allocation["marks_available"]
            for allocation in allocations
        ]
        computed_total = sum(individual_marks)
        _emit(
            event_handler,
            check="computed_ao_total",
            status="pass",
            message="computed the question total from AO allocations",
            declared_marks=declared_marks,
            computed_marks=computed_total,
            assessment_objectives=allocations,
            **question_context,
        )

        if not declared_marks_are_valid:
            question["marks"] = computed_total

            corrections.append({
                "rule": DERIVATION_RULE,
                "question_number": question.get("question_number"),
                "declared_marks": declared_marks,
                "computed_marks": computed_total,
                "assessment_objectives": allocations,
                "reason": (
                    "Question marks were unavailable or invalid, so they "
                    "were derived from the validated AO allocations."
                ),
            })

            _emit(
                event_handler,
                check="question_marks_correction",
                status="corrected",
                message="unavailable or invalid question.marks was replaced with the sum of AO allocations",
                declared_marks=declared_marks,
                corrected_marks=computed_total,
                **question_context,
            )
            continue

        # The question is already internally consistent.
        if declared_marks == computed_total:
            _emit(
                event_handler,
                check="question_total_consistency",
                status="pass",
                message="declared question marks match the sum of AO allocations; no correction is needed",
                declared_marks=declared_marks,
                computed_marks=computed_total,
                **question_context,
            )
            _emit(
                event_handler,
                check="single_ao_copy_pattern",
                status="skip",
                message="correction-pattern check was unnecessary because the totals already match",
                **question_context,
            )
            continue

        _emit(
            event_handler,
            check="question_total_consistency",
            status="fail",
            message="declared question marks do not match the sum of AO allocations",
            declared_marks=declared_marks,
            computed_marks=computed_total,
            **question_context,
        )

        # Only correct the recognised failure pattern: question.marks must
        # exactly equal one of the individual AO allocations.
        if declared_marks not in individual_marks:
            _emit(
                event_handler,
                check="single_ao_copy_pattern",
                status="fail",
                message="declared marks do not match any single AO allocation; mismatch is left unchanged",
                declared_marks=declared_marks,
                computed_marks=computed_total,
                individual_marks=individual_marks,
                **question_context,
            )
            continue

        _emit(
            event_handler,
            check="single_ao_copy_pattern",
            status="pass",
            message="declared marks match one AO allocation; the known extraction error can be corrected safely",
            declared_marks=declared_marks,
            computed_marks=computed_total,
            individual_marks=individual_marks,
            **question_context,
        )

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

        _emit(
            event_handler,
            check="question_marks_correction",
            status="corrected",
            message="question.marks was replaced with the sum of AO allocations",
            declared_marks=declared_marks,
            corrected_marks=computed_total,
            **question_context,
        )

    _emit(
        event_handler,
        check="validation_complete",
        status="pass",
        message="mark-total validation completed",
        question_count=len(questions),
        correction_count=len(corrections),
    )

    return corrected_scheme, corrections
