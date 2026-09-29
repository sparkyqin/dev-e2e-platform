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

/** 五门拍板：fact(answer) → 设计段三门(approve) → review(approve) → test(approve)，到达 MR 已创建 */
async function fastForwardGates(platform: Platform, taskId: string, answer: string): Promise<void> {
  await waitForGate(platform, taskId, 'fact')
  await decide(platform, taskId, 'zhangming', 'answer', { answer })
  await approveDesignGates(platform, taskId)
  await waitForGate(platform, taskId, 'review')
  await decide(platform, taskId, 'zhaolei', 'approve')
  await waitForGate(platform, taskId, 'test')
  await decide(platform, taskId, 'wanghao', 'approve')
  await waitFor(async () => {
    const s = await stateOf(platform, taskId)
    return s.mr ? s : null
  }, { what: 'MR 创建' })
}

describe('场景5：接口试错 → 健康徽标黄 → 人接管 → 指令修复 → 合入', () => {
  it('flaky-tool 剧本全链路', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'flaky-tool' })
    const taskId = st.taskId

    // 前置门走完到 code
    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')

    // code 阶段：连续工具报错 → 健康黄（主动叫人）
    const yellow = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.health.level === 'yellow' ? s : null
      },
      { timeoutMs: 30_000, what: '健康徽标转黄' },
    )
    expect(yellow.health.facts.some((f) => f.code === 'tool-error-streak')).toBe(true)
    // 事件流有连续报错证据 + 健康变化留痕（health_changed 语义事件覆盖）
    const toolResults = await platform.store.eventLog(taskId).read({ kinds: ['tool_result'] })
    const errs = toolResults.filter((e) => (e.payload as { ok: boolean }).ok === false)
    expect(errs.length).toBeGreaterThanOrEqual(3)
    const healthEvents = await platform.store.eventLog(taskId).read({ kinds: ['health_changed'] })
    expect(healthEvents.some((e) => (e.payload as { to: string }).to === 'yellow')).toBe(true)
    // 通知：健康预警发owner
    expect(platform.notifications.inbox('wanghao').some((n) => n.kind === 'health-warn')).toBe(true)

    // 人接管（via=interrupt）：中断会话，人在控
    await platform.takeover(taskId, 'wanghao')
    const held = await waitForStatus(platform, taskId, 'user-held')
    expect(held.autonomy).toBe('human')
    expect(held.lifecycleNote).toBe('interrupted') // ≠ 失败
    const takeovers = await platform.store.eventLog(taskId).read({ kinds: ['takeover'] })
    expect((takeovers[0].payload as { direction: string; via: string }).direction).toBe('human')
    expect((takeovers[0].payload as { direction: string; via: string }).via).toBe('interrupt')

    // 追加修复指令 → 回队列 → 修复模式完成
    await platform.instruction(taskId, '旧接口已下线，改用 PushService.send 并补齐边界用例', 'wanghao')

    // 修复完成 → verify → test 门
    await waitForGate(platform, taskId, 'test', 60_000)
    await decide(platform, taskId, 'wanghao', 'approve')
    await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建' })
    await waitForGate(platform, taskId, 'delivery')
    await decide(platform, taskId, 'zhoujie', 'merge')
    await waitForStatus(platform, taskId, 'merged', 10_000)

    // 恢复自动的显式语义已随指令回队列体现；修复后的指令确实注入引擎
    const userMsgs = await platform.store.eventLog(taskId).read({ kinds: ['user_message'] })
    expect(userMsgs.some((e) => (e.payload as { text: string }).text.includes('PushService.send'))).toBe(true)
  }, 150_000)
})

