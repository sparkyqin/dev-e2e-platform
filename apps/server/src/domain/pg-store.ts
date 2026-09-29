import { Pool } from 'pg'
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
import { nowIso } from './util.js'
import { KeyedMutex } from './util.js'
import { buildJourney, type AuditEntry } from './event-log.js'
import type { IAuditLog, IEventLog, StorageBackend } from './store-backend.js'

/**
 * PG 存储后端（生产真源：DATABASE_URL 启用）
 *
 * 表（schema 默认 public）：
 * - ai_tasks(task_id PK, seq, state jsonb, state_version, created_at, updated_at)
 * - ai_events(task_id, seq, ts, kind, stage, actor jsonb, payload jsonb, PK(task_id, seq))  — append-only
 * - ai_audit(task_id, seq, ts, actor, actor_name, action, detail jsonb, PK(task_id, seq)) — append-only
 *
 * 并发语义（与文件后端等价，跨进程成立）：
 * - 串行化：pg_advisory_lock(hashtext('<ns>:<taskId>')) 会话级互斥（ns = state/event/audit，
 *   命名空间隔离 → 同任务跨类别嵌套不死锁；连接断开 PG 自动释放）
 * - 事件/审计 append：锁内 MAX(seq)+1 → INSERT，保证 (task_id, seq) 单调无冲突
 * - 乐观锁：mutate 在锁内校验 state_version（先到先得，后者 409 知情）
 *
 * 验证：配 TEST_DATABASE_URL 时全量 e2e 跑本后端（每实例独立 schema）；
 * 本地无 PG 时用 pg-mem（内存 PG 模拟）跑同一 SQL 路径——advisory lock 为探测式：
 * 真实 PG 必可用；仅模拟后端不支持时降级进程内互斥（启动告警一次，绝不静默）。
 */

/** 结构化最小池接口（pg.Pool 与 pg-mem 测试桩皆满足） */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<unknown>; release(): void }>
  end(): Promise<unknown>
}

function qident(name: string): string {
  return `"${name.replace(/"/g, '')}"`
}

class PgCore {
  readonly pool: PgPoolLike
  readonly schema: string
  /** advisory lock 不可用（pg-mem 模拟）→ 进程内互斥兜底（真实 PG 不触发） */
  private lockFallback: boolean | null = null
  private jsMutex = new KeyedMutex()

  constructor(poolOrUrl: PgPoolLike | string, schema: string) {
    this.schema = schema
    this.pool =
      typeof poolOrUrl === 'string'
        ? new Pool({
            connectionString: poolOrUrl,
            max: 10,
            connectionTimeoutMillis: 10_000,
            options: `-c search_path=${schema}`,
          })
        : poolOrUrl
  }

  t(table: string): string {
    return `${qident(this.schema)}.${qident(table)}`
  }

  /**
   * 幂等 DDL：真实 PG 走 IF NOT EXISTS 正常路径；
   * pg-mem 重跑已存在表的 DDL 会抛「AST 未读部分」怪癖错误（表实际已建）——仅对该已知怪癖容错。
   */
  private async ensure(ddl: string): Promise<void> {
    try {
      await this.pool.query(ddl)
    } catch (e) {
      const msg = String((e as Error).message ?? '')
      if (/already exist|not supported/i.test(msg) && /AST/i.test(msg)) return
      if (/already exist/i.test(msg)) return
      throw e
    }
  }

  async init(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${qident(this.schema)}`)
    await this.ensure(`CREATE TABLE IF NOT EXISTS ${this.t('ai_tasks')} (
      task_id text PRIMARY KEY,
      seq bigint NOT NULL,
      state jsonb NOT NULL,
      state_version integer NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`)
    await this.ensure(`CREATE INDEX IF NOT EXISTS ${qident(`${this.schema}_ai_tasks_seq_idx`)} ON ${this.t('ai_tasks')} (seq)`)
    await this.ensure(`CREATE TABLE IF NOT EXISTS ${this.t('ai_events')} (
      task_id text NOT NULL,
      seq bigint NOT NULL,
      ts text NOT NULL,
      kind text NOT NULL,
      stage text NOT NULL,
      actor jsonb NOT NULL,
      payload jsonb NOT NULL,
      PRIMARY KEY (task_id, seq)
    )`)
    await this.ensure(`CREATE TABLE IF NOT EXISTS ${this.t('ai_audit')} (
      task_id text NOT NULL,
      seq bigint NOT NULL,
      ts text NOT NULL,
      actor text NOT NULL,
      actor_name text NOT NULL,
      action text NOT NULL,
      detail jsonb NOT NULL,
      PRIMARY KEY (task_id, seq)
    )`)
    // advisory lock 能力探测（pg-mem 等模拟后端不支持 → 显式降级并告警）
    try {
      await this.pool.query('SELECT pg_advisory_lock(0)')
      await this.pool.query('SELECT pg_advisory_unlock(0)')
      this.lockFallback = false
    } catch {
      this.lockFallback = true
      // eslint-disable-next-line no-console
      console.warn('[pg-store] advisory lock 不可用（模拟后端？）→ 降级进程内互斥；真实 PG 不应出现此告警')
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** 会话级 advisory lock 互斥；模拟后端降级进程内 KeyedMutex */
  async withNamedLock<T>(ns: 'state' | 'event' | 'audit', taskId: string, fn: () => Promise<T>): Promise<T> {
    if (this.lockFallback === true) {
      return this.jsMutex.run(`${ns}:${taskId}`, fn)
    }
    const client = await this.pool.connect()
    const key = `${ns}:${taskId}`
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
      return await fn()
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined)
      client.release()
    }
  }

  async nextSeq(table: 'ai_events' | 'ai_audit', taskId: string): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(MAX(seq), 0) AS s FROM ${this.t(table)} WHERE task_id = $1`, [taskId])
    return Number(r.rows[0]?.s ?? 0) + 1
  }
}

