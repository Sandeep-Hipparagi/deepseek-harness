import { Context } from 'cordis';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import { VerificationService } from './dist/services/verification.js';
import { HITLController } from './dist/services/hitl.js';
import { HeadlessLspService } from './dist/services/lsp.js';
import { ReconciliationService } from './dist/services/reconciliation.js';
import { BackgroundAgentWorker } from './dist/services/worker.js';
import { GovernanceService } from './dist/services/governance.js';
import { TelemetryService } from './dist/services/telemetry.js';
import { TaskStorage } from './dist/storage/db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase4Checks() {
  console.log('=== Starting Phase 4 Multi-Agent Convergence & Landing Pipeline Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase4.sqlite');
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
  ctx.plugin(ReconciliationService);
  ctx.plugin(BackgroundAgentWorker);
  await ctx.start();

  const sandbox = ctx.a3hSandbox;
  const storage = ctx.a3hStorage;
  const recon = ctx.a3hReconciliation;

  // Track events
  const landedEvents = [];
  const conflictEvents = [];

  ctx.on('a3h/task-landed', (evt) => {
    console.log(`[EVENT] a3h/task-landed received for task ${evt.taskId}`);
    landedEvents.push(evt.taskId);
  });

  ctx.on('a3h/conflict-escalated', (evt) => {
    console.log(`[EVENT] a3h/conflict-escalated received for task ${evt.taskId}`);
    conflictEvents.push(evt.taskId);
  });

  // Setup isolated target branch for testing
  const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = rootGitTop.trim();
  const testTargetBranch = 'test-phase4-landing-target';

  console.log(`Creating test landing branch: ${testTargetBranch}...`);
  await exec('git', ['branch', '-f', testTargetBranch, 'HEAD'], { cwd: gitRoot });

  try {
    // ----------------------------------------------------
    // Checklist Item 1: Concurrent Independence
    // Spawn two tasks modifying different files in parallel.
    // ----------------------------------------------------
    console.log('\n--- TEST 1: Concurrent Independence ---');
    const taskA = 'p4-alpha';
    const taskB = 'p4-beta';

    const worktreeA = await sandbox.allocate(taskA, testTargetBranch);
    const worktreeB = await sandbox.allocate(taskB, testTargetBranch);

    // Agent Alpha modifies file-alpha.txt
    const fileA = path.join(worktreeA, 'file-alpha.txt');
    await fs.writeFile(fileA, 'Content from Agent Alpha\n');
    await exec('git', ['add', 'file-alpha.txt'], { cwd: worktreeA });
    await exec('git', ['commit', '-m', 'Agent Alpha commit'], { cwd: worktreeA });

    // Agent Beta modifies file-beta.txt
    const fileB = path.join(worktreeB, 'file-beta.txt');
    await fs.writeFile(fileB, 'Content from Agent Beta\n');
    await exec('git', ['add', 'file-beta.txt'], { cwd: worktreeB });
    await exec('git', ['commit', '-m', 'Agent Beta commit'], { cwd: worktreeB });

    console.log('Enqueueing Task Alpha and Task Beta concurrently...');
    await recon.enqueueTask(taskA, `feature/task-${taskA}`, testTargetBranch);
    await recon.enqueueTask(taskB, `feature/task-${taskB}`, testTargetBranch);

    // Wait for queue processing to complete
    await recon.processQueue();

    const recordA = storage.getReconciliationByTaskId(taskA);
    const recordB = storage.getReconciliationByTaskId(taskB);

    console.log(`Task Alpha status: ${recordA?.queue_status}`);
    console.log(`Task Beta status: ${recordB?.queue_status}`);

    if (recordA?.queue_status !== 'merged' || recordB?.queue_status !== 'merged') {
      throw new Error(`FAIL: Concurrent independence merge failed! Alpha: ${recordA?.queue_status}, Beta: ${recordB?.queue_status}`);
    }

    if (!landedEvents.includes(taskA) || !landedEvents.includes(taskB)) {
      throw new Error('FAIL: a3h/task-landed events not fired for both tasks!');
    }

    console.log('✔ PASS: Concurrent Independence: both parallel tasks merged sequentially without collision.');

    // ----------------------------------------------------
    // Checklist Item 2: Textual Conflict Trapping
    // Spawn two tasks modifying the exact same line in a file.
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Textual Conflict Trapping ---');
    const taskGamma = 'p4-gamma';
    const taskDelta = 'p4-delta';

    // First commit a base file to target branch
    const stagingPath = await recon.getStagingPath();
    const sharedFile = 'shared-config.txt';
    const sharedFilePath = path.join(stagingPath, sharedFile);
    await fs.writeFile(sharedFilePath, 'line 1\nCOMMON_CONFIG=default\nline 3\n');
    await exec('git', ['add', sharedFile], { cwd: stagingPath });
    await exec('git', ['commit', '-m', 'Base shared config commit'], { cwd: stagingPath });
    await exec('git', ['branch', '-f', testTargetBranch, 'landing-staging'], { cwd: gitRoot });

    // Allocate Gamma and Delta from updated target branch
    const worktreeGamma = await sandbox.allocate(taskGamma, testTargetBranch);
    const worktreeDelta = await sandbox.allocate(taskDelta, testTargetBranch);

    // Gamma changes line 2
    await fs.writeFile(path.join(worktreeGamma, sharedFile), 'line 1\nCOMMON_CONFIG=gamma_setting\nline 3\n');
    await exec('git', ['add', sharedFile], { cwd: worktreeGamma });
    await exec('git', ['commit', '-m', 'Gamma modifies config'], { cwd: worktreeGamma });

    // Delta changes line 2 differently
    await fs.writeFile(path.join(worktreeDelta, sharedFile), 'line 1\nCOMMON_CONFIG=delta_setting\nline 3\n');
    await exec('git', ['add', sharedFile], { cwd: worktreeDelta });
    await exec('git', ['commit', '-m', 'Delta modifies config'], { cwd: worktreeDelta });

    console.log('Landing Gamma first...');
    await recon.enqueueTask(taskGamma, `feature/task-${taskGamma}`, testTargetBranch);
    await recon.processQueue();

    const recordGamma = storage.getReconciliationByTaskId(taskGamma);
    console.log(`Gamma status: ${recordGamma?.queue_status}`);
    if (recordGamma?.queue_status !== 'merged') {
      throw new Error('FAIL: Gamma failed to land!');
    }

    console.log('Landing Delta (conflicting on line 2)...');
    await recon.enqueueTask(taskDelta, `feature/task-${taskDelta}`, testTargetBranch);
    await recon.processQueue();

    const recordDelta = storage.getReconciliationByTaskId(taskDelta);
    console.log(`Delta status: ${recordDelta?.queue_status}, resolver attempts: ${recordDelta?.resolver_attempts}`);

    if (recordDelta?.queue_status !== 'merged') {
      throw new Error(`FAIL: Delta failed to resolve and land! Status: ${recordDelta?.queue_status}`);
    }
    if (recordDelta?.resolver_attempts === 0) {
      throw new Error('FAIL: Resolver was not triggered for conflicting Delta branch!');
    }

    console.log('✔ PASS: Textual Conflict Trapping: merge conflict trapped, resolved via resolver, and landed.');

    // ----------------------------------------------------
    // Checklist Item 3: Escalation Circuit Breaker
    // Feed an unresolvable conflicting file to the resolver.
    // Confirm git merge --abort, conflict_escalated status,
    // and subsequent queued task proceeds.
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Escalation Circuit Breaker ---');
    const taskZeta = 'p4-zeta';
    const taskEta = 'p4-eta';
    const taskTheta = 'p4-theta';

    const unresolvableFile = 'circuit-breaker.txt';
    const unresolvableFilePath = path.join(stagingPath, unresolvableFile);
    await fs.writeFile(unresolvableFilePath, 'base initial content\n');
    await exec('git', ['add', unresolvableFile], { cwd: stagingPath });
    await exec('git', ['commit', '-m', 'Base circuit breaker commit'], { cwd: stagingPath });
    await exec('git', ['branch', '-f', testTargetBranch, 'landing-staging'], { cwd: gitRoot });

    const worktreeZeta = await sandbox.allocate(taskZeta, testTargetBranch);
    const worktreeEta = await sandbox.allocate(taskEta, testTargetBranch);
    const worktreeTheta = await sandbox.allocate(taskTheta, testTargetBranch);

    // Zeta commits UNRESOLVABLE contradiction A
    await fs.writeFile(path.join(worktreeZeta, unresolvableFile), 'UNRESOLVABLE contradiction A\n');
    await exec('git', ['add', unresolvableFile], { cwd: worktreeZeta });
    await exec('git', ['commit', '-m', 'Zeta contradiction A'], { cwd: worktreeZeta });

    // Eta commits UNRESOLVABLE contradiction B
    await fs.writeFile(path.join(worktreeEta, unresolvableFile), 'UNRESOLVABLE contradiction B\n');
    await exec('git', ['add', unresolvableFile], { cwd: worktreeEta });
    await exec('git', ['commit', '-m', 'Eta contradiction B'], { cwd: worktreeEta });

    // Theta modifies an independent clean file
    await fs.writeFile(path.join(worktreeTheta, 'theta-clean.txt'), 'Theta clean independent work\n');
    await exec('git', ['add', 'theta-clean.txt'], { cwd: worktreeTheta });
    await exec('git', ['commit', '-m', 'Theta clean work'], { cwd: worktreeTheta });

    // Land Zeta first
    console.log('Landing Zeta...');
    await recon.enqueueTask(taskZeta, `feature/task-${taskZeta}`, testTargetBranch);
    await recon.processQueue();

    // Now enqueue Eta (unresolvable) followed immediately by Theta (clean)
    console.log('Enqueueing Eta (unresolvable conflict) and Theta (clean subsequent task)...');
    await recon.enqueueTask(taskEta, `feature/task-${taskEta}`, testTargetBranch);
    await recon.enqueueTask(taskTheta, `feature/task-${taskTheta}`, testTargetBranch);

    // Process both in queue
    await recon.processQueue();

    const recordEta = storage.getReconciliationByTaskId(taskEta);
    const recordTheta = storage.getReconciliationByTaskId(taskTheta);

    console.log(`Eta status: ${recordEta?.queue_status}`);
    console.log(`Theta status: ${recordTheta?.queue_status}`);

    if (recordEta?.queue_status !== 'conflict_escalated') {
      throw new Error(`FAIL: Eta was expected to be 'conflict_escalated', got '${recordEta?.queue_status}'`);
    }

    if (!conflictEvents.includes(taskEta)) {
      throw new Error('FAIL: a3h/conflict-escalated event was not fired for Eta!');
    }

    if (recordTheta?.queue_status !== 'merged') {
      throw new Error(`FAIL: Subsequent task Theta was blocked by Eta failure! Theta status: '${recordTheta?.queue_status}'`);
    }

    if (!landedEvents.includes(taskTheta)) {
      throw new Error('FAIL: a3h/task-landed event not fired for subsequent task Theta!');
    }

    console.log('✔ PASS: Escalation Circuit Breaker: unresolvable conflict aborted and escalated without blocking subsequent queued tasks.');

    console.log('\n====================================================');
    console.log('ALL PHASE 4 CONVERGENCE & LANDING TESTS PASSED! ✔✔✔');
    console.log('====================================================\n');
  } finally {
    // Cleanup staging and test branch
    try {
      await recon.cleanupStaging();
    } catch {}
    try {
      await exec('git', ['branch', '-D', testTargetBranch], { cwd: gitRoot });
    } catch {}
  }
}

runPhase4Checks().catch(err => {
  console.error('Phase 4 verification failed:', err);
  process.exit(1);
});
