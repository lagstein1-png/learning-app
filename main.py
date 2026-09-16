#!/usr/bin/env python3
"""End-to-end pipeline: MCP materials -> Claude pre-processing -> Agent SDK coach.

    python main.py                                   # Hebrew sample, auto backend
    python main.py --material en/photosynthesis.md   # English sample
    python main.py --backend local --skip-agent      # fully offline dry run
    python main.py --turn "I don't understand the third sentence." --turn "Thanks, go on."

Every stage prints what it produced, so a run is its own proof.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import textwrap
import time
from pathlib import Path

from tts_backend.agent import CoachError, CoachReply, LearningAgent, LearningSession, SessionStore
from tts_backend.config import Settings, load_settings
from tts_backend.languages import resolve
from tts_backend.mcp_server import MaterialsClient, materials_agent_config
from tts_backend.preprocess import AgentSdkBackend, AnthropicBackend, LocalBackend, TTSPreprocessor, TTSScript

WIDTH = 88


# ------------------------------------------------------------------ printing

def banner(step: int, title: str) -> None:
    print()
    print("=" * WIDTH)
    print(f"  STAGE {step}: {title}")
    print("=" * WIDTH)


def kv(label: str, value: object) -> None:
    text = str(value)
    if len(text) > WIDTH - 22:
        text = textwrap.shorten(text, width=WIDTH - 22, placeholder=" …")
    print(f"  {label:<18} {text}")


def block(label: str, text: str, indent: int = 6) -> None:
    print(f"  {label}")
    for line in textwrap.wrap(text, width=WIDTH - indent - 2) or [""]:
        print(" " * indent + line)


def print_script(script: TTSScript) -> None:
    kv("language", f"{script.language} ({script.bcp47}, {script.direction})")
    kv("title", script.title)
    kv("reading level", script.reading_level)
    kv("voice", script.voice.model_dump())
    kv("source", f"{script.source}{'  [DEGRADED: local normalisation]' if script.degraded else ''}")
    kv("segments", len(script.segments))
    kv("glossary", len(script.glossary))
    for warning in script.warnings:
        kv("warning", warning)
    print()
    for seg in script.segments:
        print(f"  --- sentence {seg.index + 1} of {len(script.segments)} ---")
        block("original:", seg.original)
        block("simplified:", seg.simplified)
        block("speech:", seg.speech)
        block("ssml:", seg.ssml)
        if seg.key_terms:
            kv("key terms", ", ".join(seg.key_terms))
    if script.glossary:
        print()
        print("  --- glossary ---")
        for entry in script.glossary:
            block(f"{entry.term}  [{entry.pronunciation}]", entry.simple_meaning)
    print()
    block("full SSML document (first 600 chars):", script.ssml_document[:600])


def print_reply(who: str, reply: CoachReply) -> None:
    print()
    block(f"{who} says:", reply.text)
    block("voice-ready SSML:", reply.voice.ssml[:400] + (" …" if len(reply.voice.ssml) > 400 else ""))
    kv("tools used", ", ".join(reply.tool_calls) or "none")
    cost = f"${reply.cost_usd:.4f}" if reply.cost_usd is not None else "n/a"
    kv("turn cost / time", f"{cost} / {reply.duration_ms} ms / {reply.num_turns} model turns")


# ------------------------------------------------------------------ pipeline

def make_preprocessor(settings: Settings, backend_name: str, log: list[str]) -> TTSPreprocessor:
    backend = {
        "anthropic": lambda: AnthropicBackend(model=settings.model, effort=settings.preprocess_effort, timeout_s=settings.request_timeout_s),
        "agent-sdk": lambda: AgentSdkBackend(model=settings.model, effort=settings.preprocess_effort),
        "local": lambda: LocalBackend(),
    }[backend_name]()
    return TTSPreprocessor(settings, backend=backend, on_event=log.append)


def default_turns(script: TTSScript) -> list[str]:
    third = script.segments[min(2, len(script.segments) - 1)]
    candidates = third.key_terms or sorted(third.simplified.split(), key=len, reverse=True)
    term = candidates[0].strip(".,;:!?…؟\"'") if candidates else "it"
    return [
        "I don't understand the third sentence.",
        f'What does the word "{term}" mean?',
        "I think I understand now. Let's keep going.",
    ]


async def run(args: argparse.Namespace) -> int:
    settings = load_settings()
    if args.materials_dir:
        settings = Settings(**{**settings.__dict__, "materials_dir": Path(args.materials_dir).resolve()})
    if args.state_dir:
        settings = Settings(**{**settings.__dict__, "state_dir": Path(args.state_dir).resolve()})
    backend_name = args.backend if args.backend != "auto" else settings.resolved_backend
    started = time.time()

    print("Multilingual TTS learning backend, end-to-end run")
    kv("model", settings.model)
    kv("pre-processing", f"{backend_name} (effort {settings.preprocess_effort})")
    kv("coach", f"Claude Agent SDK (effort {settings.coach_effort}, budget ${settings.coach_max_budget_usd:.2f})")
    kv("materials dir", settings.materials_dir)
    kv("state dir", settings.state_dir)

    # Stage 1 ------------------------------------------------------------
    banner(1, "MCP - fetch the learning material")
    async with MaterialsClient(settings.materials_dir) as materials:
        kv("server tools", ", ".join(await materials.tool_names()))
        catalog = await materials.list()
        for item in catalog:
            kv("available", f"{item.path}  [{item.language}]  {item.title}  ({item.char_count} chars)")
        doc = await materials.fetch(args.material)
    kv("fetched", doc.path)
    kv("language", doc.language)
    kv("title", doc.title)
    kv("size", f"{doc.char_count} chars, {doc.word_count} words, sha256 {doc.sha256[:12]}")
    block("text (first 240 chars):", doc.text[:240] + (" …" if len(doc.text) > 240 else ""))

    language_code = args.language or doc.language
    language = resolve(language_code)

    # Stage 2 ------------------------------------------------------------
    banner(2, f"Claude API - pre-process for TTS ({backend_name})")
    events: list[str] = []
    preprocessor = make_preprocessor(settings, backend_name, events)
    t0 = time.time()
    script = await preprocessor.prepare(doc.text, language.code)
    kv("elapsed", f"{time.time() - t0:.1f} s")
    for event in events:
        kv("backend", event)
    print_script(script)
    if args.json:
        Path(args.json).write_text(json.dumps(script.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        kv("script saved", args.json)

    if args.skip_agent:
        banner(3, "Agent SDK - skipped (--skip-agent)")
        kv("total elapsed", f"{time.time() - started:.1f} s")
        return 0

    # Stage 3 ------------------------------------------------------------
    banner(3, "Agent SDK - learning coach session")
    store = SessionStore(settings.state_dir)
    session = LearningSession.new(args.learner_id, script)
    store.save(session)
    kv("session", session.session_id)
    kv("agent session", session.agent_session_id)
    kv("state file", store.path_for(session.session_id))

    turns = args.turn or default_turns(script)
    total_cost = 0.0
    try:
        async with LearningAgent(
            session, store, preprocessor, settings, materials_server=materials_agent_config(settings.materials_dir)
        ) as coach:
            reply = await coach.start()
            print_reply("Coach", reply)
            total_cost += reply.cost_usd or 0.0
            for text in turns:
                print()
                block("Learner says:", text)
                reply = await coach.send(text)
                print_reply("Coach", reply)
                total_cost += reply.cost_usd or 0.0
    except CoachError as exc:
        print(f"\n  coach error: {exc}")
        for detail in exc.details:
            print(f"    {detail}")
        return 2

    print()
    print("  --- session state after the conversation ---")
    kv("progress", session.progress_summary())
    kv("words asked", [f.word for f in session.flags] or "none")
    kv("checks", [(c.sentence_number, c.outcome) for c in session.checks] or "none")
    kv("turns stored", len(session.turns))
    kv("session cost", f"${total_cost:.4f}")
    kv("total elapsed", f"{time.time() - started:.1f} s")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--material", default="he/water-cycle.md", help="path relative to the materials root")
    parser.add_argument("--language", default=None, help="override the document's language (en, he, es, ar)")
    parser.add_argument("--backend", default="auto", choices=("auto", "anthropic", "agent-sdk", "local"))
    parser.add_argument("--learner-id", default="demo-learner")
    parser.add_argument("--materials-dir", default=None)
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--turn", action="append", help="learner line for the simulated conversation (repeatable)")
    parser.add_argument("--skip-agent", action="store_true", help="stop after pre-processing")
    parser.add_argument("--json", default=None, help="write the TTS script to this JSON file")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
