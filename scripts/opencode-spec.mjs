// opencode 路由表核查工具：带鉴权抓 /openapi.json，列出服务端真实路由与关键 schema
// 用法：node scripts/opencode-spec.mjs（先临时拉起一个 server，抓完即杀）
// 用途：opencode 升级后核对引擎调用的路由是否存在（prompt/interrupt/event/session），
//       以及请求体/响应信封是否漂移。规范全文写到 %TEMP%\opencode-spec\openapi.json
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = 'C:\\Users\\sparky\\AppData\\Local\\Temp\\opencode-spec'
mkdirSync(dir, { recursive: true })

const PW = randomBytes(24).toString('base64url')
const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
  shell: true,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: PW },
})
let out = '', url = null
proc.stdout.on('data', (d) => {
  out += d
  const m = out.match(/(?:opencode\s+)?server\s+listening\s+on\s+(https?:\/\/\S+)/i)
  if (m && !url) url = m[1]
})
await sleep(1800)
if (!url) { console.error('拉起失败：', out.slice(0, 300)); proc.kill(); process.exit(1) }

const auth = `Basic ${Buffer.from('opencode:' + PW).toString('base64')}`
const r = await fetch(url + '/openapi.json', { headers: { Authorization: auth } })
console.log('[spec]', r.status)
if (r.status !== 200) { proc.kill(); process.exit(1) }
const spec = await r.json()

const paths = spec.paths ?? {}
console.log(`共 ${Object.keys(paths).length} 条路径。引擎依赖的关键路由：`)
for (const p of ['/api/session', '/api/session/{sessionID}/prompt', '/api/session/{sessionID}/interrupt', '/api/event']) {
  const node = paths[p]
  console.log(`  ${p}：${node ? Object.keys(node).map(m => m.toUpperCase()).join(',') + ' ✅' : '❌ 不存在（协议漂移！）'}`)
}

// prompt 请求体字段
const promptBody = paths['/api/session/{sessionID}/prompt']?.post?.requestBody?.content?.['application/json']?.schema
if (promptBody) console.log('\nprompt 请求体 schema：', JSON.stringify(promptBody).slice(0, 400))

const file = dir + '\\openapi.json'
writeFileSync(file, JSON.stringify(spec, null, 1))
console.log(`\n规范全文已写入 ${file}`)

if (process.platform === 'win32' && proc.pid) {
  spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
} else proc.kill()
setTimeout(() => process.exit(0), 300)
