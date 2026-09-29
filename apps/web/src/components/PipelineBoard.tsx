/**
 * 任务看板（双形态，multica 惯例：看板是钻取视图，不占首屏）：
 * - PipelineStrip：hero 常驻的紧凑一行 = 进度指示器（状态点/阶段名/产物数/R 轮次/当前状态图标）；
 *   点任一阶段 → onOpenBoard(sid) 切到看板页签并定位该列
 * - PipelineBoard（默认导出，看板页签）：列 = 阶段 · 卡 = 产物 · 门决策足迹；
 *   focus（外部注入，nonce 允许重复定位同一列）驱动滚动到目标列
 *
 * multica 看板解剖 → 单任务管线映射：
 * - 列 = 状态 → 列 = 阶段（9 阶段主干 + 终态；头部状态点/计数/轮次/👤·AI 署名）
 * - 卡 = issue（标题/指派/标签）→ 卡 = 产物（文件名/分区徽标/大小/主权角色；点击直达材料页）
 * - 列状态色 → done（绿）/ current（品牌色，运行中脉冲）/ todo（灰）/ 停止（红）
 * - 足迹 → 每列底部：门决策署名（谁拍板·动作）或当前状态行（AI 作业中/门等待/排队/接管/停止）
 * - 回退角标 ↩：该阶段被声明式回退重做过（R 轮次）
 * 铁门纪律不变：看板只读 + 点击跳转，阶段推进仍走门
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GateAction, SemanticEvent, StageId, TaskState } from '@ai-platform/shared'
import { GATE_META, STAGES, STAGE_ORDER } from '@ai-platform/shared'
import { fmtBytes, fmtTime } from '../format'

const ACTION_LABEL: Record<GateAction, string> = {
  approve: '通过',
  reject: '驳回',
  answer: '作答',
  rollback: '打回',
  merge: '合入',
  degrade: '降级',
}

/** 从事件流聚合每阶段足迹：最后的门决策 + 是否被回退重做（append-only 重放） */
interface StageTrace {
  gate?: { action: GateAction; byName: string; at: string }
  rolledBack: boolean
}

function aggregateTraces(events: SemanticEvent[]): Map<StageId, StageTrace> {
  const m = new Map<StageId, StageTrace>()
  const get = (sid: StageId): StageTrace => {
    let t = m.get(sid)
    if (!t) {
      t = { rolledBack: false }
      m.set(sid, t)
    }
    return t
  }
  for (const ev of events) {
    if (ev.kind === 'gate_decided') {
      const p = ev.payload as { action: GateAction; decidedByName: string }
      get(ev.stage).gate = { action: p.action, byName: p.decidedByName, at: ev.ts }
    } else if (ev.kind === 'rollback') {
      const p = ev.payload as { to: StageId }
      get(p.to).rolledBack = true
    }
  }
  return m
}

const PARTITION_CLS: Record<string, string> = { delivery: 'pp-delivery', process: 'pp-process', knowledge: 'pp-knowledge' }

/** 当前阶段的一字符状态图标（紧凑条的"谁在干/等谁"速览） */
function currentStatusIcon(state: TaskState): string {
  switch (state.status) {
    case 'running':
      return '🤖'
    case 'gate-wait':
      return '🟡'
    case 'queued':
      return '⏳'
    case 'user-held':
      return '✋'
    case 'failed':
      return '💥'
    case 'watching':
      return '👀'
    case 'aggregating':
      return '⧉'
    case 'merged':
      return '✔'
    default:
      return ''
  }
}

/** 阶段产物分组（紧凑条与看板共用） */
function groupByStage(state: TaskState): Map<StageId, TaskState['artifacts']> {
  const m = new Map<StageId, TaskState['artifacts']>()
  for (const sid of STAGE_ORDER) m.set(sid, [])
  for (const a of state.artifacts) m.get(a.stage)?.push(a)
  for (const list of m.values()) list.sort((x, y) => x.path.localeCompare(y.path))
  return m
}

