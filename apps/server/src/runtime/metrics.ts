import type {
  GateKind,
  GateWaitStat,
  MetricsSummary,
  MetricsView,
  SemanticEvent,
  StageId,
  TaskMetrics,
  TaskState,
} from '@ai-platform/shared'
import { STAGE_ORDER } from '@ai-platform/shared'
import type { Platform } from '../orchestrator/platform.js'

/**
 * 质量度量聚合（研发作业流 · TTM / 全流程追溯）
 *
 * 只读派生：全部从语义事件流（append-only JSONL）与状态真源重算，不引入第二份真相。
 *  - 阶段活跃时长：stage_entered → stage_exited / rollback（回退重做累加，体现真实投入）
 *  - 门等待：gate_raised → gate_decided（降级也算真实等待）
 *  - TTM：createdAt → 末次 deliver 完成退出（仅已合入任务计入统计）
 *  - 一次通过：零回退零修复轮直达合入；阶段一次通过 = 单轮进入完成（stage_entered.round 派生）
 */

const ts = (e: SemanticEvent): number => Date.parse(e.ts)

interface KindAgg {
  count: number
  totalMs: number
  maxMs: number
  degraded: number
}

function mergeGateAgg(map: Map<GateKind, KindAgg>, kind: GateKind, waitMs: number, degraded: boolean): void {
  const agg = map.get(kind) ?? { count: 0, totalMs: 0, maxMs: 0, degraded: 0 }
  agg.count += 1
  agg.totalMs += waitMs
  agg.maxMs = Math.max(agg.maxMs, waitMs)
  if (degraded) agg.degraded += 1
  map.set(kind, agg)
}

function toGateWaits(map: Map<GateKind, KindAgg>): GateWaitStat[] {
  return [...map.entries()].map(([kind, a]) => ({
    kind,
    count: a.count,
    totalMs: a.totalMs,
    avgMs: Math.round(a.totalMs / Math.max(1, a.count)),
    maxMs: a.maxMs,
    degraded: a.degraded,
  }))
}

export function computeTaskMetrics(state: TaskState, events: SemanticEvent[], nowMs = Date.now()): TaskMetrics {
  // ---- 阶段活跃时长（段式累加：enter 开段，exit/rollback 关段）+ 阶段最大轮次 ----
  const stageTimingsMs: Partial<Record<StageId, number>> = {}
  const stageMaxRounds: Partial<Record<StageId, number>> = {}
  let curStage: StageId | null = null
  let curStageAt = 0
  const closeSegment = (at: number): void => {
    if (curStage !== null) {
      stageTimingsMs[curStage] = (stageTimingsMs[curStage] ?? 0) + Math.max(0, at - curStageAt)
      curStage = null
    }
  }

  // ---- 门等待（gateId 配对 raise → decide；未决门不计入等待统计） ----
  const gateAgg = new Map<GateKind, KindAgg>()
  const raisedGates = new Map<string, { at: number; kind: GateKind }>()

  let rollbacks = 0
  let mergedAt: number | null = null

  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>
    switch (e.kind) {
      case 'stage_entered': {
        // 每次进入开新段（回退重做的段由 rollback 事件已关闭前段）；round 记录该阶段第几轮进入
        closeSegment(ts(e))
        curStage = p.stage as StageId
        curStageAt = ts(e)
        const round = Number(p.round ?? 1)
        stageMaxRounds[curStage] = Math.max(stageMaxRounds[curStage] ?? 0, round)
        break
      }
      case 'stage_exited': {
        if (curStage === (p.stage as StageId)) closeSegment(ts(e))
        if (p.stage === 'deliver' && p.reason === 'completed') mergedAt = ts(e) // 末次合入（回退环后重合入取最新）
        break
      }
      case 'rollback': {
        if (curStage === (p.from as StageId)) closeSegment(ts(e))
        rollbacks += 1
        break
      }
      case 'gate_raised': {
        raisedGates.set(String(p.gateId), { at: ts(e), kind: p.gateKind as GateKind })
        break
      }
      case 'gate_decided': {
        const raised = raisedGates.get(String(p.gateId))
        if (raised) {
          mergeGateAgg(gateAgg, raised.kind, Math.max(0, ts(e) - raised.at), p.action === 'degrade')
          raisedGates.delete(String(p.gateId))
        }
        break
      }
      default:
        break
    }
  }
  // 进行中的开段（当前阶段活跃时长计入，含门等待——门等待本身就是阶段时长的一部分）
  closeSegment(nowMs)

  const isMerged = state.status === 'merged' || state.status === 'archived'
  const createdAtMs = Date.parse(state.createdAt)

  return {
    taskId: state.taskId,
    seq: state.seq,
    title: state.title,
    module: state.module,
    status: state.status,
    stage: state.stage,
    createdAt: state.createdAt,
    mergedAt: mergedAt !== null ? new Date(mergedAt).toISOString() : null,
    ttmMs: isMerged && mergedAt !== null ? Math.max(0, mergedAt - createdAtMs) : null,
    ageMs: isMerged ? null : Math.max(0, nowMs - createdAtMs),
    rollbacks,
    repairRounds: state.repairRounds,
    firstPass: isMerged && rollbacks === 0 && state.repairRounds === 0,
    stageMaxRounds,
    stageTimingsMs,
    gateWaits: toGateWaits(gateAgg),
    eventCount: events.length,
  }
}

