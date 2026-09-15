import unittest

from segmentation.seg_prompt import build_segmentation_user_prompt


class SegmentationPromptTests(unittest.TestCase):
    def test_user_prompt_contains_selected_assessment_objective_descriptions(self):
        prompt = build_segmentation_user_prompt(
            question="",
            marks_available=15,
            assessment_objective_descriptions=(
                '[{"ao": "AO4", "description": '
                '"Evaluate texts critically and support this with references."}]'
            ),
            thread_extraction='{"assessment_objectives": {"AO4": {}}}',
            essay=(
                "<<<MARK_SCHEME_OCR_test>>>Student text"
                "<<<END_MARK_SCHEME_OCR_test>>>"
            ),
        )

        self.assertIn(
            "ASSESSMENT-OBJECTIVE DESCRIPTIONS FROM THE SELECTED QUESTION",
            prompt,
        )
        self.assertIn("derive the assessment focus", prompt)
        self.assertIn("Evaluate texts critically", prompt)
        self.assertIn("THREAD EXTRACTION FOR THE SELECTED QUESTION", prompt)


if __name__ == "__main__":
    unittest.main()
