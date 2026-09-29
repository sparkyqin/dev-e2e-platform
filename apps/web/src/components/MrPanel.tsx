/**
 * MR 监听面板（场景7）：监听态非终态；5 类反馈聚合 → 分诊 → 修复/消化 → SHA 校验证据 → fail-closed 合入
 * 含演示注入区（模拟远端 CodeHub 事件：流水线/评论/检视意见/approve/合入后问题）
 */
import { useState } from 'react'
import type { FeedbackItem, FeedbackStatus, MrEventRequest, TaskDetail, TriageCategory } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { fmtTime } from '../format'

const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: '新到',
  'queued-fix': '排队修复',
  'gate-raised': '已举门',
  logged: '已记录',
  fixing: '修复中',
  fixed: '已修复',
  waived: '不采纳（留痕）',
}

const TRIAGE_LABEL: Record<TriageCategory, string> = {
  'auto-fixable': '自动可修',
  'needs-human': '需人决策',
  'info-only': '仅提示',
}

const MR_STATE_LABEL: Record<string, string> = {
  open: '开放',
  watching: '监听中',
  mergeable: '可合入',
  merged: '已合入',
  closed: '已关闭',
}

export default function MrPanel({ taskId, detail, refreshDetail }: { taskId: string; detail: TaskDetail; refreshDetail: () => Promise<void> }): React.JSX.Element {
  const { pushToast } = useApp()
  const [comment, setComment] = useState('')
  const [triage, setTriage] = useState<MrEventRequest['triage']>('auto')
  const [author, setAuthor] = useState('外部评审人')
  const [busy, setBusy] = useState(false)
  const delivery = detail.delivery
  if (!delivery || !delivery.mr) return <></>
  const { mr, mrState, feedback, pipelines, evidence, mergeReadiness } = delivery

  const inject = async (r: MrEventRequest, label: string): Promise<void> => {
    setBusy(true)
    try {
      await api.mrEvent(taskId, r)
      await refreshDetail()
      pushToast(`已注入：${label}`, 'ok')
      setComment('')
    } catch (e) {
      pushToast(`注入失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const pending = feedback.filter((f: FeedbackItem) => !['fixed', 'logged', 'waived'].includes(f.status))

  return (
    <section className="panel mr-panel">
      <h3>
        MR 监听（{MR_STATE_LABEL[mrState] ?? mrState}）
        <span className={`tag mr-${mrState}`}>{mrState}</span>
      </h3>
      <div className="mr-ref">
        <code>{mr.mrId}</code>
        <span>分支 {mr.branch}</span>
        <span title="当前 SHA：证据以 SHA 校验，一变旧证据失效">SHA <code>{mr.sha.slice(0, 8)}</code></span>
        <a className="link" href={mr.url} target="_blank" rel="noreferrer">
          打开 MR ↗
        </a>
      </div>

      <div className={`readiness ${mergeReadiness.ready ? 'ready' : 'not-ready'}`}>
        <div className="ready-title">
          {mergeReadiness.ready ? '🟢 可合入（三条件齐备）' : '⛔ 未就绪（fail-closed，缺一不可）'}
        </div>
        <ul>
          <li className={mergeReadiness.pipelineGreenOnCurrentSha ? 'ok' : 'bad'}>
            {mergeReadiness.pipelineGreenOnCurrentSha ? '✓' : '✗'} 远端流水线在当前 SHA 真绿（非本地宣称）
          </li>
          <li className={mergeReadiness.allFeedbackDigested ? 'ok' : 'bad'}>
            {mergeReadiness.allFeedbackDigested ? '✓' : '✗'} 5 类反馈全消化{pending.length > 0 ? `（剩余 ${pending.length} 条）` : ''}
          </li>
          <li className={mergeReadiness.humanApproved ? 'ok' : 'wait'}>{mergeReadiness.humanApproved ? '✓' : '…'} 合入方人工拍板（交付门，永远人工）</li>
        </ul>
        {mergeReadiness.blockers.length > 0 && <div className="blockers">阻塞：{mergeReadiness.blockers.join('；')}</div>}
      </div>

      <div className="mr-cols">
        <div className="mr-col">
          <h4>远端流水线（{pipelines.length}）</h4>
          <ul className="pipe-list">
            {pipelines.length === 0 && <li className="empty">（暂无流水线记录）</li>}
            {[...pipelines].reverse().map((p) => (
              <li key={p.runId} className={`pipe pipe-${p.state}`}>
                <span className={`pipe-state s-${p.state}`}>{p.state === 'success' ? '✓ 绿' : p.state === 'failed' ? '✗ 红' : '… 跑着'}</span>
                <code>{p.sha.slice(0, 8)}</code>
                <span className="pipe-summary">{p.summary}</span>
                {p.finishedAt && <time>{fmtTime(p.finishedAt)}</time>}
              </li>
            ))}
          </ul>
        </div>
        <div className="mr-col">
          <h4>证据链（{evidence.length}）</h4>
          <ul className="evid-list">
            {evidence.length === 0 && <li className="empty">（暂无）</li>}
            {[...evidence].reverse().map((e, i) => (
              <li key={i} className={e.stale ? 'stale' : e.ok ? 'ok' : 'bad'}>
                <span>{e.ok ? '✓' : '✗'}</span>
                <span className="evid-kind">{e.kind}</span>
                <code>{e.sha.slice(0, 8)}</code>
                {e.stale && <span className="tag stale">SHA 已变·证据失效</span>}
                <time>{fmtTime(e.ts)}</time>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h4>反馈聚合（{feedback.length}）</h4>
      <ul className="feedback-list">
        {feedback.length === 0 && <li className="empty">（暂无反馈：可从下方演示注入区模拟远端评论/流水线）</li>}
        {feedback.map((f: FeedbackItem) => (
          <li key={f.feedbackId} className={`fb tri-${f.triage} st-${f.status}`}>
            <div className="fb-line">
              <span className={`tag triage-${f.triage}`}>{TRIAGE_LABEL[f.triage]}</span>
              <span className={`tag fbs-${f.status}`}>{FEEDBACK_STATUS_LABEL[f.status]}</span>
              <span className="fb-src">{f.source}</span>
              {f.author && <span>{f.author}</span>}
              <code title="反馈关联 SHA">{f.sha.slice(0, 8)}</code>
              <time>{fmtTime(f.ts)}</time>
              {f.evidenceStale && <span className="tag stale">证据失效</span>}
            </div>
            <p>{f.text}</p>
          </li>
        ))}
      </ul>

      <details className="demo-inject">
        <summary>🎛 演示注入（模拟远端 CodeHub 事件）</summary>
        <div className="inject-grid">
          <div className="inject-row">
            <span className="inject-label">流水线：</span>
            {(['success', 'failed', 'pending'] as const).map((v) => (
              <button key={v} className="btn sm" disabled={busy} onClick={() => void inject({ type: 'pipeline-run', value: v }, `流水线 ${v}`)}>
                {v === 'success' ? '真绿 ✓' : v === 'failed' ? '失败 ✗' : '跑着 …'}
              </button>
            ))}
          </div>
          <div className="inject-row">
            <span className="inject-label">评论/检视：</span>
            <input className="inject-author" placeholder="作者" value={author} onChange={(e) => setAuthor(e.target.value)} />
            <input className="inject-text" placeholder="评论内容（如：这里需要改成异步，必须改）" value={comment} onChange={(e) => setComment(e.target.value)} />
            <select value={triage} onChange={(e) => setTriage(e.target.value as MrEventRequest['triage'])} title="分诊提示（演示用）：留空则按关键词自动分诊">
              <option value="auto">分诊:自动可修</option>
              <option value="human">分诊:需人决策</option>
              <option value="info">分诊:仅提示</option>
            </select>
          </div>
          <div className="inject-row">
            <button className="btn sm" disabled={busy || !comment.trim()} onClick={() => void inject({ type: 'comment', value: comment, author, triage }, 'MR 评论')}>
              发 MR 评论
            </button>
            <button className="btn sm" disabled={busy || !comment.trim()} onClick={() => void inject({ type: 'review-comment', value: comment, author, triage }, '检视意见')}>
              发检视意见
            </button>
          </div>
          <div className="inject-row">
            <span className="inject-label">关键事件：</span>
            <button className="btn sm" disabled={busy} onClick={() => void inject({ type: 'approve', author }, 'Approve（标记可合入）')}>
              Approve ✓
            </button>
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={() => void inject({ type: 'post-merge-issue', value: comment || '合入后线上问题：接口 500，需要人决策处理' }, '合入后问题（需人决策）')}
            >
              合入后问题 ⚠
            </button>
          </div>
          <small className="hint">
            分诊=自动可修的评论不惊动人（平台自动回编码修复再重验）；需人决策的会举事实门；仅提示只记录留痕。SHA 变更后旧证据自动失效。
          </small>
        </div>
      </details>
    </section>
  )
}
