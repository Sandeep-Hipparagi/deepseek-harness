"""Deterministic, offline system clock grounding and temporal tool definition."""

from __future__ import annotations

import datetime
from typing import Any
import zoneinfo


def get_current_datetime(timezone: str = "Asia/Kolkata") -> dict[str, Any]:
    """Retrieve current calendar date, 24-hour time, weekday, and timezone.

    This function is completely deterministic, local, and offline. It does not
    make network requests. If an invalid or unrecognized IANA timezone is
    supplied, it gracefully falls back to the local system timezone with a warning.

    Returns:
        dict containing:
            - iso_timestamp: Full ISO-8601 string (e.g. 2026-10-02T18:11:01+05:30)
            - date: Calendar date in YYYY-MM-DD format
            - time_24h: 24-hour clock time in HH:MM:SS format
            - day_of_week: Full weekday name (Monday..Sunday)
            - timezone: Resolved IANA timezone name and UTC offset
            - date_and_time: Combined YYYY-MM-DD HH:MM:SS string
    """
    warning = None
    target_tz = timezone.strip() if timezone and timezone.strip() else "UTC"

    try:
        tz = zoneinfo.ZoneInfo(target_tz)
    except Exception:
        # Fallback to local system timezone
        local_tz = datetime.datetime.now().astimezone().tzinfo
        tz = local_tz if local_tz is not None else datetime.timezone.utc
        warning = f"Invalid timezone identifier '{target_tz}'. Falling back to system timezone."

    now = datetime.datetime.now(tz=tz)

    # Calculate UTC offset string: +05:30, -04:00, +00:00
    utc_offset = now.strftime("%z")
    if utc_offset and len(utc_offset) == 5:
        formatted_offset = f"UTC{utc_offset[:3]}:{utc_offset[3:]}"
    elif utc_offset:
        formatted_offset = f"UTC{utc_offset}"
    else:
        formatted_offset = "UTC+00:00"

    tz_str = f"{target_tz} ({formatted_offset})" if not warning else f"{str(tz)} ({formatted_offset})"
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")

    result: dict[str, Any] = {
        "status": "success",
        "iso_timestamp": now.isoformat(),
        "date": date_str,
        "time_24h": time_str,
        "day_of_week": now.strftime("%A"),
        "timezone": tz_str,
        "date_and_time": f"{date_str} {time_str}",
    }

    if warning:
        result["warning"] = warning

    # Defensive invariant: ensure date_and_time is always populated
    if not result.get("date_and_time"):
        result["date_and_time"] = "Not Provided"

    return result


GET_CURRENT_DATETIME_SCHEMA: dict[str, Any] = {
    "name": "get_current_datetime",
    "description": (
        "Retrieves the current real-world date, 24-hour time, day of the week, and timezone. "
        "MANDATORY tool to call whenever answering questions involving the current time, "
        "today's calendar date, the day of the week, relative dates (such as 'today', 'yesterday', "
        "'tomorrow', 'this week', 'next Tuesday'), or when scheduling reminders. "
        "Do NOT guess, hallucinate, or call external web search for current calendar date or time."
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
            "format": {
                "type": "string",
                "description": "Optional format granularity: 'full', 'date_only', 'time_only'.",
                "default": "full",
            },
        },
        "required": [],
    },
}

WEB_SEARCH_SCHEMA: dict[str, Any] = {
    "name": "web_search",
    "description": (
        "Performs an external web search for public knowledge, documentation, or news. "
        "STRICT RESTRICTION: Do NOT use this tool for questions regarding the current date, "
        "current time, day of the week, or local calendar scheduling. Use get_current_datetime instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of search queries to execute on the web.",
            },
        },
        "required": ["queries"],
    },
}
