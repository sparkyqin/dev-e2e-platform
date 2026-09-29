import type { MrState, PipelineRun, TriageCategory } from '@ai-platform/shared'
import { newId, nowIso, readJsonTolerant, writeJson } from '../domain/util.js'

/**
 * 外部代码托管平台适配器（mock CodeHub，附录 C 通道C/D）
 *
 * 真实部署替换为 CodeHub/GitLab 适配器；接口不变：
 * MR 创建（一仓一 MR）、流水线结果、评论——均为「远端真实事实」来源（[机-交付事实远端真实]）。
 * 每次变更 version+1，供监听方做变更检测（幂等）。
 */

export interface MockMr {
  mrId: string
  repo: string
  branch: string
  sha: string
  title: string
  state: MrState
  participants: { reviewer?: string; approver?: string; merger?: string }
  pipelines: PipelineRun[]
  comments: { externalId: string; author: string; text: string; kind: 'comment' | 'review-comment'; sha: string; ts: string; triage?: TriageCategory }[]
  mergedAt?: string
  /** 变更版本号（监听方幂等检测） */
  version: number
  createdAt: string
}

export class MrPlatform {
  private mrs: MockMr[] = []

  constructor(private file: string) {}

  async init(): Promise<void> {
    this.mrs = (await readJsonTolerant<MockMr[]>(this.file)) ?? []
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, this.mrs)
  }

  async createMr(input: { repo: string; branch: string; sha: string; title: string; participants: MockMr['participants'] }): Promise<MockMr> {
    // 一仓一 MR：同仓已有未关闭 MR 则复用（更新 sha）
    const existing = this.mrs.find((m) => m.repo === input.repo && m.state !== 'merged' && m.state !== 'closed')
    if (existing) {
      existing.sha = input.sha
      existing.version += 1
      await this.persist()
      return existing
    }
    const mr: MockMr = {
      mrId: `MR-${newId('x').split('_')[1].toUpperCase()}`,
      ...input,
      state: 'watching',
      pipelines: [],
      comments: [],
      version: 1,
      createdAt: nowIso(),
    }
    this.mrs.push(mr)
    await this.persist()
    return mr
  }

  get(mrId: string): MockMr | undefined {
    return this.mrs.find((m) => m.mrId === mrId)
  }

  /** 修复重推：更新 MR 关联 SHA（旧证据由调用方按 SHA 校验标失效） */
  async updateSha(mrId: string, sha: string): Promise<void> {
    const mr = this.get(mrId)
    if (!mr) return
    mr.sha = sha
    mr.version += 1
    await this.persist()
  }

  findByRepo(repo: string): MockMr | undefined {
    return this.mrs.find((m) => m.repo === repo)
  }

  list(): MockMr[] {
    return this.mrs
  }

  async addPipeline(mrId: string, sha: string, state: PipelineRun['state'], summary: string): Promise<PipelineRun> {
    const mr = this.get(mrId)
    if (!mr) throw new Error(`MR 不存在：${mrId}`)
    const run: PipelineRun = { runId: newId('run'), mrId, sha, state, summary, finishedAt: state === 'pending' ? undefined : nowIso() }
    mr.pipelines.push(run)
    mr.version += 1
    await this.persist()
    return run
  }

  async addComment(mrId: string, input: { author: string; text: string; kind: 'comment' | 'review-comment'; sha: string; externalId?: string; triage?: TriageCategory }): Promise<void> {
    const mr = this.get(mrId)
    if (!mr) throw new Error(`MR 不存在：${mrId}`)
    const externalId = input.externalId ?? newId('cmt')
    if (mr.comments.some((c) => c.externalId === externalId)) return // 幂等
    mr.comments.push({ externalId, author: input.author, text: input.text, kind: input.kind, sha: input.sha, ts: nowIso(), triage: input.triage })
    mr.version += 1
    await this.persist()
  }

  async markMergeable(mrId: string): Promise<void> {
    const mr = this.get(mrId)
    if (!mr) return
    mr.state = 'mergeable'
    mr.version += 1
    await this.persist()
  }

  async merge(mrId: string): Promise<void> {
    const mr = this.get(mrId)
    if (!mr) throw new Error(`MR 不存在：${mrId}`)
    mr.state = 'merged'
    mr.mergedAt = nowIso()
    mr.version += 1
    await this.persist()
  }
}
