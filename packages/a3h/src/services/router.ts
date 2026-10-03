import { Context, Service } from 'cordis'

export type ModelTier = 'level_1_navigation' | 'level_2_implementation' | 'level_3_reasoning'

export interface ModelTierConfig {
  tier: ModelTier
  model: string
  description: string
  inputCostPerM: number
  outputCostPerM: number
  cachedInputCostPerM: number
}

export interface ModelTierSelection {
  tier: ModelTier
  model: string
  reason: string
  estimatedCostPerM: number
}

export interface TurnMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CacheOptimizationResult {
  optimizedMessages: TurnMessage[]
  cachePrefixTokens: number
  estimatedHitRate: number // e.g. 0.92 (92%)
}

export interface EconomicsReport {
  totalRequests: number
  tierCounts: Record<ModelTier, number>
  totalTokens: {
    prompt: number
    completion: number
    cachedPrompt: number
  }
  actualSpendUSD: number
  baselineFrontierSpendUSD: number
  totalSavedUSD: number
  savingsPercentage: number
}

declare module 'cordis' {
  interface Context {
    a3hRouter: RouterService
  }
  interface Events {
    'a3h/model-fallback-triggered'(evt: { tier: ModelTier; previousModel: string; activeModel: string; reason: string }): void
    'a3h/model-regression-detected'(evt: { passAt1Rate: number; targetThreshold: number; message: string }): void
  }
}

export class RouterService extends Service {
  private tierConfigs: Record<ModelTier, ModelTierConfig> = {
    level_1_navigation: {
      tier: 'level_1_navigation',
      model: 'llama3.1:8b',
      description: 'Ultra-fast open weights for navigation, formatting & cartography',
      inputCostPerM: 0.10,
      outputCostPerM: 0.20,
      cachedInputCostPerM: 0.02,
    },
    level_2_implementation: {
      tier: 'level_2_implementation',
      model: 'llama3.1:8b',
      description: 'Specialized code generation & targeted single-file repair',
      inputCostPerM: 1.00,
      outputCostPerM: 2.00,
      cachedInputCostPerM: 0.20,
    },
    level_3_reasoning: {
      tier: 'level_3_reasoning',
      model: 'llama3.1:8b',
      description: 'Frontier reasoning for macro-DAG architecture & 3-way conflict arbitration',
      inputCostPerM: 5.00,
      outputCostPerM: 15.00,
      cachedInputCostPerM: 1.00,
    },
  }

  private fallbackModels: Record<ModelTier, string> = {
    level_1_navigation: 'llama3.1:8b',
    level_2_implementation: 'llama3.1:8b',
    level_3_reasoning: 'llama3.1:8b',
  }

