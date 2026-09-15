"""Project evidence-thread results into frontend-ready final-band evidence."""

from typing import Any


def extract_final_band_evidence(
    segmented_result: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Return every evidence quote with its final-band descriptor reference.

    The result preserves the source thread and evidence order. It intentionally
    retains evidence with no securely met final band so the frontend can still
    show every identified attempt, with ``descriptor_id`` and ``band`` set to
    ``None`` for those entries.
    """
    if not isinstance(segmented_result, dict):
        raise TypeError("segmented_result must be a dictionary")

    extracted_threads: list[dict[str, Any]] = []
    threads = segmented_result.get("threads")
    if not isinstance(threads, list):
        return {"threads": extracted_threads}

    for thread in threads:
        if not isinstance(thread, dict):
            continue

        final_band_evidence: list[dict[str, Any]] = []
        evidence_items = thread.get("evidence")
        if isinstance(evidence_items, list):
            for evidence in evidence_items:
                if not isinstance(evidence, dict):
                    continue

                final_band = evidence.get("final_band")
                if not isinstance(final_band, dict):
                    final_band = {}

                final_band_evidence.append({
                    "evidence_id": evidence.get("evidence_id"),
                    "quote": evidence.get("quote"),
                    "final_band": {
                        "descriptor_id": final_band.get("descriptor_id"),
                        "band": final_band.get("band"),
                    },
                })

        extracted_threads.append({
            "thread_id": thread.get("thread_id"),
            "thread_description": thread.get("thread_description"),
            "final_band_evidence": final_band_evidence,
        })

    return {"threads": extracted_threads}
