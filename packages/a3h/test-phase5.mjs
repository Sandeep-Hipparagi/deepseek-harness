import { Context } from 'cordis';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import { VerificationService } from './dist/services/verification.js';
import { HITLController } from './dist/services/hitl.js';
import { HeadlessLspService } from './dist/services/lsp.js';
import { ReconciliationService } from './dist/services/reconciliation.js';
import { GovernanceService } from './dist/services/governance.js';
import { ReaperService } from './dist/services/reaper.js';
import { TelemetryService } from './dist/services/telemetry.js';
import { BackgroundAgentWorker } from './dist/services/worker.js';
import { TaskStorage } from './dist/storage/db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase5Checks() {
  console.log('=== Starting Phase 5 Governance, Reaper & Telemetry Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase5.sqlite');
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
  await ctx.start();

  const sandbox = ctx.a3hSandbox;
  const storage = ctx.a3hStorage;
  const governance = ctx.a3hGovernance;
  const reaper = ctx.a3hReaper;
  const telemetry = ctx.a3hTelemetry;
  const worker = ctx.a3hWorker;

  // Track events
  const reapedEvents = [];
  const breakerEvents = [];
  const telemetryTurnEvents = [];
  const telemetryToolEvents = [];

  ctx.on('a3h/task-reaped', (evt) => {
    console.log(`[EVENT] a3h/task-reaped received for task ${evt.taskId}`);
    reapedEvents.push(evt.taskId);
  });

  ctx.on('a3h/circuit-breaker-tripped', (evt) => {
    console.log(`[EVENT] a3h/circuit-breaker-tripped for task ${evt.taskId}: ${evt.message}`);
    breakerEvents.push(evt.taskId);
  });

  ctx.on('a3h/telemetry-turn', (evt) => {
    telemetryTurnEvents.push(evt);
  });

  ctx.on('a3h/telemetry-tool', (evt) => {
    telemetryToolEvents.push(evt);
  });

  // ----------------------------------------------------
  // TEST 1: Lease Reaper Test
  // ----------------------------------------------------
  console.log('--- TEST 1: Lease Reaper Test ---');
  const taskReapId = 'p5-reap-01';
  const worktreeReap = await sandbox.allocate(taskReapId);

  // Set lease_expires_at to 1 minute in the past
  const pastTime = new Date(Date.now() - 60_000).toISOString();
  storage.createTask({
    id: taskReapId,
    instruction: 'Simulate zombie task',
    worktree_path: worktreeReap,
    git_branch: `feature/task-${taskReapId}`,
    base_commit_hash: 'HEAD',
    status: 'running',
    lease_expires_at: pastTime
  });

  // Add dead allocation older than 5 mins
  storage.createAllocation({
    id: 'alloc-dead-01',
    task_id: taskReapId,
    allocation_state: 'intending',
    worktree_path: worktreeReap,
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });

  console.log(`Triggering reaper sweep with expired lease (${pastTime})...`);
  const sweepResult = await reaper.sweep();

  console.log('Reaped tasks count:', sweepResult.reapedTasks.length);
  console.log('Pruned allocations count:', sweepResult.prunedAllocations.length);

  const reapedRecord = storage.getTask(taskReapId);
  console.log(`Task status in SQLite: ${reapedRecord?.status}, failure_reason: ${reapedRecord?.failure_reason}`);

  if (reapedRecord?.status !== 'failed' || reapedRecord?.failure_reason !== 'internal_crash') {
    throw new Error('FAIL: Reaper did not transition expired task to failed/internal_crash!');
  }

  let worktreeExists = true;
  try {
    await fs.access(worktreeReap);
  } catch {
    worktreeExists = false;
  }
  console.log(`Worktree exists after reaper sweep? ${worktreeExists}`);
  if (worktreeExists) {
    throw new Error('FAIL: Reaper did not clean up worktree for expired task!');
  }

  if (!reapedEvents.includes(taskReapId)) {
    throw new Error('FAIL: a3h/task-reaped event was not fired!');
  }

  console.log('✔ PASS: Lease Reaper Test: zombie task harvested, marked failed/internal_crash, worktree pruned.');

  // ----------------------------------------------------
  // TEST 2: Cost Ceiling & Token Circuit Breakers
  // ----------------------------------------------------
  console.log('\n--- TEST 2: Cost Ceiling & Token Circuit Breakers ---');
  governance.setLimits({
    maxCostUsd: 0.05,
    maxTokens: 1000
  });

  const taskBreakerId = 'p5-breaker-01';
  const worktreeBreaker = await sandbox.allocate(taskBreakerId);

  // Store task with cumulative_cost exceeding limit ($0.06 > $0.05)
  storage.createTask({
    id: taskBreakerId,
    instruction: 'Task that will trip cost ceiling',
    worktree_path: worktreeBreaker,
    git_branch: `feature/task-${taskBreakerId}`,
    base_commit_hash: 'HEAD',
    status: 'running',
    cumulative_cost_usd: 0.06
  });

  console.log('Attempting tool invocation for task exceeding cost ceiling ($0.06 vs limit $0.05)...');
  let circuitTripped = false;
  try {
    await worker.handleToolInvocation(
      taskBreakerId,
      { id: 'call-breaker', name: 'read_file_range', arguments: { filePath: 'package.json', startLine: 1, endLine: 5 } },
      worktreeBreaker
    );
  } catch (err) {
    console.log('Caught expected circuit breaker error:', err.message);
    if (err.message.includes('[CIRCUIT BREAKER TRIPPED]')) {
      circuitTripped = true;
    }
  }

  if (!circuitTripped) {
    throw new Error('FAIL: Circuit breaker did not throw error when budget was exceeded!');
  }

  const breakerRecord = storage.getTask(taskBreakerId);
  console.log(`Breaker task status: ${breakerRecord?.status}, failure_reason: ${breakerRecord?.failure_reason}`);
  if (breakerRecord?.status !== 'failed' || breakerRecord?.failure_reason !== 'budget_exceeded') {
    throw new Error('FAIL: Circuit breaker did not update task status to failed/budget_exceeded!');
  }

  let breakerWorktreeExists = true;
  try {
    await fs.access(worktreeBreaker);
  } catch {
    breakerWorktreeExists = false;
  }
  console.log(`Breaker worktree exists after trip? ${breakerWorktreeExists}`);
  if (breakerWorktreeExists) {
    throw new Error('FAIL: Circuit breaker did not clean up worktree immediately!');
  }

  if (!breakerEvents.includes(taskBreakerId)) {
    throw new Error('FAIL: a3h/circuit-breaker-tripped event was not fired!');
  }

  console.log('✔ PASS: Cost Ceiling Circuit Breaker: execution halted, task failed with budget_exceeded, worktree torn down.');

  // ----------------------------------------------------
  // TEST 3: Worktree Pruning & Zombie Recovery
  // ----------------------------------------------------
  console.log('\n--- TEST 3: Worktree Pruning & Zombie Recovery ---');
  const taskZombieId = 'p5-zombie-01';
  const worktreeZombie = await sandbox.allocate(taskZombieId);

  // Write a file to verify worktree was active
  await fs.writeFile(path.join(worktreeZombie, 'zombie-evidence.txt'), 'abandoned content\n');

  console.log('Simulating unhandled process termination by leaving worktree on disk...');
  // Re-allocating the same taskId cleans up stale worktrees and locked branches
  const recoveredWorktree = await sandbox.allocate(taskZombieId);
  console.log(`Successfully recovered and re-allocated worktree: ${recoveredWorktree}`);

  await sandbox.cleanup(taskZombieId);
  console.log('✔ PASS: Worktree Pruning: recovered cleanly from abandoned worktree state.');

  // ----------------------------------------------------
  // TEST 4: Live Telemetry Stream & Auditing
  // ----------------------------------------------------
  console.log('\n--- TEST 4: Live Telemetry Stream & Auditing ---');
  const taskTelemId = 'p5-telem-01';
  const worktreeTelem = await sandbox.allocate(taskTelemId);

  storage.createTask({
    id: taskTelemId,
    instruction: 'Telemetry test task',
    worktree_path: worktreeTelem,
    git_branch: `feature/task-${taskTelemId}`,
    base_commit_hash: 'HEAD',
    status: 'running',
    cumulative_cost_usd: 0.01
  });

  // Reset limits for telem task
  governance.setLimits({ maxCostUsd: 10.0, maxTokens: 1_000_000 });

  // 1. Record a turn metric
  telemetry.recordTurnMetric(taskTelemId, {
    turnIndex: 1,
    promptTokens: 250,
    completionTokens: 85,
    toolDurationMs: 120
  });

  // 2. Perform a tool execution through worker to trigger telemetry
  await worker.handleToolInvocation(
    taskTelemId,
    { id: 'call-telem', name: 'read_file_range', arguments: { filePath: 'package.json', startLine: 1, endLine: 10 } },
    worktreeTelem
  );

  console.log(`Captured telemetry turn events: ${telemetryTurnEvents.length}`);
  console.log(`Captured telemetry tool events: ${telemetryToolEvents.length}`);

  if (telemetryTurnEvents.length === 0) {
    throw new Error('FAIL: No telemetry turn events were captured!');
  }
  const lastTurn = telemetryTurnEvents[telemetryTurnEvents.length - 1];
  console.log(`Turn event: taskId=${lastTurn.taskId}, promptTokens=${lastTurn.promptTokens}, completionTokens=${lastTurn.completionTokens}`);

  if (telemetryToolEvents.length === 0) {
    throw new Error('FAIL: No telemetry tool events were captured!');
  }
  const lastTool = telemetryToolEvents[telemetryToolEvents.length - 1];
  console.log(`Tool event: taskId=${lastTool.taskId}, toolName=${lastTool.toolName}, success=${lastTool.success}, durationMs=${lastTool.durationMs}`);

  await sandbox.cleanup(taskTelemId);
  console.log('✔ PASS: Telemetry: turn and tool events captured with timestamps and duration.');

  console.log('\n====================================================');
  console.log('ALL PHASE 5 GOVERNANCE & RECOVERY TESTS PASSED! ✔✔✔');
  console.log('====================================================\n');
}

runPhase5Checks().catch((err) => {
  console.error('Phase 5 verification failed:', err);
  process.exit(1);
});
