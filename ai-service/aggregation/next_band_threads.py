"""Select the next mark-scheme level for every descriptor thread."""

from __future__ import annotations

import re
from typing import Any

from transformations.segment_transormation import transform_segment_mark_scheme


_LEVEL_NUMBER_PATTERN = re.compile(r"\b(\d+)\b")


def _get_level_number(band: object) -> int | None:
    if not isinstance(band, str):
        return None

    match = _LEVEL_NUMBER_PATTERN.search(band)
    return int(match.group(1)) if match else None


def _get_selected_thread_extraction(
    extracted_scheme: dict[str, Any],
    question: str | None,
) -> dict[str, Any]:
    """Accept a selected thread extraction or select one from a full scheme."""
    if "assessment_objectives" in extracted_scheme:
        return extracted_scheme

    questions = extracted_scheme.get("questions")
    if isinstance(questions, list):
        questions = transform_segment_mark_scheme(extracted_scheme).get("questions")

    if not isinstance(questions, dict):
        raise ValueError(
            "extracted_scheme must be a selected thread extraction or a full mark scheme"
        )
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question is required when extracted_scheme contains multiple questions")

    selected_question = questions.get(question)
    if not isinstance(selected_question, dict):
        raise ValueError(f"Question not found in extracted_scheme: {question}")

    return selected_question


def get_next_band_threads(
    holistic_band: str,
    extracted_scheme: dict[str, Any],
    question: str | None = None,
) -> dict[str, Any]:
    """Return each descriptor thread's descriptor at the next available band.

    ``extracted_scheme`` may be either the selected-question thread-extraction
    object used by live marking, or the complete extracted mark scheme. When a
    complete scheme is supplied, ``question`` selects the question to use.

    The function derives the next level from the bands that actually exist in
    the selected scheme, rather than assuming every numerical level is
    available. If there is no higher level, ``next_band`` is ``None`` and no
    threads are returned.
    """
    awarded_level = _get_level_number(holistic_band)
    if awarded_level is None:
        raise ValueError("holistic_band must contain a numeric level")

    if not isinstance(extracted_scheme, dict):
        raise TypeError("extracted_scheme must be a dictionary")

    thread_extraction = _get_selected_thread_extraction(extracted_scheme, question)
    assessment_objectives = thread_extraction.get("assessment_objectives")
    if not isinstance(assessment_objectives, dict):
        raise ValueError("thread_extraction.assessment_objectives must be a dictionary")

    available_levels: set[int] = set()
    for objective in assessment_objectives.values():
        if not isinstance(objective, dict):
            continue
        threads = objective.get("threads")
        if not isinstance(threads, dict):
            continue
        for thread in threads.values():
            if not isinstance(thread, dict):
                continue
            levels = thread.get("levels")
            if not isinstance(levels, list):
                continue
            for level in levels:
                if isinstance(level, dict):
                    level_number = _get_level_number(level.get("band"))
                    if level_number is not None and level_number > awarded_level:
                        available_levels.add(level_number)

    next_level = min(available_levels, default=None)
    next_band = f"Level {next_level}" if next_level is not None else None
    selected_objectives: dict[str, Any] = {}

    if next_level is not None:
        for ao, objective in assessment_objectives.items():
            if not isinstance(objective, dict):
                continue

            threads = objective.get("threads")
            if not isinstance(threads, dict):
                continue

            selected_threads: dict[str, Any] = {}
            for thread_key, thread in threads.items():
                if not isinstance(thread, dict):
                    continue

                levels = thread.get("levels")
                if not isinstance(levels, list):
                    continue

                next_descriptor = next(
                    (
                        level
                        for level in levels
                        if isinstance(level, dict)
                        and _get_level_number(level.get("band")) == next_level
                    ),
                    None,
                )
                if next_descriptor is None:
                    continue

                selected_threads[thread_key] = {
                    "thread_id": thread.get("thread_id"),
                    "thread_description": thread.get("thread_description"),
                    "level": next_descriptor,
                }

            if selected_threads:
                selected_objectives[ao] = {
                    "threads": selected_threads,
                }

    return {
        "awarded_band": holistic_band,
        "next_band": next_band,
        "assessment_objectives": selected_objectives,
    }
