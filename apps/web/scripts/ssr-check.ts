/**
 * 临时诊断脚本（不参与构建/类型检查）：
 * 用真实任务数据 SSR 渲染详情页全部可视组件——确定性复现「渲染崩溃/白屏」。
 * 覆盖：ArtifactsPanel / PipelineStrip / PipelineBoard / TaskRail / JourneyPanel / GateCard / MrPanel / NowLine
 * 注：不用 JSX（scripts/ 不在 tsconfig include 内，避免经典/自动运行时歧义）。
 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import ArtifactsPanel from '../src/components/ArtifactsPanel'
import PipelineBoard, { PipelineStrip } from '../src/components/PipelineBoard'
import TaskRail from '../src/components/TaskRail'
import JourneyPanel from '../src/components/JourneyPanel'
import GateCard from '../src/components/GateCard'
import MrPanel from '../src/components/MrPanel'
import { NowLine } from '../src/views/TaskView'
import { AppProvider } from '../src/store'
import type { TaskDetail } from '@ai-platform/shared'

const BASE = 'http://localhost:8787'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function ready(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/options`)
      if (r.ok) return
    } catch {
      /* 重试 */
    }
    await sleep(500)
  }
  throw new Error('API 服务器 20s 内未就绪')
}

async function main(): Promise<void> {
  await ready()
  const login = await fetch(`${BASE}/api/auth/demo-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'admin' }),
  })
  if (!login.ok) throw new Error(`demo-login ${login.status}`)
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  const tasks: Array<{ taskId: string }> = await (await fetch(`${BASE}/api/tasks`, { headers: { cookie } })).json()
  let crash = 0
  for (const t of tasks) {
    const detail = (await (await fetch(`${BASE}/api/tasks/${t.taskId}`, { headers: { cookie } })).json()) as TaskDetail
    const { state } = detail
    const parts: Array<[string, React.ReactNode]> = [
      ['NowLine', React.createElement(NowLine, { state })],
      ['PipelineStrip', React.createElement(PipelineStrip, { state, events: [], onOpenBoard: () => {} })],
      ['PipelineBoard', React.createElement(PipelineBoard, { state, events: [], onOpenArtifact: () => {} })],
      ['TaskRail', React.createElement(TaskRail, { state, detail, onChanged: () => {} })],
      ['JourneyPanel', React.createElement(JourneyPanel, { journey: detail.journey })],
      ['ArtifactsPanel', React.createElement(ArtifactsPanel, { taskId: t.taskId, detail, refreshDetail: async () => {} })],
    ]
    if (state.gate) parts.push(['GateCard', React.createElement(GateCard, { taskId: t.taskId, state, gate: state.gate, onChanged: () => {} })])
    if (detail.delivery) parts.push(['MrPanel', React.createElement(MrPanel, { taskId: t.taskId, detail, refreshDetail: async () => {} })])
    for (const [name, node] of parts) {
      try {
        const html = renderToString(React.createElement(AppProvider, null, node))
        if (html.length < 30) console.log('⚠', t.taskId, name, '输出异常短:', JSON.stringify(html.slice(0, 60)))
      } catch (e) {
        crash++
        console.log('✗', t.taskId, name, (e as Error).message)
        console.log((e as Error).stack?.split('\n').slice(0, 6).join('\n'))
      }
    }
  }
  console.log(crash === 0 ? `✓ ${tasks.length} 个任务 × 全组件渲染通过` : `✗ ${crash} 处渲染崩溃`)
}

void main()
