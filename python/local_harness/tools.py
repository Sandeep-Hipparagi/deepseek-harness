"""Standardized tool registration, execution dispatcher, and error masking guardrails."""

from __future__ import annotations

import inspect
import json
import logging
import traceback
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, Optional

from .clock import GET_CURRENT_DATETIME_SCHEMA, get_current_datetime, WEB_SEARCH_SCHEMA

logger = logging.getLogger("local_harness.tools")


class WebProviderError(Exception):
    """Raised when an external web search endpoint fails or times out."""
    pass


@dataclass
class ToolResult:
    """Strictly normalized tool output schema."""
    status: str  # "success" | "error"
    error_code: Optional[str]  # e.g., None, "WEB_PROVIDER_ERROR", "TOOL_NOT_FOUND"
    data: Any

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "error_code": self.error_code,
            "data": self.data,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), default=str, indent=2)


def default_web_search(queries: list[str]) -> list[dict[str, str]]:
    """Simulated web search handler that handles upstream provider errors gracefully."""
    if not queries:
        raise ValueError("At least one query string must be provided in 'queries'.")

    # In real usage, this connects to search API.
    # We provide a clean baseline simulation:
    results = []
    for q in queries:
        results.append({
            "query": q,
            "snippet": f"Web search results for '{q}': No critical outages reported.",
            "source": "https://local-harness.example.com",
        })
    return results


class ToolRegistry:
    """Registry managing available tool schemas, executors, and dispatch wrappers."""

    def __init__(self) -> None:
        self._schemas: dict[str, dict[str, Any]] = {}
        self._handlers: dict[str, Callable[..., Any]] = {}

        # Register default grounded tools
        self.register(
            name="get_current_datetime",
            schema=GET_CURRENT_DATETIME_SCHEMA,
            handler=get_current_datetime,
        )
        self.register(
            name="web_search",
            schema=WEB_SEARCH_SCHEMA,
            handler=default_web_search,
        )

    def register(
        self,
        name: str,
        schema: dict[str, Any],
        handler: Callable[..., Any],
    ) -> None:
        self._schemas[name] = schema
        self._handlers[name] = handler

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Return tool definitions in OpenAI / function-calling schema format."""
        return [
            {"type": "function", "function": schema}
            for schema in self._schemas.values()
        ]

    def dispatch(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        """Executes a registered tool within a defensive try/except boundary.

        Guarantees that:
        1. No unhandled exceptions escape or crash the harness loop.
        2. Technical internals and raw stack traces are masked from user-facing context.
        3. Upstream provider failures (e.g. WEB_PROVIDER_ERROR) produce clean, actionable
           fallbacks so the model can provide a polite, natural response.
        4. Output strictly adheres to {"status": ..., "error_code": ..., "data": ...}.
        """
        if name not in self._handlers:
            logger.warning("Attempted invocation of unknown tool '%s'", name)
            return ToolResult(
                status="error",
                error_code="TOOL_NOT_FOUND",
                data=(
                    f"Tool '{name}' is not registered. Available tools: "
                    f"{', '.join(sorted(self._handlers.keys()))}."
                ),
            )

        handler = self._handlers[name]
        safe_args = arguments if isinstance(arguments, dict) else {}

        try:
            # Inspect signature to pass kwargs cleanly
            sig = inspect.signature(handler)
            bound_kwargs = {}
            for param_name, param in sig.parameters.items():
                if param_name in safe_args:
                    bound_kwargs[param_name] = safe_args[param_name]
                elif param.default is not inspect.Parameter.empty:
                    pass  # Will use function default
                elif param.kind in (inspect.Parameter.VAR_KEYWORD, inspect.Parameter.VAR_POSITIONAL):
                    pass

            # If handler takes **kwargs or exact match
            if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                raw_result = handler(**safe_args)
            elif bound_kwargs:
                raw_result = handler(**bound_kwargs)
            else:
                raw_result = handler()

            # Ensure successful result conforms to ToolResult schema
            if isinstance(raw_result, ToolResult):
                return raw_result

            return ToolResult(
                status="success",
                error_code=None,
                data=raw_result,
            )

        except WebProviderError as wpe:
            # Mask internal provider failure; suppress raw stack trace
            logger.error("Web provider error during tool execution: %s", str(wpe))
            return ToolResult(
                status="error",
                error_code="WEB_PROVIDER_ERROR",
                data=(
                    "The external web search provider is currently unavailable or unreachable. "
                    "Do NOT output technical stack traces or raw JSON error blocks to the user. "
                    "Please answer the user using your internal knowledge, or politely explain "
                    "that real-time search is currently offline."
                ),
            )

        except (ValueError, TypeError) as err:
            logger.warning("Tool parameter validation error in '%s': %s", name, str(err))
            return ToolResult(
                status="error",
                error_code="INVALID_ARGUMENTS",
                data=(
                    f"Invalid arguments for tool '{name}': {str(err)}. "
                    "Please check the tool parameters schema and try again."
                ),
            )

        except Exception as exc:
            # Generic masked exception
            logger.error("Unhandled exception in tool '%s': %s\n%s", name, str(exc), traceback.format_exc())
            return ToolResult(
                status="error",
                error_code="TOOL_EXECUTION_ERROR",
                data=(
                    f"Execution of tool '{name}' encountered an error. "
                    "Please inform the user gracefully without leaking technical stack traces."
                ),
            )
