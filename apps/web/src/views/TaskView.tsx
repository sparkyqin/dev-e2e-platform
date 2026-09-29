/**
 * 任务工作台（两栏制 · Linear/GitHub PR/mae-flow 模式）：
 * - hero：标题行（身份+状态徽标）+ 现状行（一句话「现在怎么样、在等谁」）+ 紧凑阶段条（进度指示器）
 * - 主栏页签：动态（默认，人话时间线）· 材料（产物与批注）· 看板（9 阶段全景 + 历程）
 * - 右栏（行动优先）：等门时 GateCard 置顶为唯一亮色焦点；无事时一行静默提示；随后 MR 面板 + 任务信息
 * - SSE：GET /api/tasks/:id/events/stream（events 追加 / state 刷新 / notification 通知）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SemanticEvent, StageId, TaskDetail, TaskState } from '@ai-platform/shared'
import { GATE_META } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { HEALTH_META, STATUS_META, fmtRel, stageLabel } from '../format'
import PipelineBoard, { PipelineStrip } from '../components/PipelineBoard'
import GateCard from '../components/GateCard'
import SessionStream from '../components/SessionStream'
import ArtifactsPanel from '../components/ArtifactsPanel'
import MrPanel from '../components/MrPanel'
import TaskRail from '../components/TaskRail'
import JourneyPanel from '../components/JourneyPanel'

type MidTab = 'session' | 'materials' | 'board'

/** 现状行：一句话回答「现在怎么样、在等谁」（mae-flow 下一步/责任 模式；把徽标/阶段/门等散落状态合成一句） */
export function NowLine({ state }: { state: TaskState }): React.JSX.Element {
  const { me } = useApp()
  const round = state.stageRounds[state.stage] ?? 1
  let icon = '•'
  let main: React.JSX.Element | string = ''
  let meta = `更新于 ${fmtRel(state.updatedAt)}`
  switch (state.status) {
    case 'running':
      icon = '🤖'
      main = (
        <>
          AI 正在 <b>{stageLabel(state.stage)}</b> 推进{round > 1 && <span className="now-round">（第 {round} 轮）</span>}
        </>
      )
      break
    case 'gate-wait': {
      icon = '🟡'
      const g = state.gate
      if (g) {
        const who = g.soleDecider.userId === me.userId ? '你' : g.soleDecider.name
        main = (
          <>
            等{who}拍板 · <b>{GATE_META[g.kind].label}</b>
          </>
        )
        meta = `举起于 ${fmtRel(g.raisedAt)}`
      } else {
        main = <>等待人工决策</>
      }
      break
    }
    case 'user-held':
      icon = '✋'
      main = <>人接管中 · 自动迭代已暂停</>
      break
    case 'queued':
      icon = '⏳'
      main = <>排队中 · 到位后自动开始</>
      meta = ''
      break
    case 'watching':
      icon = '👀'
      main = <>代码已进入 MR · 正在聚合反馈</>
      break
    case 'aggregating':
      icon = '⧉'
      main = <>子任务合入聚合中</>
      break
    case 'merged':
      icon = '✔'
      main = <>已合入</>
      break
    case 'failed':
      icon = '💥'
      main = <>已停止{state.health.facts[0] ? <> · {state.health.facts[0].message}</> : ' · 可修复重试'}</>
      break
    case 'archived':
      icon = '📦'
      main = <>已归档</>
      meta = ''
      break
  }
  return (
    <div className="now-line">
      <span className="now-icon" aria-hidden>
        {icon}
      </span>
      <span className="now-main">{main}</span>
      {meta && <span className="now-meta">{meta}</span>}
    </div>
  )
}

