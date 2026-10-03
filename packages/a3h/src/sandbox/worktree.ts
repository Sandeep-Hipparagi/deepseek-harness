import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

declare module 'cordis' {
  interface Context {
    a3hSandbox: WorktreeSandbox
  }
}

import { DockerSandboxBackend, DockerContainerOptions } from './docker.js'

export class WorktreeSandbox extends Service {
  private dockerBackend: DockerSandboxBackend

  constructor(ctx: Context) {
    super(ctx, 'a3hSandbox', true)
    this.dockerBackend = new DockerSandboxBackend()
  }

  getDockerBackend(): DockerSandboxBackend {
    return this.dockerBackend
  }

  private async getGitRoot(externalRepoPath?: string): Promise<string> {
    if (externalRepoPath) {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: externalRepoPath })
      return stdout.trim()
    }
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
    return stdout.trim()
  }

  async allocate(taskId: string, baseCommit: string = 'HEAD', externalRepoPath?: string): Promise<string> {
    const gitRoot = await this.getGitRoot(externalRepoPath)
    const worktreePath = path.resolve(gitRoot, '.worktrees', `task-${taskId}`)
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })

    // Clean up any stale worktree or branch first
    try {
      await fs.unlink(path.resolve(worktreePath, 'node_modules'))
    } catch {}
    try {
      await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: gitRoot })
    } catch {}
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: gitRoot })
    } catch {}
    try {
      await execFileAsync('git', ['branch', '-D', `feature/task-${taskId}`], { cwd: gitRoot })
    } catch {}

    // Two-Phase allocation: git worktree branch isolation
    await execFileAsync('git', [
      'worktree', 'add', '-b', `feature/task-${taskId}`,
      worktreePath, baseCommit,
    ], { cwd: gitRoot })

    // Junction root node_modules for instant compiler and dependency access if present
    const rootNodeModules = path.resolve(gitRoot, 'node_modules')
    const worktreeNodeModules = path.resolve(worktreePath, 'node_modules')
    try {
      if (await fs.stat(rootNodeModules).then(() => true).catch(() => false)) {
        await fs.symlink(rootNodeModules, worktreeNodeModules, 'junction')
      }
    } catch {}

    return worktreePath
  }

  async execConfined(worktreePath: string, cmd: string, args: string[], timeoutMs = 60000): Promise<{ exitCode: number; output: string }> {
    const canonicalRoot = await fs.realpath(worktreePath)

    return new Promise((resolve) => {
      const child = execFile(cmd, args, {
        cwd: canonicalRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB raw safety buffer
        shell: process.platform === 'win32',
      }, (error, stdout, stderr) => {
        // Output Sanitizer: 8 KB head/tail spooler
        const sanitized = this.sanitizeOutput(stdout ?? '', stderr ?? '', worktreePath)
        resolve({ exitCode: child.exitCode ?? (error ? 1 : 0), output: sanitized })
      })
    })
  }

  async execContainerConfined(
    worktreePath: string,
    cmd: string,
    args: string[] = [],
    options?: DockerContainerOptions,
  ): Promise<{ exitCode: number; output: string; backendUsed: 'docker' | 'host_fallback' }> {
    return this.dockerBackend.execConfined(worktreePath, cmd, args, options)
  }

  private sanitizeOutput(stdout: string, stderr: string, worktreePath: string): string {
    const combined = `${stdout}\n${stderr}`.trim()
    if (Buffer.byteLength(combined, 'utf8') <= 8192) return combined

    const lines = combined.split('\n')
    const head = lines.slice(0, 50).join('\n')
    const tail = lines.slice(-150).join('\n')
    return `[TOOL OUTPUT TRUNCATED: Exceeded 8KB]\n--- HEAD ---\n${head}\n--- MIDDLE TRUNCATED ---\n--- TAIL ---\n${tail}`
  }

  async cleanup(taskId: string, externalRepoPath?: string): Promise<void> {
    const gitRoot = await this.getGitRoot(externalRepoPath)
    const worktreePath = path.resolve(gitRoot, '.worktrees', `task-${taskId}`)
    try {
      await fs.unlink(path.resolve(worktreePath, 'node_modules'))
    } catch {}
    try {
      await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: gitRoot })
    } catch (err) {}
    try {
      await execFileAsync('git', ['branch', '-D', `feature/task-${taskId}`], { cwd: gitRoot })
    } catch (err) {}
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: gitRoot })
    } catch {}
  }
}
