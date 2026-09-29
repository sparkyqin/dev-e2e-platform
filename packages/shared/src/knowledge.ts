import type { StageId } from './stages.js'

/**
 * 结构化知识库 OKL 三层（附录 E · [机-OKL 三层]）
 *
 * forward（前向层：当前任务相关知识）/ global（全局层：团队/平台通用）/ repos（仓级层：单仓专属）。
 * 按需叠加注入，避免全局知识塞进每个任务；注入摘要可观测（injection_summary：实际塞了什么、什么形态）。
 */

export type KnowledgeLayer = 'forward' | 'global' | 'repos'

export interface KnowledgeDoc {
  layer: KnowledgeLayer
  /** repos 层的仓标识 */
  repo?: string
  path: string
  title: string
  tags: string[]
}

export interface InjectedDoc {
  layer: KnowledgeLayer
  path: string
  title: string
  chars: number
  /** 注入形态：full / excerpt */
  form: 'full' | 'excerpt'
}

export interface InjectedSkill {
  id: string
  name: string
  version: number
}

/** 注入摘要（可观测：实际塞了什么、以什么形态） */
export interface InjectionSummary {
  stage: StageId
  injected: InjectedDoc[]
  skillsInjected: InjectedSkill[]
  totalChars: number
  note: string
}