/**
 * 紧凑条（hero 常驻）：一行阶段 chip = 任务进度指示器。
 * 点击任一阶段 → onOpenBoard(sid)：看板页签定位该列（大看板不占首屏）。
 */
export function PipelineStrip({
  state,
  events,
  onOpenBoard,
}: {
  state: TaskState
  events: SemanticEvent[]
  onOpenBoard: (sid: StageId) => void
}): React.JSX.Element {
  const cur = STAGE_ORDER.indexOf(state.stage)
  const traces = useMemo(() => aggregateTraces(events), [events])
  const byStage = useMemo(() => groupByStage(state), [state])

  return (
    <div className="pipe-compact" role="list">
      {STAGE_ORDER.map((sid, i) => {
        const meta = STAGES[sid]
        const arts = byStage.get(sid) ?? []
        const rounds = state.stageRounds[sid] ?? 0
        const st = i < cur ? 'done' : i === cur ? 'current' : 'todo'
        const trace = traces.get(sid)
        const gateHint = trace?.gate ? `；${trace.gate.byName}·${ACTION_LABEL[trace.gate.action]}` : ''
        return (
          <button
            key={sid}
            className={`pipe-chip ${st} ${state.status === 'failed' && st === 'current' ? 'failed' : ''}`}
            onClick={() => onOpenBoard(sid)}
            title={`${meta.label}：${meta.desc}\n退出条件：${meta.exitCondition}\n产物 ${arts.length} 个${gateHint}\n点击到看板查看产物卡与门足迹`}
            role="listitem"
          >
            <span className={`pipe-dot ${st === 'current' && state.status === 'running' ? 'running' : ''}`} />
            <span className="pipe-chip-name">{meta.shortLabel}</span>
            {rounds > 1 && <span className="pipe-rounds">R{rounds}</span>}
            {trace?.rolledBack && <span className="pipe-rollback">↩</span>}
            {arts.length > 0 && <span className="pipe-chip-count">{arts.length}</span>}
            {st === 'current' && <span className="pipe-chip-status">{currentStatusIcon(state)}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** 完整看板（看板页签）：列 = 阶段 · 卡 = 产物 · 门足迹；focus 定位目标列 */
export default function PipelineBoard({
  state,
  events,
  onOpenArtifact,
  focus,
}: {
  state: TaskState
  events: SemanticEvent[]
  /** 打开指定产物（切材料页+展开查看器）；传 null = 只切材料页看全量列表（「+N 更多」入口） */
  onOpenArtifact: (path: string | null) => void
  /** 外部定位请求：{sid, nonce}（nonce 允许重复点击同一阶段也重新定位） */
  focus?: { sid: StageId | null; nonce: number }
}): React.JSX.Element {
  const cur = STAGE_ORDER.indexOf(state.stage)
  const traces = useMemo(() => aggregateTraces(events), [events])
  const byStage = useMemo(() => groupByStage(state), [state])
  /** 「+N 更多」原地展开的阶段（列内展示全部产物，不跨栏跳转） */
  const [moreOpen, setMoreOpen] = useState<Set<StageId>>(new Set())
  const boardRef = useRef<HTMLDivElement | null>(null)

  // 外部定位：滚动到目标列（紧凑条点阶段 → 看板页签 → 这里）
  useEffect(() => {
    if (!focus?.sid || !boardRef.current) return
    const el = boardRef.current.querySelector<HTMLElement>(`[data-sid="${focus.sid}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }, [focus])

  return (
    <div className="pipeline-board" ref={boardRef} role="list">
      {STAGE_ORDER.map((sid, i) => {
        const meta = STAGES[sid]
        const arts = byStage.get(sid) ?? []
        const rounds = state.stageRounds[sid] ?? 0
        const st = i < cur ? 'done' : i === cur ? 'current' : 'todo'
        const trace = traces.get(sid)
        const running = st === 'current' && state.status === 'running'
        return (
          <section key={sid} data-sid={sid} className={`pipe-col ${st} ${state.status === 'failed' && st === 'current' ? 'failed' : ''}`} role="listitem">
            <header className="pipe-head" title={`${meta.label}：${meta.desc}\n退出条件：${meta.exitCondition}`}>
              <span className={`pipe-dot ${running ? 'running' : ''}`} />
              <span className="pipe-name">{meta.shortLabel}</span>
              <span className="pipe-tag" title={meta.automatable ? '主体工作 AI 可自动推进' : '人工阶段（铁门拍板）'}>
                {meta.automatable ? 'AI' : '👤'}
              </span>
              {rounds > 1 && (
                <span className="pipe-rounds" title={`第 ${rounds} 轮（回退重做，不从头跑）`}>
                  R{rounds}
                </span>
              )}
              {trace?.rolledBack && <span className="pipe-rollback" title="曾被声明式回退到本阶段">↩</span>}
              {arts.length > 0 && <span className="pipe-count" title={`${arts.length} 个产物`}>{arts.length}</span>}
            </header>
            <div className="pipe-body">
              {st === 'current' && <CurrentStatusLine state={state} />}
              {(moreOpen.has(sid) ? arts : arts.slice(0, 3)).map((a) => (
                <button key={a.path} className={`pipe-card ${PARTITION_CLS[a.partition] ?? 'pp-process'}`} onClick={() => onOpenArtifact(a.path)} title={`${a.path}\n${a.partition} 区 · 主权 ${a.sovereignRole} · ${fmtBytes(a.bytes)} · ${fmtTime(a.updatedAt)}\n点击在材料页查看内容`}>
                  <span className="pipe-card-dot" />
                  <span className="pipe-card-name">{a.path.split('/').pop()}</span>
                  <span className="pipe-card-bytes">{fmtBytes(a.bytes)}</span>
                </button>
              ))}
              {arts.length > 3 && (
                <button
                  className="pipe-more"
                  onClick={() =>
                    setMoreOpen((s) => {
                      const n = new Set(s)
                      if (n.has(sid)) n.delete(sid)
                      else n.add(sid)
                      return n
                    })
                  }
                  title={`原地展开该阶段全部 ${arts.length} 个产物`}
                >
                  {moreOpen.has(sid) ? '收起' : `+${arts.length - 3} 更多…`}
                </button>
              )}
              {st === 'todo' && arts.length === 0 && <span className="pipe-empty">—</span>}
            </div>
            <footer className="pipe-foot">
              {st === 'done' || (trace?.gate && i < cur) ? (
                trace?.gate ? (
                  <span className="pipe-gate-trace" title={`${trace.gate.byName} 于 ${fmtTime(trace.gate.at)} 拍板`}>
                    ⚖ {trace.gate.byName}·{ACTION_LABEL[trace.gate.action]}
                  </span>
                ) : (
                  <span className="pipe-done-mark">✓ 完成</span>
                )
              ) : st === 'todo' ? (
                <span className="pipe-foot-dim">待进入</span>
              ) : null}
            </footer>
          </section>
        )
      })}
    </div>
  )
}

/** 当前阶段的状态行（谁在干/等谁）：multica 卡片 assignee 行的等价物 */
function CurrentStatusLine({ state }: { state: TaskState }): React.JSX.Element | null {
  if (state.status === 'running') return <div className="pipe-status running">🤖 AI 作业中（{state.engineId}）</div>
  if (state.status === 'gate-wait' && state.gate) {
    const meta = GATE_META[state.gate.kind]
    return (
      <div className="pipe-status gate" title={state.gate.question}>
        🟡 {meta.label} · 等 {state.gate.soleDecider.name}
      </div>
    )
  }
  if (state.status === 'queued') return <div className="pipe-status dim">⏳ 排队（并发槽）</div>
  if (state.status === 'user-held') return <div className="pipe-status held">✋ 人接管中</div>
  if (state.status === 'failed') return <div className="pipe-status failed">💥 停止待修复</div>
  if (state.status === 'watching') return <div className="pipe-status dim">👀 MR 监听态</div>
  if (state.status === 'aggregating') return <div className="pipe-status dim">⧉ AR 聚合中</div>
  if (state.status === 'merged') return <div className="pipe-status done">✔ 已合入</div>
  return null
}
