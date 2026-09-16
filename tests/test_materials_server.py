import asyncio
import os
from pathlib import Path

import pytest
from mcp.client.client import Client

from tts_backend.mcp_server import MaterialsClient, MaterialsError, materials_agent_config
from tts_backend.mcp_server.materials_server import build_server


@pytest.fixture
def root(tmp_path: Path) -> Path:
    base = tmp_path / "materials"
    (base / "he").mkdir(parents=True)
    (base / "en").mkdir()
    (base / "he" / "water.md").write_text("---\ntitle: מחזור המים\nlanguage: he\n---\nהמים עולים. הגשם יורד.\n", encoding="utf-8")
    (base / "en" / "plants.txt").write_text("# Plants\nPlants make food. They need light.\n", encoding="utf-8")
    (base / "en" / "notes.pdf").write_bytes(b"%PDF-1.4 not served")
    (base / "ar-untagged.md").write_text("النحلة تصنع العسل. هذا رائع.\n", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("do not serve", encoding="utf-8")
    return base


def run(coro):
    return asyncio.run(coro)


async def _session(root):
    return Client(build_server(root))


def test_list_fetch_and_language_detection(root):
    async def go():
        async with Client(build_server(root)) as c:
            names = [t.name for t in (await c.list_tools()).tools]
            assert names == ["list_learning_materials", "fetch_learning_material", "search_learning_materials"]
            catalog = (await c.call_tool("list_learning_materials", {})).structured_content
            paths = {i["path"]: i for i in catalog["items"]}
            assert set(paths) == {"he/water.md", "en/plants.txt", "ar-untagged.md"}
            assert paths["he/water.md"]["language"] == "he" and paths["he/water.md"]["title"] == "מחזור המים"
            assert paths["en/plants.txt"]["language"] == "en" and paths["en/plants.txt"]["title"] == "Plants"
            assert paths["ar-untagged.md"]["language"] == "ar", "script detection when nothing declares the language"
            doc = (await c.call_tool("fetch_learning_material", {"path": "he/water.md"})).structured_content
            assert doc["text"] == "המים עולים. הגשם יורד." and doc["word_count"] == 4 and doc["metadata"]["title"] == "מחזור המים"
            only_he = (await c.call_tool("list_learning_materials", {"language": "he-IL"})).structured_content
            assert [i["path"] for i in only_he["items"]] == ["he/water.md"]
            found = (await c.call_tool("search_learning_materials", {"query": "light"})).structured_content
            assert [i["path"] for i in found["items"]] == ["en/plants.txt"]
            res = await c.read_resource("material://he/water.md")
            assert res.contents[0].text.startswith("המים")

    run(go())


@pytest.mark.parametrize("path", ["../secret.txt", "/etc/passwd", "en/notes.pdf", "en/missing.md", "", "he/../../secret.txt"])
def test_unsafe_or_unknown_paths_are_refused(root, path):
    async def go():
        async with Client(build_server(root)) as c:
            result = await c.call_tool("fetch_learning_material", {"path": path})
            assert result.is_error, path
            message = result.content[0].text
            assert "secret" not in message.lower() or "escapes" in message or ".." in message

    run(go())


def test_symlink_escape_is_refused(root, tmp_path):
    target = tmp_path / "secret.txt"
    link = root / "en" / "link.md"
    try:
        os.symlink(target, link)
    except OSError:
        pytest.skip("symlinks not supported here")

    async def go():
        async with Client(build_server(root)) as c:
            result = await c.call_tool("fetch_learning_material", {"path": "en/link.md"})
            assert result.is_error and "escapes" in result.content[0].text
            catalog = (await c.call_tool("list_learning_materials", {})).structured_content
            assert "en/link.md" not in {i["path"] for i in catalog["items"]}

    run(go())


def test_stdio_client_end_to_end(root):
    """Spawns the real server process over stdio, the way the Agent SDK does."""

    async def go():
        async with MaterialsClient(root) as client:
            assert "fetch_learning_material" in await client.tool_names()
            items = await client.list()
            assert {i.path for i in items} == {"he/water.md", "en/plants.txt", "ar-untagged.md"}
            doc = await client.fetch("he/water.md")
            assert doc.language == "he" and doc.title == "מחזור המים"
            assert (await client.read_resource("en", "plants.txt")).startswith("# Plants")
            with pytest.raises(MaterialsError):
                await client.fetch("../secret.txt")

    run(go())


def test_agent_config_shape(root):
    cfg = materials_agent_config(root)
    assert cfg["type"] == "stdio" and cfg["args"] == ["-m", "tts_backend.mcp_server"]
    assert cfg["env"]["LEARNING_MATERIALS_DIR"] == str(root.resolve())
