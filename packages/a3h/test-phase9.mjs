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
  EvolverService
} from './dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase9TestSuite() {
  console.log('=== Starting Phase 9 Autonomous Production Verification, Canary & Self-Evolution ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase9.sqlite');
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

  await ctx.start();

  const canary = ctx.a3hCanary;
  const evolver = ctx.a3hEvolver;
  const worker = ctx.a3hWorker;
  const sandbox = ctx.a3hSandbox;

  const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = rootGitTop.trim();

  const branchHealthy = 'test-phase9-canary-healthy';
  const branchRollback = 'test-phase9-canary-rollback';
  const branchMemory = 'test-phase9-canary-memory';

  // Event tracking
  const promotedEvents = [];
  const rolledBackEvents = [];

  ctx.on('a3h/canary-promoted', (evt) => {
    console.log(`[EVENT a3h/canary-promoted] Deployment: ${evt.deploymentId} | Task: ${evt.taskId}`);
    promotedEvents.push(evt);
  });

  ctx.on('a3h/canary-rolled-back', (evt) => {
    console.log(`[EVENT a3h/canary-rolled-back] Deployment: ${evt.deploymentId} | Incident: ${evt.incidentId} | Reason: ${evt.reason}`);
    rolledBackEvents.push(evt);
  });

  try {
    // ----------------------------------------------------
    // TEST 1: Canary Deployment & Healthy Metric Evaluation
    // ----------------------------------------------------
    console.log('--- TEST 1: Canary Deployment & Healthy Traffic Evaluation ---');
    await exec('git', ['branch', '-f', branchHealthy, 'HEAD'], { cwd: gitRoot });

    const { stdout: headSha } = await exec('git', ['rev-parse', branchHealthy], { cwd: gitRoot });
    const currentSha = headSha.trim();

    const healthyDeployment = await canary.deployCanary('p9-healthy-task', currentSha, branchHealthy);
    console.log(`Canary allocated: ${healthyDeployment.id} at ${healthyDeployment.worktreePath}`);

    if (healthyDeployment.status !== 'canary_active') {
      throw new Error(`FAIL: Expected status 'canary_active', got '${healthyDeployment.status}'`);
    }

    // Synthetic green traffic
    const greenTraffic = {
      requestCount: 1000,
      syntheticErrors: 0,
      syntheticLatencyMs: [15, 20, 22, 25, 28, 30, 35, 40], // well below 50ms baseline
      memoryReadingsMb: [120, 122, 121, 122, 120] // stable heap
    };

    const healthyResult = await canary.evaluateCanary(healthyDeployment, greenTraffic, {
      baselineP99LatencyMs: 50,
      maxErrorRateDelta: 0.00001,
      maxP99LatencyMultiplier: 1.10
    });

    console.log('Healthy Evaluation Result:', healthyResult);
    if (!healthyResult.healthy || healthyResult.violations.length !== 0 || healthyResult.recommendation !== 'promote') {
      throw new Error(`FAIL: Canary healthy check failed: ${JSON.stringify(healthyResult)}`);
    }
    if (healthyDeployment.status !== 'promoted') {
      throw new Error(`FAIL: Deployment status was not updated to 'promoted'!`);
    }
    if (promotedEvents.length !== 1) {
      throw new Error('FAIL: a3h/canary-promoted event was not emitted!');
    }
    await sandbox.cleanup(healthyDeployment.id);
    console.log('✔ PASS: Canary deployment passed all gates and promoted to production fleet.\n');

    // ----------------------------------------------------
    // TEST 2: Degradation Trapping & Autonomous Git Revert Rollback
    // ----------------------------------------------------
    console.log('--- TEST 2: Degradation Trapping & Autonomous Git Revert Rollback ---');
    await exec('git', ['branch', '-f', branchRollback, 'HEAD'], { cwd: gitRoot });

    // Seed a bad commit on branchRollback
    const badWt = await sandbox.allocate('p9_seed_bad', branchRollback);
    const badFilePath = path.join(badWt, 'src/bad_feature.mjs');
    await fs.mkdir(path.dirname(badFilePath), { recursive: true });
    await fs.writeFile(
      badFilePath,
      'export function executeBadLogic() {\n  throw new Error("Critical production crash on line 2");\n}\n',
      'utf8'
    );
    await exec('git', ['add', '.'], { cwd: badWt });
    await exec('git', ['commit', '--no-verify', '-m', 'feat: introduce bad logic causing degradation'], { cwd: badWt });
    const { stdout: badCommitOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: badWt });
    const badCommitSha = badCommitOut.trim();
    await exec('git', ['branch', '-f', branchRollback, badCommitSha], { cwd: gitRoot });
    await sandbox.cleanup('p9_seed_bad');

    console.log(`Bad commit created on ${branchRollback}: ${badCommitSha}`);

    const badDeployment = await canary.deployCanary('p9-bad-task', badCommitSha, branchRollback);

    // Synthetic degraded traffic: elevated error rate (2%) and high p99 latency (120ms vs 50ms limit)
    const degradedTraffic = {
      requestCount: 500,
      syntheticErrors: 10, // 2% error rate
      syntheticLatencyMs: [45, 55, 75, 95, 120, 140],
      memoryReadingsMb: [120, 122, 121, 123]
    };

    const degradedResult = await canary.evaluateCanary(badDeployment, degradedTraffic, {
      baselineP99LatencyMs: 50,
      maxErrorRateDelta: 0.00001,
      maxP99LatencyMultiplier: 1.10
    });

    console.log('Degraded Evaluation Result:', degradedResult);
    if (degradedResult.healthy || degradedResult.violations.length < 2 || degradedResult.recommendation !== 'rollback') {
      throw new Error(`FAIL: Canary failed to trap degradation violations: ${JSON.stringify(degradedResult)}`);
    }

    console.log('Triggering Autonomous Rollback Circuit Breaker...');
    const rollbackResult = await canary.rollback(
      badDeployment,
      degradedResult.violations.join('; '),
      {
        stderr: 'Error: Critical production crash on line 2\n    at executeBadLogic (src/bad_feature.mjs:2:9)',
        stackTrace: 'Error: Critical production crash on line 2\n    at executeBadLogic (src/bad_feature.mjs:2:9)',
        metrics: degradedResult.metrics
      }
    );

    console.log('Rollback Result:', rollbackResult);
    if (!rollbackResult.success || !rollbackResult.revertCommitSha) {
      throw new Error(`FAIL: Rollback did not succeed: ${JSON.stringify(rollbackResult)}`);
    }

    // Verify git revert commit exists on branchRollback
    const { stdout: logOut } = await exec('git', ['log', '-n', '2', '--oneline', branchRollback], { cwd: gitRoot });
    console.log('Git Log after Rollback:\n' + logOut);
    if (!logOut.toLowerCase().includes('revert')) {
      throw new Error(`FAIL: Expected revert commit in git log for ${branchRollback}!`);
    }

    // Verify incident report artifact exists
    const incidentDir = path.resolve(gitRoot, '.agent/incidents');
    const incidentJson = path.join(incidentDir, `${rollbackResult.incidentCapsule.incidentId}.json`);
    const incidentMd = path.join(incidentDir, `${rollbackResult.incidentCapsule.incidentId}.md`);
    const hasJson = await fs.stat(incidentJson).then(() => true).catch(() => false);
    const hasMd = await fs.stat(incidentMd).then(() => true).catch(() => false);

    if (!hasJson || !hasMd) {
      throw new Error(`FAIL: Incident capsule files were not persisted to .agent/incidents!`);
    }

    if (rolledBackEvents.length !== 1) {
      throw new Error('FAIL: a3h/canary-rolled-back event was not emitted!');
    }
    console.log('✔ PASS: Degradation trapped, atomic git revert executed, and incident capsule recorded.\n');

    // ----------------------------------------------------
    // TEST 3: Monotonic Memory Leak Detection
    // ----------------------------------------------------
    console.log('--- TEST 3: Monotonic Memory Leak Detection ---');
    await exec('git', ['branch', '-f', branchMemory, 'HEAD'], { cwd: gitRoot });

    const memDeployment = await canary.deployCanary('p9-mem-task', currentSha, branchMemory);

    // Monotonic climbing heap: 100MB -> 135MB -> 170MB -> 210MB -> 255MB
    const leakyTraffic = {
      requestCount: 500,
      syntheticErrors: 0,
      syntheticLatencyMs: [25, 30, 35],
      memoryReadingsMb: [100, 135, 170, 210, 255]
    };

    const memResult = await canary.evaluateCanary(memDeployment, leakyTraffic, {
      checkMemoryLeaks: true
    });

    console.log('Memory Leak Evaluation Result:', memResult);
    if (memResult.healthy || !memResult.metrics.memoryLeakDetected) {
      throw new Error(`FAIL: Monotonic memory leak was not detected! ${JSON.stringify(memResult)}`);
    }
    if (!memResult.violations.some((v) => v.includes('Monotonic memory leak'))) {
      throw new Error(`FAIL: Memory leak violation text missing! ${JSON.stringify(memResult.violations)}`);
    }
    await sandbox.cleanup(memDeployment.id);
    console.log('✔ PASS: Monotonic memory leak detected and flagged for rollback.\n');

    // ----------------------------------------------------
    // TEST 4: Trajectory Self-Evolution & Warm-Start Loop Closure
    // ----------------------------------------------------
    console.log('--- TEST 4: Trajectory Self-Evolution & Warm-Start Loop Closure ---');

    // Use incident capsule from Test 2
    const incidentCapsule = rollbackResult.incidentCapsule;
    console.log(`Ingesting incident capsule ${incidentCapsule.incidentId} into EvolverService...`);

    const evolutionResult = await evolver.evolveFromIncident(incidentCapsule, gitRoot);
    console.log('Self-Evolution Result:', evolutionResult);

    if (!evolutionResult.injectedToLearnings) {
      throw new Error('FAIL: Self-evolution failed to inject rule into learnings.md!');
    }
    if (evolutionResult.attribution.faultingFile !== 'src/bad_feature.mjs') {
      throw new Error(`FAIL: Expected faultingFile 'src/bad_feature.mjs', got '${evolutionResult.attribution.faultingFile}'`);
    }

    // Verify .agent/learnings.md contains the synthesized rule tag
    const learningsContent = await fs.readFile(evolutionResult.learningsFilePath, 'utf8');
    console.log('\nLearnings Content Preview:\n' + learningsContent.split('\n').slice(-6).join('\n'));

    if (!learningsContent.includes(evolutionResult.synthesizedRule.tag)) {
      throw new Error('FAIL: Synthesized rule not found in learnings.md!');
    }

    // Verify zero-turn warm-start: newly spawned task system prompt contains the rule
    const warmPrompt = await worker.getTaskInitialPrompt(
      'task-p9-next-gen',
      'Refactor API logic',
      gitRoot
    );

    console.log('\nWarm-Start Agent Prompt Preview:\n' + warmPrompt.split('\n').slice(0, 10).join('\n') + '\n...');
    if (!warmPrompt.includes(evolutionResult.synthesizedRule.tag)) {
      throw new Error('FAIL: Warm-start prompt does not include newly evolved rule!');
    }

    console.log('✔ PASS: Self-evolution closed Day-2 loop: failure attributed, rule synthesized, and warm-start immunity verified.\n');

    console.log('========================================================================');
    console.log('ALL PHASE 9 CANARY, ROLLBACK & SELF-EVOLUTION TESTS PASSED! ✔✔✔');
    console.log('========================================================================\n');
  } finally {
    for (const b of [branchHealthy, branchRollback, branchMemory]) {
      try {
        await exec('git', ['branch', '-D', b], { cwd: gitRoot });
      } catch {}
    }
    try {
      await ctx.stop();
    } catch {}
  }
}

runPhase9TestSuite().catch((err) => {
  console.error('Phase 9 verification failed:', err);
  process.exit(1);
});
