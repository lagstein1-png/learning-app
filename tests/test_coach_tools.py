import asyncio
import json

from tts_backend.agent import LearningSession, SessionStore
from tts_backend.agent.tools import CoachContext, TOOL_NAMES, build_coach_server, build_coach_tools, qualified_tool_names
from tests.conftest import HE_TEXT


def run(coro):
    return asyncio.run(coro)


def _ctx(local_preprocessor, tmp_path):
    script = run(local_preprocessor.prepare(HE_TEXT, "he"))
    session = LearningSession.new("learner-2", script)
    store = SessionStore(tmp_path / "state")
    store.save(session)
    return CoachContext(session=session, store=store, preprocessor=local_preprocessor)


def _handlers(ctx):
    return {t.name: t.handler for t in build_coach_tools(ctx)}


def _data(result):
    assert not result.get("is_error"), result
    return json.loads(result["content"][0]["text"])


def test_tool_registry_matches_server(local_preprocessor, tmp_path):
    ctx = _ctx(local_preprocessor, tmp_path)
    tools = build_coach_tools(ctx)
    assert tuple(t.name for t in tools) == TOOL_NAMES
    assert qualified_tool_names()[0] == "mcp__coach__get_reading_position"
    cfg = build_coach_server(ctx)
    assert cfg["type"] == "sdk" and cfg["name"] == "coach"


def test_reading_flow_persists(local_preprocessor, tmp_path):
    ctx = _ctx(local_preprocessor, tmp_path)
    h = _handlers(ctx)
    pos = _data(run(h["get_reading_position"]({})))
    assert pos["current"]["number"] == 1 and pos["total"] == 4 and pos["next_number"] == 2

    third = _data(run(h["get_sentence"]({"number": 3})))
    assert third["number"] == 3 and third["speech"].startswith("אדי המים")

    simpler = _data(run(h["simplify_sentence"]({"number": 3})))
    assert simpler["source"] == "local" and simpler["ssml"].startswith("<s>")

    noted = _data(run(h["note_word_explained"]({"word": "מתעבים", "number": 3, "explanation": "הופכים מאדים לטיפות"})))
    assert noted["recorded"] and noted["words_asked_so_far"] == 1

    asked = _data(run(h["ask_check_question"]({"number": 3, "question": "האם אדים הופכים לטיפות?"})))
    assert asked["recorded"]
    recorded = _data(run(h["record_check_result"]({"outcome": "understood", "learner_answer": "כן"})))
    assert recorded["outcome"] == "understood"

    done = _data(run(h["mark_sentence_done"]({"number": 3})))
    assert 3 in done["done"] and done["position"] == 4 and done["next"]["number"] == 4

    reloaded = ctx.store.load(ctx.session.session_id)
    assert reloaded.flags[0].word == "מתעבים"
    assert reloaded.checks[0].outcome == "understood"
    assert reloaded.completed == [3]
    summary = _data(run(h["get_progress"]({})))["summary"]
    assert "sentence 4 of 4" in summary


def test_tool_errors_are_reported_not_raised(local_preprocessor, tmp_path):
    h = _handlers(_ctx(local_preprocessor, tmp_path))
    bad = run(h["get_sentence"]({"number": 42}))
    assert bad["is_error"] and "out of range" in bad["content"][0]["text"]
    bad = run(h["record_check_result"]({"outcome": "understood", "learner_answer": "x"}))
    assert bad["is_error"] and "ask_check_question" in bad["content"][0]["text"]
    bad = run(h["record_check_result"]({"outcome": "maybe", "learner_answer": "x"}))
    assert bad["is_error"]
    bad = run(h["note_word_explained"]({"word": "  ", "number": 1, "explanation": "x"}))
    assert bad["is_error"]