export async function buildMetricsView(platform: Platform, nowMs = Date.now()): Promise<MetricsView> {
  const states = await platform.store.listAll()
  const tasks: TaskMetrics[] = []
  for (const st of states) {
    const events = await platform.store.eventLog(st.taskId).read()
    tasks.push(computeTaskMetrics(st, events, nowMs))
  }

  const merged = tasks.filter((t) => t.ttmMs !== null)
  const ttms = merged.map((t) => t.ttmMs as number).sort((a, b) => a - b)
  const median = ttms.length > 0 ? ttms[Math.floor((ttms.length - 1) / 2)] : null

  const mergedStatus = tasks.filter((t) => t.status === 'merged' || t.status === 'archived')
  const firstPassCount = mergedStatus.filter((t) => t.firstPass).length
  const firstPassRate = mergedStatus.length > 0 ? Math.round((firstPassCount / mergedStatus.length) * 1000) / 1000 : null

  const stageAvgMs: Partial<Record<StageId, number>> = {}
  for (const sid of STAGE_ORDER) {
    const vals = tasks.map((t) => t.stageTimingsMs[sid]).filter((v): v is number => v !== undefined)
    if (vals.length > 0) stageAvgMs[sid] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
  }

  // 阶段一次通过率：进入过该阶段的任务中，单轮完成（maxRound === 1）的占比——「哪一段最容易返工」
  const stageFirstPassRate: Partial<Record<StageId, number>> = {}
  for (const sid of STAGE_ORDER) {
    const entered = tasks.filter((t) => t.stageMaxRounds[sid] !== undefined)
    if (entered.length > 0) {
      stageFirstPassRate[sid] = Math.round((entered.filter((t) => (t.stageMaxRounds[sid] as number) === 1).length / entered.length) * 1000) / 1000
    }
  }

  const gateAgg = new Map<GateKind, KindAgg>()
  for (const t of tasks) {
    for (const g of t.gateWaits) {
      const agg = gateAgg.get(g.kind) ?? { count: 0, totalMs: 0, maxMs: 0, degraded: 0 }
      agg.count += g.count
      agg.totalMs += g.totalMs
      agg.maxMs = Math.max(agg.maxMs, g.maxMs)
      agg.degraded += g.degraded
      gateAgg.set(g.kind, agg)
    }
  }

  const n = Math.max(1, tasks.length)
  const summary: MetricsSummary = {
    taskCount: tasks.length,
    mergedCount: mergedStatus.length,
    activeCount: tasks.filter((t) => ['queued', 'running', 'gate-wait', 'user-held', 'watching'].includes(t.status)).length,
    failedCount: tasks.filter((t) => t.status === 'failed').length,
    medianTtmMs: median,
    avgTtmMs: ttms.length > 0 ? Math.round(ttms.reduce((a, b) => a + b, 0) / ttms.length) : null,
    avgRollbacks: Math.round((tasks.reduce((a, t) => a + t.rollbacks, 0) / n) * 10) / 10,
    avgRepairRounds: Math.round((tasks.reduce((a, t) => a + t.repairRounds, 0) / n) * 10) / 10,
    firstPassCount,
    firstPassRate,
    stageFirstPassRate,
    totalEvents: tasks.reduce((a, t) => a + t.eventCount, 0),
    stageAvgMs,
    gateStats: toGateWaits(gateAgg),
  }

  return { summary, tasks }
}
