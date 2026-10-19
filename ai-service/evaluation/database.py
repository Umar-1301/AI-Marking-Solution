"""SQL access for the local AI evaluation suite.

This module deliberately contains both connection management and the small
set of queries used by the CLI. The suite is local tooling, so splitting these
operations into a repository layer would add structure without adding value.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_AI_SERVICE_ROOT / ".env", override=False)
load_dotenv(_AI_SERVICE_ROOT / "local.env", override=False)


class EvaluationDatabaseError(RuntimeError):
    """Raised when evaluation storage is unavailable or inconsistent."""


def _driver():
    try:
        import pymssql
    except ImportError as exc:  # pragma: no cover - depends on local setup
        raise EvaluationDatabaseError(
            "The evaluation CLI requires pymssql. Run pip install -r "
            "ai-service/requirements.txt in the project virtual environment."
        ) from exc
    return pymssql


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise EvaluationDatabaseError(f"Required environment variable {name} is not set")
    return value


def _connection(prefix: str):
    pymssql = _driver()
    port_text = os.getenv(f"{prefix}_PORT", "1433")
    try:
        port = int(port_text)
    except ValueError as exc:
        raise EvaluationDatabaseError(f"{prefix}_PORT must be an integer") from exc

    try:
        return pymssql.connect(
            server=_required_env(f"{prefix}_SERVER"),
            port=port,
            user=_required_env(f"{prefix}_USER"),
            password=_required_env(f"{prefix}_PASSWORD"),
            database=_required_env(f"{prefix}_DATABASE"),
            login_timeout=30,
            timeout=120,
            as_dict=True,
        )
    except Exception as exc:
        raise EvaluationDatabaseError(
            f"Could not connect using the {prefix} SQL configuration"
        ) from exc


def get_connection():
    """Open the isolated evaluation database."""
    return _connection("AI_TEST_SQL")


def get_source_connection():
    """Open the source application database used only during an import."""
    return _connection("AI_SOURCE_SQL")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def hash_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _one(cursor, message: str) -> dict[str, Any]:
    row = cursor.fetchone()
    if row is None:
        raise EvaluationDatabaseError(message)
    return row


def create_target(
    *,
    target_key: str,
    name: str,
    runner_key: str,
    description: str | None = None,
) -> int:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            INSERT INTO evaluation.targets (
                target_key, name, runner_key, description
            )
            OUTPUT INSERTED.target_id
            VALUES (%s, %s, %s, %s)
            """,
            (target_key, name, runner_key, description),
        )
        target_id = int(_one(cursor, "Target insert returned no ID")["target_id"])
        connection.commit()
        return target_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def list_targets() -> list[dict[str, Any]]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT target_id, target_key, name, runner_key, description, created_at
            FROM evaluation.targets
            ORDER BY target_id
            """
        )
        return list(cursor.fetchall())
    finally:
        connection.close()


def get_target(target_id: int) -> dict[str, Any]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT target_id, target_key, name, runner_key, description, created_at
            FROM evaluation.targets
            WHERE target_id = %s
            """,
            (target_id,),
        )
        return _one(cursor, f"Target {target_id} was not found")
    finally:
        connection.close()


def create_dataset(
    *,
    name: str,
    input_data: dict[str, Any],
) -> int:
    input_json = canonical_json(input_data)
    dataset_hash = hash_json(input_data)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT COALESCE(MAX(version), 0) + 1 AS next_version
            FROM evaluation.datasets
            WHERE name = %s
            """,
            (name,),
        )
        version = int(_one(cursor, "Could not determine dataset version")["next_version"])
        cursor.execute(
            """
            INSERT INTO evaluation.datasets (
                name, version, input_data_json, expected_result_json, dataset_hash
            )
            OUTPUT INSERTED.dataset_id
            VALUES (%s, %s, %s, NULL, %s)
            """,
            (name, version, input_json, dataset_hash),
        )
        dataset_id = int(_one(cursor, "Dataset insert returned no ID")["dataset_id"])
        connection.commit()
        return dataset_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def list_datasets() -> list[dict[str, Any]]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT dataset_id, name, version, dataset_hash, created_at
            FROM evaluation.datasets
            ORDER BY dataset_id
            """
        )
        return list(cursor.fetchall())
    finally:
        connection.close()


