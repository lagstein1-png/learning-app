"""``learning_materials_mcp``: an MCP server that reads study texts from a directory.

Run it as a process (stdio transport) for Claude Code, the Agent SDK or any
other MCP client:

    LEARNING_MATERIALS_DIR=./materials python -m tts_backend.mcp_server

Or embed it in-process for tests through :func:`build_server`.

Security model: one root directory, fixed at start-up. Every path from a
client is relative, resolved with symlinks followed, and must still live under
the root; only ``.md`` and ``.txt`` files under a size cap are served. The
server never writes.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from ..languages import LANGUAGES, detect_script, language_for_script, resolve_or_none

SERVER_NAME = "learning_materials_mcp"
ALLOWED_SUFFIXES = frozenset({".md", ".txt"})
MAX_BYTES = 512 * 1024
DEFAULT_MAX_CHARS = 20000
_FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_SLUG = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


class MaterialSummary(BaseModel):
    path: str = Field(description="Path relative to the materials root, e.g. 'he/water-cycle.md'")
    language: str = Field(description="Two-letter language code: en, he, es or ar")
    title: str
    char_count: int


class MaterialDocument(BaseModel):
    path: str
    language: str
    title: str
    text: str = Field(description="The study text, front matter removed")
    char_count: int
    word_count: int
    sha256: str
    truncated: bool = False
    metadata: dict[str, str] = Field(default_factory=dict)


class MaterialCatalog(BaseModel):
    root: str
    count: int
    items: list[MaterialSummary]


class _Store:
    """Read-only access to one directory tree."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise FileNotFoundError(f"materials directory does not exist: {self.root}")

    def safe_path(self, relative: str) -> Path:
        if not relative or "\x00" in relative:
            raise ToolError("path must be a non-empty relative path such as 'he/water-cycle.md'")
        candidate = Path(relative)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ToolError("path must be relative to the materials root and may not contain '..'")
        resolved = (self.root / candidate).resolve()
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise ToolError("path escapes the materials root") from exc
        if resolved.suffix.lower() not in ALLOWED_SUFFIXES:
            raise ToolError(f"only {', '.join(sorted(ALLOWED_SUFFIXES))} files are served")
        if not resolved.is_file():
            raise ToolError(f"no such material: {relative}. Call list_learning_materials to see what exists.")
        if resolved.stat().st_size > MAX_BYTES:
            raise ToolError(f"material is larger than {MAX_BYTES // 1024} KB and is not served")
        return resolved

    def iter_files(self) -> list[Path]:
        files: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                if Path(name).suffix.lower() in ALLOWED_SUFFIXES and not name.startswith("."):
                    path = Path(dirpath, name).resolve()
                    try:
                        path.relative_to(self.root)
                    except ValueError:
                        continue
                    if path.is_file() and path.stat().st_size <= MAX_BYTES:
                        files.append(path)
        return files

    def relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def read(self, path: Path, max_chars: int = DEFAULT_MAX_CHARS) -> MaterialDocument:
        raw = path.read_text(encoding="utf-8", errors="replace")
        metadata, body = _split_front_matter(raw)
        body = body.strip()
        language = _language_of(metadata, self.relative(path), body)
        title = metadata.get("title") or _title_from_body(body) or path.stem.replace("-", " ")
        truncated = len(body) > max_chars
        text = body[:max_chars].rstrip() if truncated else body
        return MaterialDocument(
            path=self.relative(path),
            language=language,
            title=title,
            text=text,
            char_count=len(text),
            word_count=len(text.split()),
            sha256=hashlib.sha256(body.encode("utf-8")).hexdigest(),
            truncated=truncated,
            metadata=metadata,
        )

    def summary(self, path: Path) -> MaterialSummary:
        doc = self.read(path)
        return MaterialSummary(path=doc.path, language=doc.language, title=doc.title, char_count=doc.char_count)


def _split_front_matter(raw: str) -> tuple[dict[str, str], str]:
    match = _FRONT_MATTER.match(raw)
    if not match:
        return {}, raw
    metadata: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip().lower()] = value.strip().strip('"').strip("'")
    return metadata, raw[match.end() :]


