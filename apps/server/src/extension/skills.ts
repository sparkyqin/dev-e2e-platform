import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { Skill, SkillAuditEntry } from '@ai-platform/shared'
import { newId, nowIso, readJson, writeJson, ensureDir } from '../domain/util.js'

/**
 * 技能沉淀闭环（场景10 / [机-技能沉淀闭环·人采纳] / [机-写入 fail-closed 留痕] / [机-materialize 快照]）
 *
 * 任务证据 → skillDistiller 提炼 → 候选池（不自动生效）→ 人工采纳 → 正式技能架（版本留痕）→ 下次任务物化注入。
 * 写入 fail-closed：审计 append-only，错技能可回滚（deprecate）。
 */

export class SkillLibrary {
  constructor(private assetsDir: string) {}

  private libraryFile(): string {
    return path.join(this.assetsDir, 'skills', 'library.json')
  }

  private auditFile(): string {
    return path.join(this.assetsDir, 'skills', 'audit.jsonl')
  }

  private candidatesFile(): string {
    return path.join(this.assetsDir, 'skills', 'candidates.json')
  }

  async init(): Promise<void> {
    await ensureDir(path.join(this.assetsDir, 'skills'))
    if (!(await readJson<{ skills: Skill[] }>(this.libraryFile()))) {
      await writeJson(this.libraryFile(), { skills: [], version: 0 })
    }
  }

  async all(): Promise<Skill[]> {
    const lib = await readJson<{ skills: Skill[]; version: number }>(this.libraryFile())
    return lib?.skills ?? []
  }

  async active(): Promise<Skill[]> {
    return (await this.all()).filter((s) => s.status === 'active')
  }

  async candidates(): Promise<Skill[]> {
    return (await readJson<Skill[]>(this.candidatesFile())) ?? []
  }

  private async saveAll(skills: Skill[]): Promise<void> {
    const lib = (await readJson<{ skills: Skill[]; version: number }>(this.libraryFile())) ?? { skills: [], version: 0 }
    lib.skills = skills
    lib.version += 1
    await writeJson(this.libraryFile(), lib)
  }

  private async audit(entry: SkillAuditEntry): Promise<void> {
    await fs.appendFile(this.auditFile(), JSON.stringify(entry) + '\n', 'utf8')
  }

