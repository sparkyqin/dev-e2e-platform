/**
 * 顶层：hash 路由（#/ → 任务；#/task/<id> → 任务工作台；#/metrics → 度量；#/runtime → 运行时；#/knowledge → 知识库）+ 顶栏 + toast
 * 四个功能域正交：任务（在干什么）· 度量（干得怎样）· 运行时（用什么跑）· 知识库（沉淀了什么）
 * 静态托管无需 SPA 回退（state-based 导航 + hash 深链）
 */
import { useEffect, useState } from 'react'
import { AppProvider, useApp } from './store'
import TasksView from './views/TasksView'
import TaskView from './views/TaskView'
import MetricsView from './views/MetricsView'
import RuntimeView from './views/RuntimeView'
import KnowledgeView from './views/KnowledgeView'
import IdentityPicker from './components/IdentityPicker'
import NotificationBell from './components/NotificationBell'
import LoginView from './components/LoginView'

type TopView = 'tasks' | 'task' | 'metrics' | 'runtime' | 'knowledge'

function useHashRoute(): { view: TopView; taskId: string | null } {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const m = hash.match(/^#\/task\/([^/?]+)/)
  if (m) return { view: 'task', taskId: m[1] }
  if (/^#\/metrics\b/.test(hash)) return { view: 'metrics', taskId: null }
  if (/^#\/runtime\b/.test(hash)) return { view: 'runtime', taskId: null }
  if (/^#\/knowledge\b/.test(hash)) return { view: 'knowledge', taskId: null }
  return { view: 'tasks', taskId: null }
}

function TopBar(): React.JSX.Element {
  const { config } = useApp()
  const route = useHashRoute()
  const engine = config?.engine
  const on = (v: TopView, also?: TopView[]): boolean => route.view === v || (also ?? []).includes(route.view)
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="brand-mark">AI</span>
        <span className="brand-text">
          <strong>AI 研发平台</strong>
          <small>需求 → 代码合入</small>
        </span>
      </a>
      <nav className="topbar-nav" aria-label="主导航">
        <a className={`nav-link ${on('tasks', ['task']) ? 'on' : ''}`} href="#/" title="任务卡片/看板与任务工作台">
          任务
        </a>
        <a className={`nav-link ${on('metrics') ? 'on' : ''}`} href="#/metrics" title="TTM / 阶段耗时 / 门等待 / 回退（事件流只读派生）">
          度量
        </a>
        <a className={`nav-link ${on('runtime') ? 'on' : ''}`} href="#/runtime" title="并发槽 · 引擎选择与健康 · 剧本">
          运行时
        </a>
        <a className={`nav-link ${on('knowledge') ? 'on' : ''}`} href="#/knowledge" title="技能库 · 候选沉淀 · 采纳审计">
          知识库
        </a>
      </nav>
      <div className="topbar-engine" title={engine ? engine.available.map((e) => `${e.id}: ${e.available ? '可用' : e.detail}`).join('\n') : ''}>
        {engine && (
          <>
            <span className={`engine-dot ${engine.available.find((e) => e.id === engine.active)?.available ? 'on' : 'off'}`} />
            引擎 <code>{engine.active}</code>
          </>
        )}
      </div>
      <NotificationBell />
      <IdentityPicker />
    </header>
  )
}

function Toasts(): React.JSX.Element {
  const { toasts } = useApp()
  if (toasts.length === 0) return <></>
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function Shell(): React.JSX.Element {
  const route = useHashRoute()
  const { authed } = useApp()
  if (authed === null) {
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand-mark xl">AI</div>
          <p className="login-hint">正在探测会话…</p>
        </div>
      </div>
    )
  }
  if (authed === false) return <LoginView />
  return (
    <div className="app">
      <TopBar />
      <main className="app-main">
        {route.view === 'metrics' ? (
          <MetricsView />
        ) : route.view === 'runtime' ? (
          <RuntimeView />
        ) : route.view === 'knowledge' ? (
          <KnowledgeView />
        ) : route.view === 'task' && route.taskId ? (
          <TaskView key={route.taskId} taskId={route.taskId} />
        ) : (
          <TasksView />
        )}
      </main>
      <Toasts />
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}

