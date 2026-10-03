"""Local Model Harness with temporal grounding, JSON repair, and masked tool execution."""

from .clock import GET_CURRENT_DATETIME_SCHEMA, WEB_SEARCH_SCHEMA, get_current_datetime
from .engine import HarnessEngine
from .json_guard import JSON_OBJECT_GBNF, build_json_syntax_error_message, repair_json_string
from .prompt import HARDENED_SYSTEM_PROMPT_TEMPLATE, SystemPromptManager
from .tools import ToolRegistry, ToolResult, WebProviderError

__all__ = [
    "get_current_datetime",
    "GET_CURRENT_DATETIME_SCHEMA",
    "WEB_SEARCH_SCHEMA",
    "repair_json_string",
    "build_json_syntax_error_message",
    "JSON_OBJECT_GBNF",
    "ToolResult",
    "ToolRegistry",
    "WebProviderError",
    "HARDENED_SYSTEM_PROMPT_TEMPLATE",
    "SystemPromptManager",
    "HarnessEngine",
]
