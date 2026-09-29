/**
 * 阶段看板（会话厅第二视图；UX 模式参考 multica 看板，手写 CSS 无依赖）：
 * - 列 = 9 阶段主干；卡 = 任务（紧凑形态）
 * - 拖拽不绕门（铁门纪律的看板化）：门等待卡拖到其它列 → 展开快拍板浮层
 *   （复用 GateCard：证据同屏、乐观锁、会诊全套不动）；其余情形弹回并如实说明原因
 * - 活动指示（multica activity-indicator 模式）：running 卡右上角脉冲点
 * - 署名（multica attribution 模式）：引擎徽标 = AI 干的；人在环徽标 = 人干的
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SemanticEvent, StageId, TaskCard } from '@ai-platform/shared'
import { STAGES, STAGE_ORDER, STAGE_PHASES } from '@ai-platform/shared'
import GateCard from './GateCard'
import { api } from '../api'
import { useApp } from '../store'
import { HEALTH_META, STATUS_META, fmtTime, renderEvent } from '../format'

interface Props {
  cards: TaskCard[]
  onOpen: (taskId: string) => void
}

export default function StageBoard({ cards, onOpen }: Props): React.JSX.Element {
  const { pushToast, refreshCards } = useApp()
  const [quickDecideId, setQuickDecideId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<StageId | null>(null)
  // peek 驻留阈值（multica MUL-5189 实测依据）：800ms 开——指针扫过不误触；
  // 150ms 关——留 hover 桥接时间让指针移进面板
  const [peekId, setPeekId] = useState<string | null>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  const peekEnter = (taskId: string): void => {
    window.clearTimeout(closeTimer.current)
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => setPeekId(taskId), 800)
  }
  const peekLeave = (): void => {
    window.clearTimeout(openTimer.current)
    closeTimer.current = window.setTimeout(() => setPeekId(null), 150)
  }
  const peekStay = (): void => window.clearTimeout(closeTimer.current)

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current)
      window.clearTimeout(closeTimer.current)
    },
    [],
  )

  const byStage = useMemo(() => {
    const m = new Map<StageId, TaskCard[]>()
    for (const s of STAGE_ORDER) m.set(s, [])
    for (const c of cards) m.get(c.stage)?.push(c)
    return m
  }, [cards])

  /** 拖放的诚实语义：拖动不是状态写入，是"我想推进"的手势 */
  const handleDrop = (target: StageId, taskId: string): void => {
    setDragOver(null)
    const card = cards.find((c) => c.taskId === taskId)
    if (!card || card.stage === target) return
    if (card.status === 'gate-wait') {
      setQuickDecideId(taskId) // 门在：拖动直达拍板（不绕门，证据同屏）
      return
    }
    const why =
      card.status === 'running'
        ? '引擎正在作业中：阶段推进由平台按产物证据自动裁决（不信自报），不能手动拖动'
        : card.status === 'queued'
          ? '排队中：调度器将按并发槽推进'
          : card.status === 'user-held'
            ? '人在环接管中：请进任务工作区恢复自动或下达指令'
            : card.status === 'failed'
              ? '任务已停止：请进任务工作区下达修复指令复活'
              : '阶段推进走门禁：当前无门可拍'
    pushToast(`看板不绕门——${why}`, 'warn')
  }

  return (
    <div className="stage-board">
      {/* 两段分组横幅（顶部一行）：设计段（人与AI共创）｜执行段（AI自动化+人审核） */}
      <div className="pipe-phases-banner board-phases-banner" role="group" aria-label="阶段两段分组">
        {STAGE_PHASES.map((g) => (
          <span key={g.id} className={`pipe-phase ${g.id}`} title={`${g.label}：${g.hint}`}>
            <span className={`pipe-phase-dot ${g.id}`} />
            <span className="pipe-phase-label">{g.label}</span>
            <span className="pipe-phase-hint">{g.hint}</span>
          </span>
        ))}
      </div>
      <div className="stage-board-cols">
      {STAGE_PHASES.map((g) => (
        <div key={g.id} className={`board-col-group ${g.id}`} role="group" aria-label={g.label}>
          <div className="board-group-cols">
            {g.stages.map((stage) => {
              const meta = STAGES[stage]
              const list = byStage.get(stage) ?? []
              return (
                <section
                  key={stage}
                  className={`board-col ${dragOver === stage ? 'drag-over' : ''}`}
                  data-stage={stage}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('text/task-id')) {
                      e.preventDefault()
                      setDragOver(stage)
                    }
                  }}
                  onDragLeave={() => setDragOver((s) => (s === stage ? null : s))}
                  onDrop={(e) => {
                    const taskId = e.dataTransfer.getData('text/task-id')
                    if (taskId) handleDrop(stage, taskId)
                  }}
                >
                  <header className="board-col-head" title={`${meta.desc}\n退出条件：${meta.exitCondition}`}>
                    <span className="board-col-no">{meta.no}</span>
                    <span className="board-col-title">{meta.shortLabel}</span>
                    <span className="board-col-count">{list.length}</span>
                    {meta.automatable && <span className="board-col-auto" title="主体工作 AI 可自动推进">AI</span>}
                  </header>
                  <div className="board-col-body">
                    {list.map((c) => (
                      <BoardCard
                        key={c.taskId}
                        card={c}
                        onOpen={onOpen}
                        onQuickDecide={() => setQuickDecideId(c.taskId)}
                        onPeekEnter={() => peekEnter(c.taskId)}
                        onPeekLeave={peekLeave}
                      />
                    ))}
                    {list.length === 0 && <div className="board-col-empty">—</div>}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      ))}
      </div>
      {quickDecideId && <QuickDecide taskId={quickDecideId} onClose={() => setQuickDecideId(null)} onDecided={refreshCards} />}
      {peekId && !quickDecideId && (
        <BoardPeek
          taskId={peekId}
          onStay={peekStay}
          onLeave={peekLeave}
          onOpen={(id) => {
            setPeekId(null)
            onOpen(id)
          }}
          onQuickDecide={() => setQuickDecideId(peekId)}
        />
      )}
    </div>
  )
}

