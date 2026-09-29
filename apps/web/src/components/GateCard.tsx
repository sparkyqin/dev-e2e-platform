/**
 * 决策卡（反盲签核心）：preface/context/digest/材料选区与决策按钮同屏
 * - 铁门徽标 + 超时策略 + 升级提示
 * - 拍板人校验提示（演示环境由服务端最终校验，403 会 toast）
 * - 乐观锁：stateVersion 随卡提交；409 冲突时提示并刷新
 * - 会诊：邀请参与人（sole-decider 唯一）
 * - 事实门降级态：展示假设答案 + 待追认提示
 */
import { useState } from 'react'
import type { GateInstance, GateOption, RollbackTarget, TaskState } from '@ai-platform/shared'
import { GATE_META, ROLLBACK_TARGET_LABEL, USERS } from '@ai-platform/shared'
import { api, ApiRequestError } from '../api'
import { useApp } from '../store'
import { fmtTime } from '../format'

interface Props {
  taskId: string
  state: TaskState
  gate: GateInstance
  onChanged: (st: TaskState) => void
}

const TIMEOUT_POLICY_LABEL: Record<string, string> = {
  escalate: '超时升级（不放行）',
  degrade: '超时降级（非阻塞推进+待追认）',
  none: '无超时（永远等）',
}