def _language_of(metadata: dict[str, str], relative: str, body: str) -> str:
    declared = resolve_or_none(metadata.get("language", ""))
    if declared is not None:
        return declared.code
    top = relative.split("/", 1)[0]
    if top in LANGUAGES:
        return top
    return language_for_script(detect_script(body), LANGUAGES["en"]).code


def _title_from_body(body: str) -> str:
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("#"):
            return line.lstrip("#").strip()
        if line:
            return " ".join(line.split()[:8])
    return ""


def build_server(root: Path) -> MCPServer:
    store = _Store(root)
    server = MCPServer(
        SERVER_NAME,
        instructions=(
            "Read-only access to learning materials (study texts) in English, Hebrew, Spanish and Arabic. "
            "Call list_learning_materials to discover files, then fetch_learning_material to read one."
        ),
        version="1.0.0",
    )

    @server.tool(
        name="list_learning_materials",
        title="List learning materials",
        annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False),
    )
    def list_learning_materials(language: str | None = None) -> MaterialCatalog:
        """List the study texts available under the materials root.

        Args:
            language: Optional filter, one of en, he, es, ar (any BCP-47 form is accepted).

        Returns:
            MaterialCatalog with root, count and items (path, language, title, char_count).
        """
        wanted = resolve_or_none(language).code if language else None
        if language and wanted is None:
            raise ToolError("language must be one of en, he, es, ar")
        items = [store.summary(p) for p in store.iter_files()]
        if wanted:
            items = [i for i in items if i.language == wanted]
        return MaterialCatalog(root=str(store.root), count=len(items), items=items)

    @server.tool(
        name="fetch_learning_material",
        title="Fetch a learning material",
        annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False),
    )
    def fetch_learning_material(path: str, max_chars: int = DEFAULT_MAX_CHARS) -> MaterialDocument:
        """Read one study text by its relative path, e.g. 'he/water-cycle.md'.

        Args:
            path: Path relative to the materials root as returned by list_learning_materials.
            max_chars: Longest text to return (1000 to 200000); longer texts are cut and flagged.

        Returns:
            MaterialDocument: path, language, title, text, char_count, word_count, sha256, truncated, metadata.
        """
        if not 1000 <= max_chars <= 200_000:
            raise ToolError("max_chars must be between 1000 and 200000")
        return store.read(store.safe_path(path), max_chars)

    @server.tool(
        name="search_learning_materials",
        title="Search learning materials",
        annotations=ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False),
    )
    def search_learning_materials(query: str, language: str | None = None) -> MaterialCatalog:
        """Find study texts whose title or body contains the query (case-insensitive).

        Args:
            query: Words to look for.
            language: Optional filter, one of en, he, es, ar.
        """
        needle = " ".join(query.split()).lower()
        if not needle:
            raise ToolError("query must not be empty")
        wanted = resolve_or_none(language).code if language else None
        if language and wanted is None:
            raise ToolError("language must be one of en, he, es, ar")
        items: list[MaterialSummary] = []
        for path in store.iter_files():
            doc = store.read(path)
            if wanted and doc.language != wanted:
                continue
            if needle in doc.title.lower() or needle in doc.text.lower():
                items.append(MaterialSummary(path=doc.path, language=doc.language, title=doc.title, char_count=doc.char_count))
        return MaterialCatalog(root=str(store.root), count=len(items), items=items)

    @server.resource(
        "material://{language}/{slug}",
        name="learning_material",
        title="Learning material text",
        description="The plain text of one study material, addressed as material://<language>/<file name>.",
        mime_type="text/plain",
    )
    def material_resource(language: str, slug: str) -> str:
        if resolve_or_none(language) is None or not _SLUG.match(slug):
            raise ToolError("resource URI must be material://<en|he|es|ar>/<file-name.md>")
        return store.read(store.safe_path(f"{language}/{slug}")).text

    return server


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    root = Path(args[0]) if args else Path(os.environ.get("LEARNING_MATERIALS_DIR", "materials"))
    build_server(root).run("stdio")


if __name__ == "__main__":
    main()
