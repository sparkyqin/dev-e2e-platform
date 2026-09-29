import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makePlatform, stateOf, waitFor } from './helpers.js'
import type { Platform } from '../src/orchestrator/platform.js'
import type { TaskState } from '@ai-platform/shared'
import { readDecisionRecords } from '../src/domain/util.js'

/**
 * 2026-09 修复回归（分析报告 P0 系列）：
 * - 并发建任务不撞 seq / 不互相覆盖（createMutex + withLock(create)）
 * - 待追认闭环：resolve API 写 finalAnswer/resolvedAt + 决策记录留痕 + 重复追认被拒
 * - 真源损坏不再静默蒸发：readJson 抛 CorruptFileError + .corrupt 侧车保全
 * - atomicWrite 失败如实抛错（无静默非原子覆写）
 */

let ctx: Awaited<ReturnType<typeof makePlatform>>
let platform: Platform

beforeAll(async () => {
  ctx = await makePlatform()
  platform = ctx.platform
})

afterAll(async () => {
  await ctx.dispose()
})

describe('P0#1 并发建任务：seq 分配不冲突', () => {
  it('8 个并发 createTask → 8 个唯一 taskId、互不覆盖', async () => {
    const reqs = Array.from({ length: 8 }, (_, i) =>
      platform.createTask({
        title: `并发任务 ${i}`,
        requirementText: '验证并发建任务不撞 seq',
        module: 'concurrency',
        repo: 'demo',
        mode: 'incremental',
        playbookId: 'fast',
        people: {},
        unattended: false,
        engineId: 'simulated',
        scenario: 'clean',
      } as Parameters<Platform['createTask']>[0]),
    )
    const states = await Promise.all(reqs)
    const ids = states.map((s) => s.taskId)
    expect(new Set(ids).size).toBe(8) // 无 taskId 冲突
    const seqs = states.map((s) => s.seq)
    expect(new Set(seqs).size).toBe(8) // 无 seq 重复

    // 落盘互不覆盖：每个 taskId 的 state.json 都能读到且 taskId 自洽
    for (const st of states) {
      const raw = JSON.parse(await fs.readFile(path.join(platform.store.flowDir(st.taskId), 'state.json'), 'utf8')) as TaskState
      expect(raw.taskId).toBe(st.taskId)
    }
  })
})

describe('P0#2 待追认闭环：降级 → 追认 API', () => {
  it('resolve 写 finalAnswer/resolvedBy + 决策记录；重复追认 409', async () => {
    // fast playbook 事实门 300ms 超时 → 降级 → pendingConfirmations
    const st = await platform.createTask({
      title: '积分过期提醒（追认闭环验证）',
      requirementText: '会员积分快过期前发提醒，过期清零留痕',
      module: 'membership-points',
      repo: 'membership-center',
      mode: 'incremental',
      playbookId: 'fast',
      people: {},
      unattended: false,
      engineId: 'simulated',
      scenario: 'clean',
    } as Parameters<Platform['createTask']>[0])

    const degraded = await waitFor(
      async () => {
        const s = await stateOf(platform, st.taskId)
        return s.pendingConfirmations.length > 0 ? s : null
      },
      { timeoutMs: 30_000, what: '事实门超时降级（pendingConfirmations 出现）' },
    )
    const pc = degraded.pendingConfirmations[0]
    expect(pc.resolvedAt).toBeUndefined()

    // 追认：需求方身份
    const after = await platform.resolvePendingConfirmation(st.taskId, pc.id, '积分按滚动 365 天过期，清零时点为次月 1 日', 'zhangming')
    const resolved = after.pendingConfirmations.find((p) => p.id === pc.id)!
    expect(resolved.resolvedAt).toBeTruthy()
    expect(resolved.resolvedBy).toBe('张明')
    expect(resolved.finalAnswer).toContain('滚动 365 天')

    // 决策记录留痕（追认落 decisions.json，degraded=false）
    const decisions = await readDecisionRecords(path.join(platform.store.taskDir(st.taskId), 'process', 'decisions.json'))
    expect(decisions.some((d) => d.decision.includes('滚动 365 天') && d.degraded === false)).toBe(true)

    // 重复追认被拒（409 知情）
    await expect(platform.resolvePendingConfirmation(st.taskId, pc.id, '再答一次', 'zhangming')).rejects.toMatchObject({
      status: 409,
    })
  })
})

describe('P0#4 真源损坏：响亮失败 + 现场保全', () => {
  it('readJson 对损坏 JSON 抛 CorruptFileError 且写 .corrupt 侧车', async () => {
    const { readJson, CorruptFileError } = await import('../src/domain/util.js')
    const file = path.join(ctx.dir, 'corrupt-probe.json')
    await fs.writeFile(file, '{"broken": ', 'utf8')
    await expect(readJson(file)).rejects.toBeInstanceOf(CorruptFileError)
    // 不存在的文件仍是正常缺省（null），不是错误
    await expect(readJson(path.join(ctx.dir, 'no-such.json'))).resolves.toBeNull()
    // 侧车保全（.corrupt-* 前缀）
    const siblings = await fs.readdir(ctx.dir)
    expect(siblings.some((f) => f.startsWith('corrupt-probe.json.corrupt-'))).toBe(true)
  })

  it('readJsonTolerant 对损坏按缺省（缓存/派生数据语义）', async () => {
    const { readJsonTolerant } = await import('../src/domain/util.js')
    const file = path.join(ctx.dir, 'corrupt-cache.json')
    await fs.writeFile(file, 'not json at all', 'utf8')
    await expect(readJsonTolerant(file)).resolves.toBeNull()
  })
})

describe('P1#7 技能作用域 AND 匹配', () => {
  it('repo 命中但 module 不命中 → 不注入；双命中 → 注入', async () => {
    const { SkillLibrary } = await import('../src/extension/skills.js')
    const { writeJson } = await import('../src/domain/util.js')
    const lib = new SkillLibrary(ctx.dir)
    await lib.init()
    // 直接写库文件：repoA 无 module 限制 / repoB+moduleB 双限制（active 技能）
    const libFile = path.join(ctx.dir, 'skills', 'library.json')
    await writeJson(libFile, {
      version: 2,
      skills: [
        { id: 'skill_a', name: 'SA', pattern: 'p', guidance: 'g', scope: { repo: 'repoA' }, status: 'active', version: 1, sourceTaskId: 't', proposedAt: '', proposedBy: 'x' },
        { id: 'skill_b', name: 'SB', pattern: 'p', guidance: 'g', scope: { repo: 'repoB', module: 'moduleB' }, status: 'active', version: 1, sourceTaskId: 't', proposedAt: '', proposedBy: 'x' },
      ],
    })

    const ws = path.join(ctx.dir, 'ws-and-test')
    await fs.mkdir(ws, { recursive: true })
    // repoB + moduleC（module 不命中）→ skill_b 不该注入（旧 OR 实现会注入：module 未配即放行）
    let injected = await lib.materialize(ws, 'repoB', 'moduleC')
    expect(injected.map((s) => s.id)).not.toContain('skill_b')
    // repoB + moduleB（双命中）→ 注入
    injected = await lib.materialize(ws, 'repoB', 'moduleB')
    expect(injected.map((s) => s.id)).toContain('skill_b')
  })
})
