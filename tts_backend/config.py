"""Runtime settings, read once from the environment.

Every knob has a default that works on a laptop with nothing configured except
a Claude login; nothing here is required for the offline test suite.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

EffortLevel = Literal["low", "medium", "high", "xhigh", "max"]
BackendChoice = Literal["auto", "anthropic", "agent-sdk", "local"]

_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
_BACKENDS: tuple[str, ...] = ("auto", "anthropic", "agent-sdk", "local")


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, no dependency, never overrides real env."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _effort(name: str, default: str) -> EffortLevel:
    value = os.environ.get(name, default).strip().lower() or default
    if value not in _EFFORTS:
        raise ValueError(f"{name} must be one of {_EFFORTS}, got {value!r}")
    return value  # type: ignore[return-value]


@dataclass(frozen=True)
class Settings:
    model: str = "claude-opus-5"
    preprocess_backend: BackendChoice = "auto"
    preprocess_effort: EffortLevel = "medium"
    coach_effort: EffortLevel = "medium"
    coach_max_budget_usd: float = 2.0
    coach_max_turns: int = 12
    materials_dir: Path = field(default_factory=lambda: Path("materials"))
    state_dir: Path = field(default_factory=lambda: Path("state"))
    tts_max_chars: int = 6000
    request_timeout_s: float = 120.0
    has_api_credentials: bool = False

    @property
    def resolved_backend(self) -> Literal["anthropic", "agent-sdk", "local"]:
        if self.preprocess_backend == "auto":
            return "anthropic" if self.has_api_credentials else "agent-sdk"
        return self.preprocess_backend  # type: ignore[return-value]


def load_settings(project_root: Path | None = None) -> Settings:
    root = project_root or Path(__file__).resolve().parent.parent
    _load_dotenv(root / ".env")

    backend = os.environ.get("PREPROCESS_BACKEND", "auto").strip().lower() or "auto"
    if backend not in _BACKENDS:
        raise ValueError(f"PREPROCESS_BACKEND must be one of {_BACKENDS}, got {backend!r}")

    def _path(name: str, default: str) -> Path:
        value = os.environ.get(name, default).strip() or default
        p = Path(value)
        return p if p.is_absolute() else (root / p)

    has_creds = bool(
        os.environ.get("ANTHROPIC_API_KEY", "").strip()
        or os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
    )

    return Settings(
        model=os.environ.get("ANTHROPIC_MODEL", "claude-opus-5").strip() or "claude-opus-5",
        preprocess_backend=backend,  # type: ignore[arg-type]
        preprocess_effort=_effort("PREPROCESS_EFFORT", "medium"),
        coach_effort=_effort("COACH_EFFORT", "medium"),
        coach_max_budget_usd=float(os.environ.get("COACH_MAX_BUDGET_USD", "2.0") or 2.0),
        coach_max_turns=int(os.environ.get("COACH_MAX_TURNS", "12") or 12),
        materials_dir=_path("LEARNING_MATERIALS_DIR", "materials"),
        state_dir=_path("LEARNING_STATE_DIR", "state"),
        tts_max_chars=int(os.environ.get("TTS_MAX_CHARS", "6000") or 6000),
        request_timeout_s=float(os.environ.get("REQUEST_TIMEOUT_S", "120") or 120),
        has_api_credentials=has_creds,
    )
