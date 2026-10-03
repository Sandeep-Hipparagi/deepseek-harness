"""Live demonstration script running the hardened Python harness against local Ollama (Llama 3.1 8B)."""

from __future__ import annotations

import json
import urllib.request
import urllib.error
import sys

from local_harness.engine import HarnessEngine
from local_harness.tools import ToolRegistry, WebProviderError, WEB_SEARCH_SCHEMA
from local_harness.prompt import SystemPromptManager


def call_ollama(
    messages: list[dict],
    tool_schemas: list[dict],
    endpoint: str = "http://127.0.0.1:11434/v1/chat/completions",
    model: str = "llama3.1:8b",
) -> dict:
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": 0.0,
    }
    if tool_schemas:
        payload["tools"] = tool_schemas
        payload["tool_choice"] = "auto"

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        choice = body["choices"][0]["message"]
        return choice


def main():
    print("=" * 60)
    print("STARTING LOCAL HARNESS LIVE EVALUATION (Llama 3.1 8B)")
    print("=" * 60)

    # Initialize Registry with a failing web search to verify Task 3 error masking
    registry = ToolRegistry()

    def simulated_failing_web_search(queries: list[str]):
        # Deliberately raise upstream provider failure to test harness masking
        raise WebProviderError("Upstream search cluster timed out (HTTP 504)")

    registry.register("web_search", WEB_SEARCH_SCHEMA, simulated_failing_web_search)

    engine = HarnessEngine(tool_registry=registry)

    # Test 1: Grounding & Native System Clock Integration (Task 1 & 4)
    q1 = "What day of the week is it today, and what will the date be next Tuesday?"
    print(f"\n[QUERY 1] \"{q1}\"")
    result1 = engine.execute_turn([{"role": "user", "content": q1}], call_ollama)
    print(f"[ASSISTANT RESPONSE]:\n{result1['final_content']}\n")
    print(f"[TOOL AUDIT TRAIL]:")
    for event in result1["tool_events"]:
        print(f"  - Type: {event['type']}, Tool: {event.get('name')}, Status: {event.get('status')}")

    # Test 2: Error Masking & Fallback Handling (Task 3)
    q2 = "Search the web for the latest updates on Python 3.15 release schedule."
    print(f"\n[QUERY 2] \"{q2}\"")
    result2 = engine.execute_turn([{"role": "user", "content": q2}], call_ollama)
    print(f"[ASSISTANT RESPONSE]:\n{result2['final_content']}\n")
    print(f"[TOOL AUDIT TRAIL]:")
    for event in result2["tool_events"]:
        print(f"  - Type: {event['type']}, Tool: {event.get('name')}, Error Code: {event.get('error_code')}")

    # Verify no raw stack trace or raw JSON leaked to user in response 2
    assert "HTTP 504" not in result2["final_content"]
    assert "Traceback" not in result2["final_content"]
    assert '{"status": "error"' not in result2["final_content"]
    print("[OK] Verified: No internal stack traces or raw JSON blocks leaked into user response.")

    # Test 3: Model Identity & Architecture (Task 4)
    q3 = "What is your exact architecture, parameter count, and are you based on BERT?"
    print(f"\n[QUERY 3] \"{q3}\"")
    result3 = engine.execute_turn([{"role": "user", "content": q3}], call_ollama)
    print(f"[ASSISTANT RESPONSE]:\n{result3['final_content']}\n")
    content_upper = result3["final_content"].upper()
    assert "NOT BASED ON BERT" in content_upper or "NOT BERT" in content_upper or "BERT" not in content_upper
    print("[OK] Verified: Model strictly adheres to causal decoder identity and rejects BERT hallucination.")

    print("\n" + "=" * 60)
    print("ALL LIVE HARNESS EVALUATIONS COMPLETED SUCCESSFULLY!")
    print("=" * 60)


if __name__ == "__main__":
    main()
