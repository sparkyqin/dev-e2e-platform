import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SemanticEvent, TaskState } from '@ai-platform/shared'
import { makePlatform, createDemoTask, decide, stateOf, waitFor, waitForGate } from './helpers.js'
import { approveDesignGates } from './helpers.js'
import type { Platform } from '../src/orchestrator/platform.js'
import { computeTaskMetrics, buildMetricsView } from '../src/runtime/metrics.js'

let ctx: Awaited<ReturnType<typeof makePlatform>>
let platform: Platform

beforeAll(async () => {
  ctx = await makePlatform()
  platform = ctx.platform
})

afterAll(async () => {
  await ctx.dispose()
})

function baseState(): TaskState {
  return {
    schemaVersion: 1,
    taskId: 'task-998',
    seq: 998,
    title: 't',
    module: 'm',
    repo: 'r',
    requirementText: 'req',
    mode: 'incremental',
    paradigm: 'single-center',
    playbookId: 'fast',
    stage: 'merged',
    status: 'merged',
    stateVersion: 1,
    currentStepIndex: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '',
    stageRounds: { intake: 1 },
    completedStages: [],
    repairRounds: 1,
    unattended: false,
    autonomy: 'auto',
    people: {
      requester: { userId: 'a', name: 'a', role: '' },
      owner: { userId: 'b', name: 'b', role: '' },
      designer: { userId: 'c', name: 'c', role: '' },
      reviewer: { userId: 'd', name: 'd', role: '' },
      merger: { userId: 'e', name: 'e', role: '' },
      admin: { userId: 'admin', name: 'admin', role: '' },
    },
    engineId: 'simulated',
    gate: null,
    pendingInstructions: [],
    pendingConfirmations: [],
    mr: null,
    health: { level: 'green', facts: [] },
    artifacts: [],
    tokenUsage: { input: 0, output: 0, budget: 1000 },
    scenario: 'clean',
  }
}

function ev(seq: number, ts: string, kind: SemanticEvent['kind'], payload: Record<string, unknown>): SemanticEvent {
  return { seq, ts, taskId: 'task-998', kind, stage: 'intake', actor: { type: 'system' }, payload } as unknown as SemanticEvent
}

