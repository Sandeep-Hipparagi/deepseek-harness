import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { Context, Service } from 'cordis'

export interface TaskRecord {
  id: string
  parent_task_id?: string | null
  worker_id?: string | null
  lease_expires_at?: string | null
  retry_count: number
  status: 'pending' | 'running' | 'suspended_waiting_user' | 'verifying' | 'completed' | 'failed' | 'cancelled'
  failure_reason?: string | null
  instruction: string
  worktree_path: string
  git_branch: string
  base_commit_hash: string
  max_turns: number
  current_turn: number
  total_prompt_tokens: number
  total_completion_tokens: number
  cumulative_cost_usd: number
  latest_context_summary?: string | null
  created_at?: string
  updated_at?: string
}

export interface ReconciliationRecord {
  id: string
  task_id: string
  branch_name: string
  target_branch: string
  test_command?: string | null
  queue_status: 'queued' | 'processing' | 'merged' | 'failed' | 'conflict_escalated'
  resolver_attempts: number
  queued_at?: string
  resolved_at?: string | null
}

export interface WorkspaceAllocationRecord {
  id: string
  task_id: string
  allocation_state: 'intending' | 'allocated' | 'pruned'
  worktree_path: string
  created_at?: string
  cleaned_up_at?: string | null
}

declare module 'cordis' {
  interface Context {
    a3hStorage: StorageService
  }
}

export class StorageService extends Service {
  public db!: DatabaseSync
  public dbPath: string

  constructor(ctx: Context, config?: string | { path?: string }) {
    super(ctx, 'a3hStorage', true)
    if (typeof config === 'string') {
      this.dbPath = config
    } else if (config && typeof config.path === 'string') {
      this.dbPath = config.path
    } else {
      this.dbPath = path.resolve('.a3h-data/a3h.sqlite')
    }
    this.initDb()
  }

  private initDb() {
    if (!this.db) {
      const dbDir = path.dirname(this.dbPath)
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

      this.db = new DatabaseSync(this.dbPath)
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA busy_timeout = 5000;')
      this.db.exec('PRAGMA synchronous = NORMAL;')
      this.initSchema()
    }
  }

  // Safe wrapper to prevent undefined prepare calls
  public prepare(sql: string) {
    this.initDb()
    if (!this.db) {
      throw new Error(`Failed to initialize SQLite database at ${this.dbPath}`)
    }
    return this.db.prepare(sql)
  }

