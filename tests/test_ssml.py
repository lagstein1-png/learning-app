import xml.etree.ElementTree as ET

from tts_backend.preprocess.ssml import local_ssml, sanitize_ssml, split_sentences, wrap_speak
from tests.conftest import AR_TEXT, EN_TEXT, ES_TEXT, HE_TEXT


def test_split_sentences_four_languages():
    assert len(split_sentences(HE_TEXT)) == 4
    assert len(split_sentences(AR_TEXT)) == 4  # includes the Arabic question mark
    assert len(split_sentences(ES_TEXT)) == 3
    sentences = split_sentences(EN_TEXT)
    assert len(sentences) == 4
    assert "e.g. inside" in sentences[1], "abbreviation must not split a sentence"


def test_split_sentences_paragraphs_and_whitespace():
    assert split_sentences("One\n\nTwo three.\n Four?") == ["One", "Two three.", "Four?"]


def test_local_ssml_escapes_and_pauses():
    frag = local_ssml("Salt & pepper, please", 800, rate=0.9)
    root = ET.fromstring(wrap_speak(frag, "en-US"))
    assert root.tag == "speak"
    assert "&amp;" in frag and "<break time=\"300ms\"/>" in frag and "<break time=\"800ms\"/>" in frag
    assert 'rate="90%"' in frag
    assert frag.count("<s>") == 1


def test_sanitize_keeps_subset_drops_rest():
    raw = '<s>Hello <emphasis level="moderate">world</emphasis><audio src="x.mp3"/> <voice name="A">there</voice></s><break time="9s"/>'
    out = sanitize_ssml(raw, "Hello world there.")
    assert "<audio" not in out and "<voice" not in out
    assert "there" in out and "<emphasis" in out
    assert 'time="3000ms"' in out, "breaks are clamped to 3 seconds"
    ET.fromstring(wrap_speak(out, "en-US"))


def test_sanitize_invalid_xml_falls_back_to_local():
    out = sanitize_ssml("<s>broken <break time=", "Broken sentence.")
    assert out.startswith("<s>Broken sentence.</s>")


def test_sanitize_strips_unknown_attributes_and_speak_wrapper():
    out = sanitize_ssml('<speak><s onclick="x">Hi</s></speak>', "Hi.")
    assert out == "<s>Hi</s>"


def test_sanitize_normalizes_bare_prosody_rate():
    out = sanitize_ssml('<s><prosody rate="0.9">Slow.</prosody></s>', "Slow.")
    assert 'rate="90%"' in out
    assert 'rate="slow"' in sanitize_ssml('<s><prosody rate="slow">Slow.</prosody></s>', "Slow.")
