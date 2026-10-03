import { Context, Service } from 'cordis'

export interface TaintEvaluationResult {
  isTainted: boolean
  confidence: number
  triggers: string[]
  source: string
}

export interface TaintPolicyResult {
  allowed: boolean
  requiresHITL: boolean
  reason?: string
}

declare module 'cordis' {
  interface Context {
    a3hTaint: TaintService
  }
  interface Events {
    'a3h/taint-detected'(evt: { taskId?: string; source: string; triggers: string[] }): void
    'a3h/taint-lockdown'(evt: { taskId: string; action: string; reason: string }): void
  }
}

export class TaintService extends Service {
  private taintedTasks = new Map<string, { reason: string; timestamp: string; triggers: string[] }>()

  private injectionPatterns: Array<{ name: string; pattern: RegExp }> = [
    { name: 'instruction_override', pattern: /(?:ignore|disregard|forget|bypass)\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions?|rules?|prompts?)/i },
    { name: 'system_prompt_leak', pattern: /(?:print|dump|show|reveal|output|exfiltrate)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt)/i },
    { name: 'credential_exfiltration', pattern: /(?:curl|wget|fetch|http)\s+.*(?:password|token|secret|api_key|env|ssh)/i },
    { name: 'arbitrary_eval', pattern: /(?:eval|exec|Function)\s*\(\s*(?:base64|Buffer\.from)/i },
    { name: 'privilege_escalation', pattern: /(?:sudo\s+su|chmod\s+777\s+\/|chown\s+root)/i },
    { name: 'unauthorized_network_relay', pattern: /(?:webhook\.site|pipedream\.net|ngrok\.io|requestbin)/i },
  ]

  private highRiskActions = new Set<string>([
    'git_push',
    'git push',
    'deploy',
    'canary_promote',
    'execute_bash',
    'publish_package',
    'write_credentials',
    'modify_production_db',
  ])

  constructor(ctx: Context) {
    super(ctx, 'a3hTaint', true)
  }

  evaluateInput(source: string, content: string, taskId?: string): TaintEvaluationResult {
    const triggers: string[] = []

    for (const { name, pattern } of this.injectionPatterns) {
      if (pattern.test(content)) {
        triggers.push(name)
      }
    }

    const isTainted = triggers.length > 0
    const confidence = isTainted ? Math.min(1.0, triggers.length * 0.45) : 0.0

    if (isTainted) {
      this.ctx.emit('a3h/taint-detected', { taskId, source, triggers })
      if (taskId) {
        this.markTaskTainted(taskId, `Prompt injection markers detected from [${source}]: ${triggers.join(', ')}`, triggers)
      }
    }

    return {
      isTainted,
      confidence,
      triggers,
      source,
    }
  }

  markTaskTainted(taskId: string, reason: string, triggers: string[] = ['manual_taint']): void {
    this.taintedTasks.set(taskId, {
      reason,
      timestamp: new Date().toISOString(),
      triggers,
    })
  }

  isTaskTainted(taskId: string): boolean {
    return this.taintedTasks.has(taskId)
  }

  getTaintDetails(taskId: string) {
    return this.taintedTasks.get(taskId)
  }

  enforceTaintPolicy(taskId: string, action: string): TaintPolicyResult {
    const taint = this.taintedTasks.get(taskId)
    if (!taint) {
      return { allowed: true, requiresHITL: false }
    }

    const isHighRisk = this.highRiskActions.has(action) || Array.from(this.highRiskActions).some(act => action.toLowerCase().includes(act))

    if (isHighRisk) {
      const reason = `TAINT LOCKDOWN: Task '${taskId}' is tainted by untrusted input (${taint.reason}). Action '${action}' is restricted and requires mandatory human approval.`
      this.ctx.emit('a3h/taint-lockdown', { taskId, action, reason })
      return {
        allowed: false,
        requiresHITL: true,
        reason,
      }
    }

    return { allowed: true, requiresHITL: false }
  }
}
