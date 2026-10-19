import asyncio
import copy
import importlib
import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from final_marking.context import (
    build_final_marking_context,
    reconcile_final_score,
    resolve_final_marking_result,
)
from final_marking.final_prompt import SYSTEM_PROMPT, build_final_marking_user_prompt
from schemas.final_marking_result import FinalMarkingResult
from security import ms_ocr_sanitisation
from transformations.fm_descriptor_to_thread import fm_descriptor_to_thread


def inputs():
    scheme = {
        "question_number": "Question 4", "marks": 6,
        "description": "Evaluate how fear is created.",
        "assessment_objectives": [{
            "ao": "AO4", "marks_available": 6, "description": "Evaluate texts.",
            "bands": [
                {"band": "Level 0", "marks": "0", "descriptors": []},
                *[{
                    "band": f"Level {level}", "marks": marks,
                    "descriptors": [
                        {"id": f"ao4-{level}{key}", "text": f"Criterion {key} at level {level}."}
                        for key in ("a", "b")
                    ],
                } for level, marks in [(1, "1–3"), (2, "4–6")]],
            ],
        }],
    }
    threads = {"assessment_objectives": {"AO4": {
        "band_marks": [
            {"band": "Level 0", "marks": "0"},
            {"band": "Level 1", "marks": "1–3"},
            {"band": "Level 2", "marks": "4–6"},
        ],
        "threads": {
            key: {
                "thread_id": f"ao4-thread-{key}",
                "thread_description": f"Capability {key}",
                "levels": [{
                    "descriptor_id": f"ao4-{level}{key}",
                    "band": f"Level {level}",
                    "text": f"Thread extraction criterion {key} at level {level}.",
                } for level in (1, 2)],
            }
            for key in ("a", "b")
        },
    }}}
    aggregation = {"status": "complete", "result": {
        "evidence": [{
            "quote": ' The verb "quiet" suggests ~~that the~~ a sense of fear. ',
            "descriptor_ids": ["ao4-2a", "ao4-1a", "ao4-1b"],
        }],
    }}
    return aggregation, scheme, threads


def output():
    return {
        "delimiter_token": "test", "score": 2, "max_score": 6,
        "summary": "Limited evaluation with a relevant reference.",
        "breakdown": [{
            "section": "AO4", "awarded_band": "Level 1", "marks": 2,
            "max_marks": 6, "summary": "Limited development places this within Level 1.",
        }],
        "evidence": [{
            "evidence_id": "e1", "descriptor_ids": ["ao4-1a", "ao4-1b"],
            "explanation": "An opinion about fear with a relevant reference.",
            "summary": "Relevant reference with a simple opinion.",
        }],
        "featured_evidence_by_thread": [],
    }


