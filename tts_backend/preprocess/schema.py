"""Schemas shared by the three pillars.

Two layers on purpose:

* ``*Draft`` models are what Claude is asked to produce. They carry no
  numeric constraints and no defaults, because the structured-output schema
  sent to the API must stay inside the supported JSON-Schema subset; every
  constraint is enforced afterwards in Python (:mod:`preprocessor`).
* :class:`TTSScript` is what the rest of the system consumes. It adds
  provenance (which backend produced it, whether it is degraded) that the model
  must never be able to set.
"""

from __future__ import annotations

import hashlib
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .ssml import wrap_speak

ReadingLevel = Literal["simple", "very_simple"]
Source = Literal["anthropic", "agent-sdk", "local"]


class VoiceProfileDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gender: Literal["female", "male"]
    rate: float  # relative speaking rate, 1.0 = engine default
    pitch: str  # SSML pitch value such as "+0%", "-5%", "default"
    style: str  # short free-text hint for the client, e.g. "calm", "warm"


class SegmentDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    original: str
    simplified: str
    speech: str
    ssml: str
    pause_after_ms: int
    key_terms: list[str]


class GlossaryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    term: str
    simple_meaning: str
    pronunciation: str


class TTSScriptDraft(BaseModel):
    """Exactly what the model returns. Kept flat and fully required."""

    model_config = ConfigDict(extra="forbid")

    language: str
    title: str
    reading_level: ReadingLevel
    voice: VoiceProfileDraft
    segments: list[SegmentDraft]
    glossary: list[GlossaryEntry]


class VoiceProfile(BaseModel):
    gender: Literal["female", "male"] = "female"
    rate: float = Field(default=0.9, ge=0.5, le=1.5)
    pitch: str = "default"
    style: str = "calm"


class Segment(BaseModel):
    index: int = Field(ge=0)
    original: str
    simplified: str
    speech: str
    ssml: str
    pause_after_ms: int = Field(default=600, ge=0, le=3000)
    key_terms: list[str] = Field(default_factory=list)


class TTSScript(BaseModel):
    language: str
    bcp47: str
    direction: Literal["ltr", "rtl"]
    title: str
    reading_level: ReadingLevel = "simple"
    voice: VoiceProfile = Field(default_factory=VoiceProfile)
    segments: list[Segment]
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    # Provenance, set by the pre-processor only.
    source: Source = "local"
    degraded: bool = False
    warnings: list[str] = Field(default_factory=list)
    text_sha256: str = ""

    @property
    def ssml_document(self) -> str:
        """The whole text as one SSML document, ready for a cloud or on-device engine."""
        return wrap_speak("".join(seg.ssml for seg in self.segments), self.bcp47)

    @property
    def plain_speech(self) -> str:
        return " ".join(seg.speech for seg in self.segments)

    def segment_by_number(self, number: int) -> Segment:
        """1-based access, the way a learner counts ('the third sentence')."""
        if number < 1 or number > len(self.segments):
            raise IndexError(f"sentence number must be between 1 and {len(self.segments)}")
        return self.segments[number - 1]


def text_fingerprint(language: str, reading_level: str, gender: str, text: str) -> str:
    digest = hashlib.sha256()
    for part in (language, reading_level, gender, text):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()
