/**
 * 任务看板（TaskView 顶栏；替代旧线性阶段轨；UX 参考 multica 任务看板，手写 CSS 无依赖）
 *
 * 两档呈现（multica 惯例：看板是顶层视图，详情页不被大看板占屏）：
 * - 默认紧凑一行：状态点 + 阶段名 + 产物数 + 当前状态图标（谁在干/等谁速览）
 * - 展开完整看板：列 = 阶段 · 卡 = 产物 · 门决策足迹（展开态 localStorage 记忆）
 * - 点紧凑条任一阶段 → 展开看板并滚动定位到该列
 *
 * multica 看板解剖 → 单任务管线映射：
 * - 列 = 状态 → 列 = 阶段（9 阶段主干 + 终态；头部状态点/计数/轮次/👤·AI 署名）
 * - 卡 = issue（标题/指派/标签）→ 卡 = 产物（文件名/分区徽标/大小/主权角色；点击直达材料页）
 * - 列状态色 → done（绿）/ current（品牌色，运行中脉冲）/ todo（灰）/ 停止（红）
 * - 足迹 → 每列底部：门决策署名（谁拍板·动作）或当前状态行（AI 作业中/门等待/排队/接管/停止）
 * - 回退角标 ↩：该阶段被声明式回退重做过（R 轮次）
 * 铁门纪律不变：看板只读 + 点击跳转，阶段推进仍走门（与 HallView 看板同款原则）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GateAction, SemanticEvent, StageId, TaskState } from '@ai-platform/shared'
import { GATE_META, STAGES, STAGE_ORDER } from '@ai-platform/shared'
import { fmtBytes, fmtTime } from '../format'

interface Props {
  state: TaskState
  events: SemanticEvent[]
  /** 打开指定产物（切材料页+展开查看器）；传 null = 只切材料页看全量列表（「+N 更多」入口） */
  onOpenArtifact: (path: string | null) => void
}

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

export default function PipelineBoard({ state, events, onOpenArtifact }: Props): React.JSX.Element {
  const cur = STAGE_ORDER.indexOf(state.stage)
  // 默认紧凑一行（multica 惯例：看板是顶层视图，详情页不被大看板占屏）；
  // 展开态记忆在 localStorage，点紧凑条的阶段直达展开看板对应列
  const [expanded, setExpanded] = useState(() => localStorage.getItem('pipeline-expanded') === '1')
  const [focusSid, setFocusSid] = useState<StageId | null>(null)
  /** 「+N 更多」原地展开的阶段（列内展示全部产物，不跨栏跳转） */
  const [moreOpen, setMoreOpen] = useState<Set<StageId>>(new Set())
  const boardRef = useRef<HTMLDivElement | null>(null)
  const traces = useMemo(() => aggregateTraces(events), [events])
  const byStage = useMemo(() => {
    const m = new Map<StageId, typeof state.artifacts>()
    for (const sid of STAGE_ORDER) m.set(sid, [])
    for (const a of state.artifacts) m.get(a.stage)?.push(a)
    for (const list of m.values()) list.sort((x, y) => x.path.localeCompare(y.path))
    return m
  }, [state.artifacts])

  const toggle = (): void => {
    setExpanded((e) => {
      localStorage.setItem('pipeline-expanded', e ? '0' : '1')
      return !e
    })
  }

  /** 紧凑条点阶段 → 展开并滚到该列 */
  const expandTo = (sid: StageId): void => {
    setExpanded(true)
    localStorage.setItem('pipeline-expanded', '1')
    setFocusSid(sid)
  }

  // 展开后滚动到点选的列
  useEffect(() => {
    if (!expanded || !focusSid || !boardRef.current) return
    const el = boardRef.current.querySelector<HTMLElement>(`[data-sid="${focusSid}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
    setFocusSid(null)
  }, [expanded, focusSid])

  return (
    <div className="pipeline-wrap">
      {expanded ? (
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
      ) : (
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
                onClick={() => expandTo(sid)}
                title={`${meta.label}：${meta.desc}\n退出条件：${meta.exitCondition}\n产物 ${arts.length} 个${gateHint}\n点击展开看板查看产物卡与门足迹`}
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
      )}
      <button
        className="pipe-toggle"
        onClick={toggle}
        title={expanded ? '收起看板（紧凑一行）' : '展开任务看板（列=阶段 · 卡=产物 · 门足迹）'}
      >
        {expanded ? '⊟ 收起' : '▤ 展开看板'}
      </button>
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
