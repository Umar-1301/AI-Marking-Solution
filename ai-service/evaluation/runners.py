"""Prompt-specific execution functions and their allowlisted registry."""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import aggregation.aggregation_prompt as aggregation_prompt_module
import final_marking.final_prompt as final_marking_prompt_module
from aggregation.aggregation_prompt import (
    SYSTEM_PROMPT as AGGREGATION_SYSTEM_PROMPT,
    build_aggregation_user_prompt,
)
from aggregation.next_band_threads import get_next_band_threads
from final_marking.context import build_final_marking_context
from final_marking.final_prompt import (
    SYSTEM_PROMPT as FINAL_MARKING_SYSTEM_PROMPT,
    build_final_marking_user_prompt,
)
from schemas.aggregation_schema import AggregationResult
from schemas.final_marking_result import FinalMarkingResult
from security import ms_ocr_sanitisation


_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_AI_SERVICE_ROOT / ".env", override=False)
load_dotenv(_AI_SERVICE_ROOT / "local.env", override=False)


class RunnerInputError(ValueError):
    """Raised when a frozen dataset cannot supply a runner's inputs."""


def _input_data(dataset: dict[str, Any]) -> dict[str, Any]:
    data = dataset.get("input_data")
    if not isinstance(data, dict):
        raise RunnerInputError("Dataset input_data must be an object")
    return data


def _required_object(data: dict[str, Any], field: str) -> dict[str, Any]:
    value = data.get(field)
    if not isinstance(value, dict):
        raise RunnerInputError(f"Dataset requires an object in {field}")
    return value


def _assessment_focus(scheme: dict[str, Any]) -> list[str]:
    objectives = scheme.get("assessment_objectives")
    if not isinstance(objectives, list):
        raise RunnerInputError("Selected scheme has no assessment objectives")
    descriptions = [
        objective["description"].strip()
        for objective in objectives
        if isinstance(objective, dict)
        and isinstance(objective.get("description"), str)
        and objective["description"].strip()
    ]
    if not descriptions:
        raise RunnerInputError("Selected scheme has no assessment-focus descriptions")
    return descriptions


def _awarded_band(student_grade: dict[str, Any]) -> str:
    breakdown = student_grade.get("rubric_breakdown")
    if not isinstance(breakdown, list):
        breakdown = student_grade.get("breakdown")
    if not isinstance(breakdown, list) or not breakdown:
        raise RunnerInputError("Student grade has no awarded breakdown")
    first = breakdown[0]
    if not isinstance(first, dict):
        raise RunnerInputError("Student grade breakdown is invalid")
    band = first.get("awarded_band", first.get("awardedBand"))
    if not isinstance(band, str) or not band.strip():
        raise RunnerInputError("Student grade has no awarded band")
    return band


def _delimited_student_response(data: dict[str, Any]) -> tuple[str, str]:
    response = data.get("student_response")
    if not isinstance(response, str) or not response.strip():
        raise RunnerInputError("Dataset has no student response")
    response, _ = ms_ocr_sanitisation.strip_delimiter_like_patterns(response)
    return ms_ocr_sanitisation.wrap_for_prompt(
        ms_ocr_sanitisation.sanitize(response)
    )


def capture_aggregation_prompt(_: dict[str, Any]) -> dict[str, Any]:
    """Snapshot code-owned instructions, not dataset-specific prompt values."""
    return {
        "runner_key": "aggregation",
        "model": "gpt-4o-mini",
        "temperature": 0.0,
        "system_prompt": AGGREGATION_SYSTEM_PROMPT,
        "user_prompt_builder": inspect.getsource(build_aggregation_user_prompt),
        "prompt_module_source": inspect.getsource(aggregation_prompt_module),
        "response_schema": AggregationResult.model_json_schema(),
    }


