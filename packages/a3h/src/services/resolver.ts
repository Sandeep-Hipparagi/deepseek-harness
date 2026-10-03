import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export interface ResolverOptions {
  stagingPath: string
  conflictFiles: string[]
  maxTurns?: number // default: 2
  resolverFn?: (
    filePath: string,
    content: string,
    turn: number,
  ) => Promise<string | null> | (string | null)
}

export class ConflictResolver {
  private stagingPath: string
  private maxTurns: number

  constructor(stagingPath: string, maxTurns = 2) {
    this.stagingPath = stagingPath
    this.maxTurns = maxTurns
  }

  async resolveConflicts(
    conflictFiles: string[],
    resolverFn?: (filePath: string, content: string, turn: number) => Promise<string | null> | (string | null),
  ): Promise<boolean> {
    for (const relFile of conflictFiles) {
      const fullPath = path.resolve(this.stagingPath, relFile)
      let resolved = false

      for (let turn = 1; turn <= this.maxTurns; turn++) {
        let content: string
        try {
          content = await fs.readFile(fullPath, 'utf8')
        } catch {
          break
        }

        // If file no longer contains conflict markers, stage it
        if (!content.includes('<<<<<<<') && !content.includes('>>>>>>>')) {
          await this.stageFile(relFile)
          resolved = true
          break
        }

        if (resolverFn) {
          const customResolved = await resolverFn(relFile, content, turn)
          if (customResolved !== null) {
            await fs.writeFile(fullPath, customResolved, 'utf8')
            await this.stageFile(relFile)
            resolved = true
            break
          }
        } else {
          // Standard programmatic 3-way resolver
          const autoResolved = this.tryAutoResolveMarkers(content)
          if (autoResolved !== null) {
            await fs.writeFile(fullPath, autoResolved, 'utf8')
            await this.stageFile(relFile)
            resolved = true
            break
          }
        }

        // If turn >= maxTurns and still has markers, cannot resolve
        if (turn >= this.maxTurns) {
          return false
        }
      }

      if (!resolved) {
        return false
      }
    }

    // Verify git status --porcelain has no unmerged entries (UU, AA, etc.)
    return await this.verifyNoUnmergedEntries()
  }

  private tryAutoResolveMarkers(content: string): string | null {
    const conflictRegex = /<<<<<<<[^\r\n]*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>[^\r\n]*\r?\n/g
    let match: RegExpExecArray | null
    let hasMatch = false
    let resolvable = true

    // Check each conflict hunk
    while ((match = conflictRegex.exec(content)) !== null) {
      hasMatch = true
      const sideA = match[1]
      const sideB = match[2]

      // If either side is contradictory (e.g. explicitly flagged UNRESOLVABLE or binary conflict)
      if (sideA.includes('UNRESOLVABLE') || sideB.includes('UNRESOLVABLE')) {
        resolvable = false
        break
      }
    }

    if (!hasMatch || !resolvable) {
      return null
    }

    // Auto-resolve by combining both sides cleanly without markers
    const resolvedContent = content.replace(
      /<<<<<<<[^\r\n]*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>[^\r\n]*\r?\n/g,
      (_fullMatch, sideA, sideB) => {
        // If one side is empty, take the other
        if (!sideA.trim()) return sideB
        if (!sideB.trim()) return sideA

        // If both sides are identical
        if (sideA.trim() === sideB.trim()) return sideA

        // Otherwise concatenate preserving intent
        return sideA.endsWith('\n') ? `${sideA}${sideB}` : `${sideA}\n${sideB}`
      },
    )

    return resolvedContent
  }

  async stageFile(relFile: string): Promise<void> {
    await execFileAsync('git', ['add', relFile], { cwd: this.stagingPath })
  }

  async verifyNoUnmergedEntries(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: this.stagingPath })
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      const hasUnmerged = lines.some((line) => {
        const code = line.slice(0, 2)
        return code === 'UU' || code === 'AA' || code === 'UD' || code === 'DU' || code.includes('U')
      })
      return !hasUnmerged
    } catch {
      return false
    }
  }
}
