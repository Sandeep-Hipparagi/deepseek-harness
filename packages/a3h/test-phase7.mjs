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
  DockerSandboxBackend,
  EvalPipeline
} from './dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase7TestSuite() {
  console.log('=== Starting Phase 7 Production Hardening & Multi-Repo Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase7.sqlite');
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

  await ctx.start();

  const memory = ctx.a3hMemory;
  const sandbox = ctx.a3hSandbox;
  const worker = ctx.a3hWorker;
  const storage = ctx.a3hStorage;

  try {
    // ----------------------------------------------------
    // TEST 1: Repository-Level Episodic Memory & Warm-Start
    // ----------------------------------------------------
    console.log('--- TEST 1: Episodic Memory & Zero-Turn Warm-Start ---');
    const agentDir = await memory.ensureAgentDirectory();
    console.log(`Initialized .agent directory at: ${agentDir}`);

    // Verify default seeded files exist
    const envStat = await fs.stat(path.join(agentDir, 'environment.json'));
    const learnStat = await fs.stat(path.join(agentDir, 'learnings.md'));
    if (!envStat.isFile() || !learnStat.isFile()) {
      throw new Error('FAIL: .agent/ files were not created!');
    }

    // Record custom learning from Task A
    await memory.recordLearning(undefined, {
      taskId: 'task-p7-prev',
      category: 'quirks',
      content: 'Run vitest with --runInBand to avoid SQLite lock contention during parallel suite.'
    });

    // Update discovered environment profile
    await memory.recordEnvironment(undefined, {
      testCommands: ['pnpm test', 'npm run test:unit'],
      detectedFrameworks: ['Cordis', 'TypeScript']
    });

    const repoMem = await memory.getRepoMemory();
    console.log(`Discovered Package Manager: ${repoMem.environment?.packageManager}`);
    console.log(`Total Learnings Notes:      ${repoMem.learnings.length}`);

    if (!repoMem.rawLearningsMarkdown.includes('runInBand')) {
      throw new Error('FAIL: Recorded learning not found in learnings.md!');
    }

    // Verify system prompt prefix generation for zero-turn warm-start
    const promptPrefix = await worker.getTaskInitialPrompt(
      'task-p7-worker-b',
      'Execute unit test suite'
    );
    console.log('\nGenerated Agent Prompt Prefix Preview:');
    console.log(promptPrefix.split('\n').slice(0, 8).join('\n') + '\n...');

    if (!promptPrefix.includes('A3H Shared Episodic Memory') || !promptPrefix.includes('runInBand')) {
      throw new Error('FAIL: System prompt does not include episodic memory!');
    }

    // Test agent recording learning via tool call
    const wtPathForTool = await sandbox.allocate('task-p7-tool-test', 'HEAD');
    const toolResult = await worker.handleToolInvocation(
      'task-p7-tool-test',
      {
        id: 'call_record_1',
        name: 'record_learning',
        arguments: {
          category: 'build',
          content: 'ESBuild requires target es2022 when using Top-Level Await.'
        }
      },
      wtPathForTool
    );

    console.log(`Tool Result for record_learning: ${toolResult.toolResult}`);
    const updatedMem = await memory.getRepoMemory();
    if (!updatedMem.rawLearningsMarkdown.includes('Top-Level Await')) {
      throw new Error('FAIL: record_learning tool did not persist learning note!');
    }
    await sandbox.cleanup('task-p7-tool-test');

    console.log('✔ PASS: Episodic Memory: persistent knowledge store, warm-start injection & tool recording verified.\n');

    // ----------------------------------------------------
    // TEST 2: Multi-Repository Mounting & External Project Isolation
    // ----------------------------------------------------
    console.log('--- TEST 2: Multi-Repository Mounting & External Sandboxing ---');
    const externalRepoDir = path.resolve('.a3h-data', 'external-test-repo');
    await fs.rm(externalRepoDir, { recursive: true, force: true });
    await fs.mkdir(externalRepoDir, { recursive: true });

    // Initialize an independent external git repo
    await exec('git', ['init'], { cwd: externalRepoDir });
    await exec('git', ['config', 'user.email', 'a3h-test@antigravity.internal'], { cwd: externalRepoDir });
    await exec('git', ['config', 'user.name', 'A3H Test Runner'], { cwd: externalRepoDir });
    await fs.writeFile(path.join(externalRepoDir, 'main.js'), 'console.log("External project");\n');
    await exec('git', ['add', '.'], { cwd: externalRepoDir });
    await exec('git', ['commit', '--no-verify', '-m', 'Initial external commit'], { cwd: externalRepoDir });

    console.log(`External repository initialized at: ${externalRepoDir}`);

    // Allocate worktree specifically inside the external repository
    const extTaskId = 'p7-ext-task-01';
    const extWorktreePath = await sandbox.allocate(extTaskId, 'HEAD', externalRepoDir);
    console.log(`Allocated external worktree at: ${extWorktreePath}`);

    if (!extWorktreePath.startsWith(path.resolve(externalRepoDir))) {
      throw new Error(`FAIL: External worktree was allocated in wrong root! ${extWorktreePath}`);
    }

    // Verify git operations inside external worktree point to external branch
    const { stdout: extBranch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: extWorktreePath
    });
    console.log(`External worktree branch: ${extBranch.trim()}`);
    if (extBranch.trim() !== `feature/task-${extTaskId}`) {
      throw new Error(`FAIL: External branch mismatch: ${extBranch.trim()}`);
    }

    // Confined command execution inside external worktree
    const execResult = await sandbox.execConfined(extWorktreePath, 'node', ['-e', 'console.log("HELLO_EXTERNAL")']);
    if (!execResult.output.includes('HELLO_EXTERNAL')) {
      throw new Error(`FAIL: Confined execution failed in external repo! ${execResult.output}`);
    }

    // Clean up external worktree
    await sandbox.cleanup(extTaskId, externalRepoDir);
    let extWorktreeExists = true;
    try {
      await fs.access(extWorktreePath);
    } catch {
      extWorktreeExists = false;
    }
    console.log(`External worktree pruned? ${!extWorktreeExists}`);
    if (extWorktreeExists) {
      throw new Error('FAIL: External worktree was not pruned!');
    }

    // Clean up external repo dir
    await fs.rm(externalRepoDir, { recursive: true, force: true });

    console.log('✔ PASS: Multi-Repository: external project mounting, isolated worktree allocation & cleanup verified.\n');

    // ----------------------------------------------------
    // TEST 3: Ephemeral Container Sandbox & Resource Boundaries
    // ----------------------------------------------------
    console.log('--- TEST 3: Ephemeral Container Sandbox & Security Boundary ---');
    const dockerBackend = new DockerSandboxBackend({
      cpus: 2,
      memory: '4g',
      network: 'none'
    });

    const dummyWorktree = path.resolve('.worktrees', 'task-dummy');
    const dockerArgs = dockerBackend.getDockerRunArgs(dummyWorktree, 'node', ['test.js'], {
      environment: { CI: 'true', TASK_ID: 'dummy' }
    });

    console.log('Generated Container Arguments Preview:');
    console.log(dockerArgs.join(' '));

    // Verify security constraints in Docker argument list
    if (!dockerArgs.includes('--cpus') || dockerArgs[dockerArgs.indexOf('--cpus') + 1] !== '2') {
      throw new Error('FAIL: Missing or incorrect --cpus limit in docker arguments!');
    }
    if (!dockerArgs.includes('--memory') || dockerArgs[dockerArgs.indexOf('--memory') + 1] !== '4g') {
      throw new Error('FAIL: Missing or incorrect --memory limit in docker arguments!');
    }
    if (!dockerArgs.includes('--network') || dockerArgs[dockerArgs.indexOf('--network') + 1] !== 'none') {
      throw new Error('FAIL: Missing or incorrect --network isolation in docker arguments!');
    }

    // Verify volume mounting to /workspace
    const volIdx = dockerArgs.indexOf('-v');
    if (volIdx === -1 || !dockerArgs[volIdx + 1].endsWith(':/workspace')) {
      throw new Error('FAIL: Worktree is not correctly mounted to /workspace!');
    }

    // Verify host credentials exclusion
    const hasSsh = dockerArgs.some((arg) => arg.includes('id_rsa') || arg.includes('.ssh') || arg.includes('SSH_AUTH_SOCK'));
    if (hasSsh) {
      throw new Error('FAIL: Sensitive host credentials leaked into container arguments!');
    }

    // Test execution with fallback
    const confExec = await dockerBackend.execConfined(process.cwd(), 'node', ['-e', 'console.log("CONTAINER_OR_FALLBACK_OK")']);
    console.log(`Backend used: ${confExec.backendUsed} (exitCode: ${confExec.exitCode})`);
    if (!confExec.output.includes('CONTAINER_OR_FALLBACK_OK')) {
      throw new Error(`FAIL: Confined execution failed: ${confExec.output}`);
    }

    console.log('✔ PASS: Container Sandbox: resource constraints (2 CPUs, 4GB RAM, net:none), volume isolation & fallback verified.\n');

    // ----------------------------------------------------
    // TEST 4: Continuous SWE-Eval Regression Pipeline
    // ----------------------------------------------------
    console.log('--- TEST 4: Continuous SWE-Eval Regression Pipeline ---');
    const pipelineBranch = 'test-phase7-eval-target';
    const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
    const gitRoot = rootGitTop.trim();

    const historyFile = path.resolve('.a3h-data/test-phase7-eval-history.json');
    try {
      await fs.unlink(historyFile);
    } catch {}

    await exec('git', ['branch', '-f', pipelineBranch, 'HEAD'], { cwd: gitRoot });

    const evalPipeline = new EvalPipeline(ctx, historyFile);
    console.log('Executing SWE-Eval Golden Pipeline (Run 1)...');
    const report1 = await evalPipeline.runPipeline({ targetBranch: pipelineBranch });

    console.log('\n=== Evaluation Run 1 Report ===');
    console.log(`Pass@1 Rate:       ${(report1.currentRun.passAt1Rate * 100).toFixed(1)}%`);
    console.log(`Total Issues:      ${report1.currentRun.totalIssues}`);
    console.log(`Average Turns:     ${report1.currentRun.averageTurns.toFixed(1)}`);
    console.log(`Mean Cost Per Bug: $${report1.currentRun.meanCostPerBugUsd.toFixed(4)} USD`);
    console.log(`Context Bounded:   ${report1.currentRun.contextBounded ? 'YES' : 'NO'}`);
    console.log(`History Count:     ${report1.historyCount}`);

    if (report1.currentRun.passAt1Rate !== 1.0) {
      throw new Error(`FAIL: Expected 100% Pass@1 rate, got: ${report1.currentRun.passAt1Rate}`);
    }
    if (!report1.currentRun.contextBounded) {
      throw new Error('FAIL: Context was not bounded!');
    }

    // Reset target branch so Run 2 evaluates against the fresh base
    await exec('git', ['branch', '-f', pipelineBranch, 'HEAD'], { cwd: gitRoot });

    console.log('\nExecuting SWE-Eval Golden Pipeline (Run 2: Regression Check)...');
    const report2 = await evalPipeline.runPipeline({ targetBranch: pipelineBranch });
    console.log(`Run 2 Pass@1 Rate:    ${(report2.currentRun.passAt1Rate * 100).toFixed(1)}%`);
    console.log(`Regression Detected? ${report2.regressionDetected ? 'YES' : 'NO'}`);
    console.log(`Total History Runs:  ${report2.historyCount}`);

    if (report2.regressionDetected) {
      throw new Error('FAIL: Regression falsely flagged on identical golden dataset!');
    }
    if (report2.historyCount !== 2) {
      throw new Error(`FAIL: Expected history count of 2, got: ${report2.historyCount}`);
    }

    // Clean up staging and target branch
    try {
      await ctx.a3hReconciliation.cleanupStaging();
    } catch {}
    try {
      await exec('git', ['branch', '-D', pipelineBranch], { cwd: gitRoot });
    } catch {}

    console.log('\n✔ PASS: Continuous SWE-Eval: regression tracking, historical trend logging & Pass@1 consistency verified.');

    console.log('\n======================================================');
    console.log('ALL PHASE 7 PRODUCTION HARDENING TESTS PASSED! ✔✔✔');
    console.log('======================================================\n');
  } finally {
    // Clean up test sqlite
    try {
      storage.close();
      await fs.unlink(testDbPath);
    } catch {}
  }
}

runPhase7TestSuite().catch((err) => {
  console.error('Phase 7 Test Suite Failed:', err);
  process.exit(1);
});