class FinalMarkingTests(unittest.TestCase):
    def setUp(self):
        self.aggregation, self.scheme, self.threads = inputs()
        self.context = build_final_marking_context(self.aggregation, self.scheme, self.threads)

    def test_input_carries_only_quote_and_thread_suggestions(self):
        evidence = self.context["evidence"][0]
        self.assertEqual(set(evidence), {"evidence_id", "quote", "thread_ids"})
        self.assertEqual(evidence["thread_ids"], ["ao4-thread-a", "ao4-thread-b"])
        self.assertEqual(
            [thread["thread_id"] for thread in self.context["assessment_objectives"][0]["threads"]],
            ["ao4-thread-a", "ao4-thread-b"],
        )
        self.assertNotIn("score", self.context)
        self.assertEqual(self.context["question"]["description"], self.scheme["description"])
        levels = self.context["assessment_objectives"][0]["threads"][0]["levels"]
        self.assertEqual([level["descriptor_id"] for level in levels], ["ao4-1a", "ao4-2a"])

    def test_levels_come_directly_from_thread_extraction(self):
        supplied_levels = self.threads["assessment_objectives"]["AO4"]["threads"]["a"]["levels"]
        supplied_levels[0]["text"] = "Authoritative thread-extraction text."
        self.scheme["assessment_objectives"][0]["bands"][1]["descriptors"][0]["text"] = "Not used."

        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)

        self.assertIs(context["assessment_objectives"][0]["threads"][0]["levels"], supplied_levels)
        self.assertEqual(
            context["assessment_objectives"][0]["threads"][0]["levels"][0]["text"],
            "Authoritative thread-extraction text.",
        )

    def test_question_marks_come_from_selected_scheme(self):
        self.scheme["marks"] = 9

        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)

        self.assertEqual(context["question"]["marks_available"], 9)

    def test_band_marks_come_directly_from_thread_extraction(self):
        supplied_band_marks = [
            {"band": "Level 0", "marks": "0"},
            {"band": "Level 1", "marks": "1–2"},
            {"band": "Level 2", "marks": "3–6"},
        ]
        self.threads["assessment_objectives"]["AO4"]["band_marks"] = supplied_band_marks
        self.scheme["assessment_objectives"][0]["bands"][1]["marks"] = "not used"

        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)

        self.assertIs(context["assessment_objectives"][0]["band_marks"], supplied_band_marks)

    def test_missing_thread_extraction_band_marks_are_rejected(self):
        self.threads["assessment_objectives"]["AO4"].pop("band_marks")

        with self.assertRaisesRegex(ValueError, "requires band marks from thread extraction for AO4"):
            build_final_marking_context(self.aggregation, self.scheme, self.threads)

    def test_invalid_selected_scheme_question_marks_are_rejected(self):
        self.scheme["marks"] = "value not found"

        with self.assertRaisesRegex(ValueError, "requires question marks from the selected scheme"):
            build_final_marking_context(self.aggregation, self.scheme, self.threads)

    def test_resolution_keeps_source_quote_character_for_character(self):
        result = resolve_final_marking_result(output(), self.context)
        self.assertEqual(result["evidence"][0]["quote"], self.aggregation["result"]["evidence"][0]["quote"])
        self.assertEqual(result["score"], 2)  # Can disagree with the earlier award.
        self.assertEqual(result["original_score"], 2)
        self.assertEqual(result["delta"], 0)
        self.assertEqual(result["max_score"], 6)
        self.assertEqual(result["original_max_score"], 6)
        self.assertEqual(result["max_score_delta"], 0)

    def test_breakdown_marks_override_the_model_total(self):
        model_result = output()
        model_result["score"] = 1
        result = resolve_final_marking_result(model_result, self.context)
        self.assertEqual(result["score"], 2)
        self.assertEqual(result["original_score"], 1)
        self.assertEqual(result["delta"], 1)

    def test_breakdown_maxima_override_the_model_total_without_losing_it(self):
        model_result = output()
        model_result["max_score"] = 12

        result = resolve_final_marking_result(model_result, self.context)

        self.assertEqual(result["max_score"], 6)
        self.assertEqual(result["original_max_score"], 12)
        self.assertEqual(result["max_score_delta"], -6)
        self.assertEqual(reconcile_final_score(result)["original_max_score"], 12)

    def test_no_hidden_evidence_cap(self):
        self.aggregation["result"]["evidence"] *= 12
        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)
        self.assertEqual(len(context["evidence"]), 12)
        result = output()
        result["evidence"] = [{**result["evidence"][0], "evidence_id": f"e{i}"} for i in range(1, 13)]
        parsed = FinalMarkingResult.model_validate(result)
        self.assertEqual(len(resolve_final_marking_result(parsed.model_dump(), context)["evidence"]), 12)

    def test_schema_carries_featured_evidence_as_thread_entries(self):
        result = output()
        result["featured_evidence_by_thread"] = [
            {"thread_id": "ao4-thread-a", "evidence_ids": ["e1"]},
        ]

        parsed = FinalMarkingResult.model_validate(result)

        self.assertEqual(parsed.model_dump()["featured_evidence_by_thread"], [
            {"thread_id": "ao4-thread-a", "evidence_ids": ["e1"]},
        ])

    def test_every_aggregation_evidence_id_is_required(self):
        self.aggregation["result"]["evidence"] *= 2
        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)

        with self.assertRaisesRegex(ValueError, "must return every supplied evidence ID"):
            resolve_final_marking_result(output(), context)

    def test_prompt_requires_every_catalogue_entry(self):
        self.assertIn("Return EVERY evidence entry", SYSTEM_PROMPT)
        self.assertIn("Return every supplied evidence_id exactly once", build_final_marking_user_prompt("input"))

    def test_user_prompt_matches_final_result_shape_and_keeps_one_row_per_ao(self):
        prompt = build_final_marking_user_prompt("test input")

        for field in (
            "delimiter_token", "score", "max_score", "summary", "breakdown",
            "section", "awarded_band", "marks", "max_marks", "evidence",
            "evidence_id", "descriptor_ids", "explanation",
            "featured_evidence_by_thread", "thread_id", "evidence_ids",
        ):
            self.assertIn(f'"{field}":', prompt)
        self.assertIn("test input", prompt)
        self.assertIn("exactly one AO4 entry", prompt)
        self.assertIn("not another\nmark-bearing section", prompt)
        self.assertIn("Never\ndivide an AO's marks across multiple entries", prompt)

    def test_bad_references_and_inconsistent_marks_are_rejected(self):
        variants = []
        result = output()
        result["breakdown"][0]["max_marks"] = 15
        variants.append(result)
        result = output()
        result["breakdown"][0]["awarded_band"] = "Level 2"
        variants.append(result)
        result = output()
        result["breakdown"] *= 2
        variants.append(result)
        result = output()
        result["evidence"][0]["evidence_id"] = "invented"
        variants.append(result)
        result = output()
        result["evidence"] *= 2
        variants.append(result)
        for result in variants:
            with self.subTest(result=result), self.assertRaises(ValueError):
                resolve_final_marking_result(result, self.context)

    def test_final_marking_can_add_a_descriptor_from_another_thread(self):
        aggregation, scheme, threads = inputs()
        aggregation["result"]["evidence"][0]["descriptor_ids"] = ["ao4-2a"]
        context = build_final_marking_context(aggregation, scheme, threads)
        result = output()
        result["evidence"][0]["descriptor_ids"] = ["ao4-1a", "ao4-1b"]

        resolved = resolve_final_marking_result(result, context)

        self.assertEqual(resolved["evidence"][0]["descriptor_ids"], ["ao4-1a", "ao4-1b"])
        self.assertEqual(resolved["evidence"][0]["quote"], context["evidence"][0]["quote"])

    def test_final_descriptors_become_unique_threads_without_changing_other_fields(self):
        resolved = resolve_final_marking_result(output(), self.context)
        resolved["evidence"][0]["descriptor_ids"] = [
            "ao4-1a", "ao4-2a", "ao4-1b", "ao4-2a"
        ]

        transformed = fm_descriptor_to_thread(resolved, self.context)

        self.assertEqual(
            transformed["evidence"][0]["descriptor_ids"],
            ["ao4-thread-a", "ao4-thread-b"],
        )
        self.assertEqual(resolved["evidence"][0]["descriptor_ids"][0], "ao4-1a")
        self.assertEqual(transformed["evidence"][0]["quote"], resolved["evidence"][0]["quote"])
        self.assertEqual(transformed["breakdown"], resolved["breakdown"])

    def test_final_descriptors_can_map_to_more_than_two_threads(self):
        context = copy.deepcopy(self.context)
        context["assessment_objectives"][0]["threads"].append({
            "thread_id": "ao4-thread-c",
            "levels": [{"descriptor_id": "ao4-1c"}],
        })
        resolved = resolve_final_marking_result(output(), context)
        resolved["evidence"][0]["descriptor_ids"] = [
            "ao4-1a", "ao4-1b", "ao4-1c"
        ]

        transformed = fm_descriptor_to_thread(resolved, context)

        self.assertEqual(
            transformed["evidence"][0]["descriptor_ids"],
            ["ao4-thread-a", "ao4-thread-b", "ao4-thread-c"],
        )

    def test_unknown_final_descriptor_cannot_be_transformed(self):
        resolved = resolve_final_marking_result(output(), self.context)
        resolved["evidence"][0]["descriptor_ids"] = ["ao4-9z"]

        with self.assertRaisesRegex(ValueError, "unknown descriptor ID"):
            fm_descriptor_to_thread(resolved, self.context)

    def test_missing_threads_and_unknown_input_descriptors_are_rejected(self):
        with self.assertRaises(ValueError):
            build_final_marking_context(self.aggregation, self.scheme, {})
        missing_thread_id = copy.deepcopy(self.threads)
        missing_thread_id["assessment_objectives"]["AO4"]["threads"]["a"].pop("thread_id")
        with self.assertRaisesRegex(ValueError, "requires an ID for AO4 thread a"):
            build_final_marking_context(self.aggregation, self.scheme, missing_thread_id)
        self.aggregation["result"]["evidence"][0]["descriptor_ids"] = ["ao4-9a"]
        with self.assertRaises(ValueError):
            build_final_marking_context(self.aggregation, self.scheme, self.threads)

    def test_multiple_objectives_and_zero_marks(self):
        objective = copy.deepcopy(self.scheme["assessment_objectives"][0])
        objective["ao"] = "AO6"
        for band in objective["bands"]:
            for descriptor in band["descriptors"]:
                descriptor["id"] = descriptor["id"].replace("ao4", "ao6")
        self.scheme["assessment_objectives"].append(objective)
        ao6_threads = copy.deepcopy(self.threads["assessment_objectives"]["AO4"])
        for thread in ao6_threads["threads"].values():
            thread["thread_id"] = thread["thread_id"].replace("ao4", "ao6")
            for level in thread["levels"]:
                level["descriptor_id"] = level["descriptor_id"].replace("ao4", "ao6")
        self.threads["assessment_objectives"]["AO6"] = ao6_threads
        context = build_final_marking_context(self.aggregation, self.scheme, self.threads)
        result = output()
        result["max_score"] = 12
        result["breakdown"].append({
            "section": "AO6", "marks": 0, "max_marks": 6,
            "awarded_band": "Level 0", "summary": "No supporting evidence supplied.",
        })
        resolved = resolve_final_marking_result(result, context)
        self.assertEqual(resolved["max_score"], 12)
        self.assertEqual(resolved["original_max_score"], 12)
        self.assertEqual(resolved["max_score_delta"], 0)


class FinalMarkingServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Construct no live API client and never call OCR/RAG in these tests.
        with patch("openai.OpenAI"):
            cls.service = importlib.import_module("llm_service")
            cls.main = importlib.import_module("main")

    def test_raw_model_response_is_captured_before_final_validation(self):
        context = build_final_marking_context(*inputs())
        model_output = output()
        model_output["evidence"][0]["descriptor_ids"] = ["ao4-9z"]
        raw_content = json.dumps(model_output)
        message = SimpleNamespace(
            refusal=None,
            parsed=FinalMarkingResult.model_validate(model_output),
            content=raw_content,
        )
        client = Mock()
        client.chat.completions.parse.return_value = SimpleNamespace(
            id="response-1",
            model="test-model",
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
        )

        with patch.object(self.service, "client", client), \
             patch.object(self.service, "save_raw_final_marking_response") as capture, \
             redirect_stdout(io.StringIO()):
            with self.assertRaises(self.service.FinalMarkingValidationError):
                self.service.generate_final_marking_response("wrapped", "test", context)

        capture.assert_called_once_with(
            raw_content,
            response_id="response-1",
            model="test-model",
            finish_reason="stop",
        )

    def test_delimiter_verification_and_quote_resolution(self):
        context = build_final_marking_context(*inputs())
        model_output = output()
        model_output["featured_evidence_by_thread"] = [
            {"thread_id": "ao4-thread-a", "evidence_ids": ["e1"]},
        ]
        message = SimpleNamespace(refusal=None, parsed=FinalMarkingResult.model_validate(model_output))
        client = Mock()
        client.chat.completions.parse.return_value = SimpleNamespace(choices=[SimpleNamespace(message=message)])
        with patch.object(self.service, "client", client), redirect_stdout(io.StringIO()):
            result = self.service.generate_final_marking_response("wrapped", "test", context)
            self.assertNotIn("delimiter_token", result)
            self.assertEqual(result["evidence"][0]["quote"], context["evidence"][0]["quote"])
            self.assertEqual(result["featured_evidence_by_thread"], [
                {"thread_id": "ao4-thread-a", "evidence_ids": ["e1"]},
            ])
            self.assertEqual(
                result["evidence"][0]["descriptor_ids"],
                ["ao4-thread-a", "ao4-thread-b"],
            )
            with self.assertRaises(ms_ocr_sanitisation.TokenMismatchError):
                self.service.generate_final_marking_response("wrapped", "different-token", context)

    def test_final_descriptor_thread_addition_passes_application_validation(self):
        aggregation, scheme, threads = inputs()
        aggregation["result"]["evidence"][0]["descriptor_ids"] = ["ao4-2a"]
        context = build_final_marking_context(aggregation, scheme, threads)
        model_output = output()
        model_output["score"] = 3
        model_output["evidence"][0]["descriptor_ids"] = ["ao4-1b"]
        message = SimpleNamespace(refusal=None, parsed=FinalMarkingResult.model_validate(model_output))
        client = Mock()
        client.chat.completions.parse.return_value = SimpleNamespace(choices=[SimpleNamespace(message=message)])
        with patch.object(self.service, "client", client), redirect_stdout(io.StringIO()):
            result = self.service.generate_final_marking_response("wrapped", "test", context)
        self.assertEqual(result["evidence"][0]["descriptor_ids"], ["ao4-thread-b"])
        self.assertEqual(result["evidence"][0]["quote"], context["evidence"][0]["quote"])
        self.assertEqual(result["score"], 2)
        self.assertEqual(result["original_score"], 3)
        self.assertEqual(result["delta"], -1)
        self.assertNotIn("delimiter_token", result)

    def test_doubled_model_maximum_is_reconciled_before_validation(self):
        aggregation, scheme, threads = inputs()
        scheme["marks"] = 15
        scheme["assessment_objectives"][0]["marks_available"] = 15
        threads["assessment_objectives"]["AO4"]["band_marks"][1]["marks"] = "1–7"
        threads["assessment_objectives"]["AO4"]["band_marks"][2]["marks"] = "8–15"
        context = build_final_marking_context(aggregation, scheme, threads)
        model_output = output()
        model_output["score"] = 22
        model_output["max_score"] = 30
        model_output["breakdown"][0]["marks"] = 7
        model_output["breakdown"][0]["max_marks"] = 15
        message = SimpleNamespace(refusal=None, parsed=FinalMarkingResult.model_validate(model_output))
        client = Mock()
        client.chat.completions.parse.return_value = SimpleNamespace(choices=[SimpleNamespace(message=message)])

        with patch.object(self.service, "client", client), redirect_stdout(io.StringIO()):
            result = self.service.generate_final_marking_response("wrapped", "test", context)

        self.assertEqual(result["score"], 7)
        self.assertEqual(result["original_score"], 22)
        self.assertEqual(result["delta"], -15)
        self.assertEqual(result["max_score"], 15)
        self.assertEqual(result["original_max_score"], 30)
        self.assertEqual(result["max_score_delta"], -15)

    def test_unknown_final_descriptor_retains_raw_model_result_for_diagnosis(self):
        context = build_final_marking_context(*inputs())
        model_output = output()
        model_output["evidence"][0]["descriptor_ids"] = ["ao4-9z"]
        message = SimpleNamespace(refusal=None, parsed=FinalMarkingResult.model_validate(model_output))
        client = Mock()
        client.chat.completions.parse.return_value = SimpleNamespace(choices=[SimpleNamespace(message=message)])

        with patch.object(self.service, "client", client), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(self.service.FinalMarkingValidationError, "unknown descriptor ID") as error:
                self.service.generate_final_marking_response("wrapped", "test", context)

        self.assertEqual(error.exception.model_result["evidence"][0]["descriptor_ids"], ["ao4-9z"])

    def test_route_runs_holistic_then_aggregation_then_final(self):
        aggregation, scheme, threads = inputs()
        order = []

        def holistic(**kwargs):
            order.append("holistic")
            self.assertEqual(kwargs["question"], "")
            return {"score": 5, "maxScore": 6, "rubric_breakdown": [{"awarded_band": "Level 2"}]}

        def aggregate(**kwargs):
            order.append("aggregation")
            self.assertEqual(kwargs["assessment_focus"], ["Evaluate texts."])
            self.assertEqual(kwargs["extracted_result"]["score"], 5)
            self.assertEqual(kwargs["mark_scheme_extraction"]["awarded_band"], "Level 2")
            self.assertEqual(kwargs["mark_scheme_extraction"]["thread_extraction"], threads)
            return aggregation["result"]

        def final(wrapped, token, context, **kwargs):
            order.append("final")
            self.assertIn(f"<<<MARK_SCHEME_OCR_{token}>>>", wrapped)
            self.assertNotIn("Prior", wrapped)
            return resolve_final_marking_result(output(), context)

        with patch.object(self.main, "extract_student_ocr_with_raw", return_value=({"handwritten_work": "Student work"}, {"pages": []})), \
             patch.object(self.main, "save_raw_student_ocr_response"), \
             patch.object(self.main, "get_similar", return_value=[]), \
             patch.object(self.main, "generate_llm_response", side_effect=holistic), \
             patch.object(self.main, "generate_aggregation_response", side_effect=aggregate), \
             patch.object(self.main, "generate_final_marking_response", side_effect=final), \
             patch.object(self.service, "generate_segmentation_response", side_effect=AssertionError("Segmentation must stay disconnected")):
            result = asyncio.run(self.main.mark_with_scheme_text(
                student_work=SimpleNamespace(read=AsyncMock(return_value=b"image"), filename="test.png"),
                scheme_text=json.dumps(scheme), thread_extraction=json.dumps(threads),
            ))
        self.assertEqual(order, ["holistic", "aggregation", "final"])
        self.assertEqual(result["score"], 5)
        self.assertEqual(result["final_result"]["result"]["score"], 2)
        self.assertNotIn("segmentation", result)

    def test_route_retains_model_result_for_final_validation_failure(self):
        aggregation, scheme, threads = inputs()
        diagnostic = output()
        diagnostic.pop("delimiter_token")
        diagnostic = reconcile_final_score(diagnostic)

        with patch.object(self.main, "extract_student_ocr_with_raw", return_value=({"handwritten_work": "Student work"}, {"pages": []})), \
             patch.object(self.main, "save_raw_student_ocr_response"), \
             patch.object(self.main, "get_similar", return_value=[]), \
             patch.object(self.main, "generate_llm_response", return_value={
                 "score": 5, "maxScore": 6,
                 "rubric_breakdown": [{"awarded_band": "Level 2"}],
             }), \
             patch.object(self.main, "generate_aggregation_response", return_value=aggregation["result"]), \
             patch.object(self.main, "generate_final_marking_response", side_effect=
                 self.service.FinalMarkingValidationError("invalid descriptor thread", diagnostic)):
            result = asyncio.run(self.main.mark_with_scheme_text(
                student_work=SimpleNamespace(read=AsyncMock(return_value=b"image"), filename="test.png"),
                scheme_text=json.dumps(scheme), thread_extraction=json.dumps(threads),
            ))

        self.assertEqual(result["final_result"]["status"], "failed")
        self.assertEqual(result["final_result"]["model_result"], diagnostic)

    def test_route_rejects_expired_worker_deadline_before_ocr(self):
        with patch.object(self.main, "extract_student_ocr_with_raw",
                          side_effect=AssertionError("OCR must not start")):
            with self.assertRaises(self.main.HTTPException) as raised:
                asyncio.run(self.main.mark_with_scheme_text(
                    student_work=SimpleNamespace(
                        read=AsyncMock(return_value=b"image"), filename="test.png"
                    ),
                    scheme_text="{}", thread_extraction="{}",
                    x_student_marking_deadline="2000-01-01T00:00:00Z",
                ))
        self.assertEqual(raised.exception.status_code, 504)