  private usageStats = {
    level_1_navigation: { count: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    level_2_implementation: { count: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    level_3_reasoning: { count: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
  }

  constructor(ctx: Context) {
    super(ctx, 'a3hRouter', true)
  }

  getActiveTierConfig(tier: ModelTier): ModelTierConfig {
    return this.tierConfigs[tier]
  }

  triggerFallbackProvider(tier: ModelTier, customFallbackModel?: string, reason = 'Model accuracy regression detected'): void {
    const previousModel = this.tierConfigs[tier].model
    const activeModel = customFallbackModel || this.fallbackModels[tier]
    this.tierConfigs[tier].model = activeModel
    this.ctx.emit('a3h/model-fallback-triggered', {
      tier,
      previousModel,
      activeModel,
      reason,
    })
  }

  routeTurn(request: {
    action: string
    taskType?: string
    complexity?: 'trivial' | 'standard' | 'complex'
  }): ModelTierSelection {
    const act = request.action.toLowerCase()
    const type = (request.taskType || '').toLowerCase()

    // Level 3: Frontier Architecture, Conflict Resolution, Incident Triage
    if (
      request.complexity === 'complex' ||
      act.includes('decompose') ||
      act.includes('resolve_conflict') ||
      act.includes('spec_review') ||
      act.includes('triage') ||
      type.includes('macro') ||
      type.includes('architecture')
    ) {
      const cfg = this.tierConfigs.level_3_reasoning
      return {
        tier: cfg.tier,
        model: cfg.model,
        reason: 'Complex reasoning required for macro-architecture, 3-way conflict, or spec review.',
        estimatedCostPerM: cfg.inputCostPerM,
      }
    }

    // Level 1: Trivial Navigation, Skeletons, Formatting, Read-only LSP
    if (
      request.complexity === 'trivial' ||
      act.includes('read_file_range') ||
      act.includes('get_file_outline') ||
      act.includes('find_symbol') ||
      act.includes('list_dir') ||
      act.includes('format') ||
      act.includes('lint_check')
    ) {
      const cfg = this.tierConfigs.level_1_navigation
      return {
        tier: cfg.tier,
        model: cfg.model,
        reason: 'High-speed lightweight model optimal for bounded navigation and AST extraction.',
        estimatedCostPerM: cfg.inputCostPerM,
      }
    }

    // Level 2: Standard Code Implementation & Repair (Default)
    const cfg = this.tierConfigs.level_2_implementation
    return {
      tier: cfg.tier,
      model: cfg.model,
      reason: 'Code specialist model balanced for targeted patch application and single-file repairs.',
      estimatedCostPerM: cfg.inputCostPerM,
    }
  }

  optimizePromptCache(systemPrompt: string, history: TurnMessage[]): CacheOptimizationResult {
    // Prefix-cache architecture:
    // Place all invariant repository memory and base instructions at the very beginning of the prompt.
    // Dynamic turn interactions are appended at the end.
    const staticPrefix = systemPrompt.trim()
    const prefixTokens = Math.ceil(staticPrefix.length / 4)

    const optimizedMessages: TurnMessage[] = [
      { role: 'system', content: staticPrefix },
      ...history,
    ]

    // Estimate prefix-cache hit rate based on static prefix ratio
    const dynamicChars = history.map(m => m.content).join('').length
    const totalChars = staticPrefix.length + dynamicChars
    const estimatedHitRate = totalChars > 0 ? Math.min(0.96, Math.max(0.70, staticPrefix.length / totalChars + 0.15)) : 0.90

    return {
      optimizedMessages,
      cachePrefixTokens: prefixTokens,
      estimatedHitRate,
    }
  }

  recordUsage(tier: ModelTier, promptTokens: number, completionTokens: number, cached: boolean): void {
    const stats = this.usageStats[tier]
    stats.count++
    stats.promptTokens += promptTokens
    stats.completionTokens += completionTokens
    if (cached) {
      // 90% of prompt tokens treated as cached
      stats.cachedTokens += Math.floor(promptTokens * 0.90)
    }
  }

  getEconomicsSummary(): EconomicsReport {
    let actualSpendUSD = 0
    let baselineFrontierSpendUSD = 0
    let totalPrompt = 0
    let totalCompletion = 0
    let totalCached = 0
    let totalRequests = 0

    const tierCounts: Record<ModelTier, number> = {
      level_1_navigation: 0,
      level_2_implementation: 0,
      level_3_reasoning: 0,
    }

    const frontierCfg = this.tierConfigs.level_3_reasoning

    for (const [t, s] of Object.entries(this.usageStats) as [ModelTier, typeof this.usageStats[ModelTier]][]) {
      const cfg = this.tierConfigs[t]
      tierCounts[t] = s.count
      totalRequests += s.count
      totalPrompt += s.promptTokens
      totalCompletion += s.completionTokens
      totalCached += s.cachedTokens

      const nonCachedPrompt = s.promptTokens - s.cachedTokens
      const tierCost =
        (nonCachedPrompt / 1_000_000) * cfg.inputCostPerM +
        (s.cachedTokens / 1_000_000) * cfg.cachedInputCostPerM +
        (s.completionTokens / 1_000_000) * cfg.outputCostPerM

      actualSpendUSD += tierCost

      // Unrouted baseline: all requests processed by Level 3 without cache
      const baselineCost =
        (s.promptTokens / 1_000_000) * frontierCfg.inputCostPerM +
        (s.completionTokens / 1_000_000) * frontierCfg.outputCostPerM

      baselineFrontierSpendUSD += baselineCost
    }

    const totalSavedUSD = Math.max(0, baselineFrontierSpendUSD - actualSpendUSD)
    const savingsPercentage =
      baselineFrontierSpendUSD > 0 ? (totalSavedUSD / baselineFrontierSpendUSD) * 100 : 0

    return {
      totalRequests,
      tierCounts,
      totalTokens: {
        prompt: totalPrompt,
        completion: totalCompletion,
        cachedPrompt: totalCached,
      },
      actualSpendUSD,
      baselineFrontierSpendUSD,
      totalSavedUSD,
      savingsPercentage,
    }
  }
}
