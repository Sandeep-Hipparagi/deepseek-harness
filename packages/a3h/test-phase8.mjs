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
  SentinelDaemon
} from './dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runPhase8TestSuite() {
  console.log('=== Starting Phase 8 Autonomous Swarms, Spec-Driven Engineering & Sentinel Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase8.sqlite');
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

  await ctx.start();

  const specGate = ctx.a3hSpecGate;
  const decomposer = ctx.a3hDecomposer;
  const sentinel = ctx.a3hSentinel;

  const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = rootGitTop.trim();

  const branchDag = 'test-phase8-dag-target';
  const branchCascade = 'test-phase8-cascade-target';
  const branchSentinel = 'test-phase8-sentinel-target';

  // Track DAG events
  const cancelledEvents = [];
  ctx.on('a3h/dag-node-cancelled', (evt) => {
    console.log(`[EVENT a3h/dag-node-cancelled] Task: ${evt.taskId} | Reason: ${evt.reason}`);
    cancelledEvents.push(evt);
  });

  try {
    // ----------------------------------------------------
    // TEST 1: Spec Gate & Pre-Execution Critic Gate
    // ----------------------------------------------------
    console.log('--- TEST 1: Spec-Driven Pre-Execution Critic Gate ---');

    // 1a. Invariant checks on invalid specs
    const invalidSpec1 = {
      title: 'Fix',
      objective: 'Short',
      affectedFiles: [],
      validationPlan: ''
    };
    const res1 = specGate.validateSpec(invalidSpec1);
    console.log(`Rejected invalid spec: approved=${res1.approved}, critiques=${res1.critiqueNotes.length}`);
    if (res1.approved) {
      throw new Error('FAIL: SpecGate should have rejected invalid specification!');
    }
    if (res1.critiqueNotes.length < 3) {
      throw new Error(`FAIL: Expected at least 3 critiques, got: ${JSON.stringify(res1.critiqueNotes)}`);
    }

    // 1b. High risk breaking change without mitigation
    const invalidSpec2 = {
      title: 'Database Schema Drop',
      objective: 'Drop legacy user accounts table permanently',
      affectedFiles: ['schema.sql'],
      validationPlan: 'Verify table does not exist in schema',
      breakingChangesRisk: 'high'
    };
    const res2 = specGate.validateSpec(invalidSpec2);
    if (res2.approved || !res2.critiqueNotes.some((n) => n.includes('mitigationStrategy'))) {
      throw new Error('FAIL: SpecGate did not flag missing mitigationStrategy on high-risk change!');
    }

    // 1c. Valid specification
    const validSpec = {
      title: 'Modular Authentication & Lucia Migration',
      objective: 'Refactor monolithic session handling to modular Lucia authentication adapter.',
      schemaChanges: 'ALTER TABLE users ADD COLUMN auth_provider TEXT;',
      affectedFiles: ['src/models/core.ts', 'src/utils/adapters.ts', 'src/routes/api.ts'],
      validationPlan: 'Run test suite verifying session token issuance, validation and revocation.',
      breakingChangesRisk: 'medium',
      mitigationStrategy: 'Preserve dual-write compatibility for 30-day migration window.'
    };
    const res3 = specGate.validateSpec(validSpec);
    console.log(`Approved valid spec: approved=${res3.approved}, critiques=${res3.critiqueNotes.length}`);
    if (!res3.approved || res3.critiqueNotes.length !== 0) {
      throw new Error(`FAIL: Valid spec was unexpectedly rejected: ${JSON.stringify(res3.critiqueNotes)}`);
    }

    // 1d. Save SPEC.md artifact to .agent/
    const savedSpecPath = await specGate.saveSpecArtifact(gitRoot, validSpec);
    console.log(`Saved SPEC.md artifact at: ${savedSpecPath}`);
    const specOnDisk = await fs.readFile(savedSpecPath, 'utf8');
    if (!specOnDisk.includes('Modular Authentication & Lucia Migration') || !specOnDisk.includes('Affected File Manifest')) {
      throw new Error('FAIL: SPEC.md artifact was not written correctly to .agent/ directory!');
    }
    console.log('✔ PASS: Spec-Driven Pre-Execution Critic Gate validated and artifact persisted.\n');

    // ----------------------------------------------------
    // TEST 2: DAG Task Decomposition & Parallel Scheduling
    // ----------------------------------------------------
    console.log('--- TEST 2: DAG Task Decomposition & Parallel Scheduling ---');
    await exec('git', ['branch', '-f', branchDag, 'HEAD'], { cwd: gitRoot });

    const macroObjective = 'Refactor and modularize authentication service';
    const dag = await decomposer.decomposeMacro(macroObjective, { repoRoot: gitRoot });

    console.log(`Decomposed macro task into ${dag.tasks.length} subtasks.`);
    if (dag.tasks.length !== 3) {
      throw new Error(`FAIL: Expected 3 decomposed tasks, got ${dag.tasks.length}`);
    }

    const [task1, task2, task3] = dag.tasks;
    console.log(`Task 1: ${task1.title} (dependsOn: ${JSON.stringify(task1.dependsOn)})`);
    console.log(`Task 2: ${task2.title} (dependsOn: ${JSON.stringify(task2.dependsOn)})`);
    console.log(`Task 3: ${task3.title} (dependsOn: ${JSON.stringify(task3.dependsOn)})`);

    if (task1.dependsOn.length !== 0 || task2.dependsOn.length !== 0) {
      throw new Error('FAIL: Task 1 and Task 2 should be independent root tasks!');
    }
    if (!task3.dependsOn.includes(task1.id) || !task3.dependsOn.includes(task2.id)) {
      throw new Error('FAIL: Task 3 should depend on both Task 1 and Task 2!');
    }

    const executedOrder = [];

    const dagResult = await decomposer.executeDAG(dag, branchDag, async (task, wtPath) => {
      executedOrder.push(task.id);
      console.log(`[EXECUTING] ${task.id} (${task.title}) in worktree: ${wtPath}`);

      if (task.id === task1.id) {
        // Implement models/core.ts
        const filePath = path.join(wtPath, 'src/models/core.ts');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'export interface UserSession { id: string; role: string; }\n', 'utf8');
        await exec('git', ['add', '.'], { cwd: wtPath });
        await exec('git', ['commit', '--no-verify', '-m', 'feat(core): implement core models'], { cwd: wtPath });
        return true;
      } else if (task.id === task2.id) {
        // Implement utils/adapters.ts
        const filePath = path.join(wtPath, 'src/utils/adapters.ts');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'export function verifyToken(tk: string) { return tk.startsWith("tk_"); }\n', 'utf8');
        await exec('git', ['add', '.'], { cwd: wtPath });
        await exec('git', ['commit', '--no-verify', '-m', 'feat(adapters): implement token helpers'], { cwd: wtPath });
        return true;
      } else if (task.id === task3.id) {
        // Verify that parent commits from task1 and task2 exist in this worktree!
        const modelPath = path.join(wtPath, 'src/models/core.ts');
        const adapterPath = path.join(wtPath, 'src/utils/adapters.ts');
        const hasModel = await fs.stat(modelPath).then(() => true).catch(() => false);
        const hasAdapter = await fs.stat(adapterPath).then(() => true).catch(() => false);

        if (!hasModel || !hasAdapter) {
          throw new Error('FAIL: Dependent Task 3 allocated without parents landed on target branch!');
        }

        // Implement routes/api.ts
        const filePath = path.join(wtPath, 'src/routes/api.ts');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'export const apiVersion = "v2-lucia";\n', 'utf8');
        await exec('git', ['add', '.'], { cwd: wtPath });
        await exec('git', ['commit', '--no-verify', '-m', 'feat(routes): integrate api routes'], { cwd: wtPath });
        return true;
      }
      return false;
    });

    console.log('DAG Execution Result:', dagResult);
    if (!dagResult.success || dagResult.completedTasks !== 3 || dagResult.failedTasks !== 0) {
      throw new Error(`FAIL: DAG execution did not complete successfully: ${JSON.stringify(dagResult)}`);
    }

    // Verify task 3 was executed after task 1 and task 2
    const idx1 = executedOrder.indexOf(task1.id);
    const idx2 = executedOrder.indexOf(task2.id);
    const idx3 = executedOrder.indexOf(task3.id);
    if (idx3 <= idx1 || idx3 <= idx2) {
      throw new Error(`FAIL: Task 3 executed before parent completion! Order: ${executedOrder}`);
    }
    console.log('✔ PASS: DAG dynamic scheduling executed roots in parallel and sequenced dependent child.\n');

    // ----------------------------------------------------
    // TEST 3: Upstream Failure & Downstream Cancellation Cascade
    // ----------------------------------------------------
    console.log('--- TEST 3: Downstream Cancellation Cascade on Upstream Failure ---');
    await exec('git', ['branch', '-f', branchCascade, 'HEAD'], { cwd: gitRoot });

    const parentAId = 'p8_parent_fail';
    const parentBId = 'p8_parent_ok';
    const childCId = 'p8_child_c';
    const grandchildDId = 'p8_grandchild_d';

    const cascadeDAG = {
      specification: '# Cascade Test Specification',
      tasks: [
        {
          id: parentAId,
          title: 'Failing Parent Task',
          instruction: 'This task will fail verification',
          targetFiles: ['fail.txt'],
          dependsOn: []
        },
        {
          id: parentBId,
          title: 'Independent Passing Task',
          instruction: 'This task will succeed',
          targetFiles: ['success.txt'],
          dependsOn: []
        },
        {
          id: childCId,
          title: 'Direct Child of Failing Parent',
          instruction: 'Should be cancelled before execution',
          targetFiles: ['child.txt'],
          dependsOn: [parentAId]
        },
        {
          id: grandchildDId,
          title: 'Grandchild Dependent on Child',
          instruction: 'Should also be cancelled via cascade',
          targetFiles: ['grandchild.txt'],
          dependsOn: [childCId]
        }
      ]
    };

    const cascadeExecuted = [];
    const cascadeResult = await decomposer.executeDAG(cascadeDAG, branchCascade, async (task, wtPath) => {
      cascadeExecuted.push(task.id);
      if (task.id === parentAId) {
        console.log(`[EXECUTING] Intentionally failing parent task: ${task.id}`);
        return false; // Simulating failure
      }
      if (task.id === parentBId) {
        console.log(`[EXECUTING] Passing independent task: ${task.id}`);
        const f = path.join(wtPath, 'success.txt');
        await fs.writeFile(f, 'ok\n', 'utf8');
        await exec('git', ['add', '.'], { cwd: wtPath });
        await exec('git', ['commit', '--no-verify', '-m', 'feat: pass'], { cwd: wtPath });
        return true;
      }
      throw new Error(`CRITICAL FAIL: Downstream task ${task.id} was dispatched despite parent failure!`);
    });

    console.log('Cascade Result:', cascadeResult);
    if (cascadeResult.success) {
      throw new Error('FAIL: DAG with failed parent should report success: false!');
    }
    if (cascadeResult.failedTasks !== 1 || cascadeResult.completedTasks !== 1 || cascadeResult.cancelledTasks !== 2) {
      throw new Error(`FAIL: Unexpected cascade counts: ${JSON.stringify(cascadeResult)}`);
    }

    if (cascadeResult.taskResults[childCId].status !== 'cancelled' || cascadeResult.taskResults[grandchildDId].status !== 'cancelled') {
      throw new Error('FAIL: Child and grandchild tasks were not marked cancelled!');
    }

    const childCancelledEvt = cancelledEvents.find((e) => e.taskId === childCId);
    const grandchildCancelledEvt = cancelledEvents.find((e) => e.taskId === grandchildDId);
    if (!childCancelledEvt || !grandchildCancelledEvt) {
      throw new Error('FAIL: a3h/dag-node-cancelled events were not emitted for cascaded tasks!');
    }
    console.log('✔ PASS: Cancellation cascade aborted dependent tasks with zero wasted compute.\n');

    // ----------------------------------------------------
    // TEST 4: Proactive Sentinel Triage & Flaky Test Sweeper
    // ----------------------------------------------------
    console.log('--- TEST 4: Proactive Sentinel Daemon & Flaky Sweeper ---');
    await exec('git', ['branch', '-f', branchSentinel, 'HEAD'], { cwd: gitRoot });

    // 4a. Autonomous Bug Reproduction & Landing
    console.log('4a. Ingesting Issue Payload & Synthesizing Repro Test...');
    // Seed buggy file on branchSentinel
    const tempWt = await ctx.a3hSandbox.allocate('p8_seed_temp', branchSentinel);
    const authModulePath = path.join(tempWt, 'src/services/auth_validator.mjs');
    await fs.mkdir(path.dirname(authModulePath), { recursive: true });
    await fs.writeFile(
      authModulePath,
      'export function isTokenValid(token) {\n  return false; // BUG: always rejects tokens\n}\n',
      'utf8'
    );
    await exec('git', ['add', '.'], { cwd: tempWt });
    await exec('git', ['commit', '--no-verify', '-m', 'feat: initial buggy auth_validator'], { cwd: tempWt });
    // Point branchSentinel to this commit
    await exec('git', ['branch', '-f', branchSentinel, 'HEAD'], { cwd: tempWt });
    await ctx.a3hSandbox.cleanup('p8_seed_temp');

    const issuePayload = {
      id: 'BUG-409',
      title: 'isTokenValid returns false for valid JWT tokens',
      description: 'Incoming tokens with prefix jwt. are rejected erroneously by session guard.',
      source: 'sentry',
      reproductionTest: {
        filePath: 'test/auth_validator.test.mjs',
        content: `import { isTokenValid } from '../src/services/auth_validator.mjs';
if (!isTokenValid('jwt.valid.token')) {
  console.error('FAIL: Token must be valid');
  process.exit(1);
}
console.log('PASS');
`,
        testCommand: 'node test/auth_validator.test.mjs'
      }
    };

    const triageResult = await sentinel.triageAndFix(issuePayload, branchSentinel, async (wt) => {
      console.log(`[SENTINEL FIX HANDLER] Applying fix in worktree: ${wt}`);
      const fileToFix = path.join(wt, 'src/services/auth_validator.mjs');
      await fs.writeFile(
        fileToFix,
        'export function isTokenValid(token) {\n  return typeof token === "string" && token.startsWith("jwt.");\n}\n',
        'utf8'
      );
      return true;
    });

    console.log('Sentinel Triage Result:', triageResult);
    if (!triageResult.reproduced) {
      throw new Error('FAIL: Sentinel failed to reproduce the issue on unmodified base code!');
    }
    if (triageResult.status !== 'fixed_and_merged') {
      throw new Error(`FAIL: Sentinel fix was not merged. Status: ${triageResult.status}`);
    }

    // 4b. Flaky Test Sweeper
    console.log('\n4b. Executing Flaky Test Sweeper across multiple seed passes...');
    const flakyScriptPath = path.join(gitRoot, 'test_flaky_sample.mjs');
    await fs.writeFile(
      flakyScriptPath,
      `const run = process.env.TEST_RUN_INDEX;
if (run === '2') {
  console.error('Flaky failure simulated on run 2');
  process.exit(1);
}
process.exit(0);
`,
      'utf8'
    );

    const flakyReport = await sentinel.sweepFlakyTests(`node test_flaky_sample.mjs`, 3, gitRoot);
    console.log('Flaky Test Report:', flakyReport);
    if (!flakyReport.isFlaky || flakyReport.passedRuns !== 2 || flakyReport.failedRuns !== 1) {
      throw new Error(`FAIL: Sweeper did not detect flaky test! Report: ${JSON.stringify(flakyReport)}`);
    }

    // Deterministic Passing Test
    const stableReport = await sentinel.sweepFlakyTests(`node -e "process.exit(0)"`, 3, gitRoot);
    console.log('Stable Test Report:', stableReport);
    if (stableReport.isFlaky || stableReport.passedRuns !== 3 || stableReport.failedRuns !== 0) {
      throw new Error(`FAIL: Sweeper incorrectly flagged stable test! Report: ${JSON.stringify(stableReport)}`);
    }

    try {
      await fs.unlink(flakyScriptPath);
    } catch {}

    console.log('✔ PASS: Sentinel proactively reproduced bug, applied fix, merged, and swept flaky tests.\n');

    console.log('========================================================================');
    console.log('ALL PHASE 8 AUTONOMOUS SWARM & SENTINEL TESTS COMPLETED WITH 100% SUCCESS! ✔✔✔');
    console.log('========================================================================\n');
  } finally {
    // Clean up test branches and staging
    try {
      await ctx.a3hReconciliation?.cleanupStaging();
    } catch {}
    for (const b of [branchDag, branchCascade, branchSentinel]) {
      try {
        await exec('git', ['branch', '-D', b], { cwd: gitRoot });
      } catch {}
    }
    try {
      await ctx.stop();
    } catch {}
  }
}

runPhase8TestSuite().catch((err) => {
  console.error('Phase 8 verification failed:', err);
  process.exit(1);
});
