"""Content-integrity validation for extracted mark-scheme descriptors.

Boundary validation answers whether the application and model identify the
same individual descriptor points. This module independently answers whether
the complete text of the model's descriptor list still matches the raw
``descriptor`` text supplied for the band.
"""

import re
import unicodedata
from typing import Any

from observability.event_log import log_descriptor_integrity_comparison
from validation.descriptor_validation import is_general_assessment_objective


DESCRIPTOR_CONTENT_MISMATCH = "descriptor_content_mismatch"

_STRUCTURAL_LIST_MARKER = re.compile(
    r"(?:[•▪◦●○*]\s*|(?<!\S)(?:[-–—]|(?:\d+|[A-Za-z])[.)])\s+)"
)


def flatten_descriptors(descriptors: list[str]) -> str:
    """Join descriptor points in source order for a content comparison."""
    return " ".join(item.strip() for item in descriptors if item.strip())


def normalise_descriptor_content(value: str) -> str:
    """Normalise presentation-only differences without changing the wording."""
    normalised = unicodedata.normalize("NFKC", value)
    normalised = _STRUCTURAL_LIST_MARKER.sub(" ", normalised)
    return " ".join(normalised.split()).casefold()


def _issue(
    *,
    question_number: object,
    ao: object,
    band: object,
    descriptor: object,
    model_descriptors: list[str],
    flattened_model_descriptors: str,
    normalised_descriptor: str,
    normalised_flattened_model_descriptors: str,
) -> dict[str, Any]:
    return {
        "rule": DESCRIPTOR_CONTENT_MISMATCH,
        "question_number": question_number,
        "ao": ao,
        "band": band,
        "descriptor": descriptor,
        "model_descriptors": model_descriptors,
        "flattened_model_descriptors": flattened_model_descriptors,
        "normalised_descriptor": normalised_descriptor,
        "normalised_flattened_model_descriptors": (
            normalised_flattened_model_descriptors
        ),
        "reason": (
            "The flattened model-generated descriptors did not preserve the "
            "complete descriptor text."
        ),
    }


def validate_descriptor_content_integrity(
    structured_scheme: dict[str, Any],
) -> list[dict[str, Any]]:
    """Verify that every model descriptor list preserves its raw text.

    This is intentionally independent of the boundary checker. It verifies
    complete content and ordering, but does not claim to prove that inferred
    boundaries are semantically perfect.
    """
    if not isinstance(structured_scheme, dict):
        raise TypeError("structured_scheme must be a dictionary")

    issues: list[dict[str, Any]] = []
    questions = structured_scheme.get("questions")
    if not isinstance(questions, list):
        return issues

    for question in questions:
        if not isinstance(question, dict):
            continue

        question_number = question.get("question_number")
        objectives = question.get("assessment_objectives")
        if not isinstance(objectives, list):
            continue

        for objective in objectives:
            if not isinstance(objective, dict):
                continue

            ao = objective.get("ao")
            if is_general_assessment_objective(ao):
                continue

            bands = objective.get("bands")
            if not isinstance(bands, list):
                continue

            for band_data in bands:
                if not isinstance(band_data, dict):
                    continue

                descriptor = band_data.get("descriptor")
                model_descriptors = band_data.get("descriptors")
                valid_model_list = (
                    isinstance(model_descriptors, list)
                    and all(isinstance(item, str) for item in model_descriptors)
                )
                model_list = model_descriptors if valid_model_list else []
                flattened = flatten_descriptors(model_list)
                normalised_descriptor = (
                    normalise_descriptor_content(descriptor)
                    if isinstance(descriptor, str)
                    else ""
                )
                normalised_flattened = normalise_descriptor_content(flattened)
                content_matches = (
                    isinstance(descriptor, str)
                    and valid_model_list
                    and bool(normalised_descriptor)
                    and normalised_descriptor == normalised_flattened
                )

                log_descriptor_integrity_comparison(
                    question_number=question_number,
                    ao=ao,
                    band=band_data.get("band"),
                    descriptor=descriptor,
                    model_descriptors=model_list,
                    flattened_model_descriptors=flattened,
                    normalised_descriptor=normalised_descriptor,
                    normalised_flattened_model_descriptors=normalised_flattened,
                    content_matches=content_matches,
                )

                if not content_matches:
                    issues.append(_issue(
                        question_number=question_number,
                        ao=ao,
                        band=band_data.get("band"),
                        descriptor=descriptor,
                        model_descriptors=model_list,
                        flattened_model_descriptors=flattened,
                        normalised_descriptor=normalised_descriptor,
                        normalised_flattened_model_descriptors=normalised_flattened,
                    ))

    return issues
