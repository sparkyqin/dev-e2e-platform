import type { StageId } from './stages.js'
import type { GateKind } from './gates.js'
import type { TaskStatus } from './task.js'

/**
 * 质量度量视图（研发作业流 · TTM / 全流程追溯）
 *
 * 全部从语义事件流（append-only JSONL）聚合，只读派生、可随时重算：
 *  - TTM：createdAt → 合入（仅已合入任务计入，避免进行中任务拉偏均值）
 *  - 阶段耗时：stage_entered → stage_exited / rollback 段累加（回退重做计入该阶段总活跃时长）
 *  - 门等待：gate_raised → gate_decided（含超时降级：降级也消耗真实等待）
 *  - 回退：rollback 事件计数（声明式回退环次数）
 *  - 一次通过：零回退零修复轮直达合入（一次做对）；阶段一次通过 = 单轮进入完成
 */

export interface GateWaitStat {
  kind: GateKind
  count: number
  totalMs: number
  avgMs: number
  maxMs: number
  /** 超时降级次数（铁门不代答，仅事实门可降级待追认） */
  degraded: number
}

export interface TaskMetrics {
  taskId: string
  seq: number
  title: string
  module: string
  status: TaskStatus
  stage: StageId
  createdAt: string
  /** 合入时间（未合入为 null） */
  mergedAt: string | null
  /** Time To Market：创建 → 合入（仅已合入任务有值，ms） */
  ttmMs: number | null
  /** 进行中任务的在制时长（已合入为 null） */
  ageMs: number | null
  /** 声明式回退次数 */
  rollbacks: number
  /** 修复轮次（对抗式修复闭环预算消耗） */
  repairRounds: number
  /** 一次通过：零回退零修复轮直达合入（一次做对的质量口径；仅已合入任务有意义） */
  firstPass: boolean
  /** 各阶段最大进入轮次（>1 = 该阶段被回退重做；未进入不设键） */
  stageMaxRounds: Partial<Record<StageId, number>>
  /** 各阶段累计活跃时长（ms；回退重做累加，多轮任务体现真实投入） */
  stageTimingsMs: Partial<Record<StageId, number>>
  /** 门等待统计（按门类） */
  gateWaits: GateWaitStat[]
  /** 事件流总量（过程可回溯的完整度） */
  eventCount: number
}

export interface MetricsSummary {
  taskCount: number
  mergedCount: number
  activeCount: number
  failedCount: number
  /** 已合入任务 TTM 中位数（ms；无已合入任务为 null） */
  medianTtmMs: number | null
  /** 已合入任务 TTM 均值 */
  avgTtmMs: number | null
  /** 平均声明式回退次数（全部任务） */
  avgRollbacks: number
  /** 平均修复轮次 */
  avgRepairRounds: number
  /** 已合入且一次通过（零回退零修复轮直达合入）的任务数 */
  firstPassCount: number
  /** 一次通过率（分母 = 已合入任务；0-1；无已合入为 null） */
  firstPassRate: number | null
  /** 阶段一次通过率（进入过该阶段的任务中单轮完成占比；0-1；未进入不设键） */
  stageFirstPassRate: Partial<Record<StageId, number>>
  totalEvents: number
  /** 各阶段平均活跃时长（ms，按出现过该阶段的任务数摊平） */
  stageAvgMs: Partial<Record<StageId, number>>
  /** 门等待统计（按门类，全平台聚合） */
  gateStats: GateWaitStat[]
}

export interface MetricsView {
  summary: MetricsSummary
  tasks: TaskMetrics[]
}
