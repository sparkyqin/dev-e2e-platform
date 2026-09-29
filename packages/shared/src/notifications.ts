/**
 * IM 通知（附录 C 通道B / [机-通知合并]）
 *
 * `notified` 防重复打扰；按任务合并、按优先级排序；安静时段（夜间）非紧急通知合并到早上。
 * 通知单向触发、失败不阻塞（门等待状态已在真源里，通知丢失可重发）。
 */

export type NotificationPriority = 'critical' | 'high' | 'normal' | 'low'

export type NotificationKind =
  | 'gate-raised' // 门待办（带深链）
  | 'gate-escalated' // 门超时升级（不自动放行）
  | 'health-warn' // 健康徽标转黄/红（主动叫人）
  | 'build-failed' // 构建/测试失败（重试预算耗尽）
  | 'repair-exceeded' // 修复轮次超限升级
  | 'mr-watching' // MR 进入监听态
  | 'feedback-needs-human' // 反馈分诊需人决策
  | 'merge-ready' // 可合入（流水线绿+反馈全消化）
  | 'merged' // 已合入
  | 'morning-digest' // 晨间摘要（夜间合并）
  | 'skill-candidate' // 候选技能待评审
  | 'info'

export interface Notification {
  id: string
  taskId?: string
  taskSeq?: number
  kind: NotificationKind
  priority: NotificationPriority
  title: string
  body: string
  /** 深链：点开直达任务工作台 */
  deeplink: string
  audience: string
  createdAt: string
  /** 防重复打扰：同一 (task,kind,key) 只 notify 一次 */
  dedupKey: string
  notified: boolean
  notifiedAt?: string
  read: boolean
  /** 安静时段被合并进的晨间摘要 id */
  mergedInto?: string
}
