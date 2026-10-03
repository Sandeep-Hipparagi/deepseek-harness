/**
 * Lightweight, deterministic date/time tool for LLM agent harness grounding.
 * Provides real-time temporal grounding (day of the week, current calendar date,
 * local time, timezone, and ISO-8601 timestamps) for local offline/grounded LLMs.
 */

import type { Context } from 'cordis'

export interface GetCurrentDateTimeArgs {
  timezone?: string
  format?: 'full' | 'date_only' | 'time_only' | string
}

export interface DateTimeResult {
  date_and_time: string
  iso_timestamp: string
  day_of_week: string
  date: string
  time: string
  timezone: string
  formatted?: string
  warning?: string
  status?: 'success' | 'error'
  message?: string
}

/**
 * Sanitizes and normalizes incoming arguments from local LLM tool calls.
 * Handles stringified JSON, unescaped characters, single-quoted JSON,
 * and common hallucinated argument aliases (e.g. tz, time_zone, fmt).
 */
export function sanitizeDateTimeArgs(raw: unknown): {
  args?: GetCurrentDateTimeArgs
  error?: string
} {
  if (raw === undefined || raw === null || raw === '') {
    return { args: {} }
  }

  let parsed: any = raw

  // Handle stringified arguments (common with Ollama / local models)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '{}' || trimmed === '[]') {
      return { args: {} }
    }

    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Attempt recovery: single quotes to double quotes
      try {
        const normalizedJson = trimmed
          .replace(/'/g, '"')
          .replace(/,\s*([}\]])/g, '$1')
        parsed = JSON.parse(normalizedJson)
      } catch {
        // Regex recovery for common key-value patterns (e.g., timezone="UTC")
        const tzMatch = trimmed.match(/['"]?(?:timezone|tz|time_zone|zone)['"]?\s*[:=]\s*['"]?([a-z0-9_/+\-]+)['"]?/i)
        const fmtMatch = trimmed.match(/['"]?(?:format|fmt|granularity|style)['"]?\s*[:=]\s*['"]?([a-z0-9_% \-:,\/]+)['"]?/i)

        if (tzMatch || fmtMatch) {
          parsed = {
            timezone: tzMatch ? tzMatch[1] : undefined,
            format: fmtMatch ? fmtMatch[1] : undefined,
          }
        } else {
          return {
            error: 'Invalid arguments payload. Expected JSON object with optional "timezone" and "format" fields.',
          }
        }
      }
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      error: 'Invalid argument type: arguments must be an object with optional "timezone" and "format" properties.',
    }
  }

  // Alias normalization for common model hallucinations
  const timezone =
    parsed.timezone ??
    parsed.tz ??
    parsed.time_zone ??
    parsed.timeZone ??
    parsed.zone

  const format =
    parsed.format ??
    parsed.fmt ??
    parsed.granularity ??
    parsed.style

  const sanitized: GetCurrentDateTimeArgs = {}

  if (typeof timezone === 'string' && timezone.trim().length > 0) {
    sanitized.timezone = timezone.trim()
  }

  if (typeof format === 'string' && format.trim().length > 0) {
    sanitized.format = format.trim()
  }

  return { args: sanitized }
}

/**
 * Formats a custom strftime-style format string using extracted datetime components.
 */
function formatStrftime(
  formatStr: string,
  parts: Record<string, string>,
  dateObj: Date,
  offsetStr: string,
  timeZoneStr: string,
): string {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const shortMonthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const shortDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const monthIdx = parseInt(parts.month || '1', 10) - 1
  const dayOfWeekIdx = dateObj.getDay()
  const hour24 = parseInt(parts.hour || '0', 10)
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const ampm = hour24 >= 12 ? 'PM' : 'AM'

  const replacements: Record<string, string> = {
    '%Y': parts.year || '',
    '%y': (parts.year || '').slice(-2),
    '%m': parts.month || '',
    '%B': monthNames[monthIdx] || '',
    '%b': shortMonthNames[monthIdx] || '',
    '%d': parts.day || '',
    '%A': parts.weekday || '',
    '%a': shortDayNames[dayOfWeekIdx] || '',
    '%H': parts.hour || '',
    '%I': String(hour12).padStart(2, '0'),
    '%M': parts.minute || '',
    '%S': parts.second || '',
    '%p': ampm,
    '%z': offsetStr.replace(':', ''),
    '%Z': timeZoneStr,
  }

  let formatted = formatStr
  for (const [token, val] of Object.entries(replacements)) {
    formatted = formatted.split(token).join(val)
  }
  return formatted
}

/**
 * Core deterministic datetime calculator.
 * Gracefully resolves IANA timezones, falls back to system timezone on error,
 * and formats structured JSON.
 */
export function getCurrentDateTime(rawArgs?: unknown): DateTimeResult {
  const { args, error } = sanitizeDateTimeArgs(rawArgs)

  if (error) {
    return {
      status: 'error',
      message: `${error} Available format: IANA timezone string (e.g., 'UTC', 'Asia/Kolkata', 'America/New_York').`,
      date_and_time: 'Not Provided',
      iso_timestamp: new Date().toISOString(),
      day_of_week: 'Not Provided',
      date: 'Not Provided',
      time: 'Not Provided',
      timezone: 'UTC',
    }
  }

  const now = new Date()
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  let targetTz = (args?.timezone || '').trim() || systemTz
  let warning: string | undefined

  // Validate target timezone; fallback to system local time gracefully
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: targetTz }).format(now)
  } catch {
    warning = `Invalid timezone identifier '${targetTz}'. Falling back to system timezone '${systemTz}'.`
    targetTz = systemTz
  }

  // Extract timezone-accurate parts
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: targetTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
    timeZoneName: 'longOffset',
  })

  const parts: Record<string, string> = {}
  dtf.formatToParts(now).forEach((p) => {
    parts[p.type] = p.value
  })

  // Calculate UTC offset string: "+05:30", "-04:00", "+00:00"
  let offset = (parts.timeZoneName || '').replace('GMT', '')
  if (!offset) {
    offset = '+00:00'
  } else if (/^[+-]\d{1,2}$/.test(offset)) {
    offset = offset.slice(0, 1) + offset.slice(1).padStart(2, '0') + ':00'
  } else if (/^[+-]\d{1,2}:\d{2}$/.test(offset)) {
    const sign = offset[0]
    const [h, m] = offset.slice(1).split(':')
    offset = sign + h.padStart(2, '0') + ':' + m
  }

  const dateStr = (parts.year && parts.month && parts.day)
    ? `${parts.year}-${parts.month}-${parts.day}`
    : 'Not Provided'
  const timeStr = (parts.hour && parts.minute && parts.second)
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : 'Not Provided'
  const isoStr = (dateStr !== 'Not Provided' && timeStr !== 'Not Provided')
    ? `${dateStr}T${timeStr}${offset}`
    : new Date().toISOString()
  const dateAndTimeStr = (dateStr !== 'Not Provided' && timeStr !== 'Not Provided')
    ? `${dateStr} ${timeStr}`
    : 'Not Provided'
  const tzResolved = targetTz ? `${targetTz} (UTC${offset})` : 'UTC'

  const result: DateTimeResult = {
    date_and_time: dateAndTimeStr,
    iso_timestamp: isoStr,
    day_of_week: parts.weekday || 'Not Provided',
    date: dateStr,
    time: timeStr,
    timezone: tzResolved,
    status: 'success',
  }

  // Required check: ensure date_and_time is NEVER null or undefined
  if (!result.date_and_time) {
    result.date_and_time = 'Not Provided'
  }

  if (warning) {
    result.warning = warning
  }

  // Handle format granularity or custom format
  const requestedFormat = (args?.format || 'full').toLowerCase()
  if (requestedFormat === 'date_only') {
    result.formatted = `${parts.weekday}, ${dateStr}`
  } else if (requestedFormat === 'time_only') {
    result.formatted = `${timeStr} (${tzResolved})`
  } else if (args?.format && args.format !== 'full') {
    // Custom strftime format provided
    result.formatted = formatStrftime(args.format, parts, now, offset, targetTz)
  }

  return result
}

