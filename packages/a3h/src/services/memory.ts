import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface EnvironmentProfile {
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown'
  nodeVersion?: string
  testCommands: string[]
  buildScripts: string[]
  detectedFrameworks: string[]
  lastDiscoveredAt: string
}

export interface LearningNote {
  taskId: string
  category: 'build' | 'test' | 'quirks' | 'general'
  title: string
  content: string
  timestamp: string
}

export interface RepoMemory {
  environment: EnvironmentProfile | null
  learnings: LearningNote[]
  rawLearningsMarkdown: string
}

export interface MemoryPrefixOptions {
  maxTokens?: number
  targetFiles?: string[]
  relevantTags?: string[]
}

export interface CompactionResult {
  rulesBefore: number
  rulesAfter: number
  markdownBytesBefore: number
  markdownBytesAfter: number
  prunedCount: number
}

declare module 'cordis' {
  interface Context {
    a3hMemory: MemoryService
  }
}

export class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a3hMemory', true)
  }

  private async getGitRoot(customPath?: string): Promise<string> {
    const cwd = customPath ? path.resolve(customPath) : process.cwd()
    try {
      const { stdout: commonDirOut } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd })
      const commonDir = commonDirOut.trim()
      if (commonDir) {
        const absCommonDir = path.resolve(cwd, commonDir)
        return path.dirname(absCommonDir)
      }
    } catch {}

    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
      return stdout.trim()
    } catch {
      return cwd
    }
  }

  async ensureAgentDirectory(repoRoot?: string): Promise<string> {
    const root = await this.getGitRoot(repoRoot)
    const agentDir = path.resolve(root, '.agent')
    await fs.mkdir(agentDir, { recursive: true })

    // Seed environment.json if missing
    const envPath = path.resolve(agentDir, 'environment.json')
    try {
      await fs.access(envPath)
    } catch {
      const defaultEnv = await this.detectEnvironment(root)
      await fs.writeFile(envPath, JSON.stringify(defaultEnv, null, 2), 'utf8')
    }

    // Seed learnings.md if missing
    const learningsPath = path.resolve(agentDir, 'learnings.md')
    try {
      await fs.access(learningsPath)
    } catch {
      const header = [
        '# Repository Learnings & Operational Quirks',
        '',
        '> Shared episodic memory for autonomous agents. Curated notes on build quirks, test flags, and repository constraints.',
        '',
        '## Build & Dependencies',
        '- Standard build via workspace package manager.',
        '',
        '## Test Suites & Flags',
        '- Run unit tests before claiming task completion.',
        '',
        '## Known Quirks',
        '- Always preserve backward compatibility on shared symbols.',
        '',
      ].join('\n')
      await fs.writeFile(learningsPath, header, 'utf8')
    }

    return agentDir
  }

  async detectEnvironment(root: string): Promise<EnvironmentProfile> {
    let pkgMgr: EnvironmentProfile['packageManager'] = 'unknown'
    const testCommands: string[] = []
    const buildScripts: string[] = []
    const detectedFrameworks: string[] = []

    try {
      const files = await fs.readdir(root)
      if (files.includes('pnpm-lock.yaml')) pkgMgr = 'pnpm'
      else if (files.includes('yarn.lock')) pkgMgr = 'yarn'
      else if (files.includes('package-lock.json')) pkgMgr = 'npm'
      else if (files.includes('bun.lockb')) pkgMgr = 'bun'

      if (files.includes('package.json')) {
        const pkgContent = await fs.readFile(path.resolve(root, 'package.json'), 'utf8')
        const pkg = JSON.parse(pkgContent)
        if (pkg.scripts) {
          if (pkg.scripts.test) testCommands.push(`${pkgMgr === 'npm' ? 'npm test' : `${pkgMgr} test`}`)
          if (pkg.scripts.build) buildScripts.push(`${pkgMgr === 'npm' ? 'npm run build' : `${pkgMgr} build`}`)
          if (pkg.scripts.typecheck) buildScripts.push(`${pkgMgr === 'npm' ? 'npm run typecheck' : `${pkgMgr} typecheck`}`)
        }
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps.react) detectedFrameworks.push('React')
        if (deps.cordis) detectedFrameworks.push('Cordis')
        if (deps.typescript) detectedFrameworks.push('TypeScript')
        if (deps.vite) detectedFrameworks.push('Vite')
      }
    } catch {}

    return {
      packageManager: pkgMgr,
      nodeVersion: process.version,
      testCommands,
      buildScripts,
      detectedFrameworks,
      lastDiscoveredAt: new Date().toISOString(),
    }
  }

  async getRepoMemory(repoRoot?: string): Promise<RepoMemory> {
    const root = await this.getGitRoot(repoRoot)
    await this.ensureAgentDirectory(root)

    const agentDir = path.resolve(root, '.agent')
    let environment: EnvironmentProfile | null = null
    let rawLearningsMarkdown = ''
    const learnings: LearningNote[] = []

    try {
      const envRaw = await fs.readFile(path.resolve(agentDir, 'environment.json'), 'utf8')
      environment = JSON.parse(envRaw)
    } catch {}

    try {
      rawLearningsMarkdown = await fs.readFile(path.resolve(agentDir, 'learnings.md'), 'utf8')
      // Parse markdown sections into notes
      const lines = rawLearningsMarkdown.split(/\r?\n/)
      let currentCategory: LearningNote['category'] = 'general'

      for (const line of lines) {
        if (line.startsWith('## Build')) currentCategory = 'build'
        else if (line.startsWith('## Test')) currentCategory = 'test'
        else if (line.startsWith('## Known Quirks') || line.startsWith('## Quirks')) currentCategory = 'quirks'
        else if (line.startsWith('- ') && line.length > 2) {
          learnings.push({
            taskId: 'shared',
            category: currentCategory,
            title: line.slice(2, 40),
            content: line.slice(2),
            timestamp: new Date().toISOString(),
          })
        }
      }
    } catch {}

    return {
      environment,
      learnings,
      rawLearningsMarkdown,
    }
  }

  async recordLearning(
    repoRoot: string | undefined,
    note: { taskId?: string; category?: LearningNote['category']; content: string },
  ): Promise<void> {
    const root = await this.getGitRoot(repoRoot)
    await this.ensureAgentDirectory(root)

    const learningsPath = path.resolve(root, '.agent', 'learnings.md')
    let currentContent = ''
    try {
      currentContent = await fs.readFile(learningsPath, 'utf8')
    } catch {}

    const categoryHeader =
      note.category === 'build'
        ? '## Build & Dependencies'
        : note.category === 'test'
          ? '## Test Suites & Flags'
          : note.category === 'quirks'
            ? '## Known Quirks'
            : '## General Notes'

    const formattedBullet = `- [Task ${note.taskId || 'manual'}] ${note.content}\n`

    if (currentContent.includes(categoryHeader)) {
      currentContent = currentContent.replace(
        categoryHeader,
        `${categoryHeader}\n${formattedBullet.trimEnd()}`,
      )
    } else {
      currentContent += `\n\n${categoryHeader}\n${formattedBullet.trimEnd()}\n`
    }

    await fs.writeFile(learningsPath, currentContent, 'utf8')
  }

  async recordEnvironment(repoRoot: string | undefined, env: Partial<EnvironmentProfile>): Promise<void> {
    const root = await this.getGitRoot(repoRoot)
    await this.ensureAgentDirectory(root)

    const envPath = path.resolve(root, '.agent', 'environment.json')
    let existing: EnvironmentProfile
    try {
      const raw = await fs.readFile(envPath, 'utf8')
      existing = JSON.parse(raw)
    } catch {
      existing = await this.detectEnvironment(root)
    }

    const updated: EnvironmentProfile = {
      ...existing,
      ...env,
      lastDiscoveredAt: new Date().toISOString(),
    }

    await fs.writeFile(envPath, JSON.stringify(updated, null, 2), 'utf8')
  }

  async compactLearnings(
    repoRoot?: string,
    options?: { maxTokens?: number; maxRules?: number; maxAgeDays?: number },
  ): Promise<CompactionResult> {
    const root = await this.getGitRoot(repoRoot)
    const agentDir = path.resolve(root, '.agent')
    await this.ensureAgentDirectory(root)

    const rulesPath = path.resolve(agentDir, 'rules.json')
    const learningsPath = path.resolve(agentDir, 'learnings.md')

    let rules: any[] = []
    try {
      rules = JSON.parse(await fs.readFile(rulesPath, 'utf8'))
    } catch {}

    let initialMarkdown = ''
    try {
      initialMarkdown = await fs.readFile(learningsPath, 'utf8')
    } catch {}

    const rulesBefore = rules.length
    const maxRules = options?.maxRules ?? 25
    const maxTokens = options?.maxTokens ?? 2000
    const maxChars = maxTokens * 4 // ~4 chars per token estimate

    // Sort by hits (descending), then lastHitAt (descending)
    rules.sort((a, b) => {
      const hitsA = a.hits || 0
      const hitsB = b.hits || 0
      if (hitsB !== hitsA) return hitsB - hitsA
      return new Date(b.lastHitAt || b.createdAt || 0).getTime() - new Date(a.lastHitAt || a.createdAt || 0).getTime()
    })

    // Prune excess rules
    const keptRules = rules.slice(0, maxRules)
    const prunedCount = Math.max(0, rulesBefore - keptRules.length)

    // Group kept rules into markdown
    const buildRules = keptRules.filter(r => r.category === 'build')
    const testRules = keptRules.filter(r => r.category === 'test')
    const quirkRules = keptRules.filter(r => r.category === 'quirks' || r.category === 'performance')
    const generalRules = keptRules.filter(r => !['build', 'test', 'quirks', 'performance'].includes(r.category))

    const lines: string[] = [
      '# Repository Learnings & Operational Quirks',
      '',
      '> Curated and compacted episodic memory for autonomous agents. Rules are scored and retained by operational utility.',
      '',
    ]

    if (buildRules.length > 0) {
      lines.push('## Build & Dependencies')
      for (const r of buildRules) lines.push(`- **[RULE: ${r.tag}]** ${r.rule} *(Hits: ${r.hits || 0})*`)
      lines.push('')
    }

    if (testRules.length > 0) {
      lines.push('## Test Suites & Flags')
      for (const r of testRules) lines.push(`- **[RULE: ${r.tag}]** ${r.rule} *(Hits: ${r.hits || 0})*`)
      lines.push('')
    }

    if (quirkRules.length > 0) {
      lines.push('## Known Quirks & Performance Guards')
      for (const r of quirkRules) lines.push(`- **[RULE: ${r.tag}]** ${r.rule} *(Hits: ${r.hits || 0})*`)
      lines.push('')
    }

    if (generalRules.length > 0) {
      lines.push('## General Rules')
      for (const r of generalRules) lines.push(`- **[RULE: ${r.tag}]** ${r.rule} *(Hits: ${r.hits || 0})*`)
      lines.push('')
    }

    let compactedMarkdown = lines.join('\n')
    if (compactedMarkdown.length > maxChars) {
      compactedMarkdown = compactedMarkdown.slice(0, maxChars) + '\n\n...[Compact truncated at token limit]'
    }

    await fs.writeFile(learningsPath, compactedMarkdown, 'utf8')
    await fs.writeFile(rulesPath, JSON.stringify(keptRules, null, 2), 'utf8')

    return {
      rulesBefore,
      rulesAfter: keptRules.length,
      markdownBytesBefore: Buffer.byteLength(initialMarkdown, 'utf8'),
      markdownBytesAfter: Buffer.byteLength(compactedMarkdown, 'utf8'),
      prunedCount,
    }
  }

  async getSystemPromptPrefix(repoRoot?: string, options?: MemoryPrefixOptions): Promise<string> {
    const memory = await this.getRepoMemory(repoRoot)
    const sections: string[] = ['### [A3H Shared Episodic Memory & Repository Knowledge]']

    if (memory.environment) {
      sections.push(
        `**Environment Profile**: Package Manager: \`${memory.environment.packageManager}\` | Frameworks: ${memory.environment.detectedFrameworks.join(', ') || 'none'}`,
      )
      if (memory.environment.testCommands.length > 0) {
        sections.push(`**Standard Test Commands**: \`${memory.environment.testCommands.join(', ')}\``)
      }
      if (memory.environment.buildScripts.length > 0) {
        sections.push(`**Standard Build Scripts**: \`${memory.environment.buildScripts.join(', ')}\``)
      }
    }

    // Check for structured rules.json
    const root = await this.getGitRoot(repoRoot)
    const rulesPath = path.resolve(root, '.agent', 'rules.json')
    let structuredRules: any[] = []
    try {
      structuredRules = JSON.parse(await fs.readFile(rulesPath, 'utf8'))
    } catch {}

    const maxTokens = options?.maxTokens ?? 2000
    const maxChars = maxTokens * 4 // ~4 chars per token estimate

    if (structuredRules.length > 0) {
      // Score and rank rules based on targetFiles and relevance
      const targetFiles = options?.targetFiles ?? []
      const relevantTags = options?.relevantTags ?? []

      const scored = structuredRules.map((r) => {
        let score = (r.hits || 0)
        if (targetFiles.length > 0 && r.targetFiles && Array.isArray(r.targetFiles)) {
          const matches = r.targetFiles.some(
            (f: string) => targetFiles.includes(f) || targetFiles.some(tf => tf.includes(f) || f.includes(tf)),
          )
          if (matches) score += 100
        }
        if (relevantTags.includes(r.tag)) {
          score += 50
        }
        return { rule: r, score }
      })

      scored.sort((a, b) => b.score - a.score)

      const ruleLines: string[] = []
      let currentLength = sections.join('\n').length

      for (const item of scored) {
        const line = `- **[RULE: ${item.rule.tag}]** ${item.rule.rule}`
        if (ruleLines.length > 0 && currentLength + line.length > maxChars) {
          break // Stop when hitting budget limit
        }
        ruleLines.push(line)
        currentLength += line.length + 1
      }

      if (ruleLines.length > 0) {
        sections.push('\n**Curated Repository Learnings & Active Rules**:')
        sections.push(ruleLines.join('\n'))
      }
    } else if (memory.rawLearningsMarkdown.trim()) {
      let learnings = memory.rawLearningsMarkdown.trim()
      const currentLength = sections.join('\n').length
      if (currentLength + learnings.length > maxChars) {
        learnings = learnings.slice(0, Math.max(100, maxChars - currentLength)) + '\n...[Truncated to fit token ceiling]'
      }
      sections.push('\n**Curated Repository Learnings & Quirks**:')
      sections.push(learnings)
    }

    sections.push('\nUse this repository knowledge immediately to avoid wasted discovery turns.')
    return sections.join('\n')
  }
}
