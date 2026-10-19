# AI evaluation CLI

This package runs an integrated AI-service prompt repeatedly against a frozen
dataset and stores every result in the isolated `AimiraAITesting` SQL database.
It does not use expected results or automatic comparison yet.

## Configuration

The CLI reads the following values from `ai-service/.env`:

```text
AI_TEST_SQL_SERVER
AI_TEST_SQL_PORT
AI_TEST_SQL_DATABASE
AI_TEST_SQL_USER
AI_TEST_SQL_PASSWORD

AI_SOURCE_SQL_SERVER
AI_SOURCE_SQL_PORT
AI_SOURCE_SQL_DATABASE
AI_SOURCE_SQL_USER
AI_SOURCE_SQL_PASSWORD
```

The source connection is only used while importing a dataset. Evaluation runs
read exclusively from the testing database.

## Commands

Run commands from `ai-service` using the executable wrapper:

```bash
./evaluation/aimira-eval target create
./evaluation/aimira-eval target list

./evaluation/aimira-eval dataset import-prod
./evaluation/aimira-eval dataset list

./evaluation/aimira-eval batch create
./evaluation/aimira-eval batch list
./evaluation/aimira-eval batch show 1
./evaluation/aimira-eval batch edit 1

./evaluation/aimira-eval run
./evaluation/aimira-eval run-batch
./evaluation/aimira-eval evaluation show 1
./evaluation/aimira-eval dashboard
```

Every command can also be supplied non-interactively:

```bash
./evaluation/aimira-eval target create \
  --name "Aggregation: descriptor accuracy" \
  --runner aggregation

./evaluation/aimira-eval dataset import-prod \
  --marking-result 2095 \
  --name "Student result 2095"

./evaluation/aimira-eval run \
  --target 1 \
  --dataset 1 \
  --runs 10

./evaluation/aimira-eval batch create \
  --name "Question 5 cohort" \
  --datasets "1,2,3"

./evaluation/aimira-eval batch create \
  --name "Imported Question 5 cohort" \
  --marking-results "2095,2096,2097"

./evaluation/aimira-eval batch edit 1 \
  --add-datasets "4,5" \
  --remove-datasets "2"

./evaluation/aimira-eval run-batch \
  --target 1 \
  --batch 1
```

Targets select an allowlisted entry in `runners.py`. Prompt text is always
executed from the integrated Python service; SQL only receives a read-only
snapshot and hash for later comparison. Datasets are target-independent and
can be reused across aggregation, final-marking, and future evaluation targets;
the selected runner validates and reads only the fields its prompt requires.
Dataset batches are also target-independent. A batch stores references to
individual frozen datasets rather than copies of their JSON. A batch evaluation
creates one evaluation and calls the selected runner once per member dataset.
Historical results retain their dataset IDs even if a reusable batch is edited.

The dashboard binds only to the local machine at `http://127.0.0.1:8010`.
It lists targets and displays each target's stored single-dataset and batch
evaluations, dataset IDs, result JSON, errors, timings, token usage, model and
finish reason.
