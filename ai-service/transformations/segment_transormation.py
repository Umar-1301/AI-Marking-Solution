"""Build descriptor-thread input for paragraph-level segmentation."""

from __future__ import annotations

import re
from typing import Any


_DESCRIPTOR_ID_PATTERN = re.compile(
    r"^(?P<ao>.+)-\d+(?P<thread_key>[a-z]+)$",
    re.IGNORECASE,
)


def _is_no_reward_band(band_label: object, marks: object) -> bool:
    if isinstance(marks, str) and marks.strip() == "0":
        return True
    if isinstance(marks, int) and marks == 0:
        return True
    if not isinstance(band_label, str):
        return False

    return band_label.strip().casefold() in {"0", "level 0", "band 0"}


def transform_segment_mark_scheme(structured_scheme: dict[str, Any]) -> dict[str, Any]:
    """Convert an ID-enriched mark scheme into ordered descriptor threads.

    The input must be the result of descriptor-ID enrichment, where each
    non-General band's ``descriptors`` list contains ``{"id", "text"}``
    objects. Band and descriptor source order is preserved in every thread.
    """
    if not isinstance(structured_scheme, dict):
        raise TypeError("structured_scheme must be a dictionary")

    questions = structured_scheme.get("questions")
    if not isinstance(questions, list):
        raise ValueError("structured_scheme.questions must be a list")

    transformed_questions: dict[str, Any] = {}

    for question_index, question in enumerate(questions, start=1):
        if not isinstance(question, dict):
            continue

        question_number = question.get("question_number")
        question_key = (
            question_number.strip()
            if isinstance(question_number, str) and question_number.strip()
            else f"Question {question_index}"
        )

        objectives_result: dict[str, Any] = {}
        objectives = question.get("assessment_objectives")
        if not isinstance(objectives, list):
            objectives = []

        for objective in objectives:
            if not isinstance(objective, dict):
                continue

            ao = objective.get("ao")
            ao_key = ao.strip() if isinstance(ao, str) and ao.strip() else "Unknown AO"
            threads: dict[str, Any] = {}
            band_marks: list[dict[str, Any]] = []
            seen_descriptor_ids: set[str] = set()

            bands = objective.get("bands")
            if not isinstance(bands, list):
                bands = []

            for band in bands:
                if not isinstance(band, dict):
                    continue

                band_label = band.get("band")
                band_marks.append({
                    "band": band_label,
                    "marks": band.get("marks"),
                })

                if _is_no_reward_band(band_label, band.get("marks")):
                    continue

                descriptors = band.get("descriptors")
                if not isinstance(descriptors, list):
                    continue

                for descriptor in descriptors:
                    if not isinstance(descriptor, dict):
                        continue

                    descriptor_id = descriptor.get("id")
                    descriptor_text = descriptor.get("text")
                    if not isinstance(descriptor_id, str) or not isinstance(descriptor_text, str):
                        continue

                    match = _DESCRIPTOR_ID_PATTERN.fullmatch(descriptor_id)
                    if match is None:
                        continue

                    if descriptor_id in seen_descriptor_ids:
                        raise ValueError(
                            f"Duplicate descriptor ID in {question_key}: {descriptor_id}"
                        )
                    seen_descriptor_ids.add(descriptor_id)

                    thread_key = match.group("thread_key").casefold()
                    descriptor_ao = match.group("ao").casefold()
                    thread = threads.setdefault(
                        thread_key,
                        {
                            "thread_id": f"{descriptor_ao}-thread-{thread_key}",
                            "levels": [],
                        },
                    )
                    thread["levels"].append({
                        "descriptor_id": descriptor_id,
                        "band": band_label,
                        "text": descriptor_text,
                    })

            objectives_result[ao_key] = {
                "marks_available": objective.get("marks_available"),
                "band_marks": band_marks,
                "threads": threads,
            }

        transformed_questions[question_key] = {
            "marks_available": question.get("marks"),
            "assessment_objectives": objectives_result,
        }

    return {"questions": transformed_questions}