export class PgBackend implements StorageBackend {
  constructor(private core: PgCore) {}

  async init(): Promise<void> {
    await this.core.init()
  }

  async close(): Promise<void> {
    await this.core.close()
  }

  async load(taskId: string): Promise<TaskState | null> {
    const r = await this.core.pool.query(`SELECT state FROM ${this.core.t('ai_tasks')} WHERE task_id = $1`, [taskId])
    return (r.rows[0]?.state as TaskState | undefined) ?? null
  }

  async save(taskId: string, state: TaskState): Promise<void> {
    await this.core.pool.query(
      `INSERT INTO ${this.core.t('ai_tasks')} (task_id, seq, state, state_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id) DO UPDATE SET seq = $2, state = $3, state_version = $4, created_at = $5, updated_at = $6`,
      [taskId, state.seq, state, state.stateVersion, state.createdAt, state.updatedAt],
    )
  }

  async list(): Promise<TaskState[]> {
    const r = await this.core.pool.query(`SELECT state FROM ${this.core.t('ai_tasks')} ORDER BY seq, task_id`)
    return r.rows.map((row) => row.state as TaskState)
  }

  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.core.withNamedLock('state', taskId, fn)
  }

  eventLogFor(taskId: string): IEventLog {
    return new PgEventLog(this.core, taskId)
  }

  auditLogFor(taskId: string): IAuditLog {
    return new PgAuditLog(this.core, taskId)
  }
}

export class PgEventLog implements IEventLog {
  constructor(
    private core: PgCore,
    private taskId: string,
  ) {}

  async append<K extends SemanticEventKind>(
    taskId: string,
    stage: StageId,
    actor: EventActor,
    kind: K,
    payload: SemanticEventPayloadMap[K],
  ): Promise<SemanticEvent> {
    return this.core.withNamedLock('event', taskId, async () => {
      const seq = await this.core.nextSeq('ai_events', taskId)
      const event = { seq, ts: nowIso(), taskId, kind, stage, actor, payload } as SemanticEvent
      await this.core.pool.query(
        `INSERT INTO ${this.core.t('ai_events')} (task_id, seq, ts, kind, stage, actor, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, seq, event.ts, kind, stage, actor, payload],
      )
      return event
    })
  }

  async read(filter?: EventFilter): Promise<SemanticEvent[]> {
    const params: unknown[] = [this.taskId]
    let where = 'task_id = $1'
    if (filter?.afterSeq !== undefined) {
      params.push(filter.afterSeq)
      where += ` AND seq > $${params.length}`
    }
    if (filter?.kinds?.length) {
      const slots = filter.kinds.map((k) => {
        params.push(k)
        return `$${params.length}`
      })
      where += ` AND kind IN (${slots.join(', ')})`
    }
    const r = await this.core.pool.query(
      `SELECT seq, ts, kind, stage, actor, payload FROM ${this.core.t('ai_events')} WHERE ${where} ORDER BY seq`,
      params,
    )
    let out = r.rows.map(
      (row) =>
        ({
          seq: Number(row.seq),
          ts: row.ts,
          kind: row.kind,
          stage: row.stage,
          actor: row.actor,
          payload: row.payload,
        }) as SemanticEvent,
    )
    if (filter?.toolsOnly) out = out.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result')
    return out
  }

  async lastSeq(): Promise<number> {
    return (await this.core.nextSeq('ai_events', this.taskId)) - 1
  }

  async journey(limit = 200): Promise<JourneyEntry[]> {
    return buildJourney(await this.read(), limit)
  }
}

export class PgAuditLog implements IAuditLog {
  constructor(
    private core: PgCore,
    private taskId: string,
  ) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.core.withNamedLock('audit', this.taskId, async () => {
      const seq = await this.core.nextSeq('ai_audit', this.taskId)
      await this.core.pool.query(
        `INSERT INTO ${this.core.t('ai_audit')} (task_id, seq, ts, actor, actor_name, action, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [this.taskId, seq, entry.ts, entry.actor, entry.actorName, entry.action, entry.detail],
      )
    })
  }

  async read(): Promise<AuditEntry[]> {
    const r = await this.core.pool.query(
      `SELECT ts, actor, actor_name, action, detail FROM ${this.core.t('ai_audit')} WHERE task_id = $1 ORDER BY seq`,
      [this.taskId],
    )
    return r.rows.map((row) => ({
      ts: row.ts as string,
      actor: row.actor as string,
      actorName: row.actor_name as string,
      action: row.action as string,
      detail: row.detail as Record<string, unknown>,
    }))
  }
}

/** 装配入口：main.ts 仅在 DATABASE_URL 存在时动态 import，避免无谓依赖加载 */
export function createPgBackend(url: string, schema = 'public'): PgBackend {
  return new PgBackend(new PgCore(url, schema))
}

/** 测试装配：注入池实现（pg-mem）；schema 由调用方给定 */
export function createPgBackendWithPool(pool: PgPoolLike, schema: string): PgBackend {
  return new PgBackend(new PgCore(pool, schema))
}

/** 测试清理：删除实例 schema（CASCADE 连带表） */
export async function dropPgSchema(backend: PgBackend): Promise<void> {
  const core = (backend as unknown as { core: PgCore }).core
  await core.pool.query(`DROP SCHEMA IF EXISTS ${qident(core.schema)} CASCADE`)
}
