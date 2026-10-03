import { Context, Service } from 'cordis'

export interface PendingInterrupt {
  taskId: string
  toolCallId: string
  action: string
  arguments: any
  requestedAt: Date
}

declare module 'cordis' {
  interface Context {
    a3hHITL: HITLController
  }
  interface Events {
    'a3h/task-suspended'(evt: { taskId: string; toolCallId: string; action: string; args: any; requestedAt: Date }): void
    'a3h/task-resumed'(evt: { taskId: string; approved: boolean; feedback?: string }): void
  }
}

export class HITLController extends Service {
  static inject = ['a3hStorage']

  private pendingApprovals = new Map<string, PendingInterrupt>()

  constructor(ctx: Context) {
    super(ctx, 'a3hHITL', true)
  }

  // Dangerous commands that force an immediate interrupt
  isRestrictedOperation(toolName: string, args: Record<string, any>): boolean {
    if (toolName === 'execute_bash' || toolName === 'bash' || toolName === 'exec' || toolName === 'run_command') {
      const cmd = (args?.command || args?.CommandLine || args?.cmd || '').toLowerCase()
      const dangerousPatterns = ['git push', 'rm -rf', 'drop table', 'curl', 'wget', 'npm publish']
      return dangerousPatterns.some(p => cmd.includes(p))
    }
    return toolName === 'request_user_guidance'
  }

  suspendForApproval(taskId: string, toolCallId: string, action: string, args: any) {
    this.pendingApprovals.set(taskId, {
      taskId,
      toolCallId,
      action,
      arguments: args,
      requestedAt: new Date(),
    })

    // Update DB state
    if (this.ctx.a3hStorage) {
      this.ctx.a3hStorage.updateTask(taskId, { status: 'suspended_waiting_user' })
    }

    this.ctx.emit('a3h/task-suspended' as any, { taskId, action, args })
  }

  resolveApproval(taskId: string, approved: boolean, userFeedback?: string) {
    const interrupt = this.pendingApprovals.get(taskId)
    if (!interrupt) {
      throw new Error(`No pending interrupt found for task ${taskId}`)
    }

    this.pendingApprovals.delete(taskId)

    // Update DB state back to running
    if (this.ctx.a3hStorage) {
      this.ctx.a3hStorage.updateTask(taskId, { status: 'running' })
    }

    this.ctx.emit('a3h/task-resumed' as any, {
      taskId,
      approved,
      userFeedback,
      toolCallId: interrupt.toolCallId,
    })
  }

  getPending(taskId: string): PendingInterrupt | undefined {
    return this.pendingApprovals.get(taskId)
  }

  hasPending(taskId: string): boolean {
    return this.pendingApprovals.has(taskId)
  }
}
