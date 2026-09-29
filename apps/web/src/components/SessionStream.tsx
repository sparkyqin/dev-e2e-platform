/**
 * 会话流（过程可回溯）· 4 类语义事件统一渲染，两种组织模式：
 * - 回合分块（multica CommentRun 锚定模式）：引擎会话（session_started→session_ended）
 *   收拢为可折叠「运行块」，块头锚定触发它的指令（user_message）与作业目的；
 *   平台事件（阶段推进/门/回退/健康）穿插在块外，过程脉络一目了然
 * - 事件署名（multica attribution 模式）：人/AI/系统 彩色徽章，谁干的一眼可辨
 * - tool_call / tool_result 按 callId 配对合并展示；过滤：toolsOnly + kinds 多选
 * - 自动跟随滚动（可暂停）
 * - 底部：追加指令（会话内追问 / 修复指令；对挂起或失败任务人工放行下一轮自动执行）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SemanticEvent, SemanticEventKind, TaskState } from '@ai-platform/shared'
import { SEMANTIC_EVENT_KINDS } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { KIND_LABEL, fmtTime, renderEvent } from '../format'

interface Props {
  taskId: string
  state: TaskState
  events: SemanticEvent[]
  connected: boolean
}

interface Paired {
  ev: SemanticEvent
  result?: { ok: boolean; summary: string }
}

type Block =
  | { kind: 'run'; key: number; items: Paired[] } // 引擎回合（含锚定指令）
  | { kind: 'loose'; items: Paired[] } // 平台事件（块外平铺）

const RUN_REASONS: Record<string, { label: string; cls: string }> = {
  completed: { label: '完成', cls: 'run-ok' },
  failed: { label: '失败', cls: 'run-fail' },
  interrupted: { label: '被中断', cls: 'run-int' },
}

export default function SessionStream({ taskId, state, events, connected }: Props): React.JSX.Element {
  const { me, pushToast, refreshNotifications } = useApp()
  const [toolsOnly, setToolsOnly] = useState(false)
  const [kinds, setKinds] = useState<Set<SemanticEventKind>>(new Set())
  const [autoScroll, setAutoScroll] = useState(true)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [showFilter, setShowFilter] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)

  // tool_result 按 callId 挂到对应 tool_call
  const paired = useMemo(() => {
    const resultMap = new Map<string, { ok: boolean; summary: string }>()
    for (const ev of events) {
      if (ev.kind === 'tool_result') {
        const p = ev.payload as { callId: string; ok: boolean; summary: string }
        resultMap.set(p.callId, { ok: p.ok, summary: p.summary })
      }
    }
    return events.map((ev) => {
      if (ev.kind !== 'tool_call') return { ev, result: undefined }
      const p = ev.payload as { callId: string }
      return { ev, result: resultMap.get(p.callId) }
    })
  }, [events])

  // 回合分块：session_started→session_ended 收拢；回合前的 user_message（指令）并入块头作锚
  const blocks = useMemo(() => {
    const out: Block[] = []
    let cur: Extract<Block, { kind: 'run' }> | null = null
    for (const it of paired) {
      if (it.ev.kind === 'session_started') {
        cur = { kind: 'run', key: it.ev.seq, items: [it] }
        // 锚定指令：前一零散块尾部的连续 user_message 移入本回合（multica：运行块锚定触发输入）
        const prev = out[out.length - 1]
        if (prev && prev.kind === 'loose') {
          const anchors: Paired[] = []
          while (prev.items.length > 0 && prev.items[prev.items.length - 1].ev.kind === 'user_message') {
            anchors.unshift(prev.items.pop() as Paired)
          }
          if (prev.items.length === 0) out.pop()
          cur.items = [...anchors, ...cur.items]
        }
        out.push(cur)
      } else if (cur) {
        cur.items.push(it)
        if (it.ev.kind === 'session_ended') cur = null
      } else {
        const last = out[out.length - 1]
        if (last && last.kind === 'loose') last.items.push(it)
        else out.push({ kind: 'loose', items: [it] })
      }
    }
    return out
  }, [paired])

  const filtering = toolsOnly || kinds.size > 0
  const matches = (it: Paired): boolean => {
    if (toolsOnly) return it.ev.kind === 'tool_call' || it.ev.kind === 'tool_result'
    if (kinds.size > 0) return kinds.has(it.ev.kind)
    return true
  }

  // 最后一个事件所在回合默认展开（其余收起，重过程脉络不淹没）；手动切换优先
  const lastRunKey = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.kind === 'run') return b.key
    }
    return -1
  }, [blocks])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [events.length, autoScroll])

  const toggleKind = (k: SemanticEventKind): void => {
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const toggleRun = (key: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const send = async (): Promise<void> => {
    if (!instruction.trim()) return
    setBusy(true)
    try {
      await api.instruction(taskId, { text: instruction, asUserId: me.userId })
      pushToast('指令已追加（user_message 留痕；挂起/失败任务将自动回队列）', 'ok')
      setInstruction('')
      void refreshNotifications()
    } catch (e) {
      pushToast(`发送失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const held = state.status === 'user-held' || state.status === 'failed'
  const runCount = blocks.filter((b) => b.kind === 'run').length

  return (
    <div className="session">
      <div className="session-toolbar">
        <span className={`sse-dot ${connected ? 'on' : 'off'}`} title={connected ? 'SSE 已连接：事件实时推送' : 'SSE 未连接（重连中）'} />
        <strong>会话流</strong>
        <span className="hint">
          语义事件 {events.length} 条 · {runCount} 个引擎回合 · append-only 可回溯
        </span>
        <span className="spacer" />
        <label className="check sm">
          <input type="checkbox" checked={toolsOnly} onChange={(e) => setToolsOnly(e.target.checked)} />
          只看工具调用
        </label>
        <button className="btn sm ghost" onClick={() => setShowFilter((s) => !s)}>
          事件类型 {kinds.size > 0 ? `(${kinds.size})` : ''}
        </button>
        <label className="check sm">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          跟随
        </label>
      </div>
      {showFilter && (
        <div className="session-filters">
          {SEMANTIC_EVENT_KINDS.map((k) => (
            <button key={k} className={`chip ${kinds.has(k) ? 'on' : ''}`} onClick={() => toggleKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
          {kinds.size > 0 && (
            <button className="link" onClick={() => setKinds(new Set())}>
              清除
            </button>
          )}
        </div>
      )}
      <div className="session-list" ref={listRef}>
        {events.length === 0 && <div className="empty">（尚无事件）</div>}
        {blocks.map((b, bi) => {
          if (b.kind === 'loose') {
            const items = filtering ? b.items.filter(matches) : b.items
            if (items.length === 0) return null
            return (
              <div key={`loose-${bi}`} className="loose-group">
                {items.map((it) => (
                  <EventRow key={it.ev.seq} it={it} />
                ))}
              </div>
            )
          }
          return <RunBlock key={`run-${b.key}`} block={b} expanded={collapsed.has(b.key) ? false : b.key === lastRunKey} onToggle={() => toggleRun(b.key)} filter={filtering ? matches : undefined} />
        })}
      </div>
      <div className="session-input">
        <textarea
          rows={2}
          placeholder={
            held
              ? `任务处于「${state.status === 'user-held' ? '人接管中' : '已停止'}」：追加指令 = 人工放行下一轮自动执行（如修复指令：把 X 改成 Y）`
              : '追加指令（会话内追问 / 修复指令；worker 消费后作为下一轮引擎输入）'
          }
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
          }}
        />
        <button className="btn primary" disabled={busy || !instruction.trim()} onClick={() => void send()}>
          发送指令
          <small> Ctrl+↵</small>
        </button>
      </div>
    </div>
  )
}

/** 事件行：署名徽章（人/AI/系统）+ 标题 + 时间；tool_call 内联结果 */
function EventRow({ it }: { it: Paired }): React.JSX.Element {
  const ev = it.ev
  const r = renderEvent(ev)
  const res = it.result ?? (ev.kind === 'tool_result' ? (ev.payload as { ok: boolean; summary: string }) : undefined)
  const act = ev.actor.type
  return (
    <div className={`event ${r.cls}`}>
      <div className="event-line">
        <span className="event-icon">{r.icon}</span>
        <span className={`actor-chip act-${act}`} title={`署名：${r.actor}`}>
          {act === 'human' ? '👤 人' : act === 'ai' ? '🤖 AI' : '⚙ 系'}
        </span>
        <span className="event-title">{r.title}</span>
        <span className="event-seq">#{ev.seq}</span>
        <span className="event-time">{fmtTime(ev.ts)}</span>
      </div>
      {r.body && <div className="event-body">{r.body}</div>}
      {ev.kind === 'tool_call' && res && (
        <div className={`event-result ${res.ok ? 'ok' : 'fail'}`}>
          {res.ok ? '✓' : '✗'} {res.summary}
        </div>
      )}
      {ev.kind === 'tool_result' && !it.result && res && <div className="event-body">{res.summary}</div>}
    </div>
  )
}

