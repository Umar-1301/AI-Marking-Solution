"""Terminal interface for the local AI evaluation suite."""

from __future__ import annotations

import argparse
import re
import sys
from typing import Any

from evaluation import database, importer
from evaluation.orchestrator import run_batch_evaluation, run_evaluation
from evaluation.runners import available_runners


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be at least 1")
    return parsed


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    if not slug:
        raise ValueError("Target name must contain at least one letter or number")
    return slug[:100]


def _required_text(value: str | None, prompt: str) -> str:
    selected = value if value is not None else input(prompt)
    selected = selected.strip()
    if not selected:
        raise ValueError(f"{prompt.rstrip(': ')} is required")
    return selected


def _id_list(value: str) -> list[int]:
    parts = [part for part in re.split(r"[\s,]+", value.strip()) if part]
    if not parts:
        raise argparse.ArgumentTypeError("at least one ID is required")
    try:
        parsed = [_positive_int(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("IDs must be positive integers") from exc
    if len(parsed) != len(set(parsed)):
        raise argparse.ArgumentTypeError("IDs cannot be repeated")
    return parsed


def _select_row(
    rows: list[dict[str, Any]],
    *,
    id_field: str,
    heading: str,
    describe,
) -> dict[str, Any]:
    if not rows:
        raise ValueError(f"No {heading.lower()} are available")
    print(f"\n{heading}:")
    for row in rows:
        print(f"  {row[id_field]}. {describe(row)}")
    selected = _positive_int(input("Select ID: ").strip())
    for row in rows:
        if int(row[id_field]) == selected:
            return row
    raise ValueError(f"{heading.rstrip('s')} {selected} was not found")


def _target_from_args(target_id: int | None) -> dict[str, Any]:
    if target_id is not None:
        return database.get_target(target_id)
    return _select_row(
        database.list_targets(),
        id_field="target_id",
        heading="Targets",
        describe=lambda row: f"{row['name']} [{row['runner_key']}]",
    )


def _dataset_from_args(dataset_id: int | None) -> dict[str, Any]:
    if dataset_id is not None:
        return database.get_dataset(dataset_id)
    return _select_row(
        database.list_datasets(),
        id_field="dataset_id",
        heading="Datasets",
        describe=lambda row: f"{row['name']} v{row['version']}",
    )


def _batch_from_args(batch_id: int | None) -> dict[str, Any]:
    if batch_id is not None:
        return database.get_batch(batch_id)
    return _select_row(
        database.list_batches(),
        id_field="batch_id",
        heading="Batches",
        describe=lambda row: f"{row['name']} ({row['dataset_count']} datasets)",
    )


def _select_runner(runner_key: str | None) -> str:
    runners = available_runners()
    keys = {key for key, _ in runners}
    if runner_key is not None:
        if runner_key not in keys:
            raise ValueError(f"Unknown runner {runner_key!r}")
        return runner_key
    print("\nRunners:")
    for index, (key, name) in enumerate(runners, 1):
        print(f"  {index}. {name} [{key}]")
    selected = _positive_int(input("Select runner: ").strip())
    if selected > len(runners):
        raise ValueError(f"Runner option {selected} was not found")
    return runners[selected - 1][0]


def _print_targets() -> None:
    rows = database.list_targets()
    if not rows:
        print("No targets have been created.")
        return
    print("ID  Runner          Key                             Name")
    for row in rows:
        print(
            f"{row['target_id']:<3} "
            f"{row['runner_key']:<15} "
            f"{row['target_key']:<31} "
            f"{row['name']}"
        )


def _print_datasets() -> None:
    rows = database.list_datasets()
    if not rows:
        print("No datasets have been imported.")
        return
    print("ID  Version  Name")
    for row in rows:
        print(
            f"{row['dataset_id']:<3} "
            f"{row['version']:<8} "
            f"{row['name']}"
        )


def _print_batches() -> None:
    rows = database.list_batches()
    if not rows:
        print("No dataset batches have been created.")
        return
    print("ID  Datasets  Name")
    for row in rows:
        print(
            f"{row['batch_id']:<3} "
            f"{row['dataset_count']:<9} "
            f"{row['name']}"
        )


def _print_batch(batch: dict[str, Any]) -> None:
    print(f"Batch: {batch['batch_id']} — {batch['name']}")
    print(f"Datasets: {batch['dataset_count']}")
    if batch.get("description"):
        print(f"Description: {batch['description']}")
    print("ID  Position  Version  Name")
    for dataset in batch["datasets"]:
        print(
            f"{dataset['dataset_id']:<3} "
            f"{dataset['position']:<9} "
            f"{dataset['version']:<8} "
            f"{dataset['name']}"
        )


def _progress(event: dict[str, Any]) -> None:
    dataset = ""
    if event.get("dataset_id") is not None:
        dataset = f" dataset #{event['dataset_id']}"
        if event.get("dataset_name"):
            dataset += f" ({event['dataset_name']})"
    line = (
        f"Run {event['run_number']}/{event['requested_runs']}: "
        f"{event['status']}{dataset} ({event['duration_ms']} ms)"
    )
    if event.get("error"):
        line += f" — {event['error']}"
    print(line, flush=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m evaluation.cli",
        description="Run and persist repeatable AI prompt evaluations.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    target = commands.add_parser("target", help="Manage evaluation targets")
    target_commands = target.add_subparsers(dest="target_command", required=True)
    target_commands.add_parser("list", help="List targets")
    target_create = target_commands.add_parser("create", help="Create a target")
    target_create.add_argument("--name")
    target_create.add_argument("--key")
    target_create.add_argument("--runner")
    target_create.add_argument("--description")

    dataset = commands.add_parser("dataset", help="Manage frozen datasets")
    dataset_commands = dataset.add_subparsers(dest="dataset_command", required=True)
    dataset_commands.add_parser("list", help="List reusable datasets")
    dataset_import = dataset_commands.add_parser(
        "import-prod",
        help="Import one marking result from the source SQL database",
    )
    dataset_import.add_argument("--marking-result", type=_positive_int)
    dataset_import.add_argument("--name")

    batch = commands.add_parser("batch", help="Manage reusable dataset batches")
    batch_commands = batch.add_subparsers(dest="batch_command", required=True)
    batch_commands.add_parser("list", help="List dataset batches")
    batch_show = batch_commands.add_parser("show", help="Show one dataset batch")
    batch_show.add_argument("batch_id", type=_positive_int)
    batch_create = batch_commands.add_parser("create", help="Create a dataset batch")
    batch_create.add_argument("--name")
    batch_create.add_argument("--description")
    batch_create.add_argument(
        "--datasets",
        type=_id_list,
        help="Comma-separated existing dataset IDs",
    )
    batch_create.add_argument(
        "--marking-results",
        type=_id_list,
        help="Comma-separated production marking-result IDs to import",
    )
    batch_edit = batch_commands.add_parser("edit", help="Edit a dataset batch")
    batch_edit.add_argument("batch_id", type=_positive_int)
    batch_edit.add_argument("--name")
    batch_edit.add_argument("--description")
    batch_edit.add_argument("--add-datasets", type=_id_list)
    batch_edit.add_argument("--add-marking-results", type=_id_list)
    batch_edit.add_argument("--remove-datasets", type=_id_list)

    run = commands.add_parser("run", help="Run an evaluation")
    run.add_argument("--target", type=_positive_int)
    run.add_argument("--dataset", type=_positive_int)
    run.add_argument("--runs", type=_positive_int, default=10)
    run.add_argument("--name")

    run_batch = commands.add_parser(
        "run-batch",
        help="Run every dataset in a batch once",
    )
    run_batch.add_argument("--target", type=_positive_int)
    run_batch.add_argument("--batch", type=_positive_int)
    run_batch.add_argument("--name")

    dashboard = commands.add_parser(
        "dashboard",
        help="Start the local evaluation results dashboard",
    )
    dashboard.add_argument("--port", type=_positive_int, default=8010)

    evaluation = commands.add_parser("evaluation", help="Inspect evaluations")
    evaluation_commands = evaluation.add_subparsers(
        dest="evaluation_command",
        required=True,
    )
    evaluation_show = evaluation_commands.add_parser("show", help="Show one evaluation")
    evaluation_show.add_argument("evaluation_id", type=_positive_int)
    return parser


def _execute(args: argparse.Namespace) -> None:
    if args.command == "target" and args.target_command == "list":
        _print_targets()
        return

    if args.command == "target" and args.target_command == "create":
        name = _required_text(args.name, "Target name: ")
        runner_key = _select_runner(args.runner)
        target_id = database.create_target(
            target_key=args.key or _slug(name),
            name=name,
            runner_key=runner_key,
            description=args.description,
        )
        print(f"Target {target_id} created with runner {runner_key}.")
        return

    if args.command == "dataset" and args.dataset_command == "list":
        _print_datasets()
        return

    if args.command == "dataset" and args.dataset_command == "import-prod":
        marking_result_id = args.marking_result or _positive_int(
            input("Source marking result ID: ").strip()
        )
        dataset_id = importer.import_production_dataset(
            marking_result_id=marking_result_id,
            name=args.name,
        )
        print(f"Reusable dataset {dataset_id} imported and frozen.")
        return

    if args.command == "batch" and args.batch_command == "list":
        _print_batches()
        return

    if args.command == "batch" and args.batch_command == "show":
        _print_batch(database.get_batch(args.batch_id))
        return

    if args.command == "batch" and args.batch_command == "create":
        name = _required_text(args.name, "Batch name: ")
        dataset_ids = list(args.datasets or [])
        marking_result_ids = args.marking_results
        if args.datasets is None and args.marking_results is None:
            existing = input(
                "Existing dataset IDs (comma-separated, optional): "
            ).strip()
            production = input(
                "Production marking-result IDs (comma-separated, optional): "
            ).strip()
            dataset_ids.extend(_id_list(existing) if existing else [])
            marking_result_ids = _id_list(production) if production else []
        if marking_result_ids:
            imported = importer.import_production_datasets(marking_result_ids)
            dataset_ids.extend(imported)
            print(f"Imported datasets: {', '.join(map(str, imported))}")
        batch_id = database.create_batch(
            name=name,
            description=args.description,
            dataset_ids=dataset_ids,
        )
        print(f"Dataset batch {batch_id} created with {len(dataset_ids)} datasets.")
        return

    if args.command == "batch" and args.batch_command == "edit":
        batch = database.get_batch(args.batch_id)
        interactive = all(
            value is None
            for value in (
                args.name,
                args.description,
                args.add_datasets,
                args.add_marking_results,
                args.remove_datasets,
            )
        )
        name = args.name
        description = args.description
        add_datasets = list(args.add_datasets or [])
        add_marking_results = list(args.add_marking_results or [])
        remove_datasets = list(args.remove_datasets or [])
        if interactive:
            _print_batch(batch)
            name_input = input("New name (blank keeps current): ").strip()
            description_input = input(
                "New description (blank keeps current): "
            ).strip()
            add_input = input(
                "Existing dataset IDs to add (comma-separated, optional): "
            ).strip()
            import_input = input(
                "Production marking-result IDs to import and add (optional): "
            ).strip()
            remove_input = input(
                "Dataset IDs to remove (comma-separated, optional): "
            ).strip()
            name = name_input or None
            description = description_input or None
            add_datasets = _id_list(add_input) if add_input else []
            add_marking_results = _id_list(import_input) if import_input else []
            remove_datasets = _id_list(remove_input) if remove_input else []
        if add_marking_results:
            imported = importer.import_production_datasets(add_marking_results)
            add_datasets.extend(imported)
            print(f"Imported datasets: {', '.join(map(str, imported))}")
        database.update_batch(
            args.batch_id,
            name=name,
            description=description,
        )
        if add_datasets:
            database.add_batch_datasets(args.batch_id, add_datasets)
        if remove_datasets:
            database.remove_batch_datasets(args.batch_id, remove_datasets)
        print(f"Dataset batch {args.batch_id} updated.")
        return

    if args.command == "run":
        target = _target_from_args(args.target)
        dataset = _dataset_from_args(args.dataset)
        print(
            f"\nRunning {args.runs} independent calls for {target['name']} "
            f"using {dataset['name']} v{dataset['version']}..."
        )
        result = run_evaluation(
            target_id=int(target["target_id"]),
            dataset_id=int(dataset["dataset_id"]),
            requested_runs=args.runs,
            name=args.name,
            progress=_progress,
        )
        print(
            f"\nEvaluation {result['evaluation_id']} {result['status']}: "
            f"{result['successful_runs']} successful, "
            f"{result['failed_runs']} failed."
        )
        return

    if args.command == "run-batch":
        target = _target_from_args(args.target)
        batch = _batch_from_args(args.batch)
        print(
            f"\nRunning {batch['dataset_count']} datasets once each for "
            f"{target['name']} using batch {batch['name']}..."
        )
        result = run_batch_evaluation(
            target_id=int(target["target_id"]),
            batch_id=int(batch["batch_id"]),
            name=args.name,
            progress=_progress,
        )
        print(
            f"\nEvaluation {result['evaluation_id']} {result['status']}: "
            f"{result['successful_runs']} successful, "
            f"{result['failed_runs']} failed."
        )
        return

    if args.command == "dashboard":
        import uvicorn

        from evaluation.dashboard import app

        url = f"http://127.0.0.1:{args.port}"
        print(f"Evaluation dashboard: {url}", flush=True)
        print("Press Ctrl+C to stop it.", flush=True)
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
        return

    if args.command == "evaluation" and args.evaluation_command == "show":
        row = database.get_evaluation(args.evaluation_id)
        print(f"Evaluation: {row['evaluation_id']} — {row['name']}")
        print(f"Status: {row['status']}")
        print(f"Target: {row['target_name']} ({row['target_id']})")
        if row["input_mode"] == "batch":
            print(f"Batch: {row['batch_name']} ({row['batch_id']})")
        else:
            print(f"Dataset: {row['dataset_name']} ({row['dataset_id']})")
        print(f"Prompt: {row['prompt_id']}")
        print(f"Requested runs: {row['requested_runs']}")
        print(f"Results: {row['result_counts']}")
        return

    raise ValueError("Unsupported command")


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        _execute(args)
        return 0
    except KeyboardInterrupt:
        print("\nEvaluation interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
