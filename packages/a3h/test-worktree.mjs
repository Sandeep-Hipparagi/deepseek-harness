import { Context } from 'cordis';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import fs from 'node:fs';

async function test() {
  console.log('--- Initializing Context and WorktreeSandbox ---');
  const ctx = new Context();
  ctx.plugin(WorktreeSandbox);
  await ctx.start();

  const sandbox = ctx.a3hSandbox;
  const taskId = 'test-001';

  console.log(`--- Allocating worktree for task ${taskId} ---`);
  const worktreePath = await sandbox.allocate(taskId);
  console.log(`Worktree allocated at: ${worktreePath}`);

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`);
  }

  console.log('--- Running command inside worktree (git status) ---');
  const statusResult = await sandbox.execConfined(worktreePath, 'git', ['status']);
  console.log(`Exit code: ${statusResult.exitCode}`);
  console.log(`Output: \n${statusResult.output}`);

  console.log('--- Testing 8KB truncation with large output ---');
  // Run node command that outputs > 8KB
  const largeOutputResult = await sandbox.execConfined(
    worktreePath,
    'node',
    ['-e', 'console.log(String.fromCharCode(65).repeat(10000)); console.error(String.fromCharCode(66).repeat(5000));']
  );
  console.log(`Large output truncated? ${largeOutputResult.output.includes('[TOOL OUTPUT TRUNCATED: Exceeded 8KB]')}`);
  console.log(`Output snippet: \n${largeOutputResult.output.slice(0, 200)}...`);

  console.log(`--- Cleaning up worktree for task ${taskId} ---`);
  await sandbox.cleanup(taskId);

  const existsAfterCleanup = fs.existsSync(worktreePath);
  console.log(`Worktree exists after cleanup? ${existsAfterCleanup}`);

  if (existsAfterCleanup) {
    throw new Error(`Cleanup failed: ${worktreePath} still exists`);
  }

  console.log('--- All tests completed successfully! ---');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
