import { Context, Service } from 'cordis'

export type BlastRadiusLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM'

export interface ChatOpsSuspensionPrompt {
  taskId: string
  action: string
  command: string
  blastRadius: BlastRadiusLevel
  previewDiff: string
  slackPayload: Record<string, any>
  discordPayload: Record<string, any>
  createdAt: string
}

declare module 'cordis' {
  interface Context {
    a3hChatOps: ChatOpsService
  }
  interface Events {
    'a3h/chatops-prompt-created'(prompt: ChatOpsSuspensionPrompt): void
    'a3h/chatops-action-resolved'(evt: { taskId: string; action: string; userId?: string; feedback?: string }): void
  }
}

export class ChatOpsService extends Service {
  static inject = ['a3hHITL', 'a3hStorage']

  private pendingPrompts = new Map<string, ChatOpsSuspensionPrompt>()

  constructor(ctx: Context) {
    super(ctx, 'a3hChatOps', true)

    // Listen to task suspensions from the HITL controller
    this.ctx.on('a3h/task-suspended' as any, (evt: any) => {
      this.handleTaskSuspension(evt)
    })
  }

  isHighBlastRadius(action: string, args: any): boolean {
    const cmd = (args?.command || args?.CommandLine || args?.cmd || action || '').toLowerCase()
    const highRiskPatterns = [
      'git push',
      'docker push',
      'npm publish',
      'alter table',
      'drop table',
      'migrate',
      'deploy',
      'kubectl',
      'rm -rf',
    ]
    return highRiskPatterns.some(pattern => cmd.includes(pattern))
  }

  evaluateBlastRadius(action: string, args: any): BlastRadiusLevel {
    const cmd = (args?.command || args?.CommandLine || args?.cmd || action || '').toLowerCase()
    if (cmd.includes('drop table') || cmd.includes('rm -rf') || cmd.includes('npm publish')) {
      return 'CRITICAL'
    }
    if (cmd.includes('git push') || cmd.includes('docker push') || cmd.includes('migrate')) {
      return 'HIGH'
    }
    return 'MEDIUM'
  }

  handleTaskSuspension(evt: { taskId: string; action: string; args: any }): ChatOpsSuspensionPrompt {
    const blastRadius = this.evaluateBlastRadius(evt.action, evt.args)
    const command = evt.args?.command || evt.args?.CommandLine || evt.action
    const previewDiff = evt.args?.previewDiff || `diff --git a/schema.sql b/schema.sql\n--- a/schema.sql\n+++ b/schema.sql\n@@ -1,4 +1,5 @@\n+-- High-blast-radius execution pending developer approval\n+EXECUTE ${command}`

    const prompt = this.generatePrompt(evt.taskId, evt.action, command, blastRadius, previewDiff)
    this.pendingPrompts.set(evt.taskId, prompt)
    this.ctx.emit('a3h/chatops-prompt-created', prompt)
    return prompt
  }

  generatePrompt(
    taskId: string,
    action: string,
    command: string,
    blastRadius: BlastRadiusLevel,
    previewDiff: string,
  ): ChatOpsSuspensionPrompt {
    const slackPayload = {
      channel: '#agent-fleet-approvals',
      text: `🚨 [A3H Alert] Task ${taskId} suspended: High-blast-radius ${action} requires human review.`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 High-Blast-Radius Action Suspended' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Task:* \`${taskId}\`\n*Action:* \`${action}\`\n*Command:* \`${command}\`\n*Blast Radius:* *${blastRadius}*`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Pending Diff Preview:*\n\`\`\`diff\n${previewDiff.slice(0, 500)}\n\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve & Land' },
              style: 'primary',
              value: `approve_${taskId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject & Abort' },
              style: 'danger',
              value: `reject_${taskId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Steer with Feedback' },
              value: `steer_${taskId}`,
            },
          ],
        },
      ],
    }

    const discordPayload = {
      embeds: [
        {
          title: `🚨 [A3H Fleet] Action Review: Task ${taskId}`,
          description: 'An autonomous worker suspended execution before executing a high-risk operation.',
          color: blastRadius === 'CRITICAL' ? 0xff0000 : 0xffaa00,
          fields: [
            { name: 'Action', value: action, inline: true },
            { name: 'Blast Radius', value: blastRadius, inline: true },
            { name: 'Command', value: `\`${command}\``, inline: false },
            { name: 'Diff Preview', value: `\`\`\`diff\n${previewDiff.slice(0, 300)}\n\`\`\``, inline: false },
          ],
          footer: { text: 'A3H Human-in-the-Loop Gateway' },
        },
      ],
    }

    return {
      taskId,
      action,
      command,
      blastRadius,
      previewDiff,
      slackPayload,
      discordPayload,
      createdAt: new Date().toISOString(),
    }
  }

  getPendingPrompt(taskId: string): ChatOpsSuspensionPrompt | undefined {
    return this.pendingPrompts.get(taskId)
  }

  getAllPending(): ChatOpsSuspensionPrompt[] {
    return Array.from(this.pendingPrompts.values())
  }

  handleAction(payload: {
    taskId: string
    action: 'approve' | 'reject' | 'steer'
    feedback?: string
    userId?: string
  }): { success: boolean; message: string } {
    const pending = this.pendingPrompts.get(payload.taskId)
    const dbTask = this.ctx.a3hStorage?.getTask(payload.taskId)
    const hasDbPending = dbTask && dbTask.status === 'suspended_waiting_user'

    if (!pending && !this.ctx.a3hHITL?.hasPending(payload.taskId) && !hasDbPending) {
      return { success: false, message: `No pending suspended task found for ID ${payload.taskId}` }
    }

    const approved = payload.action === 'approve' || payload.action === 'steer'
    const feedback = payload.feedback || (payload.action === 'approve' ? 'Approved by human reviewer' : 'Rejected by human reviewer')

    try {
      if (this.ctx.a3hHITL?.hasPending(payload.taskId)) {
        this.ctx.a3hHITL.resolveApproval(payload.taskId, approved, feedback)
      } else if (hasDbPending && this.ctx.a3hStorage) {
        this.ctx.a3hStorage.updateTask(payload.taskId, {
          status: approved ? 'running' : 'cancelled',
          failure_reason: approved ? undefined : `Rejected via ChatOps: ${feedback}`,
        })
      }
      this.pendingPrompts.delete(payload.taskId)
      this.ctx.emit('a3h/chatops-action-resolved', {
        taskId: payload.taskId,
        action: payload.action,
        userId: payload.userId,
        feedback,
      })

      return {
        success: true,
        message: `Task ${payload.taskId} successfully ${approved ? 'resumed' : 'aborted'} via ChatOps (${payload.action}).`,
      }
    } catch (err: any) {
      return { success: false, message: err.message }
    }
  }
}