describe('度量：computeTaskMetrics（事件流只读派生）', () => {
  it('阶段段式累加：推进/回退重做/门等待降级均计入', () => {
    const s = baseState()
    const events: SemanticEvent[] = [
      ev(1, '2026-01-01T00:00:00.000Z', 'stage_entered', { stage: 'intake', reentry: false, round: 1 }),
      ev(2, '2026-01-01T00:00:10.000Z', 'stage_exited', { stage: 'intake', reason: 'completed', round: 1 }),
      ev(3, '2026-01-01T00:00:10.000Z', 'stage_entered', { stage: 'clarify', reentry: false, round: 1 }),
      ev(4, '2026-01-01T00:00:20.000Z', 'gate_raised', { gateId: 'g1', gateKind: 'fact', question: 'q', digest: 'd' }),
      ev(5, '2026-01-01T00:00:50.000Z', 'gate_decided', { gateId: 'g1', action: 'answer', decidedBy: 'a', decidedByName: 'A' }),
      ev(6, '2026-01-01T00:00:50.000Z', 'stage_exited', { stage: 'clarify', reason: 'completed', round: 1 }),
      ev(7, '2026-01-01T00:00:50.000Z', 'stage_entered', { stage: 'architecture', reentry: false, round: 1 }),
      ev(8, '2026-01-01T00:01:20.000Z', 'gate_raised', { gateId: 'g2', gateKind: 'fact', question: 'q', digest: 'd' }),
      ev(9, '2026-01-01T00:02:20.000Z', 'gate_decided', { gateId: 'g2', action: 'degrade', decidedBy: 'system', decidedByName: '平台' }),
      ev(10, '2026-01-01T00:02:20.000Z', 'stage_exited', { stage: 'architecture', reason: 'completed', round: 1 }),
      ev(11, '2026-01-01T00:02:20.000Z', 'stage_entered', { stage: 'design', reentry: false, round: 1 }),
      ev(12, '2026-01-01T00:03:00.000Z', 'stage_exited', { stage: 'design', reason: 'completed', round: 1 }),
      ev(13, '2026-01-01T00:03:00.000Z', 'stage_entered', { stage: 'verify', reentry: false, round: 1 }),
      ev(14, '2026-01-01T00:04:00.000Z', 'rollback', { from: 'verify', to: 'code', reason: '验证不通过', declaredBy: 'platform', declaredByName: '平台', reentrySkipsAiRerun: false }),
      ev(15, '2026-01-01T00:04:00.000Z', 'stage_entered', { stage: 'code', reentry: true, round: 2 }),
      ev(16, '2026-01-01T00:04:30.000Z', 'stage_exited', { stage: 'code', reason: 'completed', round: 2 }),
      ev(17, '2026-01-01T00:04:30.000Z', 'stage_entered', { stage: 'deliver', reentry: false, round: 1 }),
      ev(18, '2026-01-01T00:05:00.000Z', 'gate_raised', { gateId: 'g3', gateKind: 'delivery', question: 'q', digest: 'd' }),
      ev(19, '2026-01-01T00:06:00.000Z', 'gate_decided', { gateId: 'g3', action: 'merge', decidedBy: 'e', decidedByName: 'E' }),
      ev(20, '2026-01-01T00:06:00.000Z', 'stage_exited', { stage: 'deliver', reason: 'completed', round: 1 }),
    ]

    const m = computeTaskMetrics(s, events, Date.parse('2026-01-01T00:06:30.000Z'))

    // TTM = 创建(00:00:00) → 合入(00:06:00) = 6 分钟
    expect(m.ttmMs).toBe(6 * 60_000)
    expect(m.mergedAt).toBe('2026-01-01T00:06:00.000Z')

    // 阶段活跃时长：intake=10s；clarify=40s（含事实门等待 30s）；architecture=90s（含降级门等待 60s）
    expect(m.stageTimingsMs.intake).toBe(10_000)
    expect(m.stageTimingsMs.clarify).toBe(40_000)
    expect(m.stageTimingsMs.architecture).toBe(90_000)
    expect(m.stageTimingsMs.verify).toBe(60_000)
    expect(m.stageTimingsMs.code).toBe(30_000)

    // 门等待：fact×2（answer 30s + degrade 60s）、delivery×1（merge 60s）
    const fact = m.gateWaits.find((g) => g.kind === 'fact')
    const delivery = m.gateWaits.find((g) => g.kind === 'delivery')
    expect(fact?.count).toBe(2)
    expect(fact?.degraded).toBe(1)
    expect(fact?.maxMs).toBe(60_000)
    expect(delivery?.count).toBe(1)

    // 回退计数与事件量
    expect(m.rollbacks).toBe(1)
    expect(m.repairRounds).toBe(1)
    expect(m.eventCount).toBe(20)

    // 一次通过与阶段轮次：本用例有 1 次回退（verify→code）→ 非一次通过；code 被重做（round 2）
    expect(m.firstPass).toBe(false)
    expect(m.stageMaxRounds.code).toBe(2)
    expect(m.stageMaxRounds.verify).toBe(1)
    expect(m.stageMaxRounds.intake).toBe(1)
  })

  it('一次通过：零回退零修复轮直达合入', () => {
    const s = baseState()
    s.repairRounds = 0
    const events: SemanticEvent[] = [
      ev(1, '2026-01-01T00:00:00.000Z', 'stage_entered', { stage: 'intake', reentry: false, round: 1 }),
      ev(2, '2026-01-01T00:00:05.000Z', 'stage_exited', { stage: 'intake', reason: 'completed', round: 1 }),
      ev(3, '2026-01-01T00:00:05.000Z', 'stage_entered', { stage: 'deliver', reentry: false, round: 1 }),
      ev(4, '2026-01-01T00:00:20.000Z', 'gate_raised', { gateId: 'g1', gateKind: 'delivery', question: 'q', digest: 'd' }),
      ev(5, '2026-01-01T00:00:30.000Z', 'gate_decided', { gateId: 'g1', action: 'merge', decidedBy: 'e', decidedByName: 'E' }),
      ev(6, '2026-01-01T00:00:30.000Z', 'stage_exited', { stage: 'deliver', reason: 'completed', round: 1 }),
    ]
    const m = computeTaskMetrics(s, events, Date.parse('2026-01-01T00:00:30.000Z'))
    expect(m.rollbacks).toBe(0)
    expect(m.firstPass).toBe(true)
    expect(m.stageMaxRounds).toEqual({ intake: 1, deliver: 1 })
  })

  it('未合入任务：ttmMs=null，ageMs 随当前时间增长', () => {
    const s = baseState()
    s.status = 'gate-wait'
    s.stage = 'clarify'
    const events = [ev(1, '2026-01-01T00:00:00.000Z', 'stage_entered', { stage: 'intake', reentry: false, round: 1 })]
    const m = computeTaskMetrics(s, events, Date.parse('2026-01-01T00:02:00.000Z'))
    expect(m.ttmMs).toBeNull()
    expect(m.ageMs).toBe(2 * 60_000)
    // 进行中开段计入当前阶段（intake 段至 now）
    expect(m.stageTimingsMs.intake).toBe(2 * 60_000)
  })
})

