import xml.etree.ElementTree as ET

from tts_backend.agent.voice import clean_for_speech, voice_ready
from tts_backend.languages import LANGUAGES


def test_clean_for_speech_removes_markup_and_emojis():
    text = "**Great** work! 🎉\n- first point\n- second (extra) point"
    cleaned = clean_for_speech(text)
    assert "*" not in cleaned and "🎉" not in cleaned and "- " not in cleaned and "(" not in cleaned
    assert "extra" in cleaned


def test_voice_ready_builds_valid_ssml():
    reply = voice_ready("יופי! קראנו את המשפט הראשון. מוכנים להמשיך?", LANGUAGES["he"], rate=0.9)
    assert reply.bcp47 == "he-IL" and len(reply.sentences) == 3
    root = ET.fromstring(reply.ssml)
    assert root.tag == "speak"
    assert reply.ssml.count("<s>") == 3 and 'rate="90%"' in reply.ssml
