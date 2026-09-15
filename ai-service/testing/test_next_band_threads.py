import unittest

from aggregation.next_band_threads import get_next_band_threads


def _band(level: int, descriptors: list[tuple[str, str]]) -> dict:
    return {
        "band": f"Level {level}",
        "marks": str(level),
        "descriptor": " ".join(text for _, text in descriptors),
        "descriptors": [
            {"id": descriptor_id, "text": text}
            for descriptor_id, text in descriptors
        ],
    }


def _extracted_scheme() -> dict:
    return {
        "paper_type": "multi",
        "total_marks": 21,
        "questions": [
            {
                "question_number": "Question 3",
                "marks": 6,
                "assessment_objectives": [
                    {
                        "ao": "AO2",
                        "marks_available": 6,
                        "bands": [
                            _band(1, [
                                ("ao2-1a", "Comment on language and structure."),
                                ("ao2-1b", "References are valid but undeveloped."),
                            ]),
                            _band(2, [
                                ("ao2-2a", "Explain language and structure."),
                                ("ao2-2b", "References are appropriate and relevant."),
                            ]),
                            _band(3, [
                                ("ao2-3a", "Analyse language and structure."),
                                ("ao2-3b", "References are discriminating."),
                            ]),
                        ],
                    }
                ],
            },
            {
                "question_number": "Question 4",
                "marks": 15,
                "assessment_objectives": [
                    {
                        "ao": "AO4",
                        "marks_available": 15,
                        "bands": [
                            _band(1, [
                                ("ao4-1a", "Describe ideas."),
                                ("ao4-1b", "Make limited assertions."),
                                ("ao4-1c", "Use limited references."),
                            ]),
                            _band(2, [
                                ("ao4-2a", "Comment on ideas."),
                                ("ao4-2b", "Offer straightforward opinions."),
                                ("ao4-2c", "Use valid references."),
                            ]),
                            _band(3, [
                                ("ao4-3a", "Explain ideas."),
                                ("ao4-3b", "Offer informed judgement."),
                                ("ao4-3c", "Use appropriate references."),
                            ]),
                            _band(4, [
                                ("ao4-4a", "Analyse ideas."),
                                ("ao4-4b", "Offer developed judgement."),
                                ("ao4-4c", "Use detailed references."),
                            ]),
                            _band(5, [
                                ("ao4-5a", "Evaluate ideas."),
                                ("ao4-5b", "Offer sustained judgement."),
                                ("ao4-5c", "Use apt references."),
                            ]),
                        ],
                    }
                ],
            },
        ],
    }


def _descriptor_ids(result: dict) -> list[str]:
    return [
        thread["level"]["descriptor_id"]
        for objective in result["assessment_objectives"].values()
        for thread in objective["threads"].values()
    ]


class NextBandThreadTests(unittest.TestCase):
    def setUp(self):
        self.scheme = _extracted_scheme()

    def test_question_three_returns_each_next_level_descriptor(self):
        cases = [
            ("Level 1", "Level 2", ["ao2-2a", "ao2-2b"]),
            ("Level 2", "Level 3", ["ao2-3a", "ao2-3b"]),
        ]

        for awarded_band, expected_band, expected_ids in cases:
            with self.subTest(awarded_band=awarded_band):
                result = get_next_band_threads(
                    awarded_band,
                    self.scheme,
                    "Question 3",
                )

                self.assertEqual(result["next_band"], expected_band)
                self.assertEqual(_descriptor_ids(result), expected_ids)

    def test_question_four_returns_each_next_level_descriptor(self):
        cases = [
            ("Level 1", "Level 2", ["ao4-2a", "ao4-2b", "ao4-2c"]),
            ("Level 2", "Level 3", ["ao4-3a", "ao4-3b", "ao4-3c"]),
            ("Level 3", "Level 4", ["ao4-4a", "ao4-4b", "ao4-4c"]),
            ("Level 4", "Level 5", ["ao4-5a", "ao4-5b", "ao4-5c"]),
        ]

        for awarded_band, expected_band, expected_ids in cases:
            with self.subTest(awarded_band=awarded_band):
                result = get_next_band_threads(
                    awarded_band,
                    self.scheme,
                    "Question 4",
                )

                self.assertEqual(result["next_band"], expected_band)
                self.assertEqual(_descriptor_ids(result), expected_ids)

    def test_highest_band_returns_no_next_band_or_threads(self):
        for question, highest_band in [("Question 3", "Level 3"), ("Question 4", "Level 5")]:
            with self.subTest(question=question):
                result = get_next_band_threads(highest_band, self.scheme, question)

                self.assertIsNone(result["next_band"])
                self.assertEqual(result["assessment_objectives"], {})

    def test_full_scheme_requires_a_question(self):
        with self.assertRaisesRegex(ValueError, "question is required"):
            get_next_band_threads("Level 2", self.scheme)


if __name__ == "__main__":
    unittest.main()