def get_dataset(dataset_id: int) -> dict[str, Any]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT dataset_id, name, version, input_data_json,
                   dataset_hash, created_at
            FROM evaluation.datasets
            WHERE dataset_id = %s
            """,
            (dataset_id,),
        )
        row = _one(cursor, f"Dataset {dataset_id} was not found")
        try:
            row["input_data"] = json.loads(row.pop("input_data_json"))
        except (TypeError, json.JSONDecodeError) as exc:
            raise EvaluationDatabaseError(
                f"Dataset {dataset_id} contains invalid input JSON"
            ) from exc
        return row
    finally:
        connection.close()


def _normalised_dataset_ids(dataset_ids: list[int]) -> list[int]:
    normalised = [int(dataset_id) for dataset_id in dataset_ids]
    if not normalised:
        raise EvaluationDatabaseError("A batch must contain at least one dataset")
    if len(normalised) != len(set(normalised)):
        raise EvaluationDatabaseError("A batch cannot contain a dataset more than once")
    return normalised


def _validate_dataset_ids(cursor, dataset_ids: list[int]) -> None:
    placeholders = ", ".join(["%s"] * len(dataset_ids))
    cursor.execute(
        f"SELECT dataset_id FROM evaluation.datasets "
        f"WHERE dataset_id IN ({placeholders})",
        tuple(dataset_ids),
    )
    found = {int(row["dataset_id"]) for row in cursor.fetchall()}
    missing = [dataset_id for dataset_id in dataset_ids if dataset_id not in found]
    if missing:
        joined = ", ".join(str(dataset_id) for dataset_id in missing)
        raise EvaluationDatabaseError(f"Datasets were not found: {joined}")


def _refresh_batch_hash(cursor, batch_id: int) -> str:
    cursor.execute(
        """
        SELECT bd.dataset_id, d.dataset_hash
        FROM evaluation.batch_datasets AS bd
        JOIN evaluation.datasets AS d ON d.dataset_id = bd.dataset_id
        WHERE bd.batch_id = %s
        ORDER BY bd.position
        """,
        (batch_id,),
    )
    members = [
        {
            "dataset_id": int(row["dataset_id"]),
            "dataset_hash": row["dataset_hash"],
        }
        for row in cursor.fetchall()
    ]
    if not members:
        raise EvaluationDatabaseError("A batch must contain at least one dataset")
    batch_hash = hash_json(members)
    cursor.execute(
        """
        UPDATE evaluation.batches
        SET batch_hash = %s,
            updated_at = SYSUTCDATETIME()
        WHERE batch_id = %s
        """,
        (batch_hash, batch_id),
    )
    return batch_hash


def create_batch(
    *,
    name: str,
    dataset_ids: list[int],
    description: str | None = None,
) -> int:
    """Create a named, reusable collection of existing datasets."""
    dataset_ids = _normalised_dataset_ids(dataset_ids)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        _validate_dataset_ids(cursor, dataset_ids)
        cursor.execute(
            """
            INSERT INTO evaluation.batches (
                name, description, batch_hash
            )
            OUTPUT INSERTED.batch_id
            VALUES (%s, %s, %s)
            """,
            (name, description, hash_json([])),
        )
        batch_id = int(_one(cursor, "Batch insert returned no ID")["batch_id"])
        for position, dataset_id in enumerate(dataset_ids, 1):
            cursor.execute(
                """
                INSERT INTO evaluation.batch_datasets (
                    batch_id, dataset_id, position
                )
                VALUES (%s, %s, %s)
                """,
                (batch_id, dataset_id, position),
            )
        _refresh_batch_hash(cursor, batch_id)
        connection.commit()
        return batch_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def list_batches() -> list[dict[str, Any]]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT b.batch_id, b.name, b.description, b.batch_hash,
                   b.created_at, b.updated_at,
                   COUNT(bd.dataset_id) AS dataset_count
            FROM evaluation.batches AS b
            LEFT JOIN evaluation.batch_datasets AS bd
                ON bd.batch_id = b.batch_id
            GROUP BY b.batch_id, b.name, b.description, b.batch_hash,
                     b.created_at, b.updated_at
            ORDER BY b.batch_id
            """
        )
        rows = list(cursor.fetchall())
        for row in rows:
            row["dataset_count"] = int(row["dataset_count"])
        return rows
    finally:
        connection.close()


