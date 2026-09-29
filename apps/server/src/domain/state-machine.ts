import { STAGE_ORDER, STAGES, isRollbackTarget } from '@ai-platform/shared'
import type { RollbackTarget, StageId, TaskState } from '@ai-platform/shared'
import { TaskNotFoundError } from './task-store.js'

/**
 * 六段状态机（附录 A / L2 内核主干 · 对齐愿景图：设计段 4 + 执行段 1 + 终态）
 *
 * 阶段顺序与退出条件平台兜底；支持：
 *  - 顺序推进 advance()
 *  - 声明式回退 rollbackTo()（驳回时直接指定退回到哪一步，而非从头重跑）
 *  - 回退环：execute→execute（验证/反馈修复模式）、merged→execute（合入后问题）
 *  - execute 段内循环（编码→验证→交付）由 workers 以 .flow/execute-phase.json 检查点驱动，不是阶段边界
 */

export class IllegalTransitionError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'IllegalTransitionError'
  }
}

/** 合法顺序边 */
const FORWARD: Record<StageId, StageId | null> = {
  requirement: 'architecture',
  architecture: 'design',
  design: 'test-design',
  'test-design': 'execute',
  execute: 'merged',
  merged: null,
}

/** 回退边（声明式回退 + 修复环；execute→execute 为段内修复模式，test-design→test-design 为评审驳回重做测试设计） */
const ROLLBACK_EDGES: Record<StageId, StageId[]> = {
  requirement: [],
  architecture: ['requirement'],
  design: ['requirement', 'architecture'],
  'test-design': ['requirement', 'architecture', 'design', 'test-design'],
  execute: ['requirement', 'architecture', 'design', 'test-design', 'execute'],
  merged: ['execute'],
}

export function stageIndex(stage: StageId): number {
  return STAGE_ORDER.indexOf(stage) + 1
}

export function nextStage(stage: StageId): StageId | null {
  return FORWARD[stage]
}

export function canAdvance(from: StageId, to: StageId): boolean {
  return FORWARD[from] === to
}

export function canRollbackTo(from: StageId, to: StageId): boolean {
  return ROLLBACK_EDGES[from].includes(to)
}

/** 应用推进：记录轮次与完成集 */
export function applyAdvance(state: TaskState, to: StageId): void {
  const from = state.stage
  if (!canAdvance(from, to)) {
    throw new IllegalTransitionError(`非法推进：${from} → ${to}`)
  }
  if (from !== 'merged' && !state.completedStages.includes(from)) {
    state.completedStages.push(from)
  }
  state.stage = to
  state.currentStepIndex = stageIndex(to)
  state.stageRounds[to] = (state.stageRounds[to] ?? 0) + 1
  state.gate = null
}

/**
 * 应用声明式回退：
 *  - 阶段跳到目标（paused 再进入不重跑 AI：reentry 标记由 stageRounds 体现）
 *  - 完成集截断到目标之前
 *  - 修复轮次 +1（对抗式修复闭环预算）
 */
export function applyRollback(state: TaskState, target: StageId | RollbackTarget, reason: string): void {
  if (!isRollbackTarget(target) && !STAGE_ORDER.includes(target as StageId)) {
    throw new IllegalTransitionError(`非法回退目标：${target}`)
  }
  const from = state.stage
  if (!canRollbackTo(from, target as StageId)) {
    throw new IllegalTransitionError(`非法回退边：${from} → ${target}`)
  }
  const targetIdx = STAGE_ORDER.indexOf(target as StageId)
  state.completedStages = state.completedStages.filter((s) => STAGE_ORDER.indexOf(s) < targetIdx)
  state.stage = target as StageId
  state.currentStepIndex = stageIndex(target as StageId)
  state.stageRounds[target as StageId] = (state.stageRounds[target as StageId] ?? 0) + 1
  state.repairRounds += 1
  state.gate = null
  state.status = 'queued'
  state.lifecycleNote = undefined
}

/** 阶段是否为回退重做（paused 再进入不重跑 AI 的判定依据） */
export function isReentry(state: TaskState, stage: StageId): boolean {
  return (state.stageRounds[stage] ?? 0) > 1
}

export function stageMeta(stage: StageId) {
  return STAGES[stage]
}

export function assertTaskActive(state: TaskState): void {
  if (state.status === 'merged' || state.status === 'archived') {
    throw new TaskNotFoundError(state.taskId)
  }
}