/**
 * Standard OpenAI / JSON Schema tool definition for get_current_datetime.
 */
export const GET_CURRENT_DATETIME_SCHEMA = {
  name: 'get_current_datetime',
  description:
    'Retrieves the current real-world date, time, weekday, and timezone. ' +
    'MANDATORY tool to call whenever answering questions involving the current time, ' +
    'today\'s calendar date, the day of the week, relative dates (such as "today", "yesterday", "tomorrow", ' +
    '"this week", "next Tuesday"), or when scheduling reminders. Do NOT guess or hallucinate the date or time.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'Optional IANA timezone identifier (e.g., "Asia/Kolkata", "UTC", "America/New_York", "Europe/London"). ' +
          'Defaults to the local system timezone if omitted or empty.',
      },
      format: {
        type: 'string',
        description:
          'Optional desired return granularity or format: "full" (default), "date_only", "time_only", ' +
          'or an explicit strftime format string (e.g. "%Y-%m-%d %H:%M:%S").',
      },
    },
    required: [],
  },
}

/**
 * Registers the get_current_datetime tool and system prompt guidance with the Cordis context.
 */
export function registerDateTimeTool(ctx: Context): void {
  const toolsService = typeof (ctx as any).get === 'function'
    ? ((ctx as any).get('tools') || (ctx as any).tools)
    : (ctx as any).tools
  if (!toolsService || typeof toolsService.register !== 'function') return

  // 1. Inject prompt instruction so model always calls this tool for temporal queries
  const systemPrompt = typeof (ctx as any).get === 'function'
    ? (ctx as any).get('systemPrompt')
    : undefined

  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? (systemPrompt.getSectionOrder('TOOL_READ') ?? 1150)
        : 1150
      systemPrompt.section({
        name: 'tool:get_current_datetime',
        order,
        text:
          'You have access to the `get_current_datetime` tool. You MUST use `get_current_datetime` ' +
          'whenever the user asks about the current date, time, day of the week, or references ' +
          'temporal concepts like "today", "yesterday", "tomorrow", or relative scheduling. ' +
          'When computing relative dates (e.g., "next Tuesday"), ALWAYS use the exact `date` (YYYY-MM-DD) ' +
          'and year returned by the tool as the reference baseline. Never guess or rely on pre-training cutoff years.',
      })
    } catch {
      // Non-fatal if systemPrompt section registration fails
    }
  }

  // 2. Register the tool definition and runtime executor with try-catch and required checks
  const toolDef = {
    name: GET_CURRENT_DATETIME_SCHEMA.name,
    description: GET_CURRENT_DATETIME_SCHEMA.description,
    parameters: GET_CURRENT_DATETIME_SCHEMA.parameters,
    output: {
      schema: { type: 'object' },
      render: (_args: any, value: any) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        },
      ],
    },
    async execute(args: any) {
      try {
        const result = getCurrentDateTime(args)
        // Explicit required check to prevent null/undefined runtime crashes
        if (!result.date_and_time) {
          result.date_and_time = 'Not Provided'
        }
        return result
      } catch (err: any) {
        return {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          date_and_time: 'Not Provided',
          date: 'Not Provided',
          time: 'Not Provided',
          day_of_week: 'Not Provided',
          iso_timestamp: new Date().toISOString(),
          timezone: 'UTC',
        }
      }
    },
  }

  // Register primary tool: get_current_datetime
  toolsService.register(toolDef)

  // Register explicit alias tool: date_and_time
  toolsService.register({
    ...toolDef,
    name: 'date_and_time',
    description: 'Retrieves current date and time. Alias for get_current_datetime.',
  })
}
