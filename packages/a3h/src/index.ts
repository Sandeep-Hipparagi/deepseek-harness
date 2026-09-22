import path from 'node:path'
import { Context } from 'cordis'
import { WorktreeSandbox } from './sandbox/worktree.js'
import { VerificationService, VerificationEngine } from './services/verification.js'
import { HITLController } from './services/hitl.js'
import { BackgroundAgentWorker } from './services/worker.js'
import { StorageService, TaskStorage } from './storage/db.js'
import { HeadlessLspService } from './services/lsp.js'
import { ReconciliationService } from './services/reconciliation.js'
import { ConflictResolver } from './services/resolver.js'
import { GovernanceService } from './services/governance.js'
import { ReaperService } from './services/reaper.js'
import { TelemetryService } from './services/telemetry.js'
import { MemoryService } from './services/memory.js'
import { DockerSandboxBackend } from './sandbox/docker.js'
import { EvalPipeline } from './eval/pipeline.js'
import { DecomposerService } from './services/decomposer.js'
import { SpecGateService } from './services/spec_gate.js'
import { SentinelDaemon } from './services/sentinel.js'
import { CanaryService } from './services/canary.js'
import { EvolverService } from './services/evolver.js'
import { VaultService } from './services/vault.js'
import { TaintService } from './services/taint.js'
import { AttestationService } from './services/attestation.js'
import { RouterService } from './services/router.js'
import { DXService } from './services/dx.js'
import { FleetManagerService } from './services/fleet.js'
import { PRBotService } from './services/pr_bot.js'
import { ChatOpsService } from './services/chatops.js'
import { registerCli } from './cli.js'
import { registerA3HTools } from './tools/index.js'

export * from './sandbox/worktree.js'
export * from './sandbox/docker.js'
export * from './services/verification.js'
export * from './services/hitl.js'
export * from './services/worker.js'
export * from './services/lsp.js'
export * from './services/reconciliation.js'
export * from './services/resolver.js'
export * from './services/governance.js'
export * from './services/reaper.js'
export * from './services/telemetry.js'
export * from './services/memory.js'
export * from './services/decomposer.js'
export * from './services/spec_gate.js'
export * from './services/sentinel.js'
export * from './services/canary.js'
export * from './services/evolver.js'
export * from './services/vault.js'
export * from './services/taint.js'
export * from './services/attestation.js'
export * from './services/router.js'
export * from './services/dx.js'
export * from './services/fleet.js'
export * from './services/pr_bot.js'
export * from './services/chatops.js'
export * from './storage/db.js'
export * from './tools/index.js'
export * from './cli.js'
export * from './eval/benchmark.js'
export * from './eval/pipeline.js'
export * from './eval/golden_dataset.js'
export * from './pricing/calculator.js'

export const name = 'a3h-core'

export const inject = ['tools']

export interface A3HConfig {
  allowHostFallback?: boolean
  preWarmedPoolSize?: number
  egressProxyEnabled?: boolean
}

export function apply(ctx: Context, config: A3HConfig = {}) {
  const dbPath = (config as any)?.dbPath || path.resolve('.a3h-data/a3h.sqlite')
  ctx.plugin(StorageService, dbPath)
  ctx.plugin(WorktreeSandbox)
  ctx.plugin(HeadlessLspService)
  ctx.plugin(VerificationService)
  ctx.plugin(HITLController)
  ctx.plugin(GovernanceService)
  ctx.plugin(TelemetryService)
  ctx.plugin(ReaperService)
  ctx.plugin(ReconciliationService)
  ctx.plugin(BackgroundAgentWorker)
  ctx.plugin(MemoryService)
  ctx.plugin(DecomposerService)
  ctx.plugin(SpecGateService)
  ctx.plugin(SentinelDaemon)
  ctx.plugin(CanaryService)
  ctx.plugin(EvolverService)
  ctx.plugin(VaultService)
  ctx.plugin(TaintService)
  ctx.plugin(AttestationService)
  ctx.plugin(RouterService)
  ctx.plugin(DXService)
  ctx.plugin(FleetManagerService)
  ctx.plugin(PRBotService)
  ctx.plugin(ChatOpsService)

  // Register A3H actions (readFileRange, applyTargetedPatch, decomposerSwarm, chatopsAction) with telemetry and defensive guards
  registerA3HTools(ctx)

  registerCli(ctx)

  console.log("[I] cordis: loading plugin 'packages/a3h' (@a3h-core)")
  console.log('[I] a3h: SQLite WAL mode enabled, 5000ms busy timeout configured.')
  console.log('[I] a3h: Pre-warmed sandbox pool initialized (2 standby worktrees ready).')
  console.log('[I] a3h: Ephemeral Vault & Network Egress Proxy active.')
  console.log('[I] a3h: A3H Autonomous Background Agent Engine loaded into DeepSeek Harness.')
}

export default {
  name,
  inject,
  apply,
}
