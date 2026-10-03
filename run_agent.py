"""run_agent.py - Complete, self-contained Agent Harness for Llama 3.1 8B via Ollama.

Resolves role collapse, raw JSON leakage, and fabricated tool simulations
by enforcing native Ollama tool-calling and a multi-turn agent execution loop.
"""

from __future__ import annotations

import datetime
import json
import sys
import urllib.error
import urllib.request
import zoneinfo
from typing import Any, Callable, Dict, List, Optional


# ==============================================================================
# 1. Deterministic Local Date/Time Tool & Schema
# ==============================================================================

def get_current_datetime(timezone: str = "Asia/Kolkata") -> dict[str, Any]:
    """Retrieve current real-world date, 24-hour time, weekday, and timezone.

    Deterministic, offline standard library implementation.
    Falls back gracefully to system local timezone on unrecognized identifier.
    """
    warning = None
    target_tz_str = timezone.strip() if timezone and timezone.strip() else "UTC"

    try:
        tz = zoneinfo.ZoneInfo(target_tz_str)
    except Exception:
        local_tz = datetime.datetime.now().astimezone().tzinfo
        tz = local_tz if local_tz is not None else datetime.timezone.utc
        warning = f"Invalid timezone identifier '{target_tz_str}'. Falling back to system timezone."

    now = datetime.datetime.now(tz=tz)

    utc_offset = now.strftime("%z")
    if utc_offset and len(utc_offset) == 5:
        formatted_offset = f"UTC{utc_offset[:3]}:{utc_offset[3:]}"
    elif utc_offset:
        formatted_offset = f"UTC{utc_offset}"
    else:
        formatted_offset = "UTC+00:00"

    tz_label = f"{target_tz_str} ({formatted_offset})" if not warning else f"{str(tz)} ({formatted_offset})"
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")

    result: dict[str, Any] = {
        "status": "success",
        "iso_timestamp": now.isoformat(),
        "day_of_week": now.strftime("%A"),
        "date": date_str,
        "time_24h": time_str,
        "timezone": tz_label,
    }

    if warning:
        result["warning"] = warning

    return result


GET_CURRENT_DATETIME_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "get_current_datetime",
        "description": (
            "Retrieves the current real-world date, 24-hour time, day of the week, and timezone. "
            "Call this tool ONLY when the user explicitly asks for the current date, current time, "
            "the day of the week, or calendar calculations. Do not call this tool for general topics or explanations."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": (
                        "Optional IANA timezone identifier (e.g., 'Asia/Kolkata', 'UTC', "
                        "'America/New_York', 'Europe/London'). Defaults to 'Asia/Kolkata' if omitted."
                    ),
                    "default": "Asia/Kolkata",
                },
            },
            "required": [],
        },
    },
}


# ==============================================================================
# 2. Hardened System Prompt Builder
# ==============================================================================

def build_hardened_system_prompt(timezone: str = "Asia/Kolkata") -> str:
    """Constructs an immutable system prompt with runtime baseline timestamp injection."""
    try:
        tz = zoneinfo.ZoneInfo(timezone)
    except Exception:
        tz = datetime.datetime.now().astimezone().tzinfo or datetime.timezone.utc

    now = datetime.datetime.now(tz=tz)
    ref_time_str = now.strftime("%A, %B %d, %Y %H:%M:%S %Z")

    return (
        f"You are a helpful, grounded, and concise AI assistant running locally with Llama 3.1.\n"
        f"Current reference time: {ref_time_str}\n\n"
        f"TOOL USAGE POLICY:\n"
        f"1. You have access to tools, but you must ONLY call a tool if the user's question specifically requires external data or real-world date/time.\n"
        f"2. If the user asks for current date, time, day of the week, or calendar information, invoke get_current_datetime via the tool interface.\n"
        f"3. If the question does NOT require any tool (such as explaining concepts, definitions, programming, or general Q&A), DO NOT call any tool; answer the question directly in plain text without mentioning tools, JSON, or justifications.\n"
        f"4. Never output mock tool calls, simulated tool blocks, or raw JSON in your text output.\n"
        f"5. When a tool result is returned with role 'tool', ALWAYS accept its output as authoritative, 100% accurate, real-world data.\n"
        f"6. Synthesize a natural conversational reply using the returned tool data."
    )


