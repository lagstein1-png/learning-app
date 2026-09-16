"""Step 4: MCP server and client for learning materials."""

from .client import MaterialsClient, MaterialsError, materials_agent_config, materials_stdio_params
from .materials_server import MaterialDocument, MaterialSummary, build_server

__all__ = [
    "MaterialDocument",
    "MaterialSummary",
    "MaterialsClient",
    "MaterialsError",
    "build_server",
    "materials_agent_config",
    "materials_stdio_params",
]
