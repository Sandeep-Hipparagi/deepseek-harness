import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from 'cordis';
import { TaskStorage } from './dist/storage/db.js';
import { BackgroundAgentWorker } from './dist/services/worker.js';
import { ReaperService } from './dist/services/reaper.js';
import { CanaryService } from './dist/services/canary.js';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import { DockerSandboxBackend } from './dist/sandbox/docker.js';
import { VerificationService } from './dist/services/verification.js';
import { HITLController } from './dist/services/hitl.js';
import { HeadlessLspService } from './dist/services/lsp.js';
import { GovernanceService } from './dist/services/governance.js';
import { TelemetryService } from './dist/services/telemetry.js';

const exec = promisify(execFile);

test('Security & Concurrency Audit Validations', async (t) => {
  const testDbDir = path.resolve('.a3h-data');
  await fs.mkdir(testDbDir, { recursive: true });

  await t.test('SQLite WAL mode and busy timeout are configured', async () => {
    const dbPath = path.resolve('.a3h-data/test-chaos-wal.sqlite');
    try {
      await fs.unlink(dbPath);
    } catch {}

    const ctx = new Context();
    ctx.plugin(TaskStorage, dbPath);
    await ctx.start();

    const storage = ctx.a3hStorage;
    // Inspect PRAGMA values directly from internal db connection
    const journalModeRow = storage.db.prepare('PRAGMA journal_mode;').get();
    const busyTimeoutRow = storage.db.prepare('PRAGMA busy_timeout;').get();
    const synchronousRow = storage.db.prepare('PRAGMA synchronous;').get();

    console.log(`[TEST] SQLite PRAGMAs: journal_mode=${journalModeRow.journal_mode}, busy_timeout=${busyTimeoutRow.timeout}, synchronous=${synchronousRow.synchronous}`);
    assert.strictEqual(journalModeRow.journal_mode.toLowerCase(), 'wal', 'Journal mode must be WAL');
    assert.ok(Number(busyTimeoutRow.timeout) >= 5000, 'Busy timeout must be >= 5000ms');

    await ctx.stop();
  });

  await t.test('Docker sandbox enforces allowHostFallback check and scrubs sensitive environment', async () => {
    const backend = new DockerSandboxBackend();

    // Test 1: fail-closed when allowHostFallback is false and docker is unavailable
    // Mock isDockerAvailable to return false
    backend.isDockerAvailable = async () => false;

    await assert.rejects(
      async () => {
        await backend.execConfined(process.cwd(), 'echo', ['test'], {
          allowHostFallback: false
        });
      },
      /\[SECURITY ALERT\] Container execution failed or Docker daemon unreachable, and allowHostFallback is disabled\./,
      'Must reject execution when allowHostFallback is false'
    );

    // Test 2: In fallback mode, sensitive credentials must NOT be leaked
    process.env['AWS_ACCESS_KEY_ID'] = 'LEAKED_AWS_KEY_SECRET';
    process.env['GITHUB_TOKEN'] = 'LEAKED_GH_TOKEN';

    const result = await backend.execConfined(
      process.cwd(),
      process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32'
        ? ['/c', 'echo AWS=%AWS_ACCESS_KEY_ID% GH=%GITHUB_TOKEN%']
        : ['-c', 'echo AWS=$AWS_ACCESS_KEY_ID GH=$GITHUB_TOKEN']
    );

    assert.ok(!result.output.includes('LEAKED_AWS_KEY_SECRET'), 'AWS_ACCESS_KEY_ID must be scrubbed');
    assert.ok(!result.output.includes('LEAKED_GH_TOKEN'), 'GITHUB_TOKEN must be scrubbed');

    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['GITHUB_TOKEN'];
  });

  await t.test('Worker heartbeat prevents premature reaper eviction on long turns', async () => {
    const dbPath = path.resolve('.a3h-data/test-chaos-heartbeat.sqlite');
    try {
      await fs.unlink(dbPath);
    } catch {}

    const ctx = new Context();
    ctx.plugin(TaskStorage, dbPath);
    ctx.plugin(WorktreeSandbox);
    ctx.plugin(HeadlessLspService);
    ctx.plugin(VerificationService);
    ctx.plugin(HITLController);
    ctx.plugin(GovernanceService);
    ctx.plugin(TelemetryService);
    ctx.plugin(ReaperService);
    ctx.plugin(BackgroundAgentWorker);
    await ctx.start();

    const storage = ctx.a3hStorage;
    const worker = ctx.a3hWorker;
    const reaper = ctx.a3hReaper;

    const taskId = 'task-heartbeat-01';
    // Initially set lease to expire in 100ms
    const initialLease = new Date(Date.now() + 100).toISOString();
    storage.createTask({
      id: taskId,
      instruction: 'Test long running task heartbeat',
      worktree_path: process.cwd(),
      git_branch: 'feature/task-hb',
      base_commit_hash: 'HEAD',
      status: 'running',
      lease_expires_at: initialLease
    });

    // Start fast heartbeat (every 50ms, extending lease by 1000ms)
    const heartbeatTimer = worker.startTaskHeartbeat(taskId, 50, 1000);

    // Wait 150ms (which would have expired initial lease without heartbeat)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Sweep with reaper
    const sweepResult = await reaper.sweep();
    assert.ok(!sweepResult.reapedTasks.includes(taskId), 'Task must NOT be reaped while heartbeat is active');

    // Confirm lease was extended
    const updatedTask = storage.getTask(taskId);
    assert.ok(
      new Date(updatedTask.lease_expires_at).getTime() > new Date(initialLease).getTime(),
      'Lease must have been extended into the future by heartbeat'
    );

    clearInterval(heartbeatTimer);
    await ctx.stop();
  });

  await t.test('Conflicted Canary rollback cleanly aborts without dirtying worktree', async () => {
    const { stdout: topLevel } = await exec('git', ['rev-parse', '--show-toplevel']);
    const gitRoot = topLevel.trim();

    const dbPath = path.resolve('.a3h-data/test-chaos-canary.sqlite');
    try {
      await fs.unlink(dbPath);
    } catch {}

    const ctx = new Context();
    ctx.plugin(TaskStorage, dbPath);
    ctx.plugin(WorktreeSandbox);
    ctx.plugin(TelemetryService);
    ctx.plugin(CanaryService);
    await ctx.start();

    const canary = ctx.a3hCanary;
    const sandbox = ctx.a3hSandbox;

    // Seed base commit and commit 1 on branchName using an allocation
    const branchName = `canary-chaos-${Date.now()}`;
    await exec('git', ['branch', '-f', branchName, 'HEAD'], { cwd: gitRoot });

    const seedTaskId = `seed-${Date.now()}`;
    const seedWt = await sandbox.allocate(seedTaskId, branchName);
    const targetFile = path.join(seedWt, 'chaos-target.txt');
    await fs.writeFile(targetFile, 'line1: original\nline2: original\n', 'utf8');
    await exec('git', ['add', '.'], { cwd: seedWt });
    await exec('git', ['commit', '-m', 'chore: initial commit'], { cwd: seedWt });

    // Commit 1 (the one deployed)
    await fs.writeFile(targetFile, 'line1: commit1_change\nline2: original\n', 'utf8');
    await exec('git', ['add', '.'], { cwd: seedWt });
    await exec('git', ['commit', '-m', 'feat: canary commit 1'], { cwd: seedWt });
    const { stdout: sha1Out } = await exec('git', ['rev-parse', 'HEAD'], { cwd: seedWt });
    const commit1Sha = sha1Out.trim();

    // Commit 2 on branchName (downstream conflicting change)
    await fs.writeFile(targetFile, 'line1: commit2_conflicting_change\nline2: original\n', 'utf8');
    await exec('git', ['add', '.'], { cwd: seedWt });
    await exec('git', ['commit', '-m', 'feat: downstream commit 2'], { cwd: seedWt });

    const { stdout: headShaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: seedWt });
    await exec('git', ['branch', '-f', branchName, headShaOut.trim()], { cwd: gitRoot });
    await sandbox.cleanup(seedTaskId);

    // Deploy canary with commit1Sha targeting branchName
    const testTaskId = `canary-task-${Date.now()}`;
    const deployment = await canary.deployCanary(testTaskId, commit1Sha, branchName);

    let failedEventEmitted = false;
    ctx.on('a3h/canary-rollback-failed', (evt) => {
      failedEventEmitted = true;
      assert.strictEqual(evt.commitSha, commit1Sha);
      assert.strictEqual(evt.requiresHITL, true);
    });

    // Rollback commit1Sha - will fail because downstream commit 2 conflicts
    const rollbackResult = await canary.rollback(deployment, 'Canary synthetic error spike');
    assert.strictEqual(rollbackResult.success, false, 'Rollback must fail cleanly on conflict');
    assert.ok(failedEventEmitted, 'a3h/canary-rollback-failed event must be emitted');

    // Crucial check: verify git revert --abort ran cleanly, error was captured, and worktree was pruned without lingering lock files
    assert.ok(rollbackResult.error?.includes('conflict encountered during \'git revert\''), 'Error must specify git revert conflict');
    const worktreeCleaned = await fs.stat(deployment.worktreePath).then(() => false).catch(() => true);
    assert.strictEqual(worktreeCleaned, true, 'Deployment worktree must be cleanly pruned on rollback without lingering files');

    await exec('git', ['branch', '-D', branchName], { cwd: gitRoot }).catch(() => {});
    await ctx.stop();
  });
});
