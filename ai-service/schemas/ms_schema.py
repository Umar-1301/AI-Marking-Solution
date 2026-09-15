from typing import Literal
from pydantic import BaseModel, ConfigDict

# Sentinel used everywhere a value could not be determined from the source,
# instead of making the field Optional/nullable. Every field stays required
# and present — the shape of the response never changes based on what the
# model did or didn't find. One shared type alias so every field uses the
# exact same string; not a stand-in for "empty list" on list fields, which
# already unambiguously means "none found" on their own.
# A type alias (not a Final-annotated value) because this Pylance/pyright
# setup doesn't narrow a Final variable down to its literal type — it showed
# NOT_FOUND as type Any, which Literal[...] correctly rejected. Aliasing the
# Literal type itself sidesteps that inference entirely; it's always valid
# in a Union regardless of narrowing support.
NotFound = Literal["value not found"]


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
    )


class Band(StrictBaseModel):
    band: str
    marks: str
    descriptor: str
    descriptors: list[str]


class BandConstraint(StrictBaseModel):
    ao: str
    description: str
    affected_bands: list[str]


class AssessmentObjective(StrictBaseModel):
    ao: str
    marks_available: int | NotFound
    description: str
    bands: list[Band]


class Question(StrictBaseModel):
    question_number: str
    marks: int | NotFound
    description: str
    assessment_objectives: list[AssessmentObjective]
    band_constraints: list[BandConstraint]


class MarkSchemeExtraction(StrictBaseModel):
    paper_type: Literal["single", "multi"] | NotFound
    total_marks: int | NotFound
    delimiter_token: str
    questions: list[Question]
