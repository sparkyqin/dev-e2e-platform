import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { InjectionSummary, KnowledgeDoc, StageId } from '@ai-platform/shared'
import { readText } from '../domain/util.js'

/**
 * 结构化知识库 OKL 三层（[机-OKL 三层] / [机-知识伴随注入]）
 *
 * global：团队/平台通用知识（assets/knowledge/global）
 * repos：单仓专属知识（assets/knowledge/repos/<repo>）
 * forward：当前任务相关知识（任务工作区 knowledge/ + host-skills/ 物化快照）
 * 按需叠加注入 + 注入摘要可观测（injection_summary）。
 */

export class KnowledgeBase {
  constructor(private assetsDir: string) {}

  private globalDir(): string {
    return path.join(this.assetsDir, 'knowledge', 'global')
  }

  private repoDir(repo: string): string {
    return path.join(this.assetsDir, 'knowledge', 'repos', repo)
  }

  async listDocs(repo: string): Promise<KnowledgeDoc[]> {
    const docs: KnowledgeDoc[] = []
    for (const dir of [this.globalDir(), this.repoDir(repo)]) {
      const layer = dir === this.globalDir() ? 'global' : 'repos'
      try {
        const files = await fs.readdir(dir)
        for (const f of files.filter((x) => x.endsWith('.md'))) {
          const title = (await readText(path.join(dir, f)))?.split('\n')[0]?.replace(/^#\s*/, '') ?? f
          docs.push({ layer, repo: layer === 'repos' ? repo : undefined, path: path.join(dir, f), title, tags: [] })
        }
      } catch {
        // 层为空
      }
    }
    return docs
  }

  /**
   * 按需注入：按阶段 + 关键词打分选择文档，叠加任务前向层（host-skills 快照 + 任务知识区）。
   * 返回注入文本与摘要（可观测）。
   */
  async inject(opts: {
    stage: StageId
    repo: string
    module: string
    requirementText: string
    workspaceDir: string
    skillsInjected: { id: string; name: string; version: number }[]
  }): Promise<{ text: string; summary: InjectionSummary }> {
    const keywords = [...new Set([...tokenize(opts.requirementText), ...tokenize(opts.module), ...tokenize(opts.repo)])]
    const candidates = await this.listDocs(opts.repo)
    const scored = candidates
      .map((doc) => ({ doc, score: scoreDoc(doc, keywords) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)

    const parts: string[] = []
    const injected: InjectionSummary['injected'] = []

    for (const { doc } of scored) {
      const full = (await readText(doc.path)) ?? ''
      const chars = full.length
      const useExcerpt = chars > 4000
      const text = useExcerpt ? full.slice(0, 4000) : full
      parts.push(`【${doc.layer}】${doc.title}\n${text}`)
      injected.push({ layer: doc.layer, path: doc.path, title: doc.title, chars: text.length, form: useExcerpt ? 'excerpt' : 'full' })
    }

    // 前向层：任务工作区 host-skills 物化快照
    const hostSkillsDir = path.join(opts.workspaceDir, 'host-skills')
    try {
      const files = await fs.readdir(hostSkillsDir)
      for (const f of files.filter((x) => x.endsWith('.md')).slice(0, 6)) {
        const text = (await readText(path.join(hostSkillsDir, f))) ?? ''
        parts.push(`【forward·host-skills】${f}\n${text}`)
        injected.push({ layer: 'forward', path: `host-skills/${f}`, title: f, chars: text.length, form: 'full' })
      }
    } catch {
      // 无物化技能
    }

    const summary: InjectionSummary = {
      stage: opts.stage,
      injected,
      skillsInjected: opts.skillsInjected,
      totalChars: parts.join('\n\n').length,
      note: `按需注入 ${injected.length} 篇（global/repos/forward 叠加），技能 ${opts.skillsInjected.length} 条`,
    }
    return { text: parts.join('\n\n---\n\n'), summary }
  }
}

function tokenize(s: string): string[] {
  return (s ?? '')
    .split(/[\s,，。;；:：/\\|\-\(\)（）\[\]]+/)
    .filter((t) => t.length >= 2)
}

function scoreDoc(doc: KnowledgeDoc, keywords: string[]): number {
  let score = 0
  for (const kw of keywords) {
    if (doc.title.includes(kw)) score += 3
    if (doc.path.includes(kw)) score += 1
  }
  return score
}