describe('度量：buildMetricsView（真实管线聚合）', () => {
  it('走过设计段后的任务度量包含新阶段与门等待统计', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'clean' })
    const taskId = st.taskId

    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期，次月 1 日清零' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')
    await waitForGate(platform, taskId, 'test')
    await decide(platform, taskId, 'wanghao', 'approve')
    await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建' })

    const view = await buildMetricsView(platform)
    const mine = view.tasks.find((t) => t.taskId === taskId)
    expect(mine).toBeTruthy()
    expect(mine?.stageTimingsMs.architecture).toBeDefined() // 新阶段有活跃时长
    expect(mine?.stageTimingsMs['test-design']).toBeDefined()
    expect(mine?.stageTimingsMs.design).toBeDefined()

    // 门等待：fact ≥ 4（澄清 + 架构 + 方案 + 测试设计）、review=1、test=1
    const fact = mine?.gateWaits.find((g) => g.kind === 'fact')
    const review = mine?.gateWaits.find((g) => g.kind === 'review')
    const test = mine?.gateWaits.find((g) => g.kind === 'test')
    expect((fact?.count ?? 0)).toBeGreaterThanOrEqual(4)
    expect(review?.count).toBe(1)
    expect(test?.count).toBe(1)

    // 汇总：任务数 ≥ 1、活跃计数包含本任务、阶段均值含新阶段
    expect(view.summary.taskCount).toBeGreaterThanOrEqual(1)
    expect(view.summary.activeCount).toBeGreaterThanOrEqual(1)
    expect(view.summary.stageAvgMs.architecture).toBeDefined()
    expect(mine?.rollbacks).toBe(0)
    expect(mine?.ttmMs).toBeNull() // 未合入不计 TTM
    expect(mine?.eventCount).toBeGreaterThan(0)

    // 一次通过：任务未合入 → firstPass=false；本平台实例无已合入任务 → 汇总率为 null；阶段单轮占比可派生
    expect(mine?.firstPass).toBe(false)
    expect(view.summary.firstPassRate).toBeNull()
    expect(view.summary.stageFirstPassRate.intake).toBe(1)
    expect(view.summary.stageFirstPassRate.architecture).toBe(1)
  })
})
