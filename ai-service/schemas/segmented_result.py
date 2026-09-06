from typing import Literal

from pydantic import BaseModel, ConfigDict


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
    )


class DescriptorReview(StrictBaseModel):
    descriptor_id: str
    band: str
    status: Literal["met", "partially_met", "not_met"]


class EvidenceFinalBand(StrictBaseModel):
    descriptor_id: str | None
    band: str | None
    justification: str


class ThreadEvidence(StrictBaseModel):
    evidence_id: str
    quote: str
    thread_match_explanation: str
    descriptor_reviews: list[DescriptorReview]
    final_band: EvidenceFinalBand


class ThreadAssessment(StrictBaseModel):
    thread_id: str
    thread_description: str
    evidence: list[ThreadEvidence]


class SegmentationResult(StrictBaseModel):
    delimiter_token: str
    question: str
    marks_available: int
    threads: list[ThreadAssessment]
