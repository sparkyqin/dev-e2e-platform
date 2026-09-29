import type { SchedulerConfig } from '@ai-platform/shared'
import { readJson, writeJson } from '../domain/util.js'

/**
 * 部署级任务队列（[机-会话厅并发] / [机-门不占并发槽] / [机-部署队列真隔离]）
 *
 * - max_concurrent 可热改（持久化配置）
 * - 占槽状态仅 running；gate-wait / user-held / watching 均释放槽（状态持久化可恢复）
 * - 排队公平：FIFO（按创建时间）
 * 真隔离（PIDS_LIMIT/tmpfs/SECRET_ENV）为部署侧容器约束，开发态以工作区目录 + token 预算 + 引擎指令边界实现。
 */

export class Scheduler {
  private config: { maxConcurrent: number } = { maxConcurrent: 2 }
  /** 由 Platform 注入：取得槽后拉起 runner（await 派发，避免跨 tick 重复启动） */
  onStart: ((taskId: string) => void | Promise<void>) | null = null
  private starting = new Set<string>()

  constructor(private file: string) {}

  async init(): Promise<void> {
    const saved = await readJson<{ maxConcurrent: number }>(this.file)
    if (saved) this.config = saved
    else await writeJson(this.file, this.config)
  }  async setMaxConcurrent(n: number): Promise<void> {
    this.config = { maxConcurrent: Math.max(1, n) }
    await writeJson(this.file, this.config)
  }

  getMaxConcurrent(): number {
    return this.config.maxConcurrent
  }

  /**
   * 调度决策（纯函数，可测）：
   * 输入所有任务状态摘要，输出应启动的任务（公平 FIFO，不超限）。
   */
  plan(all: { taskId: string; status: string; createdAt: string }[]): string[] {
    const running = all.filter((t) => t.status === 'running')
    const queued = all
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId))
    const slots = this.config.maxConcurrent - running.length
    if (slots <= 0) return []
    return queued.slice(0, slots).map((t) => t.taskId)
  }

  /** 执行一次调度：把 plan 结果交给 onStart（await，确保启动落盘后本 tick 才结束） */
  async tick(all: { taskId: string; status: string; createdAt: string }[]): Promise<string[]> {
    const toStart = this.plan(all).filter((id) => !this.starting.has(id))
    for (const id of toStart) {
      this.starting.add(id)
      try {
        await this.onStart?.(id)
      } finally {
        this.starting.delete(id)
      }
    }
    return toStart
  }

  snapshot(all: { taskId: string; status: string }[]): SchedulerConfig {
    return {
      maxConcurrent: this.config.maxConcurrent,
      running: all.filter((t) => t.status === 'running').map((t) => t.taskId),
      queued: all.filter((t) => t.status === 'queued').map((t) => t.taskId),
      gateWaiting: all.filter((t) => t.status === 'gate-wait').map((t) => t.taskId),
      watching: all.filter((t) => t.status === 'watching').map((t) => t.taskId),
    }
  }
}
