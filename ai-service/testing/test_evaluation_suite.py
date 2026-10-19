import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from evaluation.dashboard import app as dashboard_app
from evaluation.database import _decoded_result_json
from evaluation.importer import build_frozen_dataset
from evaluation.orchestrator import run_batch_evaluation, run_evaluation


class DatasetImporterTests(unittest.TestCase):
    def test_build_frozen_dataset_selects_question_and_matching_threads(self):
        source = {
            "marking_result_id": 2095,
            "lesson_id": 10,
            "student_id": 20,
            "marked_at": "2026-09-20 10:00:00",
            "selected_question_index": 1,
            "student_response": "Student answer",
            "student_grade": '{"score": 7, "breakdown": []}',
            "aggregation_result": '{"status": "complete", "result": {"evidence": []}}',
            "final_result": None,
            "structured_scheme": """
                {
                    "questions": [
                        {"question_number": "1", "description": "First"},
                        {"question_number": "2", "description": "Second"}
                    ]
                }
            """,
            "thread_extraction": """
                {
                    "questions": {
                        "1": {"assessment_objectives": {"AO1": {}}},
                        "2": {"assessment_objectives": {"AO4": {}}}
                    }
                }
            """,
        }

        dataset = build_frozen_dataset(source)

        self.assertEqual(dataset["selected_scheme"]["question_number"], "2")
        self.assertIn(
            "AO4",
            dataset["selected_thread_extraction"]["assessment_objectives"],
        )
        self.assertEqual(dataset["student_response"], "Student answer")
        self.assertEqual(dataset["source"]["marking_result_id"], 2095)
        self.assertIsNone(dataset["final_result"])


class EvaluationOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.target = {
            "target_id": 1,
            "target_key": "aggregation_descriptor_accuracy",
            "name": "Aggregation: descriptor accuracy",
            "runner_key": "aggregation",
        }
        self.dataset = {
            "dataset_id": 4,
            "name": "Student result 2095",
            "version": 1,
            "input_data": {},
        }
        self.runner = {
            "name": "Aggregation",
            "model": "gpt-4o-mini",
            "temperature": 0.0,
            "validate": Mock(),
            "capture_prompt": Mock(return_value={"system_prompt": "prompt"}),
            "execute": Mock(
                return_value={
                    "result": {"evidence": []},
                    "performance": {
                        "model_returned": "gpt-4o-mini",
                        "total_tokens": 100,
                    },
                }
            ),
        }

    @patch("evaluation.orchestrator.database")
    @patch("evaluation.orchestrator.get_runner")
    def test_runs_requested_repetitions_and_persists_each_result(
        self,
        get_runner,
        database,
    ):
        database.get_target.return_value = self.target
        database.get_dataset.return_value = self.dataset
        database.save_prompt_snapshot.return_value = 7
        database.create_evaluation.return_value = 51
        database.save_result.side_effect = [101, 102, 103]
        get_runner.return_value = self.runner

        result = run_evaluation(
            target_id=1,
            dataset_id=4,
            requested_runs=3,
        )

        self.assertEqual(self.runner["execute"].call_count, 3)
        self.runner["validate"].assert_called_once_with(self.dataset)
        self.assertEqual(database.save_result.call_count, 3)
        self.assertEqual(database.save_performance.call_count, 3)
        database.complete_evaluation.assert_called_once_with(51, "complete")
        self.assertEqual(result["successful_runs"], 3)
        self.assertEqual(result["failed_runs"], 0)

    @patch("evaluation.orchestrator.database")
    @patch("evaluation.orchestrator.get_runner")
    def test_failed_model_call_is_stored_and_later_runs_continue(
        self,
        get_runner,
        database,
    ):
        database.get_target.return_value = self.target
        database.get_dataset.return_value = self.dataset
        database.save_prompt_snapshot.return_value = 7
        database.create_evaluation.return_value = 52
        database.save_result.side_effect = [201, 202, 203]
        self.runner["execute"].side_effect = [
            {
                "result": {"evidence": []},
                "performance": {},
            },
            RuntimeError("provider failure"),
            {
                "result": {"evidence": []},
                "performance": {},
            },
        ]
        get_runner.return_value = self.runner

        result = run_evaluation(
            target_id=1,
            dataset_id=4,
            requested_runs=3,
        )

        statuses = [
            call.kwargs["status"]
            for call in database.save_result.call_args_list
        ]
        self.assertEqual(statuses, ["complete", "failed", "complete"])
        database.complete_evaluation.assert_called_once_with(
            52,
            "complete_with_failures",
        )
        self.assertEqual(result["successful_runs"], 2)
        self.assertEqual(result["failed_runs"], 1)

    @patch("evaluation.orchestrator.database")
    @patch("evaluation.orchestrator.get_runner")
    def test_batch_runs_each_dataset_once_under_one_evaluation(
        self,
        get_runner,
        database,
    ):
        datasets = [
            {
                "dataset_id": dataset_id,
                "name": f"Student {dataset_id}",
                "input_data": {
                    "selected_scheme": {"question_number": "5"},
                    "selected_thread_extraction": {"assessment_objectives": {}},
                },
            }
            for dataset_id in (4, 7, 9)
        ]
        database.get_target.return_value = self.target
        database.get_batch.return_value = {
            "batch_id": 3,
            "name": "Question 5 cohort",
            "batch_hash": "abc123",
            "datasets": datasets,
        }
        database.hash_json.return_value = "question-hash"
        database.save_prompt_snapshot.return_value = 8
        database.create_evaluation.return_value = 61
        database.save_result.side_effect = [301, 302, 303]
        get_runner.return_value = self.runner

        result = run_batch_evaluation(target_id=1, batch_id=3)

        self.assertEqual(self.runner["validate"].call_count, 3)
        self.assertEqual(self.runner["capture_prompt"].call_count, 1)
        self.assertEqual(self.runner["execute"].call_count, 3)
        database.create_evaluation.assert_called_once_with(
            target_id=1,
            batch_id=3,
            batch_hash_snapshot="abc123",
            prompt_id=8,
            name="Aggregation: descriptor accuracy — batch Question 5 cohort",
            requested_runs=3,
            model_requested="gpt-4o-mini",
            temperature=0.0,
        )
        self.assertEqual(
            [call.kwargs["dataset_id"] for call in database.save_result.call_args_list],
            [4, 7, 9],
        )
        database.complete_evaluation.assert_called_once_with(61, "complete")
        self.assertEqual(result["input_mode"], "batch")
        self.assertEqual(result["dataset_ids"], [4, 7, 9])


class EvaluationDashboardTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(dashboard_app)

    def test_dashboard_page_is_served(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("Evaluation dashboard", response.text)

    @patch("evaluation.dashboard.database.list_dashboard_targets")
    def test_target_list_api_returns_database_rows(self, list_targets):
        list_targets.return_value = [{
            "target_id": 2,
            "name": "Aggregation",
            "runner_key": "aggregation",
            "evaluation_count": 1,
            "result_count": 10,
        }]

        response = self.client.get("/api/targets")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["targets"][0]["result_count"], 10)

    @patch("evaluation.dashboard.database.get_target_dashboard")
    def test_target_detail_api_returns_nested_evaluations(self, get_dashboard):
        get_dashboard.return_value = {
            "target": {"target_id": 2, "name": "Aggregation"},
            "evaluations": [{
                "evaluation_id": 1,
                "dataset_id": 2,
                "results": [{"run_number": 1, "actual_result": {"score": 7}}],
            }],
        }

        response = self.client.get("/api/targets/2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["evaluations"][0]["dataset_id"], 2)

    def test_stored_result_json_is_decoded_for_the_frontend(self):
        self.assertEqual(_decoded_result_json('{"score":7}'), {"score": 7})


if __name__ == "__main__":
    unittest.main()
