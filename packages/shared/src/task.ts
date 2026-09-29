import type { StageId, DevMode } from './stages.js'
import type { GateInstance, PendingConfirmation } from './gates.js'
import type { ArtifactMeta } from './artifacts.js'
import type { MrRef } from './delivery.js'

export type { StageId, DevMode } from './stages.js'

/**
 * 任务状态模型（附录 F · [机-一处真源] / [机-文件状态机]）
 *
 * 工作区文件 `.flow/state.json` 是阶段真相唯一来源，内存 / 前端 / 投影皆为只读。
 * stateVersion 为乐观锁：每次变更 +1，并发写入先到先得、后者知情（409）。
 */

export type TaskStatus =
  | 'queued' // 排队等并发槽 ⚪
  | 'running' // AI 自动推进中 🟢（占并发槽）
  | 'gate-wait' // 门等待 🟡（不占并发槽，容器释放可恢复）
  | 'user-held' // 人接管中（人在控，不占并发槽）
  | 'watching' // MR 监听态（被动监听，不占并发槽）
  | 'aggregating' // AR 聚合等待（父任务：子任务并行执行中，不占并发槽）
  | 'merged' // 已合入（终态）✔
  | 'failed' // 超限停止 / 升级人工
  | 'archived' // 已合入后工作区回收归档

export type HealthLevel = 'green' | 'yellow' | 'red'

export interface HealthFact {
  code: string
  message: string
  count: number
  ts: string
}

export interface TaskHealth {
  level: HealthLevel
  facts: HealthFact[]
}

export interface PersonRef {
  userId: string
  name: string
  role: string
}

export interface TaskPeople {
  /** 需求方（事实门拍板人） */
  requester: PersonRef
  /** 开发/责任人：唯一推进者、写动作归属 */
  owner: PersonRef
  /** 设计师（design 阶段主笔，主权在设计师） */
  designer: PersonRef
  /** 评审人（方案评审门唯一拍板） */
  reviewer: PersonRef
  /** 合入方（交付门唯一拍板，永远人工） */
  merger: PersonRef
  /** 管理员（可代拍板，留痕） */
  admin: PersonRef
  /** 架构师（architecture 阶段主笔与拍板；存量任务可缺省，缺省时由责任人拍板） */
  architect?: PersonRef
  /** TSE 测试设计工程师（test-design 阶段主笔与拍板；存量任务可缺省，缺省时由责任人拍板） */
  tse?: PersonRef
}

export interface TokenUsage {
  input: number
  output: number
  /** token 预算；超阈预警（warning/exceeded → 健康徽标事实） */
  budget: number
}

/** AR 子任务引用（父任务持有的派发清单，状态由聚合检查回写） */
export interface SubtaskRef {
  taskId: string
  arTitle: string
  /** 子任务责任人（开发轮转分配） */
  ownerName: string
  status: TaskStatus
}

export interface TaskState {
  schemaVersion: 1
  taskId: string
  /** 任务流水号（#128） */
  seq: number
  title: string
  module: string
  repo: string
  /** 需求原文 */
  requirementText: string
  mode: DevMode
  paradigm: 'single-center' | 'tri-partite'
  playbookId: string

  stage: StageId
  status: TaskStatus
  stateVersion: number
  /** 双指针之「当前指针」；viewingStepIndex 为前端查看指针 */
  currentStepIndex: number

  createdAt: string
  updatedAt: string

  /** 每阶段进入轮次（含回退重做） */
  stageRounds: Partial<Record<StageId, number>>
  /** 已完成阶段（回退重做后再次记录） */
  completedStages: StageId[]
  /** 修复轮次（对抗式修复闭环） */
  repairRounds: number
  /** 无人值守模式（夜间自动推进，铁门挂起） */
  unattended: boolean
  /** auto=自动迭代；human=人在控（接管后默认保持人在控直到显式恢复） */
  autonomy: 'auto' | 'human'
  /** lifecycle 标记：interrupted=被人中断（≠ AI 出错失败） */
  lifecycleNote?: 'interrupted' | 'failed'

  /** 执行段 AR 并行：review 通过后由 owner 拍板拆分为子任务并行执行 */
  arParallel?: boolean
  /** 子任务指向父任务（AR 拆分派生）；父任务无此字段 */
  parentTaskId?: string
  /** 子任务的 AR 标题（如「AR1 过期规则参数化落地」） */
  arTitle?: string
  /** 父任务派发的子任务清单（aggregating 聚合检查回写状态） */
  subtasks?: SubtaskRef[]

  people: TaskPeople
  engineId: string
  /** 当前门（唯一） */
  gate: GateInstance | null
  /** 待消费指令（回退返工修复指令 / 会话内追问），worker 消费后清空 */
  pendingInstructions: string[]
  /** 事实门超时降级的待追认清单 */
  pendingConfirmations: PendingConfirmation[]
  mr: MrRef | null
  health: TaskHealth
  artifacts: ArtifactMeta[]
  tokenUsage: TokenUsage
  /** 演示剧本（模拟引擎注入故障用）：clean | flaky-tool | build-fail | feedback-loop */
  scenario: 'clean' | 'flaky-tool' | 'build-fail' | 'feedback-loop'
}

/** 任务历程条目（TaskJourney，由事件流派生，只读投影） */
export interface JourneyEntry {
  ts: string
  seq: number
  kind: string
  stage?: StageId
  text: string
}
