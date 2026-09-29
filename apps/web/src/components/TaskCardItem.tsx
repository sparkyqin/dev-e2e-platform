/**
 * 任务卡片（会话厅第一层）：状态/健康/阶段徽标 + 当前门提示 + 引擎/场景
 */
import type { TaskCard } from '@ai-platform/shared'
import { HEALTH_META, STATUS_META, fmtTime, stageLabel } from '../format'

export function TaskStatusBadge({ card }: { card: TaskCard }): React.JSX.Element {
  const m = STATUS_META[card.status]
  return <span className={`badge ${m.cls}`}>{m.label}</span>
}

export function HealthDot({ level }: { level: TaskCard['health'] }): React.JSX.Element {
  const m = HEALTH_META[level.level]
  return (
    <span className={`health ${m.cls}`} title={(level.facts.map((f) => f.message).join('\n') || m.label) as string}>
      ●
    </span>
  )
}

export default function TaskCardItem({ card, onOpen }: { card: TaskCard; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <article className="task-card" onClick={() => onOpen(card.taskId)}>
      <header className="task-card-head">
        <span className="task-seq">#{card.seq}</span>
        <h3>{card.title}</h3>
        <HealthDot level={card.health} />
      </header>
      <div className="task-card-badges">
        <TaskStatusBadge card={card} />
        <span className="badge bg-stage">{stageLabel(card.stage)}</span>
        {card.gateKind && <span className="badge bg-gate">🟡 待决策</span>}
        {card.subtasks && (
          <span className="badge bg-agg" title={card.subtasks.map((s) => `${s.arTitle}：${STATUS_META[s.status]?.label ?? s.status}`).join('\n')}>
            ⧉ AR {card.subtasks.filter((s) => s.status === 'merged' || s.status === 'archived').length}/{card.subtasks.length}
          </span>
        )}
        {card.parentTaskId && <span className="badge bg-agg" title={`父任务 ${card.parentTaskId}`}>AR 子任务</span>}
        {card.unattended && <span className="badge bg-misc">夜间无人值守</span>}
        {card.autonomy === 'human' && <span className="badge bg-held">人在控</span>}
        {card.repairRounds > 0 && <span className="badge bg-misc">修复 {card.repairRounds} 轮</span>}
      </div>
      {card.gateQuestion && <p className="task-card-gate">🟡 {card.gateQuestion}</p>}
      <footer className="task-card-foot">
        <span>{card.module || '—'}</span>
        <span className="dot">·</span>
        <span>{card.repo || '—'}</span>
        <span className="dot">·</span>
        <span className="mono">{card.engineId}</span>
        <span className="spacer" />
        <time>{fmtTime(card.updatedAt)}</time>
      </footer>
    </article>
  )
}