# ==============================================================================
# 3. Multi-Turn Agent Runner
# ==============================================================================

class OllamaAgentRunner:
    """Active multi-turn agent dispatch loop that halts inference on tool detection,
    executes functions locally, and returns grounded context back to Ollama.
    """

    def __init__(
        self,
        model: str = "llama3.1:8b",
        ollama_url: str = "http://127.0.0.1:11434",
        timezone: str = "Asia/Kolkata",
        timeout: int = 120,
    ) -> None:
        self.model = model
        self.ollama_url = ollama_url.rstrip("/")
        self.timezone = timezone
        self.timeout = timeout
        self.tool_registry: dict[str, Callable[..., Any]] = {
            "get_current_datetime": get_current_datetime,
        }
        self.available_tools = [GET_CURRENT_DATETIME_TOOL_SCHEMA]

    def _post_chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Sends an HTTP POST request to Ollama's /api/chat endpoint."""
        endpoint = f"{self.ollama_url}/api/chat"
        data_bytes = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data_bytes,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as err:
            raise RuntimeError(
                f"Failed to communicate with Ollama at {endpoint}: {err}. "
                "Ensure Ollama is running (`ollama serve`)."
            ) from err

    def run(self, user_prompt: str, max_iterations: int = 3) -> dict[str, Any]:
        """Executes a multi-turn agent conversation turn until convergence or max_iterations."""
        system_prompt = build_hardened_system_prompt(self.timezone)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        tool_history: list[dict[str, Any]] = []
        iteration = 0

        while iteration < max_iterations:
            iteration += 1

            # Native tool passing: tools array passed directly in payload, NOT in prompt text
            payload = {
                "model": self.model,
                "messages": messages,
                "tools": self.available_tools,
                "stream": False,
                "options": {
                    "temperature": 0.0,
                },
            }

            response_data = self._post_chat(payload)
            msg = response_data.get("message", {})
            raw_tool_calls = msg.get("tool_calls")

            if not raw_tool_calls:
                # No tools requested: model produced final direct synthesis
                messages.append(msg)
                return {
                    "final_response": msg.get("content", "").strip(),
                    "messages": messages,
                    "tool_history": tool_history,
                    "iterations": iteration,
                }

            # Interception & Halting:
            # Model emitted structured tool calls. Append assistant turn to context.
            assistant_turn = {
                "role": "assistant",
                "content": msg.get("content", ""),
                "tool_calls": raw_tool_calls,
            }
            messages.append(assistant_turn)

            # Local Execution & Injection
            for tc in raw_tool_calls:
                func_obj = tc.get("function", {})
                func_name = func_obj.get("name", "")
                raw_args = func_obj.get("arguments", {})

                # Defensive argument deserialization
                if isinstance(raw_args, str):
                    try:
                        args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        args = {}
                elif isinstance(raw_args, dict):
                    args = raw_args
                else:
                    args = {}

                # Execute inside try/except block
                try:
                    if func_name in self.tool_registry:
                        tool_fn = self.tool_registry[func_name]
                        tool_result = tool_fn(**args) if args else tool_fn()
                    else:
                        tool_result = {
                            "status": "error",
                            "error": f"Tool '{func_name}' is not registered in harness.",
                        }
                except Exception as exc:
                    tool_result = {
                        "status": "error",
                        "error": f"Tool execution failed: {str(exc)}",
                    }

                tool_history.append({
                    "name": func_name,
                    "arguments": args,
                    "output": tool_result,
                })

                # Append execution output conforming to Ollama/OpenAI standard
                tool_msg = {
                    "role": "tool",
                    "content": json.dumps(tool_result),
                    "name": func_name,
                }
                messages.append(tool_msg)

        # In case max_iterations reached with trailing tool call, perform a final synthesis pass
        final_payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.0},
        }
        final_data = self._post_chat(final_payload)
        final_text = final_data.get("message", {}).get("content", "").strip()
        messages.append({"role": "assistant", "content": final_text})

        return {
            "final_response": final_text,
            "messages": messages,
            "tool_history": tool_history,
            "iterations": iteration,
        }


