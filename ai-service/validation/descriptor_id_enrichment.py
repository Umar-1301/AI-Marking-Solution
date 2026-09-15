"""Deterministic provenance-ID enrichment for validated descriptors."""

from copy import deepcopy
import re
import unicodedata
from typing import Any

from validation.descriptor_validation import (
    is_general_assessment_objective,
    split_descriptor_bullets,
)


DESCRIPTOR_ID_UNAVAILABLE = "descriptor_id_unavailable"


def _normalise_ao(ao: str) -> str | None:
    """Return a stable lowercase AO component suitable for descriptor IDs."""
    normalised = unicodedata.normalize("NFKC", ao).casefold()
    normalised = re.sub(r"\s+", "", normalised)
    normalised = re.sub(r"[^a-z0-9]+", "-", normalised).strip("-")
    return normalised or None


def _band_number(band: object) -> str | None:
    if not isinstance(band, str):
        return None

    match = re.search(r"\d+", band)
    return match.group(0) if match else None


def _letter_suffix(index: int) -> str:
    """Return a, ..., z, aa, ab, ... for a zero-based descriptor index."""
    if index < 0:
        raise ValueError("Descriptor index must be non-negative")

    suffix = ""
    value = index + 1
    while value:
        value, remainder = divmod(value - 1, 26)
        suffix = chr(ord("a") + remainder) + suffix
    return suffix


def _issue(
    *,
    question_number: object,
    ao: object,
    band: object,
    descriptor: object,
    model_descriptors: object,
    reason: str,
) -> dict[str, Any]:
    return {
        "rule": DESCRIPTOR_ID_UNAVAILABLE,
        "question_number": question_number,
        "ao": ao,
        "band": band,
        "descriptor": descriptor,
        "model_descriptors": model_descriptors,
        "reason": reason,
    }


def add_descriptor_ids(
    structured_scheme: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Add deterministic IDs after descriptor validations have succeeded.

    The supplied scheme is never modified. This function rebuilds descriptor
    points from the complete raw ``descriptor`` text, so the stored ``text``
    values originate from the application parser—not from the LLM's list.
    The caller must run both descriptor validation gates first.
    """
    if not isinstance(structured_scheme, dict):
        raise TypeError("structured_scheme must be a dictionary")

    enriched_scheme = deepcopy(structured_scheme)
    issues: list[dict[str, Any]] = []
    questions = enriched_scheme.get("questions")
    if not isinstance(questions, list):
        return enriched_scheme, issues

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
                application_descriptors = split_descriptor_bullets(descriptor)
                ao_component = _normalise_ao(ao) if isinstance(ao, str) else None
                band_component = _band_number(band_data.get("band"))
                if (
                    not application_descriptors
                    or ao_component is None
                    or band_component is None
                ):
                    issues.append(_issue(
                        question_number=question_number,
                        ao=ao,
                        band=band_data.get("band"),
                        descriptor=descriptor,
                        model_descriptors=model_descriptors,
                        reason=(
                            "A descriptor ID could not be generated because the "
                            "application descriptor list, AO, or numeric band "
                            "component was unavailable."
                        ),
                    ))
                    continue

                band_data["descriptors"] = [
                    {
                        "id": f"{ao_component}-{band_component}{_letter_suffix(index)}",
                        "text": descriptor_text,
                    }
                    for index, descriptor_text in enumerate(application_descriptors)
                ]

    return enriched_scheme, issues
