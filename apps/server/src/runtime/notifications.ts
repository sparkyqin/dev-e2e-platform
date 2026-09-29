import path from 'node:path'
import type { Notification, NotificationKind, NotificationPriority } from '@ai-platform/shared'
import { newId, nowIso, readJsonTolerant, writeJson } from '../domain/util.js'

/**
 * IM 通知服务（附录 C 通道B / [机-通知合并]）
 *
 * - `notified` + dedupKey 防重复打扰（同一 任务/类型/键 只通知一次）
 * - 安静时段（夜间）非紧急通知合并到早上（晨间摘要）
 * - 按优先级排序；通知单向触发、失败不阻塞
 */

export interface QuietHours {
  start: string // "22:00"
  end: string // "08:00"
}

export class NotificationService {
  private queue: Notification[] = []

  constructor(private file: string, private quiet: QuietHours) {}

  async init(): Promise<void> {
    this.queue = (await readJsonTolerant<Notification[]>(this.file)) ?? []
  }

  async persist(): Promise<void> {
    await writeJson(this.file, this.queue)
  }

  inQuietHours(now = new Date()): boolean {
    const mins = now.getHours() * 60 + now.getMinutes()
    const [sh, sm] = this.quiet.start.split(':').map(Number)
    const [eh, em] = this.quiet.end.split(':').map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
  }

  quietHours(): QuietHours {
    return { ...this.quiet }
  }

  async notify(input: {
    taskId?: string
    taskSeq?: number
    kind: NotificationKind
    priority: NotificationPriority
    title: string
    body: string
    deeplink?: string
    audience: string
    dedupKey: string
    force?: boolean // 忽略安静时段（critical 升级）
  }): Promise<Notification | null> {
    // 防重复：同一 dedupKey 已通知过则跳过
    if (this.queue.some((n) => n.dedupKey === input.dedupKey && n.notified)) {
      return null
    }
    const quiet = this.inQuietHours() && input.priority !== 'critical' && !input.force
    const n: Notification = {
      id: newId('ntf'),
      taskId: input.taskId,
      taskSeq: input.taskSeq,
      kind: input.kind,
      priority: input.priority,
      title: input.title,
      body: input.body,
      deeplink: input.deeplink ?? (input.taskId ? `#/task/${input.taskId}` : '#/'),
      audience: input.audience,
      createdAt: nowIso(),
      dedupKey: input.dedupKey,
      notified: !quiet,
      notifiedAt: quiet ? undefined : nowIso(),
      read: false,
    }
    this.queue.push(n)
    await this.persist()
    return n
  }

  /** 晨间摘要：把安静时段挂起的通知合并成一条（按受众） */
  async flushMorningDigest(): Promise<Notification[]> {
    if (this.inQuietHours()) return []
    const held = this.queue.filter((n) => !n.notified && !n.mergedInto)
    if (held.length === 0) return []
    const byAudience = new Map<string, Notification[]>()
    for (const n of held) {
      const list = byAudience.get(n.audience) ?? []
      list.push(n)
      byAudience.set(n.audience, list)
    }
    const digests: Notification[] = []
    for (const [audience, list] of byAudience) {
      const digest: Notification = {
        id: newId('ntf'),
        kind: 'morning-digest',
        priority: 'high',
        title: `晨间摘要：夜间挂起 ${list.length} 条待办`,
        body: list.map((n) => `· [${n.kind}] ${n.title}`).join('\n'),
        deeplink: '#/',
        audience,
        createdAt: nowIso(),
        dedupKey: `digest-${audience}-${new Date().toDateString()}`,
        notified: true,
        notifiedAt: nowIso(),
        read: false,
      }
      this.queue.push(digest)
      for (const n of list) {
        n.notified = true
        n.notifiedAt = nowIso()
        n.mergedInto = digest.id
      }
      digests.push(digest)
    }
    await this.persist()
    return digests
  }

  inbox(audience?: string): Notification[] {
    const list = audience ? this.queue.filter((n) => n.audience === audience) : this.queue
    const order: Record<NotificationPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 }
    return [...list].sort((a, b) => order[a.priority] - order[b.priority] || b.createdAt.localeCompare(a.createdAt))
  }

  async markRead(id: string): Promise<void> {
    const n = this.queue.find((x) => x.id === id)
    if (n) {
      n.read = true
      await this.persist()
    }
  }

  async markAllRead(audience: string): Promise<void> {
    for (const n of this.queue) if (n.audience === audience) n.read = true
    await this.persist()
  }
}