/** 运行块（multica CommentRun 模式）：引擎回合收拢，块头=锚定指令+目的+统计+结论 */
function RunBlock({
  block,
  expanded,
  onToggle,
  filter,
}: {
  block: Extract<Block, { kind: 'run' }>
  expanded: boolean
  onToggle: () => void
  filter?: (it: Paired) => boolean
}): React.JSX.Element {
  const items = block.items
  const startEv = items.find((it) => it.ev.kind === 'session_started')
  const endEv = items.find((it) => it.ev.kind === 'session_ended')
  const startP = (startEv?.ev.payload ?? {}) as { engine?: string; purpose?: string }
  const endP = (endEv?.ev.payload ?? {}) as { reason?: string }
  const reason = RUN_REASONS[endP.reason ?? ''] ?? { label: endP.reason ?? '未收口', cls: 'run-int' }
  // 锚定指令 = 块头部连续 user_message（触发本回合的输入）；体 = 回合自身活动（不重复渲染锚）
  let anchorCount = 0
  while (anchorCount < items.length && items[anchorCount].ev.kind === 'user_message') anchorCount++
  const anchors = items.slice(0, anchorCount)
  const bodyItems = items.slice(anchorCount)
  const toolCalls = bodyItems.filter((it) => it.ev.kind === 'tool_call').length
  const artifacts = bodyItems.filter((it) => it.ev.kind === 'artifact_written').length
  const first = items[0]
  const last = items[items.length - 1]
  const shown = filter ? bodyItems.filter(filter) : bodyItems
  const lastAssistant = [...bodyItems].reverse().find((it) => it.ev.kind === 'assistant_message')
  const lastAssistantText = lastAssistant ? String((lastAssistant.ev.payload as { text?: string }).text ?? '') : ''

  return (
    <section className={`run-block ${reason.cls}`}>
      <header className="run-head" onClick={onToggle}>
        <span className="run-caret">{expanded ? '▾' : '▸'}</span>
        <span className={`run-badge ${reason.cls}`}>{reason.label}</span>
        <span className="run-purpose">{startP.purpose ?? '引擎回合'}</span>
        <span className="run-stats" title={`${toolCalls} 次工具调用 · ${artifacts} 个产物落盘`}>
          🔧{toolCalls} 📄{artifacts}
        </span>
        <span className="run-engine mono">{startP.engine ?? ''}</span>
        <span className="run-time">
          {fmtTime(first.ev.ts)} → {fmtTime(last.ev.ts)}
        </span>
      </header>
      {anchors.length > 0 && (
        <div className="run-anchors">
          {anchors.map((a) => (
            <EventRow key={a.ev.seq} it={a} />
          ))}
        </div>
      )}
      {expanded ? (
        shown.length > 0 ? (
          <div className="run-body">
            {shown.map((it) => (
              <EventRow key={it.ev.seq} it={it} />
            ))}
          </div>
        ) : (
          <div className="empty">（本回合无匹配事件）</div>
        )
      ) : (
        lastAssistantText && (
          <div className="run-preview" onClick={onToggle} title="点击展开完整回合">
            🤖 {lastAssistantText.slice(0, 160)}
            {lastAssistantText.length > 160 ? '…' : ''}
          </div>
        )
      )}
    </section>
  )
}
