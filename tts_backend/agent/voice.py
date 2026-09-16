"""Turn a coach reply into something the device can speak immediately.

The coach is instructed to write in short, punctuated, markup-free sentences,
so its replies do not need a second model call to become speakable. This
module strips anything that would be read aloud as noise and builds the SSML
deterministically with the same rules the local pre-processing fallback uses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..languages import Language
from ..preprocess.ssml import local_ssml, split_sentences, wrap_speak

_MARKUP = re.compile(r"[*_`#>|]+")
_BULLET = re.compile(r"^\s*(?:[-•*]|\d+[.)])\s+", re.MULTILINE)
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U0000FE0F]",
)


@dataclass
class VoiceReply:
    text: str
    sentences: list[str]
    ssml: str
    bcp47: str
    pause_after_ms: int = 700
    rate: float = 0.9
    extra: dict[str, str] = field(default_factory=dict)


def clean_for_speech(text: str) -> str:
    text = _BULLET.sub("", text)
    text = _MARKUP.sub("", text)
    text = _EMOJI.sub("", text)
    text = re.sub(r"\((.*?)\)", r", \1,", text)
    text = re.sub(r"\s+,", ",", text)
    return " ".join(text.split())


def voice_ready(text: str, language: Language, *, rate: float = 0.9, pause_after_ms: int = 700) -> VoiceReply:
    cleaned = clean_for_speech(text)
    sentences = split_sentences(cleaned) or ([cleaned] if cleaned else [])
    fragments = [local_ssml(s, pause_after_ms, rate) for s in sentences]
    return VoiceReply(
        text=cleaned,
        sentences=sentences,
        ssml=wrap_speak("".join(fragments), language.bcp47),
        bcp47=language.bcp47,
        pause_after_ms=pause_after_ms,
        rate=rate,
    )
