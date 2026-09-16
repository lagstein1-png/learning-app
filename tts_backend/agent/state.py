"""Learning-session state and its persistence.

The state is deliberately small and human-readable JSON: the mobile client, a
support engineer and the coach all look at the same file. Nothing here talks to
a model; the coach reads and writes state only through the tools in
:mod:`tools`, so every change is logged as a tool call.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from ..preprocess.schema import Segment, TTSScript

CheckOutcome = Literal["pending", "understood", "retry"]
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class WordFlag:
    word: str
    sentence_number: int
    explanation: str
    at: str = field(default_factory=_now)


@dataclass
class ComprehensionCheck:
    sentence_number: int
    question: str
    learner_answer: str = ""
    outcome: CheckOutcome = "pending"
    at: str = field(default_factory=_now)


@dataclass
class Turn:
    role: Literal["learner", "coach"]
    text: str
    at: str = field(default_factory=_now)


@dataclass
class LearningSession:
    session_id: str
    learner_id: str
    language: str
    script: TTSScript
    agent_session_id: str
    position: int = 1  # 1-based sentence number the learner is on
    completed: list[int] = field(default_factory=list)
    flags: list[WordFlag] = field(default_factory=list)
    checks: list[ComprehensionCheck] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    # ----------------------------------------------------------- construction

    @classmethod
    def new(cls, learner_id: str, script: TTSScript, session_id: str | None = None) -> "LearningSession":
        if not _SAFE_ID.match(learner_id):
            raise ValueError("learner_id may only contain letters, digits, '-' and '_' (max 64)")
        return cls(
            session_id=session_id or uuid.uuid4().hex[:12],
            learner_id=learner_id,
            language=script.language,
            script=script,
            agent_session_id=str(uuid.uuid4()),
        )

    # ------------------------------------------------------------- navigation

    @property
    def total(self) -> int:
        return len(self.script.segments)

    @property
    def is_finished(self) -> bool:
        return len(set(self.completed)) >= self.total

    def sentence(self, number: int) -> Segment:
        return self.script.segment_by_number(number)

    def current(self) -> Segment | None:
        return self.sentence(self.position) if 1 <= self.position <= self.total else None

    def next_sentence(self) -> Segment | None:
        nxt = self.position + 1
        return self.sentence(nxt) if nxt <= self.total else None

    def mark_done(self, number: int) -> None:
        self.sentence(number)  # validates the range
        if number not in self.completed:
            self.completed.append(number)
        if number >= self.position:
            self.position = min(number + 1, self.total + 1) if number < self.total else self.total
        self.touch()

    def pending_check(self) -> ComprehensionCheck | None:
        for check in reversed(self.checks):
            if check.outcome == "pending":
                return check
        return None

    def touch(self) -> None:
        self.updated_at = _now()

    # -------------------------------------------------------------- summaries

    def progress_summary(self) -> str:
        """One short line: everything the coach needs, nothing it does not."""
        done = len(set(self.completed))
        understood = sum(1 for c in self.checks if c.outcome == "understood")
        retries = sum(1 for c in self.checks if c.outcome == "retry")
        flagged = ", ".join(f.word for f in self.flags[-3:]) or "none"
        where = "finished" if self.is_finished else f"on sentence {self.position} of {self.total}"
        return (
            f"{where}; {done} sentences done; checks understood {understood}, retry {retries}; "
            f"recent words asked: {flagged}"
        )

    # ------------------------------------------------------------ persistence

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["script"] = self.script.model_dump()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LearningSession":
        return cls(
            session_id=data["session_id"],
            learner_id=data["learner_id"],
            language=data["language"],
            script=TTSScript.model_validate(data["script"]),
            agent_session_id=data["agent_session_id"],
            position=int(data.get("position", 1)),
            completed=[int(n) for n in data.get("completed", [])],
            flags=[WordFlag(**f) for f in data.get("flags", [])],
            checks=[ComprehensionCheck(**c) for c in data.get("checks", [])],
            turns=[Turn(**t) for t in data.get("turns", [])],
            created_at=data.get("created_at", _now()),
            updated_at=data.get("updated_at", _now()),
        )


class SessionStore:
    """JSON files, one per session, written atomically."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, session_id: str) -> Path:
        if not _SAFE_ID.match(session_id):
            raise ValueError("invalid session id")
        return self.root / f"session-{session_id}.json"

    def save(self, session: LearningSession) -> Path:
        session.touch()
        target = self.path_for(session.session_id)
        payload = json.dumps(session.to_dict(), ensure_ascii=False, indent=2)
        fd, tmp = tempfile.mkstemp(prefix=".session-", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return target

    def load(self, session_id: str) -> LearningSession:
        path = self.path_for(session_id)
        with path.open(encoding="utf-8") as handle:
            return LearningSession.from_dict(json.load(handle))

    def exists(self, session_id: str) -> bool:
        return self.path_for(session_id).is_file()

    def list_ids(self) -> list[str]:
        return sorted(p.name[len("session-") : -len(".json")] for p in self.root.glob("session-*.json"))