  public ensureDatabase(): DatabaseSync {
    this.initDb()
    return this.db
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT,
        file_path TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT,
        worker_id TEXT,
        lease_expires_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'running', 'suspended_waiting_user',
          'verifying', 'completed', 'failed', 'cancelled'
        )),
        failure_reason TEXT,
        instruction TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        base_commit_hash TEXT NOT NULL,
        max_turns INTEGER DEFAULT 30,
        current_turn INTEGER DEFAULT 0,
        total_prompt_tokens INTEGER DEFAULT 0,
        total_completion_tokens INTEGER DEFAULT 0,
        cumulative_cost_usd REAL DEFAULT 0.0,
        latest_context_summary TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS turn_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        turn_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        output TEXT,
        exit_code INTEGER,
        execution_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        artifact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reconciliation_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'master',
        test_command TEXT,
        queue_status TEXT NOT NULL CHECK(queue_status IN (
          'queued', 'processing', 'merged', 'failed', 'conflict_escalated'
        )),
        resolver_attempts INTEGER DEFAULT 0,
        queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workspace_allocations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        allocation_state TEXT NOT NULL CHECK(allocation_state IN ('intending', 'allocated', 'pruned')),
        worktree_path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cleaned_up_at TIMESTAMP
      );
    `)
  }

  createTask(task: Omit<TaskRecord, 'retry_count' | 'current_turn' | 'total_prompt_tokens' | 'total_completion_tokens' | 'cumulative_cost_usd' | 'max_turns'> & Partial<TaskRecord>): TaskRecord {
    const record: TaskRecord = {
      id: task.id,
      parent_task_id: task.parent_task_id ?? null,
      worker_id: task.worker_id ?? null,
      lease_expires_at: task.lease_expires_at ?? null,
      retry_count: task.retry_count ?? 0,
      status: task.status,
      failure_reason: task.failure_reason ?? null,
      instruction: task.instruction,
      worktree_path: task.worktree_path ?? null,
      git_branch: task.git_branch ?? null,
      base_commit_hash: task.base_commit_hash ?? null,
      max_turns: task.max_turns ?? 30,
      current_turn: task.current_turn ?? 0,
      total_prompt_tokens: task.total_prompt_tokens ?? 0,
      total_completion_tokens: task.total_completion_tokens ?? 0,
      cumulative_cost_usd: task.cumulative_cost_usd ?? 0.0,
      latest_context_summary: task.latest_context_summary ?? null,
    }

    const stmt = this.prepare(`
      INSERT INTO tasks (
        id, parent_task_id, worker_id, lease_expires_at, retry_count, status,
        failure_reason, instruction, worktree_path, git_branch, base_commit_hash,
        max_turns, current_turn, total_prompt_tokens, total_completion_tokens,
        cumulative_cost_usd, latest_context_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      record.id,
      record.parent_task_id,
      record.worker_id,
      record.lease_expires_at,
      record.retry_count,
      record.status,
      record.failure_reason,
      record.instruction,
      record.worktree_path,
      record.git_branch,
      record.base_commit_hash,
      record.max_turns,
      record.current_turn,
      record.total_prompt_tokens,
      record.total_completion_tokens,
      record.cumulative_cost_usd,
      record.latest_context_summary,
    )

    return record
  }

  getTask(id: string): TaskRecord | null {
    const stmt = this.prepare('SELECT * FROM tasks WHERE id = ?')
    const row = stmt.get(id) as unknown as TaskRecord | undefined
    return row ?? null
  }

  listTasks(limit = 50): TaskRecord[] {
    const stmt = this.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
    return stmt.all(limit) as unknown as TaskRecord[]
  }

  updateTask(id: string, updates: Partial<TaskRecord>) {
    const keys = Object.keys(updates).filter(k => k !== 'id' && (updates as any)[k] !== undefined)
    if (keys.length === 0) return

    const setClauses = keys.map(k => `${k} = ?`).join(', ')
    const values = keys.map((k) => {
      const val = (updates as any)[k]
      return val === undefined ? null : val
    })

    const stmt = this.prepare(`
      UPDATE tasks
      SET ${setClauses}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    stmt.run(...values, id)
  }

  saveArtifact(id: string, taskId: string, artifactType: string, content: string) {
    const stmt = this.prepare(`
      INSERT INTO artifacts (id, task_id, artifact_type, content)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(id, taskId, artifactType, content)
  }

  getArtifacts(taskId: string): Array<{ id: string; artifact_type: string; content: string }> {
    const stmt = this.prepare('SELECT id, artifact_type, content FROM artifacts WHERE task_id = ?')
    return stmt.all(taskId) as unknown as Array<{ id: string; artifact_type: string; content: string }>
  }

  enqueueReconciliation(record: ReconciliationRecord): ReconciliationRecord {
    const stmt = this.prepare(`
      INSERT INTO reconciliation_queue (
        id, task_id, branch_name, target_branch, test_command, queue_status, resolver_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.task_id,
      record.branch_name,
      record.target_branch,
      record.test_command ?? null,
      record.queue_status,
      record.resolver_attempts,
    )
    return record
  }

  getNextQueuedReconciliation(): ReconciliationRecord | null {
    const stmt = this.prepare(`
      SELECT * FROM reconciliation_queue
      WHERE queue_status = 'queued'
      ORDER BY queued_at ASC
      LIMIT 1
    `)
    const row = stmt.get() as unknown as ReconciliationRecord | undefined
    return row ?? null
  }

  getReconciliation(id: string): ReconciliationRecord | null {
    const stmt = this.prepare('SELECT * FROM reconciliation_queue WHERE id = ?')
    const row = stmt.get(id) as unknown as ReconciliationRecord | undefined
    return row ?? null
  }

  getReconciliationByTaskId(taskId: string): ReconciliationRecord | null {
    const stmt = this.prepare(`
      SELECT * FROM reconciliation_queue WHERE task_id = ? ORDER BY queued_at DESC LIMIT 1
    `)
    const row = stmt.get(taskId) as unknown as ReconciliationRecord | undefined
    return row ?? null
  }

  updateReconciliation(id: string, updates: Partial<ReconciliationRecord>) {
    const keys = Object.keys(updates).filter(k => k !== 'id')
    if (keys.length === 0) return

    const setClauses = keys.map(k => `${k} = ?`).join(', ')
    const values = keys.map(k => (updates as any)[k])

    const stmt = this.prepare(`
      UPDATE reconciliation_queue
      SET ${setClauses}
      WHERE id = ?
    `)
    stmt.run(...values, id)
  }

  listReconciliations(): ReconciliationRecord[] {
    const stmt = this.prepare('SELECT * FROM reconciliation_queue ORDER BY queued_at ASC')
    return stmt.all() as unknown as ReconciliationRecord[]
  }

  getExpiredRunningTasks(cutoffIso: string): TaskRecord[] {
    const stmt = this.prepare(`
      SELECT * FROM tasks
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ?
    `)
    return stmt.all(cutoffIso) as unknown as TaskRecord[]
  }

  createAllocation(record: WorkspaceAllocationRecord): WorkspaceAllocationRecord {
    const stmt = this.prepare(`
      INSERT INTO workspace_allocations (id, task_id, allocation_state, worktree_path)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(record.id, record.task_id, record.allocation_state, record.worktree_path)
    return record
  }

  getDeadAllocations(cutoffIso: string): WorkspaceAllocationRecord[] {
    const stmt = this.prepare(`
      SELECT * FROM workspace_allocations
      WHERE allocation_state = 'intending'
        AND created_at < ?
    `)
    return stmt.all(cutoffIso) as unknown as WorkspaceAllocationRecord[]
  }

  updateAllocationState(id: string, state: 'intending' | 'allocated' | 'pruned'): void {
    const stmt = this.prepare(`
      UPDATE workspace_allocations
      SET allocation_state = ?, cleaned_up_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    stmt.run(state, id)
  }

  recordToolExecution(
    id: string,
    taskId: string,
    toolName: string,
    args: Record<string, any>,
    output?: string,
    exitCode?: number,
    durationMs?: number,
  ): void {
    const stmt = this.prepare(`
      INSERT INTO tool_executions (id, task_id, tool_name, arguments, output, exit_code, execution_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      taskId,
      toolName,
      JSON.stringify(args),
      output ?? null,
      exitCode ?? null,
      durationMs ?? null,
    )
  }

  recordTurnLog(
    taskId: string,
    turnNumber: number,
    role: string,
    content?: string,
    toolCalls?: any,
  ): void {
    const stmt = this.prepare(`
      INSERT INTO turn_logs (task_id, turn_number, role, content, tool_calls)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      taskId,
      turnNumber,
      role,
      content ?? null,
      toolCalls ? JSON.stringify(toolCalls) : null,
    )
  }

  close() {
    if (this.db) {
      this.db.close()
      this.db = undefined as any
    }
  }
}

export { StorageService as TaskStorage }
