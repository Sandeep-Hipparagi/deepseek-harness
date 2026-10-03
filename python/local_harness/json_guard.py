"""Constrained decoding grammar, robust multi-stage JSON repair, and self-correction guardrails."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Tuple


# Standard GBNF (GGML BNF) Grammar for strict JSON object generation
# Compatible with llama-server / llama.cpp / Ollama grammar-constrained sampling.
JSON_OBJECT_GBNF: str = r"""
root   ::= object
value  ::= object | array | string | number | ("true" | "false" | "null") ws

object ::=
  "{" ws (
            string ":" ws value
    ("," ws string ":" ws value)*
  )? "}" ws

array  ::=
  "[" ws (
            value
    ("," ws value)*
  )? "]" ws

string ::=
  "\"" (
    [^"\\] |
    "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
  )* "\"" ws

number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws

ws ::= ([ \t\n\r])*
""".strip()


def repair_json_string(raw: str) -> Tuple[Any, bool, str | None]:
    """Attempt robust, multi-stage repair of malformed tool-call JSON strings.

    Handles:
      - Missing colons: '"parameters{"queries": ...}' -> '{"parameters": {"queries": ...}}'
      - Key-value separation without colon: '"queries" ["test"]' -> '"queries": ["test"]'
      - Markdown code blocks: '```json ... ```'
      - Single-quoted strings and keys: "{'queries': ['python']}"
      - Trailing commas: '{"a": 1,}' -> '{"a": 1}'
      - Unquoted keys: '{queries: ["test"]}' -> '{"queries": ["test"]}'
      - Python dict representations (None, True, False)

    Returns:
        (parsed_object, was_repaired, error_message)
        If successfully parsed without edits: (data, False, None)
        If parsed after repair: (data, True, None)
        If unrecoverable: (None, False, error_description)
    """
    if not isinstance(raw, str):
        if isinstance(raw, (dict, list)):
            return raw, False, None
        return None, False, f"Expected string payload, got {type(raw).__name__}"

    trimmed = raw.strip()
    if not trimmed or trimmed in ("{}", "[]"):
        return {}, False, None

    # Step 1: Fast path - standard valid JSON
    try:
        return json.loads(trimmed), False, None
    except json.JSONDecodeError:
        pass

    working = trimmed

    # Step 2: Strip Markdown code blocks
    fence_pattern = r"^```(?:json)?\s*([\s\S]*?)\s*```$"
    fence_match = re.match(fence_pattern, working, re.IGNORECASE)
    if fence_match:
        working = fence_match.group(1).strip()
        try:
            return json.loads(working), True, None
        except json.JSONDecodeError:
            pass

    # Extract JSON object substring if surrounded by conversational filler
    if "{" in working and "}" in working:
        start_idx = working.find("{")
        end_idx = working.rfind("}")
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            working = working[start_idx : end_idx + 1].strip()
            try:
                return json.loads(working), True, None
            except json.JSONDecodeError:
                pass

    # Step 3: Fix missing colons before nested objects
    # e.g., "parameters{"queries": ...} -> "parameters": {"queries": ...}
    working = re.sub(r'("[\w\-]+")\s*(\{)', r'\1: \2', working)

    # e.g., "queries"["test"] -> "queries": ["test"]
    working = re.sub(r'("[\w\-]+")\s*(\[)', r'\1: \2', working)

    # e.g., "key" "value" -> "key": "value"
    working = re.sub(r'("[\w\-]+")\s+("[\s\S]*?")', r'\1: \2', working)

    try:
        return json.loads(working), True, None
    except json.JSONDecodeError:
        pass

    # Step 4: Fix single quotes to double quotes
    # Replace single quotes around keys/values while being careful with internal apostrophes
    try:
        # Check if it parses as a Python literal dict
        py_obj = ast.literal_eval(working)
        if isinstance(py_obj, (dict, list)):
            return py_obj, True, None
    except (ValueError, SyntaxError):
        pass

    single_quote_sub = re.sub(r"(?<=[{\[,:\s])'([^'\\]*(?:\\.[^'\\]*)*)'(?=[\s,}\]:])", r'"\1"', working)
    try:
        return json.loads(single_quote_sub), True, None
    except json.JSONDecodeError:
        working = single_quote_sub

    # Step 5: Fix unquoted keys: {name: "val"} -> {"name": "val"}
    unquoted_keys = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', working)
    try:
        return json.loads(unquoted_keys), True, None
    except json.JSONDecodeError:
        working = unquoted_keys

    # Step 6: Fix trailing commas: {"a": 1,} -> {"a": 1}
    trailing_commas = re.sub(r',\s*([\}\]])', r'\1', working)
    try:
        return json.loads(trailing_commas), True, None
    except json.JSONDecodeError:
        pass

    # Step 7: Optional jsonrepair library integration if present in environment
    try:
        import jsonrepair  # type: ignore
        repaired = jsonrepair.repair_json(trimmed, return_objects=True)
        if isinstance(repaired, (dict, list)):
            return repaired, True, None
    except Exception:
        pass

    # Step 8: Total parse failure
    return None, False, (
        f"Unable to parse malformed JSON after multiple repair heuristics. "
        f"Received payload: '{trimmed[:120]}...'"
    )


def build_json_syntax_error_message(
    tool_call_id: str | None = None,
    tool_name: str | None = None,
    raw_payload: str | None = None,
    error_detail: str | None = None,
) -> dict[str, Any]:
    """Construct structured self-correction system feedback for invalid JSON.

    This message is fed directly back into the context so the model can
    self-correct its generation instead of crashing the harness.
    """
    call_id = tool_call_id or "call_unknown"
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "name": tool_name or "tool_call_validator",
        "content": json.dumps(
            {
                "role": "tool",
                "status": "error",
                "error": "INVALID_JSON_SYNTAX",
                "error_code": "MALFORMED_TOOL_ARGUMENTS",
                "message": "Failed to parse tool call arguments. Re-emit valid JSON matching the schema.",
                "details": error_detail or "Syntax error during JSON deserialization.",
                "raw_received_preview": (raw_payload or "")[:150],
            },
            indent=2,
        ),
    }