# ==============================================================================
# 4. Automated Verification Test Suite
# ==============================================================================

def run_tests() -> bool:
    """Executes the 3 verification tests against Ollama and asserts correctness."""
    runner = OllamaAgentRunner(model="llama3.1:8b", timezone="Asia/Kolkata")
    system_date = datetime.datetime.now().strftime("%Y-%m-%d")
    system_day = datetime.datetime.now().strftime("%A")

    print("\n" + "=" * 70)
    print("STARTING AUTOMATED HARNESS VERIFICATION SUITE (Llama 3.1 8B via Ollama)")
    print("=" * 70)

    # --------------------------------------------------------------------------
    # Test 1: Real tool execution vs. hallucination
    # --------------------------------------------------------------------------
    q1 = "What day of the week is it today?"
    print(f"\n[TEST 1] Query: \"{q1}\"")
    r1 = runner.run(q1)

    print(f"Tool Invocations : {len(r1['tool_history'])}")
    for t in r1['tool_history']:
        print(f"  -> Called: {t['name']}({t['arguments']}) => {t['output']}")
    print(f"Assistant Output :\n{r1['final_response']}\n")

    # Assertions for Test 1
    assert len(r1["tool_history"]) >= 1, "Test 1 Failed: Expected tool 'get_current_datetime' to be invoked."
    assert r1["tool_history"][0]["name"] == "get_current_datetime"
    assert system_day.lower() in r1["final_response"].lower(), (
        f"Test 1 Failed: Expected '{system_day}' in output, got: {r1['final_response']}"
    )
    assert "{" not in r1["final_response"] or "}" not in r1["final_response"], (
        "Test 1 Failed: Raw JSON block was leaked to user chat."
    )
    print("[PASS] Test 1: Verified real tool execution and grounded synthesis without hallucination.")

    # --------------------------------------------------------------------------
    # Test 2: Current time in UTC versus local time
    # --------------------------------------------------------------------------
    q2 = "What is the current time in UTC versus local time?"
    print(f"\n[TEST 2] Query: \"{q2}\"")
    r2 = runner.run(q2)

    print(f"Tool Invocations : {len(r2['tool_history'])}")
    for t in r2['tool_history']:
        print(f"  -> Called: {t['name']}({t['arguments']}) => {t['output']}")
    print(f"Assistant Output :\n{r2['final_response']}\n")

    # Assertions for Test 2
    assert len(r2["tool_history"]) >= 1, "Test 2 Failed: Expected temporal tool call."
    assert "utc" in r2["final_response"].lower(), "Test 2 Failed: Output should discuss UTC time."
    print("[PASS] Test 2: Verified timezone-aware tool execution and comparison.")

    # --------------------------------------------------------------------------
    # Test 3: General conversational query (No tool invocation)
    # --------------------------------------------------------------------------
    q3 = "Explain the difference between synchronous and asynchronous execution in one concise paragraph."
    print(f"\n[TEST 3] Query: \"{q3}\"")
    r3 = runner.run(q3)

    print(f"Tool Invocations : {len(r3['tool_history'])}")
    print(f"Assistant Output :\n{r3['final_response']}\n")

    # Assertions for Test 3
    assert len(r3["tool_history"]) == 0, (
        f"Test 3 Failed: No tools should be called for generic concepts, but got: {r3['tool_history']}"
    )
    assert len(r3["final_response"]) > 30, "Test 3 Failed: Expected meaningful explanation."
    print("[PASS] Test 3: Verified direct conversational response with zero unnecessary tool calls.")

    print("\n" + "=" * 70)
    print("ALL 3 AUTOMATED TESTS PASSED SUCCESSFULLY!")
    print("=" * 70 + "\n")
    return True


if __name__ == "__main__":
    try:
        run_tests()
    except AssertionError as err:
        print(f"\n[ASSERTION FAILED]: {err}", file=sys.stderr)
        sys.exit(1)
    except Exception as err:
        print(f"\n[EXECUTION ERROR]: {err}", file=sys.stderr)
        sys.exit(1)
