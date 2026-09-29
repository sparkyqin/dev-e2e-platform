import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { approveDesignGates, makePlatform, waitFor, waitForGate, createDemoTask, decide, stateOf } from './helpers.js'
import type { Platform } from '../src/orchestrator/platform.js'
import { decideGate, raiseGate } from '../src/orchestrator/gates.js'
import { GateError } from '../src/orchestrator/gates.js'
import { VersionConflictError } from '../src/domain/task-store.js'

let ctx: Awaited<ReturnType<typeof makePlatform>>
let platform: Platform

beforeAll(async () => {
  ctx = await makePlatform()
  platform = ctx.platform
})

afterAll(async () => {
  await ctx.dispose()
})

describe('门禁：拍板权唯一（场景4 会诊单拍板）', () => {
  it('非拍板人决策被拒；会诊参与者不拍板；管理员可代拍板留痕', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    const gate = await waitForGate(platform, taskId, 'fact')
    expect(gate.soleDecider.userId).toBe('zhangming') // 事实门=需求方

    // 他人拍板 → 拒绝
    await expect(
      decideGate(platform, taskId, { stateVersion: (await stateOf(platform, taskId)).stateVersion, action: 'answer', answer: 'x', asUserId: 'wanghao' }),
    ).rejects.toThrow(/拍板权唯一/)

    // 邀请会诊：参与者可见可批注，但仍无拍板权
    const { inviteParticipant } = await import('../src/orchestrator/gates.js')
    await inviteParticipant(platform, taskId, 'sunlin', '孙琳', 'wanghao')
    const g2 = await stateOf(platform, taskId)
    expect(g2.gate?.participants.some((p) => p.userId === 'sunlin' && p.role === 'consulted')).toBe(true)
    await expect(
      decideGate(platform, taskId, { stateVersion: (await stateOf(platform, taskId)).stateVersion, action: 'answer', answer: 'x', asUserId: 'sunlin' }),
    ).rejects.toThrow(GateError)

    // 管理员代拍板（onBehalf 留痕）
    const after = await decideGate(platform, taskId, {
      stateVersion: (await stateOf(platform, taskId)).stateVersion,
      action: 'answer',
      answer: '积分按自然月过期，次月 1 日清零；即将过期=未来 30 天',
      asUserId: 'admin',
    })
    expect(after.gate?.decision?.onBehalf).toBe(true)
    expect(after.gate?.decision?.decidedByName).toContain('管理员')
  })
})

describe('门禁：乐观锁（先到先得，后者知情）', () => {
  it('旧 stateVersion 决策抛 VersionConflict', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    await waitForGate(platform, taskId, 'fact')
    const cur = await stateOf(platform, taskId)
    // 先用最新版本拍一次
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期' })
    // 再用旧版本拍 → 冲突
    await expect(
      decideGate(platform, taskId, { stateVersion: cur.stateVersion, action: 'answer', answer: '再次作答', asUserId: 'zhangming' }),
    ).rejects.toThrow(VersionConflictError)
  })
})

describe('门禁：事实门超时降级（场景2 不替答事实，待追认）', () => {
  it('超时后 status=degraded + pendingConfirmations 留待追认，任务继续推进', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' }) // fast playbook: fact 300ms
    const taskId = st.taskId
    await waitForGate(platform, taskId, 'fact')

    // 等平台 tick 处理超时（TICK_MS=80，fact 超时 300ms）
    const degraded = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.gate?.status === 'degraded' ? s : null
      },
      { what: '事实门降级' },
    )
    expect(degraded.pendingConfirmations.length).toBeGreaterThanOrEqual(1) // 后续 fact 门也可能跟着降级
    expect(degraded.pendingConfirmations[0].assumedAnswer).toBeTruthy()
    expect(degraded.status).not.toBe('gate-wait') // 降级推进，不卡死
    // 门事件留痕：gate_decided action=degrade
    const events = await platform.store.eventLog(taskId).read({ kinds: ['gate_decided'] })
    expect(events.some((e) => (e.payload as { action: string }).action === 'degrade')).toBe(true)
  })
})

describe('门禁：review/test 门超时只升级不放行（铁门永不代答）', () => {
  it('review 门超时 → escalated + 管理员 critical 通知，门不放行', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    // 走到 review 门：answer fact → 设计段三门（架构/功能/测试设计）→ review 门 raised
    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期，次月 1 日清零' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')

    const escalated = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.gate?.escalated ? s : null
      },
      { timeoutMs: 15_000, what: 'review 门超时升级' },
    )
    expect(escalated.gate?.status).toBe('raised') // 未放行
    expect(escalated.gate?.decision).toBeNull()
    const inbox = platform.notifications.inbox('admin')
    expect(inbox.some((n) => n.kind === 'gate-escalated' && n.priority === 'critical')).toBe(true)
  })
})

describe('门禁：交付门 fail-closed（合入前复核就绪条件）', () => {
  it('未就绪时 merge 被拒（not-ready），approve 动作非法', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')
    await waitForGate(platform, taskId, 'test')
    await decide(platform, taskId, 'wanghao', 'approve')

    // deliver：MR 创建后（watching 是瞬态：就绪即举交付门）
    const watching = await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建' })

    // 注入一条需人决策的评审意见（needs-human → watcher 举 fact 门）
    await platform.mrPlatform.addComment(watching.mr!.mrId, {
      author: '孙琳',
      text: '安全要求：推送内容必须先过敏感词过滤，阻塞合入',
      kind: 'review-comment',
      sha: watching.mr!.sha,
      triage: 'needs-human',
    })
    const feedbackGate = await waitForGate(platform, taskId, 'fact')
    expect(feedbackGate.question).toContain('需你决策')

    // 就绪未满足时，若直接在 delivery 门上 merge 会失败——这里通过「举不了 delivery 门」+ readiness 校验验证
    const readiness = await platform.mergeReadiness(taskId)
    expect(readiness.ready).toBe(false)
    expect(readiness.allFeedbackDigested).toBe(false)

    // waive 这条反馈 → 流水线绿 → 举交付门
    await decide(platform, taskId, 'wanghao', 'approve', { reason: '敏感词过滤下个迭代处理，留痕' })
    const deliveryGate = await waitForGate(platform, taskId, 'delivery')
    expect(deliveryGate.soleDecider.userId).toBe('zhoujie') // 合入方拍板

    // 交付门没有 approve 语义（只有 merge）
    await expect(
      decideGate(platform, taskId, { stateVersion: (await stateOf(platform, taskId)).stateVersion, action: 'approve', asUserId: 'zhoujie' }),
    ).rejects.toThrow(/永远人工/)
  })
})

describe('门禁：门材料同屏（反盲签）', () => {
  it('decision 卡携带 preface/context/materials 非空', async () => {
    const st = await createDemoTask(platform, { scenario: 'clean' })
    const taskId = st.taskId
    const gate = await waitForGate(platform, taskId, 'fact')
    expect(gate.preface.length).toBeGreaterThan(10)
    expect(gate.context.length).toBeGreaterThan(10)
    expect(gate.materials.length).toBeGreaterThan(0)
    expect(gate.materials[0].content).toBeTruthy()
  })
})