function BoardCard({
  card,
  onOpen,
  onQuickDecide,
  onPeekEnter,
  onPeekLeave,
}: {
  card: TaskCard
  onOpen: (taskId: string) => void
  onQuickDecide: () => void
  onPeekEnter: () => void
  onPeekLeave: () => void
}): React.JSX.Element {
  const gateWaiting = card.status === 'gate-wait' && !!card.gateKind
  return (
    <article
      className="board-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', card.taskId)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(card.taskId)}
      onMouseEnter={onPeekEnter}
      onMouseLeave={onPeekLeave}
      title={gateWaiting ? '拖到其它列或点「拍板」直达决策卡（证据同屏）' : '点击进入任务工作区；悬停可预览'}
    >
      {card.status === 'running' && (
        <span className="activity-dot" title={`AI 正在此任务作业（引擎 ${card.engineId}）`} />
      )}
      <div className="board-card-top">
        <span className="task-seq">#{card.seq}</span>
        <h4>{card.title}</h4>
        <span className={`health ${HEALTH_META[card.health.level].cls}`} title={card.health.facts.map((f) => f.message).join('\n') || HEALTH_META[card.health.level].label}>
          ●
        </span>
      </div>
      <div className="board-card-mid">
        <span className={`badge sm ${STATUS_META[card.status].cls}`}>{STATUS_META[card.status].label}</span>
        {card.repairRounds > 0 && <span className="badge sm bg-misc">修{card.repairRounds}轮</span>}
        {card.subtasks && (
          <span className="badge sm bg-agg">
            ⧉ {card.subtasks.filter((s) => s.status === 'merged' || s.status === 'archived').length}/{card.subtasks.length}
          </span>
        )}
        {card.autonomy === 'human' && <span className="badge sm bg-held">人在环</span>}
      </div>
      {gateWaiting ? (
        <p className="board-card-gate" onClick={(e) => { e.stopPropagation(); onQuickDecide() }}>
          🟡 {card.gateQuestion ?? '门等待中'}
        </p>
      ) : (
        card.gateQuestion && <p className="board-card-gate dim">🟡 {card.gateQuestion}</p>
      )}
      <footer className="board-card-foot">
        <span>{card.module || '—'}</span>
        <span className="dot">·</span>
        <span className="mono">{card.engineId}</span>
        <time>{fmtTime(card.updatedAt)}</time>
      </footer>
    </article>
  )
}

