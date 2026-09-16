"""Connecting to the materials server: from Python, and from the Agent SDK.

Two callers, one server:

* :class:`MaterialsClient` speaks MCP over stdio from our own process (the
  pipeline uses it to fetch a document before pre-processing).
* :func:`materials_agent_config` describes the same server to the Claude Agent
  SDK, which spawns it and exposes its tools to the coach as
  ``mcp__materials__<tool>``.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from claude_agent_sdk.types import McpStdioServerConfig
from mcp.client.client import Client
from mcp.client.stdio import StdioServerParameters
from mcp.types import CallToolResult

from .materials_server import MaterialDocument, MaterialSummary


class MaterialsError(RuntimeError):
    pass


def _server_env(materials_dir: Path) -> dict[str, str]:
    env = {"LEARNING_MATERIALS_DIR": str(Path(materials_dir).resolve())}
    # The server is started as `python -m tts_backend...`, so it must find this package.
    package_root = str(Path(__file__).resolve().parent.parent.parent)
    existing = os.environ.get("PYTHONPATH", "")
    env["PYTHONPATH"] = package_root if not existing else f"{package_root}{os.pathsep}{existing}"
    return env


def materials_stdio_params(materials_dir: Path) -> StdioServerParameters:
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "tts_backend.mcp_server"],
        env={**os.environ, **_server_env(materials_dir)},
    )


def materials_agent_config(materials_dir: Path) -> McpStdioServerConfig:
    return McpStdioServerConfig(
        type="stdio",
        command=sys.executable,
        args=["-m", "tts_backend.mcp_server"],
        env=_server_env(materials_dir),
    )


def _payload(result: CallToolResult) -> dict[str, Any]:
    if result.is_error:
        text = " ".join(getattr(block, "text", "") for block in result.content).strip()
        raise MaterialsError(text or "materials server returned an error")
    if result.structured_content:
        return result.structured_content
    for block in result.content:
        text = getattr(block, "text", None)
        if text:
            return json.loads(text)
    raise MaterialsError("materials server returned no content")


class MaterialsClient:
    def __init__(self, materials_dir: Path) -> None:
        self.materials_dir = Path(materials_dir)
        self._client: Client | None = None
        self.server_info: dict[str, Any] = {}

    async def __aenter__(self) -> "MaterialsClient":
        self._client = Client(materials_stdio_params(self.materials_dir))
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._client is not None:
            await self._client.__aexit__(*exc)
            self._client = None

    def _require(self) -> Client:
        if self._client is None:
            raise MaterialsError("not connected; use 'async with MaterialsClient(...)'")
        return self._client

    async def tool_names(self) -> list[str]:
        result = await self._require().list_tools()
        return [t.name for t in result.tools]

    async def list(self, language: str | None = None) -> list[MaterialSummary]:
        args: dict[str, Any] = {"language": language} if language else {}
        data = _payload(await self._require().call_tool("list_learning_materials", args))
        return [MaterialSummary.model_validate(item) for item in data.get("items", [])]

    async def fetch(self, path: str, max_chars: int = 20000) -> MaterialDocument:
        data = _payload(await self._require().call_tool("fetch_learning_material", {"path": path, "max_chars": max_chars}))
        return MaterialDocument.model_validate(data)

    async def search(self, query: str, language: str | None = None) -> list[MaterialSummary]:
        args: dict[str, Any] = {"query": query}
        if language:
            args["language"] = language
        data = _payload(await self._require().call_tool("search_learning_materials", args))
        return [MaterialSummary.model_validate(item) for item in data.get("items", [])]

    async def read_resource(self, language: str, slug: str) -> str:
        result = await self._require().read_resource(f"material://{language}/{slug}")
        for content in result.contents:
            text = getattr(content, "text", None)
            if text:
                return text
        raise MaterialsError("resource has no text content")
