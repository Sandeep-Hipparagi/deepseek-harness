import { Context, Service } from 'cordis'

export interface TurnMetric {
  turnIndex: number
  promptTokens: number
  completionTokens: number
  toolDurationMs: number
}

declare module 'cordis' {
  interface Context {
    a3hTelemetry: TelemetryService
  }
  interface Events {
    'a3h/telemetry-turn'(evt: {
      taskId: string
      turnIndex: number
      promptTokens: number
      completionTokens: number
      toolDurationMs: number
      timestamp: Date
    }): void
    'a3h/telemetry-tool'(evt: {
      taskId: string
      toolName: string
      durationMs: number
      success: boolean
      timestamp: Date
    }): void
  }
}

export class TelemetryService extends Service {
  static inject = ['a3hStorage']

  constructor(ctx: Context) {
    super(ctx, 'a3hTelemetry', true)
  }

  recordTurnMetric(taskId: string, metric: TurnMetric) {
    const timestamp = new Date()
    this.ctx.emit('a3h/telemetry-turn', { taskId, ...metric, timestamp })
    try {
      this.ctx.a3hStorage?.recordTurnLog(
        taskId,
        metric.turnIndex,
        'assistant',
        undefined,
        { metric },
      )
    } catch {}
  }

  recordToolExecution(
    taskId: string,
    toolName: string,
    durationMs: number,
    success: boolean,
    args?: Record<string, any>,
    output?: string,
  ) {
    const timestamp = new Date()
    this.ctx.emit('a3h/telemetry-tool', {
      taskId,
      toolName,
      durationMs,
      success,
      timestamp,
    })
    try {
      this.ctx.a3hStorage?.recordToolExecution(
        `exec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        taskId,
        toolName,
        args || {},
        output,
        success ? 0 : 1,
        durationMs,
      )
    } catch {}
  }
}
