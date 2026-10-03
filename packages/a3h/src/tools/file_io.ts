import fs from 'node:fs/promises'
import path from 'node:path'

export interface ReadRangeArgs {
  filePath: string
  startLine: number
  endLine: number
}

export async function readFileRange(worktreeRoot: string, args: ReadRangeArgs): Promise<string> {
  const resolved = path.resolve(worktreeRoot, args.filePath)

  // Boundary check: Path sandboxing (case-normalized for Windows compatibility)
  let realRoot: string
  try {
    realRoot = await fs.realpath(worktreeRoot)
  } catch {
    realRoot = path.resolve(worktreeRoot)
  }
  let realTarget: string
  try {
    realTarget = await fs.realpath(resolved)
  } catch {
    realTarget = resolved
  }

  const normRoot = path.normalize(realRoot).toLowerCase()
  const normTarget = path.normalize(realTarget).toLowerCase()

  if (!normTarget.startsWith(normRoot)) {
    throw new Error(`Access denied: Path "${args.filePath}" outside assigned worktree "${worktreeRoot}".`)
  }

  const span = args.endLine - args.startLine + 1
  if (span > 120) {
    throw new Error(`Requested span of ${span} lines exceeds the maximum limit of 120 lines per read.`)
  }

  try {
    const content = await fs.readFile(resolved, 'utf-8')
    const lines = content.split('\n')

    const selected = lines.slice(Math.max(0, args.startLine - 1), args.endLine)
    return selected
      .map((line, idx) => `${args.startLine + idx} | ${line}`)
      .join('\n')
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Target file "${args.filePath}" not found in workspace "${worktreeRoot}". Please verify the workspace path or target file location.`)
    }
    throw err
  }
}

export interface ApplyPatchArgs {
  filePath: string
  targetContent: string
  replacementContent: string
}

export async function applyTargetedPatch(
  worktreeRoot: string,
  args: ApplyPatchArgs,
): Promise<{ success: boolean; message: string }> {
  const resolved = path.resolve(worktreeRoot, args.filePath)
  let realRoot: string
  try {
    realRoot = await fs.realpath(worktreeRoot)
  } catch {
    realRoot = path.resolve(worktreeRoot)
  }
  const normRoot = path.normalize(realRoot).toLowerCase()
  const normTarget = path.normalize(resolved).toLowerCase()

  if (!normTarget.startsWith(normRoot)) {
    throw new Error(`Access denied: Path "${args.filePath}" outside assigned worktree "${worktreeRoot}".`)
  }

  let content: string
  try {
    content = await fs.readFile(resolved, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Target file "${args.filePath}" not found in workspace "${worktreeRoot}". Please verify the workspace path or target file location.`)
    }
    throw err
  }
  if (!content.includes(args.targetContent)) {
    throw new Error(`Target content not found in ${args.filePath}`)
  }

  const updated = content.replace(args.targetContent, args.replacementContent)
  await fs.writeFile(resolved, updated, 'utf-8')
  return { success: true, message: `Successfully patched ${args.filePath}` }
}
