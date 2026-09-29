/**
 * 通知收件箱（IM 通道投影）：按优先级排序、深链直达任务工作台
 * 支持单条已读 / 全部已读 / 手动触发晨间摘要（演示安静时段合并）
 */
import { useState } from 'react'
import type { Notification, NotificationPriority } from '@ai-platform/shared'
import { useApp } from '../store'
import { api } from '../api'
import { NOTIF_ICON, fmtTime } from '../format'

const PRIO_ORDER: Record<NotificationPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 }

function sortNotifs(list: Notification[]): Notification[] {
  return [...list].sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] || (a.createdAt < b.createdAt ? 1 : -1))
}

export default function NotificationBell(): React.JSX.Element {
  const { me, notifications, refreshNotifications, markAllRead, pushToast } = useApp()
  const [open, setOpen] = useState(false)
  const sorted = sortNotifs(notifications)

  const openOne = async (n: Notification): Promise<void> => {
    if (!n.read) {
      try {
        await api.markRead(n.id)
      } catch {
        /* ignore */
      }
      void refreshNotifications()
    }
    if (n.deeplink) window.location.hash = n.deeplink.startsWith('#') ? n.deeplink : `#${n.deeplink}`
    setOpen(false)
  }

  const flushDigest = async (): Promise<void> => {
    try {
      const r = await api.flushDigest()
      await refreshNotifications()
      pushToast(`晨间摘要已合并 ${r.merged} 条安静时段通知`, 'ok')
    } catch (e) {
      pushToast((e as Error).message, 'err')
    }
  }

  const unread = notifications.filter((n) => !n.read)

  return (
    <div className={`bell ${open ? 'open' : ''}`}>
      <button className="bell-btn" onClick={() => setOpen((o) => !o)} title={`${me.name} 的通知收件箱`}>
        🔔
        {unread.length > 0 && <span className="bell-badge">{unread.length}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head">
            <strong>通知收件箱（{me.name}）</strong>
            <span className="bell-actions">
              <button className="link" onClick={() => void flushDigest()} title="演示：手动合并安静时段通知为晨间摘要">
                晨间摘要
              </button>
              <button className="link" onClick={() => void markAllRead()}>
                全部已读
              </button>
            </span>
          </div>
          <div className="bell-list">
            {sorted.length === 0 && <div className="bell-empty">（暂无通知）</div>}
            {sorted.map((n) => (
              <button key={n.id} className={`bell-item ${n.read ? '' : 'unread'} prio-${n.priority}`} onClick={() => void openOne(n)}>
                <span className="bell-icon">{NOTIF_ICON[n.kind]}</span>
                <span className="bell-body">
                  <span className="bell-title">{n.title}</span>
                  <span className="bell-text">{n.body}</span>
                  <span className="bell-meta">
                    {fmtTime(n.createdAt)} · {n.taskId ? (n.taskSeq ? `#${n.taskSeq}` : n.taskId) : '平台'} · {n.priority}
                    {n.mergedInto ? ' · 已并入晨间摘要' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
