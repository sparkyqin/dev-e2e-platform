import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StageId } from '@ai-platform/shared'
import { isDeclaredOutputPath } from '@ai-platform/shared'
import { approveDesignGates, createDemoTask, decide, makePlatform, stateOf, waitFor, waitForGate, waitForStatus } from './helpers.js'
import type { Platform } from '../src/orchestrator/platform.js'
import { git, deliveryDirOf } from '../src/runtime/git.js'

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
 * E2E 主线（场景1→7 全链路）：一句话需求 → 基线 → 事实门 → 架构门 → 方案拍板 → 测试设计门 →
 * 方案评审 → 编码 → 多维评审 + Critic + 构建 + 测试 → 测试门 → MR 监听 → 流水线真绿 → 交付门 → 合入。
 */
describe('E2E：需求→合入（clean 剧本 · fast playbook）', () => {
  const answers: string[] = []

  it('全链路推进到 merged 终态', async () => {
    const st = await createDemoTask(platform, { playbookId: 'fast', scenario: 'clean' })
    const taskId = st.taskId

    // ① 事实门：需求方作答
    await waitForGate(platform, taskId, 'fact')
    answers.push('积分按自然月过期，次月 1 日清零；「即将过期」=未来 30 天内将清零')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: answers[0] })

    // ② 设计段三门：架构（架构师）→ 功能方案（开发）→ 测试设计（TSE）
    const archGate = await waitForGate(platform, taskId, 'fact')
    expect(archGate.soleDecider.userId).toBe('chenshu') // 架构门=架构师
    await decide(platform, taskId, 'chenshu', 'approve')
    const designGate = await waitForGate(platform, taskId, 'fact')
    expect(designGate.soleDecider.userId).toBe('wanghao') // 方案确认=开发
    await decide(platform, taskId, 'wanghao', 'approve')
    const testDesignGate = await waitForGate(platform, taskId, 'fact')
    expect(testDesignGate.soleDecider.userId).toBe('wuqian') // 测试设计门=TSE
    await decide(platform, taskId, 'wuqian', 'approve')

    // ③ 方案评审：评审人放行
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')

    // ④ 测试门：责任人认可（fast：功能正确性/安全性 + Critic + build + test）
    await waitForGate(platform, taskId, 'test')
    await decide(platform, taskId, 'wanghao', 'approve')

    // ⑤ MR 创建（watching 是瞬态：就绪后立即举交付门）
    const withMr = await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建' })
    expect(withMr.mr!.branch).toBe(`feature/task-${st.seq}`)
    expect(withMr.mr!.sha).toMatch(/^[0-9a-f]{40}$/)

    // ⑥ 远端流水线自动跑（watcher 模拟 CI）→ 就绪 → 交付门
    const deliveryGate = await waitForGate(platform, taskId, 'delivery')
    expect(deliveryGate.question).toContain('合入')
    expect(deliveryGate.soleDecider.userId).toBe('zhoujie')
    const readiness = await platform.mergeReadiness(taskId)
    expect(readiness.pipelineGreenOnCurrentSha).toBe(true)

    // ⑦ 合入（永远人工）
    await decide(platform, taskId, 'zhoujie', 'merge')
    const merged = await waitForStatus(platform, taskId, 'merged', 10_000)
    expect(merged.stage).toBe('merged')

    // MR 远端状态
    const mr = platform.mrPlatform.get(merged.mr!.mrId)
    expect(mr?.state).toBe('merged')
  }, 120_000)

  it('语义事件流完整可回放（14 类核心事件覆盖主线）', async () => {
    const all = await platform.store.listAll()
    const target = all.find((s) => s.status === 'merged')
    expect(target).toBeTruthy()
    const events = await platform.store.eventLog(target!.taskId).read()

    const kinds = new Set(events.map((e) => e.kind))
    // clean 主线事件（health_changed/rollback/takeover 属摩擦场景，见 e2e-scenarios）
    for (const k of ['session_started', 'session_ended', 'assistant_message', 'tool_call', 'tool_result', 'stage_entered', 'stage_exited', 'gate_raised', 'gate_decided', 'artifact_written']) {
      expect(kinds.has(k as (typeof events)[number]['kind'])).toBe(true)
    }
    // seq 单调递增（append-only）
    const seqs = events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    // 每个阶段都有 stage_entered（v2 六段：requirement 含基线+分解两个段内作业）
    for (const stage of ['requirement', 'architecture', 'design', 'test-design', 'execute']) {
      expect(events.some((e) => e.kind === 'stage_entered' && (e.payload as { stage: string }).stage === stage)).toBe(true)
    }
  })

  it('产物与阶段注册表一致（引擎/平台写盘 ⊆ STAGES 声明，单源不漂移）', async () => {
    const merged = (await platform.store.listAll()).find((s) => s.status === 'merged')
    expect(merged).toBeTruthy()
    const events = await platform.store.eventLog(merged!.taskId).read()

    // 平台元数据/知识回流区不属于阶段产物（按阶段注册表口径豁免）；其余全部必须可溯源到声明
    const EXEMPT = (p: string): boolean =>
      p === 'process/annotations.json' || p.startsWith('knowledge/') || p.startsWith('host-skills/')

    const written = events.filter((e) => e.kind === 'artifact_written')
    expect(written.length).toBeGreaterThan(5) // 主线产物足够多，断言有意义
    const undeclared: string[] = []
    for (const e of written) {
      const p = e.payload as { path: string }
      if (EXEMPT(p.path)) continue
      if (!isDeclaredOutputPath(e.stage as StageId, p.path)) undeclared.push(`${e.stage}: ${p.path}`)
    }
    expect(undeclared, `未在 STAGES 注册表声明（packages/shared/src/stages.ts）：${undeclared.join('、')}`).toEqual([])

    // 关键产物确实被声明过（防全豁免导致的假绿）
    const w = (stage: string, p: string): boolean => written.some((e) => e.stage === stage && (e.payload as { path: string }).path === p)
    expect(w('requirement', 'process/baseline.md'), 'requirement 应产出基线（intake 作业）').toBe(true)
    expect(w('requirement', 'process/decisions.json'), 'requirement 应产出决策记录（clarify 作业）').toBe(true)
    expect(w('requirement', 'delivery/requirement.md'), 'requirement 应产出需求分析 SPEC（clarify 作业，交付区）').toBe(true)
    expect(w('architecture', 'delivery/architecture.md'), 'architecture 应产出架构 SPEC').toBe(true)
    expect(w('design', 'delivery/contract/api-contract.json'), 'design 应产出契约单源').toBe(true)
    expect(w('execute', 'process/ar-design.md'), 'execute 应产出 AR 级设计摘要（ar-design 作业）').toBe(true)
    expect(w('execute', 'process/test-cases.md'), 'execute 应产出测试用例集（测试轨①）').toBe(true)
    expect(w('execute', 'process/test-r1.md'), 'execute 应产出测试报告（验证小节）').toBe(true)
    expect(
      written.some((e) => e.stage === 'execute' && (e.payload as { path: string }).path.startsWith('delivery/src/')),
      'execute 应产出实现代码（编码小节）',
    ).toBe(true)
    expect(
      written.some((e) => e.stage === 'execute' && (e.payload as { path: string }).path.startsWith('delivery/test/auto/')),
      'execute 应产出自动化用例（测试轨③）',
    ).toBe(true)
  })

  it('产物分区：过程区不入 git，交付区含 spec/契约/代码', async () => {
    const merged = (await platform.store.listAll()).find((s) => s.status === 'merged')
    expect(merged).toBeTruthy()
    const ddir = deliveryDirOf(platform.store.taskDir(merged!.taskId))

    const ls = await git(ddir, 'ls-files')
    const files = ls.out.split('\n').filter(Boolean)
    expect(files.some((f) => f === 'requirement.md' || f.endsWith('/requirement.md'))).toBe(true)
    expect(files.some((f) => f === 'spec.md' || f.endsWith('/spec.md') || f.startsWith('spec'))).toBe(true)
    expect(files.some((f) => f.includes('api-contract.json'))).toBe(true)
    expect(files.some((f) => f.startsWith('src/'))).toBe(true)
    expect(files.some((f) => f.startsWith('test/auto/'))).toBe(true) // 测试轨自动化用例入 git
    // 过程区物理隔离：baseline/评审报告不在 git 内
    expect(files.every((f) => !f.startsWith('../process') && !f.includes('baseline.md'))).toBe(true)
    expect(await git(ddir, 'cat-file', '-e', 'HEAD:baseline.md').then((r) => r.ok)).toBe(false)

    // 真源状态机文件在 .flow/，不在交付仓内
    expect(files.every((f) => !f.includes('.flow'))).toBe(true)
  })

  it('任务历程（TaskJourney）可从事件流重建', async () => {
    const merged = (await platform.store.listAll()).find((s) => s.status === 'merged')
    const journey = await platform.store.eventLog(merged!.taskId).journey()
    expect(journey.length).toBeGreaterThan(10)
    expect(journey.some((j) => j.kind === 'gate_decided')).toBe(true)
  })

  it('技能沉淀：合入后从证据提炼候选（不自动生效）', async () => {
    const merged = (await platform.store.listAll()).find((s) => s.status === 'merged')
    // 演示语料包含 限流/边界 关键词 → 候选提炼
    const candidates = await platform.skills.candidates()
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.status === 'candidate' && c.version === 0)).toBe(true)
    expect(await platform.skills.active()).toEqual([])
  })
})

