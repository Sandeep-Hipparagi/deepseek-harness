import { Context, Service } from 'cordis'
import { VerificationResult } from './verification.js'
import { readFileRange, applyTargetedPatch } from '../tools/file_io.js'
import { getFileOutline } from '../tools/outline.js'
import { getCurrentDateTime } from '../tools/datetime.js'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

export interface WorkerStepResult {
  status: 'running' | 'suspended_waiting_user' | 'completed' | 'failed'
  message?: string
  verification?: VerificationResult
  toolResult?: any
}

declare module 'cordis' {
  interface Context {
    a3hWorker: BackgroundAgentWorker
  }
  interface Events {
    'a3h/worker-heartbeat-warning'(evt: { taskId: string; error: string }): void
  }
}

export class BackgroundAgentWorker extends Service {
  static inject = {
    a3hHITL: { required: true },
    a3hVerification: { required: true },
    a3hStorage: { required: true },
    a3hSandbox: { required: true },
    a3hLSP: { required: true },
    a3hGovernance: { required: true },
    a3hTelemetry: { required: true },
    a3hMemory: { required: false },
  }

  constructor(ctx: Context) {
    super(ctx, 'a3hWorker', true)
  }

  async getTaskInitialPrompt(
    taskId: string,
    instruction: string,
    repoRoot?: string,
    options?: { maxTokens?: number; targetFiles?: string[]; relevantTags?: string[] },
  ): Promise<string> {
    let prefix = ''
    if (this.ctx.a3hMemory) {
      try {
        prefix = await this.ctx.a3hMemory.getSystemPromptPrefix(repoRoot, options)
      } catch {}
    }
    if (!prefix) return instruction
    return `${prefix}\n\n### Task Assignment\n${instruction}`
  }

  startTaskHeartbeat(taskId: string, intervalMs = 10_000, leaseTtlMs = 30_000): NodeJS.Timeout {
    return setInterval(() => {
      try {
        const nextLease = new Date(Date.now() + leaseTtlMs).toISOString()
        this.ctx.a3hStorage?.updateTask(taskId, {
          updated_at: new Date().toISOString(),
          lease_expires_at: nextLease,
        })
      } catch (err: any) {
        this.ctx.emit('a3h/worker-heartbeat-warning', { taskId, error: err.message })
      }
    }, intervalMs)
  }

  async executeTurnLoop<T>(taskId: string, turnRunner: () => Promise<T>): Promise<T> {
    const timer = this.startTaskHeartbeat(taskId)
    try {
      return await turnRunner()
    } finally {
      clearInterval(timer)
    }
  }

  async handleToolInvocation(
    taskId: string,
    toolCall: ToolCall,
    worktreePath: string,
  ): Promise<WorkerStepResult> {
    const startTime = Date.now()

    // 0. Circuit Breakers / Governance Check
    if (this.ctx.a3hGovernance) {
      await this.ctx.a3hGovernance.checkBudgetOrThrow(taskId)
    }

    const heartbeatTimer = this.startTaskHeartbeat(taskId)

    let result: WorkerStepResult
    try {
      result = await this.executeTool(taskId, toolCall, worktreePath)
    } finally {
      clearInterval(heartbeatTimer)
    }

    if (this.ctx.a3hTelemetry) {
      const durationMs = Date.now() - startTime
      const success = result.status !== 'failed'
      this.ctx.a3hTelemetry.recordToolExecution(
        taskId,
        toolCall.name,
        durationMs,
        success,
        toolCall.arguments,
        result.message || JSON.stringify(result.toolResult),
      )
    }

    return result
  }

