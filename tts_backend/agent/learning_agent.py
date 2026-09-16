"""The learning coach: a stateful agent on the Claude Agent SDK.

Responsibilities are split so each piece stays small:

* :class:`LearningSession` (state.py) holds *what happened*.
* The coach tools (tools.py) are the *only* way the model touches that state.
* :class:`LearningAgent` owns the Agent SDK connection, turns learner text into
  a query, collects the reply and its tool calls, persists the session after
  every turn, and returns a speech-ready reply.

Conversation memory lives in two places on purpose: the Agent SDK session (so
``resume`` restores the full transcript) and our JSON state (so a new device,
or a new process, can rebuild the lesson even if the transcript is gone).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    McpSdkServerConfig,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)
from claude_agent_sdk.types import McpStdioServerConfig

from ..config import Settings
from ..languages import Language, resolve
from ..preprocess.preprocessor import TTSPreprocessor
from .prompts import render_coach_prompt
from .state import LearningSession, SessionStore, Turn
from .tools import CoachContext, build_coach_server, qualified_tool_names
from .voice import VoiceReply, voice_ready

log = logging.getLogger(__name__)

MATERIALS_SERVER_NAME = "materials"
MATERIALS_TOOL_NAMES = ("list_learning_materials", "fetch_learning_material", "search_learning_materials")


class CoachError(RuntimeError):
    """The agent turn failed; ``details`` carries the SDK's error list."""

    def __init__(self, message: str, details: list[str] | None = None) -> None:
        super().__init__(message)
        self.details = details or []


@dataclass
class CoachReply:
    text: str
    voice: VoiceReply
    tool_calls: list[str] = field(default_factory=list)
    cost_usd: float | None = None
    duration_ms: int = 0
    num_turns: int = 0
    session_id: str = ""


class LearningAgent:
    def __init__(
        self,
        session: LearningSession,
        store: SessionStore,
        preprocessor: TTSPreprocessor,
        settings: Settings,
        *,
        materials_server: McpStdioServerConfig | None = None,
        resume: bool = False,
    ) -> None:
        self.session = session
        self.store = store
        self.settings = settings
        self.language: Language = resolve(session.language)
        self.materials_server = materials_server
        self.resume = resume
        self._ctx = CoachContext(session=session, store=store, preprocessor=preprocessor)
        self._coach_server: McpSdkServerConfig = build_coach_server(self._ctx)
        self._client: ClaudeSDKClient | None = None
        self._in_flight = False
        self.stderr: list[str] = []

    # ---------------------------------------------------------------- options

    def _options(self) -> ClaudeAgentOptions:
        mcp_servers: dict[str, Any] = {"coach": self._coach_server}
        allowed = qualified_tool_names()
        if self.materials_server is not None:
            mcp_servers[MATERIALS_SERVER_NAME] = self.materials_server
            allowed += [f"mcp__{MATERIALS_SERVER_NAME}__{name}" for name in MATERIALS_TOOL_NAMES]
        system_prompt = render_coach_prompt(
            self.language,
            self.session.script.title,
            self.session.total,
            self.session.progress_summary(),
        )
        options = ClaudeAgentOptions(
            system_prompt=system_prompt,
            tools=[],  # no built-in file or shell tools: the coach only sees the lesson
            mcp_servers=mcp_servers,
            allowed_tools=allowed,
            model=self.settings.model,
            effort=self.settings.coach_effort,
            max_turns=self.settings.coach_max_turns,
            max_budget_usd=self.settings.coach_max_budget_usd,
            cwd=self.store.root,
            stderr=self.stderr.append,
        )
        if self.resume:
            options.resume = self.session.agent_session_id
        else:
            options.session_id = self.session.agent_session_id
        return options

    # --------------------------------------------------------------- lifecycle

    async def __aenter__(self) -> "LearningAgent":
        self._client = ClaudeSDKClient(options=self._options())
        await self._client.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.disconnect()
            self._client = None
        self.store.save(self.session)

    # ------------------------------------------------------------------ turns

    async def start(self) -> CoachReply:
        """Open the lesson: one greeting sentence, then sentence one."""
        prompt = (
            "The learner just opened the text. Greet them in one warm sentence, "
            "then read the current sentence aloud exactly as its speech text, and stop."
        )
        return await self._turn(prompt, learner_text=None)

    async def send(self, learner_text: str) -> CoachReply:
        text = " ".join(learner_text.split())
        if not text:
            raise ValueError("learner_text is empty")
        return await self._turn(text, learner_text=text)

    async def flag_word(self, word: str) -> CoachReply:
        """The learner tapped a word mid-reading. Interrupt any turn in flight, then ask."""
        if self._in_flight and self._client is not None:
            await self._client.interrupt()
        current = self.session.current()
        where = f" in sentence {current.index + 1}" if current else ""
        return await self.send(f"I don't understand the word \"{word.strip()}\"{where}.")

    async def _turn(self, prompt: str, learner_text: str | None) -> CoachReply:
        if self._client is None:
            raise CoachError("agent is not connected; use 'async with LearningAgent(...)'")
        if learner_text is not None:
            self.session.turns.append(Turn(role="learner", text=learner_text))
        self._in_flight = True
        texts: list[str] = []
        tool_calls: list[str] = []
        result: ResultMessage | None = None
        try:
            await self._client.query(prompt)
            async for message in self._client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            texts.append(block.text.strip())
                        elif isinstance(block, ToolUseBlock):
                            tool_calls.append(block.name)
                elif isinstance(message, ResultMessage):
                    result = message
        finally:
            self._in_flight = False

        if result is None:
            raise CoachError("no result from the agent", self.stderr[-5:])
        if result.is_error:
            raise CoachError(result.result or "agent turn failed", result.errors or self.stderr[-5:])

        # Everything the coach said in this turn is the reply: an explanation often
        # comes before a tool call and the check question after it. The SDK's
        # ``result`` holds only the final block, so join the blocks in order.
        final = (result.result or "").strip()
        if final and final not in texts:
            texts.append(final)
        reply_text = " ".join(texts).strip()
        self.session.turns.append(Turn(role="coach", text=reply_text))
        self.store.save(self.session)
        voice = voice_ready(reply_text, self.language, rate=self.session.script.voice.rate)
        return CoachReply(
            text=reply_text,
            voice=voice,
            tool_calls=tool_calls,
            cost_usd=result.total_cost_usd,
            duration_ms=result.duration_ms,
            num_turns=result.num_turns,
            session_id=result.session_id,
        )