/** 快拍板浮层：拉全量详情，复用 GateCard（证据同屏/乐观锁/会诊全套同源，不另造一套） */function QuickDecide({ taskId, onClose, onDecided }: { taskId: string; onClose: () => void; onDecided: () => Promise<void> }): React.JSX.Element {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.getTask>> | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getTask(taskId)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message)
      })
    return () => {
      alive = false
    }
  }, [taskId])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="quick-decide" onClick={(e) => e.stopPropagation()}>
        <header className="quick-decide-head">
          <h3>快拍板</h3>
          <span className="hint">从看板直达决策卡：证据同屏（反盲签）·乐观锁·会诊与任务工作区一致</span>
          <button className="btn sm" onClick={onClose}>
            关闭（Esc）
          </button>
        </header>
        {err && <div className="notice err">加载失败：{err}</div>}
        {!err && !detail && <div className="empty-big">加载决策卡…</div>}
        {!err && detail && !detail.state.gate && <div className="notice warn">门已被决策或收口（可能他人先到）。</div>}
        {!err && detail && detail.state.gate && (
          <GateCard
            taskId={taskId}
            state={detail.state}
            gate={detail.state.gate}
            onChanged={async (st) => {
              setDetail({ ...detail, state: st })
              await onDecided()
              if (!st.gate || st.gate.status !== 'raised') onClose()
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 悬停预览（multica peek 模式）：驻留 800ms 开、面板可停留（hover 桥接）、
 * 只读速览（当前门/健康事实/最近事件），操作仍走 拍板/进入 两条正路
 */
function BoardPeek({
  taskId,
  onStay,
  onLeave,
  onOpen,
  onQuickDecide,
}: {
  taskId: string
  onStay: () => void
  onLeave: () => void
  onOpen: (taskId: string) => void
  onQuickDecide: () => void
}): React.JSX.Element {
  const { cards } = useApp()
  const [events, setEvents] = useState<SemanticEvent[]>([])

  useEffect(() => {
    let alive = true
    api
      .events(taskId, {})
      .then((p) => {
        if (alive) setEvents(p.events.slice(-6).reverse())
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [taskId])

  const card = cards.find((c) => c.taskId === taskId)
  if (!card) return <></>
  const gateWaiting = card.status === 'gate-wait' && !!card.gateKind

  return (
    <aside className="board-peek" onMouseEnter={onStay} onMouseLeave={onLeave}>
      <header className="board-peek-head">
        <span className="task-seq">#{card.seq}</span>
        <h4>{card.title}</h4>
        <span className={`health ${HEALTH_META[card.health.level].cls}`}>●</span>
      </header>
      <div className="board-peek-meta">
        <span className={`badge sm ${STATUS_META[card.status].cls}`}>{STATUS_META[card.status].label}</span>
        <span className="badge sm bg-stage">{STAGES[card.stage]?.shortLabel ?? card.stage}</span>
        <span className="mono">{card.engineId}</span>
      </div>
      {gateWaiting && (
        <button className="board-peek-gate" onClick={onQuickDecide}>
          🟡 拍板：{String(card.gateQuestion ?? '').slice(0, 80)}
        </button>
      )}
      {card.health.facts.length > 0 && (
        <ul className="board-peek-facts">
          {card.health.facts.slice(0, 3).map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      )}
      <div className="board-peek-events">
        {events.length === 0 && <div className="empty">（加载最近事件…）</div>}
        {events.map((ev) => {
          const r = renderEvent(ev)
          return (
            <div key={ev.seq} className="board-peek-ev">
              <span>{r.icon}</span>
              <span className="board-peek-ev-title">{r.title}</span>
              <time>{fmtTime(ev.ts)}</time>
            </div>
          )
        })}
      </div>
      <footer className="board-peek-foot">
        <span className="hint">预览只读 · 更新 {fmtTime(card.updatedAt)}</span>
        <button className="btn sm primary" onClick={() => onOpen(taskId)}>
          进入工作区 →
        </button>
      </footer>
    </aside>
  )
}
