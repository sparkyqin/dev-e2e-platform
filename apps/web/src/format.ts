/**
 * 展示辅助：状态/健康/事件渲染元数据与格式化函数
 */
import type {
  HealthLevel,
  Notification,
  SemanticEvent,
  SemanticEventKind,
  StageId,
  TaskState,
} from '@ai-platform/shared'
import { STAGES, STAGE_ORDER } from '@ai-platform/shared'

export const STATUS_META: Record<TaskState['status'], { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'st-queued' },
  running: { label: 'AI 推进中', cls: 'st-running' },
  'gate-wait': { label: '门等待', cls: 'st-gate' },
  'user-held': { label: '人接管中', cls: 'st-held' },
  watching: { label: 'MR 监听态', cls: 'st-watching' },
  aggregating: { label: 'AR 聚合中', cls: 'st-agg' },
  merged: { label: '已合入', cls: 'st-merged' },
  failed: { label: '已停止/升级', cls: 'st-failed' },
  archived: { label: '已归档', cls: 'st-archived' },
}

export const HEALTH_META: Record<HealthLevel, { label: string; cls: string }> = {
  green: { label: '健康', cls: 'hl-green' },
  yellow: { label: '黄牌', cls: 'hl-yellow' },
  red: { label: '红线', cls: 'hl-red' },
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function stageLabel(stage: StageId): string {
  return STAGES[stage]?.label ?? stage
}

export function stageShort(stage: StageId): string {
  return STAGES[stage]?.shortLabel ?? stage
}

export function stageNo(stage: StageId): number {
  return STAGES[stage]?.no ?? 0
}

/** 阶段轨进度：当前阶段索引（含 merged 终态） */
export function stageProgress(stage: StageId): number {
  return STAGE_ORDER.indexOf(stage)
}

export const SCENARIO_LABEL: Record<TaskState['scenario'], string> = {
  clean: '顺滑剧本',
  'flaky-tool': '工具抽风（健康红线+接管修复）',
  'build-fail': '构建失败（预算耗尽+恢复）',
  'feedback-loop': 'MR 反馈环（SHA 失效+重推）',
}

// ---------- 事件渲染 ----------

export interface EventRender {
  icon: string
  actor: string
  title: string
  body: string
  cls: string
}

const ACTOR_LABEL: Record<string, string> = { human: '人', ai: 'AI', system: '系统' }

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function renderEvent(ev: SemanticEvent): EventRender {
  const p = ev.payload as unknown as Record<string, unknown>
  const who = ev.actor.type === 'human' ? (ev.actor.name ?? ev.actor.userId ?? '人') : ACTOR_LABEL[ev.actor.type] ?? ev.actor.type
  switch (ev.kind) {
    case 'session_started':
      return { icon: '🚀', actor: who, title: `会话开始 · ${p.engine ?? ''}`, body: String(p.purpose ?? ''), cls: 'ev-session' }
    case 'session_ended':
      return { icon: '🏁', actor: who, title: `会话结束（${p.reason ?? ''}）`, body: String(p.summary ?? ''), cls: 'ev-session' }
    case 'user_message':
      return { icon: '💬', actor: who, title: `用户消息（${p.source ?? ''}）`, body: String(p.text ?? ''), cls: 'ev-user' }
    case 'assistant_message':
      return { icon: '🤖', actor: who, title: 'AI 输出', body: String(p.text ?? ''), cls: 'ev-ai' }
    case 'tool_call':
      return { icon: '🔧', actor: who, title: `调用 ${String(p.tool ?? '')}`, body: String(p.input ?? ''), cls: 'ev-tool' }
    case 'tool_result':
      return {
        icon: p.ok ? '✅' : '❌',
        actor: who,
        title: `结果 ${String(p.tool ?? '')}`,
        body: String(p.summary ?? ''),
        cls: p.ok ? 'ev-tool-ok' : 'ev-tool-fail',
      }
    case 'stage_entered':
      return {
        icon: '▶️',
        actor: who,
        title: `进入「${stageLabel(p.stage as StageId)}」第 ${Number(p.round ?? 1)} 轮${p.reentry ? '（回退重做）' : ''}`,
        body: STAGES[p.stage as StageId]?.desc ?? '',
        cls: 'ev-stage',
      }
    case 'stage_exited':
      return { icon: '⏹️', actor: who, title: `离开「${stageLabel(p.stage as StageId)}」（${p.reason ?? ''}）`, body: '', cls: 'ev-stage' }
    case 'gate_raised':
      return { icon: '🟡', actor: who, title: `门举起：${String(p.gateKind ?? '')}`, body: truncate(String(p.question ?? ''), 300), cls: 'ev-gate' }
    case 'gate_decided':
      return { icon: '⚖️', actor: who, title: `门决策：${String(p.action ?? '')}（${String(p.decidedByName ?? '')}）`, body: '', cls: 'ev-gate' }
    case 'rollback':
      return {
        icon: '↩️',
        actor: who,
        title: `回退：「${stageLabel(p.from as StageId)}」→「${stageLabel(p.to as StageId)}」`,
        body: `${String(p.declaredByName ?? '')}：${String(p.reason ?? '')}`,
        cls: 'ev-rollback',
      }
    case 'takeover':
      return {
        icon: p.direction === 'human' ? '✋' : '🔁',
        actor: who,
        title: p.direction === 'human' ? '人工接管（中断在跑会话）' : '恢复自动迭代',
        body: String(p.note ?? ''),
        cls: 'ev-takeover',
      }
    case 'artifact_written':
      return {
        icon: '📄',
        actor: who,
        title: `产物写入（${String(p.partition ?? '')} 区）`,
        body: `${String(p.path ?? '')} · ${fmtBytes(Number(p.bytes ?? 0))}`,
        cls: 'ev-artifact',
      }
    case 'health_changed':
      return { icon: '❤️', actor: who, title: `健康 ${String(p.from ?? '')} → ${String(p.to ?? '')}`, body: (p.facts as string[] | undefined)?.join('；') ?? '', cls: 'ev-health' }
    case 'subtask_spawned':
      return {
        icon: '⧉',
        actor: who,
        title: `AR${String(p.index ?? '')}/${String(p.totalSubtasks ?? '')} 派发：${String(p.arTitle ?? '')}`,
        body: `子任务 ${String(p.subtaskTaskId ?? '')} · 责任人 ${String(p.ownerName ?? '')}`,
        cls: 'ev-subtask',
      }
    case 'subtask_completed':
      return {
        icon: '✔️',
        actor: who,
        title: `AR 合入：${String(p.arTitle ?? '')}（${String(p.mergedCount ?? '')}/${String(p.totalSubtasks ?? '')}）`,
        body: `子任务 ${String(p.subtaskTaskId ?? '')} 已合入`,
        cls: 'ev-subtask',
      }
    default:
      return { icon: '•', actor: who, title: ev.kind, body: JSON.stringify(p), cls: '' }
  }
}

export const KIND_LABEL: Record<SemanticEventKind, string> = {
  session_started: '会话开始',
  session_ended: '会话结束',
  user_message: '用户消息',
  assistant_message: 'AI 输出',
  tool_call: '工具调用',
  tool_result: '工具结果',
  stage_entered: '进入阶段',
  stage_exited: '离开阶段',
  gate_raised: '门举起',
  gate_decided: '门决策',
  rollback: '回退',
  takeover: '接管/恢复',
  artifact_written: '产物写入',
  health_changed: '健康变化',
  subtask_spawned: 'AR 派发',
  subtask_completed: 'AR 合入',
}

export const NOTIF_ICON: Record<Notification['kind'], string> = {
  'gate-raised': '🟡',
  'gate-escalated': '🔴',
  'health-warn': '❤️',
  'build-failed': '💥',
  'repair-exceeded': '🛑',
  'mr-watching': '👀',
  'feedback-needs-human': '🗨️',
  'merge-ready': '🟢',
  merged: '✔️',
  'morning-digest': '🌅',
  'skill-candidate': '🧠',
  info: 'ℹ️',
}

/** 时长格式化（度量用）：ms → 人类可读（TTM/阶段耗时/门等待共用） */
export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m${rs > 0 ? `${rs}s` : ''}`
  return `${Math.floor(m / 60)}h${(m % 60) > 0 ? `${m % 60}m` : ''}`
}
