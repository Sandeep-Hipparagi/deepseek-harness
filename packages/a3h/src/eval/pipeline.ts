import { Context } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BenchmarkHarness, BenchmarkIssue, BenchmarkResult } from './benchmark.js'
import { getGoldenDataset, GoldenBenchmarkIssue } from './golden_dataset.js'

const execFileAsync = promisify(execFile)

export interface RegressionRunRecord {
  id: string
  timestamp: string
  gitCommit: string
  totalIssues: number
  passedCount: number
  passAt1Rate: number
  averageTurns: number
  averageDurationMs: number
  meanCostPerBugUsd: number
  contextBounded: boolean
  withMemory: boolean
  issues: Array<{
    id: string
    passed: boolean
    turns: number
    durationMs: number
  }>
}

export interface EvalPipelineReport {
  currentRun: RegressionRunRecord
  historyCount: number
  regressionDetected: boolean
  deltaPassRate?: number
}

export interface GoldenRegressionReport {
  timestamp: string
  totalTested: number
  passedCount: number
  passAt1Rate: number
  averageTurns: number
  costPerBugUSD: number
  withinBudget: boolean
  regressionDetected: boolean
  fallbackTriggered: boolean
  activeModel: string
  issues: Array<{
    id: string
    name: string
    passed: boolean
    turns: number
    durationMs: number
  }>
}

export class EvalPipeline {
  private ctx: Context
  private historyFile: string

  constructor(ctx: Context, historyFile = '.a3h-data/eval-history.json') {
    this.ctx = ctx
    this.historyFile = path.resolve(historyFile)
  }

  getGoldenDataset(): BenchmarkIssue[] {
    return [
      {
        id: 'golden-01-null-guard',
        name: 'Null Guard in Pricing Calculator',
        description: 'Prevent TypeError on undefined/null items array',
        setupFiles: {
          'src/pricing.js': [
            'export function calculatePrice(items) {',
            '  return items.reduce((acc, item) => acc + item.price, 0);',
            '}',
          ].join('\n'),
          'test-pricing.js': [
            'import assert from "node:assert";',
            'import { calculatePrice } from "./src/pricing.js";',
            'assert.strictEqual(calculatePrice([{ price: 50 }, { price: 25 }]), 75);',
            'assert.strictEqual(calculatePrice(null), 0);',
            'assert.strictEqual(calculatePrice(undefined), 0);',
            'console.log("Pricing test passed.");',
          ].join('\n'),
        },
        testCommand: 'node test-pricing.js',
        solution: {
          filePath: 'src/pricing.js',
          startLine: 1,
          endLine: 3,
          targetContent: [
            'export function calculatePrice(items) {',
            '  return items.reduce((acc, item) => acc + item.price, 0);',
            '}',
          ].join('\n'),
          replacementContent: [
            'export function calculatePrice(items) {',
            '  if (!items || !Array.isArray(items)) return 0;',
            '  return items.reduce((acc, item) => acc + item.price, 0);',
            '}',
          ].join('\n'),
        },
      },
      {
        id: 'golden-02-sanitize-header',
        name: 'Header Sanitizer',
        description: 'Strip newline characters from outgoing headers',
        setupFiles: {
          'src/header.js': [
            'export function sanitizeHeader(val) {',
            '  return val;',
            '}',
          ].join('\n'),
          'test-header.js': [
            'import assert from "node:assert";',
            'import { sanitizeHeader } from "./src/header.js";',
            'assert.strictEqual(sanitizeHeader("Bearer abc"), "Bearer abc");',
            'assert.strictEqual(sanitizeHeader("Bearer abc\\r\\nInjected: evil"), "Bearer abcInjected: evil");',
            'console.log("Header test passed.");',
          ].join('\n'),
        },
        testCommand: 'node test-header.js',
        solution: {
          filePath: 'src/header.js',
          startLine: 1,
          endLine: 3,
          targetContent: [
            'export function sanitizeHeader(val) {',
            '  return val;',
            '}',
          ].join('\n'),
          replacementContent: [
            'export function sanitizeHeader(val) {',
            '  if (typeof val !== "string") return "";',
            '  return val.replace(/[\\r\\n]+/g, "");',
            '}',
          ].join('\n'),
        },
      },
      {
        id: 'golden-03-safe-divide',
        name: 'Safe Division Helper',
        description: 'Return fallback value on division by zero',
        setupFiles: {
          'src/math.js': [
            'export function safeDivide(a, b, fallback = 0) {',
            '  return a / b;',
            '}',
          ].join('\n'),
          'test-math.js': [
            'import assert from "node:assert";',
            'import { safeDivide } from "./src/math.js";',
            'assert.strictEqual(safeDivide(10, 2), 5);',
            'assert.strictEqual(safeDivide(10, 0, -1), -1);',
            'assert.strictEqual(safeDivide(0, 0), 0);',
            'console.log("Math test passed.");',
          ].join('\n'),
        },
        testCommand: 'node test-math.js',
        solution: {
          filePath: 'src/math.js',
          startLine: 1,
          endLine: 3,
          targetContent: [
            'export function safeDivide(a, b, fallback = 0) {',
            '  return a / b;',
            '}',
          ].join('\n'),
          replacementContent: [
            'export function safeDivide(a, b, fallback = 0) {',
            '  if (b === 0 || !Number.isFinite(b)) return fallback;',
            '  return a / b;',
            '}',
          ].join('\n'),
        },
      },
    ]
  }

