import path from 'node:path'
import type { TaskCard } from '@ai-platform/shared'
import { ensureDir, readJson, writeJson } from '../domain/util.js'

/**
 * 只读投影（[机-一处真源]：`.flow/state.json` 唯一真源，投影只读）
 *
 * 会话厅列表来自本投影（真实部署为 PG 只读投影；此处为 JSON 投影，接口一致）。
 * write-through：状态每次落盘后同步投影；rebuild() 全量重建兜底。
 */

interface ProjectionFile {
  cards: TaskCard[]
}

export class Projection {
  private cards = new Map<string, TaskCard>()

  constructor(private file: string) {}

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.file))
    const saved = await readJson<ProjectionFile>(this.file)
    if (saved) for (const c of saved.cards) this.cards.set(c.taskId, c)
  }

  static toCard(s: import('@ai-platform/shared').TaskState): TaskCard {
    return {
      taskId: s.taskId,
      seq: s.seq,
      title: s.title,
      module: s.module,
      repo: s.repo,
      stage: s.stage,
      status: s.status,
      health: s.health,
      gateKind: s.gate?.kind ?? null,
      gateQuestion: s.gate?.question ?? null,
      gateDeciderName: s.gate?.soleDecider?.name ?? null,
      gateRaisedAt: s.gate?.raisedAt ?? null,
      engineId: s.engineId,
      unattended: s.unattended,
      autonomy: s.autonomy,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      repairRounds: s.repairRounds,
      subtasks: s.subtasks ? s.subtasks.map((t) => ({ taskId: t.taskId, arTitle: t.arTitle, status: t.status })) : null,
      parentTaskId: s.parentTaskId ?? null,
      arTitle: s.arTitle ?? null,
    }
  }

  writeThrough(state: import('@ai-platform/shared').TaskState): void {
    this.cards.set(state.taskId, Projection.toCard(state))
    void this.persist()
  }

  async rebuild(all: import('@ai-platform/shared').TaskState[]): Promise<void> {
    this.cards.clear()
    for (const s of all) this.cards.set(s.taskId, Projection.toCard(s))
    await this.persist()
  }

  list(): TaskCard[] {
    return [...this.cards.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, { cards: [...this.cards.values()] } satisfies ProjectionFile)
  }
}