describe('场景9：构建失败 → 重试预算耗尽 → 停止升级（反幻觉，不假装通过）', () => {
  it('build-fail 剧本：failed + critical 通知 + 如实记录', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'build-fail' })
    const taskId = st.taskId

    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')

    // code 完成 → verify：多维评审 PASS，但 build 连续失败 → 预算耗尽 failed
    const failed = await waitForStatus(platform, taskId, 'failed', 90_000)
    expect(failed.lifecycleNote).toBe('failed')
    // 如实记录构建失败（不假装通过）
    const evts = await platform.store.eventLog(taskId).read({ kinds: ['tool_result'] })
    const builds = evts.filter((e) => (e.payload as { tool: string }).tool === 'run_build')
    expect(builds.length).toBeGreaterThanOrEqual(2) // fast 预算 build=2
    expect(builds.every((e) => (e.payload as { ok: boolean }).ok === false)).toBe(true)
    // critical 通知给 owner（状态先落库、通知随后送达——轮询等待而非即时断言，避免时序竞态）
    await waitFor(async () => {
      const inbox = platform.notifications.inbox('wanghao')
      return inbox.some((n) => n.priority === 'critical' && n.title.includes('停止待修复')) ? inbox : null
    }, { what: '停止待修复 critical 通知' })

    // 反幻觉恢复：追加修复指令后回队列，修复后 build 通过
    await platform.instruction(taskId, '模块路径错误已修正，请重试', 'wanghao')
    await waitForGate(platform, taskId, 'test', 90_000)
    await decide(platform, taskId, 'wanghao', 'approve')
    await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建' })
    await waitForGate(platform, taskId, 'delivery')
    await decide(platform, taskId, 'zhoujie', 'merge')
    await waitForStatus(platform, taskId, 'merged', 10_000)
  }, 200_000)
})

describe('场景7：流水线首败 → 自动修复 → 重推 → 旧证据失效 → 合入', () => {
  it('feedback-loop 剧本：SHA 变更后旧流水线证据 stale', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'feedback-loop' })
    const taskId = st.taskId
    await fastForwardGates(platform, taskId, '按自然月过期')

    const first = await stateOf(platform, taskId)
    const oldSha = first.mr!.sha

    // 首轮流水线失败（远端真实）→ 反馈分诊 auto-fixable → 不惊动人 → 回退编码修复
    const rolledBack = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.stage === 'code' && s.repairRounds >= 1 ? s : null
      },
      { timeoutMs: 30_000, what: '流水线失败自动回退编码' },
    )
    expect(rolledBack.repairRounds).toBeGreaterThanOrEqual(1)
    // 修复指令含 MR 反馈（持久证据：user_message 事件留痕；live 指令会被 codeWorker 即刻消费）
    await waitFor(
      async () => {
        const msgs = await platform.store.eventLog(taskId).read({ kinds: ['user_message'] })
        return msgs.some((e) => String((e.payload as { text: string }).text).includes('MR 反馈')) ? true : null
      },
      { timeoutMs: 30_000, what: 'MR 反馈修复指令留痕' },
    )
    await waitFor(
      async () => {
        const rbs = await platform.store.eventLog(taskId).read({ kinds: ['rollback'] })
        return rbs.some((e) => String((e.payload as { reason: string }).reason).includes('自动可修')) ? true : null
      },
      { what: '自动修复回退事件留痕' },
    )

    // 修复轮完成会再次举起 test 门（复检后仍需人拍板，铁门不放行）→ 决策后进入重推
    await waitForGate(platform, taskId, 'test', 60_000)
    await decide(platform, taskId, 'wanghao', 'approve')

    // 修复完成重推：新 SHA → 旧 SHA 证据失效（重推后可能立即就绪举门，故只看 SHA 变化）
    const repushed = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.mr && s.mr.sha !== oldSha ? s : null
      },
      { timeoutMs: 90_000, what: '修复重推（新 SHA）' },
    )
    expect(repushed.mr!.sha).not.toBe(oldSha)

    const { loadDeliveryState } = await import('../src/orchestrator/workers.js')
    const ds = await loadDeliveryState(platform, taskId)
    const oldEvidence = ds.evidence.filter((e) => e.sha === oldSha)
    expect(oldEvidence.length).toBeGreaterThan(0)
    expect(oldEvidence.every((e) => e.stale)).toBe(true) // SHA 校验
    expect(ds.feedback.every((f) => ['fixed', 'logged', 'waived'].includes(f.status))).toBe(true)

    // 新 SHA 流水线真绿 → 交付门 → 合入
    await waitForGate(platform, taskId, 'delivery', 30_000)
    await decide(platform, taskId, 'zhoujie', 'merge')
    await waitForStatus(platform, taskId, 'merged', 10_000)
  }, 200_000)
})

