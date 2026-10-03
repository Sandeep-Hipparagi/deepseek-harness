import { Context } from 'cordis';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import { VerificationService } from './dist/services/verification.js';
import { HITLController } from './dist/services/hitl.js';
import { BackgroundAgentWorker } from './dist/services/worker.js';
import { HeadlessLspService } from './dist/services/lsp.js';
import { GovernanceService } from './dist/services/governance.js';
import { TelemetryService } from './dist/services/telemetry.js';
import { TaskStorage } from './dist/storage/db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase2Checks() {
  console.log('=== Starting Phase 2 Verification Checklist ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase2.sqlite');
  try {
    await fs.unlink(testDbPath);
  } catch {}

  const ctx = new Context();
  ctx.plugin(TaskStorage, testDbPath);
  ctx.plugin(WorktreeSandbox);
  ctx.plugin(VerificationService);
  ctx.plugin(HITLController);
  ctx.plugin(HeadlessLspService);
  ctx.plugin(GovernanceService);
  ctx.plugin(TelemetryService);
  ctx.plugin(BackgroundAgentWorker);
  await ctx.start();

  const sandbox = ctx.a3hSandbox;
  const worker = ctx.a3hWorker;
  const storage = ctx.a3hStorage;
  const hitl = ctx.a3hHITL;

  // Track events
  let suspendedEventFired = false;
  let resumedEventFired = false;

  ctx.on('a3h/task-suspended', (evt) => {
    console.log(`[EVENT] a3h/task-suspended received for task ${evt.taskId}`);
    suspendedEventFired = true;
  });

  ctx.on('a3h/task-resumed', (evt) => {
    console.log(`[EVENT] a3h/task-resumed received for task ${evt.taskId}`);
    resumedEventFired = true;
  });

  // ----------------------------------------------------
  // Checklist Item 1: Ghost-Diff Check
  // ----------------------------------------------------
  console.log('--- TEST 1: Ghost-Diff Check ---');
  const taskId1 = 'p2-ghost-01';
  const worktreePath1 = await sandbox.allocate(taskId1);
  storage.createTask({
    id: taskId1,
    instruction: 'Fix a bug',
    worktree_path: worktreePath1,
    git_branch: `feature/task-${taskId1}`,
    base_commit_hash: 'HEAD',
    status: 'running'
  });

  // Call complete_task immediately without writing any files
  const ghostResult = await worker.handleToolInvocation(
    taskId1,
    { id: 'call-1', name: 'complete_task', arguments: { testCommand: 'node -v' } },
    worktreePath1
  );

  console.log('Ghost result status:', ghostResult.status);
  console.log('Ghost rejection reason:', ghostResult.verification?.reason);

  if (ghostResult.verification?.passed !== false || ghostResult.verification?.tierFailed !== 0) {
    throw new Error('FAIL: Ghost diff check did not fail at Tier 0!');
  }
  if (!ghostResult.verification?.reason?.includes('No files were modified')) {
    throw new Error(`FAIL: Unexpected reason: ${ghostResult.verification?.reason}`);
  }
  console.log('✔ PASS: Ghost-Diff Check rejected empty-diff completion at Tier 0.\n');

  await sandbox.cleanup(taskId1);

  // ----------------------------------------------------
  // Checklist Item 2: Test Assertion Tampering Guard
  // ----------------------------------------------------
  console.log('--- TEST 2: Test-Tampering Check ---');
  const taskId2 = 'p2-tamper-02';
  const worktreePath2 = await sandbox.allocate(taskId2);
  storage.createTask({
    id: taskId2,
    instruction: 'Fix test suite without cheating',
    worktree_path: worktreePath2,
    git_branch: `feature/task-${taskId2}`,
    base_commit_hash: 'HEAD',
    status: 'running'
  });

  // Create an initial test file and commit it so git diff can detect modifications
  const testFilePath = path.join(worktreePath2, 'dummy.spec.js');
  await fs.writeFile(
    testFilePath,
    '// Initial test\nif (1 !== 1) throw new Error("assertion 1 failed");\nif (2 !== 2) throw new Error("assertion 2 failed");\n'
  );
  await exec('git', ['add', 'dummy.spec.js'], { cwd: worktreePath2 });
  await exec('git', ['commit', '-m', 'chore: add test fixture', '--no-verify'], { cwd: worktreePath2 });

  // Now simulate tampering: delete an assertion line
  await fs.writeFile(
    testFilePath,
    '// Initial test\n// Assertion deleted by naughty model!\nif (2 !== 2) throw new Error("assertion 2 failed");\n'
  );

  const tamperResult = await worker.handleToolInvocation(
    taskId2,
    { id: 'call-2', name: 'complete_task', arguments: { testCommand: 'node -v' } },
    worktreePath2
  );

  console.log('Tamper result status:', tamperResult.status);
  console.log('Tamper rejection reason:', tamperResult.verification?.reason);

  if (tamperResult.verification?.passed !== false || tamperResult.verification?.tierFailed !== 0) {
    throw new Error('FAIL: Test tampering check did not fail at Tier 0!');
  }
  if (!tamperResult.verification?.reason?.includes('Assertion tampering detected')) {
    throw new Error(`FAIL: Unexpected reason: ${tamperResult.verification?.reason}`);
  }
  console.log('✔ PASS: Test-tampering check detected assertion tampering and rejected completion.\n');

  await sandbox.cleanup(taskId2);

  // ----------------------------------------------------
  // Checklist Item 3: HITL Suspension Check
  // ----------------------------------------------------
  console.log('--- TEST 3: HITL Suspension Check ---');
  const taskId3 = 'p2-hitl-03';
  const worktreePath3 = await sandbox.allocate(taskId3);
  storage.createTask({
    id: taskId3,
    instruction: 'Deploy changes to remote',
    worktree_path: worktreePath3,
    git_branch: `feature/task-${taskId3}`,
    base_commit_hash: 'HEAD',
    status: 'running'
  });

  // Issue dangerous command: git push origin main
  console.log('Issuing restricted command: git push origin main');
  const hitlResult = await worker.handleToolInvocation(
    taskId3,
    {
      id: 'call-push-01',
      name: 'execute_bash',
      arguments: { command: 'git push origin main --force' }
    },
    worktreePath3
  );

  console.log('Worker return status:', hitlResult.status);
  console.log('Worker message:', hitlResult.message);

  if (hitlResult.status !== 'suspended_waiting_user') {
    throw new Error(`FAIL: Expected suspended_waiting_user, got ${hitlResult.status}`);
  }

  // Verify task status in SQLite
  const taskInDb = storage.getTask(taskId3);
  console.log('Task status in SQLite:', taskInDb?.status);
  if (taskInDb?.status !== 'suspended_waiting_user') {
    throw new Error(`FAIL: SQLite status is ${taskInDb?.status}, expected suspended_waiting_user`);
  }

  if (!suspendedEventFired) {
    throw new Error('FAIL: a3h/task-suspended event did not fire!');
  }

  if (!hitl.hasPending(taskId3)) {
    throw new Error('FAIL: hitl.hasPending is false!');
  }

  // Now resolve the approval (human approves with guidance)
  console.log('Resolving approval via hitl.resolveApproval...');
  hitl.resolveApproval(taskId3, true, 'Approved by human reviewer');

  const resumedTaskInDb = storage.getTask(taskId3);
  console.log('Resumed task status in SQLite:', resumedTaskInDb?.status);
  if (resumedTaskInDb?.status !== 'running') {
    throw new Error(`FAIL: SQLite status after resume is ${resumedTaskInDb?.status}, expected running`);
  }

  if (!resumedEventFired) {
    throw new Error('FAIL: a3h/task-resumed event did not fire!');
  }

  console.log('✔ PASS: HITL Suspension cleanly suspended, persisted state to SQLite, and resumed on approval.\n');

  await sandbox.cleanup(taskId3);

  // ----------------------------------------------------
  // Successful Task Completion & Diff Artifact Persistence
  // ----------------------------------------------------
  console.log('--- TEST 4: Successful Task Completion & Artifacts ---');
  const taskId4 = 'p2-success-04';
  const worktreePath4 = await sandbox.allocate(taskId4);
  storage.createTask({
    id: taskId4,
    instruction: 'Create hello world file',
    worktree_path: worktreePath4,
    git_branch: `feature/task-${taskId4}`,
    base_commit_hash: 'HEAD',
    status: 'running'
  });

  // Write a valid code change
  await fs.writeFile(path.join(worktreePath4, 'hello.txt'), 'Hello Phase 2!\n');

  const successResult = await worker.handleToolInvocation(
    taskId4,
    { id: 'call-finish', name: 'complete_task', arguments: { conformanceCommand: 'node -v', testCommand: 'node -v' } },
    worktreePath4
  );

  console.log('Success result status:', successResult.status);
  console.log('Success verification passed?', successResult.verification?.passed);
  console.log('Success verification reason:', successResult.verification?.reason);

  if (successResult.status !== 'completed' || !successResult.verification?.passed) {
    throw new Error(`FAIL: Expected completed, got ${successResult.status}`);
  }

  const completedTaskInDb = storage.getTask(taskId4);
  if (completedTaskInDb?.status !== 'completed') {
    throw new Error(`FAIL: Task status in DB is ${completedTaskInDb?.status}, expected completed`);
  }

  const artifacts = storage.getArtifacts(taskId4);
  console.log('Saved artifacts count:', artifacts.length);
  if (artifacts.length === 0 || !artifacts[0].content.includes('hello.txt')) {
    throw new Error('FAIL: Unified diff artifact was not saved!');
  }

  console.log('✔ PASS: Successful task verified, completed in DB, and unified diff artifact recorded.\n');

  await sandbox.cleanup(taskId4);
  storage.close();

  // Cleanup test sqlite
  try {
    await fs.unlink(testDbPath);
  } catch {}

  console.log('====================================================');
  console.log('ALL PHASE 2 VERIFICATION CHECKLIST TESTS PASSED! ✔✔✔');
  console.log('====================================================');
}

runPhase2Checks().catch((err) => {
  console.error('Phase 2 verification failed:', err);
  process.exit(1);
});
