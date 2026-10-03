"""Core Harness execution loop with dynamic session injection, JSON repair, and error-masked tool dispatch."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from .clock import get_current_datetime
from .json_guard import build_json_syntax_error_message, repair_json_string
from .prompt import SystemPromptManager
from .tools import ToolRegistry, ToolResult

logger = logging.getLogger("local_harness.engine")


class HarnessEngine:
    """Production-grade LLM agent harness loop with defensive runtime guardrails."""

    def __init__(
        self,
        tool_registry: ToolRegistry | None = None,
        prompt_manager: SystemPromptManager | None = None,
        max_tool_rounds: int = 5,
        max_json_repair_retries: int = 2,
    ) -> None:
        self.tool_registry = tool_registry or ToolRegistry()
        self.prompt_manager = prompt_manager or SystemPromptManager()
        self.max_tool_rounds = max_tool_rounds
        self.max_json_repair_retries = max_json_repair_retries

    def prepare_messages(
        self,
        conversation: list[dict[str, Any]],
        timezone: str | None = None,
    ) -> list[dict[str, Any]]:
        """Prepares turn messages, injecting/updating the dynamically grounded system prompt."""
        grounded_system_prompt = self.prompt_manager.inject_session_header(timezone=timezone)

        messages: list[dict[str, Any]] = []
        has_system = False

        for msg in conversation:
            if msg.get("role") == "system":
                # Replace with newly grounded system prompt
                messages.append({"role": "system", "content": grounded_system_prompt})
                has_system = True
            else:
                messages.append(dict(msg))

        if not has_system:
            messages.insert(0, {"role": "system", "content": grounded_system_prompt})

        return messages

    def execute_turn(
        self,
        messages: list[dict[str, Any]],
        model_caller: Callable[[list[dict[str, Any]], list[dict[str, Any]]], dict[str, Any]],
        timezone: str = "Asia/Kolkata",
    ) -> dict[str, Any]:
        """Runs one full agent turn through the harness execution loop.

        Args:
            messages: Conversation history.
            model_caller: Callable receiving (messages, tool_schemas) and returning an OpenAI-style response dict:
                          {"role": "assistant", "content": "...", "tool_calls": [...]}
            timezone: Timezone for temporal grounding.

        Returns:
            dict with:
                - final_content: Clean assistant text for user chat
                - messages: Complete updated message trajectory
                - tool_events: Detailed audit log of tool calls, repairs, and executions
                - finish_reason: Reason for turn completion
        """
        turn_messages = self.prepare_messages(messages, timezone=timezone)
        tool_schemas = self.tool_registry.get_tool_schemas()
        tool_events: list[dict[str, Any]] = []

        round_idx = 0
        json_retries = 0

        while round_idx < self.max_tool_rounds:
            round_idx += 1
            logger.debug("Executing harness loop round %d", round_idx)

            # 1. Invoke Model with tool schemas
            response = model_caller(turn_messages, tool_schemas)
            assistant_msg = {
                "role": "assistant",
                "content": response.get("content") or "",
            }
            if "tool_calls" in response and response["tool_calls"]:
                assistant_msg["tool_calls"] = response["tool_calls"]

            turn_messages.append(assistant_msg)

            raw_tool_calls = response.get("tool_calls")
            if not raw_tool_calls:
                # No tool calls: final conversational synthesis reached
                return {
                    "final_content": assistant_msg["content"],
                    "messages": turn_messages,
                    "tool_events": tool_events,
                    "finish_reason": "stop",
                }

            # 2. Process and dispatch tool calls
            for tc in raw_tool_calls:
                tc_id = tc.get("id", f"call_{round_idx}")
                func_info = tc.get("function", {})
                func_name = func_info.get("name", "")
                raw_args = func_info.get("arguments", "{}")

                # Parse & Repair JSON Arguments
                parsed_args, was_repaired, repair_err = repair_json_string(raw_args)

                if repair_err:
                    logger.warning("Unrecoverable tool call JSON: %s", repair_err)
                    if json_retries < self.max_json_repair_retries:
                        json_retries += 1
                        error_feedback = build_json_syntax_error_message(
                            tool_call_id=tc_id,
                            tool_name=func_name,
                            raw_payload=str(raw_args),
                            error_detail=repair_err,
                        )
                        turn_messages.append(error_feedback)
                        tool_events.append({
                            "type": "json_parse_error",
                            "tool_call_id": tc_id,
                            "raw_arguments": raw_args,
                            "retry_count": json_retries,
                        })
                        # Allow model to self-correct in next loop iteration
                        break
                    else:
                        # Max retries exceeded; emit error result for this tool
                        parsed_args = {}

                if was_repaired:
                    logger.info("Successfully repaired malformed tool call JSON for '%s'", func_name)
                    tool_events.append({
                        "type": "json_repaired",
                        "tool_call_id": tc_id,
                        "original": raw_args,
                        "repaired": parsed_args,
                    })

                # 3. Defensive Tool Dispatch with Error Masking
                tool_result: ToolResult = self.tool_registry.dispatch(
                    name=func_name,
                    arguments=parsed_args or {},
                )

                tool_events.append({
                    "type": "tool_executed",
                    "tool_call_id": tc_id,
                    "name": func_name,
                    "status": tool_result.status,
                    "error_code": tool_result.error_code,
                    "data": tool_result.data,
                })

                # Append standardized tool message to context
                turn_messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "name": func_name,
                    "content": tool_result.to_json(),
                })

        # Final loop termination: Request final synthesis from model
        final_response = model_caller(turn_messages, tool_schemas=[])
        final_content = final_response.get("content") or ""
        turn_messages.append({"role": "assistant", "content": final_content})

        return {
            "final_content": final_content,
            "messages": turn_messages,
            "tool_events": tool_events,
            "finish_reason": "completed",
        }
