import path from 'node:path'
import { existsSync } from 'node:fs'
import type { Platform } from './platform.js'
import { runStageWorker } from './workers.js'

/**
 * TaskRunner（场景5 / 场景8）
 *
 * Runner 是无状态可续跑的阶段循环：每次迭代从真源加载状态再决策，
 * 因此门解除 / 接管 / 重启恢复后重新入队即可继续（[机-门不占并发槽]：挂起即释放并发槽）。
 * autonomy=human（人在控）时单步执行后回到等待，直到显式恢复自动。
 *
 * 任何 worker 异常都被捕获并安全落败（不产生 unhandled rejection，不拖垮进程）；
 * 任务可能已被删除（如测试清理临时目录），此时静默退出。
 * 真源损坏（目录在、state.json 不可解析）≠ 删除：告警留痕后退出，不静默蒸发。
 */

export class TaskRunner {
  private stopped = false
  attempts = 0
  private donePromise: Promise<void>

  constructor(
    private platform: Platform,
    private taskId: string,
  ) {
    this.donePromise = this.run()
  }

  stop(): void {
    this.stopped = true
    this.platform.abortSession(this.taskId, 'runner-stop')
  }

  /** 等待 runner 收敛（dispose 用，带兜底超时） */
  done(timeoutMs = 5_000): Promise<void> {
    return Promise.race([this.donePromise, new Promise<void>((r) => setTimeout(r, timeoutMs))])
  }

  private async run(): Promise<void> {
    try {
      let lastStage = ''
      for (;;) {
        if (this.stopped) break
        const state = await this.platform.store.load(this.taskId).catch(() => null)
        if (!state) {
          // 区分删除（正常回收）与损坏（目录在但真源不可载——后端已告警并保全 .corrupt 侧车）
          if (existsSync(path.dirname(this.platform.store.statePath(this.taskId)))) {
            // eslint-disable-next-line no-console
            console.error(`[runner] 任务 ${this.taskId} 真源不可载（损坏？）——runner 退出，等待人工修复侧车后重启恢复`)
          }
          break
        }
        if (state.status !== 'running') break // 挂起（门/监听/人在控/排队）→ 释放并发槽
        if (state.stage === 'merged') break

        if (state.stage !== lastStage) {
          this.attempts = 0
          lastStage = state.stage
        }

        let outcome: 'continue' | 'wait' | 'stop'
        try {
          outcome = await runStageWorker({ platform: this.platform, state, attempts: this.attempts })
        } catch (err) {
          // worker 异常安全网：如实落败（fail-closed），不带病推进
          try {
            await this.platform.store.mutate(this.taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'worker-crash' } }, (s) => {
              if (s.status === 'running') {
                s.status = 'failed'
                s.lifecycleNote = 'failed'
              }
            })
            await this.platform.store.eventLog(this.taskId).append(this.taskId, state.stage, { type: 'system' }, 'health_changed', {
              from: state.health.level,
              to: 'red',
              facts: [`阶段 ${state.stage} worker 异常：${(err as Error).message}`],
            })
          } catch {
            // 任务可能已不存在（测试清理）；吞掉避免 unhandled rejection
          }
          break
        }
        this.attempts += 1

        if (outcome === 'stop') break
        if (outcome === 'wait') break
        // continue → 视人在控状态决定是否单步停车
        const after = await this.platform.store.load(this.taskId).catch(() => null)
        if (!after || after.status !== 'running') break
        if (after.autonomy === 'human') {
          await this.platform.store.mutate(this.taskId, { expectedVersion: null }, (s) => {
            if (s.status === 'running') s.status = 'user-held'
          })
          break
        }
      }
    } catch {
      // 顶层兜底：runner 永不产生未观察拒绝（状态真源在文件，重启可恢复）
    } finally {
      this.platform.onRunnerDone(this.taskId)
    }
  }
}