  async runPipeline(options?: {
    targetBranch?: string
    withMemory?: boolean
    issues?: BenchmarkIssue[]
  }): Promise<EvalPipelineReport> {
    const issues = options?.issues || this.getGoldenDataset()
    const harness = new BenchmarkHarness(this.ctx)

    const { stdout: rootGitTop } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
    const gitRoot = rootGitTop.trim()

    let headCommit = 'HEAD'
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: gitRoot })
      headCommit = stdout.trim()
    } catch {}

    const isAutoBranch = !options?.targetBranch
    const targetBranch = options?.targetBranch || `eval-target-${Date.now().toString(36)}`

    // Ensure target branch exists and starts at HEAD
    await execFileAsync('git', ['branch', '-f', targetBranch, 'HEAD'], { cwd: gitRoot })

    let summary: BenchmarkResult
    try {
      summary = await harness.runBenchmark(issues, targetBranch)
    } finally {
      if (isAutoBranch) {
        try {
          await this.ctx.a3hReconciliation?.cleanupStaging()
        } catch {}
        try {
          await execFileAsync('git', ['branch', '-D', targetBranch], { cwd: gitRoot })
        } catch {}
      }
    }

    // Calculate simulated mean cost per bug (e.g. 500 prompt tokens + 150 completion tokens per turn)
    const simulatedCostPerTurn = (500 * 0.00000014) + (150 * 0.00000028)
    const meanCostPerBugUsd = summary.averageTurns * simulatedCostPerTurn

    const currentRun: RegressionRunRecord = {
      id: `eval_${Date.now()}`,
      timestamp: new Date().toISOString(),
      gitCommit: headCommit,
      totalIssues: summary.totalIssues,
      passedCount: summary.passedCount,
      passAt1Rate: summary.passAt1Rate,
      averageTurns: summary.averageTurns,
      averageDurationMs: summary.averageDurationMs,
      meanCostPerBugUsd,
      contextBounded: summary.contextBounded,
      withMemory: options?.withMemory ?? true,
      issues: summary.issues.map(i => ({
        id: i.id,
        passed: i.passed,
        turns: i.turns,
        durationMs: i.durationMs,
      })),
    }

    // Load history and detect regressions
    const history = await this.loadHistory()
    let regressionDetected = false
    let deltaPassRate: number | undefined

    if (history.length > 0) {
      const previous = history[history.length - 1]
      deltaPassRate = currentRun.passAt1Rate - previous.passAt1Rate
      if (currentRun.passAt1Rate < previous.passAt1Rate) {
        regressionDetected = true
      }
    }

    history.push(currentRun)
    await this.saveHistory(history)

    return {
      currentRun,
      historyCount: history.length,
      regressionDetected,
      deltaPassRate,
    }
  }

  async runGoldenRegressionSuite(options?: {
    count?: number
    threshold?: number
    targetBranch?: string
    fallbackTier?: 'level_1_navigation' | 'level_2_implementation' | 'level_3_reasoning'
    simulatedPassCount?: number
  }): Promise<GoldenRegressionReport> {
    const allIssues = getGoldenDataset()
    const count = options?.count ?? allIssues.length
    const issues = allIssues.slice(0, count)
    const harness = new BenchmarkHarness(this.ctx)

    const { stdout: rootGitTop } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
    const gitRoot = rootGitTop.trim()

    const isAutoBranch = !options?.targetBranch
    const targetBranch = options?.targetBranch || `golden-eval-${Date.now().toString(36)}`
    await execFileAsync('git', ['branch', '-f', targetBranch, 'HEAD'], { cwd: gitRoot })

    let summary: BenchmarkResult
    try {
      summary = await harness.runBenchmark(issues, targetBranch)
    } finally {
      if (isAutoBranch) {
        try {
          await this.ctx.a3hReconciliation?.cleanupStaging()
        } catch {}
        try {
          await execFileAsync('git', ['branch', '-D', targetBranch], { cwd: gitRoot })
        } catch {}
      }
    }

    // Allow simulated test count for explicit regression testing if requested
    let passedCount = summary.passedCount
    if (typeof options?.simulatedPassCount === 'number') {
      passedCount = options.simulatedPassCount
    }

    const passAt1Rate = issues.length > 0 ? passedCount / issues.length : 0
    const threshold = options?.threshold ?? 0.85

    // Calculate cost envelope ($1.00/M tokens for Tier 2 code repair * ~1500 tokens/turn * avg turns)
    const costPerTurnUSD = (1500 / 1_000_000) * 1.00
    const costPerBugUSD = Math.max(0.001, summary.averageTurns * costPerTurnUSD)
    const withinBudget = costPerBugUSD <= 1.50

    let regressionDetected = false
    let fallbackTriggered = false

    if (passAt1Rate < threshold || !withinBudget) {
      regressionDetected = true
      const targetTier = options?.fallbackTier ?? 'level_2_implementation'
      if (this.ctx.a3hRouter) {
        this.ctx.a3hRouter.triggerFallbackProvider(targetTier)
        fallbackTriggered = true
      }
      this.ctx.emit('a3h/model-regression-detected', {
        passAt1Rate,
        targetThreshold: threshold,
        message: `Regression detected: Pass@1 rate ${(passAt1Rate * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(1)}%`,
      })
    }

    const activeModel = this.ctx.a3hRouter?.getActiveTierConfig('level_2_implementation')?.model || 'deepseek-coder'

    const report: GoldenRegressionReport = {
      timestamp: new Date().toISOString(),
      totalTested: issues.length,
      passedCount,
      passAt1Rate,
      averageTurns: summary.averageTurns,
      costPerBugUSD,
      withinBudget,
      regressionDetected,
      fallbackTriggered,
      activeModel,
      issues: summary.issues.map(i => ({
        id: i.id,
        name: i.name,
        passed: i.passed,
        turns: i.turns,
        durationMs: i.durationMs,
      })),
    }

    // Save to golden eval history
    const goldenHistoryFile = path.resolve('.a3h-data/golden-eval-history.json')
    try {
      await fs.mkdir(path.dirname(goldenHistoryFile), { recursive: true })
      let existing: any[] = []
      try {
        existing = JSON.parse(await fs.readFile(goldenHistoryFile, 'utf8'))
      } catch {}
      existing.push(report)
      await fs.writeFile(goldenHistoryFile, JSON.stringify(existing, null, 2), 'utf8')
    } catch {}

    return report
  }

  async loadHistory(): Promise<RegressionRunRecord[]> {
    try {
      const raw = await fs.readFile(this.historyFile, 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  private async saveHistory(history: RegressionRunRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.historyFile), { recursive: true })
    await fs.writeFile(this.historyFile, JSON.stringify(history, null, 2), 'utf8')
  }
}