  async auditLog(): Promise<SkillAuditEntry[]> {
    try {
      const txt = await fs.readFile(this.auditFile(), 'utf8')
      return txt
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SkillAuditEntry)
    } catch {
      return []
    }
  }

  /** skillDistiller：从任务证据提炼候选（候选不自动生效） */
  async proposeCandidates(
    evidence: { annotations: string[]; rollbackReasons: string[]; feedbackTexts: string[]; decisions: string[]; docTexts?: string[]; repo: string; module: string },
    sourceTaskId: string,
  ): Promise<Skill[]> {
    const proposed: Skill[] = []
    const corpus = [...evidence.annotations, ...evidence.rollbackReasons, ...evidence.feedbackTexts, ...evidence.decisions, ...(evidence.docTexts ?? [])].join('\n')

    // 模式1：推送/限流类经验（场景10 叙事）
    if (/限流|熔断|频率|推送/.test(corpus)) {
      proposed.push(
        this.candidate({
          name: '推送限流规则',
          pattern: '涉及消息推送 / PushService / 通知渠道的改动',
          guidance:
            '高频推送必须经 PushService 统一限流（默认 100 条/秒，可按渠道配置），并在发送侧做批量合并；否则会触发网关熔断，导致会员中心批量推送失败。降级路径：App 内信失败时降级短信兜底，同样需限流。',
          repo: evidence.repo,
          module: evidence.module,
          sourceTaskId,
        }),
      )
    }
    // 模式2：测试覆盖经验
    if (/边界|覆盖|用例|测试/.test(corpus)) {
      proposed.push(
        this.candidate({
          name: '边界用例前置检查',
          pattern: '涉及积分/额度/过期等有边界语义的规则改动',
          guidance:
            '涉及「过期/清零/阈值」类规则时，test-design 阶段必须前置覆盖：自然月边界、月末/月初切换、零余额、历史遗留数据四类边界用例，避免评审门因测试覆盖不足驳回。',
          repo: evidence.repo,
          module: evidence.module,
          sourceTaskId,
        }),
      )
    }

    if (proposed.length > 0) {
      const existing = await this.candidates()
      // 幂等：同名候选不重复提案（候选池与正式技能架都查）
      const names = new Set(existing.map((c) => c.name))
      const taken = new Set((await this.all()).map((s) => s.name))
      const fresh = proposed.filter((p) => !names.has(p.name) && !taken.has(p.name))
      if (fresh.length > 0) {
        await writeJson(this.candidatesFile(), [...existing, ...fresh])
        for (const f of fresh) {
          await this.audit({ ts: nowIso(), action: 'proposed', skillId: f.id, version: 0, actor: 'skillDistiller', actorName: 'skillDistiller', note: `源自任务 ${sourceTaskId} 执行证据` })
        }
      }
      return fresh
    }
    return []
  }

  private candidate(o: { name: string; pattern: string; guidance: string; repo: string; module: string; sourceTaskId: string }): Skill {
    return {
      id: newId('skill'),
      name: o.name,
      pattern: o.pattern,
      guidance: o.guidance,
      scope: { repo: o.repo || undefined, module: o.module || undefined },
      status: 'candidate',
      version: 0,
      sourceTaskId: o.sourceTaskId,
      proposedAt: nowIso(),
      proposedBy: 'skillDistiller',
    }
  }

  /** 人工采纳（候选不自动生效；采纳即版本 1，留痕） */
  async adopt(skillId: string, actor: string, actorName: string): Promise<Skill> {
    const candidates = await this.candidates()
    const cand = candidates.find((c) => c.id === skillId)
    if (!cand) throw new Error(`候选技能不存在：${skillId}`)
    const adopted: Skill = { ...cand, status: 'active', version: 1, adoptedAt: nowIso(), adoptedBy: actor }
    await this.saveAll([...(await this.all()), adopted])
    await writeJson(
      this.candidatesFile(),
      candidates.filter((c) => c.id !== skillId),
    )
    await this.audit({ ts: nowIso(), action: 'adopted', skillId, version: 1, actor, actorName })
    return adopted
  }

  async reject(skillId: string, actor: string, actorName: string, reason?: string): Promise<void> {
    const candidates = await this.candidates()
    const cand = candidates.find((c) => c.id === skillId)
    if (!cand) throw new Error(`候选技能不存在：${skillId}`)
    await writeJson(
      this.candidatesFile(),
      candidates.map((c) => (c.id === skillId ? { ...c, status: 'rejected' as const, rejectedAt: nowIso(), rejectedBy: actor, rejectReason: reason } : c)),
    )
    await this.audit({ ts: nowIso(), action: 'rejected', skillId, version: 0, actor, actorName, note: reason })
  }

  /** 错技能回滚：deprecate（留痕，不物理删除） */
  async deprecate(skillId: string, actor: string, actorName: string, reason: string): Promise<void> {
    const all = await this.all()
    const target = all.find((s) => s.id === skillId)
    if (!target) throw new Error(`技能不存在：${skillId}`)
    target.status = 'deprecated'
    target.deprecatedAt = nowIso()
    target.deprecatedReason = reason
    target.version += 1
    await this.saveAll(all)
    await this.audit({ ts: nowIso(), action: 'deprecated', skillId, version: target.version, actor, actorName, note: reason })
  }

  /** 下次任务开局：物化匹配技能快照到工作区 host-skills/（[机-materialize 快照]） */
  async materialize(workspaceDir: string, repo: string, module: string): Promise<{ id: string; name: string; version: number }[]> {
    const active = await this.active()
    const matched = active.filter((s) => !s.scope.repo || s.scope.repo === repo || !s.scope.module || s.scope.module === module)
    const dir = path.join(workspaceDir, 'host-skills')
    await ensureDir(dir)
    const injected: { id: string; name: string; version: number }[] = []
    for (const s of matched) {
      const file = path.join(dir, `${s.name}.md`)
      await fs.writeFile(file, `# 技能：${s.name}（v${s.version}）\n\n- 适用：${s.pattern}\n\n${s.guidance}\n`, 'utf8')
      injected.push({ id: s.id, name: s.name, version: s.version })
    }
    return injected
  }
}
