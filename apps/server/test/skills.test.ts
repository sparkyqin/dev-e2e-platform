import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillLibrary } from '../src/extension/skills.js'

const dirs: string[] = []

async function tmpLib(): Promise<SkillLibrary> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'skill-test-'))
  dirs.push(dir)
  const lib = new SkillLibrary(path.join(dir, 'assets'))
  await lib.init()
  return lib
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
})

const evidence = {
  annotations: ['推送频率太高，要加限流'],
  rollbackReasons: [],
  feedbackTexts: ['测试边界没覆盖月末切换'],
  decisions: [],
  repo: 'membership-center',
  module: 'membership-points',
}

describe('技能沉淀闭环（场景10：候选不自动生效，人采纳）', () => {
  it('proposeCandidates 提炼候选，但不进正式技能架', async () => {
    const lib = await tmpLib()
    const fresh = await lib.proposeCandidates(evidence, 'task-101')
    expect(fresh.length).toBeGreaterThanOrEqual(2) // 推送限流 + 边界用例
    expect((await lib.candidates()).length).toBe(fresh.length)
    expect(await lib.active()).toEqual([]) // 关键：候选不自动生效
  })

  it('幂等：重复提案同名候选不重复', async () => {
    const lib = await tmpLib()
    await lib.proposeCandidates(evidence, 'task-101')
    const again = await lib.proposeCandidates(evidence, 'task-102')
    expect(again).toEqual([])
    expect((await lib.candidates()).length).toBe(2)
  })

  it('采纳后版本 1 进正式架，候选池清空，审计留痕', async () => {
    const lib = await tmpLib()
    const [cand] = await lib.proposeCandidates(evidence, 'task-101')
    const adopted = await lib.adopt(cand.id, 'wanghao', '王浩')
    expect(adopted.status).toBe('active')
    expect(adopted.version).toBe(1)
    expect((await lib.active()).map((s) => s.id)).toContain(cand.id)
    expect(await lib.candidates()).toHaveLength(1) // 仅移除被采纳者，另一候选保留
    const audit = await lib.auditLog()
    expect(audit.some((a) => a.action === 'adopted' && a.skillId === cand.id)).toBe(true)
  })

  it('拒绝候选：留痕不生效', async () => {
    const lib = await tmpLib()
    const [cand] = await lib.proposeCandidates(evidence, 'task-101')
    await lib.reject(cand.id, 'wanghao', '王浩', '与现有技能重复')
    expect(await lib.active()).toEqual([])
    const rejected = (await lib.candidates()).find((c) => c.id === cand.id)
    expect(rejected?.status).toBe('rejected')
  })

  it('物化：active 技能写入工作区 host-skills/ 快照（版本随行）', async () => {
    const lib = await tmpLib()
    const [cand] = await lib.proposeCandidates(evidence, 'task-101')
    await lib.adopt(cand.id, 'wanghao', '王浩')
    const ws = await fs.mkdtemp(path.join(tmpdir(), 'ws-'))
    dirs.push(ws)
    const injected = await lib.materialize(ws, 'membership-center', 'membership-points')
    expect(injected.map((s) => s.id)).toContain(cand.id)
    const file = path.join(ws, 'host-skills', `${cand.name}.md`)
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain(`v1`)
    expect(text).toContain(cand.guidance.slice(0, 20))
  })

  it('错技能回滚：deprecate 留痕不物理删除', async () => {
    const lib = await tmpLib()
    const [cand] = await lib.proposeCandidates(evidence, 'task-101')
    const adopted = await lib.adopt(cand.id, 'wanghao', '王浩')
    await lib.deprecate(adopted.id, 'wanghao', '王浩', '规则已过时')
    const all = await lib.all()
    const dep = all.find((s) => s.id === adopted.id)
    expect(dep?.status).toBe('deprecated')
    expect(dep?.version).toBe(2)
    expect(await lib.active()).toEqual([])
  })
})
