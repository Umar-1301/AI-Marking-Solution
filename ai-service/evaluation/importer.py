"""Import immutable evaluation inputs from the application SQL database."""

from __future__ import annotations

import json
from typing import Any

from evaluation import database


class DatasetImportError(ValueError):
    """Raised when a source marking result cannot form a usable dataset."""


def _parse_json(value: Any, field: str, *, required: bool) -> Any:
    if value is None or value == "":
        if required:
            raise DatasetImportError(f"Source result is missing {field}")
        return None
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        raise DatasetImportError(f"Source field {field} is not JSON text")
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise DatasetImportError(f"Source field {field} contains invalid JSON") from exc


def _selected_question(structured_scheme: dict[str, Any], index: Any) -> dict[str, Any]:
    questions = structured_scheme.get("questions")
    if not isinstance(questions, list) or not questions:
        raise DatasetImportError("Structured scheme contains no questions")
    selected_index = index if isinstance(index, int) else 0
    if selected_index < 0 or selected_index >= len(questions):
        selected_index = 0
    question = questions[selected_index]
    if not isinstance(question, dict):
        raise DatasetImportError("Selected scheme question is not an object")
    return question


def _selected_threads(
    thread_extraction: dict[str, Any],
    question: dict[str, Any],
) -> dict[str, Any]:
    questions = thread_extraction.get("questions")
    if not isinstance(questions, dict):
        raise DatasetImportError("Thread extraction has no keyed questions")
    question_number = question.get("question_number")
    selected = questions.get(question_number)
    if selected is None:
        selected = questions.get(str(question_number))
    if not isinstance(selected, dict):
        raise DatasetImportError(
            f"No thread extraction was found for question {question_number!r}"
        )
    return selected


def load_source_marking_result(marking_result_id: int) -> dict[str, Any]:
    """Read one complete source snapshot without modifying the source DB."""
    connection = database.get_source_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT mr.id AS marking_result_id,
                   mr.lesson_id,
                   mr.student_id,
                   mr.marked_at,
                   mr.student_grade,
                   mr.aggregation_result,
                   mr.final_result,
                   so.ocr_text AS student_response,
                   selected_ocr.structured_scheme,
                   selected_ocr.thread_extraction,
                   selected_ocr.selected_question_index
            FROM dbo.marking_results AS mr
            JOIN dbo.student_ocr AS so ON so.id = mr.ocr_id
            OUTER APPLY (
                SELECT TOP 1 t.structured_scheme,
                             t.thread_extraction,
                             t.selected_question_index
                FROM dbo.teacher_ocr AS t
                WHERE t.lesson_id = mr.lesson_id
                ORDER BY t.id DESC
            ) AS selected_ocr
            WHERE mr.id = %s
            """,
            (marking_result_id,),
        )
        row = cursor.fetchone()
        if row is None:
            raise DatasetImportError(
                f"Marking result {marking_result_id} was not found in the source database"
            )
        return row
    finally:
        connection.close()


def build_frozen_dataset(source: dict[str, Any]) -> dict[str, Any]:
    """Convert the source row into the stable shape consumed by runners."""
    structured_scheme = _parse_json(
        source.get("structured_scheme"),
        "structured_scheme",
        required=True,
    )
    thread_extraction = _parse_json(
        source.get("thread_extraction"),
        "thread_extraction",
        required=True,
    )
    student_grade = _parse_json(
        source.get("student_grade"),
        "student_grade",
        required=True,
    )
    if not isinstance(structured_scheme, dict):
        raise DatasetImportError("structured_scheme must be a JSON object")
    if not isinstance(thread_extraction, dict):
        raise DatasetImportError("thread_extraction must be a JSON object")
    if not isinstance(student_grade, dict):
        raise DatasetImportError("student_grade must be a JSON object")

    question = _selected_question(
        structured_scheme,
        source.get("selected_question_index"),
    )
    selected_threads = _selected_threads(thread_extraction, question)
    student_response = source.get("student_response")
    if not isinstance(student_response, str) or not student_response.strip():
        raise DatasetImportError("Source result has no student OCR text")

    return {
        "schema_version": 1,
        "source": {
            "marking_result_id": source.get("marking_result_id"),
            "lesson_id": source.get("lesson_id"),
            "student_id": source.get("student_id"),
            "marked_at": source.get("marked_at"),
        },
        "selected_scheme": question,
        "selected_thread_extraction": selected_threads,
        "student_response": student_response,
        "student_grade": student_grade,
        "aggregation": _parse_json(
            source.get("aggregation_result"),
            "aggregation_result",
            required=False,
        ),
        "final_result": _parse_json(
            source.get("final_result"),
            "final_result",
            required=False,
        ),
    }


def import_production_dataset(
    *,
    marking_result_id: int,
    name: str | None = None,
) -> int:
    """Import once, then run all evaluations from the frozen test copy."""
    source = load_source_marking_result(marking_result_id)
    frozen = build_frozen_dataset(source)
    return database.create_dataset(
        name=name or f"marking-result-{marking_result_id}",
        input_data=frozen,
    )


def import_production_datasets(marking_result_ids: list[int]) -> list[int]:
    """Bulk-import source results as individual reusable datasets."""
    imported: list[int] = []
    for marking_result_id in marking_result_ids:
        imported.append(
            import_production_dataset(marking_result_id=marking_result_id)
        )
    return imported
