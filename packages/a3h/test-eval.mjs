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
  BenchmarkHarness
} from './dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

async function runBenchmarkSuite() {
  console.log('=== Starting Phase 6 SWE-Bench Style Synthetic Evaluation ===\n');

  const testDbPath = path.resolve('.a3h-data/test-eval.sqlite');
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

  const { stdout: rootGitTop } = await exec('git', ['rev-parse', '--show-toplevel']);
  const gitRoot = rootGitTop.trim();
  const benchmarkBranch = 'test-benchmark-target';

  console.log(`Setting up benchmark target branch: ${benchmarkBranch}...`);
  await exec('git', ['branch', '-f', benchmarkBranch, 'HEAD'], { cwd: gitRoot });

  const harness = new BenchmarkHarness(ctx);

  const issues = [
    {
      id: 'swe-01-null-guard',
      name: 'Add null guard to calculateTotal',
      description: 'Fix TypeError when items array is undefined or null',
      setupFiles: {
        'src/cart.js': [
          'export function calculateTotal(items) {',
          '  return items.reduce((sum, item) => sum + item.price, 0);',
          '}'
        ].join('\n'),
        'test-cart.js': [
          'import assert from "node:assert";',
          'import { calculateTotal } from "./src/cart.js";',
          'assert.strictEqual(calculateTotal([{ price: 10 }, { price: 20 }]), 30);',
          'assert.strictEqual(calculateTotal(null), 0);',
          'assert.strictEqual(calculateTotal(undefined), 0);',
          'console.log("Cart tests passed.");'
        ].join('\n')
      },
      testCommand: 'node test-cart.js',
      solution: {
        filePath: 'src/cart.js',
        startLine: 1,
        endLine: 3,
        targetContent: [
          'export function calculateTotal(items) {',
          '  return items.reduce((sum, item) => sum + item.price, 0);',
          '}'
        ].join('\n'),
        replacementContent: [
          'export function calculateTotal(items) {',
          '  if (!items || !Array.isArray(items)) return 0;',
          '  return items.reduce((sum, item) => sum + item.price, 0);',
          '}'
        ].join('\n')
      }
    },
    {
      id: 'swe-02-auth-token',
      name: 'Implement isTokenExpired helper',
      description: 'Add token expiry verification logic to auth helper',
      setupFiles: {
        'src/tokens.js': [
          'export function isTokenExpired(token) {',
          '  return true;',
          '}'
        ].join('\n'),
        'test-tokens.js': [
          'import assert from "node:assert";',
          'import { isTokenExpired } from "./src/tokens.js";',
          'assert.strictEqual(isTokenExpired({ exp: Date.now() + 100000 }), false);',
          'assert.strictEqual(isTokenExpired({ exp: Date.now() - 100000 }), true);',
          'console.log("Token tests passed.");'
        ].join('\n')
      },
      testCommand: 'node test-tokens.js',
      solution: {
        filePath: 'src/tokens.js',
        startLine: 1,
        endLine: 3,
        targetContent: [
          'export function isTokenExpired(token) {',
          '  return true;',
          '}'
        ].join('\n'),
        replacementContent: [
          'export function isTokenExpired(token) {',
          '  if (!token || !token.exp) return true;',
          '  return token.exp < Date.now();',
          '}'
        ].join('\n')
      }
    },
    {
      id: 'swe-03-slugify',
      name: 'Implement slugify string helper',
      description: 'Convert title strings to lowercased hyphenated slugs',
      setupFiles: {
        'src/slug.js': [
          'export function slugify(str) {',
          '  return str;',
          '}'
        ].join('\n'),
        'test-slug.js': [
          'import assert from "node:assert";',
          'import { slugify } from "./src/slug.js";',
          'assert.strictEqual(slugify("Hello World"), "hello-world");',
          'assert.strictEqual(slugify("DeepSeek Harness"), "deepseek-harness");',
          'console.log("Slug tests passed.");'
        ].join('\n')
      },
      testCommand: 'node test-slug.js',
      solution: {
        filePath: 'src/slug.js',
        startLine: 1,
        endLine: 3,
        targetContent: [
          'export function slugify(str) {',
          '  return str;',
          '}'
        ].join('\n'),
        replacementContent: [
          'export function slugify(str) {',
          '  if (!str) return "";',
          '  return str.toLowerCase().trim().replace(/\\s+/g, "-");',
          '}'
        ].join('\n')
      }
    }
  ];

  try {
    console.log(`Executing benchmark against ${issues.length} synthetic issues...`);
    const benchmarkResults = await harness.runBenchmark(issues, benchmarkBranch);

    console.log('\n=== Evaluation Metrics Report ===');
    console.log(`Total Evaluated Issues: ${benchmarkResults.totalIssues}`);
    console.log(`Passed Tasks:           ${benchmarkResults.passedCount}/${benchmarkResults.totalIssues}`);
    console.log(`Pass@1 Accuracy:        ${(benchmarkResults.passAt1Rate * 100).toFixed(1)}%`);
    console.log(`Average Turns Per Task: ${benchmarkResults.averageTurns.toFixed(1)}`);
    console.log(`Average Task Duration:  ${benchmarkResults.averageDurationMs.toFixed(0)}ms`);
    console.log(`Context Spool Bounded:  ${benchmarkResults.contextBounded ? 'YES (<= 8KB)' : 'NO'}`);

    for (const res of benchmarkResults.issues) {
      console.log(` - [${res.passed ? '✔ PASS' : '✖ FAIL'}] ${res.id} (${res.name}) - ${res.turns} turns in ${res.durationMs}ms`);
    }

    if (benchmarkResults.passAt1Rate !== 1.0) {
      throw new Error(`FAIL: Expected 100% Pass@1 rate on synthetic benchmark, got ${benchmarkResults.passAt1Rate * 100}%`);
    }

    if (!benchmarkResults.contextBounded) {
      throw new Error('FAIL: Output bounding failed during evaluation!');
    }

    console.log('\n======================================================');
    console.log('ALL PHASE 6 SYNTHETIC BENCHMARKS PASSED! ✔✔✔');
    console.log('======================================================\n');
  } finally {
    try {
      await ctx.a3hReconciliation.cleanupStaging();
    } catch {}
    try {
      await exec('git', ['branch', '-D', benchmarkBranch], { cwd: gitRoot });
    } catch {}
  }
}

runBenchmarkSuite().catch((err) => {
  console.error('Benchmark suite failed:', err);
  process.exit(1);
});
