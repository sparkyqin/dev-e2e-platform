/**
 * 临时诊断脚本（不参与构建/类型检查）：
 * 用真实任务数据 SSR 渲染 ArtifactsPanel，确定性复现「材料页签白屏」。
 * 覆盖路径 = 组件挂载渲染（与点击材料 tab 的挂载路径完全一致）。
 * 注：不用 JSX（scripts/ 不在 tsconfig include 内，避免经典/自动运行时歧义）。
 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import ArtifactsPanel from '../src/components/ArtifactsPanel'
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
    try {
      const html = renderToString(
        React.createElement(
          AppProvider,
          null,
          React.createElement(ArtifactsPanel, { taskId: t.taskId, detail, refreshDetail: async () => {} }),
        ),
      )
      if (!html.includes('artifact-group') && !html.includes('injections')) {
        console.log('⚠', t.taskId, '输出异常短:', JSON.stringify(html.slice(0, 100)))
      }
    } catch (e) {
      crash++
      console.log('✗', t.taskId, (e as Error).message)
      console.log((e as Error).stack?.split('\n').slice(0, 8).join('\n'))
    }
  }
  console.log(crash === 0 ? `✓ ${tasks.length} 个任务材料面板全部渲染通过（挂载路径）` : `✗ ${crash}/${tasks.length} 个任务渲染崩溃`)
}

void main()