/** 右栏静默态：无事可做时一行带过（机制解释进 title，不上界面） */
function quietOf(state: TaskState): { text: string; title: string } {
  switch (state.status) {
    case 'running':
      return { text: '🤖 AI 推进中 · 无需人工输入', title: `引擎 ${state.engineId}；门举起时自动出现在这里` }
    case 'queued':
      return { text: '⏳ 排队中 · 到位后自动开始', title: '并发槽有限，先到先得' }
    case 'user-held':
      return { text: '✋ 人接管中 · 可在下方恢复自动', title: '接管期间自动迭代暂停' }
    case 'watching':
      return { text: '👀 MR 反馈聚合中', title: '就绪后交付门将举起' }
    case 'aggregating':
      return { text: '⧉ 子任务聚合中', title: '全部子任务合入后举聚合验收门' }
    case 'merged':
      return { text: '✔ 已合入', title: '终态；合入后发现问题可回退编码（回退环）' }
    case 'failed':
      return { text: '💥 已停止 · 可接管修复', title: '接管修复，或「恢复自动」重跑' }
    default:
      return { text: '当前无待决策门', title: '' }
  }
}

export default function TaskView({ taskId }: { taskId: string }): React.JSX.Element {
  const { pushToast, refreshNotifications, refreshCards } = useApp()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [events, setEvents] = useState<SemanticEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<MidTab>('session')
  /** 看板产物卡 → 材料页的焦点请求；nonce 保证重复点击同一产物也能重新打开（同值 bail-out 规避） */
  const [focus, setFocus] = useState<{ path: string | null; nonce: number }>({ path: null, nonce: 0 })
  /** 紧凑条阶段 → 看板页的定位请求；nonce 同理 */
  const [boardFocus, setBoardFocus] = useState<{ sid: StageId | null; nonce: number }>({ sid: null, nonce: 0 })
  const lastSeqRef = useRef(0)
  const detailTimer = useRef<number | null>(null)

  /** 看板产物卡 → 材料页直达（切页签 + 打开该产物）；path=null 表示只切页签看全量列表（「+N 更多」入口） */
  const openArtifact = useCallback((path: string | null): void => {
    setFocus((f) => ({ path, nonce: f.nonce + 1 }))
    setTab('materials')
  }, [])

  /** 紧凑条阶段 → 看板页直达（切页签 + 滚动定位到该列） */
  const openBoard = useCallback((sid: StageId): void => {
    setBoardFocus((f) => ({ sid, nonce: f.nonce + 1 }))
    setTab('board')
  }, [])

  const mergeEvents = useCallback((incoming: SemanticEvent[]): void => {
    if (incoming.length === 0) return
    setEvents((prev) => {
      const map = new Map(prev.map((e) => [e.seq, e]))
      for (const e of incoming) map.set(e.seq, e)
      const merged = [...map.values()].sort((a, b) => a.seq - b.seq)
      lastSeqRef.current = Math.max(lastSeqRef.current, merged.length > 0 ? merged[merged.length - 1].seq : 0)
      return merged
    })
  }, [])

  const fetchDetail = useCallback(
    async (quiet = true): Promise<void> => {
      try {
        const d = await api.getTask(taskId)
        setDetail(d)
        setError(null)
      } catch (e) {
        if (!quiet) setError((e as Error).message)
      }
    },
    [taskId],
  )

  // 初载：detail + 全量事件 → 开 SSE
  useEffect(() => {
    let alive = true
    let es: EventSource | null = null
    setDetail(null)
    setEvents([])
    lastSeqRef.current = 0

    void (async () => {
      try {
        const d = await api.getTask(taskId)
        if (!alive) return
        setDetail(d)
      } catch (e) {
        if (alive) setError((e as Error).message)
        return
      }
      try {
        const page = await api.events(taskId, { afterSeq: 0 })
        if (!alive) return
        mergeEvents(page.events)
      } catch {
        /* ignore */
      }

      es = new EventSource(`/api/tasks/${taskId}/events/stream?afterSeq=${lastSeqRef.current}`)
      es.addEventListener('open', () => alive && setConnected(true))
      es.addEventListener('ping', () => alive && setConnected(true))
      es.addEventListener('error', () => alive && setConnected(false))
      es.addEventListener('events', (ev) => {
        try {
          mergeEvents(JSON.parse((ev as MessageEvent<string>).data) as SemanticEvent[])
        } catch {
          /* ignore */
        }
      })
      es.addEventListener('state', () => {
        // 节流刷新详情（一次推进可能连发多个 state）
        if (detailTimer.current !== null) return
        detailTimer.current = window.setTimeout(() => {
          detailTimer.current = null
          void fetchDetail()
          void refreshCards()
        }, 250)
      })
      es.addEventListener('notification', (ev) => {
        try {
          const n = JSON.parse((ev as MessageEvent<string>).data) as { title: string; body?: string }
          pushToast(`🔔 ${n.title}${n.body ? `：${n.body.slice(0, 80)}` : ''}`, 'warn')
        } catch {
          /* ignore */
        }
        void refreshNotifications()
      })
    })()

    return () => {
      alive = false
      es?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 兜底轮询（SSE 断连时也能推进）；SSE 活着时低频
  useEffect(() => {
    const t = setInterval(() => void fetchDetail(), connected ? 6000 : 2000)
    return () => clearInterval(t)
  }, [fetchDetail, connected])

  useEffect(
    () => () => {
      if (detailTimer.current !== null) {
        clearTimeout(detailTimer.current)
        detailTimer.current = null
      }
    },
    [],
  )

  const onStateChanged = useCallback(
    (st: TaskState) => {
      setDetail((d) => (d ? { ...d, state: st, gate: st.gate } : d))
      void fetchDetail()
      void refreshCards()
    },
    [fetchDetail, refreshCards],
  )

  if (error) {
    return (
      <div className="task-error">
        <h2>无法打开任务</h2>
        <p>{error}</p>
        <a className="btn" href="#/">
          ← 返回任务列表
        </a>
      </div>
    )
  }
  if (!detail) {
    return <div className="loading-big">加载任务中…</div>
  }

  const state = detail.state
  const st = STATUS_META[state.status]
  const hm = HEALTH_META[state.health.level]
  const quiet = quietOf(state)

  return (
    <div className="taskview">
      <header className="task-head">
        <div className="task-head-row">
          <a className="back" href="#/" title="返回任务列表">
            ←
          </a>
          <span className="task-seq">#{state.seq}</span>
          <h2>{state.title}</h2>
          <span className={`badge ${st.cls}`}>{st.label}</span>
          {state.autonomy === 'human' && <span className="badge bg-held">人在控</span>}
          <span className={`health ${hm.cls}`} title={state.health.facts.map((f) => f.message).join('\n') || hm.label}>
            ●
          </span>
          {state.status === 'running' && (
            <span className="chip muted mono" title={`当前引擎 ${state.engineId}`}>
              🤖 {state.engineId}
            </span>
          )}
        </div>
        <NowLine state={state} />
        <PipelineStrip state={state} events={events} onOpenBoard={openBoard} />
      </header>

      <div className="task-cols">
        <section className="col col-mid">
          <div className="tabs mid">
            <button className={tab === 'session' ? 'on' : ''} onClick={() => setTab('session')} title="过程事件时间线（可回溯）">
              动态
            </button>
            <button className={tab === 'materials' ? 'on' : ''} onClick={() => setTab('materials')} title="产物分区与批注">
              材料（{state.artifacts.length}）
            </button>
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')} title="9 阶段全景 · 产物卡 · 门足迹 · 历程">
              看板
            </button>
          </div>
          {tab === 'session' && <SessionStream taskId={taskId} state={state} events={events} connected={connected} />}
          {tab === 'materials' && (
            <div className="materials-wrap">
              <ArtifactsPanel taskId={taskId} detail={detail} refreshDetail={() => fetchDetail()} focus={focus} />
            </div>
          )}
          {tab === 'board' && (
            <div className="board-tab">
              <PipelineBoard state={state} events={events} onOpenArtifact={openArtifact} focus={boardFocus} />
              <JourneyPanel journey={detail.journey} />
            </div>
          )}
        </section>

        <aside className="col col-rail">
          {state.gate ? (
            <div className="rail-action">
              <GateCard taskId={taskId} state={state} gate={state.gate} onChanged={onStateChanged} />
            </div>
          ) : (
            <div className="rail-quiet" title={quiet.title}>
              {quiet.text}
            </div>
          )}
          {detail.delivery && <MrPanel taskId={taskId} detail={detail} refreshDetail={() => fetchDetail()} />}
          <TaskRail state={state} detail={detail} onChanged={onStateChanged} />
        </aside>
      </div>
    </div>
  )
}
