import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../src/runtime/scheduler.js'
import { triageComment, computeReadiness } from '../src/orchestrator/watcher.js'
import type { DeliveryStateFile } from '../src/orchestrator/workers.js'

const tmpFiles: string[] = []

async function makeScheduler(): Promise<Scheduler> {
  const file = path.join(await fs.mkdtemp(path.join(tmpdir(), 'sched-')), 'scheduler.json')
  tmpFiles.push(path.dirname(file))
  const s = new Scheduler(file)
  await s.init()
  return s
}

afterEach(async () => {
  for (const d of tmpFiles.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
})

describe('调度器（场景8：门不占并发槽）', () => {
  it('FIFO 公平调度且不超 maxConcurrent', () => {
    const s = new Scheduler('')
    const all = [
      { taskId: 'b', status: 'queued', createdAt: '2026-01-02T00:00:00Z' },
      { taskId: 'a', status: 'queued', createdAt: '2026-01-01T00:00:00Z' },
      { taskId: 'c', status: 'queued', createdAt: '2026-01-03T00:00:00Z' },
    ]
    expect(s.plan(all)).toEqual(['a', 'b']) // 默认 2 槽
  })

  it('gate-wait / watching / user-held 不占槽，仅 running 占槽', () => {
    const s = new Scheduler('')
    const all = [
      { taskId: 'r1', status: 'running', createdAt: '1' },
      { taskId: 'g1', status: 'gate-wait', createdAt: '1' },
      { taskId: 'g2', status: 'gate-wait', createdAt: '1' },
      { taskId: 'w1', status: 'watching', createdAt: '1' },
      { taskId: 'h1', status: 'user-held', createdAt: '1' },
      { taskId: 'q1', status: 'queued', createdAt: '1' },
    ]
    expect(s.plan(all)).toEqual(['q1'])
  })

  it('maxConcurrent 热改生效', async () => {
    const s = await makeScheduler()
    await s.setMaxConcurrent(4)
    expect(s.getMaxConcurrent()).toBe(4)
    const all = Array.from({ length: 6 }, (_, i) => ({ taskId: `t${i}`, status: 'queued', createdAt: String(i) }))
    expect(s.plan(all)).toHaveLength(4)
  })

  it('满槽时不调度；释放后继续', () => {
    const s = new Scheduler('')
    const all = [
      { taskId: 'r1', status: 'running', createdAt: '1' },
      { taskId: 'r2', status: 'running', createdAt: '2' },
      { taskId: 'q1', status: 'queued', createdAt: '3' },
    ]
    expect(s.plan(all)).toEqual([])
    const freed = [
      { taskId: 'r1', status: 'running', createdAt: '1' },
      { taskId: 'r2', status: 'gate-wait', createdAt: '2' }, // 举门释放槽
      { taskId: 'q1', status: 'queued', createdAt: '3' },
    ]
    expect(s.plan(freed)).toEqual(['q1'])
  })
})

describe('反馈分诊', () => {
  it('显式提示优先', () => {
    expect(triageComment('随便', 'needs-human')).toBe('needs-human')
    expect(triageComment('随便', 'info-only')).toBe('info-only')
    expect(triageComment('随便', 'auto-fixable')).toBe('auto-fixable')
  })

  it('文本启发：阻塞/必须/改架构 → 需人；nit/建议 → 提示；其余 → 自动可修', () => {
    expect(triageComment('这里必须改')).toBe('needs-human')
    expect(triageComment('建议改架构')).toBe('needs-human')
    expect(triageComment('nit: 变量名可读性')).toBe('info-only')
    expect(triageComment('typo in comment')).toBe('auto-fixable')
  })
})

describe('合入就绪（fail-closed 三条件）', () => {
  const sha = 'abc123'
  function ds(partial: Partial<DeliveryStateFile>): DeliveryStateFile {
    return {
      lastSeenVersion: 0,
      processedExternalIds: [],
      pipelinedShas: [],
      feedback: [],
      evidence: [],
      ...partial,
    }
  }

  it('流水线未绿 / 反馈未消化均不可合入', () => {
    const r1 = computeReadiness(sha, ds({}))
    expect(r1.ready).toBe(false)
    expect(r1.blockers.join()).toContain('流水线')

    const r2 = computeReadiness(
      sha,
      ds({
        evidence: [{ kind: 'pipeline', ref: 'run', sha, ok: true, ts: '', stale: false }],
        feedback: [
          { feedbackId: 'f', source: 'mr-comment', externalId: 'x', text: 't', sha, ts: '', triage: 'auto-fixable', status: 'new' },
        ],
      }),
    )
    expect(r2.ready).toBe(false)
    expect(r2.allFeedbackDigested).toBe(false)
  })

  it('SHA 变更后旧流水线证据失效（stale）', () => {
    const r = computeReadiness(
      sha,
      ds({
        evidence: [{ kind: 'pipeline', ref: 'run', sha: 'old999', ok: true, ts: '', stale: true }],
      }),
    )
    expect(r.pipelineGreenOnCurrentSha).toBe(false)
  })

  it('真绿 + 反馈全消化 → ready', () => {
    const r = computeReadiness(
      sha,
      ds({
        evidence: [{ kind: 'pipeline', ref: 'run', sha, ok: true, ts: '', stale: false }],
        feedback: [
          { feedbackId: 'f1', source: 'mr-comment', externalId: 'x', text: 't', sha, ts: '', triage: 'info-only', status: 'logged' },
          { feedbackId: 'f2', source: 'pipeline', externalId: 'y', text: 't', sha, ts: '', triage: 'auto-fixable', status: 'fixed' },
        ],
      }),
    )
    expect(r.ready).toBe(true)
    expect(r.blockers).toEqual([])
  })
})
