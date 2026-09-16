"""SSML helpers shared by the Claude backend, the local fallback and the coach.

Design rule: the model *proposes* SSML, this module *decides* what reaches the
TTS engine. Mobile engines (AVSpeechSynthesizer, Android TextToSpeech, and the
cloud voices behind them) support only a small, common subset; an unknown tag
is read aloud as text by some engines, which is worse than no markup at all.
Everything outside :data:`ALLOWED_TAGS` is unwrapped and its text kept.
"""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from typing import Iterable

ALLOWED_TAGS: frozenset[str] = frozenset(
    {"speak", "p", "s", "break", "prosody", "emphasis", "say-as", "sub", "lang", "phoneme"}
)
ALLOWED_ATTRS: dict[str, frozenset[str]] = {
    "speak": frozenset({"version", "xml:lang", "xmlns"}),
    "break": frozenset({"time", "strength"}),
    "prosody": frozenset({"rate", "pitch", "volume"}),
    "emphasis": frozenset({"level"}),
    "say-as": frozenset({"interpret-as", "format", "detail"}),
    "sub": frozenset({"alias"}),
    "lang": frozenset({"xml:lang"}),
    "phoneme": frozenset({"alphabet", "ph"}),
}
MAX_BREAK_MS = 3000
_XML_NS = "{http://www.w3.org/XML/1998/namespace}"

