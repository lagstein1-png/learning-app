import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import anthropic
import httpx2 as httpx
import pytest

from tts_backend.config import Settings
from tts_backend.languages import LANGUAGES
from tts_backend.preprocess import AnthropicBackend, BackendResult, EmptyTextError, LocalBackend, TTSPreprocessor, TTSScriptDraft
from tts_backend.preprocess.backends import LocalBackend as LB
from tts_backend.preprocess.prompts import SYSTEM_PROMPT, build_user_message
from tts_backend.preprocess.schema import VoiceProfile
from tests.conftest import AR_TEXT, EN_TEXT, HE_TEXT


def run(coro):
    return asyncio.run(coro)


class FailingBackend:
    name = "anthropic"

    def __init__(self, exc):
        self.exc = exc

    async def run(self, system, user, language):
        raise self.exc


class DraftBackend:
    """Returns a hand-made model draft, including bad SSML the sanitiser must fix."""

    name = "anthropic"

    def __init__(self):
        self.calls = 0

    async def run(self, system, user, language):
        self.calls += 1
        local = LB().build(user.split("<source_text>")[1].split("</source_text>")[0], language)
        segs = []
        for seg in local.segments:
            seg = seg.model_copy(update={"ssml": f'<s>{seg.speech}<audio src="no"/></s><break time="99s"/>', "key_terms": ["x"]})
            segs.append(seg)
        draft = local.model_copy(update={"segments": segs, "language": "xx", "voice": local.voice.model_copy(update={"rate": 9.0})})
        return BackendResult(draft, self.name, "end_turn", "fake", {"input_tokens": 1})


def test_empty_text_raises(local_preprocessor):
    with pytest.raises(EmptyTextError):
        run(local_preprocessor.prepare("   ", "he"))


def test_local_backend_segments_and_provenance(local_preprocessor):
    script = run(local_preprocessor.prepare(HE_TEXT, "he"))
    assert script.source == "local" and script.degraded is False
    assert script.language == "he" and script.direction == "rtl" and script.bcp47 == "he-IL"
    assert len(script.segments) == 4
    assert all(seg.ssml.startswith("<s>") for seg in script.segments)
    assert script.ssml_document.startswith('<speak version="1.0" xml:lang="he-IL">')
    assert script.segment_by_number(3).index == 2


def test_script_mismatch_switches_language(local_preprocessor):
    script = run(local_preprocessor.prepare(AR_TEXT, "en"))
    assert script.language == "ar"
    assert any("Arabic script" in w for w in script.warnings)


def test_failing_backend_falls_back_and_marks_degraded(settings):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.APIConnectionError(request=request)
    pre = TTSPreprocessor(settings, backend=FailingBackend(exc))
    script = run(pre.prepare(EN_TEXT, "en"))
    assert script.degraded is True and script.source == "local"
    assert any("fallback" in w for w in script.warnings)
    assert len(script.segments) == 4


def test_refusal_result_falls_back(settings):
    class Refusing:
        name = "anthropic"

        async def run(self, system, user, language):
            return BackendResult(None, "anthropic", "refusal", "declined")

    script = run(TTSPreprocessor(settings, backend=Refusing()).prepare(EN_TEXT, "en"))
    assert script.degraded and "declined" in " ".join(script.warnings)


def test_model_draft_is_verified_and_cached(settings):
    backend = DraftBackend()
    pre = TTSPreprocessor(settings, backend=backend)
    script = run(pre.prepare(EN_TEXT, "en"))
    assert script.source == "anthropic" and not script.degraded
    assert all("<audio" not in seg.ssml for seg in script.segments)
    assert all('time="3000ms"' in seg.ssml for seg in script.segments)
    assert script.voice.rate == 1.5, "rate is clamped"
    assert any("labelled the text 'xx'" in w for w in script.warnings)
    again = run(pre.prepare(EN_TEXT, "en"))
    assert backend.calls == 1 and again.segments == script.segments


def test_long_text_is_chunked(settings):
    small = Settings(**{**settings.__dict__, "tts_max_chars": 120})
    backend = DraftBackend()
    pre = TTSPreprocessor(small, backend=backend)
    script = run(pre.prepare(EN_TEXT, "en"))
    assert backend.calls >= 2
    assert [s.index for s in script.segments] == list(range(len(script.segments)))


def test_user_message_contains_language_rules():
    msg = build_user_message("Hi.", LANGUAGES["ar"], "simple", VoiceProfile(), 12)
    assert "tashkeel" in msg and "<source_text>" in msg and '"bcp47": "ar-SA"' in msg
    assert "SSML" in SYSTEM_PROMPT and "glossary" in SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# AnthropicBackend against a fake Messages endpoint: proves the request shape
# (structured output, thinking, caching, fallbacks) and the response parsing
# without a key or network.


class _FakeMessages(BaseHTTPRequestHandler):
    received: list[dict] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        _FakeMessages.received.append({"body": body, "headers": dict(self.headers)})
        text = body["messages"][0]["content"]
        source = text.split("<source_text>")[1].split("</source_text>")[0]
        draft = LB().build(source, LANGUAGES["en"])
        payload = {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [{"type": "text", "text": draft.model_dump_json()}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence
        pass


@pytest.fixture
def fake_api():
    server = HTTPServer(("127.0.0.1", 0), _FakeMessages)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _FakeMessages.received.clear()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_anthropic_backend_request_and_parse(fake_api, settings):
    client = anthropic.AsyncAnthropic(api_key="test-key", base_url=fake_api, max_retries=0)
    backend = AnthropicBackend(client, model="claude-opus-5", effort="medium")
    pre = TTSPreprocessor(settings, backend=backend)
    script = run(pre.prepare(EN_TEXT, "en"))
    assert script.source == "anthropic" and not script.degraded
    assert len(script.segments) == 4

    sent = _FakeMessages.received[-1]
    body = sent["body"]
    assert body["model"] == "claude-opus-5"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["output_config"]["effort"] == "medium"
    assert body["thinking"] == {"type": "adaptive"}
    assert body["fallbacks"] == "default"
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "server-side-fallback-2026-07-01" in sent["headers"].get("anthropic-beta", "")
    assert isinstance(TTSScriptDraft.model_validate_json(body and json.dumps(LB().build("A b.", LANGUAGES["en"]).model_dump())), TTSScriptDraft)
