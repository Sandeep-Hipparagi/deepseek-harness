import { Context } from 'cordis';
import { WorktreeSandbox } from './dist/sandbox/worktree.js';
import { VerificationService } from './dist/services/verification.js';
import { HITLController } from './dist/services/hitl.js';
import { BackgroundAgentWorker } from './dist/services/worker.js';
import { GovernanceService } from './dist/services/governance.js';
import { TelemetryService } from './dist/services/telemetry.js';
import { TaskStorage } from './dist/storage/db.js';
import { HeadlessLspService } from './dist/services/lsp.js';
import fs from 'node:fs/promises';
import path from 'node:path';

async function runPhase3Checks() {
  console.log('=== Starting Phase 3 Navigation & Cartography Verification ===\n');

  const testDbPath = path.resolve('.a3h-data/test-phase3.sqlite');
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
  ctx.plugin(BackgroundAgentWorker);
  await ctx.start();

  const sandbox = ctx.a3hSandbox;
  const worker = ctx.a3hWorker;
  const lsp = ctx.a3hLSP;

  // ----------------------------------------------------
  // TEST 1: Window Guard (ReadFileRange <= 120 lines)
  // ----------------------------------------------------
  console.log('--- TEST 1: Window Guard (readFileRange <= 120 lines) ---');
  const taskId1 = 'p3-window-01';
  const worktreePath1 = await sandbox.allocate(taskId1);

  // Generate a 200-line file
  const largeContent = Array.from({ length: 200 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join('\n');
  const testFile1 = path.join(worktreePath1, 'large-file.ts');
  await fs.writeFile(testFile1, largeContent);

  // Attempt to read 130 lines (> 120 limit)
  console.log('Attempting to read 130 lines (span > 120)...');
  const overLimitResult = await worker.handleToolInvocation(
    taskId1,
    {
      id: 'call-read-1',
      name: 'read_file_range',
      arguments: { filePath: 'large-file.ts', startLine: 1, endLine: 130 }
    },
    worktreePath1
  );

  console.log('Over-limit response:', overLimitResult.message);
  if (!overLimitResult.message?.includes('exceeds the maximum limit of 120 lines')) {
    throw new Error(`FAIL: Window guard did not reject over-limit read! Output: ${overLimitResult.message}`);
  }
  console.log('✔ Window guard rejected read > 120 lines.');

  // Attempt bounded read (lines 10 to 40 = 31 lines)
  console.log('Attempting bounded read (lines 10 to 40)...');
  const validReadResult = await worker.handleToolInvocation(
    taskId1,
    {
      id: 'call-read-2',
      name: 'read_file_range',
      arguments: { filePath: 'large-file.ts', startLine: 10, endLine: 40 }
    },
    worktreePath1
  );

  if (!validReadResult.toolResult?.includes('10 | const line_10 = 10;')) {
    throw new Error('FAIL: Bounded read did not include line numbers or content!');
  }
  console.log('✔ Bounded read returned formatted lines with line numbers.');
  console.log('✔ PASS: Test 1 (Window Guard) passed.\n');

  await sandbox.cleanup(taskId1);

  // ----------------------------------------------------
  // TEST 2: Reference Trapping & Blast Radius
  // ----------------------------------------------------
  console.log('--- TEST 2: Reference Trapping (find_symbol_references) ---');
  const taskId2 = 'p3-refs-02';
  const worktreePath2 = await sandbox.allocate(taskId2);

  const srcDir = path.join(worktreePath2, 'src');
  await fs.mkdir(srcDir, { recursive: true });

  // auth.ts declares validateToken
  await fs.writeFile(
    path.join(srcDir, 'auth.ts'),
    `export function validateToken(token: string): boolean {\n  return token.length > 0;\n}\n`
  );

  // middleware.ts calls validateToken
  await fs.writeFile(
    path.join(srcDir, 'middleware.ts'),
    `import { validateToken } from './auth.js';\nexport function authMiddleware(req: any) {\n  return validateToken(req.token);\n}\n`
  );

  // server.ts calls validateToken
  await fs.writeFile(
    path.join(srcDir, 'server.ts'),
    `import { validateToken } from './auth.js';\nexport function start() {\n  const ok = validateToken('secret');\n}\n`
  );

  console.log('Querying find_symbol_references for "validateToken"...');
  const refsResult = await worker.handleToolInvocation(
    taskId2,
    {
      id: 'call-refs-1',
      name: 'find_symbol_references',
      arguments: { symbol: 'validateToken' }
    },
    worktreePath2
  );

  const refs = refsResult.toolResult;
  console.log(`Found ${refs.length} references across worktree:`);
  for (const r of refs) {
    console.log(`  -> ${r.filePath}:${r.line} (isDefinition: ${r.isDefinition}) "${r.lineContent}"`);
  }

  const hasAuthDef = refs.some(r => r.filePath.includes('auth.ts') && r.isDefinition);
  const hasMiddlewareCall = refs.some(r => r.filePath.includes('middleware.ts'));
  const hasServerCall = refs.some(r => r.filePath.includes('server.ts'));

  if (!hasAuthDef || !hasMiddlewareCall || !hasServerCall) {
    throw new Error('FAIL: Reference trapping failed to identify all cross-file call sites!');
  }
  console.log('✔ PASS: Test 2 (Reference Trapping) identified all definition and call sites.\n');

  // Also verify find_symbol_definition
  console.log('Querying find_symbol_definition for "validateToken"...');
  const defResult = await worker.handleToolInvocation(
    taskId2,
    {
      id: 'call-def-1',
      name: 'find_symbol_definition',
      arguments: { symbol: 'validateToken' }
    },
    worktreePath2
  );
  console.log('Found definition:', defResult.toolResult);
  if (!defResult.toolResult?.filePath.includes('auth.ts')) {
    throw new Error('FAIL: find_symbol_definition did not locate auth.ts!');
  }
  console.log('✔ PASS: find_symbol_definition located definition in auth.ts.\n');

  await sandbox.cleanup(taskId2);

  // ----------------------------------------------------
  // TEST 3: Cartography Outline (get_file_outline)
  // ----------------------------------------------------
  console.log('--- TEST 3: Cartography Outline (get_file_outline) ---');
  const taskId3 = 'p3-outline-03';
  const worktreePath3 = await sandbox.allocate(taskId3);

  const modelCode = `
export interface UserRecord {
  id: string;
  email: string;
}

export class UserManager {
  private users: UserRecord[] = [];

  constructor() {}

  async findUser(id: string): Promise<UserRecord | undefined> {
    return this.users.find(u => u.id === id);
  }

  deleteUser(id: string): boolean {
    return true;
  }
}

export function createManager(): UserManager {
  return new UserManager();
}
`;

  await fs.writeFile(path.join(worktreePath3, 'manager.ts'), modelCode);

  const outlineResult = await worker.handleToolInvocation(
    taskId3,
    {
      id: 'call-outline-1',
      name: 'get_file_outline',
      arguments: { filePath: 'manager.ts' }
    },
    worktreePath3
  );

  const outline = outlineResult.toolResult;
  console.log(`Extracted ${outline.symbols.length} top-level symbols from manager.ts:`);
  for (const s of outline.symbols) {
    console.log(`  [${s.kind}] ${s.name} (lines ${s.startLine}-${s.endLine})`);
    if (s.children) {
      for (const c of s.children) {
        console.log(`     └─ [${c.kind}] ${c.name} (lines ${c.startLine}-${c.endLine})`);
      }
    }
  }

  const hasInterface = outline.symbols.some(s => s.name === 'UserRecord' && s.kind === 'interface');
  const hasClass = outline.symbols.some(s => s.name === 'UserManager' && s.kind === 'class');
  const hasMethod = outline.symbols.some(s => s.children?.some(c => c.name === 'findUser' && c.kind === 'method'));
  const hasFunction = outline.symbols.some(s => s.name === 'createManager' && s.kind === 'function');

  if (!hasInterface || !hasClass || !hasMethod || !hasFunction) {
    throw new Error('FAIL: Outline did not extract all expected structural AST symbols!');
  }
  console.log('✔ PASS: Test 3 (Cartography Outline) extracted interface, class, method, and function skeletons.\n');

  await sandbox.cleanup(taskId3);

  // ----------------------------------------------------
  // TEST 4: Daemon Teardown (Headless LSP Lifecycle)
  // ----------------------------------------------------
  console.log('--- TEST 4: Daemon Teardown (LSP Lifecycle & Cleanup) ---');
  const taskId4 = 'p3-teardown-04';
  const worktreePath4 = await sandbox.allocate(taskId4);

  // Test getOrStartServer & cleanup
  console.log('Spawning language server process...');
  const proc = await lsp.getOrStartServer(worktreePath4, 'ts');
  const isRunningBefore = lsp.isServerRunning(worktreePath4);
  console.log(`LSP daemon running before cleanup? ${isRunningBefore}`);

  console.log('Triggering cleanup...');
  lsp.cleanup(worktreePath4);
  const isRunningAfter = lsp.isServerRunning(worktreePath4);
  console.log(`LSP daemon running after cleanup? ${isRunningAfter}`);

  if (isRunningAfter) {
    throw new Error('FAIL: LSP daemon was not killed during cleanup!');
  }
  console.log('✔ PASS: Test 4 (Daemon Teardown) verified LSP process cleanup.\n');

  await sandbox.cleanup(taskId4);

  // Clean up test sqlite
  try {
    await fs.unlink(testDbPath);
  } catch {}

  console.log('======================================================');
  console.log('ALL PHASE 3 NAVIGATION & LSP TESTS PASSED! ✔✔✔');
  console.log('======================================================');
}

runPhase3Checks().catch((err) => {
  console.error('Phase 3 verification failed:', err);
  process.exit(1);
});