def validate_aggregation_dataset(dataset: dict[str, Any]) -> None:
    data = _input_data(dataset)
    scheme = _required_object(data, "selected_scheme")
    thread_extraction = _required_object(data, "selected_thread_extraction")
    student_grade = _required_object(data, "student_grade")
    _assessment_focus(scheme)
    awarded_band = _awarded_band(student_grade)
    get_next_band_threads(awarded_band, thread_extraction)
    response = data.get("student_response")
    if not isinstance(response, str) or not response.strip():
        raise RunnerInputError("Dataset has no student response")


def run_aggregation(dataset: dict[str, Any]) -> dict[str, Any]:
    data = _input_data(dataset)
    scheme = _required_object(data, "selected_scheme")
    thread_extraction = _required_object(data, "selected_thread_extraction")
    student_grade = _required_object(data, "student_grade")
    awarded_band = _awarded_band(student_grade)
    response, token = _delimited_student_response(data)

    mark_scheme_extraction = {
        "awarded_band": awarded_band,
        "thread_extraction": thread_extraction,
        "next_band_context": get_next_band_threads(
            awarded_band,
            thread_extraction,
        ),
    }

    # Import lazily so listing targets or datasets does not construct an
    # OpenAI client or require an API key.
    from llm_service import generate_aggregation_response

    result, performance = generate_aggregation_response(
        assessment_focus=_assessment_focus(scheme),
        student_response=response,
        extracted_result=student_grade,
        mark_scheme_extraction=mark_scheme_extraction,
        expected_token=token,
        include_performance=True,
    )
    return {"result": result, "performance": performance}


def capture_final_marking_prompt(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "runner_key": "final_marking",
        "model": "gpt-4o-mini",
        "temperature": 0.0,
        "system_prompt": FINAL_MARKING_SYSTEM_PROMPT,
        "user_prompt_builder": inspect.getsource(build_final_marking_user_prompt),
        "prompt_module_source": inspect.getsource(final_marking_prompt_module),
        "response_schema": FinalMarkingResult.model_json_schema(),
    }


def validate_final_marking_dataset(dataset: dict[str, Any]) -> None:
    data = _input_data(dataset)
    build_final_marking_context(
        _required_object(data, "aggregation"),
        _required_object(data, "selected_scheme"),
        _required_object(data, "selected_thread_extraction"),
    )


def run_final_marking(dataset: dict[str, Any]) -> dict[str, Any]:
    data = _input_data(dataset)
    scheme = _required_object(data, "selected_scheme")
    thread_extraction = _required_object(data, "selected_thread_extraction")
    aggregation = _required_object(data, "aggregation")

    context = build_final_marking_context(
        aggregation,
        scheme,
        thread_extraction,
    )
    final_text, _ = ms_ocr_sanitisation.strip_delimiter_like_patterns(
        json.dumps(context, ensure_ascii=False)
    )
    wrapped_input, token = ms_ocr_sanitisation.wrap_for_prompt(
        ms_ocr_sanitisation.sanitize(final_text)
    )

    from llm_service import generate_final_marking_response

    result, performance = generate_final_marking_response(
        wrapped_input,
        token,
        context,
        include_performance=True,
    )
    return {"result": result, "performance": performance}


RUNNERS = {
    "aggregation": {
        "name": "Aggregation",
        "model": "gpt-4o-mini",
        "temperature": 0.0,
        "validate": validate_aggregation_dataset,
        "capture_prompt": capture_aggregation_prompt,
        "execute": run_aggregation,
    },
    "final_marking": {
        "name": "Final marking",
        "model": "gpt-4o-mini",
        "temperature": 0.0,
        "validate": validate_final_marking_dataset,
        "capture_prompt": capture_final_marking_prompt,
        "execute": run_final_marking,
    },
}


def get_runner(runner_key: str) -> dict[str, Any]:
    runner = RUNNERS.get(runner_key)
    if runner is None:
        available = ", ".join(sorted(RUNNERS))
        raise RunnerInputError(
            f"Runner {runner_key!r} is not configured. Available runners: {available}"
        )
    return runner


def available_runners() -> list[tuple[str, str]]:
    return [(key, value["name"]) for key, value in RUNNERS.items()]
