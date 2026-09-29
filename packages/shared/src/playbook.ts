import type { StageId } from './stages.js'
import type { RollbackTarget } from './stages.js'

/**
 * 流程模板（附录 E · 四层扩展机制之一）
 *
 * locked：阶段 I/O 与退出条件（不可删，主干兜底）
 * customizable：三分歧可配项（门的否决权 / 协作范式 / 评审维度）+ 预算与超时
 * 成熟 playbook 可上架为团队资产（[机-流程模板反哺]）。
 */

export interface PlaybookStageSpec {
  id: StageId
  io: string
  exitCondition: string
}

export interface Playbook {
  id: string
  name: string
  description: string
  /** 上架的团队资产（可被新任务选用） */
  published: boolean
  locked: { stages: PlaybookStageSpec[] }
  customizable: {
    /** 门的否决权：blocking=阻塞式驳回即回退；advisory=建议式开发自决；adversarial=对抗式修复闭环+复检 */
    gateVetoStyle: 'blocking' | 'advisory' | 'adversarial'
    /** 协作范式：单中心默认 / 三权分立（高合规可选） */
    paradigm: 'single-center' | 'tri-partite'
    /** 评审维度（维度数可配：默认单评审人轻量，可启用多维并行 + Critic 终审） */
    reviewDimensions: string[]
    criticEnabled: boolean
    /** 修复轮次上限（超限升级人工介入，不无限打转） */
    maxRepairRounds: number
    /** 重试预算（构建/测试失败重试次数上限，超限停止升级不烧资源） */
    retryBudget: { build: number; test: number }
    /** 门超时预算（毫秒；0=无超时） */
    gateTimeoutMs: { fact: number; review: number; test: number; delivery: number }
    defaultUnattended: boolean
  }
}

export const DEFAULT_REVIEW_DIMENSIONS = ['功能正确性', '架构合理性', '安全性', '性能', '可维护性', '测试充分性']

export function playbookRollbackTargets(pb: Playbook): RollbackTarget[] {
  // 声明式回退可选目标由模板约束（advisory 风格不允许直接回退驳回，只提建议；其余=设计段全谱 + 执行段修复模式）
  return pb.customizable.gateVetoStyle === 'advisory' ? ['execute'] : ['requirement', 'architecture', 'design', 'test-design', 'execute']
}
