import path from 'node:path'
import type { Playbook } from '@ai-platform/shared'
import { DEFAULT_REVIEW_DIMENSIONS } from '@ai-platform/shared'
import { ensureDir, readJson, writeJson } from '../domain/util.js'

/**
 * 流程模板（附录 E · 四层扩展机制：流程模板）
 *
 * locked（阶段 I/O 与退出条件，不可删）+ customizable（三分歧可配项：门的否决权/协作范式/评审维度）。
 * 成熟 playbook 可上架为团队资产（[机-流程模板反哺]）。
 */

export const DEFAULT_PLAYBOOK: Playbook = {
  id: 'default',
  name: '默认 · 单评审人轻量',
  description: '单中心推进、单评审人评审、阻塞式门。适合日常需求。',
  published: true,
  locked: {
    stages: [
      { id: 'intake', io: '需求单 → 基线快照（过程区）', exitCondition: '基线双层自动校验（程序规则 + AI 复核）通过' },
      { id: 'clarify', io: '基线 → 可验收原子项（IR→SR→AR）+ 决策记录', exitCondition: '原子项落成；事实门全决或降级标记待追认' },
      { id: 'architecture', io: '原子项 → 架构设计 SPEC（架构分析/边界设计/业务流分析，交付区）', exitCondition: '架构师拍板架构方案通过；主权移交开发' },
      { id: 'design', io: '架构 → 功能设计 SPEC（实现设计/规格接口/功能 FMEA，交付区）+ 契约单源', exitCondition: '开发拍板方案通过；主权移交开发' },
      { id: 'test-design', io: '功能设计 → 测试 SPEC（需求测试分析/测试策略/测试点设计，交付区）', exitCondition: 'TSE 拍板测试设计通过' },
      { id: 'review', io: '方案证据 → 唯一拍板', exitCondition: '评审人通过放行 / 驳回附理由声明式回退' },
      { id: 'code', io: '方案 → 代码变更（交付区 src）', exitCondition: 'AI 自报完成 + 平台文件存在校验通过' },
      { id: 'verify', io: '代码 → 评审报告 + 构建/测试证据', exitCondition: '各维独立判定 + Critic 终审 + 编译测试通过' },
      { id: 'deliver', io: '代码 → MR（监听态）→ 合入', exitCondition: '反馈全消化 + 流水线真绿 + 合入方拍板' },
      { id: 'merged', io: '—', exitCondition: '终态；合入后发现问题可回退编码' },
    ],
  },
  customizable: {
    gateVetoStyle: 'blocking',
    paradigm: 'single-center',
    reviewDimensions: ['综合检视'],
    criticEnabled: false,
    maxRepairRounds: 10,
    retryBudget: { build: 3, test: 3 },
    gateTimeoutMs: { fact: 5 * 60_000, review: 5 * 60_000, test: 3 * 60_000, delivery: 0 },
    defaultUnattended: false,
  },
}

export const STRICT_PLAYBOOK: Playbook = {
  ...DEFAULT_PLAYBOOK,
  id: 'strict',
  name: '严格 · 多维并行评审 + Critic 终审',
  description: '多维并行评审（6 维独立判定）+ Critic 终审 + 对抗式修复闭环。适合高风险改动。',
  customizable: {
    ...DEFAULT_PLAYBOOK.customizable,
    gateVetoStyle: 'adversarial',
    reviewDimensions: DEFAULT_REVIEW_DIMENSIONS,
    criticEnabled: true,
  },
}

export const FAST_PLAYBOOK: Playbook = {
  ...DEFAULT_PLAYBOOK,
  id: 'fast',
  name: '加速 · 测试与演示用',
  description: '超时极短、预算极小，用于自动化测试与演示剧本。',
  customizable: {
    ...DEFAULT_PLAYBOOK.customizable,
    reviewDimensions: ['功能正确性', '安全性'],
    criticEnabled: true,
    maxRepairRounds: 2,
    retryBudget: { build: 2, test: 2 },
    gateTimeoutMs: { fact: 300, review: 300, test: 300, delivery: 0 },
  },
}

export class PlaybookRegistry {
  private cache: Map<string, Playbook> = new Map()

  constructor(private dir: string) {
    this.cache.set('default', DEFAULT_PLAYBOOK)
    this.cache.set('strict', STRICT_PLAYBOOK)
    this.cache.set('fast', FAST_PLAYBOOK)
  }

  async init(): Promise<void> {
    await ensureDir(this.dir)
    // 内置模板落盘为团队资产（可编辑副本）
    for (const pb of [DEFAULT_PLAYBOOK, STRICT_PLAYBOOK, FAST_PLAYBOOK]) {
      const file = path.join(this.dir, `${pb.id}.json`)
      const existing = await readJson<Playbook>(file)
      if (!existing) await writeJson(file, pb)
    }
    await this.reload()
  }

  async reload(): Promise<void> {
    const { readdir } = await import('node:fs/promises')
    try {
      const files = await readdir(this.dir)
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        const pb = await readJson<Playbook>(path.join(this.dir, f))
        if (pb?.id) this.cache.set(pb.id, pb)
      }
    } catch {
      // 目录为空则仅内置
    }
  }

  get(id: string): Playbook {
    return this.cache.get(id) ?? DEFAULT_PLAYBOOK
  }

  list(): Playbook[] {
    return [...this.cache.values()].filter((p) => p.published)
  }

  /** 上架新模板（团队资产反哺） */
  async publish(pb: Playbook): Promise<void> {
    this.cache.set(pb.id, pb)
    await writeJson(path.join(this.dir, `${pb.id}.json`), pb)
  }
}
