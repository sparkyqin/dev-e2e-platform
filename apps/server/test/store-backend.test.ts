import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { makePlatform } from './helpers.js'
import { VersionConflictError } from '../src/domain/task-store.js'
import { Platform } from '../src/orchestrator/platform.js'
import type { TaskState } from '@ai-platform/shared'

/**
 * 存储后端契约测试：
 * - 文件后端：全量 e2e（58 用例）即契约（默认跑）
 * - PG 后端：配 TEST_DATABASE_URL 时启用（同一契约 + 跨进程锁 + 重启持久化）
 *   `TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test`
 */

const pgUrl = process.env.TEST_DATABASE_URL

describe('文件后端：存储契约（全量 e2e 之外的直检）', () => {
  let platform: Platform
  let dispose: () => Promise<void>

  beforeAll(async () => {
    const ctx = await makePlatform()
    platform = ctx.platform
    dispose = ctx.dispose
  })
  afterAll(async () => {
    await dispose()
  })

  it('createTask → 状态在 state.json；事件 JSONL 单调 seq；审计可回放', async () => {
    const st = await platform.createTask({
      title: '存储契约直检',
      requirementText: '验证状态/事件/审计三真源的文件布局',
      module: 'storage',
      repo: 'demo',
      mode: 'incremental',
      playbookId: 'strict',
      people: {},
      unattended: false,
      engineId: 'simulated',
      scenario: 'clean',
    } as Parameters<Platform['createTask']>[0])
    expect(st.taskId).toMatch(/^task-\d+$/)
    expect(st.stateVersion).toBeGreaterThanOrEqual(0)

    const raw = JSON.parse(
      await fs.readFile(path.join(platform.store.flowDir(st.taskId), 'state.json'), 'utf8'),
    ) as TaskState
    expect(raw.taskId).toBe(st.taskId)

    const events = await platform.store.eventLog(st.taskId).read()
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].kind).toBe('stage_entered')
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBe(events[i - 1].seq + 1)

    const audit = await platform.store.auditLog(st.taskId).read()
    expect(Array.isArray(audit)).toBe(true)
  })

  it('mutate 乐观锁：版本不符 → VersionConflictError（先到先得）', async () => {
    const all = await platform.store.listAll()
    const t = all[all.length - 1]
    const v = t.stateVersion
    await platform.store.mutate(t.taskId, { expectedVersion: v }, () => undefined)
    await expect(platform.store.mutate(t.taskId, { expectedVersion: v }, () => undefined)).rejects.toBeInstanceOf(
      VersionConflictError,
    )
  })
})

