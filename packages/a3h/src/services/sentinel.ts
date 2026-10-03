import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export interface IssuePayload {
  id: string
  title: string
  description: string
  source?: 'github' | 'sentry' | 'ci'
  reproductionTest?: {
    filePath: string
    content: string
    testCommand: string
  }
}

export interface TriageResult {
  issueId: string
  reproduced: boolean
  reproductionError?: string
  taskId?: string
  status: 'reproduced_and_dispatched' | 'not_reproducible' | 'fixed_and_merged'
}

export interface FlakySweepReport {
  testCommand: string
  runs: number
  passedRuns: number
  failedRuns: number
  isFlaky: boolean
  failureDetails?: string[]
}

declare module 'cordis' {
  interface Context {
    a3hSentinel: SentinelDaemon
  }
}

export class SentinelDaemon extends Service {
  static inject = ['a3hSandbox', 'a3hStorage', 'a3hReconciliation', 'a3hVerification', 'a3hWorker']

  constructor(ctx: Context) {
    super(ctx, 'a3hSentinel', true)
  }

  async triageAndFix(
    issue: IssuePayload,
    targetBranch?: string,
    fixHandler?: (worktreePath: string) => Promise<boolean>,
  ): Promise<TriageResult> {
    let effectiveBranch = targetBranch
    if (!effectiveBranch || effectiveBranch === 'main') {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
        const current = stdout.trim()
        if (targetBranch === 'main') {
          try {
            await execFileAsync('git', ['rev-parse', '--verify', 'main'])
            effectiveBranch = 'main'
          } catch {
            effectiveBranch = current || 'master'
          }
        } else {
          effectiveBranch = current || 'master'
        }
      } catch {
        effectiveBranch = targetBranch || 'master'
      }
    }

    const reproTaskId = `sentinel_${issue.id}_${Math.random().toString(36).slice(2, 7)}`
    const worktreePath = await this.ctx.a3hSandbox.allocate(reproTaskId, effectiveBranch)

    try {
      // 1. If reproduction test is provided, inject it and verify it fails on unmodified code
      if (issue.reproductionTest) {
        const testFileAbs = path.resolve(worktreePath, issue.reproductionTest.filePath)
        await fs.mkdir(path.dirname(testFileAbs), { recursive: true })
        await fs.writeFile(testFileAbs, issue.reproductionTest.content, 'utf8')

        // Execute test command; expect failure
        const [bin, ...args] = issue.reproductionTest.testCommand.split(' ')
        let testFailedAsExpected = false
        let reproOutput = ''

        try {
          await execFileAsync(bin, args, { cwd: worktreePath, shell: true })
        } catch (err: any) {
          testFailedAsExpected = true
          reproOutput = err.stderr || err.stdout || err.message
        }

        if (!testFailedAsExpected) {
          return {
            issueId: issue.id,
            reproduced: false,
            reproductionError: 'Reproduction test passed on base code without changes; could not reproduce issue.',
            status: 'not_reproducible',
          }
        }

        // 2. Commit the reproduction test
        await execFileAsync('git', ['add', '.'], { cwd: worktreePath })
        await execFileAsync('git', ['commit', '--no-verify', '-m', `repro: add failing test for ${issue.id}`], {
          cwd: worktreePath,
        })

        // 3. Trigger fix handler if provided
        if (fixHandler) {
          const fixApplied = await fixHandler(worktreePath)
          if (fixApplied) {
            // Re-run the reproduction test: should now pass!
            let testPassed = false
            try {
              await execFileAsync(bin, args, { cwd: worktreePath, shell: true })
              testPassed = true
            } catch {}

            if (testPassed) {
              await execFileAsync('git', ['add', '.'], { cwd: worktreePath })
              await execFileAsync('git', ['commit', '--no-verify', '-m', `fix: resolve ${issue.id}`], {
                cwd: worktreePath,
              })

              // Reconcile and land
              const queueId = await this.ctx.a3hReconciliation.enqueueTask(
                reproTaskId,
                `feature/task-${reproTaskId}`,
                effectiveBranch,
                issue.reproductionTest.testCommand,
              )

              await this.ctx.a3hReconciliation.processQueue()
              const rec = this.ctx.a3hStorage.getReconciliation(queueId)

              return {
                issueId: issue.id,
                reproduced: true,
                taskId: reproTaskId,
                status: rec?.queue_status === 'merged' ? 'fixed_and_merged' : 'reproduced_and_dispatched',
              }
            }
          }
        }

        return {
          issueId: issue.id,
          reproduced: true,
          taskId: reproTaskId,
          status: 'reproduced_and_dispatched',
        }
      }

      return {
        issueId: issue.id,
        reproduced: false,
        status: 'not_reproducible',
      }
    } finally {
      try {
        await this.ctx.a3hSandbox.cleanup(reproTaskId)
      } catch {}
    }
  }

  async sweepFlakyTests(testCommand: string, runs: number = 3, cwd?: string): Promise<FlakySweepReport> {
    const targetDir = cwd ? path.resolve(cwd) : process.cwd()
    const [bin, ...args] = testCommand.split(' ')
    let passedRuns = 0
    let failedRuns = 0
    const failureDetails: string[] = []

    for (let i = 1; i <= runs; i++) {
      try {
        await execFileAsync(bin, args, {
          cwd: targetDir,
          shell: true,
          env: {
            ...process.env,
            TEST_RUN_INDEX: String(i),
            RANDOM_SEED: String(Math.floor(Math.random() * 100000)),
          },
        })
        passedRuns++
      } catch (err: any) {
        failedRuns++
        failureDetails.push(`Run #${i}: ${err.stderr || err.stdout || err.message}`)
      }
    }

    const isFlaky = passedRuns > 0 && failedRuns > 0

    return {
      testCommand,
      runs,
      passedRuns,
      failedRuns,
      isFlaky,
      failureDetails: failureDetails.length > 0 ? failureDetails : undefined,
    }
  }
}
