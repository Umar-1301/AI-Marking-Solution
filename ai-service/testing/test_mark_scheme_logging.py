import io
import logging
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from observability import event_log


class MarkSchemeLoggingTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.handler = logging.StreamHandler(self.output)
        self.handler.setFormatter(event_log._ConsoleFormatter())
        event_log.logger.addHandler(self.handler)

    def tearDown(self):
        event_log.logger.removeHandler(self.handler)

    def test_concurrent_jobs_keep_their_own_identifiers(self):
        barrier = Barrier(3)

        def run(job_id):
            with event_log.mark_scheme_log_context(job_id, f"attempt-{job_id}"):
                barrier.wait()
                event_log.log_mark_scheme_stage("ocr", "start")
                event_log.log_mark_scheme_failure(ValueError(f"error-{job_id}"))

        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(run, ("job-1", "job-2", "job-3")))

        lines = self.output.getvalue().splitlines()
        self.assertEqual(len(lines), 6)
        for job_id in ("job-1", "job-2", "job-3"):
            matching = [line for line in lines if f"job={job_id} attempt=attempt-{job_id}" in line]
            self.assertEqual(len(matching), 2)
            self.assertTrue(any("stage=ocr status=start" in line for line in matching))
            self.assertTrue(any("stage=ocr status=failed" in line for line in matching))
            self.assertTrue(all("step=3a" in line for line in matching))

    def test_each_mark_scheme_stage_has_a_stable_step_number(self):
        with event_log.mark_scheme_log_context("job-1", "attempt-1"):
            for stage in event_log._MARK_SCHEME_STEPS:
                event_log.log_mark_scheme_stage(stage, "start")
                event_log.log_mark_scheme_stage(stage, "pass")

        lines = self.output.getvalue().splitlines()
        self.assertEqual(len(lines), 14)
        for stage, step in event_log._MARK_SCHEME_STEPS.items():
            matching = [line for line in lines if f"stage={stage} " in line]
            self.assertEqual(len(matching), 2)
            self.assertTrue(all(f"step={step}" in line for line in matching))

    def test_descriptor_text_stays_off_console_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            debug_path = Path(directory) / "descriptors.txt"
            with patch.object(event_log, "_DESCRIPTOR_DEBUG_LOG_PATH", debug_path):
                with event_log.mark_scheme_log_context("job-1", "attempt-1"):
                    event_log.log_descriptor_validation_comparison(
                        question_number="1", ao="AO1", band="Level 1",
                        descriptor="private descriptor text",
                        model_descriptors=["different text"],
                        application_descriptors=["private descriptor text"],
                        normalised_application_descriptors=["private descriptor text"],
                        normalised_model_descriptors=["different text"],
                        shape_matches=False,
                    )
                    event_log.log_descriptor_validation_issues([{
                        "rule": "descriptor_list_mismatch",
                        "question_number": "1",
                        "ao": "AO1",
                        "band": "Level 1",
                        "descriptor": "private descriptor text",
                        "reason": "Lists differ",
                    }])

            console = self.output.getvalue()
            self.assertIn("rule=descriptor_list_mismatch", console)
            self.assertNotIn("private descriptor text", console)
            self.assertIn("private descriptor text", debug_path.read_text())


if __name__ == "__main__":
    unittest.main()
