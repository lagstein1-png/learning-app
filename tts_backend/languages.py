"""The four supported languages, and everything the rest of the system needs
to know about them: script, direction, voice preferences and the pronunciation
guidance that goes into the Claude prompt.

Two runtime helpers matter for voice quality more than anything else:

* :func:`detect_script` - a text read by a voice of the wrong language is the
  single most common cause of "robotic" or garbled output. We verify the
  script of the text against the requested language before any TTS work.
* :func:`rank_voices` - the mobile client sends the voices installed on the
  device; we return them in the order the app should try them. Usability
  (right language) is the first key, gender the second, quality the third.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Mapping

Script = str  # "Latin" | "Hebrew" | "Arabic" | "unknown"


class UnsupportedLanguageError(ValueError):
    """Raised for a language code outside the four supported languages."""


@dataclass(frozen=True)
class Language:
    code: str
    bcp47: str
    name_en: str
    name_native: str
    direction: str  # "ltr" | "rtl"
    script: Script
    voice_gender: str  # default preference: "female" | "male"
    voice_hints: tuple[str, ...]  # substrings of well-known voice names, best first
    sentence_terminators: str
    pronunciation_notes: str  # goes verbatim into the pre-processing prompt


LANGUAGES: dict[str, Language] = {
    "en": Language(
        code="en",
        bcp47="en-US",
        name_en="English",
        name_native="English",
        direction="ltr",
        script="Latin",
        voice_gender="female",
        voice_hints=("Samantha", "Ava", "Jenny", "Aria", "Neural2-F", "Wavenet-F", "en-US"),
        sentence_terminators=".!?…",
        pronunciation_notes=(
            "English: expand every abbreviation (e.g. -> for example, Dr. -> Doctor, "
            "St. -> Street or Saint by context). Write numbers, dates, years, money and "
            "units as words the way a teacher reads them aloud ('nineteen ninety-eight', "
            "'three and a half kilometres'). Avoid homograph ambiguity (read/lead/tear) "
            "by rephrasing or with <sub alias='...'>. Respell hard proper nouns with "
            "<sub alias='...'>. Statements end with falling intonation: no trailing "
            "commas, no question marks on statements."
        ),
    ),
    "he": Language(
        code="he",
        bcp47="he-IL",
        name_en="Hebrew",
        name_native="עברית",
        direction="rtl",
        script="Hebrew",
        voice_gender="female",
        voice_hints=("Carmit", "Hila", "Avri", "he-IL"),
        sentence_terminators=".!?…",
        pronunciation_notes=(
            "Hebrew: in the `speech` field add nikud (vowel points) to words that are "
            "ambiguous without it (homographs such as ספר, מלך, שלום in unusual roles), "
            "to foreign names, and to rare words; leave common unambiguous words bare. "
            "Write all numbers as words with correct gender agreement "
            "(שלושה ספרים / שלוש בנות). Expand acronyms that are read letter by letter "
            "(צה\"ל is read as a word; ח\"כ is read חבר כנסת). Wrap English loanwords or "
            "names that must keep English sounds in <lang xml:lang='en-US'>...</lang>. "
            "Keep the `simplified` field without nikud so it matches everyday print, "
            "unless the word is genuinely ambiguous."
        ),
    ),
    "es": Language(
        code="es",
        bcp47="es-ES",
        name_en="Spanish",
        name_native="Español",
        direction="ltr",
        script="Latin",
        voice_gender="female",
        voice_hints=("Mónica", "Monica", "Paulina", "Elvira", "Neural2-A", "es-ES", "es-MX"),
        sentence_terminators=".!?…",
        pronunciation_notes=(
            "Spanish: every written accent must be correct because it changes stress "
            "(esta/está, cómo/como). Write numbers as words with gender agreement "
            "(doscientas personas, veintiún años). Expand abbreviations (Sra. -> señora, "
            "EE. UU. -> Estados Unidos). Keep the opening ¿ and ¡ marks; the TTS uses "
            "them to shape intonation from the first word. Use <say-as "
            "interpret-as='date'> for dates."
        ),
    ),
    "ar": Language(
        code="ar",
        bcp47="ar-SA",
        name_en="Arabic",
        name_native="العربية",
        direction="rtl",
        script="Arabic",
        voice_gender="female",
        voice_hints=("Zariyah", "Salma", "Laila", "Wavenet-A", "ar-XA", "ar-SA", "ar-EG"),
        sentence_terminators=".!?…؟۔",
        pronunciation_notes=(
            "Arabic: use Modern Standard Arabic. In the `speech` field add full tashkeel "
            "(fatha, damma, kasra, sukun, shadda) to every word: unvowelled text is the "
            "main cause of Arabic TTS mispronunciation. Keep the `simplified` field "
            "unvowelled like everyday print. Write all numbers as words with correct "
            "gender and case (ثلاثةُ كتبٍ / ثلاثُ بناتٍ). Write hamza forms explicitly "
            "(أ إ ؤ ئ). Use the Arabic question mark ؟ and comma ، so the engine "
            "detects sentence boundaries."
        ),
    ),
}

_ALIASES: Mapping[str, str] = {
    "iw": "he",  # legacy Hebrew code still emitted by some Android devices
    "heb": "he",
    "eng": "en",
    "spa": "es",
    "ara": "ar",
}

_SCRIPT_TO_LANGUAGE: Mapping[Script, str] = {"Hebrew": "he", "Arabic": "ar"}


def resolve(code: str) -> Language:
    """Map any reasonable language tag ('he', 'he-IL', 'iw', 'es_MX', 'AR') to a Language."""
    if not code or not code.strip():
        raise UnsupportedLanguageError("language code is empty")
    base = re.split(r"[-_]", code.strip().lower())[0]
    base = _ALIASES.get(base, base)
    try:
        return LANGUAGES[base]
    except KeyError as exc:
        raise UnsupportedLanguageError(
            f"unsupported language {code!r}; supported: {', '.join(sorted(LANGUAGES))}"
        ) from exc


def _script_of_char(ch: str) -> Script | None:
    cp = ord(ch)
    if 0x0590 <= cp <= 0x05FF or 0xFB1D <= cp <= 0xFB4F:
        return "Hebrew"
    if (
        0x0600 <= cp <= 0x06FF
        or 0x0750 <= cp <= 0x077F
        or 0x08A0 <= cp <= 0x08FF
        or 0xFB50 <= cp <= 0xFDFF
        or 0xFE70 <= cp <= 0xFEFF
    ):
        return "Arabic"
    if ch.isascii() and ch.isalpha():
        return "Latin"
    if 0x00C0 <= cp <= 0x024F and unicodedata.category(ch).startswith("L"):
        return "Latin"
    return None


def detect_script(text: str) -> Script:
    """Majority script of the letters in ``text``; 'unknown' when there are no letters."""
    counts: dict[Script, int] = {"Latin": 0, "Hebrew": 0, "Arabic": 0}
    for ch in text:
        script = _script_of_char(ch)
        if script:
            counts[script] += 1
    total = sum(counts.values())
    if total == 0:
        return "unknown"
    best = max(counts, key=counts.__getitem__)
    return best if counts[best] * 2 >= total else "unknown"


def language_for_script(script: Script, requested: Language) -> Language:
    """The language a text should be read in, given its script and what was asked for.

    Hebrew and Arabic scripts are unambiguous. Latin script keeps the requested
    language when that language is itself Latin-script (English or Spanish),
    and falls back to English otherwise.
    """
    if script in _SCRIPT_TO_LANGUAGE:
        return LANGUAGES[_SCRIPT_TO_LANGUAGE[script]]
    if script == "Latin":
        return requested if requested.script == "Latin" else LANGUAGES["en"]
    return requested


_QUALITY_WORDS = ("neural", "enhanced", "premium", "natural", "wavenet", "studio", "hd")


def rank_voices(available: Iterable[Mapping[str, str]], language: Language) -> list[dict[str, str]]:
    """Order device voices for ``language``: usable first, then gender, then quality, then hints.

    Each voice is a mapping with ``name``, ``lang`` (BCP-47 tag) and optional
    ``gender``. Voices for other languages are dropped: a wrong-language voice is
    never a fallback, it is the bug we are preventing.
    """
    ranked: list[tuple[tuple[int, int, int, int], dict[str, str]]] = []
    for voice in available:
        tag = (voice.get("lang") or "").replace("_", "-").lower()
        if not tag or resolve_or_none(tag) is not language:
            continue
        name = voice.get("name") or ""
        gender = (voice.get("gender") or "").lower()
        exact_region = 0 if tag == language.bcp47.lower() else 1
        gender_key = 0 if gender == language.voice_gender else (1 if not gender else 2)
        quality_key = 0 if any(w in name.lower() for w in _QUALITY_WORDS) else 1
        hint_key = next(
            (i for i, hint in enumerate(language.voice_hints) if hint.lower() in name.lower()),
            len(language.voice_hints),
        )
        ranked.append(((gender_key, quality_key, hint_key, exact_region), dict(voice)))
    ranked.sort(key=lambda item: item[0])
    return [voice for _, voice in ranked]


def resolve_or_none(code: str) -> Language | None:
    try:
        return resolve(code)
    except UnsupportedLanguageError:
        return None
