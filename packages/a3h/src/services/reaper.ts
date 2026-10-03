import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

declare module 'cordis' {
  interface Context {
    a3hReaper: ReaperService
  }
  interface Events {
    'a3h/task-reaped'(evt: { taskId: string; leaseExpiresAt?: string | null }): void
  }
}

export class ReaperService extends Service {
  static inject = ['a3hStorage', 'a3hSandbox', 'a3hLSP']

  private timer?: NodeJS.Timeout
  private intervalMs: number

  constructor(ctx: Context, intervalMs = 30_000) {
    super(ctx, 'a3hReaper', true)
    this.intervalMs = intervalMs
  }

  startReaper(intervalMs?: number): void {
    this.stopReaper()
    const int = intervalMs ?? this.intervalMs
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        this.ctx.logger('reaper').error('Reaper sweep failed:', err)
      })
    }, int)
  }

  stopReaper(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async sweep(): Promise<{ reapedTasks: string[]; prunedAllocations: string[] }> {
    const nowIso = new Date().toISOString()
    const reapedTasks: string[] = []
    const prunedAllocations: string[] = []

    if (!this.ctx.a3hStorage) {
      return { reapedTasks, prunedAllocations }
    }

    // 1. Recover Zombie Tasks whose lease expired without a heartbeat update
    const expiredTasks = this.ctx.a3hStorage.getExpiredRunningTasks(nowIso)

    for (const task of expiredTasks) {
      this.ctx.logger('reaper').warn(`Reaping dead task ${task.id} (lease expired at ${task.lease_expires_at})`)

      this.ctx.a3hStorage.updateTask(task.id, {
        status: 'failed',
        failure_reason: 'internal_crash',
      })

      // Force-terminate associated processes and cleanup worktree
      try {
        await this.ctx.a3hSandbox.cleanup(task.id)
      } catch {}

      try {
        if (this.ctx.a3hLSP) {
          this.ctx.a3hLSP.cleanup(task.worktree_path)
        }
      } catch {}

      reapedTasks.push(task.id)
      this.ctx.emit('a3h/task-reaped', { taskId: task.id, leaseExpiresAt: task.lease_expires_at })
    }

    // 2. Prune orphaned git worktrees from host filesystem
    try {
      await execFileAsync('git', ['worktree', 'prune'])
    } catch {
      // Ignore routine prune errors
    }

    // 3. Clean up unallocated or abandoned two-phase allocations older than 5 mins
    const cutoffDate = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const deadAllocations = this.ctx.a3hStorage.getDeadAllocations(cutoffDate)

    for (const alloc of deadAllocations) {
      try {
        await this.ctx.a3hSandbox.cleanup(alloc.task_id)
      } catch {}

      this.ctx.a3hStorage.updateAllocationState(alloc.id, 'pruned')
      prunedAllocations.push(alloc.id)
    }

    return { reapedTasks, prunedAllocations }
  }
}