# Sentence boundaries: Latin terminators, ellipsis, Arabic question mark and full stop.
_TERMINATORS = ".!?…؟۔"
_SPLIT_RE = re.compile(r"(?<=[" + re.escape(_TERMINATORS) + r"])[\"'”’»)]*\s+")
_ABBREVIATIONS = (
    "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "e.g.", "i.e.", "etc.", "vs.",
    "sr.", "sra.", "srta.", "ee. uu.", "núm.", "pág.",
)


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for all four languages without an NLP dependency.

    Paragraph breaks always split. Inside a paragraph we split after a terminator
    followed by whitespace, then re-join pieces that ended on a known abbreviation.
    """
    sentences: list[str] = []
    for paragraph in re.split(r"\n\s*\n|\n", text):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue
        pieces = [p.strip() for p in _SPLIT_RE.split(paragraph) if p.strip()]
        merged: list[str] = []
        for piece in pieces:
            if merged and merged[-1].lower().endswith(_ABBREVIATIONS):
                merged[-1] = f"{merged[-1]} {piece}"
            else:
                merged.append(piece)
        sentences.extend(merged)
    return sentences


def ensure_terminal_punctuation(sentence: str) -> str:
    stripped = sentence.rstrip()
    if not stripped:
        return stripped
    return stripped if stripped[-1] in _TERMINATORS + "\"'”’»)" else stripped + "."


def local_ssml(sentence: str, pause_after_ms: int = 600, rate: float | None = None) -> str:
    """Deterministic SSML for one sentence: pauses driven only by punctuation."""
    text = ensure_terminal_punctuation(" ".join(sentence.split()))
    escaped = html.escape(text, quote=False)
    # Breath pauses at clause punctuation; the engine's own sentence pause is too short
    # for learners who need time to process each clause.
    escaped = re.sub(r"([,;:،])\s+", r'\1 <break time="300ms"/> ', escaped)
    escaped = re.sub(r"\s+[–—-]\s+", ' <break time="300ms"/> ', escaped)
    body = f"<s>{escaped}</s>"
    if rate is not None and abs(rate - 1.0) > 1e-9:
        body = f'<prosody rate="{int(round(rate * 100))}%">{body}</prosody>'
    pause = max(0, min(int(pause_after_ms), MAX_BREAK_MS))
    if pause:
        body += f'<break time="{pause}ms"/>'
    return body


def wrap_speak(inner: str, bcp47: str) -> str:
    return f'<speak version="1.0" xml:lang="{bcp47}">{inner}</speak>'


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if tag.startswith("{") else tag


def _attr_name(name: str) -> str:
    return "xml:lang" if name == f"{_XML_NS}lang" else name


def _serialize(node: ET.Element) -> str:
    """Serialize a sanitised element tree back to an SSML fragment."""
    tag = _strip_ns(node.tag)
    parts: list[str] = []
    if tag != "speak":
        attrs = "".join(
            f' {name}="{html.escape(value, quote=True)}"'
            for name, value in ((_attr_name(k), v) for k, v in node.attrib.items())
        )
        parts.append(f"<{tag}{attrs}")
        if len(node) == 0 and not (node.text or "").strip():
            parts.append("/>")
            parts.append(html.escape(node.tail or "", quote=False))
            return "".join(parts)
        parts.append(">")
    parts.append(html.escape(node.text or "", quote=False))
    for child in node:
        parts.append(_serialize(child))
    if tag != "speak":
        parts.append(f"</{tag}>")
    parts.append(html.escape(node.tail or "", quote=False))
    return "".join(parts)


def _unwrap(parent: ET.Element, index: int, child: ET.Element) -> None:
    """Replace ``child`` by its text and children, keeping document order."""
    prev = parent[index - 1] if index > 0 else None
    text = child.text or ""
    if prev is not None:
        prev.tail = (prev.tail or "") + text
    else:
        parent.text = (parent.text or "") + text
    grandchildren = list(child)
    parent.remove(child)
    for offset, grandchild in enumerate(grandchildren):
        parent.insert(index + offset, grandchild)
    tail = child.tail or ""
    if grandchildren:
        grandchildren[-1].tail = (grandchildren[-1].tail or "") + tail
    elif prev is not None:
        prev.tail = (prev.tail or "") + tail
    else:
        parent.text = (parent.text or "") + tail


def _sanitize_node(node: ET.Element) -> None:
    for index in range(len(node) - 1, -1, -1):
        child = node[index]
        tag = _strip_ns(child.tag)
        if tag not in ALLOWED_TAGS or tag == "speak":
            _sanitize_node(child)
            _unwrap(node, index, child)
            continue
        allowed = ALLOWED_ATTRS.get(tag, frozenset())
        for name in list(child.attrib):
            if _attr_name(name) not in allowed:
                del child.attrib[name]
        if tag == "break" and "time" in child.attrib:
            child.attrib["time"] = _clamp_time(child.attrib["time"])
        if tag == "prosody" and "rate" in child.attrib:
            child.attrib["rate"] = _normalize_rate(child.attrib["rate"])
        _sanitize_node(child)


def _normalize_rate(value: str) -> str:
    """Bare multipliers ('0.9') become percentages ('90%'); named and % values pass through."""
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*", value)
    if match:
        return f"{int(round(float(match.group(1)) * 100))}%"
    return value.strip()


def _clamp_time(value: str) -> str:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*", value)
    if not match:
        return "300ms"
    amount, unit = float(match.group(1)), match.group(2)
    ms = amount * 1000 if unit == "s" else amount
    return f"{int(min(max(ms, 0), MAX_BREAK_MS))}ms"


def sanitize_ssml(fragment: str, fallback_text: str, pause_after_ms: int = 600) -> str:
    """Return a fragment that only uses the supported subset, or a local rendering.

    A fragment that is not well-formed XML is discarded entirely: a half-parsed
    tag read aloud ("less than break") is the failure mode we refuse to ship.
    """
    candidate = fragment.strip()
    if not candidate:
        return local_ssml(fallback_text, pause_after_ms)
    if candidate.startswith("<speak"):
        wrapped = candidate
    else:
        wrapped = f'<speak xmlns:xml="http://www.w3.org/XML/1998/namespace">{candidate}</speak>'
    try:
        root = ET.fromstring(wrapped)
    except ET.ParseError:
        return local_ssml(fallback_text, pause_after_ms)
    _sanitize_node(root)
    result = _serialize(root).strip()
    if not "".join(root.itertext()).strip():
        return local_ssml(fallback_text, pause_after_ms)
    return result


def join_fragments(fragments: Iterable[str]) -> str:
    return "".join(fragments)
