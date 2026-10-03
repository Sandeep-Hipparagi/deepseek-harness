"""Comprehensive unit and integration test suite for the local harness guardrails."""

import json
import re
import unittest
from typing import Any

from local_harness.clock import (
    GET_CURRENT_DATETIME_SCHEMA,
    WEB_SEARCH_SCHEMA,
    get_current_datetime,
)
from local_harness.engine import HarnessEngine
from local_harness.json_guard import (
    JSON_OBJECT_GBNF,
    build_json_syntax_error_message,
    repair_json_string,
)
from local_harness.prompt import (
    HARDENED_SYSTEM_PROMPT_TEMPLATE,
    SystemPromptManager,
)
from local_harness.tools import (
    ToolRegistry,
    ToolResult,
    WebProviderError,
)


class TestTask1GroundedClock(unittest.TestCase):
    """Verifies Task 1: Deterministic offline temporal grounding and session injection."""

    def test_get_current_datetime_structure(self):
        result = get_current_datetime(timezone="Asia/Kolkata")

        # Verify required structured keys
        self.assertIn("iso_timestamp", result)
        self.assertIn("date", result)
        self.assertIn("time_24h", result)
        self.assertIn("day_of_week", result)
        self.assertIn("timezone", result)
        self.assertIn("date_and_time", result)
        self.assertEqual(result["status"], "success")

        # Verify exact formats
        self.assertRegex(result["date"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertRegex(result["time_24h"], r"^\d{2}:\d{2}:\d{2}$")
        self.assertIn(
            result["day_of_week"],
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        )
        self.assertIn("Asia/Kolkata", result["timezone"])
        self.assertTrue(result["iso_timestamp"].endswith("+05:30") or "+05:30" in result["iso_timestamp"])

    def test_timezone_fallbacks(self):
        # Valid UTC
        utc_res = get_current_datetime(timezone="UTC")
        self.assertTrue(utc_res["iso_timestamp"].endswith("+00:00") or "+00:00" in utc_res["iso_timestamp"])
        self.assertNotIn("warning", utc_res)

        # Invalid timezone identifier falls back gracefully with warning
        bad_tz = get_current_datetime(timezone="Invalid/Nonexistent_Timezone")
        self.assertIn("warning", bad_tz)
        self.assertIn("Invalid timezone", bad_tz["warning"])
        self.assertRegex(bad_tz["date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_tool_schema_differentiation(self):
        # Ensure schema cleanly differentiates temporal clock vs web search
        self.assertIn("get_current_datetime", GET_CURRENT_DATETIME_SCHEMA["name"])
        self.assertIn("real-world date", GET_CURRENT_DATETIME_SCHEMA["description"])
        self.assertIn("Do NOT guess", GET_CURRENT_DATETIME_SCHEMA["description"])

        self.assertIn("web_search", WEB_SEARCH_SCHEMA["name"])
        self.assertIn("STRICT RESTRICTION: Do NOT use this tool for questions regarding the current date", WEB_SEARCH_SCHEMA["description"])


class TestTask2ConstrainedDecodingAndJsonRepair(unittest.TestCase):
    """Verifies Task 2: GBNF grammar specification, multi-stage JSON repair, and self-correction."""

    def test_gbnf_grammar_presence(self):
        self.assertIn("root   ::= object", JSON_OBJECT_GBNF)
        self.assertIn("string \":\" ws value", JSON_OBJECT_GBNF)

    def test_valid_json_untouched(self):
        data, repaired, err = repair_json_string('{"queries": ["deepseek", "llama"]}')
        self.assertEqual(data, {"queries": ["deepseek", "llama"]})
        self.assertFalse(repaired)
        self.assertIsNone(err)

    def test_repair_missing_colon_before_nested_object(self):
        # Current bug: "parameters{"queries": ...}
        malformed = '{"parameters"{"queries": ["release notes"]}}'
        data, repaired, err = repair_json_string(malformed)
        self.assertTrue(repaired)
        self.assertIsNone(err)
        self.assertEqual(data, {"parameters": {"queries": ["release notes"]}})

    def test_repair_missing_colon_before_array(self):
        malformed = '{"queries" ["local harness", "llama"]}'
        data, repaired, err = repair_json_string(malformed)
        self.assertTrue(repaired)
        self.assertIsNone(err)
        self.assertEqual(data, {"queries": ["local harness", "llama"]})

    def test_repair_markdown_code_fences(self):
        fenced = "```json\n{\n  \"timezone\": \"Asia/Kolkata\"\n}\n```"
        data, repaired, err = repair_json_string(fenced)
        self.assertTrue(repaired)
        self.assertIsNone(err)
        self.assertEqual(data, {"timezone": "Asia/Kolkata"})

    def test_repair_single_quotes(self):
        single_quoted = "{'queries': ['deepseek r1', 'ollama']}"
        data, repaired, err = repair_json_string(single_quoted)
        self.assertTrue(repaired)
        self.assertIsNone(err)
        self.assertEqual(data, {"queries": ["deepseek r1", "ollama"]})

    def test_repair_unquoted_keys_and_trailing_commas(self):
        sloppy = "{timezone: 'UTC', format: 'date_only',}"
        data, repaired, err = repair_json_string(sloppy)
        self.assertTrue(repaired)
        self.assertIsNone(err)
        self.assertEqual(data.get("timezone"), "UTC")

    def test_unrecoverable_json_generates_self_correction_feedback(self):
        garbage = "completely broken garbage [[[[{{"
        data, repaired, err = repair_json_string(garbage)
        self.assertIsNone(data)
        self.assertFalse(repaired)
        self.assertIsNotNone(err)

        # Generate structured self-correction feedback message
        feedback = build_json_syntax_error_message(
            tool_call_id="call_99",
            tool_name="web_search",
            raw_payload=garbage,
            error_detail=err,
        )
        self.assertEqual(feedback["role"], "tool")
        self.assertEqual(feedback["tool_call_id"], "call_99")
        parsed_feedback = json.loads(feedback["content"])
        self.assertEqual(parsed_feedback["error"], "INVALID_JSON_SYNTAX")
        self.assertEqual(parsed_feedback["status"], "error")
        self.assertIn("Re-emit valid JSON", parsed_feedback["message"])


class TestTask3ErrorMaskingAndFallbacks(unittest.TestCase):
    """Verifies Task 3: Error masking, standard return schema, and provider exception shielding."""

    def setUp(self):
        self.registry = ToolRegistry()

    def test_standard_success_schema(self):
        result = self.registry.dispatch("get_current_datetime", {"timezone": "Asia/Kolkata"})
        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.status, "success")
        self.assertIsNone(result.error_code)
        self.assertIn("date", result.data)

    def test_web_provider_error_masking(self):
        # Register a failing web search handler that raises WebProviderError
        def failing_search(queries):
            raise WebProviderError("HTTP 502 Bad Gateway from upstream search cluster at 10.0.4.15:8080")

        self.registry.register(
            name="failing_web_search",
            schema=WEB_SEARCH_SCHEMA,
            handler=failing_search,
        )

        result = self.registry.dispatch("failing_web_search", {"queries": ["test"]})
        self.assertEqual(result.status, "error")
        self.assertEqual(result.error_code, "WEB_PROVIDER_ERROR")

        # Verify internal stack trace and cluster IPs are strictly masked
        self.assertNotIn("10.0.4.15", str(result.data))
        self.assertNotIn("HTTP 502", str(result.data))
        self.assertIn("provider is currently unavailable", result.data)
        self.assertIn("Do NOT output technical stack traces", result.data)

    def test_unhandled_generic_exception_masking(self):
        def crashing_tool():
            raise ZeroDivisionError("division by zero in internal calc pipeline")

        self.registry.register(
            name="crashing_tool",
            schema={"name": "crashing_tool", "parameters": {"type": "object"}},
            handler=crashing_tool,
        )

        result = self.registry.dispatch("crashing_tool", {})
        self.assertEqual(result.status, "error")
        self.assertEqual(result.error_code, "TOOL_EXECUTION_ERROR")
        self.assertNotIn("ZeroDivisionError", str(result.data))
        self.assertIn("Please inform the user gracefully", result.data)


class TestTask4SystemPromptHardening(unittest.TestCase):
    """Verifies Task 4: Immutable identity metadata and dynamic temporal session stamping."""

    def test_system_prompt_identity_assertion(self):
        mgr = SystemPromptManager(
            model_name="Llama-3.1-8B-Instruct",
            model_architecture="Causal Decoder-Only Autoregressive Transformer",
            model_parameters="8 Billion Parameters",
        )
        prompt = mgr.inject_session_header(timezone="Asia/Kolkata")

        # Identity checks
        self.assertIn("Llama-3.1-8B-Instruct", prompt)
        self.assertIn("Causal Decoder-Only Autoregressive Transformer", prompt)
        self.assertIn("8 Billion Parameters", prompt)

        # Anti-hallucination checks
        self.assertIn("strictly a causal autoregressive language model", prompt)
        self.assertIn("NOT BERT", prompt)
        self.assertIn("NEVER claim to be BERT", prompt)
        self.assertIn("fixed runtime characteristics", prompt)

        # Tool directives
        self.assertIn("NEVER call `web_search` for current calendar facts", prompt)
        self.assertIn("NEVER output raw JSON tool call blocks", prompt)

    def test_dynamic_temporal_stamping(self):
        mgr = SystemPromptManager()
        prompt = mgr.inject_session_header(timezone="Asia/Kolkata")

        # Verify dynamic slot replacement
        self.assertNotIn("{{current_date}}", prompt)
        self.assertNotIn("{{day_of_week}}", prompt)
        self.assertNotIn("{{iso_timestamp}}", prompt)
        self.assertRegex(prompt, r"Current Calendar Date: \d{4}-\d{2}-\d{2}")
        self.assertRegex(prompt, r"Current 24-Hour Time:  \d{2}:\d{2}:\d{2}")


class TestEndToEndEngineExecution(unittest.TestCase):
    """Verifies full HarnessEngine turn with JSON repair, tool dispatch, and error masking."""

    def test_engine_turn_with_json_repair_and_temporal_grounding(self):
        engine = HarnessEngine()

        # Mock model caller that initially emits a malformed tool call
        call_count = 0

        def mock_model(messages, tool_schemas):
            nonlocal call_count
            call_count += 1

            if call_count == 1:
                # Step 1: Model emits malformed JSON tool call (missing colon)
                return {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_clock_1",
                            "type": "function",
                            "function": {
                                "name": "get_current_datetime",
                                "arguments": '{"timezone" "Asia/Kolkata"}',  # Missing colon!
                            },
                        }
                    ],
                }
            else:
                # Step 2: Final synthesis using grounded context
                # Find tool response in history
                tool_msg = next((m for m in messages if m.get("role") == "tool"), {})
                tool_content = json.loads(tool_msg.get("content", "{}"))
                current_day = tool_content.get("data", {}).get("day_of_week", "Friday")
                return {
                    "role": "assistant",
                    "content": f"Today is {current_day}.",
                }

        initial_messages = [{"role": "user", "content": "What day is today?"}]
        result = engine.execute_turn(initial_messages, mock_model)

        self.assertEqual(result["final_content"], "Today is Friday.")

        # Verify tool events logged the repair and execution
        event_types = [e["type"] for e in result["tool_events"]]
        self.assertIn("json_repaired", event_types)
        self.assertIn("tool_executed", event_types)

        # Verify system prompt was injected as message 0 with fresh date
        first_msg = result["messages"][0]
        self.assertEqual(first_msg["role"], "system")
        self.assertIn("Current Calendar Date", first_msg["content"])


if __name__ == "__main__":
    unittest.main()
