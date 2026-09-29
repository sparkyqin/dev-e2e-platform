/**
 * 交付合入（场景7 / 附录 F）
 *
 * MR 创建是监听态非终态，合入才终态。
 * 反馈 5 源聚合 → 分诊（自动可修 / 需人决策 / 仅提示）→ 修复 → 重验（SHA 校验）→ 合入。
 * 交付事实来自远端真实（防本地宣称「测试通过」）；SHA 一变旧证据失效（幂等重放防重复/遗漏）。
 */

export type FeedbackSource =
  | 'mr-comment' // MR 评论
  | 'pipeline' // 远端流水线
  | 'review-comment' // 检视意见
  | 'test-report' // 测试报告
  | 'post-merge' // 合入后问题

export type TriageCategory = 'auto-fixable' | 'needs-human' | 'info-only'

export type FeedbackStatus =
  | 'new'
  | 'queued-fix'
  | 'gate-raised'
  | 'logged'
  | 'fixing'
  | 'fixed'
  | 'waived'

export interface FeedbackItem {
  feedbackId: string
  source: FeedbackSource
  /** 外部幂等键（重放去重） */
  externalId: string
  author?: string
  text: string
  /** 关联提交 SHA：SHA 校验，一变旧证据失效 */
  sha: string
  ts: string
  triage: TriageCategory
  status: FeedbackStatus
  evidenceStale?: boolean
}

export interface PipelineRun {
  runId: string
  mrId: string
  sha: string
  state: 'pending' | 'success' | 'failed'
  summary: string
  finishedAt?: string
}

export type MrState = 'open' | 'watching' | 'mergeable' | 'merged' | 'closed'

export interface MrRef {
  mrId: string
  url: string
  branch: string
  sha: string
  repo: string
  /** 一仓一 MR */
  title: string
}

export interface EvidenceEntry {
  kind: 'pipeline' | 'review' | 'test' | 'feedback-digested'
  ref: string
  sha: string
  ok: boolean
  ts: string
  /** SHA 变更后失效（证据非自报） */
  stale: boolean
}

/** 合入条件（[机-fail-closed 合入]）：三者缺一不可 */
export interface MergeReadiness {
  pipelineGreenOnCurrentSha: boolean
  allFeedbackDigested: boolean
  humanApproved: boolean
  ready: boolean
  blockers: string[]
}
