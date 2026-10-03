import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export interface CanaryConfig {
  trafficSampleCount?: number
  baselineErrorRate?: number
  baselineP99LatencyMs?: number
  maxErrorRateDelta?: number // default: 0.00001 (0.001%)
  maxP99LatencyMultiplier?: number // default: 1.10 (10% drift)
  checkMemoryLeaks?: boolean
}

export interface CanaryDeployment {
  id: string
  taskId: string
  commitSha: string
  targetBranch: string
  worktreePath: string
  status: 'deploying' | 'canary_active' | 'promoted' | 'rolled_back'
  deployedAt: string
}

export interface TrafficConfig {
  requestCount?: number
  syntheticLatencyMs?: number[]
  syntheticErrors?: number // count of errors encountered
  memoryReadingsMb?: number[] // sequential memory samples
}

export interface CanaryMetrics {
  totalRequests: number
  errorCount: number
  errorRate: number // 0.0 to 1.0
  p99LatencyMs: number
  baselineP99LatencyMs: number
  memoryReadingsMb: number[]
  memoryLeakDetected: boolean
}

export interface CanaryEvaluationResult {
  healthy: boolean
  metrics: CanaryMetrics
  violations: string[]
  recommendation: 'promote' | 'rollback'
}

export interface IncidentCapsule {
  incidentId: string
  taskId: string
  commitSha: string
  targetBranch: string
  timestamp: string
  violations: string[]
  metrics: CanaryMetrics
  stdoutLogs?: string
  stderrLogs?: string
  stackTrace?: string
  revertCommitSha?: string
}

export interface RollbackResult {
  success: boolean
  revertCommitSha?: string
  incidentCapsule: IncidentCapsule
  error?: string
}

declare module 'cordis' {
  interface Context {
    a3hCanary: CanaryService
  }
  interface Events {
    'a3h/canary-promoted'(evt: { deploymentId: string; taskId: string; metrics: CanaryMetrics }): void
    'a3h/canary-rolled-back'(evt: { deploymentId: string; taskId: string; reason: string; incidentId: string }): void
    'a3h/canary-rollback-failed'(evt: { deploymentId: string; taskId: string; commitSha: string; error: string; requiresHITL: boolean }): void
  }
}

export class CanaryService extends Service {
  static inject = {
    a3hSandbox: { required: true },
    a3hStorage: { required: true },
    a3hTelemetry: { required: true },
  }

  private activeDeployments = new Map<string, CanaryDeployment>()

  constructor(ctx: Context) {
    super(ctx, 'a3hCanary', true)
  }

  async deployCanary(
    taskId: string,
    commitSha: string,
    targetBranch: string = 'master',
  ): Promise<CanaryDeployment> {
    const deploymentId = `canary_${taskId}_${Date.now().toString(36)}`
    const worktreePath = await this.ctx.a3hSandbox.allocate(deploymentId, targetBranch)

    const deployment: CanaryDeployment = {
      id: deploymentId,
      taskId,
      commitSha,
      targetBranch,
      worktreePath,
      status: 'canary_active',
      deployedAt: new Date().toISOString(),
    }

    this.activeDeployments.set(deploymentId, deployment)
    return deployment
  }

  async evaluateCanary(
    deployment: CanaryDeployment,
    traffic?: TrafficConfig,
    config?: CanaryConfig,
  ): Promise<CanaryEvaluationResult> {
    const totalRequests = traffic?.requestCount ?? 500
    const errorCount = traffic?.syntheticErrors ?? 0
    const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0

    // Latency computation
    const baselineP99 = config?.baselineP99LatencyMs ?? 50
    let p99LatencyMs = baselineP99
    if (traffic?.syntheticLatencyMs && traffic.syntheticLatencyMs.length > 0) {
      const sorted = [...traffic.syntheticLatencyMs].sort((a, b) => a - b)
      const p99Index = Math.floor(sorted.length * 0.99)
      p99LatencyMs = sorted[Math.min(p99Index, sorted.length - 1)]
    }

    // Memory leak analysis: monotonic climb across >= 3 sequential readings
    const memoryReadings = traffic?.memoryReadingsMb ?? [120, 122, 121, 122]
    let memoryLeakDetected = false
    if (config?.checkMemoryLeaks !== false && memoryReadings.length >= 4) {
      let isStrictlyIncreasing = true
      for (let i = 1; i < memoryReadings.length; i++) {
        if (memoryReadings[i] <= memoryReadings[i - 1]) {
          isStrictlyIncreasing = false
          break
        }
      }
      const overallGrowth = memoryReadings[memoryReadings.length - 1] - memoryReadings[0]
      if (isStrictlyIncreasing && overallGrowth > 20) {
        memoryLeakDetected = true
      }
    }

    const maxErrorDelta = config?.maxErrorRateDelta ?? 0.00001
    const maxP99Mult = config?.maxP99LatencyMultiplier ?? 1.10
    const violations: string[] = []

    if (errorRate > maxErrorDelta) {
      violations.push(
        `Error rate delta exceeded threshold: ${(errorRate * 100).toFixed(4)}% vs max ${(maxErrorDelta * 100).toFixed(4)}%`,
      )
    }

    if (p99LatencyMs > baselineP99 * maxP99Mult) {
      violations.push(
        `p99 latency drift exceeded limit: ${p99LatencyMs.toFixed(1)}ms vs max allowed ${(baselineP99 * maxP99Mult).toFixed(1)}ms`,
      )
    }

    if (memoryLeakDetected) {
      violations.push(
        `Monotonic memory leak detected: Heap climbed from ${memoryReadings[0]}MB to ${memoryReadings[memoryReadings.length - 1]}MB across sequential traffic windows`,
      )
    }

    const healthy = violations.length === 0
    const metrics: CanaryMetrics = {
      totalRequests,
      errorCount,
      errorRate,
      p99LatencyMs,
      baselineP99LatencyMs: baselineP99,
      memoryReadingsMb: memoryReadings,
      memoryLeakDetected,
    }

    if (healthy) {
      deployment.status = 'promoted'
      this.ctx.emit('a3h/canary-promoted', {
        deploymentId: deployment.id,
        taskId: deployment.taskId,
        metrics,
      })
    }

    return {
      healthy,
      metrics,
      violations,
      recommendation: healthy ? 'promote' : 'rollback',
    }
  }

