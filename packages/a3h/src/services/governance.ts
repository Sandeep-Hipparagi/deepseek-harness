import { Context, Service } from 'cordis'

export interface BudgetLimits {
  maxTokens: number       // Default: 1,000,000
  maxCostUsd: number      // Default: $5.00
  maxTurns: number        // Default: 30
  maxWallClockMs: number  // Default: 45 minutes
}

declare module 'cordis' {
  interface Context {
    a3hGovernance: GovernanceService
  }
  interface Events {
    'a3h/task-failed'(evt: { taskId: string; reason: string; message: string }): void
    'a3h/circuit-breaker-tripped'(evt: { taskId: string; reason: string; message: string }): void
  }
}

export class GovernanceService extends Service {
  static inject = ['a3hStorage', 'a3hSandbox']

  private limits: BudgetLimits = {
    maxTokens: 1_000_000,
    maxCostUsd: 5.0,
    maxTurns: 30,
    maxWallClockMs: 45 * 60 * 1000,
  }

  private taskLimitOverrides = new Map<string, Partial<BudgetLimits>>()

  constructor(ctx: Context) {
    super(ctx, 'a3hGovernance', true)
  }

  setLimits(limits: Partial<BudgetLimits>) {
    this.limits = { ...this.limits, ...limits }
  }

  setTaskLimits(taskId: string, limits: Partial<BudgetLimits>) {
    this.taskLimitOverrides.set(taskId, limits)
  }

  getLimits(taskId?: string): BudgetLimits {
    if (taskId && this.taskLimitOverrides.has(taskId)) {
      return { ...this.limits, ...this.taskLimitOverrides.get(taskId) }
    }
    return this.limits
  }

  async checkBudgetOrThrow(taskId: string): Promise<void> {
    const task = this.ctx.a3hStorage?.getTask(taskId)
    if (!task) return

    const limits = this.getLimits(taskId)
    const totalTokens = (task.total_prompt_tokens || 0) + (task.total_completion_tokens || 0)
    const cost = Number(task.cumulative_cost_usd || 0)

    let wallClock = 0
    if (task.created_at) {
      const normalized = task.created_at.includes('T')
        ? task.created_at
        : task.created_at.replace(' ', 'T') + 'Z'
      const createdMs = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z').getTime()
      wallClock = Math.max(0, Date.now() - createdMs)
    }

    if (totalTokens >= limits.maxTokens) {
      await this.tripBreaker(taskId, 'budget_exceeded', `Token limit of ${limits.maxTokens} exceeded.`)
    }

    if (cost >= limits.maxCostUsd) {
      await this.tripBreaker(taskId, 'budget_exceeded', `Cost ceiling of $${limits.maxCostUsd} USD reached.`)
    }

    if (task.current_turn >= limits.maxTurns) {
      await this.tripBreaker(taskId, 'budget_exceeded', `Maximum turn threshold (${limits.maxTurns}) reached.`)
    }

    if (wallClock >= limits.maxWallClockMs) {
      await this.tripBreaker(taskId, 'timeout', `Task exceeded maximum duration of ${limits.maxWallClockMs / 60000} minutes.`)
    }
  }

  async tripBreaker(taskId: string, reason: string, message: string): Promise<never> {
    this.ctx.a3hStorage?.updateTask(taskId, {
      status: 'failed',
      failure_reason: reason as any,
    })

    // Teardown sandboxed resources immediately
    try {
      await this.ctx.a3hSandbox?.cleanup(taskId)
    } catch {}

    this.ctx.emit('a3h/task-failed', { taskId, reason, message })
    this.ctx.emit('a3h/circuit-breaker-tripped', { taskId, reason, message })

    throw new Error(`[CIRCUIT BREAKER TRIPPED] ${message}`)
  }
}
