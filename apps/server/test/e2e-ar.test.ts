import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { approveDesignGates, createDemoTask, decide, makePlatform, stateOf, waitFor, waitForGate, waitForStatus } from './helpers.js'
import type { Platform } from '../src/orchestrator/platform.js'

let ctx: Awaited<ReturnType<typeof makePlatform>>
let platform: Platform

beforeAll(async () => {
  ctx = await makePlatform()
  platform = ctx.platform
})

afterAll(async () => {
  await ctx.dispose()
})

/**
 * E2E：AR 级并行（研发作业流 · 执行段拆分）
 * 父任务 review 通过 → AR 拆分门（owner 拍）→ spawn 3 子任务（开发轮转承接，从 code 起跑）
 * → 子任务各自 编码→验证→测试门→MR→交付门合入 → 父任务 aggregating →
 * 聚合验收门（TSE 拍）→ 父任务收口 merged；subtask_spawned/completed 事件全程可回溯。
 */
describe('E2E：AR 并行（父拆分 → 子任务并行执行 → 聚合验收 → 父收口）', () => {
  it('全链路：父任务经拆分与聚合到达 merged', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'clean', arParallel: true })
    const taskId = st.taskId

    // 设计段：澄清作答 + 三门拍板 + 审核放行
    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期，次月 1 日清零；30 天口径' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')

    // AR 拆分门（fact，owner 拍板）
    const splitGate = await waitForGate(platform, taskId, 'fact')
    expect(splitGate.soleDecider.userId).toBe('wanghao')
    expect(splitGate.question).toContain('AR 拆分')
    expect(splitGate.question).toContain('过期规则参数化') // 演示剧本拆 3 个 AR
    await decide(platform, taskId, 'wanghao', 'approve')

    // 父任务转聚合等待，派发 3 个子任务
    const parent = await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.status === 'aggregating' && (s.subtasks?.length ?? 0) > 0 ? s : null
    }, { what: '父任务 aggregating + 子任务清单', timeoutMs: 30_000 })
    expect(parent.subtasks).toHaveLength(3)
    expect(parent.stage).toBe('execute')

    // 子任务：拷贝了父任务设计产物，从 execute 段编码小节起跑（设计段完成集已注入）
    const subIds = parent.subtasks!.map((s) => s.taskId)
    for (const subId of subIds) {
      const sub = await stateOf(platform, subId)
      expect(sub.parentTaskId).toBe(taskId)
      expect(sub.stage).toBe('execute')
      expect(sub.completedStages).toContain('test-design')
      const { ArtifactManager } = await import('../src/extension/artifacts.js')
      const am = new ArtifactManager(platform.store.taskDir(subId))
      expect(await am.read('delivery/architecture.md')).toBeTruthy() // 父任务架构 SPEC 已拷贝
    }
    // 开发轮转：3 个子任务分别由 王浩/刘阳/陈静 承接
    const owners = new Set(parent.subtasks!.map((s) => s.ownerName))
    expect(owners.size).toBe(3)

    // 驱动每个子任务到 merged：测试门（责任人拍）→ MR → 交付门（合入方 merge）
    for (const subId of subIds) {
      const tg = await waitForGate(platform, subId, 'test', 60_000)
      await decide(platform, subId, tg.soleDecider.userId, 'approve')
      await waitForGate(platform, subId, 'delivery', 60_000)
      await decide(platform, subId, 'zhoujie', 'merge')
      await waitForStatus(platform, subId, 'merged', 30_000)
    }

    // 全部合入 → 聚合验收门（test 类，TSE 拍板）
    const aggGate = await waitForGate(platform, taskId, 'test', 30_000)
    expect(aggGate.soleDecider.userId).toBe('wuqian')
    expect(aggGate.question).toContain('AR 聚合验收')
    await decide(platform, taskId, 'wuqian', 'approve')

    // 父任务收口
    const merged = await waitForStatus(platform, taskId, 'merged', 30_000)
    expect(merged.stage).toBe('merged')
    expect(merged.completedStages).toContain('execute')

    // 事件流可回溯：spawn ×3 + completed ×3
    const events = await platform.store.eventLog(taskId).read()
    expect(events.filter((e) => e.kind === 'subtask_spawned')).toHaveLength(3)
    expect(events.filter((e) => e.kind === 'subtask_completed')).toHaveLength(3)

    // 子任务度量：execute 段计时有归属（stage_entered(execute) 在 spawn 时补发）
    for (const subId of subIds) {
      const subEvents = await platform.store.eventLog(subId).read()
      expect(subEvents.some((e) => e.kind === 'stage_entered' && (e.payload as { stage?: string }).stage === 'execute')).toBe(true)
    }

    // 子任务清单状态全部回写 merged
    const fin = await stateOf(platform, taskId)
    expect(fin.subtasks?.every((s) => s.status === 'merged')).toBe(true)
  }, 180_000)
})