export default function GateCard({ taskId, state, gate, onChanged }: Props): React.JSX.Element {
  const { me, pushToast } = useApp()
  const [answer, setAnswer] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [invitee, setInvitee] = useState('sunlin')
  const meta = GATE_META[gate.kind]
  const isDecider = me.userId === gate.soleDecider.userId
  const isAdmin = me.userId === 'admin'

  const decide = async (opt: GateOption, explicitAnswer?: string, explicitReason?: string): Promise<void> => {
    if (opt.action === 'degrade') return // 降级由平台触发，不出现在决策按钮
    setBusy(true)
    try {
      const st = await api.decideGate(taskId, {
        stateVersion: state.stateVersion,
        action: opt.action,
        answer: opt.action === 'answer' ? (explicitAnswer ?? answer) : undefined,
        rollbackTarget: opt.rollbackTarget,
        reason: explicitReason ?? (reason || undefined),
        asUserId: me.userId,
      })
      onChanged(st)
      pushToast(`已${opt.label.includes('不采纳') ? '决策（waive 留痕）' : '决策'}：${opt.label}`, 'ok')
      setAnswer('')
      setReason('')
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'version-conflict') {
        pushToast(`乐观锁冲突：状态已被他人更新（v${e.currentVersion}），已为你刷新，请基于最新材料重试`, 'warn')
      } else {
        pushToast(`决策失败：${(e as Error).message}`, 'err')
      }
    } finally {
      setBusy(false)
    }
  }

  const invite = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await api.invite(taskId, { stateVersion: state.stateVersion, userId: invitee, asUserId: me.userId })
      onChanged(st)
      pushToast(`已邀请 ${USERS.find((u) => u.userId === invitee)?.name ?? invitee} 会诊（不改变唯一拍板人）`, 'ok')
      setShowInvite(false)
    } catch (e) {
      pushToast(`邀请失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const forceTimeout = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await api.forceTimeout(taskId)
      onChanged(st)
      pushToast('已快进门计时到超时（演示）：观察升级/降级策略', 'warn')
    } catch (e) {
      pushToast(`操作失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const needsAnswer = gate.options.some((o) => o.action === 'answer')
  const hasRollback = gate.options.some((o) => o.action === 'rollback')
  const decided = gate.status === 'decided'
  const degraded = gate.status === 'degraded'

  return (
    <section className={`gate-card kind-${gate.kind} ${decided ? 'decided' : degraded ? 'degraded' : ''}`}>
      <header className="gate-head">
        <span className="gate-kind">{meta.label}</span>
        {meta.iron && <span className="tag iron" title="铁门永不代答：无人值守也不偷偷放行">🔒 铁门</span>}
        <span className="tag timeout" title={TIMEOUT_POLICY_LABEL[meta.timeoutPolicy]}>
          {TIMEOUT_POLICY_LABEL[meta.timeoutPolicy]}
        </span>
        {gate.escalated && <span className="tag escalated">⚠ 已升级通知（未放行）</span>}
        <span className="gate-meta">v{state.stateVersion} · 举于 {fmtTime(gate.raisedAt)}</span>
      </header>

      {!decided && !degraded && !isDecider && (
        <div className="notice warn">
          {isAdmin ? '你是管理员：可代拍板（留痕 on-behalf）' : `当前身份「${me.name}」不是拍板人（拍板人：${gate.soleDecider.name}）——服务端将拒绝；请切换身份体验`}
        </div>
      )}
      {degraded && (
        <div className="notice degraded">
          事实门超时已降级：按假设「{gate.degraded?.assumedAnswer}」推进非阻塞部分（{gate.degraded?.note}）。事实未被替答——待追认中。
        </div>
      )}
      {decided && gate.decision && (
        <div className="notice decided">
          已决策：{gate.decision.action}（{gate.decision.decidedByName} · {fmtTime(gate.decision.decidedAt)}）
          {gate.decision.reason ? ` · 理由：${gate.decision.reason}` : ''}
        </div>
      )}

      <div className="gate-q">
        <h4 className="gate-question">{gate.question}</h4>
        <div className="gate-digest">
          <span className="q-tag">digest</span>
          {gate.digest}
        </div>
        {(gate.preface || gate.context) && (
          <details className="side-fold gate-bg">
            <summary>背景与判据（为什么问这个）</summary>
            <div className="gate-preface">
              <span className="q-tag">preface</span>
              {gate.preface}
            </div>
            {gate.context && (
              <div className="gate-context">
                <span className="q-tag">context</span>
                {gate.context}
              </div>
            )}
          </details>
        )}
      </div>

      {gate.materials.length > 0 && (
        <details className="gate-materials" open={gate.materials.length <= 3}>
          <summary>
            材料选区（{gate.materials.length}）· 决策与证据同屏，不跳页
          </summary>
          {gate.materials.map((m, i) => (
            <div key={i} className="gate-material">
              <div className="gate-material-label">
                <span className={`tag mat-${m.kind}`}>{m.kind}</span>
                <code>{m.ref}</code> {m.label}
              </div>
              {m.content && <pre>{m.content}</pre>}
            </div>
          ))}
        </details>
      )}

      <div className="gate-people">
        <span>
          唯一拍板：<strong>{gate.soleDecider.name}</strong>（{gate.soleDecider.role}）
        </span>
        {gate.participants.filter((p) => p.role === 'consulted').length > 0 && (
          <span>
            会诊：{gate.participants.filter((p) => p.role === 'consulted').map((p) => p.name).join('、')}
          </span>
        )}
        {!decided && !degraded && (
          <button className="link" onClick={() => setShowInvite((s) => !s)}>
            + 邀请会诊
          </button>
        )}
        {!decided && !degraded && gate.timeoutMs > 0 && (
          <button className="link" onClick={() => void forceTimeout()} title="把门的计时快进到超时：演示升级/降级策略，不必等真实超时">
            ⏩ 快进超时（演示）
          </button>
        )}
      </div>
      {showInvite && (
        <div className="gate-invite">
          <select value={invitee} onChange={(e) => setInvitee(e.target.value)}>
            {USERS.filter((u) => u.userId !== gate.soleDecider.userId).map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name}（{u.role}）
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={busy} onClick={() => void invite()}>
            邀请
          </button>
        </div>
      )}

      {!decided && !degraded && (
        <div className="gate-actions">
          {needsAnswer && (
            <div className="gate-answer">
              <textarea
                rows={2}
                placeholder="作答（事实门答案；成组质询可逐题作答）"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </div>
          )}
          {hasRollback && (
            <input className="gate-reason" placeholder="理由 / 说明（驳回与回退建议附理由，将随事件留痕）" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          <div className="gate-buttons">
            {gate.options.map((opt, i) => (
              <button
                key={i}
                className={`btn ${opt.tone === 'primary' ? 'primary' : opt.tone === 'danger' ? 'danger' : ''}`}
                disabled={busy || (opt.action === 'answer' && !answer.trim())}
                title={opt.rollbackTarget ? `声明式回退到「${ROLLBACK_TARGET_LABEL[opt.rollbackTarget as RollbackTarget]}」（不从头重跑）` : opt.label}
                onClick={() => void decide(opt)}
              >
                {opt.label}
                {opt.rollbackTarget && <small> → {ROLLBACK_TARGET_LABEL[opt.rollbackTarget]}</small>}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
