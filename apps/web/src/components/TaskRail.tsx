/**
 * 任务右栏（两栏制：行动优先）：
 * - 行动卡（GateCard/MrPanel）由 TaskView 装配在本栏顶部；历程在看板页签
 * - 任务信息：需求描述（进来第一问「这任务是啥」）+ 健康警示（green 不渲染，头部健康点已有）
 * - 任务属性（阶段轮次/方式/模板/剧本/引擎/Token）收进折叠 —— 低频只读
 * - 干系人：责任人+需求方常显，其余折叠
 * - 接管 / 恢复自动：安全钮常驻（过程可接管铁律）
 * - AR 子任务 / AR 谱系 / 待追认：按需出现
 */
import { useState } from 'react'
import type { PendingConfirmation, TaskDetail, TaskState } from '@ai-platform/shared'
import { STAGES } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { HEALTH_META, SCENARIO_LABEL, STATUS_META, fmtTime, stageLabel } from '../format'

/** 待追认表单：给出正式事实答案（假设仅是推进依据，不作数） */
function PendingConfirmForm({ taskId, pc, onResolved }: { taskId: string; pc: PendingConfirmation; onResolved: (st: TaskState) => void }): React.JSX.Element {
  const { me, pushToast } = useApp()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!answer.trim()) {
      pushToast('请填写确认后的事实答案', 'warn')
      return
    }
    setBusy(true)
    try {
      const st = await api.resolvePending(taskId, pc.id, { finalAnswer: answer.trim(), asUserId: me.userId })
      onResolved(st)
      pushToast('已追认（事实已落决策记录）', 'ok')
    } catch (e) {
      pushToast(`追认失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pc-form">
      <input
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="确认后的事实答案（将落决策记录）"
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
      />
      <button className="btn primary sm" onClick={() => void submit()} disabled={busy}>
        {busy ? '提交中…' : '追认'}
      </button>
    </div>
  )
}

export default function TaskRail({
  state,
  detail,
  onChanged,
}: {
  state: TaskState
  detail: TaskDetail
  onChanged: (st: TaskState) => void
}): React.JSX.Element {
  const { me, pushToast } = useApp()
  const hm = HEALTH_META[state.health.level]
  const tokenPct = Math.min(100, Math.round(((state.tokenUsage.input + state.tokenUsage.output) / state.tokenUsage.budget) * 100))

  const doTakeover = async (): Promise<void> => {
    try {
      const s = await api.takeover(state.taskId, { asUserId: me.userId })
      onChanged(s)
      pushToast(`已以「${me.name}」接管（在跑会话被中断；保持人在控直到显式恢复）`, 'warn')
    } catch (e) {
      pushToast(`接管失败：${(e as Error).message}`, 'err')
    }
  }

  const doResume = async (): Promise<void> => {
    try {
      const s = await api.resumeAuto(state.taskId, { stateVersion: state.stateVersion, asUserId: me.userId })
      onChanged(s)
      pushToast('已恢复自动迭代（任务回队列，由调度器派发）', 'ok')
    } catch (e) {
      pushToast(`恢复失败：${(e as Error).message}`, 'err')
    }
  }

  const canTakeover = ['running', 'watching', 'gate-wait', 'failed', 'user-held'].includes(state.status)
  const canResume = state.status === 'user-held' || state.status === 'failed'

  const roleOf = (key: 'requester' | 'owner' | 'designer' | 'architect' | 'tse' | 'reviewer' | 'merger' | 'admin'): string => {
    const labels = {
      requester: '需求方',
      owner: '责任人',
      designer: '设计师',
      architect: '架构师',
      tse: 'TSE',
      reviewer: '评审人',
      merger: '合入方',
      admin: '管理员',
    }
    return labels[key]
  }

  return (
    <div className="sidebar">
      <section className="panel info">
        <h3>任务信息</h3>
        <dl className="info-list">
          <div>
            <dt>需求描述</dt>
            <dd className="req-text">{state.requirementText}</dd>
          </div>
          {state.health.level !== 'green' && (
            <div>
              <dt>健康</dt>
              <dd className={hm.cls}>
                {hm.label}
                {state.health.facts.length > 0 && (
                  <ul className="health-facts">
                    {state.health.facts.map((f, i) => (
                      <li key={i}>
                        [{f.code}] {f.message} ×{f.count}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          )}
        </dl>

        <details className="side-fold">
          <summary>任务属性（轮次 / 方式 / 引擎 / Token）</summary>
          <dl className="info-list">
            <div>
              <dt>阶段轮次</dt>
              <dd>
                {stageLabel(state.stage)} 第 {state.stageRounds[state.stage] ?? 1} 轮 · 修复 {state.repairRounds} 轮
              </dd>
            </div>
            <div>
              <dt>本段知识</dt>
              <dd className="rail-skills">
                {(STAGES[state.stage]?.skills ?? []).map((sk) => (
                  <span key={sk.id} className="rail-skill" title={sk.desc}>{sk.label}</span>
                ))}
                {(STAGES[state.stage]?.skills ?? []).length === 0 && <span className="dim">—</span>}
              </dd>
            </div>
            <div>
              <dt>开发方式</dt>
              <dd>{state.mode}</dd>
            </div>
            <div>
              <dt>流程模板</dt>
              <dd>
                {state.playbookId} · {state.paradigm === 'tri-partite' ? '三权分立' : '单中心'}
              </dd>
            </div>
            <div>
              <dt>演示剧本</dt>
              <dd>{SCENARIO_LABEL[state.scenario]}</dd>
            </div>
            <div>
              <dt>引擎</dt>
              <dd className="mono">{state.engineId}</dd>
            </div>
            <div>
              <dt>Token 预算</dt>
              <dd>
                <div className="token-bar" title={`in ${state.tokenUsage.input} / out ${state.tokenUsage.output} / budget ${state.tokenUsage.budget}`}>
                  <span style={{ width: `${tokenPct}%` }} className={tokenPct > 80 ? 'hot' : ''} />
                </div>
                <small>
                  {tokenPct}%（{((state.tokenUsage.input + state.tokenUsage.output) / 1000).toFixed(1)}k / {(state.tokenUsage.budget / 1_000_000).toFixed(1)}M）
                </small>
              </dd>
            </div>
          </dl>
        </details>

        <div className="actions">
          <button className="btn" disabled={!canTakeover} onClick={() => void doTakeover()} title="中断在跑会话，转人在控（via=interrupt，非失败）">
            ✋ 接管
          </button>
          <button className="btn primary" disabled={!canResume} onClick={() => void doResume()} title="显式恢复自动迭代（挂起/失败任务回队列）">
            🔁 恢复自动
          </button>
        </div>
      </section>

      {state.subtasks && state.subtasks.length > 0 && (
        <section className="panel">
          <h3>AR 子任务（{state.subtasks.filter((s) => s.status === 'merged' || s.status === 'archived').length}/{state.subtasks.length} 已合入）</h3>
          <small className="hint">执行段 AR 并行：每个原子需求一个子任务（拷贝本任务设计产物，从编码起跑），全部合入后举聚合验收门（TSE 拍板）</small>
          <ul className="subtask-list">
            {state.subtasks.map((s, i) => (
              <li key={s.taskId}>
                <a href={`#/task/${s.taskId}`} title={`查看子任务 ${s.taskId}`}>
                  <span className="sub-idx">AR{i + 1}</span>
                  <span className="sub-title">{s.arTitle}</span>
                  <span className="sub-owner">{s.ownerName}</span>
                  <span className={`badge ${STATUS_META[s.status]?.cls ?? ''}`}>{STATUS_META[s.status]?.label ?? s.status}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.parentTaskId && (
        <section className="panel">
          <h3>AR 谱系</h3>
          <dl className="info-list">
            <div>
              <dt>父任务</dt>
              <dd>
                <a href={`#/task/${state.parentTaskId}`}>查看父任务（{state.parentTaskId}）</a>
              </dd>
            </div>
            <div>
              <dt>本 AR</dt>
              <dd>{state.arTitle ?? '—'}</dd>
            </div>
          </dl>
          <small className="hint">父任务设计产物已拷贝至本任务交付区；实现范围=本 AR，独立验证与 MR。</small>
        </section>
      )}

      <section className="panel">
        <h3>干系人</h3>
        <ul className="people">
          {(['requester', 'owner'] as const).map((k) => {
            const p = state.people[k]
            if (!p) return null
            return (
              <li key={k}>
                <span className="role">{roleOf(k)}</span>
                <strong>{p.name}</strong>
                <small>{p.role}</small>
              </li>
            )
          })}
        </ul>
        {(() => {
          const rest = (['designer', 'architect', 'tse', 'reviewer', 'merger', 'admin'] as const).filter((k) => state.people[k])
          if (rest.length === 0) return null
          return (
            <details className="side-fold">
              <summary>另 {rest.length} 位干系人</summary>
              <ul className="people">
                {rest.map((k) => (
                  <li key={k}>
                    <span className="role">{roleOf(k)}</span>
                    <strong>{state.people[k]!.name}</strong>
                    <small>{state.people[k]!.role}</small>
                  </li>
                ))}
              </ul>
            </details>
          )
        })()}
      </section>

      {state.pendingConfirmations.length > 0 && (
        <section className="panel">
          <h3>待追认（{state.pendingConfirmations.length}）</h3>
          <small className="hint">事实门超时降级推进的项：假设不作数，需人工事后追认</small>
          <ul className="pending-confirm">
            {state.pendingConfirmations.map((pc) => (
              <li key={pc.id} className={pc.resolvedAt ? 'resolved' : ''}>
                <div className="pc-q">{pc.question}</div>
                <div className="pc-a">假设：{pc.assumedAnswer}</div>
                {pc.resolvedAt ? (
                  <div className="pc-res">已追认：{pc.finalAnswer}（{pc.resolvedBy} · {fmtTime(pc.resolvedAt)}）</div>
                ) : (
                  <PendingConfirmForm taskId={state.taskId} pc={pc} onResolved={onChanged} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
