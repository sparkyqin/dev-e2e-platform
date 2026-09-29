/**
 * 任务工作台（第二/三层）：
 * - 顶栏：任务标题/徽标 + 任务看板（multica 式：列=阶段 · 卡=产物 · 门决策足迹）
 * - 三栏：材料（信息/干系人/产物/批注）· 中间（会话流+指令）· 右侧（决策卡 + MR 监听）
 * - SSE：GET /api/tasks/:id/events/stream（events 追加 / state 刷新 / notification 通知）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SemanticEvent, TaskDetail, TaskState } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { HEALTH_META, STATUS_META, fmtTime } from '../format'
import PipelineBoard from '../components/PipelineBoard'
import GateCard from '../components/GateCard'
import SessionStream from '../components/SessionStream'
import ArtifactsPanel from '../components/ArtifactsPanel'
import MrPanel from '../components/MrPanel'
import TaskSidebar from '../components/TaskSidebar'

type MidTab = 'session' | 'materials'

export default function TaskView({ taskId }: { taskId: string }): React.JSX.Element {
  const { pushToast, refreshNotifications, refreshCards } = useApp()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [events, setEvents] = useState<SemanticEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<MidTab>('session')
  /** 看板产物卡 → 材料页的焦点请求；nonce 保证重复点击同一产物也能重新打开（同值 bail-out 规避） */
  const [focus, setFocus] = useState<{ path: string | null; nonce: number }>({ path: null, nonce: 0 })
  const lastSeqRef = useRef(0)
  const detailTimer = useRef<number | null>(null)

  /** 看板产物卡 → 材料页直达（切页签 + 打开该产物）；path=null 表示只切页签看全量列表（「+N 更多」入口） */
  const openArtifact = useCallback((path: string | null): void => {
    setFocus((f) => ({ path, nonce: f.nonce + 1 }))
    setTab('materials')
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
          ← 返回会话厅
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

  return (
    <div className="taskview">
      <header className="task-head">
        <div className="task-head-row">
          <a className="back" href="#/" title="返回会话厅">
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
          <span className="spacer" />
          <span className="task-updated">更新于 {fmtTime(state.updatedAt)}</span>
        </div>
        <PipelineBoard state={state} events={events} onOpenArtifact={openArtifact} />
      </header>

      <div className="task-cols">
        <aside className="col col-left">
          <TaskSidebar state={state} detail={detail} onChanged={onStateChanged} />
        </aside>

        <section className="col col-mid">
          <div className="tabs mid">
            <button className={tab === 'session' ? 'on' : ''} onClick={() => setTab('session')}>
              会话流（过程可回溯）
            </button>
            <button className={tab === 'materials' ? 'on' : ''} onClick={() => setTab('materials')}>
              材料与批注（{state.artifacts.length}）
            </button>
          </div>
          {tab === 'session' ? (
            <SessionStream taskId={taskId} state={state} events={events} connected={connected} />
          ) : (
            <div className="materials-wrap">
              <ArtifactsPanel taskId={taskId} detail={detail} refreshDetail={() => fetchDetail()} focus={focus} />
            </div>
          )}
        </section>

        <aside className="col col-right">
          {state.gate ? (
            <GateCard taskId={taskId} state={state} gate={state.gate} onChanged={onStateChanged} />
          ) : (
            <div className="no-gate">
              {state.status === 'running'
                ? '🤖 AI 正在自动推进（无需人工输入）；门举起时会出现在这里。'
                : state.status === 'queued'
                  ? '⏳ 排队等待并发槽（先到先得）。'
                  : state.status === 'watching'
                    ? '👀 MR 监听态：反馈聚合与分诊进行中；就绪后交付门将举起。'
                    : state.status === 'merged'
                      ? '✔ 已合入（终态）。合入后发现问题可回退编码（回退环）。'
                      : '当前无待决策门。'}
            </div>
          )}
          {detail.delivery && <MrPanel taskId={taskId} detail={detail} refreshDetail={() => fetchDetail()} />}
          {!detail.delivery && (state.stage === 'deliver' || state.stage === 'merged') && (
            <div className="no-gate">（MR 信息尚未就绪）</div>
          )}
        </aside>
      </div>
    </div>
  )
}
