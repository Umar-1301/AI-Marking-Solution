"""Shared execution lifecycle for single-dataset and batch evaluations."""

from __future__ import annotations

from time import perf_counter
from typing import Any, Callable

from evaluation import database
from evaluation.runners import get_runner


ProgressCallback = Callable[[dict[str, Any]], None]


def _question_signature(dataset: dict[str, Any]) -> str:
    input_data = dataset.get("input_data")
    if not isinstance(input_data, dict):
        raise ValueError(f"Dataset {dataset.get('dataset_id')} has no input data")
    return database.hash_json({
        "selected_scheme": input_data.get("selected_scheme"),
        "selected_thread_extraction": input_data.get("selected_thread_extraction"),
    })


def _validate_batch_datasets(
    datasets: list[dict[str, Any]],
    runner: dict[str, Any],
) -> None:
    if not datasets:
        raise ValueError("A batch must contain at least one dataset")
    signatures: dict[str, list[int]] = {}
    for dataset in datasets:
        runner["validate"](dataset)
        signature = _question_signature(dataset)
        signatures.setdefault(signature, []).append(int(dataset["dataset_id"]))
    if len(signatures) > 1:
        groups = "; ".join(
            ", ".join(str(dataset_id) for dataset_id in dataset_ids)
            for dataset_ids in signatures.values()
        )
        raise ValueError(
            "Batch datasets do not share the same selected question and "
            f"thread extraction: {groups}"
        )


def _execute_calls(
    *,
    evaluation_id: int,
    datasets: list[dict[str, Any]],
    runner: dict[str, Any],
    progress: ProgressCallback | None,
) -> tuple[int, int, str]:
    successes = 0
    failures = 0
    requested_runs = len(datasets)

    try:
        for run_number, dataset in enumerate(datasets, 1):
            dataset_id = int(dataset["dataset_id"])
            started = perf_counter()
            try:
                output = runner["execute"](dataset)
                result = output.get("result")
                performance = output.get("performance") or {}
                if not isinstance(result, dict):
                    raise ValueError("Runner returned no result object")
                if not isinstance(performance, dict):
                    raise ValueError("Runner returned invalid performance data")
            except Exception as exc:
                duration_ms = round((perf_counter() - started) * 1000)
                result_id = database.save_result(
                    evaluation_id=evaluation_id,
                    dataset_id=dataset_id,
                    run_number=run_number,
                    status="failed",
                    actual_result=None,
                    error_message=f"{type(exc).__name__}: {exc}",
                )
                database.save_performance(
                    result_id=result_id,
                    performance={"duration_ms": duration_ms},
                )
                failures += 1
                event = {
                    "evaluation_id": evaluation_id,
                    "run_number": run_number,
                    "requested_runs": requested_runs,
                    "dataset_id": dataset_id,
                    "dataset_name": dataset.get("name"),
                    "status": "failed",
                    "duration_ms": duration_ms,
                    "error": str(exc),
                }
            else:
                performance["duration_ms"] = round(
                    (perf_counter() - started) * 1000
                )
                result_id = database.save_result(
                    evaluation_id=evaluation_id,
                    dataset_id=dataset_id,
                    run_number=run_number,
                    status="complete",
                    actual_result=result,
                )
                database.save_performance(
                    result_id=result_id,
                    performance=performance,
                )
                successes += 1
                event = {
                    "evaluation_id": evaluation_id,
                    "run_number": run_number,
                    "requested_runs": requested_runs,
                    "dataset_id": dataset_id,
                    "dataset_name": dataset.get("name"),
                    "status": "complete",
                    "duration_ms": performance["duration_ms"],
                }

            if progress is not None:
                progress(event)

        status = (
            "complete"
            if failures == 0
            else "complete_with_failures"
            if successes > 0
            else "failed"
        )
        database.complete_evaluation(evaluation_id, status)
    except BaseException:
        database.complete_evaluation(evaluation_id, "failed")
        raise

    return successes, failures, status


def run_evaluation(
    *,
    target_id: int,
    dataset_id: int,
    requested_runs: int = 10,
    name: str | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Run one frozen dataset repeatedly to measure model consistency."""
    if requested_runs < 1:
        raise ValueError("requested_runs must be at least 1")

    target = database.get_target(target_id)
    dataset = database.get_dataset(dataset_id)
    runner = get_runner(target["runner_key"])
    runner["validate"](dataset)
    prompt_snapshot = runner["capture_prompt"](dataset)
    prompt_id = database.save_prompt_snapshot(
        target_id=target_id,
        name=runner["name"],
        prompt=prompt_snapshot,
    )
    evaluation_name = name or (
        f"{target['name']} — {dataset['name']} v{dataset['version']}"
    )
    evaluation_id = database.create_evaluation(
        target_id=target_id,
        dataset_id=dataset_id,
        prompt_id=prompt_id,
        name=evaluation_name,
        requested_runs=requested_runs,
        model_requested=runner["model"],
        temperature=runner["temperature"],
    )
    successes, failures, status = _execute_calls(
        evaluation_id=evaluation_id,
        datasets=[dataset] * requested_runs,
        runner=runner,
        progress=progress,
    )

    return {
        "evaluation_id": evaluation_id,
        "target_id": target_id,
        "input_mode": "single",
        "dataset_id": dataset_id,
        "prompt_id": prompt_id,
        "requested_runs": requested_runs,
        "successful_runs": successes,
        "failed_runs": failures,
        "status": status,
    }


def run_batch_evaluation(
    *,
    target_id: int,
    batch_id: int,
    name: str | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Run every dataset in one reusable batch exactly once."""
    target = database.get_target(target_id)
    batch = database.get_batch(batch_id)
    datasets = batch["datasets"]
    runner = get_runner(target["runner_key"])
    _validate_batch_datasets(datasets, runner)

    prompt_snapshot = runner["capture_prompt"](datasets[0])
    prompt_id = database.save_prompt_snapshot(
        target_id=target_id,
        name=runner["name"],
        prompt=prompt_snapshot,
    )
    evaluation_name = name or f"{target['name']} — batch {batch['name']}"
    evaluation_id = database.create_evaluation(
        target_id=target_id,
        batch_id=batch_id,
        batch_hash_snapshot=batch["batch_hash"],
        prompt_id=prompt_id,
        name=evaluation_name,
        requested_runs=len(datasets),
        model_requested=runner["model"],
        temperature=runner["temperature"],
    )
    successes, failures, status = _execute_calls(
        evaluation_id=evaluation_id,
        datasets=datasets,
        runner=runner,
        progress=progress,
    )

    return {
        "evaluation_id": evaluation_id,
        "target_id": target_id,
        "input_mode": "batch",
        "batch_id": batch_id,
        "dataset_ids": [int(dataset["dataset_id"]) for dataset in datasets],
        "prompt_id": prompt_id,
        "requested_runs": len(datasets),
        "successful_runs": successes,
        "failed_runs": failures,
        "status": status,
    }
