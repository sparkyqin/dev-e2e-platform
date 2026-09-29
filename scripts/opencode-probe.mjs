// opencode 协议漂移核查工具：升级 opencode 后先跑它，核对引擎依赖的 v2 协议事实是否漂移
// 用法：node scripts/opencode-probe.mjs
//
// 核对项（全部来自 2026-09 对 opencode v2.0.18 的实测，引擎 opencode-engine.ts 依赖它们）：
//  [1] spawn「opencode serve --port=0」cwd=工作区 → stdout 出「server listening on <url>」
//  [2] OPENCODE_SERVER_PASSWORD env 注入 + Basic("opencode:"+口令) → /api/* 200
//  [3] 会话绑定服务端 cwd（create 响应 location.directory == 工作区）→ 工作区隔离的根基
//  [4] POST /session/{id}/prompt {text} 异步投递 → 事件流收到 AI 产出
//  [5] SSE 事件信封 {id,type,data}；工具/文本/收口事件名与字段
//  [6] 收口事件 session.execution.succeeded；usage.updated 带 tokens
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const probeDir = process.env.PROBE_DIR ?? 'C:\\Users\\sparky\\AppData\\Local\\Temp\\opencode-proto-probe'
rmSync(probeDir, { recursive: true, force: true })
mkdirSync(probeDir, { recursive: true })

const PW = randomBytes(24).toString('base64url')
const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
  shell: true,
  cwd: probeDir,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: PW },
})
let out = '', url = null
proc.stdout.on('data', (d) => {
  out += d
  if (!url) {
    const m = out.match(/(?:opencode\s+)?server\s+listening\s+on\s+(https?:\/\/\S+)/i)
    if (m) url = m[1]
  }
})
proc.stderr.on('data', (d) => (out += d))
await sleep(1800)
console.log(`[1] listening 行解析：url = ${url}`)
if (!url) { console.log('    失败，输出：', out.slice(0, 300)); killTree(); process.exit(1) }

const auth = `Basic ${Buffer.from('opencode:' + PW).toString('base64')}`
const H = { 'Content-Type': 'application/json', Authorization: auth }

// create + [2][3]
const cr = await fetch(`${url}/api/session`, { method: 'POST', headers: H, body: JSON.stringify({ title: '[probe] 协议核查' }) })
const cbody = await cr.json().catch(() => null)
const sessionId = cbody?.data?.id
const loc = cbody?.data?.location?.directory
console.log(`[2] create HTTP ${cr.status}，id = ${sessionId}`)
console.log(`[3] 会话目录 = ${loc} ${loc === probeDir ? '✅ 绑定工作区' : '❌ 未绑定（引擎隔离前提失效！）'}`)
if (!sessionId) { killTree(); process.exit(1) }

// [4][5] SSE + prompt
const events = []
const sseAbort = new AbortController()
;(async () => {
  const r = await fetch(`${url}/api/event`, { headers: { Authorization: auth }, signal: sseAbort.signal })
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value.replace(/\r\n/g, '\n')
    const chunks = buf.split('\n\n')
    buf = chunks.pop() ?? ''
    for (const c of chunks) {
      const data = c.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s*/, '')).join('\n')
      if (data) { try { events.push(JSON.parse(data)) } catch { } }
    }
  }
})().catch(() => { })
await sleep(300)

const t0 = Date.now()
const marker = `probe-hello-${Date.now()}.txt`
const pr = await fetch(`${url}/api/session/${sessionId}/prompt`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ text: `在工作区里创建 ${marker}（内容 hi），然后只回复两个字：完成。` }),
})
console.log(`[4] prompt HTTP ${pr.status}，delivery = ${(await pr.json().catch(() => null))?.data?.delivery}`)

while (!events.some(e => /^session\.execution\.(succeeded|failed|aborted)/.test(e.type ?? '')) && Date.now() - t0 < 180_000) {
  await sleep(400)
}
await sleep(600)
sseAbort.abort()

// [5] 事件名/字段核查
const expect = {
  'session.execution.started': 'data.sessionID',
  'session.text.ended': 'data.text',
  'session.step.ended': 'data.finish + data.tokens',
  'session.usage.updated': 'data.tokens',
}
console.log('[5] 事件名核查（本回合实际出现）：')
const types = new Set(events.map(e => e.type))
for (const [name, field] of Object.entries(expect)) {
  console.log(`    ${name}（${field}）：${types.has(name) ? '✅' : '（本回合未出现，如引擎异常先查这里）'}`)
}
if (events.some(e => e.type?.startsWith('session.tool.'))) {
  console.log(`    session.tool.*：✅ ${[...types].filter(t => t.startsWith('session.tool.')).join(', ')}`)
}
// [6] 收口
const terminal = events.findLast(e => /^session\.execution\./.test(e.type ?? ''))
console.log(`[6] 收口事件 = ${terminal?.type}`)
const usage = events.findLast(e => e.type === 'session.usage.updated')?.data
console.log(`    usage tokens = ${JSON.stringify(usage?.tokens ?? null)}`)

// 工作区落点核查
const file = probeDir + '\\' + marker
console.log(`[隔离] 产物落在工作区：${existsSync(file) ? '✅' : '❌'} ${existsSync(file) ? '内容=' + JSON.stringify(readFileSync(file, 'utf8')) : ''}`)

killTree()

function killTree() {
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else proc.kill()
  setTimeout(() => process.exit(0), 300)
}
