from typing import Literal

from pydantic import BaseModel, ConfigDict


NotFound = Literal["value not found"]


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
    )


class BandMark(StrictBaseModel):
    band: str
    marks: str


class ThreadLevel(StrictBaseModel):
    descriptor_id: str
    band: str
    text: str


class DescriptorThread(StrictBaseModel):
    thread_key: str
    thread_id: str
    thread_description: str
    levels: list[ThreadLevel]


class AssessmentObjectiveThreads(StrictBaseModel):
    ao: str
    marks_available: int | NotFound
    band_marks: list[BandMark]
    threads: list[DescriptorThread]


class QuestionThreads(StrictBaseModel):
    question: str
    marks_available: int | NotFound
    assessment_objectives: list[AssessmentObjectiveThreads]


class ThreadDescriptionResult(StrictBaseModel):
    delimiter_token: str
    questions: list[QuestionThreads]
