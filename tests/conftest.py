import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tts_backend.config import Settings  # noqa: E402
from tts_backend.preprocess import LocalBackend, TTSPreprocessor  # noqa: E402

HE_TEXT = (
    "מחזור המים הוא התהליך שבו המים נעים בין הים, האוויר והיבשה. "
    "השמש מחממת את פני הים, וחלק מהמים מתאדים. "
    "אדי המים מתקררים בגובה, מתעבים לטיפות ויוצרים עננים. "
    "הטיפות נופלות כגשם, כשלג או כברד."
)
EN_TEXT = (
    "Photosynthesis is the process by which plants make food. "
    "It happens in the chloroplasts, e.g. inside the leaves. "
    "Carbon dioxide and water become glucose and oxygen. "
    "The oxygen is released into the air."
)
AR_TEXT = "تعيش النحلة في خلية منظمة. تجمع الشغالات الرحيق من الأزهار. هل تعرف كيف يصنع العسل؟ إنه عمل جماعي."
ES_TEXT = "El sistema solar tiene ocho planetas. ¿Sabías que la Tierra es el tercero? Está a 150 millones de kilómetros del Sol."


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(materials_dir=tmp_path / "materials", state_dir=tmp_path / "state", preprocess_backend="local")


@pytest.fixture
def local_preprocessor(settings: Settings) -> TTSPreprocessor:
    return TTSPreprocessor(settings, backend=LocalBackend())
