"""Multilingual TTS learning backend.

Three pillars, one process:

* ``tts_backend.preprocess``  - Claude API text pre-processing for TTS (Step 2)
* ``tts_backend.agent``       - Claude Agent SDK learning coach (Step 3)
* ``tts_backend.mcp_server``  - MCP server + client for learning materials (Step 4)
"""

__version__ = "1.0.0"
