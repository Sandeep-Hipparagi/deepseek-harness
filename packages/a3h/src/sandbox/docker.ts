import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export interface DockerContainerOptions {
  image?: string
  cpus?: number
  memory?: string
  network?: string
  timeoutMs?: number
  environment?: Record<string, string>
  worktreePath?: string
  allowHostFallback?: boolean
}

export class DockerSandboxBackend {
  private defaultImage: string
  private defaultCpus: number
  private defaultMemory: string
  private defaultNetwork: string
  private dockerAvailable: boolean | null = null

  constructor(options?: DockerContainerOptions) {
    this.defaultImage = options?.image || 'node:20-alpine'
    this.defaultCpus = options?.cpus ?? 2
    this.defaultMemory = options?.memory || '4g'
    this.defaultNetwork = options?.network || 'none'
  }

  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable
    }
    try {
      await execFileAsync('docker', ['--version'], { timeout: 3000 })
      await execFileAsync('docker', ['info'], { timeout: 5000 })
      this.dockerAvailable = true
    } catch {
      this.dockerAvailable = false
    }
    return this.dockerAvailable
  }

  getDockerRunArgs(
    worktreePath: string,
    cmd: string,
    args: string[] = [],
    options?: DockerContainerOptions,
  ): string[] {
    const image = options?.image || this.defaultImage
    const cpus = String(options?.cpus ?? this.defaultCpus)
    const memory = options?.memory || this.defaultMemory
    const network = options?.network || this.defaultNetwork

    const normalizedPath = path.resolve(worktreePath).replace(/\\/g, '/')

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '-i',
      '--cpus', cpus,
      '--memory', memory,
      '--network', network,
      '-v', `${normalizedPath}:/workspace`,
      '-w', '/workspace',
    ]

    // Explicitly pass only sanitized environment variables (no SSH/GPG/host credentials)
    if (options?.environment) {
      for (const [k, v] of Object.entries(options.environment)) {
        dockerArgs.push('-e', `${k}=${v}`)
      }
    }

    dockerArgs.push(image)
    dockerArgs.push(cmd)
    dockerArgs.push(...args)

    return dockerArgs
  }

  private spoolOutput(rawOutput: string): string {
    const maxBytes = 8192
    if (Buffer.byteLength(rawOutput, 'utf8') <= maxBytes) {
      return rawOutput
    }
    const lines = rawOutput.split(/\r?\n/)
    if (lines.length <= 200) {
      return rawOutput.slice(0, maxBytes) + '\n[TOOL OUTPUT TRUNCATED: Exceeded 8KB]'
    }
    const head = lines.slice(0, 50).join('\n')
    const tail = lines.slice(-150).join('\n')
    return `${head}\n\n[TOOL OUTPUT TRUNCATED: Exceeded 8KB]\n--- HEAD ---\n...\n--- TAIL ---\n${tail}`
  }

  async execConfined(
    worktreePath: string,
    cmd: string,
    args: string[] = [],
    options?: DockerContainerOptions,
  ): Promise<{ exitCode: number; output: string; backendUsed: 'docker' | 'host_fallback' }> {
    const timeoutMs = options?.timeoutMs ?? 60000
    const hasDocker = await this.isDockerAvailable()

    if (hasDocker) {
      const dockerArgs = this.getDockerRunArgs(worktreePath, cmd, args, options)
      return new Promise((resolve) => {
        const proc = spawn('docker', dockerArgs, {
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
          },
        })

        let stdout = ''
        let stderr = ''

        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {}
          resolve({
            exitCode: -1,
            output: this.spoolOutput(`[TIMEOUT]: Docker container execution exceeded ${timeoutMs}ms limit`),
            backendUsed: 'docker',
          })
        }, timeoutMs)

        proc.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        proc.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        proc.on('close', (code) => {
          clearTimeout(timer)
          const combined = stdout + (stderr ? `\n[STDERR]:\n${stderr}` : '')
          resolve({
            exitCode: code ?? 0,
            output: this.spoolOutput(combined),
            backendUsed: 'docker',
          })
        })

        proc.on('error', (err) => {
          clearTimeout(timer)
          resolve({
            exitCode: 1,
            output: this.spoolOutput(`Docker execution error: ${err.message}`),
            backendUsed: 'docker',
          })
        })
      })
    }

    // Host confined execution fallback
    if (options?.allowHostFallback === false) {
      throw new Error('[SECURITY ALERT] Container execution failed or Docker daemon unreachable, and allowHostFallback is disabled.')
    }

    // Strictly allow-list standard OS environment variables only
    const ALLOWED_ENV_VARS = [
      'PATH',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'LANG',
      'LC_ALL',
    ]

    const sanitizedHostEnv: Record<string, string> = {}
    for (const key of ALLOWED_ENV_VARS) {
      if (process.env[key] !== undefined) {
        sanitizedHostEnv[key] = process.env[key]!
      }
    }

    const taskEnv = options?.environment || {}
    const finalEnv: Record<string, string> = {
      ...sanitizedHostEnv,
      ...taskEnv,
    }

    // Explicitly avoid inherited SSH or Cloud credentials
    delete finalEnv['SSH_AUTH_SOCK']
    delete finalEnv['GPG_AGENT_INFO']
    delete finalEnv['GIT_SSH_COMMAND']
    delete finalEnv['AWS_ACCESS_KEY_ID']
    delete finalEnv['AWS_SECRET_ACCESS_KEY']
    delete finalEnv['GITHUB_TOKEN']

    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd: worktreePath,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        windowsHide: true,
        env: finalEnv,
      })

      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM')
        } catch {}
        resolve({
          exitCode: -1,
          output: this.spoolOutput(`[TIMEOUT]: Command exceeded ${timeoutMs}ms limit`),
          backendUsed: 'host_fallback',
        })
      }, timeoutMs)

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        const combined = stdout + (stderr ? `\n[STDERR]:\n${stderr}` : '')
        resolve({
          exitCode: code ?? 0,
          output: this.spoolOutput(combined),
          backendUsed: 'host_fallback',
        })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          exitCode: 1,
          output: this.spoolOutput(`Execution error: ${err.message}`),
          backendUsed: 'host_fallback',
        })
      })
    })
  }
}