def get_batch(batch_id: int) -> dict[str, Any]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT batch_id, name, description, batch_hash,
                   created_at, updated_at
            FROM evaluation.batches
            WHERE batch_id = %s
            """,
            (batch_id,),
        )
        batch = _one(cursor, f"Batch {batch_id} was not found")
        cursor.execute(
            """
            SELECT bd.position, d.dataset_id, d.name, d.version,
                   d.dataset_hash, d.input_data_json, d.created_at
            FROM evaluation.batch_datasets AS bd
            JOIN evaluation.datasets AS d ON d.dataset_id = bd.dataset_id
            WHERE bd.batch_id = %s
            ORDER BY bd.position
            """,
            (batch_id,),
        )
        datasets = list(cursor.fetchall())
        for dataset in datasets:
            try:
                dataset["input_data"] = json.loads(dataset.pop("input_data_json"))
            except (TypeError, json.JSONDecodeError) as exc:
                raise EvaluationDatabaseError(
                    f"Dataset {dataset['dataset_id']} contains invalid input JSON"
                ) from exc
        batch["datasets"] = datasets
        batch["dataset_count"] = len(datasets)
        return batch
    finally:
        connection.close()


def update_batch(
    batch_id: int,
    *,
    name: str | None = None,
    description: str | None = None,
) -> None:
    if name is None and description is None:
        return
    assignments: list[str] = []
    values: list[Any] = []
    if name is not None:
        assignments.append("name = %s")
        values.append(name)
    if description is not None:
        assignments.append("description = %s")
        values.append(description or None)
    assignments.append("updated_at = SYSUTCDATETIME()")
    values.append(batch_id)

    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            f"UPDATE evaluation.batches SET {', '.join(assignments)} "
            "WHERE batch_id = %s",
            tuple(values),
        )
        if cursor.rowcount != 1:
            raise EvaluationDatabaseError(f"Batch {batch_id} was not found")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def add_batch_datasets(batch_id: int, dataset_ids: list[int]) -> None:
    dataset_ids = _normalised_dataset_ids(dataset_ids)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            "SELECT batch_id FROM evaluation.batches WHERE batch_id = %s",
            (batch_id,),
        )
        _one(cursor, f"Batch {batch_id} was not found")
        _validate_dataset_ids(cursor, dataset_ids)
        placeholders = ", ".join(["%s"] * len(dataset_ids))
        cursor.execute(
            f"""
            SELECT dataset_id
            FROM evaluation.batch_datasets
            WHERE batch_id = %s AND dataset_id IN ({placeholders})
            """,
            (batch_id, *dataset_ids),
        )
        duplicates = [int(row["dataset_id"]) for row in cursor.fetchall()]
        if duplicates:
            joined = ", ".join(str(dataset_id) for dataset_id in duplicates)
            raise EvaluationDatabaseError(
                f"Datasets already belong to batch {batch_id}: {joined}"
            )
        cursor.execute(
            """
            SELECT COALESCE(MAX(position), 0) AS last_position
            FROM evaluation.batch_datasets
            WHERE batch_id = %s
            """,
            (batch_id,),
        )
        position = int(_one(cursor, "Could not read batch position")["last_position"])
        for dataset_id in dataset_ids:
            position += 1
            cursor.execute(
                """
                INSERT INTO evaluation.batch_datasets (
                    batch_id, dataset_id, position
                )
                VALUES (%s, %s, %s)
                """,
                (batch_id, dataset_id, position),
            )
        _refresh_batch_hash(cursor, batch_id)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def remove_batch_datasets(batch_id: int, dataset_ids: list[int]) -> None:
    dataset_ids = _normalised_dataset_ids(dataset_ids)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            "SELECT COUNT(*) AS dataset_count FROM evaluation.batch_datasets "
            "WHERE batch_id = %s",
            (batch_id,),
        )
        current_count = int(_one(cursor, "Could not read batch")["dataset_count"])
        if current_count == 0:
            raise EvaluationDatabaseError(f"Batch {batch_id} was not found or is empty")
        placeholders = ", ".join(["%s"] * len(dataset_ids))
        cursor.execute(
            f"""
            SELECT dataset_id
            FROM evaluation.batch_datasets
            WHERE batch_id = %s AND dataset_id IN ({placeholders})
            """,
            (batch_id, *dataset_ids),
        )
        found = {int(row["dataset_id"]) for row in cursor.fetchall()}
        missing = [dataset_id for dataset_id in dataset_ids if dataset_id not in found]
        if missing:
            joined = ", ".join(str(dataset_id) for dataset_id in missing)
            raise EvaluationDatabaseError(
                f"Datasets are not members of batch {batch_id}: {joined}"
            )
        if current_count - len(dataset_ids) < 1:
            raise EvaluationDatabaseError("A batch must retain at least one dataset")
        cursor.execute(
            f"""
            DELETE FROM evaluation.batch_datasets
            WHERE batch_id = %s AND dataset_id IN ({placeholders})
            """,
            (batch_id, *dataset_ids),
        )
        _refresh_batch_hash(cursor, batch_id)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def save_prompt_snapshot(
    *,
    target_id: int,
    name: str,
    prompt: dict[str, Any],
) -> int:
    prompt_hash = hash_json(prompt)
    prompt_json = canonical_json(prompt)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT TOP 1 prompt_id
            FROM evaluation.prompts
            WHERE target_id = %s AND prompt_hash = %s
            ORDER BY prompt_id DESC
            """,
            (target_id, prompt_hash),
        )
        existing = cursor.fetchone()
        if existing is not None:
            return int(existing["prompt_id"])

        cursor.execute(
            """
            SELECT COALESCE(MAX(version), 0) + 1 AS next_version
            FROM evaluation.prompts
            WHERE target_id = %s AND name = %s
            """,
            (target_id, name),
        )
        version = int(_one(cursor, "Could not determine prompt version")["next_version"])
        cursor.execute(
            """
            INSERT INTO evaluation.prompts (
                target_id, name, version, prompt_json, prompt_hash
            )
            OUTPUT INSERTED.prompt_id
            VALUES (%s, %s, %s, %s, %s)
            """,
            (target_id, name, version, prompt_json, prompt_hash),
        )
        prompt_id = int(_one(cursor, "Prompt insert returned no ID")["prompt_id"])
        connection.commit()
        return prompt_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def create_evaluation(
    *,
    target_id: int,
    dataset_id: int | None = None,
    batch_id: int | None = None,
    batch_hash_snapshot: str | None = None,
    prompt_id: int,
    name: str,
    requested_runs: int,
    model_requested: str,
    temperature: float,
) -> int:
    if (dataset_id is None) == (batch_id is None):
        raise ValueError("An evaluation requires exactly one dataset or one batch")
    input_mode = "batch" if batch_id is not None else "single"
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            INSERT INTO evaluation.evaluations (
                target_id, dataset_id, batch_id, input_mode,
                batch_hash_snapshot, prompt_id, name, status,
                requested_runs, model_requested, temperature, started_at
            )
            OUTPUT INSERTED.evaluation_id
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, N'running',
                %s, %s, %s, SYSUTCDATETIME()
            )
            """,
            (
                target_id,
                dataset_id,
                batch_id,
                input_mode,
                batch_hash_snapshot,
                prompt_id,
                name,
                requested_runs,
                model_requested,
                temperature,
            ),
        )
        evaluation_id = int(
            _one(cursor, "Evaluation insert returned no ID")["evaluation_id"]
        )
        connection.commit()
        return evaluation_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def save_result(
    *,
    evaluation_id: int,
    dataset_id: int,
    run_number: int,
    status: str,
    actual_result: dict[str, Any] | None,
    error_message: str | None = None,
) -> int:
    result_json = canonical_json(actual_result) if actual_result is not None else None
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            INSERT INTO evaluation.results (
                evaluation_id, dataset_id, run_number, status, actual_result_json,
                comparison_json, error_message
            )
            OUTPUT INSERTED.result_id
            VALUES (%s, %s, %s, %s, %s, NULL, %s)
            """,
            (
                evaluation_id,
                dataset_id,
                run_number,
                status,
                result_json,
                error_message,
            ),
        )
        result_id = int(_one(cursor, "Result insert returned no ID")["result_id"])
        connection.commit()
        return result_id
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def save_performance(
    *,
    result_id: int,
    performance: dict[str, Any],
) -> None:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            INSERT INTO evaluation.performance (
                result_id, model_returned, finish_reason, duration_ms,
                prompt_tokens, completion_tokens, total_tokens
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                result_id,
                performance.get("model_returned"),
                performance.get("finish_reason"),
                performance.get("duration_ms"),
                performance.get("prompt_tokens"),
                performance.get("completion_tokens"),
                performance.get("total_tokens"),
            ),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def complete_evaluation(evaluation_id: int, status: str) -> None:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            UPDATE evaluation.evaluations
            SET status = %s,
                completed_at = SYSUTCDATETIME()
            WHERE evaluation_id = %s
            """,
            (status, evaluation_id),
        )
        if cursor.rowcount != 1:
            raise EvaluationDatabaseError(f"Evaluation {evaluation_id} was not found")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def get_evaluation(evaluation_id: int) -> dict[str, Any]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT e.evaluation_id, e.name, e.status, e.requested_runs,
                   e.model_requested, e.temperature, e.started_at,
                   e.completed_at, e.target_id, t.name AS target_name,
                   e.input_mode, e.dataset_id, d.name AS dataset_name,
                   e.batch_id, b.name AS batch_name,
                   e.batch_hash_snapshot, e.prompt_id
            FROM evaluation.evaluations AS e
            JOIN evaluation.targets AS t ON t.target_id = e.target_id
            LEFT JOIN evaluation.datasets AS d ON d.dataset_id = e.dataset_id
            LEFT JOIN evaluation.batches AS b ON b.batch_id = e.batch_id
            WHERE e.evaluation_id = %s
            """,
            (evaluation_id,),
        )
        evaluation = _one(cursor, f"Evaluation {evaluation_id} was not found")
        cursor.execute(
            """
            SELECT status, COUNT(*) AS run_count
            FROM evaluation.results
            WHERE evaluation_id = %s
            GROUP BY status
            """,
            (evaluation_id,),
        )
        evaluation["result_counts"] = {
            row["status"]: int(row["run_count"])
            for row in cursor.fetchall()
        }
        return evaluation
    finally:
        connection.close()