describe('场景8：并发调度（多任务槽位竞争，门挂起释放槽）', () => {
  it('3 任务 maxConcurrent=2：同时最多 2 个 running；门挂起后排队任务获得槽位', async () => {
    await platform.scheduler.setMaxConcurrent(2)
    const a = await createDemoTask(platform, { scenario: 'clean' })
    const b = await createDemoTask(platform, { scenario: 'clean' })
    const c = await createDemoTask(platform, { scenario: 'clean' })

    // 门挂起不占槽 → c 获得槽开跑（无人拍板时 a/b 只会停在门上，槽必然空出）
    const cRunning = await waitFor(
      async () => {
        const s = await stateOf(platform, c.taskId)
        return s.status === 'running' || s.status === 'gate-wait' ? s : null
      },
      { what: '排队任务获得槽位' },
    )
    expect(['running', 'gate-wait']).toContain(cRunning.status)

    // 采样不变量：任意时刻 running ≤ 2
    const runningNow = (await platform.store.listAll()).filter((s) => s.status === 'running')
    expect(runningNow.length).toBeLessThanOrEqual(2)

    // 槽位释放因果（E2E 可观测证据）：c 的首个引擎会话不早于 a/b 首个门的举起
    // （门举起 → 挂起释放槽 → 调度才可能把槽分给 c；FIFO 由 plan 纯函数单测保证）
    const firstOf = async (taskId: string, kind: 'session_started' | 'gate_raised') =>
      (await platform.store.eventLog(taskId).read({ kinds: [kind] }))[0]
    const cSession = await waitFor(() => firstOf(c.taskId, 'session_started').then((e) => e ?? null), { what: 'c 首个引擎会话' })
    const aGate = await waitFor(() => firstOf(a.taskId, 'gate_raised').then((e) => e ?? null), { what: 'a 首个门' })
    const bGate = await waitFor(() => firstOf(b.taskId, 'gate_raised').then((e) => e ?? null), { what: 'b 首个门' })
    const firstSuspend = Math.min(Date.parse(aGate.ts), Date.parse(bGate.ts))
    expect(Date.parse(cSession.ts)).toBeGreaterThanOrEqual(firstSuspend)

    // 收尾：c 至少推进到澄清（fast 剧本 fact 门 300ms 降级是瞬态，不可断言 raised）
    await waitFor(
      async () => {
        const s = await stateOf(platform, c.taskId)
        return ['clarify', 'architecture', 'design', 'test-design', 'review', 'code', 'verify', 'deliver', 'merged'].includes(s.stage) ? s : null
      },
      { what: 'c 已推进过 intake' },
    )
  }, 60_000)
})

describe('场景9 附加：重启恢复（状态在文件，不丢状态）', () => {
  it('新 Platform 实例恢复：门等待中的任务状态原样保留', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    await waitForGate(platform, taskId, 'fact')

    // 模拟重启：旧实例 dispose → 新实例同目录 init
    const dir = ctx.dir
    await platform.dispose()
    const { Platform: P } = await import('../src/orchestrator/platform.js')
    const p2 = new P(dir)
    await p2.init()

    const recovered = await p2.store.load(taskId)
    expect(recovered.status).toBe('gate-wait')
    expect(recovered.gate?.kind).toBe('fact')
    expect(recovered.stage).toBe('clarify')

    // 恢复后仍可决策并继续推进
    const { decideGate } = await import('../src/orchestrator/gates.js')
    await decideGate(p2, taskId, { stateVersion: recovered.stateVersion, action: 'answer', answer: '恢复后作答：按自然月过期', asUserId: 'zhangming' })
    const after = await waitFor(async () => {
      const s = await p2.store.load(taskId)
      return s.stage === 'architecture' || s.gate?.kind === 'fact' ? s : null
    }, { what: '恢复后推进' })
    expect(after.seq).toBe(st.seq)

    // 换回实例供后续用例
    await p2.dispose()
    const p3 = new P(dir)
    await p3.init()
    platform = p3
    ctx = { ...ctx, platform: p3, dir }
  }, 60_000)
})
