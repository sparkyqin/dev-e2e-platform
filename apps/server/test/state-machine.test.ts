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
    stage: 'requirement',
    status: 'running',
    stateVersion: 1,
    currentStepIndex: 1,
    createdAt: '',
    updatedAt: '',
    stageRounds: { requirement: 1 },
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
  it('requirement → architecture → … → execute → merged 全链可推进（六段）', () => {
    const s = baseState()
    const path = ['architecture', 'design', 'test-design', 'execute', 'merged'] as const
    let prev: (typeof path)[number] | 'requirement' = 'requirement'
    for (const st of path) {
      expect(canAdvance(prev, st)).toBe(true)
      applyAdvance(s, st)
      expect(s.stage).toBe(st)
      prev = st
    }
    expect(s.completedStages).toContain('requirement')
    expect(s.completedStages).toContain('architecture')
    expect(s.completedStages).toContain('test-design')
    expect(s.completedStages).toContain('execute')
    expect(s.stageRounds.merged).toBe(1)
  })

  it('跳段推进非法', () => {
    expect(canAdvance('requirement', 'design')).toBe(false)
    expect(canAdvance('architecture', 'test-design')).toBe(false) // 必须先过 design
    expect(canAdvance('design', 'execute')).toBe(false) // 必须先过 test-design
    expect(() => applyAdvance(baseState(), 'execute')).toThrow(/非法推进/)
  })

  it('终态 merged 无下一阶段', () => {
    expect(canAdvance('merged', 'requirement')).toBe(false)
    expect(stageIndex('merged')).toBe(6)
  })
})

describe('状态机：声明式回退', () => {
  it('execute → execute 段内修复环（验证/反馈打回重编码，不丢设计段完成集）', () => {
    const s = baseState()
    for (const st of ['architecture', 'design', 'test-design', 'execute'] as const) applyAdvance(s, st)
    applyRollback(s, 'execute', '验证不通过')
    expect(s.stage).toBe('execute')
    expect(s.repairRounds).toBe(1)
    expect(s.status).toBe('queued')
    expect(s.completedStages).not.toContain('execute')
    expect(s.completedStages).toEqual(['requirement', 'architecture', 'design', 'test-design']) // 设计段完成集保留
    expect(isReentry(s, 'execute')).toBe(true)
  })

  it('test-design → requirement 跨段回退截断完成集', () => {
    const s = baseState()
    for (const st of ['architecture', 'design', 'test-design'] as const) applyAdvance(s, st)
    applyRollback(s, 'requirement', '需求歧义')
    expect(s.completedStages).toEqual([]) // 回退目标之前的完成记录保留（requirement 是第一段）
    expect(s.stageRounds.requirement).toBe(2)
  })

  it('test-design → test-design 自回环（评审门驳回重做测试设计）', () => {
    const s = baseState()
    for (const st of ['architecture', 'design', 'test-design'] as const) applyAdvance(s, st)
    applyRollback(s, 'test-design', '测试点覆盖不足')
    expect(s.stage).toBe('test-design')
    expect(s.completedStages).toEqual(['requirement', 'architecture', 'design'])
  })

  it('回退边表：设计段全谱 + 执行段修复环 + 合入后回退', () => {
    expect(canRollbackTo('design', 'execute')).toBe(false)
    expect(canRollbackTo('design', 'architecture')).toBe(true) // design → architecture 合法
    expect(canRollbackTo('architecture', 'requirement')).toBe(true)
    expect(canRollbackTo('execute', 'execute')).toBe(true) // 段内修复环
    expect(canRollbackTo('execute', 'requirement')).toBe(true) // 一步回退到源头
    expect(canRollbackTo('merged', 'execute')).toBe(true) // 合入后问题回退环
    expect(canRollbackTo('requirement', 'requirement')).toBe(false) // 第一段无自回环（无更早目标）
  })

  it('非法回退边抛错', () => {
    const s = baseState()
    applyAdvance(s, 'architecture')
    expect(() => applyRollback(s, 'execute', 'x')).toThrow(/非法回退/)
  })
})
