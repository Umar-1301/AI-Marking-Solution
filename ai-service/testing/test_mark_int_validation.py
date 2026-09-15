import unittest
from unittest.mock import patch

from observability.event_log import log_mark_total_validation_event
from validation.mark_int_validation import validate_mark_totals


def scheme(*, declared_marks=24, objectives=None):
    return {
        "questions": [{
            "question_number": "Question 5",
            "marks": declared_marks,
            "assessment_objectives": objectives or [
                {"ao": "AO5", "marks_available": 24},
                {"ao": "AO6", "marks_available": 16},
            ],
        }],
    }


class MarkTotalValidationTests(unittest.TestCase):
    def run_validation(self, source):
        events = []
        corrected, corrections = validate_mark_totals(source, event_handler=events.append)
        return corrected, corrections, events

    def test_events_trace_a_safe_correction(self):
        corrected, corrections, events = self.run_validation(scheme())

        self.assertEqual(corrected["questions"][0]["marks"], 40)
        self.assertEqual(len(corrections), 1)
        self.assertTrue(any(
            event["check"] == "question_total_consistency" and event["status"] == "fail"
            for event in events
        ))
        self.assertTrue(any(
            event["check"] == "single_ao_copy_pattern" and event["status"] == "pass"
            for event in events
        ))
        self.assertTrue(any(
            event["check"] == "question_marks_correction" and event["status"] == "corrected"
            for event in events
        ))

    def test_events_explain_an_unresolved_mismatch(self):
        corrected, corrections, events = self.run_validation(scheme(declared_marks=30))

        self.assertEqual(corrected["questions"][0]["marks"], 30)
        self.assertEqual(corrections, [])
        unresolved = next(
            event for event in events
            if event["check"] == "single_ao_copy_pattern"
        )
        self.assertEqual(unresolved["status"], "fail")
        self.assertIn("left unchanged", unresolved["message"])
        self.assertEqual(unresolved["computed_marks"], 40)

    def test_events_explain_why_single_ao_question_is_skipped(self):
        source = scheme(
            declared_marks=15,
            objectives=[{"ao": "AO4", "marks_available": 15}],
        )

        corrected, corrections, events = self.run_validation(source)

        self.assertEqual(corrected, source)
        self.assertEqual(corrections, [])
        skipped = next(event for event in events if event["check"] == "minimum_ao_count")
        self.assertEqual(skipped["status"], "skip")
        self.assertIn("single-AO", skipped["message"])

    def test_events_report_invalid_ao_marks(self):
        source = scheme(objectives=[
            {"ao": "AO5", "marks_available": "value not found"},
            {"ao": "AO6", "marks_available": 16},
        ])

        corrected, corrections, events = self.run_validation(source)

        self.assertEqual(corrected, source)
        self.assertEqual(corrections, [])
        failed = next(event for event in events if event["check"] == "ao_marks_available")
        self.assertEqual(failed["status"], "fail")
        self.assertEqual(failed["marks_available"], "value not found")

    def test_unavailable_question_marks_are_derived_from_valid_ao_allocations(self):
        source = scheme(declared_marks="value not found")

        corrected, corrections, events = self.run_validation(source)

        self.assertEqual(source["questions"][0]["marks"], "value not found")
        self.assertEqual(corrected["questions"][0]["marks"], 40)
        self.assertEqual(len(corrections), 1)
        self.assertEqual(
            corrections[0]["rule"],
            "question_marks_derived_from_ao_total",
        )
        self.assertTrue(any(
            event["check"] == "question_marks_correction"
            and event["status"] == "corrected"
            for event in events
        ))

    def test_unavailable_question_marks_are_unchanged_when_ao_sum_is_unsafe(self):
        source = scheme(
            declared_marks="value not found",
            objectives=[
                {"ao": "AO5", "marks_available": "value not found"},
                {"ao": "AO6", "marks_available": 16},
            ],
        )

        corrected, corrections, events = self.run_validation(source)

        self.assertEqual(corrected, source)
        self.assertEqual(corrections, [])
        self.assertTrue(any(
            event["check"] == "ao_marks_available"
            and event["status"] == "fail"
            for event in events
        ))

    def test_unavailable_question_marks_can_be_derived_from_one_valid_ao(self):
        source = scheme(
            declared_marks="value not found",
            objectives=[{"ao": "AO4", "marks_available": 15}],
        )

        corrected, corrections, _ = self.run_validation(source)

        self.assertEqual(corrected["questions"][0]["marks"], 15)
        self.assertEqual(len(corrections), 1)
        self.assertEqual(
            corrections[0]["rule"],
            "question_marks_derived_from_ao_total",
        )

    def test_terminal_event_contains_only_requested_fields(self):
        event = {
            "check": "declared_question_marks",
            "message": "question.marks is unavailable",
            "question": "Section B: Transactional Writing",
            "status": "fail",
            "declared_marks": "value not found",
        }

        with patch("observability.event_log.logger.warning") as warning:
            log_mark_total_validation_event(event)

        warning.assert_called_once_with(
            '[MARK TOTAL VALIDATION] {"message": "question.marks is unavailable", '
            '"question": "Section B: Transactional Writing", "status": "fail"}'
        )


if __name__ == "__main__":
    unittest.main()
