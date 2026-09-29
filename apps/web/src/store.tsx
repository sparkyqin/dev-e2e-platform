/**
 * 全局应用状态：认证身份、任务卡片轮询、通知收件箱、平台配置、toast
 * 身份唯一来源 = 服务端会话（Cookie）：me() 探测登录态，401 全局事件切回登录页；
 * DEMO_MODE 下身份切换 = /api/auth/switch 重铸会话（生产模式不渲染切换器）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Notification, PlatformConfig, TaskCard, User } from '@ai-platform/shared'
import { USERS } from '@ai-platform/shared'
import { api } from './api'

export interface Toast {
  id: number
  text: string
  tone: 'ok' | 'warn' | 'err'
}

interface AppCtx {
  /** null=启动探测中；false=未登录（渲染登录页） */
  authed: boolean | null
  me: User
  demoMode: boolean
  /** 登录（令牌）；成功后进入应用 */
  logIn: (userId: string, token: string) => Promise<void>
  /** 演示模式免令牌登录 */
  demoLogIn: (userId: string) => Promise<void>
  /** 演示模式切换身份（重铸会话）；严格模式不可用 */
  setMe: (userId: string) => Promise<void>
  logout: () => Promise<void>
  cards: TaskCard[]
  config: PlatformConfig | null
  notifications: Notification[]
  unread: Notification[]
  refreshAll: () => Promise<void>
  refreshCards: () => Promise<void>
  refreshNotifications: () => Promise<void>
  markAllRead: () => Promise<void>
  pushToast: (text: string, tone?: Toast['tone']) => void
  toasts: Toast[]
}

const Ctx = createContext<AppCtx | null>(null)

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [meId, setMeId] = useState<string>('zhangming')
  const [demoMode, setDemoMode] = useState(false)
  const [cards, setCards] = useState<TaskCard[]>([])
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)

  const me = useMemo(() => USERS.find((u) => u.userId === meId) ?? USERS[0], [meId])

  const pushToast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++toastSeq.current
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  const refreshCards = useCallback(async () => {
    try {
      setCards(await api.listTasks())
    } catch {
      /* server 未起时静默 */
    }
  }, [])

  const refreshNotifications = useCallback(async () => {
    try {
      const { items } = await api.notifications()
      setNotifications(items)
    } catch {
      /* ignore */
    }
  }, [])

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.config())
    } catch {
      /* ignore */
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshCards(), refreshNotifications(), refreshConfig()])
  }, [refreshCards, refreshNotifications, refreshConfig])

  const markAllRead = useCallback(async () => {
    try {
      await api.markAllRead(meId)
      await refreshNotifications()
    } catch (e) {
      pushToast((e as Error).message, 'err')
    }
  }, [meId, refreshNotifications, pushToast])

  // 启动：登录态探测（公开 options 探测演示模式 + me 探测会话）
  useEffect(() => {
    void (async () => {
      try {
        const options = await api.authOptions()
        setDemoMode(options.demoMode)
      } catch {
        /* options 失败不阻塞（默认严格模式） */
      }
      try {
        const { user } = await api.me()
        setMeId(user.userId)
        setAuthed(true)
      } catch {
        setAuthed(false)
      }
    })()
  }, [])

  // 会话中途过期：任意 API 401 → 切回登录页
  useEffect(() => {
    const on = (): void => setAuthed(false)
    window.addEventListener('ai:unauthorized', on)
    return () => window.removeEventListener('ai:unauthorized', on)
  }, [])

  const logIn = useCallback(
    async (userId: string, token: string) => {
      const { user } = await api.login({ userId, token })
      setMeId(user.userId)
      setAuthed(true)
      await refreshAll()
    },
    [refreshAll],
  )

  const demoLogIn = useCallback(
    async (userId: string) => {
      const { user } = await api.demoLogin({ userId })
      setMeId(user.userId)
      setAuthed(true)
      await refreshAll()
    },
    [refreshAll],
  )

  const setMe = useCallback(
    async (userId: string) => {
      await api.switchUser({ userId })
      setMeId(userId)
      await refreshAll()
    },
    [refreshAll],
  )

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    setAuthed(false)
  }, [])

  // 轮询：任务列表 2s；通知 2.5s；配置 4s（仅登录态）
  useEffect(() => {
    if (authed !== true) return
    void refreshAll()
    const t1 = setInterval(() => void refreshCards(), 2000)
    const t2 = setInterval(() => void refreshNotifications(), 2500)
    const t3 = setInterval(() => void refreshConfig(), 4000)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
      clearInterval(t3)
    }
  }, [authed, refreshAll, refreshCards, refreshNotifications, refreshConfig])

  const value = useMemo<AppCtx>(
    () => ({
      authed,
      me,
      demoMode,
      logIn,
      demoLogIn,
      setMe,
      logout,
      cards,
      config,
      notifications,
      unread: notifications.filter((n) => !n.read),
      refreshAll,
      refreshCards,
      refreshNotifications,
      markAllRead,
      pushToast,
      toasts,
    }),
    [
      authed,
      me,
      demoMode,
      logIn,
      demoLogIn,
      setMe,
      logout,
      cards,
      config,
      notifications,
      refreshAll,
      refreshCards,
      refreshNotifications,
      markAllRead,
      pushToast,
      toasts,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApp must be used within AppProvider')
  return c
}