describe('pg-mem 内存模拟：PG 后端 SQL 路径（本地无 PG 时的真执行验证）', () => {
  it('DDL + 平台全流程 + 事件/审计 + 乐观锁 + 重启持久化', async () => {
    const { newDb } = await import('pg-mem')
    const { Pool } = await import('pg')
    const { createPgBackendWithPool, dropPgSchema } = await import('../src/domain/pg-store.js')

    const db = newDb()
    const { Client } = db.adapters.createPg()
    const mkBackend = (): { backend: import('../src/domain/pg-store.js').PgBackend; pool: import('pg').Pool } => {
      const pool = new Pool({ Client } as import('pg').PoolConfig)
      return { backend: createPgBackendWithPool(pool, 'public'), pool }
    }

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ai-platform-pgmem-'))
    const { backend, pool } = mkBackend()
    const platform = new Platform(dir, { backend })
    await platform.init()

    const st = await platform.createTask({
      title: 'pg-mem 契约',
      requirementText: 'PG 后端 SQL 路径本地验证',
      module: 'storage',
      repo: 'demo',
      mode: 'incremental',
      playbookId: 'strict',
      people: {},
      unattended: false,
      engineId: 'simulated',
      scenario: 'clean',
    } as Parameters<Platform['createTask']>[0])
    expect(st.taskId).toMatch(/^task-\d+$/)

    // 并发 append：seq 单调无冲突（模拟后端降级进程内互斥，串行化仍成立）
    const log = platform.store.eventLog(st.taskId)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        log.append(st.taskId, 'intake', { type: 'system' }, 'assistant_message', { text: `并发事件 ${i}` }),
      ),
    )
    const events = await log.read()
    const seqs = events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // 过滤契约：afterSeq / kinds
    const tail = await log.read({ afterSeq: seqs[0] })
    expect(tail.every((e) => e.seq > seqs[0])).toBe(true)
    const staged = await log.read({ kinds: ['stage_entered'] })
    expect(staged.every((e) => e.kind === 'stage_entered')).toBe(true)
    // journey 与事件流同构（活任务后台仍在写，用结构断言而非精确计数）
    const j = await log.journey()
    expect(j.length).toBeGreaterThanOrEqual(events.length)
    expect(j.every((x) => typeof x.text === 'string' && x.text.length > 0)).toBe(true)

    // 乐观锁契约
    const cur = await platform.store.load(st.taskId)
    await expect(
      platform.store.mutate(st.taskId, { expectedVersion: cur.stateVersion - 1 }, () => undefined),
    ).rejects.toBeInstanceOf(VersionConflictError)

    // 审计 append/read
    await platform.store.auditLog(st.taskId).append({ ts: new Date().toISOString(), actor: 'test', actorName: '测试', action: 'probe', detail: { k: 1 } })
    expect((await platform.store.auditLog(st.taskId).read()).some((a) => a.action === 'probe')).toBe(true)

    await platform.dispose()

    // 重启（同库再装配）：真源持久
    const { backend: backend2, pool: pool2 } = mkBackend()
    const platform2 = new Platform(await fs.mkdtemp(path.join(tmpdir(), 'ai-platform-pgmem-')), { backend: backend2 })
    await platform2.init()
    const all = await platform2.store.listAll()
    expect(all.some((s) => s.taskId === st.taskId)).toBe(true)
    const events2 = await platform2.store.eventLog(st.taskId).read()
    expect(events2.length).toBeGreaterThanOrEqual(events.length)
    expect((await platform2.store.auditLog(st.taskId).read()).some((a) => a.action === 'probe')).toBe(true)

    await platform2.dispose()
    await dropPgSchema(backend2).catch(() => undefined)
    await pool2.end().catch(() => undefined)
    await dropPgSchema(backend).catch(() => undefined)
    await pool.end().catch(() => undefined)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })
})

describe.skipIf(!pgUrl)('PG 后端：跨进程锁 + 重启持久化（真实实例）', () => {
  it('同一 schema 两次装配（模拟重启）：状态/事件/审计持久；advisory lock 下并发 append 无 seq 冲突', async () => {
    const { createPgBackend, dropPgSchema } = await import('../src/domain/pg-store.js')
    const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ai-platform-pg-test-'))
    const backend = createPgBackend(pgUrl!, schema)

    const platform = new Platform(dir, { backend })
    await platform.init()
    const st = await platform.createTask({
      title: 'PG 契约',
      requirementText: 'PG 后端契约验证',
      module: 'storage',
      repo: 'demo',
      mode: 'incremental',
      playbookId: 'strict',
      people: {},
      unattended: false,
      engineId: 'simulated',
      scenario: 'clean',
    } as Parameters<Platform['createTask']>[0])

    // 并发 append：无 (task_id, seq) 冲突（advisory lock 串行）
    const log = platform.store.eventLog(st.taskId)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.append(st.taskId, 'intake', { type: 'system' }, 'assistant_message', { text: `并发事件 ${i}` }),
      ),
    )
    const events = await log.read()
    const seqs = events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length) // 无重复
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // 有序

    await platform.dispose()

    // 重启（同 schema 再装配）：真源仍在
    const backend2 = createPgBackend(pgUrl!, schema)
    const platform2 = new Platform(await fs.mkdtemp(path.join(tmpdir(), 'ai-platform-pg-test-')), { backend: backend2 })
    await platform2.init()
    const all = await platform2.store.listAll()
    expect(all.some((s) => s.taskId === st.taskId)).toBe(true)
    const events2 = await platform2.store.eventLog(st.taskId).read()
    expect(events2.length).toBe(events.length)
    const j = await platform2.store.eventLog(st.taskId).journey()
    expect(j.length).toBe(events.length)

    await platform2.dispose()
    await dropPgSchema(backend2).catch(() => undefined)
    await backend2.close()
    await dropPgSchema(backend).catch(() => undefined)
    await backend.close()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })
})