  private async executeTool(
    taskId: string,
    toolCall: ToolCall,
    worktreePath: string,
  ): Promise<WorkerStepResult> {
    // 1. Before executing any tool: Check Dangerous Tool Policy (HITL)
    if (this.ctx.a3hHITL.isRestrictedOperation(toolCall.name, toolCall.arguments)) {
      this.ctx.a3hHITL.suspendForApproval(
        taskId,
        toolCall.id,
        toolCall.name,
        toolCall.arguments,
      )
      return {
        status: 'suspended_waiting_user',
        message: `Execution halted: Operation '${toolCall.name}' triggered HITL policy and requires user approval.`,
      }
    }

    // 2. Navigation & Cartography Tools (Phase 3)
    if (toolCall.name === 'read_file_range') {
      try {
        const text = await readFileRange(worktreePath, {
          filePath: toolCall.arguments.filePath,
          startLine: toolCall.arguments.startLine,
          endLine: toolCall.arguments.endLine,
        })
        return {
          status: 'running',
          toolResult: text,
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error reading file range: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'apply_targeted_patch') {
      try {
        const result = await applyTargetedPatch(worktreePath, {
          filePath: toolCall.arguments.filePath,
          targetContent: toolCall.arguments.targetContent,
          replacementContent: toolCall.arguments.replacementContent,
        })
        return {
          status: 'running',
          toolResult: result,
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error applying patch: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'get_file_outline') {
      try {
        const outline = await getFileOutline(worktreePath, toolCall.arguments.filePath)
        return {
          status: 'running',
          toolResult: outline,
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error getting outline: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'find_symbol_references') {
      try {
        const refs = await this.ctx.a3hLSP.findSymbolReferences(
          worktreePath,
          toolCall.arguments.symbol,
          toolCall.arguments.originFile,
        )
        return {
          status: 'running',
          toolResult: refs,
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error finding symbol references: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'find_symbol_definition') {
      try {
        const def = await this.ctx.a3hLSP.findSymbolDefinition(
          worktreePath,
          toolCall.arguments.symbol,
        )
        return {
          status: 'running',
          toolResult: def,
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error finding symbol definition: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'record_learning') {
      try {
        if (this.ctx.a3hMemory) {
          await this.ctx.a3hMemory.recordLearning(worktreePath, {
            taskId,
            category: toolCall.arguments.category || 'general',
            content: toolCall.arguments.content,
          })
        }
        return {
          status: 'running',
          toolResult: 'Learnings recorded to .agent/learnings.md successfully.',
        }
      } catch (err: any) {
        return {
          status: 'running',
          message: `Error recording learnings: ${err.message}`,
        }
      }
    }

    if (toolCall.name === 'get_current_datetime' || toolCall.name === 'date_and_time') {
      try {
        const dt = getCurrentDateTime(toolCall.arguments)
        if (!dt.date_and_time) {
          dt.date_and_time = 'Not Provided'
        }
        return {
          status: 'running',
          toolResult: dt,
        }
      } catch (err: any) {
        return {
          status: 'running',
          toolResult: {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
            date_and_time: 'Not Provided',
            date: 'Not Provided',
            time: 'Not Provided',
            day_of_week: 'Not Provided',
            iso_timestamp: new Date().toISOString(),
            timezone: 'UTC',
          },
        }
      }
    }

    // 3. When the LLM calls complete_task: Route directly to VerificationEngine
    if (toolCall.name === 'complete_task') {
      const verifier = this.ctx.a3hVerification
      const testCmd = toolCall.arguments?.testCommand
      const confCmd = toolCall.arguments?.conformanceCommand
      const result = await verifier.verifyTask(worktreePath, testCmd, confCmd)

      const task = this.ctx.a3hStorage?.getTask(taskId)
      const currentRetries = task?.retry_count ?? 0

      if (!result.passed) {
        const newRetries = currentRetries + 1
        if (newRetries >= 3) {
          this.ctx.a3hStorage?.updateTask(taskId, {
            status: 'failed',
            retry_count: newRetries,
            failure_reason: 'verification_exhausted',
          })
          return {
            status: 'failed',
            verification: result,
            message: `Task failed: Verification exhausted after ${newRetries} attempts. Reason: ${result.reason}`,
          }
        }

        this.ctx.a3hStorage?.updateTask(taskId, {
          status: 'running',
          retry_count: newRetries,
        })

        return {
          status: 'running',
          verification: result,
          message: `Verification failed: ${result.reason}. You must fix the code and verify again.`,
        }
      }

      // Passed verification
      if (result.diffSummary) {
        this.ctx.a3hStorage?.saveArtifact(
          `diff-${Date.now()}`,
          taskId,
          'git_diff',
          result.diffSummary,
        )
      }

      this.ctx.a3hStorage?.updateTask(taskId, {
        status: 'completed',
      })

      return {
        status: 'completed',
        verification: result,
        message: 'Task verified successfully and marked completed.',
      }
    }

    // Standard tool execution in worktree
    if (toolCall.name === 'execute_bash') {
      const cmd = toolCall.arguments?.command || toolCall.arguments?.cmd
      const res = await this.ctx.a3hSandbox?.execConfined(
        worktreePath,
        process.platform === 'win32' ? 'cmd.exe' : 'bash',
        process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd],
      )
      return {
        status: 'running',
        toolResult: res,
      }
    }

    return {
      status: 'running',
      message: `Tool ${toolCall.name} executed.`,
    }
  }
}
