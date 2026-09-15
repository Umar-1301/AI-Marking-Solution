from pydantic import BaseModel, ConfigDict, Field


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FinalEvidence(StrictBaseModel):
    evidence_id: str = Field(min_length=1)
    descriptor_ids: list[str] = Field(min_length=1)
    explanation: str = Field(min_length=1)
    summary: str = Field(min_length=1)


class FinalObjectiveMark(StrictBaseModel):
    section: str = Field(min_length=1)
    awarded_band: str = Field(min_length=1)
    marks: int = Field(ge=0)
    max_marks: int = Field(ge=1)
    summary: str = Field(min_length=1)


class FinalMarkingResult(StrictBaseModel):
    delimiter_token: str
    score: int = Field(ge=0)
    max_score: int = Field(ge=1)
    summary: str = Field(min_length=1)
    breakdown: list[FinalObjectiveMark] = Field(min_length=1)
    evidence: list[FinalEvidence]
