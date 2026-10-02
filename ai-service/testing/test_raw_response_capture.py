import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from observability.raw_response_capture import (
    save_raw_final_marking_response,
    save_raw_student_ocr_response,
)


class RawResponseCaptureTests(unittest.TestCase):
    def test_saves_structured_and_raw_student_ocr_before_processing(self):
        structured = {
            "handwritten_work": "Student answer",
            "printed_text": "Question 1",
            "other": "",
        }
        raw = {"pages": [{"text": "Question 1 Student answer"}]}

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "raw data"
            with patch("observability.raw_response_capture.RAW_DATA_DIR", directory), \
                 patch("observability.raw_response_capture.logger"):
                destination = save_raw_student_ocr_response(structured, raw)

            self.assertIsNotNone(destination)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            record = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(record["structured_ocr"], structured)
            self.assertEqual(record["raw_ocr"], raw)

    def test_saves_original_model_text_and_a_readable_copy(self):
        raw_content = '{"featured_evidence_by_thread": [{"thread_id": "ao4-thread-a", "evidence_ids": ["e2"]}]}'

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "raw data"
            with patch("observability.raw_response_capture.RAW_DATA_DIR", directory), \
                 patch("observability.raw_response_capture.logger"):
                first = save_raw_final_marking_response(
                    raw_content,
                    response_id="response-1",
                    model="test-model",
                    finish_reason="stop",
                )
                second = save_raw_final_marking_response(raw_content)

            self.assertIsNotNone(first)
            self.assertNotEqual(first, second)
            self.assertEqual(len(list(directory.glob("final-marker-*.json"))), 2)
            self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)

            record = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual(record["raw_content"], raw_content)
            self.assertEqual(record["model_output"]["featured_evidence_by_thread"][0]["evidence_ids"], ["e2"])
            self.assertEqual(record["response_id"], "response-1")
            self.assertEqual(record["model"], "test-model")
            self.assertEqual(record["finish_reason"], "stop")

    def test_missing_content_does_not_write_a_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "raw data"
            with patch("observability.raw_response_capture.RAW_DATA_DIR", directory), \
                 patch("observability.raw_response_capture.logger"):
                self.assertIsNone(save_raw_final_marking_response(None))

            self.assertFalse(directory.exists())

    def test_capture_failure_does_not_interrupt_marking(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "raw data"
            with patch("observability.raw_response_capture.RAW_DATA_DIR", directory), \
                 patch("observability.raw_response_capture.os.open", side_effect=OSError("disk unavailable")), \
                 patch("observability.raw_response_capture.logger") as logger:
                self.assertIsNone(save_raw_final_marking_response("{}"))

            logger.warning.assert_called_once()
