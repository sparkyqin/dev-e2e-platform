import { describe, expect, it } from 'vitest'
import { applyAdvance, applyRollback, canAdvance, canRollbackTo, isReentry, stageIndex } from '../src/domain/state-machine.js'
import type { TaskState } from '@ai-platform/shared'

function baseState(): TaskState {
  return {
    schemaVersion: 1,
    taskId: 'task-999',
    seq: 999,
    title: 't',
    module: 'm',
    repo: 'r',
    requirementText: 'req',
    mode: 'incremental',
    paradigm: 'single-center',
    playbookId: 'default',
    stage: 'intake',
    status: 'running',
    stateVersion: 1,
    currentStepIndex: 1,
    createdAt: '',
    updatedAt: '',
    stageRounds: { intake: 1 },
    completedStages: [],
    repairRounds: 0,
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

describe('状态机：顺序推进', () => {
  it('intake → clarify → … → deliver → merged 全链可推进（9 阶段）', () => {
    const s = baseState()
    const path = ['clarify', 'architecture', 'design', 'test-design', 'review', 'code', 'verify', 'deliver', 'merged'] as const
    let prev: (typeof path)[number] | 'intake' = 'intake'
    for (const st of path) {
      expect(canAdvance(prev, st)).toBe(true)
      applyAdvance(s, st)
      expect(s.stage).toBe(st)
      prev = st
    }
    expect(s.completedStages).toContain('intake')
    expect(s.completedStages).toContain('architecture')
    expect(s.completedStages).toContain('test-design')
    expect(s.completedStages).toContain('deliver')
    expect(s.stageRounds.merged).toBe(1)
  })

  it('跳段推进非法', () => {
    expect(canAdvance('intake', 'design')).toBe(false)
    expect(canAdvance('clarify', 'design')).toBe(false) // 必须先过 architecture
    expect(canAdvance('architecture', 'review')).toBe(false) // 必须先过 design/test-design
    expect(() => applyAdvance(baseState(), 'code')).toThrow(/非法推进/)
  })

  it('终态 merged 无下一阶段', () => {
    expect(canAdvance('merged', 'intake')).toBe(false)
    expect(stageIndex('merged')).toBe(10)
  })
})

describe('状态机：声明式回退', () => {
  it('verify → code 修复环', () => {
    const s = baseState()
    for (const st of ['clarify', 'architecture', 'design', 'test-design', 'review', 'code', 'verify'] as const) applyAdvance(s, st)
    applyRollback(s, 'code', '验证不通过')
    expect(s.stage).toBe('code')
    expect(s.repairRounds).toBe(1)
    expect(s.status).toBe('queued')
    expect(s.completedStages).not.toContain('code')
    expect(s.completedStages).not.toContain('verify')
    expect(isReentry(s, 'code')).toBe(true)
  })

  it('review → clarify 跨段回退截断完成集（intake 已完成仍保留）', () => {
    const s = baseState()
    for (const st of ['clarify', 'architecture', 'design', 'test-design', 'review'] as const) applyAdvance(s, st)
    applyRollback(s, 'clarify', '需求歧义')
    expect(s.completedStages).toEqual(['intake']) // 回退目标之前的完成记录保留
    expect(s.stageRounds.clarify).toBe(2)
  })

  it('review → test-design 单段回退（新阶段图的细粒度回退）', () => {
    const s = baseState()
    for (const st of ['clarify', 'architecture', 'design', 'test-design', 'review'] as const) applyAdvance(s, st)
    applyRollback(s, 'test-design', '测试点覆盖不足')
    expect(s.stage).toBe('test-design')
    expect(s.completedStages).toEqual(['intake', 'clarify', 'architecture', 'design'])
  })

  it('回退边表：design 不能直接回退到 code', () => {
    expect(canRollbackTo('design', 'code')).toBe(false)
    expect(canRollbackTo('design', 'architecture')).toBe(true) // design → architecture 合法
    expect(canRollbackTo('architecture', 'clarify')).toBe(true)
    expect(canRollbackTo('deliver', 'code')).toBe(true)
    expect(canRollbackTo('merged', 'code')).toBe(true) // 合入后问题回退环
    expect(canRollbackTo('intake', 'clarify')).toBe(false)
  })

  it('非法回退边抛错', () => {
    const s = baseState()
    applyAdvance(s, 'clarify')
    expect(() => applyRollback(s, 'code', 'x')).toThrow(/非法回退/)
  })
})
