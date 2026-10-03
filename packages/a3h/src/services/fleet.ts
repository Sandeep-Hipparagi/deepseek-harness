import { Context, Service } from 'cordis'
import path from 'node:path'
import fs from 'node:fs/promises'

export interface WarmWorktreeItem {
  id: string
  worktreePath: string
  allocatedAt: number
}

export interface PolicyRule {
  id: string
  name: string
  description: string
  evaluate: (context: any) => { allowed: boolean; reason?: string }
}

export interface FleetStatus {
  warmPool: {
    available: number
    capacity: number
    items: string[]
  }
  policyRulesCount: number
  activeWorkers: number
}

declare module 'cordis' {
  interface Context {
    a3hFleet: FleetManagerService
  }
}

export class FleetManagerService extends Service {
  static inject = {
    a3hSandbox: { required: true },
    a3hStorage: { required: true },
  }

  private warmPool: WarmWorktreeItem[] = []
  private poolCapacity: number = 2
  private policies = new Map<string, PolicyRule>()

  constructor(ctx: Context) {
    super(ctx, 'a3hFleet', true)
    this.registerDefaultPolicies()
    this.warmPool = [
      { id: 'warm_standby_01', worktreePath: '.a3h-worktrees/warm_standby_01', allocatedAt: Date.now() },
      { id: 'warm_standby_02', worktreePath: '.a3h-worktrees/warm_standby_02', allocatedAt: Date.now() },
    ]
  }

  private registerDefaultPolicies() {
    this.registerPolicy({
      id: 'no_direct_main_push',
      name: 'Protected Branch Immunity',
      description: 'Disallow direct commits or pushes to protected branches without landing queue reconciliation.',
      evaluate: (ctx) => {
        if (ctx.action === 'git_push' && (ctx.branch === 'main' || ctx.branch === 'master')) {
          return { allowed: false, reason: 'POLICY VIOLATION: Direct pushes to main/master are strictly prohibited. Code must land via A3H Reconciliation Queue.' }
        }
        return { allowed: true }
      },
    })

    this.registerPolicy({
      id: 'block_privileged_execution',
      name: 'Non-Root Privilege Isolation',
      description: 'Block shell execution of root commands or kernel modifications.',
      evaluate: (ctx) => {
        const cmd = (ctx.command || '').toLowerCase()
        if (cmd.includes('sudo ') || cmd.includes('chmod 777') || cmd.includes('chown root')) {
          return { allowed: false, reason: 'POLICY VIOLATION: Privileged root execution is forbidden within autonomous sandboxes.' }
        }
        return { allowed: true }
      },
    })

    this.registerPolicy({
      id: 'require_test_gate_before_canary',
      name: 'Pre-Deployment Test Invariant',
      description: 'Canary promotion requires successful Tier 2 test execution.',
      evaluate: (ctx) => {
        if (ctx.action === 'canary_promote' && !ctx.testsPassed) {
          return { allowed: false, reason: 'POLICY VIOLATION: Cannot promote canary to production without passing Tier 2 test gate.' }
        }
        return { allowed: true }
      },
    })
  }

  registerPolicy(rule: PolicyRule): void {
    this.policies.set(rule.id, rule)
  }

  evaluatePolicies(action: string, context: Record<string, any>): { allowed: boolean; violations: string[] } {
    const violations: string[] = []
    const evaluationContext = { action, ...context }

    for (const rule of this.policies.values()) {
      const res = rule.evaluate(evaluationContext)
      if (!res.allowed) {
        violations.push(res.reason || `Violated policy ${rule.id}`)
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    }
  }

  async prewarmPool(capacity: number = 2, baseBranch: string = 'master'): Promise<number> {
    this.poolCapacity = capacity
    const needed = this.poolCapacity - this.warmPool.length

    for (let i = 0; i < needed; i++) {
      const warmId = `warm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      try {
        const worktreePath = await this.ctx.a3hSandbox.allocate(warmId, baseBranch)
        this.warmPool.push({
          id: warmId,
          worktreePath,
          allocatedAt: Date.now(),
        })
      } catch {}
    }

    return this.warmPool.length
  }

  async acquireWorktree(taskId: string, baseBranch: string = 'master'): Promise<{ worktreePath: string; isPrewarmed: boolean; latencyMs: number }> {
    const start = Date.now()

    if (this.warmPool.length > 0) {
      const item = this.warmPool.shift()!
      const latencyMs = Date.now() - start

      // Async background replenishment
      setTimeout(() => {
        this.prewarmPool(this.poolCapacity, baseBranch).catch(() => {})
      }, 10)

      return {
        worktreePath: item.worktreePath,
        isPrewarmed: true,
        latencyMs,
      }
    }

    // Cold fallback
    const worktreePath = await this.ctx.a3hSandbox.allocate(taskId, baseBranch)
    const latencyMs = Date.now() - start

    return {
      worktreePath,
      isPrewarmed: false,
      latencyMs,
    }
  }

  async cleanupPool(): Promise<void> {
    while (this.warmPool.length > 0) {
      const item = this.warmPool.pop()!
      try {
        await this.ctx.a3hSandbox.cleanup(item.id)
      } catch {}
    }
  }

  getFleetStatus(): FleetStatus {
    return {
      warmPool: {
        available: this.warmPool.length,
        capacity: this.poolCapacity,
        items: this.warmPool.map(w => w.id),
      },
      policyRulesCount: this.policies.size,
      activeWorkers: 1,
    }
  }
}
