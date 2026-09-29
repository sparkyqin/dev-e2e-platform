import path from 'node:path'
import { promises as fs } from 'node:fs'
import type {
  EventActor,
  EventFilter,
  JourneyEntry,
  SemanticEvent,
  SemanticEventKind,
  SemanticEventPayloadMap,
  StageId,
  TaskState,
} from '@ai-platform/shared'
import { KeyedMutex, writeJson, readJson } from './util.js'
import { AuditLog, EventLog, type AuditEntry } from './event-log.js'

/**
 * 存储后端抽象（[机-一处真源]：状态/事件/审计的真源可切换）
 *
 * - 文件后端（默认）：`data/runtime/tasks/<id>/.flow/{state.json, events.jsonl, audit.jsonl}`
 * - PG 后端：`DATABASE_URL` 启用（ai_tasks / ai_events / ai_audit 表），跨进程 advisory lock 串行
 * - 工作区（git 仓库 / 产物 / 派生缓存）始终在文件系统：引擎与工具链天然面向文件
 *
 * 语义契约（两后端必须等价，由全量 e2e 即契约测试保证）：
 * - mutate：按任务串行 + 乐观锁版本校验（先到先得，后者 409 知情）
 * - events/audit：append-only、单调 seq、按 (task_id, seq) 有序回放
 */

/** 绑定到单个任务的语义事件流（文件 JSONL 或 PG 行集） */
export interface IEventLog {
  append<K extends SemanticEventKind>(
    taskId: string,
    stage: StageId,
    actor: EventActor,
    kind: K,
    payload: SemanticEventPayloadMap[K],
  ): Promise<SemanticEvent>
  read(filter?: EventFilter): Promise<SemanticEvent[]>
  lastSeq(): Promise<number>
  journey(limit?: number): Promise<JourneyEntry[]>
}

/** 绑定到单个任务的审计留痕 */
export interface IAuditLog {
  append(entry: AuditEntry): Promise<void>
  read(): Promise<AuditEntry[]>
}

export interface StorageBackend {
  init(): Promise<void>
  close(): Promise<void>
  /** 读状态；不存在返回 null */
  load(taskId: string): Promise<TaskState | null>
  /** 覆盖式保存（upsert；调用方负责在锁内做版本语义） */
  save(taskId: string, state: TaskState): Promise<void>
  /** 全量状态（按 seq 升序） */
  list(): Promise<TaskState[]>
  /** 按任务串行化临界区（文件=进程内互斥；PG=跨进程 advisory lock） */
  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T>
  eventLogFor(taskId: string): IEventLog
  auditLogFor(taskId: string): IAuditLog
}

/** 文件后端：现状行为原样抽离（原子写 + KeyedMutex 串行） */
export class FileBackend implements StorageBackend {
  private mutex = new KeyedMutex()

  constructor(private tasksDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true })
  }

  async close(): Promise<void> {}

  private statePath(taskId: string): string {
    return path.join(this.tasksDir, taskId, '.flow', 'state.json')
  }

  async load(taskId: string): Promise<TaskState | null> {
    try {
      return await readJson<TaskState>(this.statePath(taskId))
    } catch (err) {
      // 真源损坏 ≠ 不存在：告警一次（带侧车取证路径），返回 null 让调用方按"任务不可载"处置，
      // 不让异常在 tick/调度链路上连环炸（runner 对 load null 已有静默退出语义，但此处已留痕）
      const e = err as { name?: string; message?: string }
      // eslint-disable-next-line no-console
      console.error(`[store] 任务真源损坏（已保全原文到 .corrupt 侧车，请人工介入）：${this.statePath(taskId)} —— ${e.message}`)
      return null
    }
  }

  async save(taskId: string, state: TaskState): Promise<void> {
    await writeJson(this.statePath(taskId), state)
  }

  async list(): Promise<TaskState[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.tasksDir, { withFileTypes: true })
    } catch {
      return []
    }
    const states: TaskState[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const s = await this.load(e.name)
      if (s) states.push(s)
    }
    return states.sort((a, b) => a.seq - b.seq)
  }

  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(taskId, fn)
  }

  eventLogFor(taskId: string): IEventLog {
    return new EventLog(path.join(this.tasksDir, taskId, '.flow', 'events.jsonl'))
  }

  auditLogFor(taskId: string): IAuditLog {
    return new AuditLog(path.join(this.tasksDir, taskId, '.flow', 'audit.jsonl'))
  }
}