  async rollback(
    deployment: CanaryDeployment,
    reason: string,
    diagnostics?: { stdout?: string; stderr?: string; stackTrace?: string; metrics?: CanaryMetrics },
  ): Promise<RollbackResult> {
    deployment.status = 'rolled_back'
    const incidentId = `INC-${Date.now().toString(36).toUpperCase()}`

    let revertCommitSha = ''
    let rollbackError: string | undefined

    try {
      const { stdout: rootTop } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
      const gitRoot = rootTop.trim()

      // Check if target branch has commit
      if (deployment.commitSha) {
        // Run git revert on target branch
        // To safely revert on targetBranch, checkout or cherry-pick/revert inside the worktree
        try {
          await execFileAsync('git', ['revert', '--no-edit', deployment.commitSha], {
            cwd: deployment.worktreePath,
          })

          // Fast-forward or update target branch to include revert
          const { stdout: revStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: deployment.worktreePath,
          })
          revertCommitSha = revStdout.trim()

          // Update targetBranch
          await execFileAsync('git', ['branch', '-f', deployment.targetBranch, revertCommitSha], {
            cwd: gitRoot,
          })
        } catch (revertErr: any) {
          // 1. Immediately abort the conflicted revert to reset the staging worktree state cleanly
          await execFileAsync('git', ['revert', '--abort'], {
            cwd: deployment.worktreePath,
          }).catch(() => {})

          // 2. Emit alert for Human-in-the-Loop (HITL) intervention
          this.ctx.emit('a3h/canary-rollback-failed', {
            deploymentId: deployment.id,
            taskId: deployment.taskId,
            commitSha: deployment.commitSha,
            error: `Autonomous rollback conflicted with downstream landed commits: ${revertErr.message}`,
            requiresHITL: true,
          })

          rollbackError = `Canary rollback halted: conflict encountered during 'git revert'. Worktree cleanly reset. Manual intervention required: ${revertErr.message}`
        }
      }
    } catch (err: any) {
      rollbackError = err.message
    }

    const capsule: IncidentCapsule = {
      incidentId,
      taskId: deployment.taskId,
      commitSha: deployment.commitSha,
      targetBranch: deployment.targetBranch,
      timestamp: new Date().toISOString(),
      violations: [reason],
      metrics: diagnostics?.metrics ?? {
        totalRequests: 0,
        errorCount: 0,
        errorRate: 0,
        p99LatencyMs: 0,
        baselineP99LatencyMs: 0,
        memoryReadingsMb: [],
        memoryLeakDetected: false,
      },
      stdoutLogs: diagnostics?.stdout,
      stderrLogs: diagnostics?.stderr,
      stackTrace: diagnostics?.stackTrace,
      revertCommitSha,
    }

    // Save incident capsule to disk
    await this.persistIncidentReport(capsule)

    this.ctx.emit('a3h/canary-rolled-back', {
      deploymentId: deployment.id,
      taskId: deployment.taskId,
      reason,
      incidentId,
    })

    // Cleanup canary worktree
    try {
      await this.ctx.a3hSandbox.cleanup(deployment.id)
      this.activeDeployments.delete(deployment.id)
    } catch {}

    return {
      success: !rollbackError,
      revertCommitSha,
      incidentCapsule: capsule,
      error: rollbackError,
    }
  }

  async persistIncidentReport(capsule: IncidentCapsule, repoRoot?: string): Promise<string> {
    const root = repoRoot ?? process.cwd()
    const incidentsDir = path.resolve(root, '.agent/incidents')
    await fs.mkdir(incidentsDir, { recursive: true })

    const filePath = path.join(incidentsDir, `${capsule.incidentId}.json`)
    await fs.writeFile(filePath, JSON.stringify(capsule, null, 2), 'utf8')

    // Also write markdown report
    const mdPath = path.join(incidentsDir, `${capsule.incidentId}.md`)
    const mdContent = `# Incident Report: ${capsule.incidentId}

**Task ID**: \`${capsule.taskId}\`
**Faulting Commit**: \`${capsule.commitSha}\`
**Target Branch**: \`${capsule.targetBranch}\`
**Revert Commit**: \`${capsule.revertCommitSha || 'N/A'}\`
**Timestamp**: \`${capsule.timestamp}\`

## Violations Detected
${capsule.violations.map(v => `- ${v}`).join('\n')}

## Metrics Summary
- **Requests Sampled**: ${capsule.metrics.totalRequests}
- **Error Rate**: ${(capsule.metrics.errorRate * 100).toFixed(4)}%
- **p99 Latency**: ${capsule.metrics.p99LatencyMs}ms (Baseline: ${capsule.metrics.baselineP99LatencyMs}ms)
- **Memory Leak**: ${capsule.metrics.memoryLeakDetected ? 'YES (Monotonic climb)' : 'NO'}

${capsule.stackTrace ? `## Stack Trace\n\`\`\`\n${capsule.stackTrace}\n\`\`\`\n` : ''}
`

    await fs.writeFile(mdPath, mdContent, 'utf8')
    return mdPath
  }
}
