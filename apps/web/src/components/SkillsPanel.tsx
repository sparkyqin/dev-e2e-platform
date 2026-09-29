/**
 * 技能沉淀闭环面板（场景10）：正式技能架 / 候选池（人工采纳，防 AI 自我强化）/ 审计留痕
 */
import { useCallback, useEffect, useState } from 'react'
import type { Skill, SkillAuditEntry, SkillStatus } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { fmtTime } from '../format'

type Tab = 'library' | 'candidates' | 'audit'

const STATUS_LABEL: Record<SkillStatus, string> = {
  candidate: '候选',
  active: '生效中',
  rejected: '已驳回',
  deprecated: '已废弃',
}

interface SkillsData {
  library: Skill[]
  candidates: Skill[]
  audit: SkillAuditEntry[]
}

function SkillItem({
  skill,
  mode,
  reload,
}: {
  skill: Skill
  mode: 'library' | 'candidates'
  reload: () => Promise<void>
}): React.JSX.Element {
  const { me, pushToast } = useApp()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const act = async (action: 'adopt' | 'reject' | 'deprecate'): Promise<void> => {
    setBusy(true)
    try {
      await api.skillAction(skill.id, { action, reason: reason || undefined, asUserId: me.userId })
      pushToast(`技能「${skill.name}」已${action === 'adopt' ? '采纳' : action === 'reject' ? '驳回' : '废弃'}（留痕 v${skill.version}）`, 'ok')
      await reload()
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="skill-item">
      <div className="skill-head">
        <strong>{skill.name}</strong>
        <span className={`tag st-${skill.status}`}>{STATUS_LABEL[skill.status]}</span>
        <span className="mono">v{skill.version}</span>
      </div>
      <div className="skill-pattern">适用：{skill.pattern}</div>
      <p className="skill-guidance">{skill.guidance}</p>
      <div className="skill-meta">
        {skill.sourceTaskId && <span>来源任务 {skill.sourceTaskId}</span>}
        {skill.proposedAt && <span>提出 {fmtTime(skill.proposedAt)}</span>}
      </div>
      <div className="skill-actions">
        <input placeholder="理由（驳回时建议填写）" value={reason} onChange={(e) => setReason(e.target.value)} />
        {mode === 'candidates' && (
          <>
            <button className="btn sm primary" disabled={busy} onClick={() => void act('adopt')}>
              采纳回流
            </button>
            <button className="btn sm danger" disabled={busy} onClick={() => void act('reject')}>
              驳回
            </button>
          </>
        )}
        {mode === 'library' && (
          <button className="btn sm" disabled={busy} onClick={() => void act('deprecate')}>
            废弃
          </button>
        )}
      </div>
    </div>
  )
}

export default function SkillsPanel(): React.JSX.Element {
  const [view, setView] = useState<SkillsData | null>(null)
  const [tab, setTab] = useState<Tab>('candidates')

  const reload = useCallback(async () => {
    try {
      setView(await api.skills())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), 5000)
    return () => clearInterval(t)
  }, [reload])

  return (
    <section className="panel">
      <h3>技能沉淀闭环</h3>
      <div className="tabs sm">
        <button className={tab === 'candidates' ? 'on' : ''} onClick={() => setTab('candidates')}>
          候选池 {view ? `(${view.candidates.length})` : ''}
        </button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>
          正式技能 {view ? `(${view.library.length})` : ''}
        </button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>
          审计
        </button>
      </div>
      <div className="skill-body">
        {!view && <div className="loading">加载中…</div>}
        {view &&
          tab === 'candidates' &&
          (view.candidates.length === 0 ? (
            <div className="empty">（暂无候选：任务合入后由 skillDistiller 从决策与交付物提炼）</div>
          ) : (
            view.candidates.map((s) => <SkillItem key={s.id} skill={s} mode="candidates" reload={reload} />)
          ))}
        {view &&
          tab === 'library' &&
          (view.library.length === 0 ? (
            <div className="empty">（正式技能架空；采纳候选后回流团队资产）</div>
          ) : (
            view.library.map((s) => <SkillItem key={s.id} skill={s} mode="library" reload={reload} />)
          ))}
        {view && tab === 'audit' && (
          <ul className="audit-list">
            {view.audit.length === 0 && <div className="empty">（暂无审计记录）</div>}
            {[...view.audit].reverse().map((a, i) => (
              <li key={i}>
                <code>{fmtTime(a.ts)}</code> <span className={`tag act-${a.action}`}>{a.action}</span> <strong>{a.skillId}</strong> v{a.version} · {a.actorName}
                {a.note ? ` · ${a.note}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <small className="hint">候选不自动生效（防 AI 自我强化错误做法）；采纳/驳回/废弃全部留痕（append-only 审计）。</small>
    </section>
  )
}
