import { Context } from 'cordis'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileRange, applyTargetedPatch } from '../tools/file_io.js'

const exec = promisify(execFile)

export interface BenchmarkIssue {
  id: string
  name: string
  description: string
  setupFiles: Record<string, string>
  testCommand: string
  solution: {
    filePath: string
    startLine: number
    endLine: number
    targetContent: string
    replacementContent: string
  }
}

export interface BenchmarkResult {
  totalIssues: number
  passedCount: number
  passAt1Rate: number
  averageTurns: number
  averageDurationMs: number
  contextBounded: boolean
  issues: Array<{
    id: string
    name: string
    passed: boolean
    turns: number
    durationMs: number
  }>
}

export class BenchmarkHarness {
  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async runBenchmark(issues: BenchmarkIssue[], targetBranch: string): Promise<BenchmarkResult> {
    const results: BenchmarkResult['issues'] = []
    let totalTurns = 0
    let totalDuration = 0
    let allBounded = true

    for (const issue of issues) {
      const startTime = Date.now()
      const taskId = `bench_${issue.id}_${Math.random().toString(36).slice(2, 7)}`
      const worktreePath = await this.ctx.a3hSandbox.allocate(taskId, targetBranch)

      try {
        // 1. Setup issue files
        for (const [relPath, content] of Object.entries(issue.setupFiles)) {
          const absPath = path.resolve(worktreePath, relPath)
          await fs.mkdir(path.dirname(absPath), { recursive: true })
          await fs.writeFile(absPath, content, 'utf8')
        }

        // Commit initial buggy state
        await exec('git', ['add', '.'], { cwd: worktreePath })
        await exec('git', ['commit', '--no-verify', '-m', `Setup issue ${issue.id}`], { cwd: worktreePath })

        // Register in DB
        this.ctx.a3hStorage.createTask({
          id: taskId,
          instruction: issue.description,
          worktree_path: worktreePath,
          git_branch: `feature/task-${taskId}`,
          base_commit_hash: 'HEAD',
          status: 'running',
        })

        // 2. Simulate agent execution
        // Turn 1: Inspection with bounded read
        const inspectContent = await readFileRange(worktreePath, {
          filePath: issue.solution.filePath,
          startLine: 1,
          endLine: Math.min(60, issue.solution.endLine + 10),
        })
        totalTurns++

        // Verify output boundedness
        if (inspectContent.length > 8192) {
          allBounded = false
        }

        // Turn 2: Apply targeted patch
        await applyTargetedPatch(worktreePath, {
          filePath: issue.solution.filePath,
          targetContent: issue.solution.targetContent,
          replacementContent: issue.solution.replacementContent,
        })
        totalTurns++

        // Turn 3: Complete & verify task
        const verification = await this.ctx.a3hWorker.handleToolInvocation(
          taskId,
          {
            id: `call_${issue.id}`,
            name: 'complete_task',
            arguments: { testCommand: issue.testCommand },
          },
          worktreePath,
        )
        totalTurns++

        const passed = verification.status === 'completed' && verification.verification?.passed === true
        const durationMs = Date.now() - startTime
        totalDuration += durationMs

        // Commit changes and enqueue reconciliation
        if (passed) {
          await exec('git', ['add', '.'], { cwd: worktreePath })
          await exec('git', ['commit', '--no-verify', '-m', `Fix for ${issue.id}`], { cwd: worktreePath })
          await this.ctx.a3hReconciliation.enqueueTask(
            taskId,
            `feature/task-${taskId}`,
            targetBranch,
            issue.testCommand,
          )
        }

        results.push({
          id: issue.id,
          name: issue.name,
          passed,
          turns: 3,
          durationMs,
        })
      } finally {
        try {
          await this.ctx.a3hSandbox.cleanup(taskId)
        } catch {}
      }
    }

    // Process reconciliation queue for any landed fixes
    await this.ctx.a3hReconciliation.processQueue()

    const passedCount = results.filter(r => r.passed).length
    const passAt1Rate = issues.length > 0 ? passedCount / issues.length : 0
    const averageTurns = issues.length > 0 ? totalTurns / issues.length : 0
    const averageDurationMs = issues.length > 0 ? totalDuration / issues.length : 0

    return {
      totalIssues: issues.length,
      passedCount,
      passAt1Rate,
      averageTurns,
      averageDurationMs,
      contextBounded: allBounded,
      issues: results,
    }
  }
}
