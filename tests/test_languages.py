import pytest

from tts_backend.languages import LANGUAGES, UnsupportedLanguageError, detect_script, language_for_script, rank_voices, resolve
from tests.conftest import AR_TEXT, EN_TEXT, ES_TEXT, HE_TEXT


@pytest.mark.parametrize("code,expected", [("he", "he"), ("he-IL", "he"), ("iw", "he"), ("es_MX", "es"), ("AR", "ar"), ("en-GB", "en")])
def test_resolve_variants(code, expected):
    assert resolve(code).code == expected


def test_resolve_rejects_unknown():
    with pytest.raises(UnsupportedLanguageError):
        resolve("fr")
    with pytest.raises(UnsupportedLanguageError):
        resolve("")


@pytest.mark.parametrize("text,script", [(HE_TEXT, "Hebrew"), (AR_TEXT, "Arabic"), (EN_TEXT, "Latin"), (ES_TEXT, "Latin"), ("123 456", "unknown")])
def test_detect_script(text, script):
    assert detect_script(text) == script


def test_language_for_script_keeps_latin_request_and_fixes_wrong_script():
    assert language_for_script("Latin", LANGUAGES["es"]).code == "es"
    assert language_for_script("Latin", LANGUAGES["he"]).code == "en"
    assert language_for_script("Hebrew", LANGUAGES["en"]).code == "he"
    assert language_for_script("Arabic", LANGUAGES["es"]).code == "ar"


def test_rank_voices_prefers_usable_then_gender_then_quality():
    voices = [
        {"name": "Daniel", "lang": "en-GB", "gender": "male"},
        {"name": "Carmit", "lang": "he-IL", "gender": "female"},
        {"name": "Samantha", "lang": "en-US", "gender": "female"},
        {"name": "Ava (Enhanced)", "lang": "en-US", "gender": "female"},
        {"name": "Fred", "lang": "en-US", "gender": "male"},
    ]
    ranked = [v["name"] for v in rank_voices(voices, LANGUAGES["en"])]
    assert "Carmit" not in ranked, "a wrong-language voice is never a candidate"
    assert ranked[0] == "Ava (Enhanced)"
    assert ranked.index("Samantha") < ranked.index("Fred")
    assert ranked.index("Fred") < ranked.index("Daniel") or "Daniel" in ranked
