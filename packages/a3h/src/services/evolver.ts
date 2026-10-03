import { Context, Service } from 'cordis'
import { IncidentCapsule } from './canary.js'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface FailureAttribution {
  faultingFile?: string
  lineNumber?: number
  snippet?: string
  violationReason: string
  taskId: string
  commitSha: string
}

export interface SynthesizedRule {
  tag: string
  category: string
  rule: string
  sourceIncidentId: string
  targetFiles: string[]
}

export interface StructuredRule {
  id: string
  tag: string
  category: string
  rule: string
  sourceIncidentId: string
  targetFiles: string[]
  hits: number
  createdAt: string
  lastHitAt: string
}

export interface SelfEvolutionResult {
  attribution: FailureAttribution
  synthesizedRule: SynthesizedRule
  structuredRule?: StructuredRule
  injectedToLearnings: boolean
  learningsFilePath: string
}

declare module 'cordis' {
  interface Context {
    a3hEvolver: EvolverService
  }
}

export class EvolverService extends Service {
  static inject = {
    a3hStorage: { required: true },
    a3hMemory: { required: false },
  }

  constructor(ctx: Context) {
    super(ctx, 'a3hEvolver', true)
  }

  async attributeFailure(incident: IncidentCapsule, repoRoot?: string): Promise<FailureAttribution> {
    const violationReason = incident.violations[0] || 'Unknown production degradation'

    // Parse stack trace if available
    let faultingFile: string | undefined
    let lineNumber: number | undefined

    if (incident.stackTrace) {
      const match = incident.stackTrace.match(/(?:at\s+.*\s+\()?([a-zA-Z0-9_\-./\\]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?/)
      if (match) {
        faultingFile = match[1].replace(/\\/g, '/')
        lineNumber = parseInt(match[2], 10)
      }
    }

    if (!faultingFile && incident.violations.length > 0) {
      // Check for file references in violation message
      const fileMatch = incident.violations.join(' ').match(/([a-zA-Z0-9_\-./]+\.[cm]?[jt]sx?)/)
      if (fileMatch) {
        faultingFile = fileMatch[1]
      }
    }

    let snippet: string | undefined
    if (faultingFile && repoRoot && lineNumber) {
      try {
        const abs = path.resolve(repoRoot, faultingFile)
        const content = await fs.readFile(abs, 'utf8')
        const lines = content.split('\n')
        if (lineNumber <= lines.length) {
          snippet = lines[lineNumber - 1]?.trim()
        }
      } catch {}
    }

    return {
      faultingFile,
      lineNumber,
      snippet,
      violationReason,
      taskId: incident.taskId,
      commitSha: incident.commitSha,
    }
  }

  async synthesizeHeuristic(attribution: FailureAttribution, incidentId: string): Promise<SynthesizedRule> {
    const file = attribution.faultingFile || 'shared modules'
    const reason = attribution.violationReason.toLowerCase()

    let tag = 'runtime_safety'
    let category = 'quirks'
    let ruleText = ''

    if (reason.includes('memory') || reason.includes('leak')) {
      tag = 'memory_leak_prevention'
      category = 'performance'
      ruleText = `When modifying \`${file}\`, avoid retaining unbounded caches, global listener registrations, or unclosed streams across request cycles to prevent monotonic memory climbs under sustained traffic.`
    } else if (reason.includes('latency') || reason.includes('drift')) {
      tag = 'latency_budget'
      category = 'performance'
      ruleText = `In \`${file}\`, avoid synchronous blocking I/O or unbounded N+1 network/database lookups in the hot request path. Ensure queries are batched or indexed to satisfy p99 <= 1.10x baseline latency.`
    } else if (reason.includes('connection') || reason.includes('pool') || reason.includes('socket')) {
      tag = 'pool_exhaustion'
      category = 'infrastructure'
      ruleText = `When introducing or configuring connection pools in \`${file}\`, always specify explicit \`maxIdleTimeoutMillis\` and \`connectionTimeoutMillis\` to eliminate connection leaks under concurrency.`
    } else {
      tag = 'fault_tolerance'
      category = 'reliability'
      ruleText = `When altering logic in \`${file}\`, enforce defensive null/undefined guards and catch potential unhandled promise rejections to maintain zero error rate delta.`
    }

    return {
      tag,
      category,
      rule: ruleText,
      sourceIncidentId: incidentId,
      targetFiles: attribution.faultingFile ? [attribution.faultingFile] : [],
    }
  }

  async getStructuredRules(repoRoot?: string): Promise<StructuredRule[]> {
    const root = repoRoot ?? process.cwd()
    const rulesPath = path.resolve(root, '.agent/rules.json')
    try {
      const raw = await fs.readFile(rulesPath, 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  async saveStructuredRules(rules: StructuredRule[], repoRoot?: string): Promise<void> {
    const root = repoRoot ?? process.cwd()
    const agentDir = path.resolve(root, '.agent')
    await fs.mkdir(agentDir, { recursive: true })
    const rulesPath = path.resolve(agentDir, 'rules.json')
    await fs.writeFile(rulesPath, JSON.stringify(rules, null, 2), 'utf8')
  }

  async recordRuleHit(tag: string, repoRoot?: string): Promise<boolean> {
    const rules = await this.getStructuredRules(repoRoot)
    const rule = rules.find(r => r.tag === tag)
    if (rule) {
      rule.hits += 1
      rule.lastHitAt = new Date().toISOString()
      await this.saveStructuredRules(rules, repoRoot)
      return true
    }
    return false
  }

  async pruneRules(
    repoRoot?: string,
    options?: { maxRules?: number; maxAgeDays?: number; minHits?: number },
  ): Promise<{ kept: number; pruned: number }> {
    const rules = await this.getStructuredRules(repoRoot)
    const initialCount = rules.length
    const now = Date.now()
    const maxAgeMs = (options?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
    const minHits = options?.minHits ?? 0

    let filtered = rules.filter((r) => {
      if (minHits > 0 && r.hits < minHits) {
        const age = now - new Date(r.lastHitAt || r.createdAt).getTime()
        if (age > maxAgeMs) return false
      }
      return true
    })

    // Sort by hits (descending), then lastHitAt (descending)
    filtered.sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits
      return new Date(b.lastHitAt).getTime() - new Date(a.lastHitAt).getTime()
    })

    if (options?.maxRules && filtered.length > options.maxRules) {
      filtered = filtered.slice(0, options.maxRules)
    }

    await this.saveStructuredRules(filtered, repoRoot)
    return {
      kept: filtered.length,
      pruned: initialCount - filtered.length,
    }
  }

  async injectRule(rule: SynthesizedRule, repoRoot?: string): Promise<{ learningsPath: string; structuredRule: StructuredRule }> {
    const root = repoRoot ?? process.cwd()
    const agentDir = path.resolve(root, '.agent')
    await fs.mkdir(agentDir, { recursive: true })

    // 1. Maintain structured rules.json
    const rules = await this.getStructuredRules(root)
    let existingRule = rules.find(r => r.tag === rule.tag)
    const nowStr = new Date().toISOString()

    if (existingRule) {
      existingRule.rule = rule.rule
      existingRule.targetFiles = Array.from(new Set([...existingRule.targetFiles, ...rule.targetFiles]))
      existingRule.lastHitAt = nowStr
    } else {
      existingRule = {
        id: `rule_${rule.tag}_${Date.now()}`,
        tag: rule.tag,
        category: rule.category,
        rule: rule.rule,
        sourceIncidentId: rule.sourceIncidentId,
        targetFiles: rule.targetFiles,
        hits: 0,
        createdAt: nowStr,
        lastHitAt: nowStr,
      }
      rules.push(existingRule)
    }
    await this.saveStructuredRules(rules, root)

    // 2. Append to learnings.md
    const learningsPath = path.resolve(agentDir, 'learnings.md')
    let currentLearnings = ''
    try {
      currentLearnings = await fs.readFile(learningsPath, 'utf8')
    } catch {
      currentLearnings = '# Repository Learnings & Operational Quirks\n\n'
    }

    const entry = `\n- **[RULE: ${rule.tag}]** ${rule.rule} *(Derived from ${rule.sourceIncidentId})*\n`

    if (!currentLearnings.includes(rule.tag)) {
      currentLearnings += entry
      await fs.writeFile(learningsPath, currentLearnings, 'utf8')
    }

    // Also record via MemoryService if available
    if (this.ctx.a3hMemory) {
      try {
        await this.ctx.a3hMemory.recordLearning(root, {
          taskId: rule.sourceIncidentId,
          category: (['general', 'build', 'test', 'quirks'].includes(rule.category) ? rule.category : 'quirks') as any,
          content: rule.rule,
        })
      } catch {}
    }

    return { learningsPath, structuredRule: existingRule }
  }

  async evolveFromIncident(incident: IncidentCapsule, repoRoot?: string): Promise<SelfEvolutionResult> {
    const attribution = await this.attributeFailure(incident, repoRoot)
    const synthesizedRule = await this.synthesizeHeuristic(attribution, incident.incidentId)
    const { learningsPath, structuredRule } = await this.injectRule(synthesizedRule, repoRoot)

    return {
      attribution,
      synthesizedRule,
      structuredRule,
      injectedToLearnings: true,
      learningsFilePath: learningsPath,
    }
  }
}
