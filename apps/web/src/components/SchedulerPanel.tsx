/**
 * 调度配置（并发槽）+ 引擎可用性：并发槽位 / 运行中 / 排队 / 门等待 / 监听态一览
 * 列表项一律「#序号 标题（+场景信息）」：不向用户裸露内部 task id；点击直达任务工作台
 */
import { useState } from 'react'
import { useApp } from '../store'
import { api } from '../api'
import { STAGES } from '@ai-platform/shared'
import type { TaskCard } from '@ai-platform/shared'
import { fmtDur } from '../format'

/** 调度列表项：有卡片 → 人话行；无卡片（理论上不会）→ 兜底裸 id */
function SchedTask({ id, card, extra }: { id: string; card?: TaskCard; extra?: string }): React.JSX.Element {
  if (!card) return <code key={id}>{id}</code>
  return (
    <a className="sched-task" key={id} href={`#/task/${id}`} title={`${card.title} —— 点击进入任务工作台`}>
      <b>#{card.seq}</b>
      <span className="sched-task-title">{card.title}</span>
      {extra ? <small>{extra}</small> : null}
    </a>
  )
}

export default function SchedulerPanel(): React.JSX.Element {
  const { cards, config, pushToast, refreshAll } = useApp()
  const [val, setVal] = useState(2)
  const [busy, setBusy] = useState(false)
  const sched = config?.scheduler
  const byId = new Map(cards.map((c) => [c.taskId, c]))

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.setScheduler(val)
      await refreshAll()
      pushToast(`并发槽已调整为 ${val}`, 'ok')
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h3>调度与引擎</h3>
      {sched && (
        <>
          <div className="sched-row">
            <label>
              并发槽 maxConcurrent
              <input type="number" min={1} max={16} value={val} onChange={(e) => setVal(Number(e.target.value) || 1)} />
            </label>
            <button className="btn sm" disabled={busy || val === sched.maxConcurrent} onClick={() => void save()}>
              保存
            </button>
            <span className="sched-cur">当前 {sched.maxConcurrent}</span>
          </div>
          <dl className="sched-list">
            <div>
              <dt>运行中（占槽）</dt>
              <dd>
                {sched.running.length
                  ? sched.running.map((id) => {
                      const c = byId.get(id)
                      return <SchedTask key={id} id={id} card={c} extra={c ? `阶段·${STAGES[c.stage].shortLabel}` : undefined} />
                    })
                  : <em>无</em>}
              </dd>
            </div>
            <div>
              <dt>排队中</dt>
              <dd>
                {sched.queued.length
                  ? sched.queued.map((id, i) => <SchedTask key={id} id={id} card={byId.get(id)} extra={`第${i + 1}位`} />)
                  : <em>无</em>}
              </dd>
            </div>
            <div>
              <dt title="任务停在人工门等唯一拍板人决策（铁门永不代答）；等待期间并发槽已释放，不阻塞其他任务排队运行">门等待（等人拍板）</dt>
              <dd>
                {sched.gateWaiting.length
                  ? sched.gateWaiting.map((id) => {
                      const c = byId.get(id)
                      const ms = c?.gateRaisedAt ? Date.now() - Date.parse(c.gateRaisedAt) : Number.NaN
                      const wait = Number.isFinite(ms) ? fmtDur(ms) : null
                      return (
                        <SchedTask
                          key={id}
                          id={id}
                          card={c}
                          extra={c ? `等${c.gateDeciderName ?? '拍板人'}拍板${wait ? ` · 已等${wait}` : ''}` : undefined}
                        />
                      )
                    })
                  : <em>无</em>}
              </dd>
            </div>
            <div>
              <dt title="已提交 MR：等远端流水线转绿 + 反馈消化">MR 监听中</dt>
              <dd>
                {sched.watching.length ? sched.watching.map((id) => <SchedTask key={id} id={id} card={byId.get(id)} />) : <em>无</em>}
              </dd>
            </div>
          </dl>
        </>
      )}
      {config && (
        <div className="engine-list">
          {config.engine.available.map((e) => (
            <div key={e.id} className={`engine-row ${e.available ? 'ok' : 'bad'} ${e.id === config.engine.active ? 'active' : ''}`}>
              <span className={`engine-dot ${e.available ? 'on' : 'off'}`} />
              <code>{e.id}</code>
              {e.id === config.engine.active && <span className="tag">当前</span>}
              <span className="engine-detail" title={e.detail}>
                {e.available ? '可用' : e.detail}
              </span>
            </div>
          ))}
          <small className="hint">引擎选择由服务端 AI_ENGINE 环境变量决定（auto/opencode/claude/simulated）；演示任务用 simulated。</small>
        </div>
      )}
      {config && (
        <div className="sched-quiet">
          安静时段：{config.quietHours.start} ~ {config.quietHours.end}（非紧急通知并入晨间摘要）
        </div>
      )}
    </section>
  )
}