describe('E2E：strict 剧本回退环（多维评审 FAIL → 声明式回退 → 复检 → 合入）', () => {
  it('测试充分性首轮 FAIL 触发 execute 段内修复环，修复轮复检通过后合入', async () => {
    const st = await createDemoTask(platform, { playbookId: 'strict', scenario: 'clean' })
    const taskId = st.taskId

    await waitForGate(platform, taskId, 'fact')
    await decide(platform, taskId, 'zhangming', 'answer', { answer: '按自然月过期，次月 1 日清零；30 天口径' })
    await approveDesignGates(platform, taskId)
    await waitForGate(platform, taskId, 'review')
    await decide(platform, taskId, 'zhaolei', 'approve')

    // 首轮多维评审：测试充分性 FAIL（边界未覆盖）→ execute 段内回退（编码小节修复模式）
    const rolledBack = await waitFor(
      async () => {
        const s = await stateOf(platform, taskId)
        return s.repairRounds >= 1 && s.stage === 'execute' ? s : null
      },
      { timeoutMs: 60_000, what: 'execute 段内声明式回退（修复模式）' },
    )
    expect(rolledBack.repairRounds).toBeGreaterThanOrEqual(1)
    // 修复指令已注入（持久证据：engine-runner 把 fixDirectives 记为 user_message 事件；
    // live pendingInstructions 会被编码小节在毫秒级内消费，不可断言）
    await waitFor(
      async () => {
        const msgs = await platform.store.eventLog(taskId).read({ kinds: ['user_message'] })
        return msgs.some((e) => String((e.payload as { text: string }).text).includes('修复指令')) ? msgs : null
      },
      { timeoutMs: 30_000, what: '修复指令注入留痕' },
    )
    const fixMsgs = await platform.store.eventLog(taskId).read({ kinds: ['user_message'] })
    expect(fixMsgs.some((e) => String((e.payload as { text: string }).text).includes('边界'))).toBe(true)

    const rollbacks = await waitFor(
      async () => {
        const rbs = await platform.store.eventLog(taskId).read({ kinds: ['rollback'] })
        return rbs.length > 0 ? rbs : null
      },
      { what: '回退事件留痕' },
    )
    expect(rollbacks.length).toBe(1)
    expect((rollbacks[0].payload as { from: string; to: string }).from).toBe('execute')
    expect((rollbacks[0].payload as { from: string; to: string }).to).toBe('execute')

    // 修复轮：code 完成后复检（仅失败维度回请原维度）→ test 门
    await waitForGate(platform, taskId, 'test', 90_000)
    await decide(platform, taskId, 'wanghao', 'approve')
    await waitFor(async () => {
      const s = await stateOf(platform, taskId)
      return s.mr ? s : null
    }, { what: 'MR 创建（修复轮后）' })
    await waitForGate(platform, taskId, 'delivery', 30_000)
    await decide(platform, taskId, 'zhoujie', 'merge')
    await waitForStatus(platform, taskId, 'merged', 10_000)

    // 评审报告防伪：分派 ID 存在于报告文件
    const am = new (await import('../src/extension/artifacts.js')).ArtifactManager(platform.store.taskDir(taskId))
    const reports = await (await import('node:fs/promises')).readdir(`${platform.store.taskDir(taskId)}/process/review`).catch(() => [])
    expect(reports.some((f) => f.startsWith('dim-') && f.includes('测试充分性'))).toBe(true)
    expect(reports.some((f) => f.startsWith('critic-'))).toBe(true)
    expect(await am.read('delivery/test-design.md')).toBeTruthy()
  }, 180_000)
})
