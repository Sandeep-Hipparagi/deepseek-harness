import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ConflictResolver } from './resolver.js'
import { ReconciliationRecord } from '../storage/db.js'

const execFileAsync = promisify(execFile)

declare module 'cordis' {
  interface Context {
    a3hReconciliation: ReconciliationService
  }
  interface Events {
    'a3h/conflict-escalated'(evt: { taskId: string }): void
    'a3h/reconciliation-failed'(evt: { taskId: string; reason?: string }): void
    'a3h/task-landed'(evt: { taskId: string }): void
  }
}

export class ReconciliationService extends Service {
  static inject = ['a3hStorage', 'a3hSandbox', 'a3hVerification']

  private isProcessing = false
  private stagingPath: string | null = null
  private resolverFnOverride?: (
    filePath: string,
    content: string,
    turn: number,
  ) => Promise<string | null> | (string | null)

  constructor(ctx: Context) {
    super(ctx, 'a3hReconciliation', true)
  }

  setCustomResolver(
    fn?: (filePath: string, content: string, turn: number) => Promise<string | null> | (string | null),
  ) {
    this.resolverFnOverride = fn
  }

  private async getGitRoot(): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
    return stdout.trim()
  }

  async getDefaultBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
      const current = stdout.trim()
      if (current && current !== 'HEAD') return current
    } catch {}

    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'main'])
      return 'main'
    } catch {}

    return 'master'
  }

  async getStagingPath(): Promise<string> {
    if (!this.stagingPath) {
      const gitRoot = await this.getGitRoot()
      this.stagingPath = path.resolve(gitRoot, '.worktrees', 'landing-staging')
    }
    return this.stagingPath
  }

  private async ensureStagingWorktree(targetBranch: string): Promise<string> {
    const gitRoot = await this.getGitRoot()
    const stagingPath = await this.getStagingPath()

    await fs.mkdir(path.dirname(stagingPath), { recursive: true })

    let worktreeExists = false
    try {
      await fs.access(stagingPath)
      worktreeExists = true
    } catch {}

    if (!worktreeExists) {
      // Clean up stale worktree or branch if any
      try {
        await execFileAsync('git', ['worktree', 'remove', stagingPath, '--force'])
      } catch {}
      try {
        await execFileAsync('git', ['worktree', 'prune'])
      } catch {}
      try {
        await execFileAsync('git', ['branch', '-D', 'landing-staging'])
      } catch {}

      await execFileAsync('git', ['worktree', 'add', '-B', 'landing-staging', stagingPath, targetBranch])

      // Junction node_modules for compiler access
      const rootNodeModules = path.resolve(gitRoot, 'node_modules')
      const stagingNodeModules = path.resolve(stagingPath, 'node_modules')
      try {
        await fs.symlink(rootNodeModules, stagingNodeModules, 'junction')
      } catch {}
    } else {
      // Ensure node_modules junction exists
      const rootNodeModules = path.resolve(gitRoot, 'node_modules')
      const stagingNodeModules = path.resolve(stagingPath, 'node_modules')
      try {
        await fs.access(stagingNodeModules)
      } catch {
        try {
          await fs.symlink(rootNodeModules, stagingNodeModules, 'junction')
        } catch {}
      }
    }

    return stagingPath
  }

  async enqueueTask(
    taskId: string,
    branchName: string,
    targetBranch?: string,
    testCommand?: string,
  ): Promise<string> {
    const defaultBranch = await this.getDefaultBranch()
    const resolvedTargetBranch = targetBranch || defaultBranch
    const queueId = `rec_${taskId}`

    if (!this.ctx.a3hStorage) {
      return queueId
    }

    this.ctx.a3hStorage.enqueueReconciliation({
      id: queueId,
      task_id: taskId,
      branch_name: branchName,
      target_branch: resolvedTargetBranch,
      test_command: testCommand ?? null,
      queue_status: 'queued',
      resolver_attempts: 0,
    })

    // Non-blocking trigger of the queue processor
    this.processQueue().catch(() => {
      // Background loop errors caught internally
    })

    return queueId
  }

  private processingPromise: Promise<void> | null = null

  async processQueue(): Promise<void> {
    if (!this.ctx.a3hStorage) return
    if (this.processingPromise) {
      return this.processingPromise
    }

    this.processingPromise = (async () => {
      try {
        while (true) {
          const entry = this.ctx.a3hStorage?.getNextQueuedReconciliation()
          if (!entry) break

          this.ctx.a3hStorage?.updateReconciliation(entry.id, {
            queue_status: 'processing',
          })

          await this.attemptReconcile(entry)
        }
      } finally {
        this.processingPromise = null
      }
    })()

    return this.processingPromise
  }

  private async attemptReconcile(entry: ReconciliationRecord): Promise<void> {
    const gitRoot = await this.getGitRoot()
    const stagingPath = await this.ensureStagingWorktree(entry.target_branch)
    const cwd = stagingPath

    // 1. Sync staging with latest target branch
    try {
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd })
      } catch {}
      await execFileAsync('git', ['checkout', '-B', 'landing-staging', entry.target_branch], { cwd })
      await execFileAsync('git', ['reset', '--hard', entry.target_branch], { cwd })
    } catch (syncErr: any) {
      this.ctx.a3hStorage.updateReconciliation(entry.id, {
        queue_status: 'failed',
        resolved_at: new Date().toISOString(),
      })
      this.ctx.emit('a3h/reconciliation-failed', { taskId: entry.task_id, reason: syncErr.message })
      return
    }

    // 2. Attempt non-fast-forward merge
    let hasConflict = false
    try {
      await execFileAsync('git', [
        'merge', '--no-ff', entry.branch_name,
        '-m', `Merge ${entry.branch_name} into staging`,
      ], { cwd })
    } catch {
      hasConflict = true
    }

    if (hasConflict) {
      // 3. Merge conflict encountered: invoke resolver subagent
      const conflictHandled = await this.handleMergeConflict(entry, stagingPath)
      if (!conflictHandled) {
        try {
          await execFileAsync('git', ['merge', '--abort'], { cwd })
        } catch {}

        this.ctx.a3hStorage.updateReconciliation(entry.id, {
          queue_status: 'conflict_escalated',
          resolved_at: new Date().toISOString(),
        })

        this.ctx.emit('a3h/conflict-escalated', { taskId: entry.task_id })
        return // Pick next in queue without blocking
      } else {
        // Staged resolved files, now commit the merge
        try {
          await execFileAsync('git', [
            'commit', '--no-verify', '-m', `Merge ${entry.branch_name} into staging (resolved conflicts)`,
          ], { cwd })
        } catch (commitErr: any) {
          console.error('[RECONCILIATION COMMIT ERROR]:', commitErr.stdout, commitErr.stderr)
          throw commitErr
        }
      }
    }

    // 4. Run Phase 2 Verification on merged staging branch
    const verification = await this.ctx.a3hVerification.verifyTask(
      stagingPath,
      entry.test_command || undefined,
      undefined,
      { skipGhostDiff: true, baseBranch: entry.target_branch },
    )

    if (!verification.passed) {
      // Revert if semantic/test regression detected
      await execFileAsync('git', ['reset', '--hard', entry.target_branch], { cwd })
      this.ctx.a3hStorage.updateReconciliation(entry.id, {
        queue_status: 'failed',
        resolved_at: new Date().toISOString(),
      })
      this.ctx.emit('a3h/reconciliation-failed', { taskId: entry.task_id, reason: verification.reason })
      return
    }

    // 5. Land onto target_branch and clean up
    try {
      const { stdout: rootBranch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitRoot })
      if (rootBranch.trim() === entry.target_branch) {
        await execFileAsync('git', ['merge', '--ff-only', 'landing-staging'], { cwd: gitRoot })
      } else {
        await execFileAsync('git', ['branch', '-f', entry.target_branch, 'landing-staging'], { cwd: gitRoot })
      }
    } catch {
      await execFileAsync('git', ['branch', '-f', entry.target_branch, 'landing-staging'], { cwd: gitRoot })
    }

    // Prune the task branch & worktree
    try {
      await this.ctx.a3hSandbox.cleanup(entry.task_id)
    } catch {}

    this.ctx.a3hStorage.updateReconciliation(entry.id, {
      queue_status: 'merged',
      resolved_at: new Date().toISOString(),
    })

    this.ctx.emit('a3h/task-landed', { taskId: entry.task_id })
  }

  private async handleMergeConflict(entry: ReconciliationRecord, stagingPath: string): Promise<boolean> {
    try {
      const { stdout: conflictOutput } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: stagingPath })
      const conflictFiles = conflictOutput.split(/\r?\n/).map(s => s.trim()).filter(Boolean)

      if (conflictFiles.length === 0) return false

      this.ctx.a3hStorage.updateReconciliation(entry.id, {
        resolver_attempts: entry.resolver_attempts + 1,
      })

      const resolver = new ConflictResolver(stagingPath, 2)
      return await resolver.resolveConflicts(conflictFiles, this.resolverFnOverride)
    } catch {
      return false
    }
  }

  async cleanupStaging(): Promise<void> {
    const stagingPath = await this.getStagingPath()
    try {
      await fs.unlink(path.resolve(stagingPath, 'node_modules'))
    } catch {}
    try {
      await execFileAsync('git', ['worktree', 'remove', stagingPath, '--force'])
    } catch {}
    try {
      await execFileAsync('git', ['worktree', 'prune'])
    } catch {}
    try {
      await execFileAsync('git', ['branch', '-D', 'landing-staging'])
    } catch {}
  }
}
