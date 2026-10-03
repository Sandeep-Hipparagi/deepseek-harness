export * from './file_io.js'
export * from './outline.js'
export * from './datetime.js'
import { registerDateTimeTool } from './datetime.js'
import type { Context } from 'cordis'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required: string[]
  }
}

export const NAVIGATION_TOOLS: ToolDefinition[] = [
  {
    name: 'get_file_outline',
    description: 'Returns the structural outline and symbol declarations (classes, methods, functions, interfaces) with line numbers of a source file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the source file within the worktree.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'find_symbol_references',
    description: 'Finds all usages, call sites, and references of a symbol across the entire worktree to prevent blast radius blind spots.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, class, type, or identifier to locate.',
        },
        originFile: {
          type: 'string',
          description: 'Optional path to the file where the symbol was modified.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'find_symbol_definition',
    description: 'Locates the exact declaration and definition site of a symbol across the worktree.',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, class, type, or identifier to locate.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'read_file_range',
    description: 'Reads a windowed line range from a file with line numbers (maximum 120 lines per read).',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file within the worktree.',
        },
        startLine: {
          type: 'integer',
          description: '1-indexed starting line number.',
        },
        endLine: {
          type: 'integer',
          description: '1-indexed ending line number (span must be <= 120 lines).',
        },
      },
      required: ['filePath', 'startLine', 'endLine'],
    },
  },
  {
    name: 'apply_targeted_patch',
    description: 'Replaces an exact target snippet with replacement content in a file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file.',
        },
        targetContent: {
          type: 'string',
          description: 'Exact string to be replaced.',
        },
        replacementContent: {
          type: 'string',
          description: 'Content to replace with.',
        },
      },
      required: ['filePath', 'targetContent', 'replacementContent'],
    },
  },
]

function safeLogTelemetry(ctx: Context, toolName: string, targetPath: string) {
  const storage = typeof (ctx as any).get === 'function' ? (ctx as any).get('a3hStorage') : undefined
  const db = storage?.db || storage
  if (db && typeof db.prepare === 'function') {
    try {
      const stmt = db.prepare(
        'INSERT INTO telemetry_events (tool_name, file_path, timestamp) VALUES (?, ?, ?)',
      )
      stmt.run(toolName, targetPath, new Date().toISOString())
    } catch (err) {
      // Suppress telemetry logging error to preserve tool execution
    }
  }
}

export function registerA3HTools(ctx: Context) {
  const toolsService = typeof (ctx as any).get === 'function'
    ? ((ctx as any).get('tools') || (ctx as any).tools)
    : (ctx as any).tools
  if (!toolsService || typeof toolsService.register !== 'function') return

  toolsService.register({
    name: 'readFileRange',
    description: 'Reads a windowed line range from a file within the A3H sandboxed worktree (max 120 lines).',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path.' },
        startLine: { type: 'integer', description: '1-indexed starting line number.' },
        endLine: { type: 'integer', description: '1-indexed ending line number.' },
        worktreePath: { type: 'string', description: 'Optional explicit worktree or repository root path.' },
      },
      required: ['filePath', 'startLine', 'endLine'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      // 1. Resolve worktree path
      const workspace = ctx.get('workspace') as any
      const targetWorktree = args.worktreePath || workspace?.current?.path || process.cwd()
      const fullPath = path.resolve(targetWorktree, args.filePath)

      if (!fs.existsSync(fullPath)) {
        return { error: `File not found at ${fullPath}` }
      }

      // 2. Read lines
      const content = fs.readFileSync(fullPath, 'utf8')
      const lines = content.split(/\r?\n/)
      const sliced = lines.slice(Math.max(0, args.startLine - 1), args.endLine)

      // 3. Log telemetry safely if storage exists (do not crash if undefined)
      safeLogTelemetry(ctx, 'readFileRange', args.filePath)

      return {
        lines: sliced,
        totalLines: lines.length,
        startLine: args.startLine,
        endLine: Math.min(args.endLine, lines.length),
        preview: sliced.map((line: string, idx: number) => `${args.startLine + idx} | ${line}`).join('\n'),
      }
    },
  })

  toolsService.register({
    name: 'applyTargetedPatch',
    description: 'Applies an exact targeted snippet replacement inside the A3H sandboxed worktree.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path.' },
        targetContent: { type: 'string', description: 'Exact string to be replaced.' },
        replacementContent: { type: 'string', description: 'Replacement string.' },
        worktreePath: { type: 'string', description: 'Optional explicit worktree or repository root path.' },
      },
      required: ['filePath', 'targetContent', 'replacementContent'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const workspace = ctx.get('workspace') as any
      const targetWorktree = args.worktreePath || workspace?.current?.path || process.cwd()
      const fullPath = path.resolve(targetWorktree, args.filePath)

      if (!fs.existsSync(fullPath)) {
        return { success: false, error: `File not found at ${fullPath}` }
      }

      const content = fs.readFileSync(fullPath, 'utf8')
      if (!content.includes(args.targetContent)) {
        return { success: false, error: `Target content not found in ${args.filePath}` }
      }

      const updated = content.replace(args.targetContent, args.replacementContent)
      fs.writeFileSync(fullPath, updated, 'utf8')

      safeLogTelemetry(ctx, 'applyTargetedPatch', args.filePath)

      return { success: true, message: `Successfully patched ${args.filePath}` }
    },
  })

  toolsService.register({
    name: 'decomposerSwarm',
    description: 'Decomposes a complex engineering instruction into a parallel DAG swarm with architectural verification.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Macro-instruction to decompose.' },
        baseBranch: { type: 'string', description: 'Base branch or commit hash.' },
      },
      required: ['instruction'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const decomposer = ctx.get('a3hDecomposer') as any
      if (!decomposer) {
        return { error: 'DecomposerService not loaded' }
      }
      safeLogTelemetry(ctx, 'decomposerSwarm', args.baseBranch || 'master')
      const dag = await decomposer.decomposeMacro(args.instruction)
      return await decomposer.executeDAG(dag, args.baseBranch || 'master')
    },
  })

  toolsService.register({
    name: 'chatopsAction',
    description: 'Interacts with A3H ChatOps review gateway to approve, reject, steer, or inspect suspended tasks.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to act on.' },
        action: { type: 'string', enum: ['approve', 'reject', 'steer'], description: 'Action to perform.' },
        feedback: { type: 'string', description: 'Feedback message for the agent.' },
      },
      required: ['taskId', 'action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const chatOps = ctx.get('a3hChatOps') as any
      if (!chatOps) {
        return { error: 'ChatOpsService not loaded' }
      }
      safeLogTelemetry(ctx, 'chatopsAction', args.taskId)
      return chatOps.handleAction(args)
    },
  })

  // Register deterministic datetime tool for local LLM temporal grounding
  registerDateTimeTool(ctx)
}
