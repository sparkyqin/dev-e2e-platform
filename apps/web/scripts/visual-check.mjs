/**
 * 无头浏览器目检（零依赖：Node≥22 原生 WebSocket + 本机 Edge CDP）：
 *   node scripts/visual-check.mjs [taskId] [loginUserId]
 *
 * 为什么需要它：ssr-check 只验证 HTML 结构正确，验证不了「CSS 在特定视口下的真实布局」——
 * 双栏重构时 ≤1280px 媒体查询残留旧三栏规则，主栏被挤进 260px、右栏落中间、最右空列，
 * SSR/typecheck 全绿也测不出来。本脚本用无头 Edge 真渲染，1280/1600/1000 三档视口各截一图，
 * 并输出布局诊断（网格轨道 / 元素矩形 / 面板清单 / JS 异常），产物在系统临时目录。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const taskId = process.argv[2] ?? 'task-124'
const loginUser = process.argv[3] ?? 'zhaolei'
const OUT = process.env.OUT_DIR ?? join(tmpdir(), 'ai-platform-look')
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(process.env.CDP_PORT ?? 9333)
const BASE = process.env.APP_URL ?? 'http://localhost:5173'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${OUT}/edge-profile`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-extensions', '--disable-sync', '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page')
  } catch {}
  if (!target) await sleep(250)
}
if (!target) { console.error('FAIL: CDP target not found (Edge 起来了吗？)'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws fail'))) })

let mid = 0
const pending = new Map()
const exceptions = []
const logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text)
})
const send = (method, params = {}) => new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const d = r.result
  if (d?.exceptionDetails) return { __exc: d.exceptionDetails.exception?.description ?? d.exceptionDetails.text }
  return d?.result?.value
}
const until = async (expr, timeoutMs = 15000) => {
  const dl = Date.now() + timeoutMs
  while (Date.now() < dl) {
    if ((await evalJS(expr)) === true) return true
    await sleep(300)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

const diag = { taskId, steps: [] }
const shot = async (name, opts = {}) => {
  const r = await send('Page.captureScreenshot', { format: 'png', ...opts })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  diag.steps.push('saved ' + name)
}
const setViewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

// 登录（demo-login 同源 fetch 自动落 cookie）→ 整页跳转任务
await setViewport(1280, 860)
await send('Page.navigate', { url: `${BASE}/` })
await until("document.readyState === 'complete'")
await sleep(600)
diag.login = await evalJS(`(async () => {
  const r = await fetch('/api/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '${loginUser}' }) })
  return r.status + ' ' + (await r.text()).slice(0, 120)
})()`)
await send('Page.navigate', { url: 'about:blank' })
await until("document.readyState === 'complete'")
await send('Page.navigate', { url: `${BASE}/#/task/${taskId}` })
await until("document.readyState === 'complete'")
diag.railAppeared_1280 = await until("!!document.querySelector('.col-rail') && !!document.querySelector('.col-rail .sidebar')", 20000)
await sleep(1200)

const railProbe = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const cols = document.querySelector('.task-cols'); const rail = document.querySelector('.col-rail'); const mid = document.querySelector('.col-mid')
  if (!cols) return { error: 'no .task-cols (登录失败？非任务页？)' }
  // 两段分组横幅（设计段/执行段）：看板列分组（紧凑条已随 hero 移除，业务流收口看板页签）
  const stripResidue = document.querySelectorAll('.pipe-compact').length
  const boardGroups = [...document.querySelectorAll('.pipeline-board .pipe-col-group')].map((g) => ({
    cls: g.className,
    label: g.querySelector('.pipe-col-group-label')?.textContent,
    cols: g.querySelectorAll('.pipe-col').length,
  }))
  return {
    viewport: innerWidth + 'x' + innerHeight,
    grid: getComputedStyle(cols).gridTemplateColumns,
    mid: r(mid), rail: r(rail),
    stripResidue,
    boardGroups,
    boardGroupCount: boardGroups.length,
    boardColTotal: boardGroups.reduce((a, g) => a + g.cols, 0),
    railScrollHeight: rail ? rail.scrollHeight : null,
    railPanels: [...document.querySelectorAll('.col-rail .panel h3')].map((h) => h.textContent),
    gateCard: !!document.querySelector('.col-rail .gate-card'),
    railTextHead: (rail?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  }
})()`

diag.view_1280 = await evalJS(railProbe)
await shot(`look-${taskId}-1280`)

await setViewport(1600, 900)
await sleep(800)
diag.view_1600 = await evalJS(railProbe)
await shot(`look-${taskId}-1600`)

await setViewport(1000, 900)
await sleep(800)
diag.view_1000 = await evalJS(railProbe)
await shot(`look-${taskId}-1000`, { captureBeyondViewport: true })

diag.exceptions = exceptions
diag.consoleErrors = logs
writeFileSync(join(OUT, `look-${taskId}-diag.json`), JSON.stringify(diag, null, 1))
spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
await sleep(800)
console.log(`DONE: ${OUT}/look-${taskId}-*.png + -diag.json`)
if (exceptions.length) console.log(`!! ${exceptions.length} 个页面异常，见 diag`)
