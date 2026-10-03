import { Context } from 'cordis';
import {
  TaskStorage,
  WorktreeSandbox,
  HeadlessLspService,
  VerificationService,
  HITLController,
  GovernanceService,
  TelemetryService,
  ReaperService,
  ReconciliationService,
  BackgroundAgentWorker,
  MemoryService,
  DecomposerService,
  SpecGateService,
  SentinelDaemon,
  CanaryService,
  EvolverService,
  VaultService,
  TaintService,
  AttestationService,
  RouterService,
  DXService,
  FleetManagerService
} from './dist/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';

async function runFleetOperationsTestSuite() {
  console.log('=== Starting Fleet Production Operations, Productization & Economics Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-fleet.sqlite');
  try {
    await fs.unlink(testDbPath);
  } catch {}

  const ctx = new Context();
  ctx.plugin(TaskStorage, testDbPath);
  ctx.plugin(WorktreeSandbox);
  ctx.plugin(HeadlessLspService);
  ctx.plugin(VerificationService);
  ctx.plugin(HITLController);
  ctx.plugin(GovernanceService);
  ctx.plugin(TelemetryService);
  ctx.plugin(ReaperService);
  ctx.plugin(ReconciliationService);
  ctx.plugin(BackgroundAgentWorker);
  ctx.plugin(MemoryService);
  ctx.plugin(DecomposerService);
  ctx.plugin(SpecGateService);
  ctx.plugin(SentinelDaemon);
  ctx.plugin(CanaryService);
  ctx.plugin(EvolverService);
  ctx.plugin(VaultService);
  ctx.plugin(TaintService);
  ctx.plugin(AttestationService);
  ctx.plugin(RouterService);
  ctx.plugin(DXService);
  ctx.plugin(FleetManagerService);

  await ctx.start();

  const router = ctx.a3hRouter;
  const dx = ctx.a3hDX;
  const fleet = ctx.a3hFleet;

  try {
    // ----------------------------------------------------
    // TEST 1: Tiered Model Arbitration & Prompt Cache Maximization
    // ----------------------------------------------------
    console.log('--- TEST 1: Tiered Model Arbitration & Unit Economics Optimization ---');

    // 1a. Model Tier Routing
    const routeL1 = router.routeTurn({ action: 'read_file_range' });
    console.log(`Action 'read_file_range' -> Tier: ${routeL1.tier} (${routeL1.model}, $${routeL1.estimatedCostPerM}/M)`);
    if (routeL1.tier !== 'level_1_navigation' || routeL1.model !== 'deepseek-v3') {
      throw new Error(`FAIL: Expected level_1_navigation for read_file_range, got: ${routeL1.tier}`);
    }

    const routeL2 = router.routeTurn({ action: 'apply_patch' });
    console.log(`Action 'apply_patch'     -> Tier: ${routeL2.tier} (${routeL2.model}, $${routeL2.estimatedCostPerM}/M)`);
    if (routeL2.tier !== 'level_2_implementation' || routeL2.model !== 'deepseek-coder') {
      throw new Error(`FAIL: Expected level_2_implementation for apply_patch, got: ${routeL2.tier}`);
    }

    const routeL3 = router.routeTurn({ action: 'decompose_macro', taskType: 'macro' });
    console.log(`Action 'decompose_macro' -> Tier: ${routeL3.tier} (${routeL3.model}, $${routeL3.estimatedCostPerM}/M)`);
    if (routeL3.tier !== 'level_3_reasoning' || routeL3.model !== 'deepseek-r1') {
      throw new Error(`FAIL: Expected level_3_reasoning for decompose_macro, got: ${routeL3.tier}`);
    }

    // 1b. Prompt Cache Optimization
    const staticSystemPrompt = `### [A3H Invariant System Context & Repository Instructions]
You are an autonomous engineering agent operating inside an isolated git worktree.
Rules:
1. Always verify code with test suites before declaring completion.
2. Maintain zero-trust security boundaries.
3. Observe p99 latency budgets.
`.repeat(10); // Large static prefix

    const dynamicTurnHistory = [
      { role: 'user', content: 'Inspect the auth validator error on line 42.' },
      { role: 'assistant', content: 'Calling read_file_range lines 30-60...' }
    ];

    const cacheResult = router.optimizePromptCache(staticSystemPrompt, dynamicTurnHistory);
    console.log(`Cache Optimization: Prefix Tokens=${cacheResult.cachePrefixTokens}, Hit Rate=${(cacheResult.estimatedHitRate * 100).toFixed(1)}%`);

    if (cacheResult.estimatedHitRate < 0.90) {
      throw new Error(`FAIL: Expected >=90% prefix cache hit rate, got: ${cacheResult.estimatedHitRate}`);
    }

    // 1c. Unit Economics Tracking
    // Simulate 50 navigation turns (L1), 20 code repair turns (L2), and 2 architecture turns (L3)
    for (let i = 0; i < 50; i++) router.recordUsage('level_1_navigation', 4000, 200, true);
    for (let i = 0; i < 20; i++) router.recordUsage('level_2_implementation', 8000, 1000, true);
    for (let i = 0; i < 2; i++) router.recordUsage('level_3_reasoning', 12000, 2500, true);

    const econReport = router.getEconomicsSummary();
    console.log('\n=== Unit Economics Summary Report ===');
    console.log(`Total Requests:         ${econReport.totalRequests}`);
    console.log(`Actual Tiered Spend:    $${econReport.actualSpendUSD.toFixed(4)} USD`);
    console.log(`Unrouted Baseline:      $${econReport.baselineFrontierSpendUSD.toFixed(4)} USD`);
    console.log(`Total Cost Saved:       $${econReport.totalSavedUSD.toFixed(4)} USD`);
    console.log(`Efficiency Savings:     ${econReport.savingsPercentage.toFixed(1)}%`);

    if (econReport.savingsPercentage < 60) {
      throw new Error(`FAIL: Expected >=60% cost savings with tiered routing, got: ${econReport.savingsPercentage}%`);
    }
    console.log('✔ PASS: Dynamic model arbitration and unit economics optimization verified.\n');

    // ----------------------------------------------------
    // TEST 2: Developer Experience (DX) & Batched PR Portfolios
    // ----------------------------------------------------
    console.log('--- TEST 2: Developer Experience & Batched PR Portfolio Generation ---');

    const prPortfolio = dx.createBatchedPR({
      portfolioTitle: 'Feature: Multi-Tenant Zero-Trust Fleet Upgrade',
      targetBranch: 'master',
      macroObjective: 'Consolidate authentication refactor, vault broker, and attestation ledger into clean PR release.',
      tasks: [
        {
          taskId: 'task-auth-01',
          title: 'Lucia session schema refactor',
          filesModified: ['src/models/core.ts'],
          testStatus: 'passed',
          attestationVerified: true,
          canaryPassed: true
        },
        {
          taskId: 'task-vault-02',
          title: 'Ephemeral secret broker & JIT vault',
          filesModified: ['src/services/vault.ts'],
          testStatus: 'passed',
          attestationVerified: true,
          canaryPassed: true
        },
        {
          taskId: 'task-attest-03',
          title: 'In-toto cryptographic ledger signing',
          filesModified: ['src/services/attestation.ts'],
          testStatus: 'passed',
          attestationVerified: true,
          canaryPassed: true
        }
      ]
    });

    console.log('Batched PR Preview:\n' + prPortfolio.markdownContent.split('\n').slice(0, 15).join('\n') + '\n...');

    if (!prPortfolio.allVerified || prPortfolio.totalSubtasks !== 3 || prPortfolio.totalFilesModified !== 3) {
      throw new Error(`FAIL: Batched PR summary counts incorrect: ${JSON.stringify(prPortfolio)}`);
    }
    if (!prPortfolio.markdownContent.includes('In--Toto Attestation') || !prPortfolio.markdownContent.includes('mermaid')) {
      throw new Error('FAIL: Batched PR markdown missing badges or mermaid diagram!');
    }

    // 2b. ChatOps Notification Formatting
    const chatOpsAlert = dx.formatChatOpsAlert({
      taskId: 'task-auth-01',
      title: 'Restricted Action: Database Migration',
      reason: 'Schema modification requires production review',
      confidence: 0.94,
      environment: 'production-canary',
      worktreePath: '/workspace/.worktrees/task-auth-01'
    });

    console.log(`ChatOps Payload: Channel=${chatOpsAlert.channel}, Blocks=${chatOpsAlert.blocks.length}`);
    const actionBlock = chatOpsAlert.blocks.find((b) => b.type === 'actions');
    if (!actionBlock || actionBlock.elements.length < 2) {
      throw new Error('FAIL: ChatOps alert missing interactive approval action buttons!');
    }

    // 2c. Alert Curation & Noise Filtering
    const noisyAlert = dx.curateAlert({
      source: 'linter_bot',
      confidence: 0.45,
      message: 'Unused import found in legacy test'
    });
    if (noisyAlert.shouldNotify) {
      throw new Error('FAIL: Noisy low-confidence alert was not suppressed!');
    }

    const urgentAlert = dx.curateAlert({
      source: 'canary_monitor',
      confidence: 0.95,
      message: 'Monotonic memory climb detected in worker'
    });
    if (!urgentAlert.shouldNotify || urgentAlert.priority !== 'high') {
      throw new Error('FAIL: High-confidence critical alert was not prioritized!');
    }
    console.log('✔ PASS: Batched PR portfolio, badges, ChatOps actions, and alert curation verified.\n');

    // ----------------------------------------------------
    // TEST 3: Pre-Warmed Worktree Pool & Sub-Second Spawning
    // ----------------------------------------------------
    console.log('--- TEST 3: Pre-Warmed Worktree Pool & Sub-Second Task Spawning ---');

    console.log('Pre-warming fleet worktree pool (capacity: 2)...');
    const warmedCount = await fleet.prewarmPool(2, 'master');
    console.log(`Pre-warmed pool ready with ${warmedCount} sandboxes.`);

    if (warmedCount !== 2) {
      throw new Error(`FAIL: Expected 2 warmed sandboxes, got: ${warmedCount}`);
    }

    // Acquire sandbox from pre-warmed pool
    const allocation = await fleet.acquireWorktree('task-subsecond-spawn-01', 'master');
    console.log(`Allocated sandbox in: ${allocation.latencyMs}ms (Pre-warmed? ${allocation.isPrewarmed})`);
    console.log(`Path: ${allocation.worktreePath}`);

    if (!allocation.isPrewarmed) {
      throw new Error('FAIL: Allocation did not pull from pre-warmed pool!');
    }
    if (allocation.latencyMs > 100) {
      throw new Error(`FAIL: Pre-warmed allocation exceeded sub-second threshold: ${allocation.latencyMs}ms`);
    }

    await fleet.cleanupPool();
    console.log('✔ PASS: Pre-warmed pool allocated sandbox sub-second with zero wait overhead.\n');

    // ----------------------------------------------------
    // TEST 4: Declarative Fleet Policy Enforcement
    // ----------------------------------------------------
    console.log('--- TEST 4: Declarative Policy-as-Code Fleet Enforcement ---');

    // 4a. Protected branch violation
    const mainPushCheck = fleet.evaluatePolicies('git_push', { branch: 'main' });
    console.log('Policy check on git_push to main:', mainPushCheck);
    if (mainPushCheck.allowed || !mainPushCheck.violations.some((v) => v.includes('main/master') || v.includes('Protected Branch'))) {
      throw new Error('FAIL: Policy engine permitted direct push to main branch!');
    }

    // 4b. Root execution violation
    const rootCheck = fleet.evaluatePolicies('execute_bash', { command: 'sudo chown root /etc/shadow' });
    console.log('Policy check on sudo command:', rootCheck);
    if (rootCheck.allowed || !rootCheck.violations.some((v) => v.includes('Privileged root'))) {
      throw new Error('FAIL: Policy engine permitted root command execution!');
    }

    // 4c. Permitted safe action
    const safeCheck = fleet.evaluatePolicies('git_push', { branch: 'feature/task-safe' });
    if (!safeCheck.allowed || safeCheck.violations.length !== 0) {
      throw new Error('FAIL: Safe branch push was blocked unexpectedly by policy engine!');
    }

    console.log('✔ PASS: Policy-as-code successfully enforced enterprise governance rules.\n');

    console.log('========================================================================');
    console.log('ALL FLEET PRODUCTION OPERATIONS & PRODUCTIZATION TESTS PASSED! ✔✔✔');
    console.log('========================================================================\n');
  } finally {
    try {
      await fleet.cleanupPool();
      await ctx.stop();
    } catch {}
  }
}

runFleetOperationsTestSuite().catch((err) => {
  console.error('Fleet operations verification failed:', err);
  process.exit(1);
});
