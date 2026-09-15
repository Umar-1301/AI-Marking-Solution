import unittest

from pydantic import ValidationError

from aggregation.aggregation_prompt import (
    SYSTEM_PROMPT,
    _select_extracted_result,
    build_aggregation_user_prompt,
)
from schemas.aggregation_schema import AggregationResult


class AggregationPromptTests(unittest.TestCase):
    def test_system_prompt_uses_student_response_without_segmentation(self):
        self.assertIn("BEST QUOTE AND JUSTIFICATION", SYSTEM_PROMPT)
        self.assertIn("EVIDENCE SEARCH FRAMEWORK", SYSTEM_PROMPT)
        self.assertIn(
            "Before selecting any evidence, read every supplied thread_description",
            SYSTEM_PROMPT,
        )
        self.assertIn(
            "It must provide evidence of a capability represented\n"
            "in the supplied mark-scheme threads",
            SYSTEM_PROMPT,
        )
        self.assertIn(
            "This does not mean that every thread must receive evidence",
            SYSTEM_PROMPT,
        )
        self.assertIn(
            "Strength is therefore one selection factor, but it is not the definition of\n"
            "evidence",
            SYSTEM_PROMPT,
        )
        self.assertIn("using\nthis evidence-search framework", SYSTEM_PROMPT)
        self.assertNotIn(
            "Prefer the strongest, most relevant and\nmeaningfully distinct examples",
            SYSTEM_PROMPT,
        )
        self.assertIn("no more than ten quotations", SYSTEM_PROMPT)
        self.assertIn(
            "Do not stop after finding the first\nquotation for a thread or level",
            SYSTEM_PROMPT,
        )
        self.assertIn(
            "the characters immediately after\n"
            "MARK_SCHEME_OCR_ (or END_MARK_SCHEME_OCR_)",
            SYSTEM_PROMPT,
        )
        self.assertIn("return `descriptor_ids` as a non-empty list", SYSTEM_PROMPT)
        self.assertIn("A single quotation may demonstrate\nmultiple descriptors", SYSTEM_PROMPT)
        self.assertIn("below,\nwithin, or above the holistic awarded band", SYSTEM_PROMPT)
        self.assertIn("You may choose descriptor\nIDs from any level", SYSTEM_PROMPT)
        self.assertIn(
            "does not recalculate or replace\n"
            "the whole-response band",
            SYSTEM_PROMPT,
        )
        self.assertIn("EVIDENCE QUOTE FIDELITY", SYSTEM_PROMPT)
        self.assertIn("spelling and grammatical mistakes", SYSTEM_PROMPT)
        self.assertIn("`~~` markers", SYSTEM_PROMPT)
        self.assertIn("exact substring of the delimited STUDENT RESPONSE", SYSTEM_PROMPT)
        self.assertIn("may begin or end anywhere within a sentence", SYSTEM_PROMPT)
        self.assertIn("Never return `was met with nothing.`", SYSTEM_PROMPT)
        self.assertIn("WHOLE-RESPONSE COVERAGE PASS", SYSTEM_PROMPT)
        self.assertIn("perform a mandatory second pass", SYSTEM_PROMPT)
        self.assertIn("do not cluster all evidence in one part", SYSTEM_PROMPT)
        self.assertIn("Never invent a descriptor match", SYSTEM_PROMPT)
        self.assertNotIn("SEGMENTED RESULT", SYSTEM_PROMPT)

    def test_user_prompt_contains_student_response_without_segmentation(self):
        prompt = build_aggregation_user_prompt(
            question="How successfully is fear created?",
            student_response="<<<MARK_SCHEME_OCR_test>>>Student text<<<END_MARK_SCHEME_OCR_test>>>",
            extracted_result={"score": 5, "maxScore": 15, "rubric_breakdown": []},
            mark_scheme_extraction={"next_band": "Level 3"},
        )

        self.assertIn("STUDENT RESPONSE", prompt)
        self.assertIn("Student text", prompt)
        self.assertIn("How successfully is fear created?", prompt)
        self.assertIn("crossed-out notation preserved", prompt)
        self.assertIn("may start or end mid-sentence", prompt)
        self.assertIn("no boundary punctuation added", prompt)
        self.assertIn("whole-response coverage pass", prompt)
        self.assertIn("substantial uncovered sections", prompt)
        self.assertIn('"descriptor_ids"', prompt)
        self.assertIn("selecting freely\nfrom all levels", prompt)
        self.assertIn("do not alter the fixed holistic score or band", prompt)
        self.assertNotIn("SEGMENTED RESULT", prompt)

    def test_aggregation_schema_limits_evidence_to_ten_items(self):
        evidence = [
            {
                "quote": f"Quote {index}",
                "explanation": "Explanation",
                "descriptor_ids": ["ao4-3a"],
            }
            for index in range(11)
        ]

        with self.assertRaises(ValidationError):
            AggregationResult.model_validate({
                "delimiter_token": "test",
                "evidence": evidence,
            })

    def test_aggregation_schema_requires_descriptor_ids_for_each_quote(self):
        with self.assertRaises(ValidationError):
            AggregationResult.model_validate({
                "delimiter_token": "test",
                "evidence": [{
                    "quote": "Student quotation",
                    "explanation": "Explanation",
                }],
            })

    def test_aggregation_schema_allows_multiple_descriptors_for_one_quote(self):
        result = AggregationResult.model_validate({
            "delimiter_token": "test",
            "evidence": [{
                "quote": "The quotation and the student's opinion.",
                "explanation": "This demonstrates two awarded-band descriptors.",
                "descriptor_ids": ["ao4-2b", "ao4-2c"],
            }],
        })

        self.assertEqual(
            result.evidence[0].descriptor_ids,
            ["ao4-2b", "ao4-2c"],
        )

    def test_extracted_result_is_reduced_to_mark_summary(self):
        extracted_result = {
            "score": 8,
            "maxScore": 15,
            "rubric_breakdown": [
                {
                    "criterion": "AO4",
                    "awarded_band": "Level 3",
                    "score_awarded": 8,
                    "max_marks": 15,
                    "reason": "This must not be included.",
                    "evidence_supporting_awarded_band": [],
                }
            ],
            "actionable_steps": ["This must not be included."],
        }

        selected = _select_extracted_result(extracted_result)

        self.assertEqual(selected, {
            "score": 8,
            "maxScore": 15,
            "percentage": 53,
            "breakdown": [
                {
                    "section": "AO4",
                    "awardedBand": "Level 3",
                    "marks": 8,
                    "maxMarks": 15,
                }
            ],
        })


if __name__ == "__main__":
    unittest.main()
