import type { HealthLevel, StageId } from './task.js'
import type { GateAction, GateKind } from './gates.js'
import type { Partition } from './artifacts.js'

/**
 * 语义事件流（附录 F · [机-语义事件流]）
 *
 * 16 类语义事件统一描述所有过程——看一种流就能回看任何阶段。
 * 事件按任务持久化为 append-only JSONL，可重放（[机-重启恢复]、任务历程 TaskJourney）。
 */
export const SEMANTIC_EVENT_KINDS = [
  'session_started',
  'session_ended',
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'stage_entered',
  'stage_exited',
  'gate_raised',
  'gate_decided',
  'rollback',
  'takeover',
  'artifact_written',
  'health_changed',
  'subtask_spawned',
  'subtask_completed',
] as const

export type SemanticEventKind = (typeof SEMANTIC_EVENT_KINDS)[number]

export interface EventActor {
  type: 'human' | 'ai' | 'system'
  userId?: string
  name?: string
  engine?: string
}

// ---- 各类事件 payload ----

export interface SessionStartedPayload {
  sessionId: string
  engine: string
  autonomy: 'auto' | 'human'
  purpose: string
}

export interface SessionEndedPayload {
  sessionId: string
  reason: 'completed' | 'interrupted' | 'failed'
  summary: string
}

export interface UserMessagePayload {
  text: string
  source: 'chat' | 'instruction' | 'gate-answer'
}

export interface AssistantMessagePayload {
  text: string
  sessionId?: string
}

export interface ToolCallPayload {
  callId: string
  tool: string
  input: string
}

export interface ToolResultPayload {
  callId: string
  tool: string
  ok: boolean
  summary: string
}

export interface StageEnteredPayload {
  stage: StageId
  reentry: boolean
  round: number
}

export interface StageExitedPayload {
  stage: StageId
  reason: 'completed' | 'rollback-out' | 'gate-reject'
  round: number
}

export interface GateRaisedPayload {
  gateId: string
  gateKind: GateKind
  question: string
  digest: string
}

export interface GateDecidedPayload {
  gateId: string
  action: GateAction
  decidedBy: string
  decidedByName: string
}

export interface RollbackPayload {
  from: StageId
  to: StageId
  reason: string
  declaredBy: string
  declaredByName: string
  reentrySkipsAiRerun: boolean
}

export interface TakeoverPayload {
  direction: 'human' | 'auto'
  /** interrupt=被人中断（区别于 AI 出错失败）；resume=显式恢复自动 */
  via: 'interrupt' | 'resume'
  note?: string
}

export interface ArtifactWrittenPayload {
  path: string
  partition: Partition
  bytes: number
  sovereignRole?: string
}

export interface HealthChangedPayload {
  from: HealthLevel
  to: HealthLevel
  facts: string[]
}

/** AR 拆分派发：父任务 spawn 子任务（落到父任务事件流；子任务流同步留痕） */
export interface SubtaskSpawnedPayload {
  parentTaskId: string
  subtaskTaskId: string
  arTitle: string
  /** 第几个 AR（从 1 开始） */
  index: number
  totalSubtasks: number
  /** 子任务责任人（开发轮转分配） */
  ownerName: string
}

/** AR 子任务合入：父任务观察到的完成（含聚合进度） */
export interface SubtaskCompletedPayload {
  parentTaskId: string
  subtaskTaskId: string
  arTitle: string
  mergedCount: number
  totalSubtasks: number
}

export interface SemanticEventPayloadMap {
  session_started: SessionStartedPayload
  session_ended: SessionEndedPayload
  user_message: UserMessagePayload
  assistant_message: AssistantMessagePayload
  tool_call: ToolCallPayload
  tool_result: ToolResultPayload
  stage_entered: StageEnteredPayload
  stage_exited: StageExitedPayload
  gate_raised: GateRaisedPayload
  gate_decided: GateDecidedPayload
  rollback: RollbackPayload
  takeover: TakeoverPayload
  artifact_written: ArtifactWrittenPayload
  health_changed: HealthChangedPayload
  subtask_spawned: SubtaskSpawnedPayload
  subtask_completed: SubtaskCompletedPayload
}

export interface SemanticEvent<K extends SemanticEventKind = SemanticEventKind> {
  /** 任务内单调递增序号 */
  seq: number
  ts: string
  taskId: string
  kind: K
  stage: StageId
  actor: EventActor
  payload: SemanticEventPayloadMap[K]
}

/** 事件流查询过滤（场景5：会话流「只看工具调用」过滤） */
export interface EventFilter {
  kinds?: SemanticEventKind[]
  toolsOnly?: boolean
  afterSeq?: number
}
