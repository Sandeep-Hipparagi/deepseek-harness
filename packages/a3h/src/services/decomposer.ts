import { Context, Service } from 'cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SubTaskNode {
  id: string
  title: string
  instruction: string
  targetFiles: string[]
  testCommand?: string
  dependsOn: string[] // IDs of parent tasks that must merge before this task starts
  status?: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

export interface ExecutionDAG {
  specification: string // Markdown RFC explaining architectural decisions
  tasks: SubTaskNode[]
}

export interface DAGExecutionResult {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  cancelledTasks: number
  taskResults: Record<string, { status: SubTaskNode['status']; error?: string }>
  success: boolean
}

declare module 'cordis' {
  interface Context {
    a3hDecomposer: DecomposerService
  }
  interface Events {
    'a3h/dag-node-ready'(evt: { taskId: string }): void
    'a3h/dag-node-cancelled'(evt: { taskId: string; reason: string }): void
    'a3h/dag-completed'(evt: { success: boolean }): void
  }
}

export class DecomposerService extends Service {
  static inject = {
    a3hStorage: { required: true },
    a3hSandbox: { required: true },
    a3hVerification: { required: true },
    a3hReconciliation: { required: true },
    a3hWorker: { required: true },
    a3hMemory: { required: false },
  }

  constructor(ctx: Context) {
    super(ctx, 'a3hDecomposer', true)
  }

  async decomposeMacro(instruction: string, context?: { repoRoot?: string }): Promise<ExecutionDAG> {
    // 1. Analyze repository context
    let repoLearnings = ''
    if (this.ctx.a3hMemory) {
      try {
        const mem = await this.ctx.a3hMemory.getRepoMemory(context?.repoRoot)
        repoLearnings = mem.rawLearningsMarkdown
      } catch {}
    }

    // 2. Deterministic architectural decomposition of macro instruction
    const lower = instruction.toLowerCase()
    const tasks: SubTaskNode[] = []
    let specMarkdown = `# Architecture RFC & Execution DAG: ${instruction}\n\n`

    if (lower.includes('auth') || lower.includes('migrate') || lower.includes('modularize') || lower.includes('refactor')) {
      specMarkdown += `## Objective\nPerform modular architectural update for: ${instruction}\n\n`
      specMarkdown += '## DAG Phasing Plan\n'
      specMarkdown += '- **Phase 1 (Parallel Independent)**: Core models and helper modules.\n'
      specMarkdown += '- **Phase 2 (Parallel Independent)**: Middleware and adapters.\n'
      specMarkdown += '- **Phase 3 (Dependent Sequence)**: Endpoint integration and end-to-end verification.\n\n'

      const id1 = `dag_sub_${Date.now().toString(36)}_1`
      const id2 = `dag_sub_${Date.now().toString(36)}_2`
      const id3 = `dag_sub_${Date.now().toString(36)}_3`

      tasks.push({
        id: id1,
        title: 'Core Schema & Data Models',
        instruction: 'Implement core types and validation schemas for updated service.',
        targetFiles: ['src/models/core.ts'],
        dependsOn: [],
        status: 'pending',
      })

      tasks.push({
        id: id2,
        title: 'Adapter & Token Helpers',
        instruction: 'Implement helper utilities and token verification adapters.',
        targetFiles: ['src/utils/adapters.ts'],
        dependsOn: [],
        status: 'pending',
      })

      tasks.push({
        id: id3,
        title: 'API Integration & Route Wire-up',
        instruction: 'Integrate core schema and token helpers into API routes and verify suite.',
        targetFiles: ['src/routes/api.ts'],
        dependsOn: [id1, id2],
        status: 'pending',
      })
    } else {
      // Default decomposition: split into implementation and integration test
      specMarkdown += `## Objective\nDecomposed execution plan for: ${instruction}\n\n`

      const id1 = `dag_sub_${Date.now().toString(36)}_1`
      const id2 = `dag_sub_${Date.now().toString(36)}_2`

      tasks.push({
        id: id1,
        title: 'Feature Implementation',
        instruction: `Implement core logic for: ${instruction}`,
        targetFiles: ['src/feature.ts'],
        dependsOn: [],
        status: 'pending',
      })

      tasks.push({
        id: id2,
        title: 'Integration Test Suite',
        instruction: `Implement automated test coverage and assertions for: ${instruction}`,
        targetFiles: ['test/feature.spec.ts'],
        dependsOn: [id1],
        status: 'pending',
      })
    }

    return {
      specification: specMarkdown,
      tasks,
    }
  }

