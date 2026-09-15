import re


def mark_range(value):
    match = re.fullmatch(r"\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*", str(value))
    if not match:
        raise ValueError(f"Unrecognised mark range: {value}")
    low = int(match[1])
    high = int(match[2] or match[1])
    if low > high:
        raise ValueError(f"Invalid mark range: {value}")
    return low, high


def build_final_marking_context(aggregation, scheme, thread_extraction):
    """Allowlist final-pass inputs, removing all earlier marking judgements."""
    if not isinstance(aggregation, dict) or aggregation.get("status") != "complete":
        raise ValueError("Final marking requires completed aggregation")
    if not isinstance(scheme, dict) or not isinstance(scheme.get("assessment_objectives"), list):
        raise ValueError("Final marking requires the selected structured question")
    if not isinstance(thread_extraction, dict):
        raise ValueError("Final marking requires thread descriptions")
    question_marks = scheme.get("marks")
    if type(question_marks) is not int or question_marks <= 0:
        raise ValueError("Final marking requires question marks from the selected scheme")

    supplied_objectives = thread_extraction.get("assessment_objectives", {})
    if not isinstance(supplied_objectives, dict):
        raise ValueError("Final marking requires keyed assessment-objective threads")
    objectives = []
    descriptor_threads = {}
    for objective in scheme["assessment_objectives"]:
        if not isinstance(objective, dict) or not isinstance(objective.get("ao"), str):
            raise ValueError("Final marking requires assessment-objective names")
        ao = objective["ao"]
        maximum = objective.get("marks_available")
        if type(maximum) is not int or maximum <= 0:
            raise ValueError(f"Final marking requires marks available for {ao}")
        supplied_objective = supplied_objectives.get(ao)
        if not isinstance(supplied_objective, dict) or not isinstance(supplied_objective.get("threads"), dict):
            raise ValueError(f"Final marking requires thread descriptions for {ao}")
        band_marks = supplied_objective.get("band_marks")
        if not isinstance(band_marks, list) or not band_marks:
            raise ValueError(f"Final marking requires band marks from thread extraction for {ao}")
        for band in band_marks:
            if (
                not isinstance(band, dict)
                or not isinstance(band.get("band"), str)
                or not isinstance(band.get("marks"), str)
            ):
                raise ValueError(f"Final marking requires valid band marks from thread extraction for {ao}")
            _, high = mark_range(band["marks"])
            if high > maximum:
                raise ValueError(f"Band marks exceed the maximum for {ao}")
        supplied = supplied_objective["threads"]
        threads = []
        for key, supplied_thread in supplied.items():
            thread_id = supplied_thread.get("thread_id") if isinstance(supplied_thread, dict) else None
            description = supplied_thread.get("thread_description") if isinstance(supplied_thread, dict) else None
            levels = supplied_thread.get("levels") if isinstance(supplied_thread, dict) else None
            if not isinstance(thread_id, str) or not thread_id.strip():
                raise ValueError(f"Final marking requires an ID for {ao} thread {key}")
            if not isinstance(description, str) or not description.strip():
                raise ValueError(f"Final marking requires a description for {ao} thread {key}")
            if not isinstance(levels, list) or not levels:
                raise ValueError(f"Final marking requires levels for {ao} thread {key}")
            for level in levels:
                if (
                    not isinstance(level, dict)
                    or not isinstance(level.get("descriptor_id"), str)
                    or not level["descriptor_id"].strip()
                    or not isinstance(level.get("band"), str)
                    or not level["band"].strip()
                    or not isinstance(level.get("text"), str)
                    or not level["text"].strip()
                ):
                    raise ValueError(f"Final marking requires valid levels for {ao} thread {key}")
                descriptor_id = level["descriptor_id"]
                if descriptor_id in descriptor_threads:
                    raise ValueError(f"Final marking requires unique descriptor IDs: {descriptor_id}")
                descriptor_threads[descriptor_id] = thread_id
            threads.append({
                "thread_id": thread_id,
                "thread_description": description,
                "levels": levels,
            })
        if not threads:
            raise ValueError(f"Final marking requires descriptor threads for {ao}")
        objectives.append({
            "ao": ao,
            "description": objective.get("description", ""),
            "marks_available": maximum,
            "band_marks": band_marks,
            "threads": threads,
        })

    if not objectives:
        raise ValueError("Final marking requires assessment objectives")
    source_result = aggregation.get("result")
    if not isinstance(source_result, dict) or not isinstance(source_result.get("evidence"), list):
        raise ValueError("Final marking requires an aggregation evidence catalogue")
    evidence = []
    for index, item in enumerate(source_result["evidence"], 1):
        if not isinstance(item, dict):
            raise ValueError("Final marking requires structured evidence entries")
        quote = item.get("quote")
        ids = item.get("descriptor_ids")
        if not isinstance(quote, str) or not quote.strip() or not isinstance(ids, list) or not ids:
            raise ValueError("Final marking requires quotes with descriptor matches")
        if any(not isinstance(id_, str) or id_ not in descriptor_threads for id_ in ids):
            raise ValueError("Aggregation references a descriptor outside the selected scheme")
        evidence.append({
            "evidence_id": f"e{index}",
            "quote": quote,
            "thread_ids": list(dict.fromkeys(descriptor_threads[descriptor_id] for descriptor_id in ids)),
        })

    return {
        "question": {
            "question_number": scheme.get("question_number", ""),
            "description": scheme.get("description", ""),
            "marks_available": question_marks,
        },
        "assessment_objectives": objectives,
        "evidence": evidence,
    }


def reconcile_final_score(result):
    """Make the per-AO breakdown authoritative while retaining the LLM total."""
    original_score = result.get("original_score", result["score"])
    score = sum(item["marks"] for item in result["breakdown"])
    return {
        **result,
        "score": score,
        "original_score": original_score,
        "delta": score - original_score,
    }


def resolve_final_marking_result(result, context):
    """Check marks/references and attach source quotes without regenerating them."""
    result = reconcile_final_score(result)
    objectives = {ao["ao"]: ao for ao in context["assessment_objectives"]}
    sections = [item["section"] for item in result["breakdown"]]
    if len(sections) != len(set(sections)) or set(sections) != set(objectives):
        raise ValueError("Final marking must cover each assessment objective exactly once")
    for item in result["breakdown"]:
        objective = objectives[item["section"]]
        ranges = {band["band"]: mark_range(band["marks"]) for band in objective["band_marks"]}
        limits = ranges.get(item["awarded_band"])
        if limits is None or not limits[0] <= item["marks"] <= limits[1]:
            raise ValueError("Final mark is outside its awarded band range")
        if item["max_marks"] != objective["marks_available"]:
            raise ValueError("Final AO maximum differs from the mark scheme")
    if result["max_score"] != sum(ao["marks_available"] for ao in objectives.values()):
        raise ValueError("Final maximum differs from the mark scheme")

    sources = {item["evidence_id"]: item for item in context["evidence"]}
    selected = set()
    evidence = []
    for item in result["evidence"]:
        source = sources.get(item["evidence_id"])
        if source is None or item["evidence_id"] in selected:
            raise ValueError("Final marking returned an unknown or repeated evidence ID")
        selected.add(item["evidence_id"])
        evidence.append({**item, "quote": source["quote"]})
    if selected != set(sources):
        raise ValueError("Final marking must return every supplied evidence ID")
    if result["score"] > 0 and not evidence:
        raise ValueError("A positive final mark requires supporting evidence")
    return {**result, "evidence": evidence}
