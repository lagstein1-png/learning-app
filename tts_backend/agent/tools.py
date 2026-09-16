"""The coach's tools: an in-process MCP server built with the Agent SDK.

Every tool is a thin, validated door into :class:`LearningSession`. The coach
cannot read or change state any other way, which keeps the transcript an
honest audit trail of what happened in the lesson. The tools also call the
pre-processing module of Step 2 (``simplify_sentence``), so the coach can
lower the reading level of one sentence on demand.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Coroutine

from claude_agent_sdk import McpSdkServerConfig, SdkMcpTool, create_sdk_mcp_server, tool
from mcp.types import ToolAnnotations

from ..preprocess.preprocessor import TTSPreprocessor
from ..preprocess.schema import Segment
from .state import ComprehensionCheck, LearningSession, SessionStore, WordFlag

SERVER_NAME = "coach"
TOOL_NAMES: tuple[str, ...] = (
    "get_reading_position",
    "get_sentence",
    "simplify_sentence",
    "note_word_explained",
    "ask_check_question",
    "record_check_result",
    "mark_sentence_done",
    "get_progress",
)


def qualified_tool_names() -> list[str]:
    """Names as Claude Code exposes them: mcp__<server>__<tool>."""
    return [f"mcp__{SERVER_NAME}__{name}" for name in TOOL_NAMES]


@dataclass
class CoachContext:
    session: LearningSession
    store: SessionStore
    preprocessor: TTSPreprocessor

    def persist(self) -> None:
        self.store.save(self.session)


def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


def _error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "is_error": True}


def _segment_payload(seg: Segment, session: LearningSession) -> dict[str, Any]:
    glossary = [
        g.model_dump()
        for g in session.script.glossary
        if g.term.lower() in seg.simplified.lower() or g.term.lower() in seg.original.lower()
    ]
    return {
        "number": seg.index + 1,
        "of": session.total,
        "original": seg.original,
        "simplified": seg.simplified,
        "speech": seg.speech,
        "ssml": seg.ssml,
        "key_terms": seg.key_terms,
        "glossary": glossary,
        "done": (seg.index + 1) in session.completed,
    }


def _number_or_error(ctx: CoachContext, raw: Any) -> tuple[int | None, dict[str, Any] | None]:
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None, _error(f"number must be an integer between 1 and {ctx.session.total}")
    if number < 1 or number > ctx.session.total:
        return None, _error(f"sentence number {number} is out of range; the text has {ctx.session.total} sentences")
    return number, None


ReadOnly = ToolAnnotations(read_only_hint=True, idempotent_hint=True)
Mutating = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False)


def build_coach_tools(ctx: CoachContext) -> list[SdkMcpTool[Any]]:
    session = ctx.session

    @tool(
        "get_reading_position",
        "Where the learner is in the text: the current sentence (number, display text and speech text), "
        "the next sentence, and counts. Call this first in every session.",
        {},
        annotations=ReadOnly,
    )
    async def get_reading_position(args: dict[str, Any]) -> dict[str, Any]:
        current = session.current()
        nxt = session.next_sentence()
        return _ok(
            {
                "finished": session.is_finished,
                "current": _segment_payload(current, session) if current else None,
                "next_number": nxt.index + 1 if nxt else None,
                "total": session.total,
                "completed": sorted(set(session.completed)),
                "title": session.script.title,
                "language": session.language,
            }
        )

    @tool(
        "get_sentence",
        "Fetch one sentence by its 1-based number as the learner counts it ('the third sentence' is number 3). "
        "Returns original, simplified, speech and SSML forms plus glossary entries for that sentence.",
        {"number": int},
        annotations=ReadOnly,
    )
    async def get_sentence(args: dict[str, Any]) -> dict[str, Any]:
        number, err = _number_or_error(ctx, args.get("number"))
        if err:
            return err
        assert number is not None
        return _ok(_segment_payload(session.sentence(number), session))

    @tool(
        "simplify_sentence",
        "Rewrite one sentence (1-based number) at the lowest reading level using the text pre-processing engine. "
        "Returns the simpler display text, the speech text and SSML. Use when the learner says a sentence is hard.",
        {"number": int},
        annotations=ReadOnly,
    )
    async def simplify_sentence(args: dict[str, Any]) -> dict[str, Any]:
        number, err = _number_or_error(ctx, args.get("number"))
        if err:
            return err
        assert number is not None
        seg = session.sentence(number)
        script = await ctx.preprocessor.simplify_sentence(seg.simplified, session.language)
        return _ok(
            {
                "number": number,
                "simplified": " ".join(s.simplified for s in script.segments),
                "speech": " ".join(s.speech for s in script.segments),
                "ssml": "".join(s.ssml for s in script.segments),
                "glossary": [g.model_dump() for g in script.glossary],
                "source": script.source,
                "degraded": script.degraded,
            }
        )

    @tool(
        "note_word_explained",
        "Record that you explained a word the learner asked about, with the explanation you gave. "
        "Returns the glossary entry for the word if one exists, so you can add its pronunciation.",
        {"word": str, "number": int, "explanation": str},
        annotations=Mutating,
    )
    async def note_word_explained(args: dict[str, Any]) -> dict[str, Any]:
        number, err = _number_or_error(ctx, args.get("number"))
        if err:
            return err
        assert number is not None
        word = str(args.get("word", "")).strip()
        explanation = str(args.get("explanation", "")).strip()
        if not word:
            return _error("word must not be empty")
        session.flags.append(WordFlag(word=word, sentence_number=number, explanation=explanation))
        ctx.persist()
        entry = next((g.model_dump() for g in session.script.glossary if g.term.lower() == word.lower()), None)
        return _ok({"recorded": True, "word": word, "glossary": entry, "words_asked_so_far": len(session.flags)})

    @tool(
        "ask_check_question",
        "Record the one short comprehension question you are about to ask about a sentence (1-based number). "
        "The question must have a yes/no or one-word answer.",
        {"number": int, "question": str},
        annotations=Mutating,
    )
    async def ask_check_question(args: dict[str, Any]) -> dict[str, Any]:
        number, err = _number_or_error(ctx, args.get("number"))
        if err:
            return err
        assert number is not None
        question = str(args.get("question", "")).strip()
        if not question:
            return _error("question must not be empty")
        pending = session.pending_check()
        if pending is not None:
            pending.outcome = "retry"
        session.checks.append(ComprehensionCheck(sentence_number=number, question=question))
        ctx.persist()
        return _ok({"recorded": True, "number": number, "open_checks": 1})

    @tool(
        "record_check_result",
        "Record the learner's answer to the open comprehension question. outcome is 'understood' or 'retry'.",
        {"outcome": str, "learner_answer": str},
        annotations=Mutating,
    )
    async def record_check_result(args: dict[str, Any]) -> dict[str, Any]:
        outcome = str(args.get("outcome", "")).strip().lower()
        if outcome not in ("understood", "retry"):
            return _error("outcome must be 'understood' or 'retry'")
        pending = session.pending_check()
        if pending is None:
            return _error("there is no open comprehension question; call ask_check_question first")
        pending.learner_answer = str(args.get("learner_answer", "")).strip()
        pending.outcome = outcome  # type: ignore[assignment]
        ctx.persist()
        retries = sum(1 for c in session.checks if c.sentence_number == pending.sentence_number and c.outcome == "retry")
        return _ok({"recorded": True, "number": pending.sentence_number, "outcome": outcome, "retries_on_this_sentence": retries})

    @tool(
        "mark_sentence_done",
        "Mark a sentence (1-based number) as understood and move the reading position forward. "
        "Returns the new position.",
        {"number": int},
        annotations=Mutating,
    )
    async def mark_sentence_done(args: dict[str, Any]) -> dict[str, Any]:
        number, err = _number_or_error(ctx, args.get("number"))
        if err:
            return err
        assert number is not None
        session.mark_done(number)
        ctx.persist()
        nxt = session.current() if not session.is_finished else None
        return _ok(
            {
                "done": sorted(set(session.completed)),
                "finished": session.is_finished,
                "position": session.position,
                "next": _segment_payload(nxt, session) if nxt and nxt.index + 1 != number else None,
            }
        )

    @tool(
        "get_progress",
        "A one-line summary of the session: position, sentences done, checks, recent words asked.",
        {},
        annotations=ReadOnly,
    )
    async def get_progress(args: dict[str, Any]) -> dict[str, Any]:
        return _ok({"summary": session.progress_summary(), "flags": [f.__dict__ for f in session.flags]})

    return [
        get_reading_position,
        get_sentence,
        simplify_sentence,
        note_word_explained,
        ask_check_question,
        record_check_result,
        mark_sentence_done,
        get_progress,
    ]


def build_coach_server(ctx: CoachContext) -> McpSdkServerConfig:
    return create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=build_coach_tools(ctx))


ToolHandler = Callable[[dict[str, Any]], Coroutine[Any, Any, dict[str, Any]]]
