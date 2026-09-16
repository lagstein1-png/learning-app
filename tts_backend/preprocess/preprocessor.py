"""The pre-processing orchestrator: validate, route, verify, fall back, cache.

Guarantees to callers:

* :meth:`TTSPreprocessor.prepare` never raises for a model or network problem.
  It returns a script, and says on the script (``source``, ``degraded``,
  ``warnings``) how it was produced.
* The returned SSML is always well-formed and inside the supported subset.
* Sentence coverage is checked: a model that silently dropped part of the
  text is recorded as a warning, never trusted blindly.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Awaitable, Callable

import anthropic
from pydantic import ValidationError

from ..config import Settings
from ..languages import Language, detect_script, language_for_script, resolve
from .backends import AgentSdkBackend, AnthropicBackend, BackendResult, LocalBackend, PreprocessBackend
from .prompts import SYSTEM_PROMPT, build_user_message
from .schema import GlossaryEntry, ReadingLevel, Segment, TTSScript, TTSScriptDraft, VoiceProfile, text_fingerprint
from .ssml import sanitize_ssml, split_sentences

log = logging.getLogger(__name__)

MAX_WORDS_PER_SENTENCE = {"simple": 12, "very_simple": 8}
COVERAGE_WARNING_RATIO = 0.7


class EmptyTextError(ValueError):
    """Raised when there is nothing to read."""


def _transport_errors() -> tuple[type[BaseException], ...]:
    """Everything that means 'the model could not be reached or did not answer'."""
    errors: list[type[BaseException]] = [
        anthropic.APIConnectionError,
        anthropic.APITimeoutError,
        anthropic.APIStatusError,
        ValidationError,
        TimeoutError,
    ]
    try:
        from claude_agent_sdk import ClaudeSDKError

        errors.append(ClaudeSDKError)
    except ImportError:  # pragma: no cover - the SDK is a hard dependency
        pass
    return tuple(errors)


class TTSPreprocessor:
    def __init__(
        self,
        settings: Settings,
        backend: PreprocessBackend | None = None,
        *,
        fallback: LocalBackend | None = None,
        cache_size: int = 256,
        on_event: Callable[[str], None] | None = None,
    ) -> None:
        self.settings = settings
        self.backend = backend if backend is not None else self._default_backend(settings)
        self.fallback = fallback or LocalBackend()
        self._cache: OrderedDict[str, TTSScript] = OrderedDict()
        self._cache_size = cache_size
        self._on_event = on_event or (lambda msg: None)

    @staticmethod
    def _default_backend(settings: Settings) -> PreprocessBackend:
        choice = settings.resolved_backend
        if choice == "anthropic":
            return AnthropicBackend(
                model=settings.model, effort=settings.preprocess_effort, timeout_s=settings.request_timeout_s
            )
        if choice == "agent-sdk":
            return AgentSdkBackend(model=settings.model, effort=settings.preprocess_effort)
        return LocalBackend()

    # ------------------------------------------------------------------ public

    async def prepare(
        self,
        text: str,
        language_code: str,
        *,
        reading_level: ReadingLevel = "simple",
        voice: VoiceProfile | None = None,
    ) -> TTSScript:
        if not text or not text.strip():
            raise EmptyTextError("text is empty")
        requested = resolve(language_code)
        voice = voice or VoiceProfile(gender=requested.voice_gender)  # type: ignore[arg-type]
        warnings: list[str] = []

        script = detect_script(text)
        language = language_for_script(script, requested)
        if language is not requested:
            warnings.append(
                f"text is written in {script} script; reading it as {language.code} instead of {requested.code}"
            )
        if script == "unknown":
            warnings.append("could not determine the script of the text; using the requested language")

        key = text_fingerprint(language.code, reading_level, voice.gender, text)
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cached.model_copy(deep=True)

        chunks = self._chunk(text, self.settings.tts_max_chars)
        drafts: list[TTSScriptDraft] = []
        source = self.backend.name
        degraded = False
        for chunk in chunks:
            result = await self._run_with_fallback(chunk, language, reading_level, voice)
            if result.source == self.fallback.name and self.backend.name != self.fallback.name:
                degraded = True
                source = self.fallback.name
                warnings.append(f"fallback to local normalisation: {result.detail}")
            assert result.draft is not None  # the fallback always produces a draft
            drafts.append(result.draft)

        merged = self._merge(drafts)
        script_obj = self._finalize(merged, language, source, degraded, warnings, key, text)
        self._remember(key, script_obj)
        return script_obj.model_copy(deep=True)

    async def simplify_sentence(self, sentence: str, language_code: str) -> TTSScript:
        """A single sentence at the lowest reading level: used by the coach on demand."""
        return await self.prepare(sentence, language_code, reading_level="very_simple")

    # ---------------------------------------------------------------- internals

    async def _run_with_fallback(
        self, text: str, language: Language, reading_level: str, voice: VoiceProfile
    ) -> BackendResult:
        user = build_user_message(text, language, reading_level, voice, MAX_WORDS_PER_SENTENCE[reading_level])
        if self.backend.name == self.fallback.name:
            return await self.fallback.run(SYSTEM_PROMPT, user, language)
        try:
            result = await self.backend.run(SYSTEM_PROMPT, user, language)
        except anthropic.AuthenticationError as exc:
            result = BackendResult(None, self.backend.name, None, f"authentication failed: {exc.message}")
        except anthropic.PermissionDeniedError as exc:
            result = BackendResult(None, self.backend.name, None, f"permission denied: {exc.message}")
        except anthropic.NotFoundError as exc:
            result = BackendResult(None, self.backend.name, None, f"model not found: {exc.message}")
        except anthropic.BadRequestError as exc:
            result = BackendResult(None, self.backend.name, None, f"bad request: {exc.message}")
        except anthropic.RateLimitError as exc:
            retry_after = exc.response.headers.get("retry-after", "?") if exc.response is not None else "?"
            result = BackendResult(None, self.backend.name, None, f"rate limited (retry after {retry_after}s)")
        except _transport_errors() as exc:
            result = BackendResult(None, self.backend.name, None, f"{type(exc).__name__}: {str(exc)[:200]}")
        if result.ok:
            self._on_event(f"{self.backend.name}: ok ({result.stop_reason}) usage={result.usage}")
            return result
        self._on_event(f"{self.backend.name}: failed -> local fallback ({result.detail})")
        log.warning("pre-processing backend %s failed: %s", self.backend.name, result.detail)
        fallback = await self.fallback.run(SYSTEM_PROMPT, user, language)
        fallback.detail = result.detail
        return fallback

    @staticmethod
    def _chunk(text: str, max_chars: int) -> list[str]:
        text = text.strip()
        if len(text) <= max_chars:
            return [text]
        chunks: list[str] = []
        current: list[str] = []
        size = 0
        for sentence in split_sentences(text):
            if current and size + len(sentence) + 1 > max_chars:
                chunks.append(" ".join(current))
                current, size = [], 0
            current.append(sentence)
            size += len(sentence) + 1
        if current:
            chunks.append(" ".join(current))
        return chunks

    @staticmethod
    def _merge(drafts: list[TTSScriptDraft]) -> TTSScriptDraft:
        if len(drafts) == 1:
            return drafts[0]
        head = drafts[0]
        segments = []
        glossary: list[GlossaryEntry] = []
        for draft in drafts:
            segments.extend(draft.segments)
            glossary.extend(draft.glossary)
        merged = head.model_copy(update={"segments": segments, "glossary": glossary})
        return merged

    def _finalize(
        self,
        draft: TTSScriptDraft,
        language: Language,
        source: str,
        degraded: bool,
        warnings: list[str],
        key: str,
        original_text: str,
    ) -> TTSScript:
        voice = VoiceProfile(
            gender=draft.voice.gender,
            rate=min(max(draft.voice.rate, 0.5), 1.5),
            pitch=(draft.voice.pitch or "default")[:16],
            style=(draft.voice.style or "calm")[:32],
        )
        segments: list[Segment] = []
        seen_glossary: set[str] = set()
        for position, seg in enumerate(sorted(draft.segments, key=lambda s: s.index)):
            simplified = " ".join(seg.simplified.split()) or " ".join(seg.original.split())
            speech = " ".join(seg.speech.split()) or simplified
            if not speech:
                continue
            pause = min(max(int(seg.pause_after_ms), 0), 3000)
            ssml = sanitize_ssml(seg.ssml, speech, pause)
            segments.append(
                Segment(
                    index=position,
                    original=" ".join(seg.original.split()) or simplified,
                    simplified=simplified,
                    speech=speech,
                    ssml=ssml,
                    pause_after_ms=pause,
                    key_terms=[t.strip() for t in seg.key_terms if t.strip()][:3],
                )
            )
        if not segments:
            warnings.append("model returned no usable segments; using local normalisation")
            local = self.fallback.build(original_text, language)
            return self._finalize(local, language, self.fallback.name, True, warnings, key, original_text)

        glossary: list[GlossaryEntry] = []
        for entry in draft.glossary:
            term = entry.term.strip()
            if term and term.lower() not in seen_glossary:
                seen_glossary.add(term.lower())
                glossary.append(GlossaryEntry(term=term, simple_meaning=entry.simple_meaning.strip(), pronunciation=entry.pronunciation.strip()))

        source_sentences = len(split_sentences(original_text)) or 1
        if len(segments) < source_sentences * COVERAGE_WARNING_RATIO:
            warnings.append(
                f"coverage: {len(segments)} segments for {source_sentences} source sentences; check for dropped content"
            )
        if draft.language and draft.language.split("-")[0].lower() != language.code:
            warnings.append(f"model labelled the text {draft.language!r}; keeping {language.code}")

        return TTSScript(
            language=language.code,
            bcp47=language.bcp47,
            direction=language.direction,  # type: ignore[arg-type]
            title=" ".join(draft.title.split())[:120] or language.name_native,
            reading_level=draft.reading_level,
            voice=voice,
            segments=segments,
            glossary=glossary,
            source=source,  # type: ignore[arg-type]
            degraded=degraded,
            warnings=warnings,
            text_sha256=key,
        )

    def _remember(self, key: str, script: TTSScript) -> None:
        self._cache[key] = script
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


RunFn = Callable[[str, str, Language], Awaitable[BackendResult]]
