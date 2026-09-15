import unittest

from validation.descriptor_id_enrichment import add_descriptor_ids
from validation.descriptor_integrity_validation import (
    DESCRIPTOR_CONTENT_MISMATCH,
    validate_descriptor_content_integrity,
)
from validation.descriptor_validation import (
    split_descriptor_bullets,
    validate_descriptor_shapes,
)


def _scheme(*, ao="AO4", band="Level 2", descriptor=None, descriptors=None):
    return {
        "questions": [{
            "question_number": "Q4",
            "assessment_objectives": [{
                "ao": ao,
                "bands": [{
                    "band": band,
                    "descriptor": descriptor or (
                        "• Comment on ideas.\n"
                        "• Straightforward opinions are offered.\n"
                        "• References are valid."
                    ),
                    "descriptors": descriptors or [
                        "Comment on ideas.",
                        "Straightforward opinions are offered.",
                        "References are valid.",
                    ],
                }],
            }],
        }],
    }


class DescriptorValidationTests(unittest.TestCase):
    def _validate_and_add_ids(self, source):
        self.assertEqual(validate_descriptor_shapes(source), [])
        self.assertEqual(validate_descriptor_content_integrity(source), [])
        return add_descriptor_ids(source)

    def test_matching_bullets_are_enriched_with_deterministic_ids(self):
        source = _scheme()

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
            [
                {"id": "ao4-2a", "text": "Comment on ideas."},
                {"id": "ao4-2b", "text": "Straightforward opinions are offered."},
                {"id": "ao4-2c", "text": "References are valid."},
            ],
        )
        self.assertIsInstance(
            source["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"][0],
            str,
        )

    def test_wrapped_bullet_is_kept_as_one_descriptor(self):
        source = _scheme(
            descriptor=(
                "• Comment on ideas, events, themes\n"
                "  or settings.\n"
                "• References are valid."
            ),
            descriptors=[
                "Comment on ideas, events, themes or settings.",
                "References are valid.",
            ],
        )

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"][0],
            {"id": "ao4-2a", "text": "Comment on ideas, events, themes or settings."},
        )

    def test_flattened_ao4_bullets_are_separated(self):
        source = _scheme(
            descriptor=(
                "• Comment on ideas, events, themes or settings. "
                "• Straightforward opinions with limited judgements are offered about the text. "
                "• The selection of references is valid, but not developed."
            ),
            descriptors=[
                "Comment on ideas, events, themes or settings.",
                "Straightforward opinions with limited judgements are offered about the text.",
                "The selection of references is valid, but not developed.",
            ],
        )

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            [item["id"] for item in enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"]],
            ["ao4-2a", "ao4-2b", "ao4-2c"],
        )

    def test_nb_note_is_a_separate_descriptor(self):
        source = _scheme(
            ao="AO2",
            band="Level 1",
            descriptor=(
                "• Comment on language and structure. "
                "• References are valid, but not developed. "
                "NB: The mark cannot progress beyond Level 1 if only language "
                "or structure has been considered."
            ),
            descriptors=[
                "Comment on language and structure.",
                "References are valid, but not developed.",
                "NB: The mark cannot progress beyond Level 1 if only language or structure has been considered.",
            ],
        )

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"][2],
            {
                "id": "ao2-1c",
                "text": "NB: The mark cannot progress beyond Level 1 if only language or structure has been considered.",
            },
        )

    def test_flattened_point_mark_hyphens_preserve_the_preamble(self):
        self.assertEqual(
            split_descriptor_bullets(
                'Award 1 mark for: - "quiet" - "quiet for almost an hour"'
            ),
            ["Award 1 mark for:", '"quiet"', '"quiet for almost an hour"'],
        )

    def test_one_unbulleted_descriptor_is_enriched(self):
        source = _scheme(
            descriptor="A clear, developed critical judgement is offered.",
            descriptors=["A clear, developed critical judgement is offered."],
        )

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
            [{"id": "ao4-2a", "text": "A clear, developed critical judgement is offered."}],
        )

    def test_mismatched_lists_report_a_boundary_issue_without_enrichment(self):
        source = _scheme(descriptors=["Comment on ideas.", "References are valid."])

        issues = validate_descriptor_shapes(source)

        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["rule"], "descriptor_list_mismatch")
        self.assertEqual(
            source["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
            ["Comment on ideas.", "References are valid."],
        )

    def test_combined_ao_is_normalised_for_a_safe_id(self):
        enriched, issues = self._validate_and_add_ids(_scheme(ao="AO5/AO6"))

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"][0]["id"],
            "ao5-ao6-2a",
        )

    def test_id_text_comes_from_the_application_descriptor_list(self):
        source = _scheme(
            descriptor="• COMMENT on ideas.",
            descriptors=["comment on ideas."],
        )

        enriched, issues = self._validate_and_add_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
            [{"id": "ao4-2a", "text": "COMMENT on ideas."}],
        )

    def test_general_ao_bypasses_every_descriptor_stage(self):
        source = _scheme(
            ao="General",
            band="General",
            descriptor="Award 1 mark for each valid response: Mara shouts Yusuf's name.",
            descriptors=[
                "Award 1 mark for each valid response:",
                "Mara shouts Yusuf's name.",
            ],
        )

        self.assertEqual(validate_descriptor_shapes(source), [])
        self.assertEqual(validate_descriptor_content_integrity(source), [])
        enriched, issues = add_descriptor_ids(source)

        self.assertEqual(issues, [])
        self.assertEqual(
            enriched["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
            source["questions"][0]["assessment_objectives"][0]["bands"][0]["descriptors"],
        )

    def test_content_integrity_accepts_flattened_raw_descriptor(self):
        source = _scheme(
            ao="AO6",
            band="Level 5",
            descriptor=(
                "Sophisticated ability to write for clarity, purpose and effect. "
                "Uses an extensive vocabulary strategically; rare spelling errors "
                "do not detract from overall meaning. Punctuates writing with "
                "accuracy to aid emphasis and precision."
            ),
            descriptors=[
                "Sophisticated ability to write for clarity, purpose and effect.",
                "Uses an extensive vocabulary strategically; rare spelling errors do not detract from overall meaning.",
                "Punctuates writing with accuracy to aid emphasis and precision.",
            ],
        )

        # The boundary checker intentionally cannot infer sentence boundaries.
        # The content layer separately proves the list preserved all text.
        self.assertEqual(len(validate_descriptor_shapes(source)), 1)
        self.assertEqual(validate_descriptor_content_integrity(source), [])

    def test_content_integrity_reports_changed_descriptor_content(self):
        source = _scheme(
            descriptors=[
                "Comment on ideas.",
                "Straightforward opinions are offered.",
                "References are persuasive.",
            ],
        )

        issues = validate_descriptor_content_integrity(source)

        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["rule"], DESCRIPTOR_CONTENT_MISMATCH)
        self.assertIn("References are persuasive.", issues[0]["flattened_model_descriptors"])

    def test_content_integrity_ignores_inline_source_list_markers(self):
        source = _scheme(
            descriptor="- Comment on ideas. - References are valid.",
            descriptors=["Comment on ideas.", "References are valid."],
        )

        self.assertEqual(validate_descriptor_content_integrity(source), [])


if __name__ == "__main__":
    unittest.main()
