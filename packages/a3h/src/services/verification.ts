import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface VerificationResult {
  passed: boolean
  tierFailed?: number
  reason?: string
  diffSummary?: string
}

declare module 'cordis' {
  interface Context {
    a3hVerification: VerificationService
    a3hVerifier: VerificationService
  }
}

export class VerificationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a3hVerification', true)
  }

  async verifyTask(
    worktreePath: string,
    testCommand?: string,
    conformanceCommand?: string,
    options?: { skipGhostDiff?: boolean; baseBranch?: string },
  ): Promise<VerificationResult> {
    // 1. Ghost-Diff Check: Ensure changes actually exist
    if (!options?.skipGhostDiff) {
      const { stdout: diffStatus } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath })
      if (!diffStatus.trim()) {
        return {
          passed: false,
          tierFailed: 0,
          reason: 'REJECTED: No files were modified. You must implement the code changes before declaring completion.',
        }
      }
    } else if (options?.baseBranch) {
      const { stdout: diffWithBase } = await exec('git', ['diff', '--name-only', `${options.baseBranch}...HEAD`], { cwd: worktreePath })
      if (!diffWithBase.trim()) {
        const { stdout: status } = await exec('git', ['status'], { cwd: worktreePath })
        const { stdout: log } = await exec('git', ['log', '-n', '3', '--oneline'], { cwd: worktreePath })
        console.error('[DIFF EMPTY DEBUG] baseBranch:', options.baseBranch, 'status:', status, 'log:', log)
        return {
          passed: false,
          tierFailed: 0,
          reason: 'REJECTED: No files were modified relative to the target branch.',
        }
      }
    }

    // 2. Test Assertion Tampering Guard: Did the model mutate existing test files?
    const diffRef = options?.baseBranch ? `${options.baseBranch}...HEAD` : 'HEAD'
    const { stdout: modifiedFiles } = await exec('git', ['diff', '--name-only', diffRef], { cwd: worktreePath })
    const touchedTests = modifiedFiles
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.includes('test') || f.includes('spec'))

    // Check if tests were edited rather than newly added
    for (const testFile of touchedTests) {
      if (!testFile) continue
      try {
        const { stdout: diffOnTest } = await exec('git', ['diff', diffRef, '--', testFile], { cwd: worktreePath })
        // Check for removed lines in existing test files
        const lines = diffOnTest.split('\n')
        const hasDeletedAssertion = lines.some(line => line.startsWith('-') && !line.startsWith('---'))
        if (hasDeletedAssertion && !diffOnTest.includes('+++ /dev/null')) {
          return {
            passed: false,
            tierFailed: 0,
            reason: `REJECTED: Assertion tampering detected in '${testFile}'. You cannot modify or delete existing test assertions.`,
          }
        }
      } catch {
        // New untracked test file is allowed
      }
    }

    // 3. Tier 1: Static Conformance (Lint / Typecheck)
    if (conformanceCommand) {
      const [cBin, ...cArgs] = conformanceCommand.split(' ')
      try {
        await exec(cBin, cArgs, { cwd: worktreePath, shell: true })
      } catch (err: any) {
        return {
          passed: false,
          tierFailed: 1,
          reason: `Tier 1 Static Conformance Failed (Typecheck):\n${err.stdout || err.stderr || err.message}`,
        }
      }
    }

    // 4. Tier 2: Targeted Test Suite
    if (testCommand) {
      const [bin, ...args] = testCommand.split(' ')
      try {
        await exec(bin, args, { cwd: worktreePath, shell: true })
      } catch (err: any) {
        return {
          passed: false,
          tierFailed: 2,
          reason: `Tier 2 Test Suite Failed:\n${err.stdout || err.stderr || err.message}`,
        }
      }
    }

    // Capture unified diff for review artifact
    const { stdout: fullDiff } = await exec('git', ['diff', diffRef], { cwd: worktreePath })
    const { stdout: statusSummary } = await exec('git', ['status', '--short'], { cwd: worktreePath })

    return {
      passed: true,
      diffSummary: fullDiff.trim() || statusSummary.trim(),
    }
  }
}

// Backward-compatible alias for Phase 1 references
export class VerificationEngine extends VerificationService {
  constructor(ctx: Context) {
    super(ctx)
  }
}
