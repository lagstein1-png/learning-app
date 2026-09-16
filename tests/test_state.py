import asyncio

import pytest

from tts_backend.agent import LearningSession, SessionStore
from tests.conftest import HE_TEXT


def make_session(local_preprocessor):
    script = asyncio.run(local_preprocessor.prepare(HE_TEXT, "he"))
    return LearningSession.new("learner-1", script)


def test_navigation_and_summary(local_preprocessor):
    s = make_session(local_preprocessor)
    assert s.total == 4 and s.position == 1 and not s.is_finished
    assert s.current().index == 0 and s.next_sentence().index == 1
    s.mark_done(1)
    assert s.position == 2 and s.completed == [1]
    s.mark_done(3)  # skipping ahead is allowed; position follows the furthest sentence
    assert s.position == 4
    s.mark_done(4)
    assert not s.is_finished, "sentence two was skipped, so the text is not finished"
    assert s.position == 4 and s.current().index == 3
    s.mark_done(2)
    assert s.is_finished and s.position == 4
    assert "finished" in s.progress_summary()
    with pytest.raises(IndexError):
        s.mark_done(9)


def test_store_roundtrip(local_preprocessor, tmp_path):
    store = SessionStore(tmp_path / "state")
    s = make_session(local_preprocessor)
    s.mark_done(1)
    path = store.save(s)
    assert path.is_file() and store.exists(s.session_id)
    loaded = store.load(s.session_id)
    assert loaded.to_dict() == s.to_dict()
    assert loaded.script.segments[0].ssml == s.script.segments[0].ssml
    assert store.list_ids() == [s.session_id]


def test_ids_are_validated(local_preprocessor, tmp_path):
    script = asyncio.run(local_preprocessor.prepare(HE_TEXT, "he"))
    with pytest.raises(ValueError):
        LearningSession.new("../evil", script)
    with pytest.raises(ValueError):
        SessionStore(tmp_path).path_for("a/b")
