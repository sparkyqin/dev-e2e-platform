/**
 * 运行时视图（顶层 · #/runtime）：调度并发 · 引擎选择与健康 · 剧本 —— "用什么跑、同时跑多少"的正交配置面
 */
import SchedulerPanel from '../components/SchedulerPanel'

export default function RuntimeView(): React.JSX.Element {
  return (
    <div className="page-view runtime-view">
      <div className="page-toolbar">
        <div className="hall-title">
          <h2>运行时</h2>
          <span className="hint">并发槽 · 引擎选择与健康探测 · 剧本 —— 平台用什么跑、同时跑多少</span>
        </div>
      </div>
      <div className="page-panels">
        <SchedulerPanel />
      </div>
    </div>
  )
}