  async executeDAG(
    dag: ExecutionDAG,
    targetBranch?: string,
    taskExecutor?: (task: SubTaskNode, worktreePath: string) => Promise<boolean>,
  ): Promise<DAGExecutionResult> {
    let effectiveBranch = targetBranch
    if (!effectiveBranch || effectiveBranch === 'main') {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
        const current = stdout.trim()
        if (targetBranch === 'main') {
          try {
            await execFileAsync('git', ['rev-parse', '--verify', 'main'])
            effectiveBranch = 'main'
          } catch {
            effectiveBranch = current || 'master'
          }
        } else {
          effectiveBranch = current || 'master'
        }
      } catch {
        effectiveBranch = targetBranch || 'master'
      }
    }

    const nodeMap = new Map<string, SubTaskNode>()
    for (const task of dag.tasks) {
      nodeMap.set(task.id, { ...task, status: 'pending' })
    }

    const completed = new Set<string>()
    const failed = new Set<string>()
    const cancelled = new Set<string>()
    const running = new Set<string>()

    const checkAndCascadeCancellations = () => {
      let changed = false
      for (const [id, node] of nodeMap.entries()) {
        if (node.status === 'pending' || node.status === 'ready') {
          const hasFailedParent = node.dependsOn.some(parentId => failed.has(parentId) || cancelled.has(parentId))
          if (hasFailedParent) {
            node.status = 'cancelled'
            node.error = 'Upstream parent task failed or cancelled'
            cancelled.add(id)
            changed = true
            this.ctx.emit('a3h/dag-node-cancelled', { taskId: id, reason: node.error })
          }
        }
      }
      return changed
    }

    while (completed.size + failed.size + cancelled.size < dag.tasks.length) {
      checkAndCascadeCancellations()

      // Find all ready nodes whose dependencies are all completed and not running
      const readyNodes: SubTaskNode[] = []
      for (const [id, node] of nodeMap.entries()) {
        if (node.status === 'pending') {
          const allDepsCompleted = node.dependsOn.every(depId => completed.has(depId))
          if (allDepsCompleted) {
            node.status = 'ready'
            readyNodes.push(node)
          }
        }
      }

      if (readyNodes.length === 0 && running.size === 0) {
        // No tasks can make progress - dead end or cycle
        break
      }

      // Dispatch ready nodes concurrently
      const dispatchPromises = readyNodes.map(async (node) => {
        node.status = 'running'
        running.add(node.id)

        try {
          const wtPath = await this.ctx.a3hSandbox.allocate(node.id, effectiveBranch)
          let taskPassed = true

          if (taskExecutor) {
            taskPassed = await taskExecutor(node, wtPath)
          }

          if (taskPassed) {
            // Reconcile and land onto target branch
            const queueId = await this.ctx.a3hReconciliation.enqueueTask(
              node.id,
              `feature/task-${node.id}`,
              effectiveBranch,
              node.testCommand,
            )

            // Wait for landing
            await this.ctx.a3hReconciliation.processQueue()
            const rec = this.ctx.a3hStorage.getReconciliation(queueId)

            if (rec?.queue_status === 'merged') {
              node.status = 'completed'
              completed.add(node.id)
            } else {
              node.status = 'failed'
              node.error = `Reconciliation failed with status: ${rec?.queue_status}`
              failed.add(node.id)
            }
          } else {
            node.status = 'failed'
            node.error = 'Task executor returned failure'
            failed.add(node.id)
          }
        } catch (err: any) {
          node.status = 'failed'
          node.error = err.message
          failed.add(node.id)
        } finally {
          running.delete(node.id)
          try {
            await this.ctx.a3hSandbox.cleanup(node.id)
          } catch {}
        }
      })

      await Promise.all(dispatchPromises)
    }

    // Final check for remaining pending
    checkAndCascadeCancellations()

    const taskResults: Record<string, { status: SubTaskNode['status']; error?: string }> = {}
    for (const [id, node] of nodeMap.entries()) {
      taskResults[id] = { status: node.status, error: node.error }
    }

    const success = failed.size === 0 && cancelled.size === 0
    this.ctx.emit('a3h/dag-completed', { success })

    return {
      totalTasks: dag.tasks.length,
      completedTasks: completed.size,
      failedTasks: failed.size,
      cancelledTasks: cancelled.size,
      taskResults,
      success,
    }
  }
}
