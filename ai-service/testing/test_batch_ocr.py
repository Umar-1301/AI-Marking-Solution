"""Checks the page boundary that the local six-student experiment depends on."""

import io
import re
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import student_ocr_service as ocr
import main


def jpeg_bytes(colour):
    output = io.BytesIO()
    Image.new("RGB", (80, 100), colour).save(output, format="JPEG")
    return output.getvalue()


class BatchOcrTest(unittest.TestCase):
    def setUp(self):
        self.images = [jpeg_bytes((index * 30, 40, 90)) for index in range(6)]

    def extracted(self, wrong_page=None):
        def fake_extract(pdf, filename, deadline, schema, monitor=None):
            self.assertEqual(filename, "student-batch.pdf")
            self.assertEqual(len(re.findall(rb"/Type\s*/Page\b", pdf)), 6)
            fields = __import__("json").loads(schema)["properties"]
            self.assertEqual(len(fields), 6)
            result = {}
            for index in range(6):
                field = f"handwritten_work_page_{index}"
                result[field] = f"Student {index} answer"
                cited_page = wrong_page if index == 2 and wrong_page is not None else index
                result[f"{field}_citations"] = [f"/page/{cited_page}/Text/0"]
            return result, {"page_count": 6, "metadata": {"failed_pages": []}}
        return fake_extract

    @patch.object(ocr, "save_raw_student_ocr_response")
    def test_six_pdfs_are_joined_and_texts_stay_in_page_order(self, _capture):
        with patch.object(ocr, "_extract_student_ocr_result", self.extracted()):
            texts = ocr.extract_student_ocr_batch(self.images, 999999999)
        self.assertEqual(texts, [f"Student {i} answer" for i in range(6)])

    @patch.object(ocr, "save_raw_student_ocr_response")
    def test_crossed_page_citation_stops_the_batch(self, _capture):
        with patch.object(ocr, "_extract_student_ocr_result", self.extracted(wrong_page=3)):
            with self.assertRaisesRegex(ValueError, "batch page 2"):
                ocr.extract_student_ocr_batch(self.images, 999999999)

    @patch.object(ocr, "save_raw_student_ocr_response")
    def test_empty_page_is_isolated_without_losing_other_text(self, _capture):
        def extracted(pdf, filename, deadline, schema, monitor=None):
            structured, result = self.extracted()(pdf, filename, deadline, schema, monitor)
            structured["handwritten_work_page_2"] = "  "
            structured.pop("handwritten_work_page_2_citations")
            return structured, result

        with patch.object(ocr, "_extract_student_ocr_result", extracted):
            texts = ocr.extract_student_ocr_batch(self.images, 999999999)
        self.assertIsNone(texts[2])
        self.assertEqual(texts[3], "Student 3 answer")

    @patch.object(ocr, "save_raw_student_ocr_response")
    @patch.object(ocr, "record_batch_ocr_request")
    def test_provider_completion_and_page_mapping_failure_are_separate(self, record, _capture):
        monitor = {"run_key": "test-run-001", "user_slot": 1,
                   "batch_key": "batch-a", "file_count": 6, "request_id": "request-a"}
        with patch.object(ocr, "_extract_student_ocr_result", self.extracted(wrong_page=3)):
            with self.assertRaisesRegex(ValueError, "batch page 2"):
                ocr.extract_student_ocr_batch(self.images, 999999999, monitor)
        self.assertEqual(record.call_args.args[1]["phase"], "validation_failed")
        self.assertEqual(record.call_args.args[1]["page_count"], 6)

    def test_batch_endpoint_returns_six_separate_slots(self):
        with patch.object(main, "extract_student_ocr_batch",
                          return_value=[f"answer {i}" for i in range(6)]) as extract:
            response = TestClient(main.app).post(
                "/student-ocr-batch",
                data={"slot_keys": [f"job-{i}" for i in range(6)]},
                files=[("student_works", (f"student-{i}.jpg", image, "image/jpeg"))
                       for i, image in enumerate(self.images)],
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["page_count"], 6)
        self.assertEqual(response.json()["students"], [
            {"slot_key": f"job-{i}", "handwritten_work": f"answer {i}"}
            for i in range(6)
        ])
        self.assertEqual(len(extract.call_args.args[0]), 6)

    def test_batch_endpoint_reports_empty_slot_without_dropping_other_students(self):
        texts = [f"answer {i}" for i in range(6)]
        texts[2] = None
        with patch.object(main, "extract_student_ocr_batch", return_value=texts):
            response = TestClient(main.app).post(
                "/student-ocr-batch",
                data={"slot_keys": [f"job-{i}" for i in range(6)]},
                files=[("student_works", (f"student-{i}.jpg", image, "image/jpeg"))
                       for i, image in enumerate(self.images)],
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["empty_slot_keys"], ["job-2"])
        self.assertEqual(len(response.json()["students"]), 5)

    def test_combined_pdf_endpoint_keeps_page_keys_in_order(self):
        combined = ocr.build_student_pdf_batch(self.images[:2])
        with patch.object(main, "extract_student_ocr_pdf",
                          return_value=["first page", "second page"]) as extract:
            response = TestClient(main.app).post(
                "/student-ocr-pdf-batch",
                data={"page_keys": ["job-a:page:0", "job-b:page:0"],
                      "source_names": ["a.jpg", "b.jpg"]},
                files={"batch_pdf": ("student-batch.pdf", combined, "application/pdf")},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["page_count"], 2)
        self.assertEqual(response.json()["students"], [
            {"slot_key": "job-a:page:0", "handwritten_work": "first page"},
            {"slot_key": "job-b:page:0", "handwritten_work": "second page"},
        ])
        self.assertTrue(extract.call_args.args[0].startswith(b"%PDF"))
        self.assertEqual(extract.call_args.args[1], 2)

    @patch.object(ocr, "save_raw_student_ocr_response")
    def test_combined_pdf_ocr_checks_each_page_citation(self, _capture):
        combined = ocr.build_student_pdf_batch(self.images[:2])

        def extracted(pdf, filename, deadline, schema, monitor):
            self.assertEqual(pdf, combined)
            self.assertEqual(filename, "student-batch.pdf")
            self.assertEqual(len(__import__("json").loads(schema)["properties"]), 2)
            return {
                "handwritten_work_page_0": "first",
                "handwritten_work_page_0_citations": ["/page/0/Text/0"],
                "handwritten_work_page_1": "second",
                "handwritten_work_page_1_citations": ["/page/1/Text/0"],
            }, {"page_count": 2, "metadata": {"failed_pages": []}}

        with patch.object(ocr, "_extract_student_ocr_result", extracted):
            self.assertEqual(
                ocr.extract_student_ocr_pdf(combined, 2, 999999999),
                ["first", "second"],
            )

    def test_mark_text_endpoint_runs_one_student_pipeline(self):
        with patch.object(main, "_mark_student_text",
                          return_value={"student_ocr_text": "answer"}) as mark:
            response = TestClient(main.app).post("/mark-with-ocr-text", data={
                "student_ocr_text": "answer",
                "scheme_text": "scheme",
                "thread_extraction": "{}",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["student_ocr_text"], "answer")
        self.assertEqual(mark.call_args.args[:3], ("answer", "scheme", "{}"))

    @patch.object(ocr, "save_raw_student_ocr_response")
    @patch.object(ocr, "record_batch_ocr_request")
    @patch.object(ocr.time, "sleep")
    @patch.dict(ocr.os.environ, {"DATALAB_API_KEY": "test-key"})
    def test_provider_monitor_counts_one_six_page_submission(
        self, _sleep, record, _capture
    ):
        submitted = unittest.mock.Mock(status_code=200)
        submitted.json.return_value = {"request_check_url": "https://example.test/check"}
        completed = unittest.mock.Mock(status_code=200)
        completed.json.return_value = {
            "status": "complete", "page_count": 6,
            "metadata": {"failed_pages": []},
            "extraction_schema_json": {
                key: value for index in range(6)
                for key, value in (
                    (f"handwritten_work_page_{index}", f"answer {index}"),
                    (f"handwritten_work_page_{index}_citations", [f"/page/{index}/Text/0"]),
                )
            },
        }
        monitor = {"run_key": "test-run-001", "user_slot": 1,
                   "batch_key": "batch-a", "file_count": 6}
        with patch.object(ocr.requests, "post", return_value=submitted) as post, \
             patch.object(ocr.requests, "get", return_value=completed):
            texts = ocr.extract_student_ocr_batch(
                self.images, time.monotonic() + 30, monitor
            )
        self.assertEqual(texts, [f"answer {index}" for index in range(6)])
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["files"]["file"][0], "student-batch.pdf")
        self.assertEqual(
            [call.args[1]["phase"] for call in record.call_args_list],
            ["started", "accepted", "completed", "validated"],
        )
        self.assertEqual(record.call_args_list[2].args[1]["page_count"], 6)


if __name__ == "__main__":
    unittest.main()
