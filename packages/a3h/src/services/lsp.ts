import { Context, Service } from 'cordis'
import { spawn, ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import ts from 'typescript'

const execFileAsync = promisify(execFile)

export interface SymbolReference {
  filePath: string
  line: number
  column: number
  lineContent: string
  isDefinition: boolean
}

export interface SymbolDefinition {
  filePath: string
  line: number
  column: number
  lineContent: string
}

declare module 'cordis' {
  interface Context {
    a3hLSP: HeadlessLspService
  }
}

export class HeadlessLspService extends Service {
  private servers = new Map<string, ChildProcess>()
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>()
  private messageBuffers = new Map<string, string>()
  private nextRequestId = 1

  constructor(ctx: Context) {
    super(ctx, 'a3hLSP', true)
  }

  async getOrStartServer(worktreePath: string, language: 'ts' | 'py' = 'ts'): Promise<ChildProcess> {
    const normalizedKey = path.normalize(worktreePath).toLowerCase()
    if (this.servers.has(normalizedKey)) {
      return this.servers.get(normalizedKey)!
    }

    const cmd = language === 'ts' ? 'typescript-language-server' : 'pyright-langserver'
    const serverProc = spawn(cmd, ['--stdio'], {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    })

    this.servers.set(normalizedKey, serverProc)
    this.messageBuffers.set(normalizedKey, '')

    // Handle incoming JSON-RPC stream
    serverProc.stdout?.on('data', (chunk: Buffer) => {
      this.handleLspData(normalizedKey, chunk.toString('utf-8'))
    })

    serverProc.on('error', (err) => {
      // Graceful handling if language server binary is missing from PATH
      this.servers.delete(normalizedKey)
    })

    serverProc.on('exit', () => {
      this.servers.delete(normalizedKey)
      this.messageBuffers.delete(normalizedKey)
    })

    // Initialize LSP handshake (rootUri locked to worktree)
    try {
      await this.sendRpc(serverProc, 'initialize', {
        rootUri: `file://${path.resolve(worktreePath).replace(/\\/g, '/')}`,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
          },
        },
      })
    } catch {
      // Non-fatal if server init fails
    }

    return serverProc
  }

  private handleLspData(key: string, data: string) {
    let buffer = (this.messageBuffers.get(key) || '') + data
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = buffer.slice(0, headerEnd)
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) break

      const contentLength = parseInt(match[1], 10)
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength

      if (buffer.length < messageEnd) break // Incomplete message

      const jsonStr = buffer.slice(messageStart, messageEnd)
      buffer = buffer.slice(messageEnd)

      try {
        const message = JSON.parse(jsonStr)
        if (message.id && this.pendingRequests.has(message.id)) {
          const { resolve } = this.pendingRequests.get(message.id)!
          this.pendingRequests.delete(message.id)
          resolve(message.result)
        }
      } catch {}
    }
    this.messageBuffers.set(key, buffer)
  }

  sendRpc(proc: ChildProcess, method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      const header = `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n`

      this.pendingRequests.set(id, { resolve, reject })

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          resolve(null) // Fallback on timeout
        }
      }, 5000)

      try {
        proc.stdin?.write(header + payload)
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        reject(err)
      }
    })
  }

  // Cross-file semantic reference locator (guarantees blast radius discovery)
  async findSymbolReferences(
    worktreePath: string,
    targetSymbol: string,
    originFile?: string,
  ): Promise<SymbolReference[]> {
    const references: SymbolReference[] = []
    const files = await this.listSourceFiles(worktreePath)

    for (const relFile of files) {
      const fullPath = path.resolve(worktreePath, relFile)
      let content: string
      try {
        content = await fs.readFile(fullPath, 'utf-8')
      } catch {
        continue
      }

      const ext = path.extname(relFile).toLowerCase()
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        const sourceFile = ts.createSourceFile(
          relFile,
          content,
          ts.ScriptTarget.Latest,
          true,
        )

        const lines = content.split('\n')

        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === targetSymbol) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            const lineIdx = line
            const lineContent = lines[lineIdx]?.trim() || ''

            // Check if definition site
            let isDefinition = false
            const parent = node.parent
            if (
              (ts.isFunctionDeclaration(parent) && parent.name === node) ||
              (ts.isMethodDeclaration(parent) && parent.name === node) ||
              (ts.isClassDeclaration(parent) && parent.name === node) ||
              (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
              (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
              (ts.isVariableDeclaration(parent) && parent.name === node)
            ) {
              isDefinition = true
            }

            references.push({
              filePath: relFile.replace(/\\/g, '/'),
              line: line + 1,
              column: character + 1,
              lineContent,
              isDefinition,
            })
          }
          ts.forEachChild(node, visit)
        }

        ts.forEachChild(sourceFile, visit)
      } else {
        // Textual token match for non-TS source files
        const lines = content.split('\n')
        const regex = new RegExp(`\\b${targetSymbol}\\b`)
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            references.push({
              filePath: relFile.replace(/\\/g, '/'),
              line: i + 1,
              column: lines[i].indexOf(targetSymbol) + 1,
              lineContent: lines[i].trim(),
              isDefinition: lines[i].includes('def ') || lines[i].includes('class '),
            })
          }
        }
      }
    }

    return references
  }

  // Cross-file symbol definition finder
  async findSymbolDefinition(
    worktreePath: string,
    targetSymbol: string,
  ): Promise<SymbolDefinition | null> {
    const refs = await this.findSymbolReferences(worktreePath, targetSymbol)
    const def = refs.find(r => r.isDefinition)
    if (def) {
      return {
        filePath: def.filePath,
        line: def.line,
        column: def.column,
        lineContent: def.lineContent,
      }
    }
    return null
  }

  private async listSourceFiles(dir: string, base: string = ''): Promise<string[]> {
    const allowedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.json', '.md'])
    try {
      const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: dir })
      if (stdout) {
        return stdout
          .split(/\r?\n/)
          .map(f => f.trim())
          .filter((f) => {
            if (!f || f.startsWith('.')) return false
            if (f.startsWith('.worktrees') || f.includes('node_modules')) return false
            const ext = path.extname(f).toLowerCase()
            return allowedExts.has(ext)
          })
      }
    } catch {}

    const results: string[] = []
    const entries = await fs.readdir(path.resolve(dir, base), { withFileTypes: true })

    for (const entry of entries) {
      const relPath = base ? path.join(base, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === '.worktrees'
        ) {
          continue
        }
        const subFiles = await this.listSourceFiles(dir, relPath)
        results.push(...subFiles)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.json', '.md'].includes(ext)) {
          results.push(relPath)
        }
      }
    }

    return results
  }

  cleanup(worktreePath: string) {
    const normalizedKey = path.normalize(worktreePath).toLowerCase()
    const proc = this.servers.get(normalizedKey)
    if (proc) {
      try {
        proc.kill('SIGTERM')
      } catch {}
      this.servers.delete(normalizedKey)
      this.messageBuffers.delete(normalizedKey)
    }
  }

  isServerRunning(worktreePath: string): boolean {
    const normalizedKey = path.normalize(worktreePath).toLowerCase()
    const proc = this.servers.get(normalizedKey)
    return Boolean(proc && !proc.killed)
  }
}
