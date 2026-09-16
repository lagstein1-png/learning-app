from tts_backend.agent.prompts import render_coach_prompt
from tts_backend.languages import LANGUAGES


def test_coach_prompt_carries_voice_gender_and_language():
    prompt = render_coach_prompt(LANGUAGES["he"], "מחזור המים", 16, "on sentence 1 of 16", voice_gender="female")
    assert "Your voice is female." in prompt
    assert "Speak in Hebrew." in prompt
    assert '"מחזור המים"' in prompt and "16 sentences" in prompt


def test_coach_prompt_escapes_braces_in_title():
    prompt = render_coach_prompt(LANGUAGES["en"], "a {weird} title", 3, "x")
    assert "(weird)" in prompt
