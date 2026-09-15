from pydantic import BaseModel, ConfigDict


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
    )


class DescriptorEvidence(StrictBaseModel):
    quote: str
    explanation: str


class AwardedBandDescriptorEvidence(StrictBaseModel):
    descriptor_id: str
    status: str
    evidence: list[DescriptorEvidence]
    judgement: str


class RubricCriterion(StrictBaseModel):
    criterion: str
    awarded_band: str
    score_awarded: int
    max_marks: int
    evidence_supporting_awarded_band: list[AwardedBandDescriptorEvidence]
    next_band_requirement_not_met: str | None
    reason: str


class MarkingResult(StrictBaseModel):
    max_score_detected: int
    delimiter_token: str
    actionable_steps: list[str]
    rubric_breakdown: list[RubricCriterion]
    teacher_review_required: bool
    question_mismatch: bool
    question_mismatch_reason: str | None
