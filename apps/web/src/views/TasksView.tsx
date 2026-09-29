/**
 * 任务视图（顶层 · #/）：任务卡片/看板 + 新建任务 —— "在干什么"的正交功能域
 * 调度/技能/度量归各自顶层视图；视图选择记忆（hall-view）；点卡片进任务工作台
 */
import { useState } from 'react'
import { useApp } from '../store'
import TaskCardItem from '../components/TaskCardItem'
import StageBoard from '../components/StageBoard'
import NewTaskDialog from '../components/NewTaskDialog'

export default function TasksView(): React.JSX.Element {
  const { cards } = useApp()
  const [showNew, setShowNew] = useState(false)
  const [view, setView] = useState<'grid' | 'board'>(() => (localStorage.getItem('hall-view') === 'board' ? 'board' : 'grid'))

  const open = (taskId: string): void => {
    window.location.hash = `#/task/${taskId}`
  }

  const switchView = (v: 'grid' | 'board'): void => {
    setView(v)
    localStorage.setItem('hall-view', v)
  }

  return (
    <div className="hall">
      <div className="hall-main">
        <div className="hall-toolbar">
          <div className="hall-title">
            <h2>任务</h2>
            <span className="hint">全部任务的实时视图：状态徽标 / 健康度 / 当前门；点卡片进工作台</span>
          </div>
          <div className="hall-actions">
            <div className="view-toggle" role="tablist" aria-label="视图切换">
              <button className={`toggle-btn ${view === 'grid' ? 'on' : ''}`} role="tab" aria-selected={view === 'grid'} onClick={() => switchView('grid')}>
                ▦ 卡片
              </button>
              <button className={`toggle-btn ${view === 'board' ? 'on' : ''}`} role="tab" aria-selected={view === 'board'} onClick={() => switchView('board')} title="阶段看板：列=9 阶段主干；拖拽不绕门（门等待卡拖动直达拍板）">
                ▤ 看板
              </button>
            </div>
            <button className="btn primary" onClick={() => setShowNew(true)}>
              ＋ 新建任务
            </button>
          </div>
        </div>
        {view === 'grid' ? (
          <div className="task-grid">
            {cards.length === 0 && <div className="empty-big">还没有任务。点「新建任务」用一句话需求开张。</div>}
            {cards.map((c) => (
              <TaskCardItem key={c.taskId} card={c} onOpen={open} />
            ))}
          </div>
        ) : (
          <StageBoard cards={cards} onOpen={open} />
        )}
      </div>
      {showNew && (
        <NewTaskDialog
          onClose={() => setShowNew(false)}
          onCreated={(taskId) => {
            setShowNew(false)
            open(taskId)
          }}
        />
      )}
    </div>
  )
}
