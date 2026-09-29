/**
 * 质量度量视图（顶层 · #/metrics）：事件流只读派生的回顾性聚合
 *
 * 安置原则（multica/Linear 惯例）：分析归独立顶层视图，首页只留迷你 KPI 条。
 * - KPI 行：TTM 中位/均值 · 已合入 · 回退/修复轮
 * - 双栏：阶段平均活跃时长（条形图）｜门等待统计（raise → decide，降级也算真实等待）
 * - 任务 TTM 一览：全量任务（独立视图不再截 6 条）
 * 实时性：签名驱动重算——SSE 推任务卡片 → 阶段/状态/门签名变化 → 重新聚合（事件流只读派生，重算廉价）
 */
import { useEffect, useMemo, useState } from 'react'
import type { MetricsView as MetricsViewData, StageId } from '@ai-platform/shared'
import { STAGES, STAGE_ORDER } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { STATUS_META, fmtDur } from '../format'

export default function MetricsView(): React.JSX.Element {
  const { cards, pushToast } = useApp()
  const [view, setView] = useState<MetricsViewData | null>(null)
  const [busy, setBusy] = useState(false)

  // 与首页迷你条同源机制：任一任务阶段/状态/门变化即重聚合
  const signature = useMemo(() => cards.map((c) => `${c.taskId}:${c.stage}:${c.status}:${c.gateKind ?? ''}`).join('|'), [cards])

  const load = async (): Promise<void> => {
    setBusy(true)
    try {
      setView(await api.metrics())
    } catch (e) {
      pushToast(`度量加载失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const s = view?.summary
  const stageBars =
    s &&
    STAGE_ORDER.filter((sid) => sid !== 'merged' && s.stageAvgMs[sid] !== undefined).map((sid) => ({
      sid: sid as StageId,
      label: STAGES[sid].shortLabel,
      ms: s.stageAvgMs[sid] as number,
    }))
  const stageMax = stageBars ? Math.max(...stageBars.map((b) => b.ms), 1) : 1

  return (
    <div className="page-view metrics-view">
      <div className="page-toolbar">
        <div className="hall-title">
          <h2>质量度量</h2>
          <span className="hint">TTM / 阶段耗时 / 门等待 / 回退 —— 全部由语义事件流只读派生，可回放追溯</span>
        </div>
        <button className="btn sm ghost" disabled={busy} onClick={() => void load()} title="重新聚合（从语义事件流重算）">
          {busy ? '聚合中…' : '刷新'}
        </button>
      </div>

      {!s ? (
        <div className="hint">聚合中…</div>
      ) : s.taskCount === 0 ? (
        <div className="empty-big">暂无任务。创建任务合入后，这里给出 TTM / 阶段耗时 / 门等待 / 回退等度量。</div>
      ) : (
        <>
          <div className="metrics-kpis">
            <div className="kpi">
              <span className="kpi-v">{fmtDur(s.medianTtmMs)}</span>
              <span className="kpi-k" title="已合入任务：创建 → 合入 中位数">
                TTM 中位
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-v">{fmtDur(s.avgTtmMs)}</span>
              <span className="kpi-k" title="已合入任务 TTM 均值">
                TTM 均值
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-v">
                {s.mergedCount}/{s.taskCount}
              </span>
              <span className="kpi-k" title={`活跃 ${s.activeCount} · 失败 ${s.failedCount}`}>
                已合入/任务
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-v">{s.avgRollbacks}</span>
              <span className="kpi-k" title="平均声明式回退次数；修复轮均值">
                回退/修复 {s.avgRepairRounds}
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-v">{s.firstPassRate !== null ? `${Math.round(s.firstPassRate * 100)}%` : '—'}</span>
              <span className="kpi-k" title={`已合入 ${s.mergedCount} 个任务中 ${s.firstPassCount} 个零回退零修复轮直达合入（一次做对）`}>
                一次通过 {s.firstPassCount}/{s.mergedCount}
              </span>
            </div>
          </div>

          <div className="metrics-grid">
            <section className="metrics-card">
              <div className="metrics-sub">阶段平均活跃时长（含门等待；回退重做累加）</div>
              <div className="metrics-bars">
                {stageBars?.map((b) => (
                  <div
                    key={b.sid}
                    className="metrics-bar"
                    title={`${STAGES[b.sid].label}：均值 ${fmtDur(b.ms)}${s.stageFirstPassRate[b.sid] !== undefined ? `；单轮完成占比 ${Math.round((s.stageFirstPassRate[b.sid] as number) * 100)}%` : ''}`}
                  >
                    <span className="mb-label">{b.label}</span>
                    <span className="mb-track">
                      <span className={`mb-fill ${b.sid === 'requirement' || b.sid === 'test-design' ? '' : 'auto'}`} style={{ width: `${Math.max(3, Math.round((b.ms / stageMax) * 100))}%` }} />
                    </span>
                    <span className="mb-val">{fmtDur(b.ms)}</span>
                    {s.stageFirstPassRate[b.sid] !== undefined && (
                      <span className="mb-fp" title="阶段一次通过率：进入过该阶段的任务中单轮完成（未被回退重做）占比">
                        {Math.round((s.stageFirstPassRate[b.sid] as number) * 100)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="metrics-card">
              <div className="metrics-sub">门等待（raise → decide，降级也算真实等待）</div>
              <div className="metrics-gates">
                {s.gateStats.length === 0 && <span className="hint">暂无已决门</span>}
                {s.gateStats.map((g) => (
                  <div key={g.kind} className="mg-row" title={`${g.kind} 门：${g.count} 次，总等待 ${fmtDur(g.totalMs)}，最长 ${fmtDur(g.maxMs)}`}>
                    <span className="mg-kind">{g.kind}</span>
                    <span className="mg-num">×{g.count}</span>
                    <span className="mg-avg">均 {fmtDur(g.avgMs)}</span>
                    <span className="mg-avg">峰 {fmtDur(g.maxMs)}</span>
                    {g.degraded > 0 && <span className="mg-deg" title="超时降级（待追认）">降级{g.degraded}</span>}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="metrics-card">
            <div className="metrics-sub">任务 TTM 一览（全量）</div>
            <div className="metrics-tasks">
              {view?.tasks
                .slice()
                .sort((a, b) => b.seq - a.seq)
                .map((t) => (
                  <a key={t.taskId} className="mt-row" href={`#/task/${t.taskId}`} title={`创建 ${t.createdAt}${t.mergedAt ? ` · 合入 ${t.mergedAt}` : ''} · 事件 ${t.eventCount} 条`}>
                    <span className="mt-seq">#{t.seq}</span>
                    <span className="mt-title">{t.title}</span>
                    <span className={`badge ${STATUS_META[t.status]?.cls ?? ''}`}>
                      {STATUS_META[t.status]?.label ?? t.status}
                    </span>
                    <span className="mt-ttm" title={t.ttmMs !== null ? 'TTM（创建→合入）' : '在制时长（未合入）'}>
                      {fmtDur(t.ttmMs ?? t.ageMs)}
                    </span>
                    {t.rollbacks > 0 && (
                      <span className="mt-rb" title="声明式回退次数">
                        ↺{t.rollbacks}
                      </span>
                    )}
                    {t.firstPass && (
                      <span className="mt-fp" title="一次通过：零回退零修复轮直达合入">
                        一次✓
                      </span>
                    )}
                  </a>
                ))}
            </div>
          </section>

          <small className="hint">
            共 {s.taskCount} 任务 · {s.totalEvents} 条语义事件可回放（全流程追溯）
          </small>
        </>
      )}
    </div>
  )
}
