import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Platform } from '../src/orchestrator/platform.js'
import { sleep } from '../src/domain/util.js'
import type { StorageBackend } from '../src/domain/store-backend.js'
import type { TaskState } from '@ai-platform/shared'

/**
 * 测试基建：临时目录 Platform + 轮询等待。
 *
 * 约定：SIM_DELAY=0（模拟引擎事件零间隔）、TICK_MS=80（平台轮询加速）、安静时段避开。
 * 存储：默认文件后端；配 TEST_DATABASE_URL 时切 PG 后端（每实例独立 schema `t_<uuid>`，
 * dispose 时 DROP CASCADE——同一套 e2e 即双后端契约测试）。
 */

export async function makePlatform(): Promise<{ platform: Platform; dir: string; dispose: () => Promise<void> }> {
  process.env.SIM_DELAY = '0'
  process.env.TICK_MS = '80'
  process.env.QUIET_HOURS_START = '03:00'
  process.env.QUIET_HOURS_END = '03:01'
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'ai-platform-test-'))

  let backend: StorageBackend | undefined
  const pgUrl = process.env.TEST_DATABASE_URL
  if (pgUrl) {
    const { createPgBackend, dropPgSchema } = await import('../src/domain/pg-store.js')
    const b = createPgBackend(pgUrl, `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    backend = b
    const platform = new Platform(dir, { backend })
    await platform.init()
    return {
      platform,
      dir,
      dispose: async () => {
        await platform.dispose()
        await dropPgSchema(b).catch(() => undefined)
        await b.close().catch(() => undefined)
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      },
    }
  }

  const platform = new Platform(dir)
  await platform.init()
  return {
    platform,
    dir,
    dispose: async () => {
      await platform.dispose()
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; step?: number; what?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const step = opts.step ?? 40
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）：${opts.what ?? '条件未满足'}`)
    }
    await sleep(step)
  }
}

export async function stateOf(platform: Platform, taskId: string): Promise<TaskState> {
  return platform.store.load(taskId)
}

export async function waitForStatus(platform: Platform, taskId: string, status: TaskState['status'], timeoutMs?: number): Promise<TaskState> {
  return waitFor(async () => {
    const s = await stateOf(platform, taskId)
    return s.status === status ? s : null
  }, { timeoutMs, what: `status=${status}` })
}

export async function waitForStage(platform: Platform, taskId: string, stage: TaskState['stage'], timeoutMs?: number): Promise<TaskState> {
  return waitFor(async () => {
    const s = await stateOf(platform, taskId)
    return s.stage === stage ? s : null
  }, { timeoutMs, what: `stage=${stage}` })
}

/** 等当前门出现（kind 匹配且处于 raised 状态） */
export async function waitForGate(platform: Platform, taskId: string, kind: TaskState['gate'] extends null ? never : NonNullable<TaskState['gate']>['kind'], timeoutMs?: number) {
  return waitFor(async () => {
    const s = await stateOf(platform, taskId)
    return s.gate && s.gate.kind === kind && s.gate.status === 'raised' ? s.gate : null
  }, { timeoutMs, what: `gate=${kind}(raised)` })
}

export interface DemoTaskOpts {
  playbookId?: string
  scenario?: 'clean' | 'flaky-tool' | 'build-fail' | 'feedback-loop'
  title?: string
  requirementText?: string
  unattended?: boolean
  arParallel?: boolean
}

export async function createDemoTask(platform: Platform, opts: DemoTaskOpts = {}): Promise<TaskState> {
  return platform.createTask({
    title: opts.title ?? '会员积分过期提醒',
    requirementText: opts.requirementText ?? '会员中心：积分快过期的会员，在过期前 7 天发提醒（短信/App 内信），过期后积分清零要留痕。',
    module: 'membership-points',
    repo: 'membership-center',
    mode: 'incremental',
    playbookId: opts.playbookId ?? 'fast',
    people: {},
    unattended: opts.unattended ?? false,
    engineId: 'simulated',
    scenario: opts.scenario ?? 'clean',
    arParallel: opts.arParallel ?? false,
  })
}

/** 以指定身份决策当前门（演示环境无鉴权） */
export async function decide(
  platform: Platform,
  taskId: string,
  asUserId: string,
  action: 'approve' | 'answer' | 'rollback' | 'merge',
  extra: {
    answer?: string
    rollbackTarget?: 'clarify' | 'architecture' | 'design' | 'test-design' | 'code' | 'verify'
    reason?: string
  } = {},
) {
  const { decideGate } = await import('../src/orchestrator/gates.js')
  const st = await stateOf(platform, taskId)
  return decideGate(platform, taskId, {
    stateVersion: st.stateVersion,
    action,
    answer: extra.answer,
    rollbackTarget: extra.rollbackTarget,
    reason: extra.reason,
    asUserId,
  })
}

/**
 * 设计段三门推进：架构（架构师拍）→ 功能设计（开发拍）→ 测试设计（TSE 拍）。
 * 以门的 soleDecider 身份 approve（与演示驱动器同策略，健壮于缺省角色回退）。
 */
export async function approveDesignGates(platform: Platform, taskId: string, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    const gate = await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, gate.soleDecider.userId, 'approve')
  }
}
