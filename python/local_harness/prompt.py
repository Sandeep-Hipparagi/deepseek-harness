"""Hardened system prompt templates, immutable model architecture specs, and dynamic temporal injectors."""

from __future__ import annotations

from typing import Any, Dict
from .clock import get_current_datetime


HARDENED_SYSTEM_PROMPT_TEMPLATE: str = """[SYSTEM SPECIFICATION & IDENTITY - IMMUTABLE]
You are {{model_name}}, a high-performance local AI assistant running inside a private local harness.
- Architecture: {{model_architecture}}
- Parameter Scale: {{model_parameters}}
- Execution Context: Local offline execution harness with isolated tool dispatch.
- Runtime Distinctions: Your model parameters, weights, and hyperparameters (e.g., context window, temperature) are fixed runtime characteristics. They are NEVER prompt inputs or user variables.
- Anti-Hallucination Directive: You are strictly a causal autoregressive language model. You are NOT BERT, NOT an encoder-only model, and NOT a masked language model. NEVER claim to be BERT or any obsolete architecture.

[TEMPORAL GROUNDING & CURRENT SYSTEM BASELINE]
The local host system clock has stamped the current baseline for this turn:
- Current Calendar Date: {{current_date}} (YYYY-MM-DD)
- Current 24-Hour Time:  {{current_time_24h}} (HH:MM:SS)
- Day of the Week:       {{day_of_week}}
- System Timezone:       {{timezone}}
- Timestamp (ISO-8601):  {{iso_timestamp}}

[TOOL USAGE & EXECUTION DIRECTIVES]
You have access to local grounded tools. You must adhere to the following rules:
1. Temporal vs. Web Queries:
   - For ANY query asking about today's date, current time, day of the week, relative scheduling (e.g., 'yesterday', 'tomorrow', 'next Tuesday', 'in 3 days'), you MUST use the temporal baseline above or call `get_current_datetime`.
   - NEVER call `web_search` for current calendar facts, current time, or local relative dates.
   - Use `web_search` ONLY for external real-world factual information, current news, or documentation lookups.
2. Function Calling Protocol:
   - Tool calls must be emitted exclusively through the designated function-calling mechanism.
   - NEVER output raw JSON tool call blocks, unparsed code fences, or internal schema payloads directly into your conversation with the user.
3. Graceful Error Handling & Fallback:
   - If a tool invocation returns `{"status": "error"}`, technical stack traces and internal provider error codes are strictly masked.
   - In response to a tool error, provide a polite, natural language explanation to the user (e.g., 'I am temporarily unable to search the web right now, but based on what I know...') and NEVER leak raw error objects or code traces into chat.

Your working directory is {{workspace_cwd}}.
"""


class SystemPromptManager:
    """Manages system prompt template interpolation, identity assertion, and dynamic session stamping."""

    def __init__(
        self,
        model_name: str = "Llama-3.1-8B-Instruct",
        model_architecture: str = "Causal Decoder-Only Autoregressive Transformer",
        model_parameters: str = "8 Billion Parameters",
        workspace_cwd: str = ".",
        default_timezone: str = "Asia/Kolkata",
    ) -> None:
        self.model_name = model_name
        self.model_architecture = model_architecture
        self.model_parameters = model_parameters
        self.workspace_cwd = workspace_cwd
        self.default_timezone = default_timezone
        self.template = HARDENED_SYSTEM_PROMPT_TEMPLATE

    def inject_session_header(
        self,
        timezone: str | None = None,
        extra_variables: dict[str, Any] | None = None,
    ) -> str:
        """Dynamically render the hardened system prompt with fresh temporal grounding."""
        tz = timezone or self.default_timezone
        temporal_data = get_current_datetime(timezone=tz)

        variables = {
            "model_name": self.model_name,
            "model_architecture": self.model_architecture,
            "model_parameters": self.model_parameters,
            "workspace_cwd": self.workspace_cwd,
            "current_date": temporal_data["date"],
            "current_time_24h": temporal_data["time_24h"],
            "day_of_week": temporal_data["day_of_week"],
            "timezone": temporal_data["timezone"],
            "iso_timestamp": temporal_data["iso_timestamp"],
        }

        if extra_variables:
            variables.update(extra_variables)

        rendered = self.template
        for key, value in variables.items():
            rendered = rendered.replace(f"{{{{{key}}}}}", str(value))

        return rendered