def list_dashboard_targets() -> list[dict[str, Any]]:
    """Return targets with lightweight counts for the dashboard selector."""
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT t.target_id, t.target_key, t.name, t.runner_key,
                   t.description, t.created_at,
                   COUNT(DISTINCT e.evaluation_id) AS evaluation_count,
                   COUNT(r.result_id) AS result_count
            FROM evaluation.targets AS t
            LEFT JOIN evaluation.evaluations AS e
                ON e.target_id = t.target_id
            LEFT JOIN evaluation.results AS r
                ON r.evaluation_id = e.evaluation_id
            GROUP BY t.target_id, t.target_key, t.name, t.runner_key,
                     t.description, t.created_at
            ORDER BY t.target_id
            """
        )
        rows = list(cursor.fetchall())
        for row in rows:
            row["evaluation_count"] = int(row["evaluation_count"])
            row["result_count"] = int(row["result_count"])
        return rows
    finally:
        connection.close()


def _decoded_result_json(value: Any) -> Any:
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {"unparsed_result": value}


def get_target_dashboard(target_id: int) -> dict[str, Any]:
    """Return every evaluation, result and performance row for one target."""
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            """
            SELECT target_id, target_key, name, runner_key, description, created_at
            FROM evaluation.targets
            WHERE target_id = %s
            """,
            (target_id,),
        )
        target = _one(cursor, f"Target {target_id} was not found")

        cursor.execute(
            """
            SELECT e.evaluation_id, e.name, e.status, e.requested_runs,
                   e.model_requested, e.temperature, e.started_at,
                   e.completed_at, e.created_at, e.input_mode, e.dataset_id,
                   d.name AS dataset_name, d.version AS dataset_version,
                   d.dataset_hash, e.batch_id, b.name AS batch_name,
                   e.batch_hash_snapshot, e.prompt_id
            FROM evaluation.evaluations AS e
            LEFT JOIN evaluation.datasets AS d ON d.dataset_id = e.dataset_id
            LEFT JOIN evaluation.batches AS b ON b.batch_id = e.batch_id
            WHERE e.target_id = %s
            ORDER BY e.created_at DESC, e.evaluation_id DESC
            """,
            (target_id,),
        )
        evaluations = list(cursor.fetchall())
        by_id = {
            int(evaluation["evaluation_id"]): evaluation
            for evaluation in evaluations
        }
        for evaluation in evaluations:
            evaluation["results"] = []

        if evaluations:
            cursor.execute(
                """
                SELECT r.result_id, r.evaluation_id, r.dataset_id,
                       d.name AS dataset_name, d.version AS dataset_version,
                       r.run_number,
                       r.status, r.actual_result_json, r.error_message,
                       r.created_at,
                       p.performance_id, p.model_returned, p.finish_reason,
                       p.duration_ms, p.prompt_tokens,
                       p.completion_tokens, p.total_tokens
                FROM evaluation.results AS r
                JOIN evaluation.evaluations AS e
                    ON e.evaluation_id = r.evaluation_id
                JOIN evaluation.datasets AS d
                    ON d.dataset_id = r.dataset_id
                LEFT JOIN evaluation.performance AS p
                    ON p.result_id = r.result_id
                WHERE e.target_id = %s
                ORDER BY r.evaluation_id DESC, r.run_number
                """,
                (target_id,),
            )
            for row in cursor.fetchall():
                evaluation = by_id.get(int(row["evaluation_id"]))
                if evaluation is None:
                    continue
                result = {
                    "result_id": row["result_id"],
                    "dataset_id": row["dataset_id"],
                    "dataset_name": row["dataset_name"],
                    "dataset_version": row["dataset_version"],
                    "run_number": row["run_number"],
                    "status": row["status"],
                    "actual_result": _decoded_result_json(
                        row["actual_result_json"]
                    ),
                    "error_message": row["error_message"],
                    "created_at": row["created_at"],
                    "performance": {
                        "performance_id": row["performance_id"],
                        "model_returned": row["model_returned"],
                        "finish_reason": row["finish_reason"],
                        "duration_ms": row["duration_ms"],
                        "prompt_tokens": row["prompt_tokens"],
                        "completion_tokens": row["completion_tokens"],
                        "total_tokens": row["total_tokens"],
                    },
                }
                evaluation["results"].append(result)

        return {"target": target, "evaluations": evaluations}
    finally:
        connection.close()
