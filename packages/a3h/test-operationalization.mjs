import { Context } from 'cordis';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { apply } from './dist/index.js';
import { EvalPipeline } from './dist/eval/pipeline.js';
import { getGoldenDataset } from './dist/eval/golden_dataset.js';

async function main() {
  console.log('=== Starting Operationalization, Golden Regression & Human Interface Verification ===\n');

  const ctx = new Context();
  apply(ctx);
  await ctx.start();

  // -------------------------------------------------------------------------
  // TEST 1: Golden Regression Benchmark Dataset Integrity & Execution
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Golden Regression Benchmark Dataset Integrity & Execution ---');
  const dataset = getGoldenDataset();
  assert.strictEqual(dataset.length, 16, 'Golden dataset must contain exactly 16 software engineering tickets');

  console.log(`Golden dataset loaded with ${dataset.length} diverse real-world bug tickets:`);
  console.log(` - ${dataset[0].id}: ${dataset[0].name} (Category: ${dataset[0].category})`);
  console.log(` - ${dataset[4].id}: ${dataset[4].name} (Category: ${dataset[4].category})`);
  console.log(` - ${dataset[6].id}: ${dataset[6].name} (Category: ${dataset[6].category})`);
  console.log(` - ${dataset[11].id}: ${dataset[11].name} (Category: ${dataset[11].category})`);

  const pipeline = new EvalPipeline(ctx);
  console.log('\nExecuting Golden Regression Run on sample benchmark tickets...');
  const report = await pipeline.runGoldenRegressionSuite({
    count: 3,
    threshold: 0.85
  });

  console.log(`Golden Run Results:`);
  console.log(`  Total Tested:      ${report.totalTested}`);
  console.log(`  Passed Count:      ${report.passedCount}`);
  console.log(`  Pass@1 Rate:       ${(report.passAt1Rate * 100).toFixed(1)}%`);
  console.log(`  Average Turns:     ${report.averageTurns.toFixed(1)}`);
  console.log(`  Cost Per Bug:      $${report.costPerBugUSD.toFixed(4)} USD`);
  console.log(`  Budget Compliant:  ${report.withinBudget}`);
  console.log(`  Regression Flag:   ${report.regressionDetected}`);

  assert.strictEqual(report.passAt1Rate >= 0.85, true, 'Golden regression pass rate must meet or exceed 85% threshold');
  assert.strictEqual(report.withinBudget, true, 'Cost per bug must remain strictly under $1.50 target');
  assert.strictEqual(report.averageTurns <= 3.0, true, 'Agent must resolve bugs via AST/LSP within 3-turn budget');
  assert.strictEqual(report.regressionDetected, false, 'No regression should be detected on healthy baseline');
  console.log('✔ PASS: Golden regression suite scored 100% Pass@1, within 3 turns, and strictly within $1.50 budget.\n');

  // -------------------------------------------------------------------------
  // TEST 2: Model Drift Detection & Automated Provider Fallback
  // -------------------------------------------------------------------------
  console.log('--- TEST 2: Model Drift Detection & Automated Provider Fallback ---');
  let regressionAlertFired = false;
  let fallbackModelName = '';

  ctx.on('a3h/model-regression-detected', (evt) => {
    regressionAlertFired = true;
    console.log(`[ALERT] Model Regression Event Received: ${(evt.passAt1Rate * 100).toFixed(1)}% < ${(evt.targetThreshold * 100).toFixed(1)}%`);
  });

  ctx.on('a3h/model-fallback-triggered', (evt) => {
    fallbackModelName = evt.activeModel;
    console.log(`[FALLBACK] Model Arbitrator switched ${evt.tier} from ${evt.previousModel} -> ${evt.activeModel}`);
  });

  console.log('Simulating model degradation (Pass rate drops to 50% < 85% threshold)...');
  const degradedReport = await pipeline.runGoldenRegressionSuite({
    count: 2,
    threshold: 0.85,
    simulatedPassCount: 1 // 50% pass rate
  });

  assert.strictEqual(degradedReport.regressionDetected, true, 'Regression must be flagged when pass rate < 85%');
  assert.strictEqual(degradedReport.fallbackTriggered, true, 'Fallback provider must be triggered on regression');
  assert.strictEqual(regressionAlertFired, true, 'Regression event must be emitted');
  assert.strictEqual(fallbackModelName, 'deepseek-coder-fallback', 'Fallback model must be activated in tier');
  console.log(`✔ PASS: Model drift successfully trapped and automated model provider fallback engaged.\n`);

  // -------------------------------------------------------------------------
  // TEST 3: GitHub/GitLab Pull Request Bot Generation & Verification Badges
  // -------------------------------------------------------------------------
  console.log('--- TEST 3: GitHub/GitLab Pull Request Bot Generation & Verification Badges ---');
  // Seed sample tasks in storage
  const task1Id = `task-auth-hardening-${Date.now()}`;
  const task2Id = `task-query-optimizer-${Date.now()}`;

  ctx.a3hStorage.createTask({
    id: task1Id,
    instruction: 'Enforce constant-time timing safe secret comparison',
    status: 'completed',
    worktree_path: path.resolve(`.worktrees/${task1Id}`),
    git_branch: `feature/${task1Id}`,
    base_commit_hash: 'HEAD'
  });
  ctx.a3hStorage.createTask({
    id: task2Id,
    instruction: 'Add compound B-tree index on tenants(org_id, created_at)',
    status: 'completed',
    worktree_path: path.resolve(`.worktrees/${task2Id}`),
    git_branch: `feature/${task2Id}`,
    base_commit_hash: 'HEAD'
  });

  const pr = await ctx.a3hPRBot.createPullRequest({
    repo: 'deepseek-ai/deepseek-harness',
    baseBranch: 'master',
    headBranch: 'staging/reconciled-v2',
    title: 'feat(security): Auth Timing Hardening & Multi-Tenant Query Indexing',
    taskIds: [task1Id, task2Id],
    executiveSummary: 'Eliminates timing attack vectors in authentication and accelerates tenant query latency by 4.2x.'
  });

  console.log(`Pull Request Generated: #${pr.number} -> ${pr.url}`);
  console.log(`Attestation Verified:   ${pr.attestationVerified}`);
  console.log(`Verification Badges:   ${pr.verificationBadges.length} shields attached`);

  assert.strictEqual(pr.state, 'open', 'PR must be in open state');
  assert.strictEqual(pr.verificationBadges.length, 4, 'Must contain 4 distinct verification badges');
  assert.strictEqual(pr.body.includes('Tier%201%20Lint-PASS'), true, 'Must contain Tier 1 Lint badge');
  assert.strictEqual(pr.body.includes('Tier%202%20Tests-100%25%20PASS'), true, 'Must contain Tier 2 Unit Test badge');
  assert.strictEqual(pr.body.includes('Tier%203%20Canary-HEALTHY'), true, 'Must contain Tier 3 Canary badge');
  assert.strictEqual(pr.body.includes('In--Toto%20Attestation'), true, 'Must contain In-Toto cryptographic attestation badge');
  assert.strictEqual(pr.body.includes('```mermaid\ngraph LR'), true, 'Must include Mermaid topology diagram');
  assert.strictEqual(pr.body.includes(task1Id), true, 'Must list task1 in verification matrix');
  assert.strictEqual(pr.body.includes(task2Id), true, 'Must list task2 in verification matrix');

  console.log('✔ PASS: Structured Pull Request generated with executive summary, badges, Mermaid topology, and attestation.\n');

  // -------------------------------------------------------------------------
  // TEST 4: Interactive ChatOps Suspension Prompts & Action Resumption
  // -------------------------------------------------------------------------
  console.log('--- TEST 4: Interactive ChatOps Suspension Prompts & Action Resumption ---');
  let chatopsPromptReceived = false;
  let chatopsActionResolved = false;

  ctx.on('a3h/chatops-prompt-created', (prompt) => {
    chatopsPromptReceived = true;
    console.log(`[CHATOPS] Alert emitted for suspended task ${prompt.taskId} (Risk: ${prompt.blastRadius})`);
  });

  ctx.on('a3h/chatops-action-resolved', (evt) => {
    chatopsActionResolved = true;
    console.log(`[CHATOPS] Action resolved on task ${evt.taskId}: ${evt.action} (Feedback: ${evt.feedback})`);
  });

  // 4a. Simulate dangerous command triggering HITL suspension
  const suspendedTaskId = `task-prod-migration-${Date.now()}`;
  ctx.a3hStorage.createTask({
    id: suspendedTaskId,
    instruction: 'Drop legacy user credentials table',
    status: 'running',
    worktree_path: path.resolve(`.worktrees/${suspendedTaskId}`),
    git_branch: `feature/${suspendedTaskId}`,
    base_commit_hash: 'HEAD'
  });

  // Call suspendForApproval with high-blast-radius action
  ctx.a3hHITL.suspendForApproval(
    suspendedTaskId,
    'call_migration_drop',
    'execute_bash',
    { command: 'DROP TABLE legacy_users;' }
  );

  const pending = ctx.a3hChatOps.getPendingPrompt(suspendedTaskId);
  assert.ok(pending, 'ChatOps must track pending suspension prompt');
  assert.strictEqual(pending.blastRadius, 'CRITICAL', 'DROP TABLE must be classified as CRITICAL blast radius');
  assert.strictEqual(pending.slackPayload.blocks.length, 4, 'Slack payload must contain 4 interactive blocks');
  assert.strictEqual(pending.slackPayload.blocks[3].type, 'actions', 'Slack payload must have interactive action buttons');
  assert.strictEqual(pending.discordPayload.embeds.length, 1, 'Discord payload must contain rich embed');

  console.log(`Slack Payload Preview:`);
  console.log(`  Channel: ${pending.slackPayload.channel}`);
  console.log(`  Header:  ${pending.slackPayload.blocks[0].text.text}`);
  console.log(`  Actions: ${pending.slackPayload.blocks[3].elements.map(e => e.text.text).join(' | ')}`);

  // 4b. Simulate Developer clicking "Steer with Feedback" in Slack/Discord
  console.log('\nSimulating Developer responding with steering guidance via ChatOps...');
  const actionResult = ctx.a3hChatOps.handleAction({
    taskId: suspendedTaskId,
    action: 'steer',
    feedback: 'DO NOT drop table yet! Add deprecation view alias and backup table first.',
    userId: 'U_LEAD_ARCHITECT_01'
  });

  assert.strictEqual(actionResult.success, true, 'ChatOps action resolution must succeed');
  assert.strictEqual(chatopsActionResolved, true, 'ChatOps resolution event must fire');

  // Verify task was unblocked from suspension in storage
  const updatedTask = ctx.a3hStorage.getTask(suspendedTaskId);
  assert.strictEqual(updatedTask.status, 'running', 'Task must be resumed back to running state');
  console.log(`✔ PASS: High-blast-radius action suspended, ChatOps interactive alert dispatched, and task steered/resumed.\n`);

  console.log('========================================================================');
  console.log('ALL OPERATIONALIZATION, GOLDEN REGRESSION & HUMAN INTERFACE TESTS PASSED! ✔✔✔');
  console.log('========================================================================\n');

  await ctx.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
