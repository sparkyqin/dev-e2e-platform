/**
 * 渲染错误边界：任何视图级渲染崩溃 → 人话错误面板（不再整页白屏）
 * - 顶栏在边界之外，崩溃后仍可导航逃离
 * - resetKey（视图/任务）变化自动复位：一次崩溃不毒化其他视图
 * - 完整堆栈只进控制台（componentDidCatch），界面不裸露堆栈
 */
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  /** 变化即复位（传 当前视图+任务id） */
  resetKey: string
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="crash-panel">
        <h3>😵 界面出了点问题</h3>
        <p>这一块渲染时出错了，其余功能不受影响。可以先返回任务列表，或重试 / 刷新页面。</p>
        <pre>{this.state.error.message}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            刷新页面
          </button>
          <a className="btn" href="#/">
            返回任务列表
          </a>
        </div>
      </div>
    )
  }
}
