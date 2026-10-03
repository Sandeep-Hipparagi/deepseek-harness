import { Context } from 'cordis';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  apply,
  TaskStorage,
  AttestationService,
  VaultService,
  MemoryService,
  EvolverService,
  SpecGateService,
  HITLController,
  ChatOpsService
} from './dist/index.js';

const execFileAsync = promisify(execFile);

async function main() {
  console.log('=== Starting Staging Lifecycle, Key Persistence & Memory Compaction Verification ===\n');

  const { stdout: gitRootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = gitRootRaw.trim();
  const testDbPath = path.resolve('.a3h-data/test-staging-lifecycle.sqlite');

  try {
    await fs.unlink(testDbPath);
  } catch {}

  // -------------------------------------------------------------------------
  // TEST 1: Persistent Ed25519 Attestation Root & Git Tree Digesting (Track 1)
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Persistent Ed25519 Attestation Root & Git Tree Digesting ---');

  const ctx1 = new Context();
  ctx1.plugin(TaskStorage, testDbPath);
  ctx1.plugin(VaultService);
  ctx1.plugin(AttestationService);
  await ctx1.start();

  const attestation1 = ctx1.a3hAttestation;

  // 1a. Ensure persistent keys on disk
  const keyInfo = await attestation1.ensurePersistentKeys(gitRoot);
  console.log(`Persistent Key Algorithm: ${keyInfo.algorithm}`);
  assert.strictEqual(keyInfo.algorithm, 'ed25519', 'Key algorithm must be ed25519');

  const privKeyPath = path.resolve(gitRoot, '.agent/keys/attestation_ed25519_private.pem');
  const pubKeyPath = path.resolve(gitRoot, '.agent/keys/attestation_ed25519_public.pem');

  const hasPriv = await fs.stat(privKeyPath).then(() => true).catch(() => false);
  const hasPub = await fs.stat(pubKeyPath).then(() => true).catch(() => false);
  assert.strictEqual(hasPriv, true, 'Private key must be persisted to .agent/keys');
  assert.strictEqual(hasPub, true, 'Public key must be persisted to .agent/keys');

  const pubKeyContent = await fs.readFile(pubKeyPath, 'utf8');

  // 1b. Get canonical Git Tree SHA
  const { stdout: expectedTreeSha } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: gitRoot
  });
  const canonicalTreeSha = expectedTreeSha.trim();
  console.log(`Canonical Git Tree SHA (HEAD^{tree}): ${canonicalTreeSha}`);

  // 1c. Generate signed attestation
  const taskId = 'task-staging-attest-01';
  const envelope = await attestation1.generateAttestation(taskId, {
    baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    targetBranch: 'master',
    resultingCommitSha: 'HEAD',
    turnLogs: [{ turn: 1, tool: 'verify_spec' }, { turn: 2, tool: 'run_tests' }],
    verificationOutput: 'ALL TESTS PASSED: Tier 1 & Tier 2 verified',
    filesModified: ['src/services/attestation.ts'],
    model: 'deepseek-coder-v2',
    repoRoot: gitRoot
  });

  console.log('Generated Attestation Envelope:');
  console.log(`  Format:       ${envelope.format}`);
  console.log(`  Algorithm:    ${envelope.algorithm}`);
  console.log(`  Git Tree SHA: ${envelope.payload.gitTreeSha}`);
  console.log(`  Signature:    ${envelope.signature.slice(0, 32)}...`);

  assert.strictEqual(envelope.algorithm, 'ed25519', 'Attestation must be signed with ed25519');
  assert.strictEqual(envelope.payload.gitTreeSha, canonicalTreeSha, 'Attestation payload must capture exact Git tree SHA');
  assert.ok(envelope.publicKey, 'Attestation envelope must include public key');

  // 1d. Simulate Daemon Restart: Stop ctx1 and start ctx2 with fresh services
  await ctx1.stop();
  console.log('\nSimulating daemon restart with fresh AttestationService instance...');

  const ctx2 = new Context();
  ctx2.plugin(TaskStorage, testDbPath);
  ctx2.plugin(AttestationService);
  await ctx2.start();

  const attestation2 = ctx2.a3hAttestation;

  // Verify that fresh service reloads persistent key and verifies original envelope
  const reloadedVerify = attestation2.verifyAttestation(envelope);
  console.log(`Verification after daemon restart: verified=${reloadedVerify.verified}`);
  assert.strictEqual(reloadedVerify.verified, true, 'Attestation must be verifiable across daemon restarts');

  // 1e. Verify with external public key (simulating external auditor or CI gate)
  const externalVerify = attestation2.verifyAttestation(envelope, pubKeyContent);
  console.log(`External public key audit verification: verified=${externalVerify.verified}`);
  assert.strictEqual(externalVerify.verified, true, 'External auditor must verify signature using public key alone');

  // 1f. Verify tamper protection on Git Tree SHA
  const tamperedEnvelope = JSON.parse(JSON.stringify(envelope));
  tamperedEnvelope.payload.gitTreeSha = '0000000000000000000000000000000000000000';
  const tamperCheck = attestation2.verifyAttestation(tamperedEnvelope);
  console.log(`Tampered Git tree verification: verified=${tamperCheck.verified} (Reason: ${tamperCheck.reason})`);
  assert.strictEqual(tamperCheck.verified, false, 'Tampered Git tree hash must be rejected');

  await ctx2.stop();
  console.log('✔ PASS: Persistent Ed25519 attestation root, canonical Git tree SHA, and audit verification verified.\n');

  // -------------------------------------------------------------------------
  // TEST 2: Knowledge Store Compaction & Scoped Retrieval (Track 2)
  // -------------------------------------------------------------------------
  console.log('--- TEST 2: Knowledge Store Compaction & Scoped Retrieval ---');

  const ctx3 = new Context();
  ctx3.plugin(TaskStorage, testDbPath);
  ctx3.plugin(MemoryService);
  ctx3.plugin(EvolverService);
  await ctx3.start();

  const memory = ctx3.a3hMemory;
  const evolver = ctx3.a3hEvolver;

  // Reset rules.json for deterministic test run
  await evolver.saveStructuredRules([], gitRoot);

  // 2a. Evolve rules from simulated incidents
  const incidentA = {
    incidentId: 'INC-MEM-01',
    taskId: 'task-mem-leak',
    commitSha: 'a1b2c3d4e5',
    targetBranch: 'staging',
    timestamp: new Date().toISOString(),
    violations: ['Monotonic memory leak detected: Heap climbing monotonically over 5 consecutive batches'],
    stackTrace: 'at Object.<anonymous> (src/services/auth.ts:42:15)'
  };

  const incidentB = {
    incidentId: 'INC-LAT-02',
    taskId: 'task-p99-drift',
    commitSha: 'b2c3d4e5f6',
    targetBranch: 'staging',
    timestamp: new Date().toISOString(),
    violations: ['p99 Latency degradation: 450ms > 1.10x baseline'],
    stackTrace: 'at queryDatabase (src/storage/db.ts:88:10)'
  };

  const evoA = await evolver.evolveFromIncident(incidentA, gitRoot);
  const evoB = await evolver.evolveFromIncident(incidentB, gitRoot);

  console.log(`Synthesized Rule A: [${evoA.synthesizedRule.tag}] for ${evoA.synthesizedRule.targetFiles.join(', ')}`);
  console.log(`Synthesized Rule B: [${evoB.synthesizedRule.tag}] for ${evoB.synthesizedRule.targetFiles.join(', ')}`);

  // Verify structured rules.json was populated
  const rulesInitial = await evolver.getStructuredRules(gitRoot);
  assert.ok(rulesInitial.some((r) => r.tag === evoA.synthesizedRule.tag), 'Rule A must be in rules.json');
  assert.ok(rulesInitial.some((r) => r.tag === evoB.synthesizedRule.tag), 'Rule B must be in rules.json');

  // 2b. Track rule hit metrics
  await evolver.recordRuleHit('memory_leak_prevention', gitRoot);
  await evolver.recordRuleHit('memory_leak_prevention', gitRoot);
  await evolver.recordRuleHit('memory_leak_prevention', gitRoot);

  const rulesAfterHits = await evolver.getStructuredRules(gitRoot);
  const memRule = rulesAfterHits.find((r) => r.tag === 'memory_leak_prevention');
  console.log(`Recorded Rule Hits for memory_leak_prevention: ${memRule?.hits}`);
  assert.strictEqual(memRule?.hits, 3, 'Hits must increment to 3');

  // 2c. Scoped Prompt Retrieval with Token Ceiling
  const scopedPrompt = await memory.getSystemPromptPrefix(gitRoot, {
    maxTokens: 250,
    targetFiles: ['src/services/auth.ts']
  });

  console.log('\nScoped Prompt Prefix Preview:');
  console.log(scopedPrompt);

  assert.ok(scopedPrompt.includes('memory_leak_prevention'), 'Scoped prompt must include targeted high-hit rule');
  assert.ok(scopedPrompt.length <= 250 * 5, 'Prompt prefix must remain within bounded token ceiling');

  // 2d. Compact Knowledge Store Under Bloat
  console.log('\nSimulating knowledge store bloat (adding 25 synthetic rules)...');
  const bloatRules = [...rulesAfterHits];
  for (let i = 1; i <= 25; i++) {
    bloatRules.push({
      id: `synthetic_rule_${i}`,
      tag: `quirk_rule_${i}`,
      category: 'quirks',
      rule: `Historical quirk rule number ${i} for simulated test coverage.`,
      sourceIncidentId: `INC-SYNTH-${i}`,
      targetFiles: [`file_${i}.ts`],
      hits: i % 2 === 0 ? 1 : 0,
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      lastHitAt: new Date(Date.now() - i * 86400000).toISOString()
    });
  }
  await evolver.saveStructuredRules(bloatRules, gitRoot);

  const compactionResult = await memory.compactLearnings(gitRoot, {
    maxRules: 8,
    maxTokens: 800
  });

  console.log('Compaction Report:');
  console.log(`  Rules Before:         ${compactionResult.rulesBefore}`);
  console.log(`  Rules After:          ${compactionResult.rulesAfter}`);
  console.log(`  Pruned Rules:         ${compactionResult.prunedCount}`);
  console.log(`  Markdown Bytes After: ${compactionResult.markdownBytesAfter}`);

  assert.strictEqual(compactionResult.rulesAfter <= 8, true, 'Compaction must enforce maxRules cap');
  assert.strictEqual(compactionResult.prunedCount >= 15, true, 'Compaction must prune excess rules');

  const compactedRules = await evolver.getStructuredRules(gitRoot);
  assert.ok(
    compactedRules.some((r) => r.tag === 'memory_leak_prevention'),
    'High-hit rule must be preserved across compaction'
  );

  await ctx3.stop();
  console.log('✔ PASS: Indexed rules, hit tracking, scoped retrieval, and memory compaction verified.\n');

  // -------------------------------------------------------------------------
  // TEST 3: Staging Packaging & End-to-End Ingestion Simulation (Track 3)
  // -------------------------------------------------------------------------
  console.log('--- TEST 3: Staging Packaging & End-to-End Ingestion Simulation ---');

  // 3a. Validate Docker Compose configuration
  const composePath = path.resolve('packages/a3h/deploy/docker-compose.yml');
  const composeContent = await fs.readFile(composePath, 'utf8');

  assert.ok(composeContent.includes('a3h-orchestrator'), 'Compose must define a3h-orchestrator service');
  assert.ok(composeContent.includes('a3h-redis'), 'Compose must define a3h-redis service');
  assert.ok(composeContent.includes('a3h-db'), 'Compose must define a3h-db service');
  assert.ok(composeContent.includes('AGENT_EGRESS_ALLOWLIST'), 'Compose must enforce outbound egress allowlist');
  console.log('Docker Compose staging topology validated: Services and network isolation declared.');

  // 3b. Simulate Full Swarm Ingestion with ChatOps Suspension & Landing
  const ctx4 = new Context();
  apply(ctx4);
  await ctx4.start();

  const specGate = ctx4.a3hSpecGate;
  const hitl = ctx4.a3hHITL;
  const chatops = ctx4.a3hChatOps;
  const attestation4 = ctx4.a3hAttestation;

  // Step 1: Formulate Spec from incoming issue
  console.log('\nSimulating external issue webhook ingestion & Spec formulation...');
  const specDoc = {
    title: 'Migrate auth session token hashing to SHA-256',
    objective: 'Migrate legacy token hashing to SHA-256 with constant-time comparison.',
    affectedFiles: ['src/auth/session.ts', 'test/auth_session.spec.ts'],
    validationPlan: 'Execute unit tests verifying token generation and validation with 100% assertions passing.',
    breakingChangesRisk: 'low'
  };
  const spec = specGate.validateSpec(specDoc);
  assert.strictEqual(spec.approved, true, 'Spec must be approved by SpecGateService');
  await specGate.saveSpecArtifact(gitRoot, specDoc);
  console.log(`Spec approved: ${specDoc.title}`);

  // Step 2: Trigger high-blast-radius operation in task
  console.log('\nSimulating worker encountering high-risk restricted operation (deploy_to_production)...');
  const stagingTaskId = 'task-staging-sim-01';

  let alertEmitted = false;
  let emittedPayload = null;
  ctx4.on('a3h/chatops-prompt-created', (prompt) => {
    alertEmitted = true;
    emittedPayload = prompt;
  });

  hitl.suspendForApproval(
    stagingTaskId,
    'call_deploy_99',
    'deploy_to_production',
    { cluster: 'prod-us-east', image: 'deepseek-harness/auth:sha256' }
  );

  assert.strictEqual(alertEmitted, true, 'ChatOps alert must be emitted upon HITL suspension');
  assert.ok(emittedPayload.slackPayload.blocks.length >= 3, 'ChatOps payload must contain Block Kit structures');
  console.log(`ChatOps Prompt Dispatched: Task=${emittedPayload.taskId}, BlastRadius=${emittedPayload.blastRadius}`);

  // Step 3: Simulate Developer Approving Merge via ChatOps
  console.log('Simulating developer approving action via interactive ChatOps button...');
  const chatopsResult = chatops.handleAction({
    taskId: stagingTaskId,
    action: 'approve'
  });

  assert.strictEqual(chatopsResult.success, true, 'ChatOps action resolution must succeed');

  // Step 4: Land task with Ed25519 In-Toto Provenance Attestation
  const finalAttestation = await attestation4.generateAttestation(stagingTaskId, {
    baseCommitSha: 'master',
    targetBranch: 'master',
    resultingCommitSha: 'HEAD',
    turnLogs: [{ turn: 1, action: 'spec' }, { turn: 2, action: 'code' }, { turn: 3, action: 'chatops_approval' }],
    verificationOutput: 'Production canary verified: 0% error delta, p99 within threshold',
    filesModified: ['src/auth/session.ts'],
    repoRoot: gitRoot
  });

  assert.strictEqual(finalAttestation.algorithm, 'ed25519', 'Final landing attestation must be signed via Ed25519');
  assert.ok(finalAttestation.payload.gitTreeSha, 'Final landing attestation must capture canonical Git tree SHA');

  console.log('\nFinal Landing Attestation Envelope:');
  console.log(`  Task:         ${finalAttestation.payload.taskId}`);
  console.log(`  Algorithm:    ${finalAttestation.algorithm}`);
  console.log(`  Git Tree SHA: ${finalAttestation.payload.gitTreeSha}`);
  console.log(`  Signature:    ${finalAttestation.signature.slice(0, 32)}...`);

  const finalVerify = attestation4.verifyAttestation(finalAttestation);
  assert.strictEqual(finalVerify.verified, true, 'Final landing attestation must pass verification');

  await ctx4.stop();
  console.log('✔ PASS: Full staging ingestion, ChatOps suspension approval, and verified landing validated.\n');

  console.log('========================================================================');
  console.log('ALL STAGING LIFECYCLE & FLEET STEWARDSHIP TESTS PASSED WITH 100% SUCCESS! ✔✔✔');
  console.log('========================================================================\n');
}

main().catch((err) => {
  console.error('Staging lifecycle verification failed:', err);
  process.exit(1);
});
