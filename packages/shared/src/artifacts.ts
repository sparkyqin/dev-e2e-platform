import type { StageId } from './stages.js'

/**
 * 产物分层（附录 E · [机-产物分层·三分区] / [机-契约单源] / [机-产物主权流转]）
 *
 * 三分区治理：process（过程区，不入 git）/ delivery（交付区，入 git）/ knowledge（知识区，可回流团队资产）。
 * 契约唯一真源：delivery/contract/api-contract.json，其余视图只读派生，防多版本漂移。
 */

export type Partition = 'process' | 'delivery' | 'knowledge'

export const PARTITION_META: Record<Partition, { label: string; inGit: boolean; desc: string }> = {
  process: { label: '过程区', inGit: false, desc: '中间态草稿（基线/分解草稿/spec草稿），不入 git' },
  delivery: { label: '交付区', inGit: true, desc: '承诺交付物（spec/design/契约/代码），入 git' },
  knowledge: { label: '知识区', inGit: false, desc: '可复用沉淀，经采纳后回流团队资产' },
}

export interface ArtifactMeta {
  /** 相对任务工作区根，如 process/spec.draft.md */
  path: string
  partition: Partition
  bytes: number
  updatedAt: string
  stage: StageId
  /** 当前主权角色（非主权方只读 + 批注） */
  sovereignRole: string
  /** 内容指纹（sha256 前 16 位；变更检测用——同字节数不同内容也能识别） */
  contentHash?: string
}

export interface AnnotationReply {
  id: string
  author: string
  authorName: string
  text: string
  ts: string
}

/** 原位批注（场景3/4：在产物上原位留的讨论意见） */
export interface Annotation {
  id: string
  artifactPath: string
  /** 锚点：产物内小节标题或行号描述 */
  anchor?: string
  author: string
  authorName: string
  text: string
  ts: string
  replies: AnnotationReply[]
  resolved: boolean
}

/** 各阶段产物主权（场景3：拍板后主权移交开发；测试设计段收口的评审报告主权在评审人） */
export const STAGE_SOVEREIGNTY: Record<StageId, string> = {
  requirement: 'owner',
  architecture: 'architect',
  design: 'designer',
  'test-design': 'tse',
  execute: 'owner',
  merged: 'owner',
}

export interface ContractDerivedView {
  path: string
  /** 生成该视图时的源契约内容 hash */
  hashOfSource: string
  /** 当前视图内容 hash */
  hashOfView: string
  drifted: boolean
}

export interface ContractState {
  /** 契约单源路径 */
  contractPath: string
  sourceHash: string
  updatedAt: string
  derivedViews: ContractDerivedView[]
}
