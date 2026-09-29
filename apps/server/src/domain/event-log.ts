import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  EventActor,
  SemanticEvent,
  SemanticEventKind,
  SemanticEventPayloadMap,
  EventFilter,
  JourneyEntry,
} from '@ai-platform/shared'
import type { StageId } from '@ai-platform/shared'
import { KeyedMutex, atomicWrite, nowIso, readJsonTolerant } from './util.js'

/**
 * 语义事件流（[机-语义事件流] / [机-重启恢复]）
 *
 * 每任务一个 append-only JSONL：`tasks/<id>/.flow/events.jsonl`
 * 单调 seq；可按 kind / afterSeq / 只看工具调用 过滤回放。
 * 文件级互斥保证并行作业（多维评审）下 seq 不冲突。
 */

const fileMutex = new KeyedMutex()

/** 进程内 seq 缓存（file → lastSeq）：append 不再每次全量读文件解析——
 *  事件流到几千条后旧实现写入成本 O(n²)。缓存仅在「本进程写」路径上失效（互斥保证单写者）；
 *  文件被外部改动（如磁盘修复）的兜底：缓存 miss 时全量读重建。 */
const seqCache = new Map<string, number>()

export class EventLog {
  constructor(private file: string) {}

  async append<K extends SemanticEventKind>(
    taskId: string,
    stage: StageId,
    actor: EventActor,
    kind: K,
    payload: SemanticEventPayloadMap[K],
  ): Promise<SemanticEvent> {
    return fileMutex.run(this.file, async () => {
      const cached = seqCache.get(this.file)
      const seq = (cached !== undefined ? cached : await this.lastSeqUnsafe()) + 1
      const event: SemanticEvent = { seq, ts: nowIso(), taskId, kind, stage, actor, payload } as SemanticEvent
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, JSON.stringify(event) + '\n', 'utf8')
      seqCache.set(this.file, seq)
      return event
    })
  }

  private async lastSeqUnsafe(): Promise<number> {
    try {
      const txt = await fs.readFile(this.file, 'utf8')
      const lines = txt.trim().split('\n').filter(Boolean)
      if (lines.length === 0) return 0
      const last = JSON.parse(lines[lines.length - 1]) as SemanticEvent
      seqCache.set(this.file, last.seq)
      return last.seq
    } catch {
      return 0
    }
  }

  async lastSeq(): Promise<number> {
    return fileMutex.run(this.file, () => this.lastSeqUnsafe())
  }

  async read(filter?: EventFilter): Promise<SemanticEvent[]> {
    let events: SemanticEvent[]
    try {
      const txt = await fs.readFile(this.file, 'utf8')
      events = txt
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SemanticEvent)
    } catch {
      return []
    }
    let out = events
    if (filter?.afterSeq !== undefined) out = out.filter((e) => e.seq > (filter.afterSeq ?? 0))
    if (filter?.kinds?.length) out = out.filter((e) => filter.kinds!.includes(e.kind))
    if (filter?.toolsOnly) out = out.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result')
    return out
  }

  /** 从事件流重建任务历程（TaskJourney，只读投影；文件/PG 两后端共用派生） */
  async journey(limit = 200): Promise<JourneyEntry[]> {
    return buildJourney(await this.read(), limit)
  }
}

/** 事件 → 历程条目派生（单源：文件与 PG 后端共用） */
export function buildJourney(events: SemanticEvent[], limit = 200): JourneyEntry[] {
  const entries: JourneyEntry[] = []
  for (const e of events) {
    entries.push({ ts: e.ts, seq: e.seq, kind: e.kind, stage: e.stage, text: journeyText(e) })
  }
  return entries.slice(-limit)
}

function journeyText(e: SemanticEvent): string {
  const p = e.payload as unknown as Record<string, unknown>
  switch (e.kind) {
    case 'session_started':
      return `会话开始：${String(p.purpose)}（引擎 ${String(p.engine)}）`
    case 'session_ended':
      return `会话结束（${String(p.reason)}）：${String(p.summary)}`
    case 'user_message':
      return `${e.actor.name ?? e.actor.userId ?? '用户'}：${String(p.text)}`
    case 'assistant_message':
      return truncate(String(p.text))
    case 'tool_call':
      return `调用工具 ${String(p.tool)}`
    case 'tool_result':
      return `${p.ok ? '✓' : '✗'} ${String(p.tool)}：${truncate(String(p.summary), 80)}`
    case 'stage_entered':
      return `进入阶段「${String(p.stage)}」（第 ${String(p.round)} 轮${p.reentry ? '，回退重做' : ''}）`
    case 'stage_exited':
      return `离开阶段「${String(p.stage)}」（${String(p.reason)}）`
    case 'gate_raised':
      return `举起${String(p.gateKind)}门：${truncate(String(p.question), 60)}`
    case 'gate_decided':
      return `门已决策（${String(p.action)}），决策人 ${String(p.decidedByName)}`
    case 'rollback':
      return `声明式回退：${String(p.from)} → ${String(p.to)}（${truncate(String(p.reason), 60)}）`
    case 'takeover':
      return p.direction === 'human' ? `人接管（via=${String(p.via)}）` : `恢复自动迭代`
    case 'artifact_written':
      return `写入产物 ${String(p.path)}（${String(p.partition)}区）`
    case 'health_changed':
      return `健康徽标 ${String(p.from)} → ${String(p.to)}`
    case 'subtask_spawned':
      return `AR 拆分派发：AR${String(p.index)}/${String(p.totalSubtasks)}「${String(p.arTitle)}」→ ${String(p.subtaskTaskId)}（责任人 ${String(p.ownerName)}）`
    case 'subtask_completed':
      return `AR 子任务合入：「${String(p.arTitle)}」（${String(p.mergedCount)}/${String(p.totalSubtasks)}）`
    default:
      return e.kind
  }
}

function truncate(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 审计留痕（决策/操作 append-only） */
export interface AuditEntry {
  ts: string
  actor: string
  actorName: string
  action: string
  detail: Record<string, unknown>
}

export class AuditLog {
  constructor(private file: string) {}

  async append(entry: AuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8')
  }

  async read(): Promise<AuditEntry[]> {
    try {
      const txt = await fs.readFile(this.file, 'utf8')
      return txt
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry)
    } catch {
      return []
    }
  }
}

/** 注入摘要持久化（可观测：实际塞了什么） */
export interface InjectionRecord {
  file: string
}

export async function loadInjections(flowDir: string): Promise<import('@ai-platform/shared').InjectionSummary[]> {
  return (await readJsonTolerant<import('@ai-platform/shared').InjectionSummary[]>(path.join(flowDir, 'injections.json'))) ?? []
}

export async function saveInjections(flowDir: string, list: import('@ai-platform/shared').InjectionSummary[]): Promise<void> {
  await atomicWrite(path.join(flowDir, 'injections.json'), JSON.stringify(list, null, 2))
}
