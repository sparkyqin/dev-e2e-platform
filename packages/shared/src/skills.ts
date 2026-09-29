/**
 * 技能沉淀闭环（场景10 / 附录 E）
 *
 * 任务证据 → skillDistiller 提炼 → 候选池 → 人工采纳 → 正式技能架（版本留痕 fail-closed）→ 下次任务物化注入。
 * 候选不自动生效（防 AI 自我强化错误做法）；写入留痕可回滚。
 */

export type SkillStatus = 'candidate' | 'active' | 'rejected' | 'deprecated'

export interface Skill {
  id: string
  name: string
  /** 适用场景模式 */
  pattern: string
  /** 技能正文（指导） */
  guidance: string
  scope: { repo?: string; module?: string }
  status: SkillStatus
  version: number
  sourceTaskId?: string
  proposedAt?: string
  proposedBy?: string
  adoptedAt?: string
  adoptedBy?: string
  rejectedAt?: string
  rejectedBy?: string
  rejectReason?: string
  deprecatedAt?: string
  deprecatedReason?: string
}

export type SkillAuditAction = 'proposed' | 'adopted' | 'rejected' | 'deprecated'

/** 写入 fail-closed 留痕：技能架每次变更追加审计（append-only JSONL） */
export interface SkillAuditEntry {
  ts: string
  action: SkillAuditAction
  skillId: string
  version: number
  actor: string
  actorName: string
  note?: string
}
