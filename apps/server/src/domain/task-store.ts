import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { TaskState } from '@ai-platform/shared'
import { atomicWrite, nowIso } from './util.js'
import { FileBackend, type IAuditLog, type IEventLog, type StorageBackend } from './store-backend.js'

/**
 * 任务真源存储（[机-一处真源] / [机-文件状态机] / 乐观锁）
 *
 * 阶段真相唯一来源 = 存储后端中的任务状态（文件后端：`data/runtime/tasks/<taskId>/.flow/state.json`；
 * PG 后端：ai_tasks.state）。所有变更经 mutate()：按任务串行 + 校验乐观锁版本（先到先得，后者 409 知情）
 * → 变更 → 版本 +1 → 落盘。内存 / 投影 / 前端皆为只读副本。
 *
 * 工作区（git 仓库 / 产物 / 派生缓存）始终在文件系统；本类同时提供工作区路径与产物读写。
 */

export class VersionConflictError extends Error {
  constructor(
    public expected: number,
    public current: number,
  ) {
    super(`state_version 冲突：期望 ${expected}，当前 ${current}（先到先得，后者知情）`)
    this.name = 'VersionConflictError'
  }
}

export class TaskNotFoundError extends Error {
  constructor(public taskId: string) {
    super(`任务不存在：${taskId}`)
    this.name = 'TaskNotFoundError'
  }
}

export interface MutateOptions {
  /** 乐观锁校验；null 表示创建（不校验） */
  expectedVersion: number | null
  /** 变更说明（审计留痕） */
  audit?: { actor: string; actorName: string; action: string; detail?: Record<string, unknown> }
}

export class TaskStore {
  private backend: StorageBackend
  /** 状态写穿回调（投影 write-through） */
  onWrite: ((state: TaskState) => void) | null = null

  constructor(tasksDir: string, backend?: StorageBackend) {
    this.tasksDir = tasksDir
    this.backend = backend ?? new FileBackend(tasksDir)
  }

  private readonly tasksDir: string

  async init(): Promise<void> {
    await this.backend.init()
  }

  async close(): Promise<void> {
    await this.backend.close()
  }

  taskDir(taskId: string): string {
    return path.join(this.tasksDir, taskId)
  }

  flowDir(taskId: string): string {
    return path.join(this.taskDir(taskId), '.flow')
  }

  statePath(taskId: string): string {
    return path.join(this.flowDir(taskId), 'state.json')
  }

  eventLog(taskId: string): IEventLog {
    return this.backend.eventLogFor(taskId)
  }

  auditLog(taskId: string): IAuditLog {
    return this.backend.auditLogFor(taskId)
  }

  async exists(taskId: string): Promise<boolean> {
    return (await this.backend.load(taskId)) !== null
  }

  async load(taskId: string): Promise<TaskState> {
    const state = await this.backend.load(taskId)
    if (!state) throw new TaskNotFoundError(taskId)
    return state
  }

  async loadOrNull(taskId: string): Promise<TaskState | null> {
    return this.backend.load(taskId)
  }

  async listAll(): Promise<TaskState[]> {
    return this.backend.list()
  }

  /**
   * 乐观锁变更入口：串行化 + 版本校验 + 版本推进 + 落盘 + 投影 write-through。
   */
  async mutate<T>(
    taskId: string,
    opts: MutateOptions,
    fn: (state: TaskState) => T | Promise<T>,
  ): Promise<{ state: TaskState; result: T }> {
    return this.backend.withLock(taskId, async () => {
      const current = await this.backend.load(taskId)
      if (!current) throw new TaskNotFoundError(taskId)
      if (opts.expectedVersion !== null && opts.expectedVersion !== current.stateVersion) {
        throw new VersionConflictError(opts.expectedVersion, current.stateVersion)
      }
      const result = await fn(current)
      current.updatedAt = nowIso()
      current.stateVersion += 1
      await this.backend.save(taskId, current)
      if (opts.audit) {
        await this.auditLog(taskId).append({ ts: nowIso(), ...opts.audit, detail: opts.audit.detail ?? {} })
      }
      this.onWrite?.(current)
      return { state: current, result }
    })
  }

  /** 创建任务真源（不经乐观锁；与文件行为一致 = upsert） */
  async create(state: TaskState): Promise<TaskState> {
    await this.backend.save(state.taskId, state)
    this.onWrite?.(state)
    return state
  }

  /** 覆盖式保存（恢复/归档等平台内部操作，仍走串行化） */
  async saveRaw(state: TaskState): Promise<TaskState> {
    return this.backend.withLock(state.taskId, async () => {
      state.updatedAt = nowIso()
      await this.backend.save(state.taskId, state)
      this.onWrite?.(state)
      return state
    })
  }

  async readArtifact(taskId: string, relPath: string): Promise<string | null> {
    const root = path.normalize(this.taskDir(taskId)) + path.sep
    const norm = path.normalize(path.join(this.taskDir(taskId), relPath))
    // 分区白名单内才可读（防越界；带分隔符前缀，避免 task-1 匹配 task-10 的前缀歧义）
    if (!norm.startsWith(root)) return null
    try {
      return await fs.readFile(norm, 'utf8')
    } catch {
      return null
    }
  }

  async writeArtifact(taskId: string, relPath: string, content: string): Promise<void> {
    const full = path.join(this.taskDir(taskId), relPath)
    await atomicWrite(full, content)
  }
}
