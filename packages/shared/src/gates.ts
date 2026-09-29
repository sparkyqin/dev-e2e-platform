import type { StageId, RollbackTarget } from './stages.js'

/**
 * 门禁体系（附录 F · [机-门禁·四类门]）
 *
 * 四类人工门：事实门 / 评审门 / 测试门 / 交付门。各门拍板人不同，拍板权随阶段前移。
 * 铁律：
 *  1. 铁门永不代答——无人值守也不偷偷放行（fail-closed）；
 *  2. 决策必有证据同屏——决策卡带 preface/context/材料选区，反盲签；
 *  3. 会诊单拍板——可邀请多人会诊（isInvitedReviewParticipant），但 decided_by 唯一；
 *  4. 乐观锁 state_version——并发审批先到先得，后者知情；
 *  5. 超时升级不自动放行（事实门例外：可降级推进非阻塞部分，标记待人工事后追认）。
 */

export type GateKind = 'fact' | 'review' | 'test' | 'delivery'

export type GateAction = 'approve' | 'reject' | 'answer' | 'rollback' | 'merge' | 'degrade'

export interface GateMeta {
  kind: GateKind
  label: string
  /** 拍板人角色 */
  deciderRole: string
  /** 铁门：不可代答 */
  iron: boolean
  /** 超时策略：escalate=升级通知不放行；degrade=降级推进非阻塞部分+待追认（仅事实门）；none=无超时 */
  timeoutPolicy: 'escalate' | 'degrade' | 'none'
}

export const GATE_META: Record<GateKind, GateMeta> = {
  fact: {
    kind: 'fact',
    label: '事实门',
    deciderRole: '需求方/开发',
    iron: true,
    timeoutPolicy: 'degrade',
  },
  review: {
    kind: 'review',
    label: '评审门',
    deciderRole: '评审人',
    iron: true,
    timeoutPolicy: 'escalate',
  },
  test: {
    kind: 'test',
    label: '测试门',
    deciderRole: '开发/评审人',
    iron: true,
    timeoutPolicy: 'escalate',
  },
  delivery: {
    kind: 'delivery',
    label: '交付门',
    deciderRole: '合入方',
    iron: true,
    timeoutPolicy: 'none',
  },
}

export interface GateMaterial {
  /** 材料 ref：产物相对路径 / diff ref / 报告 ref */
  ref: string
  label: string
  kind: 'artifact' | 'diff' | 'report' | 'evidence'
  /** 同屏展示用内容（决策与证据同屏，不跳页） */
  content?: string
}

export interface GateOption {
  action: GateAction
  label: string
  /** rollback 时的声明式回退目标 */
  rollbackTarget?: RollbackTarget
  tone?: 'primary' | 'danger' | 'neutral'
}

export interface GateParticipant {
  userId: string
  name: string
  /** sole-decider=唯一拍板人；consulted=会诊（isInvitedReviewParticipant，不拍板） */
  role: 'sole-decider' | 'consulted'
}

export interface GateDecision {
  action: GateAction
  /** 事实门回答 */
  answer?: string
  rollbackTarget?: RollbackTarget
  reason?: string
  decidedBy: string
  decidedByName: string
  decidedAt: string
  /** 决策时的乐观锁版本 */
  stateVersion: number
  /** 管理员代拍板（留痕） */
  onBehalf?: boolean
}

export interface GateDegradation {
  /** 事实门超时降级：用默认假设推进非阻塞部分，不替答事实 */
  assumedAnswer: string
  note: string
  at: string
  pendingConfirmationId: string
}

export interface GateInstance {
  gateId: string
  kind: GateKind
  taskId: string
  stage: StageId
  /** 问题本体 */
  question: string
  /** request_digest：快速判断是否值得细看 */
  digest: string
  /** 举卡前上文——让人知道「为什么问这个」（反盲签） */
  preface: string
  /** 提问前模型最后一段话——让人看到 AI 推理上下文 */
  context: string
  /** 材料选区：决策与证据同屏，不跳页 */
  materials: GateMaterial[]
  options: GateOption[]
  soleDecider: GateParticipant
  participants: GateParticipant[]
  raisedAt: string
  /** 0 = 无超时（交付门永远等） */
  timeoutMs: number
  escalated: boolean
  escalatedAt?: string
  status: 'raised' | 'decided' | 'degraded'
  decision: GateDecision | null
  degraded?: GateDegradation
}

/** 事实门超时降级后的待人工追认项（场景2：不替答事实） */
export interface PendingConfirmation {
  id: string
  gateId: string
  question: string
  assumedAnswer: string
  raisedAt: string
  resolvedAt?: string
  resolvedBy?: string
  finalAnswer?: string
}
