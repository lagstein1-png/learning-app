"""Three ways to obtain a :class:`TTSScriptDraft`, behind one interface.

* :class:`AnthropicBackend` - the Claude API through the official ``anthropic``
  SDK: structured output, adaptive thinking, prompt caching and server-side
  refusal fallbacks. This is the production path.
* :class:`AgentSdkBackend` - the same prompt through the Claude Agent SDK. It
  needs no API key on a machine that is logged in to Claude Code, which is how
  developers and CI run the pipeline locally.
* :class:`LocalBackend` - deterministic, no network. It never fails, and it is
  the floor every other backend falls back to.

A backend returns a draft or ``None``; it raises only for transport-level
failures. The pre-processor decides what to do with either outcome.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import anthropic

from ..languages import Language
from .schema import GlossaryEntry, SegmentDraft, TTSScriptDraft, VoiceProfile, VoiceProfileDraft
from .ssml import ensure_terminal_punctuation, local_ssml, split_sentences


@dataclass
class BackendResult:
    draft: TTSScriptDraft | None
    source: str
    stop_reason: str | None = None
    detail: str = ""
    usage: dict[str, int | float] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.draft is not None


@runtime_checkable
class PreprocessBackend(Protocol):
    name: str

    async def run(self, system: str, user: str, language: Language) -> BackendResult: ...


class AnthropicBackend:
    """Claude API via ``anthropic.AsyncAnthropic``."""

    name = "anthropic"

    def __init__(
        self,
        client: anthropic.AsyncAnthropic | None = None,
        *,
        model: str = "claude-opus-5",
        effort: str = "medium",
        max_tokens: int = 16000,
        timeout_s: float = 120.0,
    ) -> None:
        self.client = client or anthropic.AsyncAnthropic(timeout=timeout_s)
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens

    async def run(self, system: str, user: str, language: Language) -> BackendResult:
        response = await self.client.beta.messages.parse(
            model=self.model,
            max_tokens=self.max_tokens,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
            output_format=TTSScriptDraft,
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "cache_read_input_tokens": response.usage.cache_read_input_tokens or 0,
            "cache_creation_input_tokens": response.usage.cache_creation_input_tokens or 0,
        }
        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            explanation = getattr(details, "explanation", None) or "request declined"
            return BackendResult(None, self.name, "refusal", explanation, usage)
        if response.stop_reason == "max_tokens":
            return BackendResult(None, self.name, "max_tokens", "output truncated", usage)
        parsed = response.parsed_output
        if parsed is None:
            return BackendResult(None, self.name, response.stop_reason, "no parsed output", usage)
        return BackendResult(parsed, self.name, response.stop_reason, response.model, usage)


class AgentSdkBackend:
    """The same prompt, executed by the Claude Agent SDK with structured output.

    One turn, no tools, a fresh session id per call so nothing is written into
    any other session's transcript.
    """

    name = "agent-sdk"

    def __init__(self, *, model: str = "claude-opus-5", effort: str = "medium", max_budget_usd: float = 1.0) -> None:
        self.model = model
        self.effort = effort
        self.max_budget_usd = max_budget_usd

    async def run(self, system: str, user: str, language: Language) -> BackendResult:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        stderr_lines: list[str] = []
        options = ClaudeAgentOptions(
            system_prompt=system,
            tools=[],
            # Structured output is delivered through a synthetic tool call, which
            # counts as a turn; one turn is not enough and fails with max_turns.
            max_turns=3,
            model=self.model,
            effort=self.effort,  # type: ignore[arg-type]
            max_budget_usd=self.max_budget_usd,
            session_id=str(uuid.uuid4()),
            output_format={"type": "json_schema", "schema": TTSScriptDraft.model_json_schema()},
            stderr=stderr_lines.append,
        )
        result: ResultMessage | None = None
        async for message in query(prompt=user, options=options):
            if isinstance(message, ResultMessage):
                result = message
        if result is None:
            return BackendResult(None, self.name, None, "no result message; " + " ".join(stderr_lines)[-400:])
        usage = {"total_cost_usd": result.total_cost_usd or 0.0, "num_turns": result.num_turns}
        if result.is_error:
            errors = "; ".join(result.errors or []) or result.result or "unknown error"
            return BackendResult(None, self.name, result.stop_reason, errors, usage)
        if result.stop_reason == "refusal":
            return BackendResult(None, self.name, "refusal", result.result or "request declined", usage)
        if not result.structured_output:
            return BackendResult(None, self.name, result.stop_reason, "no structured output", usage)
        draft = TTSScriptDraft.model_validate(result.structured_output)
        return BackendResult(draft, self.name, result.stop_reason, self.model, usage)


class LocalBackend:
    """Deterministic normalisation with no model: sentence split, punctuation pauses.

    It does not simplify and does not add pronunciation marks; it guarantees
    that a learner always hears the text, cleanly segmented, whatever happens
    upstream.
    """

    name = "local"

    def __init__(self, voice: VoiceProfile | None = None, pause_after_ms: int = 600) -> None:
        self.voice = voice or VoiceProfile()
        self.pause_after_ms = pause_after_ms

    def build(self, text: str, language: Language, reading_level: str = "simple") -> TTSScriptDraft:
        sentences = split_sentences(text) or [text.strip()]
        segments = [
            SegmentDraft(
                index=i,
                original=sentence,
                simplified=sentence,
                speech=ensure_terminal_punctuation(sentence),
                ssml=local_ssml(sentence, self.pause_after_ms),
                pause_after_ms=self.pause_after_ms,
                key_terms=[],
            )
            for i, sentence in enumerate(sentences)
        ]
        first_words = sentences[0].split()[:6]
        title = " ".join(first_words).rstrip(".,;:!?…؟") or language.name_native
        return TTSScriptDraft(
            language=language.code,
            title=title,
            reading_level=reading_level,  # type: ignore[arg-type]
            voice=VoiceProfileDraft(**self.voice.model_dump()),
            segments=segments,
            glossary=[],
        )

    async def run(self, system: str, user: str, language: Language) -> BackendResult:
        # The user message carries the text between markers; extract it without
        # re-parsing the JSON header.
        start = user.find("<source_text>")
        end = user.rfind("</source_text>")
        text = user[start + len("<source_text>") : end] if start != -1 and end != -1 else user
        await asyncio.sleep(0)  # keep the interface honest: this is an awaitable backend
        return BackendResult(self.build(text, language), self.name, "end_turn", "local")


__all__ = [
    "AgentSdkBackend",
    "AnthropicBackend",
    "BackendResult",
    "GlossaryEntry",
    "LocalBackend",
    "PreprocessBackend",
]
