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
  BackgroundAgentWorker
} from './dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runStressTests() {
  console.log('=== Starting Phase 6 Concurrency Stress & Chaos Suite ===\n');

  const testDbPath = path.resolve('.a3h-data/test-stress.sqlite');
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
  const recon = ctx.a3hReconciliation;
  const reaper = ctx.a3hReaper;

  const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = rootGitTop.trim();
  const stressBranch = 'test-stress-target';

  console.log(`Setting up isolated stress target branch: ${stressBranch}...`);
  await exec('git', ['branch', '-f', stressBranch, 'HEAD'], { cwd: gitRoot });

  const landedTasks = [];
  ctx.on('a3h/task-landed', (evt) => {
    landedTasks.push(evt.taskId);
  });
  ctx.on('a3h/reconciliation-failed', (evt) => {
    console.log(`[EVENT] a3h/reconciliation-failed for task ${evt.taskId}: ${evt.reason}`);
  });

  try {
    // ----------------------------------------------------
    // STRESS 1: The Fork Test (3 Parallel Concurrent Tasks)
    // ----------------------------------------------------
    console.log('\n--- STRESS 1: The Fork Test (3 Parallel Tasks) ---');
    const tasks = ['stress-fork-1', 'stress-fork-2', 'stress-fork-3'];
    const files = ['module_a.ts', 'module_b.ts', 'module_c.ts'];

    // Spawn 3 tasks in parallel
    const worktreePromises = tasks.map((taskId) => sandbox.allocate(taskId, stressBranch));
    const worktreePaths = await Promise.all(worktreePromises);

    for (let i = 0; i < tasks.length; i++) {
      const taskId = tasks[i];
      const wtPath = worktreePaths[i];
      const fileName = files[i];

      const fullFile = path.join(wtPath, fileName);
      await fs.writeFile(fullFile, `export const ${fileName.replace('.', '_')} = "Worker ${i + 1}";\n`);
      await exec('git', ['add', fileName], { cwd: wtPath });
      await exec('git', ['commit', '--no-verify', '-m', `Worker ${i + 1} adds ${fileName}`], { cwd: wtPath });

      storage.createTask({
        id: taskId,
        instruction: `Create ${fileName}`,
        worktree_path: wtPath,
        git_branch: `feature/task-${taskId}`,
        base_commit_hash: 'HEAD',
        status: 'running'
      });
    }

    console.log('Dispatching 3 tasks to Reconciliation Queue concurrently...');
    await Promise.all(
      tasks.map((taskId) => recon.enqueueTask(taskId, `feature/task-${taskId}`, stressBranch))
    );

    await recon.processQueue();

    for (const taskId of tasks) {
      const record = storage.getReconciliationByTaskId(taskId);
      console.log(`Task ${taskId} queue_status: ${record?.queue_status}`);
      if (record?.queue_status !== 'merged') {
        throw new Error(`FAIL: Task ${taskId} did not merge cleanly! Got: ${record?.queue_status}`);
      }
    }

    console.log('✔ PASS: Fork Test: 3 concurrent tasks merged sequentially without index.lock collisions.');

    // ----------------------------------------------------
    // STRESS 2: The Conflict Collision Test
    // ----------------------------------------------------
    console.log('\n--- STRESS 2: The Conflict Collision Test ---');
    const taskColA = 'stress-col-a';
    const taskColB = 'stress-col-b';
    const sharedApiFile = 'api_endpoint.ts';

    // Seed shared base file into stressBranch
    const stagingPath = await recon.getStagingPath();
    const sharedPath = path.join(stagingPath, sharedApiFile);
    await fs.writeFile(
      sharedPath,
      'export function handleRequest(req: any) {\n  return "BASE_RESPONSE";\n}\n'
    );
    await exec('git', ['add', sharedApiFile], { cwd: stagingPath });
    await exec('git', ['commit', '--no-verify', '-m', 'Add base api_endpoint.ts'], { cwd: stagingPath });
    await exec('git', ['branch', '-f', stressBranch, 'landing-staging'], { cwd: gitRoot });

    // Allocate both workers from the updated stress branch
    const wtColA = await sandbox.allocate(taskColA, stressBranch);
    const wtColB = await sandbox.allocate(taskColB, stressBranch);

    // Worker A updates endpoint A
    await fs.writeFile(
      path.join(wtColA, sharedApiFile),
      'export function handleRequestA(req: any) {\n  return "RESPONSE_ALPHA";\n}\n'
    );
    await exec('git', ['add', sharedApiFile], { cwd: wtColA });
    await exec('git', ['commit', '--no-verify', '-m', 'Worker A update'], { cwd: wtColA });

    // Worker B updates endpoint B (divergent conflict on same line)
    await fs.writeFile(
      path.join(wtColB, sharedApiFile),
      'export function handleRequestB(req: any) {\n  return "RESPONSE_BETA";\n}\n'
    );
    await exec('git', ['add', sharedApiFile], { cwd: wtColB });
    await exec('git', ['commit', '--no-verify', '-m', 'Worker B update'], { cwd: wtColB });

    console.log('Landing Worker A first...');
    await recon.enqueueTask(taskColA, `feature/task-${taskColA}`, stressBranch);
    await recon.processQueue();

    console.log('Landing Worker B with collision...');
    await recon.enqueueTask(taskColB, `feature/task-${taskColB}`, stressBranch);
    await recon.processQueue();

    const recordColB = storage.getReconciliationByTaskId(taskColB);
    console.log(`Worker B status: ${recordColB?.queue_status}, resolver attempts: ${recordColB?.resolver_attempts}`);

    if (recordColB?.queue_status !== 'merged') {
      throw new Error(`FAIL: Conflict collision was not merged! Status: ${recordColB?.queue_status}`);
    }
    if (recordColB?.resolver_attempts === 0) {
      throw new Error('FAIL: Conflict resolver was not invoked for collision!');
    }

    console.log('✔ PASS: Conflict Collision Test: collision trapped, resolved via resolver subagent, and landed.');

    // ----------------------------------------------------
    // STRESS 3: The Chaos Interrupt & Dead Lease Recovery
    // ----------------------------------------------------
    console.log('\n--- STRESS 3: The Chaos Interrupt & Dead Lease Recovery ---');
    const taskChaos = 'stress-chaos-dead';
    const wtChaos = await sandbox.allocate(taskChaos, stressBranch);

    // Simulate an aborted process where worker was killed abruptly
    await fs.writeFile(path.join(wtChaos, 'partial_work.ts'), 'incomplete work\n');

    storage.createTask({
      id: taskChaos,
      instruction: 'Chaos victim task',
      worktree_path: wtChaos,
      git_branch: `feature/task-${taskChaos}`,
      base_commit_hash: 'HEAD',
      status: 'running',
      lease_expires_at: new Date(Date.now() - 45_000).toISOString() // expired 45s ago
    });

    console.log('Executing Reaper sweep on crashed worker...');
    const sweep = await reaper.sweep();

    if (!sweep.reapedTasks.includes(taskChaos)) {
      throw new Error(`FAIL: Reaper failed to reap crashed task ${taskChaos}!`);
    }

    const chaosRecord = storage.getTask(taskChaos);
    console.log(`Chaos task status in SQLite: ${chaosRecord?.status}, failure_reason: ${chaosRecord?.failure_reason}`);
    if (chaosRecord?.status !== 'failed' || chaosRecord?.failure_reason !== 'internal_crash') {
      throw new Error('FAIL: Crashed task not transitioned to failed/internal_crash!');
    }

    let chaosWorktreeExists = true;
    try {
      await fs.access(wtChaos);
    } catch {
      chaosWorktreeExists = false;
    }
    console.log(`Orphan worktree cleaned up? ${!chaosWorktreeExists}`);
    if (chaosWorktreeExists) {
      throw new Error('FAIL: Crashed task worktree was not purged by reaper!');
    }

    console.log('✔ PASS: Chaos Recovery: crashed worker identified, dead lease harvested, orphan sandbox purged.');

    console.log('\n======================================================');
    console.log('ALL PHASE 6 CONCURRENCY & CHAOS TESTS PASSED! ✔✔✔');
    console.log('======================================================\n');
  } finally {
    try {
      await recon.cleanupStaging();
    } catch {}
    try {
      await exec('git', ['branch', '-D', stressBranch], { cwd: gitRoot });
    } catch {}
  }
}

runStressTests().catch((err) => {
  console.error('Stress test suite failed:', err);
  process.exit(1);
});
