// OpenCode 引擎 e2e 冒烟：建 opencode 引擎任务 → 盯事件流直到出事实门/失败
// 用法：node scripts/e2e-opencode.mjs
const BASE = 'http://localhost:8787'
let cookie = ''

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0]
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`)
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. 登录（需求方）
const { user } = await j('POST', '/api/auth/demo-login', { userId: 'zhangming' })
console.log(`登录：${user.name}（${user.userId}）`)

// 2. 建 opencode 引擎任务
const created = await j('POST', '/api/tasks', {
  title: '积分到期提醒（OpenCode 引擎冒烟）',
  requirementText:
    '会员积分快过期时提醒用户。需求点：1) 距过期≤7天的积分需要提醒；2) 提醒渠道：App 内信优先、短信兜底；3) 清零动作要留审计痕迹。技术栈与平台一致（Node 全栈 TS）。',
  module: 'member-points',
  repo: 'ai-platform',
  mode: 'greenfield',
  engineId: 'opencode',
  unattended: false,
})
const taskId = created.taskId ?? created.state?.taskId
console.log(`任务已建：${taskId}（engine=${created.engineId ?? created.state?.engineId}）`)

// 3. 轮询：状态行 + 事件流增量（events 在专用端点，detail 不带）
let lastSeq = 0
let lastLine = ''
const t0 = Date.now()
while (Date.now() - t0 < 420_000) {
  await sleep(3000)
  const d = await j('GET', `/api/tasks/${taskId}`).catch((e) => null)
  if (!d) {
    console.log('轮询失败（任务可能已归档）')
    break
  }
  const evs = (await j('GET', `/api/tasks/${taskId}/events?afterSeq=${lastSeq}&pageSize=100`).catch(() => ({ events: [] }))).events ?? []
  for (const e of evs) {
    lastSeq = e.seq
    const brief =
      e.kind === 'tool_call' ? `tool_call ${e.tool}`
      : e.kind === 'tool_result' ? `tool_result ${e.tool} ok=${e.ok}`
      : e.kind === 'assistant_message' ? `assistant: ${String(e.text ?? '').slice(0, 70).replace(/\n/g, ' ')}`
      : e.kind === 'session_ended' ? `session_ended ${e.reason}: ${String(e.summary ?? '').slice(0, 120)}`
      : e.kind === 'session_started' ? `session_started（engine=${e.engine}）`
      : e.kind === 'stage_exited' ? `stage_exited ${e.reason}`
      : (e.title ?? e.summary ?? '')
    console.log(`  [${e.stage}] #${e.seq} ${e.kind}: ${brief}`)
  }
  const s = d.state
  const line = `[${s.stage}/${s.status}] gate=${s.gate ? `${s.gate.kind}:${s.gate.status}` : '-'} health=${s.health?.level ?? '-'}`
  if (line !== lastLine) {
    console.log(line)
    lastLine = line
  }
  if (s.gate?.status === 'raised') {
    console.log(`\n✅ 到门：${s.gate.kind}（等待拍板）——引擎作业完成，事件流如上`)
    break
  }
  if (s.status === 'failed') {
    console.log(`\n❌ 任务失败：`, (s.health?.facts ?? []).map((f) => f.message).join('; '))
    break
  }
}
console.log('（冒烟观察结束）')
