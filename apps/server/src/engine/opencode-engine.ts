import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { AiEngine, EngineEvent, StageWorkRequest } from './types.js'

/**
 * OpenCode 引擎适配器（[机-自动迭代/无人值守]）
 *
 * 直连 opencode v2.0.x HTTP API（不经 @opencode-ai/sdk——实测 1.18.x SDK 的路由表与
 * opencode v2.0.18 不匹配：SDK prompt 走 /message 而服务端只有 /prompt，abort 路由不存在）。
 *
 * 实测协议事实（opencode v2.0.18）：
 *  - serve 就绪行「server listening on <url>」（旧版「opencode server listening」两代都认）
 *  - API 挂 /api/* 且强制 Basic 鉴权：Authorization: Basic base64("opencode:" + 口令)。
 *    口令 = 拉起时注入的 OPENCODE_SERVER_PASSWORD（自选随机值，不依赖 stdout 解析）
 *  - 会话绑定服务端 cwd：create 时 location[directory] / x-opencode-directory 头一律不生效
 *    → 工作区隔离 = 每个阶段作业自起一个以任务工作区为 cwd 的临时 server（--port=0），
 *      回合结束整树杀掉（Windows 用 taskkill /T，防 shell 垫片留孤儿 bun 进程）
 *  - prompt 为异步投递：POST /session/{id}/prompt {text}（v2 无 system 字段→规则拼进 text），
 *    立即返回用户消息（delivery=steer|queue），AI 产出全部走 GET /event SSE
 *  - 事件信封 {id, type, data}；回合收口 = session.execution.succeeded/failed/aborted
 *  - 中断 = POST /session/{id}/interrupt（不是旧 API 的 abort）
 *  - 远程模式 OPENCODE_HOST/OPENCODE_KEY：可连接，但会话跑在远端 server 自己的项目目录
 *    （v2.0.18 限制），仅适合同机自管 server 的场景
 *
 * 作业纪律（对齐 mae-flow-cloud sessionDriver）：
 *  - 空回合≠完成：收口成功但无文本且无工具 → 如实报失败（不编造完成）
 *  - busy collision（prompt 409）：退避 250ms 单次重投，不自愈循环
 *  - abort 先竖旗再收束；server 意外退出/事件流断开 → 带最近输出的诊断性报错
 */

type AnyRecord = Record<string, any>

const SYSTEM_PROMPT = [
  '你是「需求到代码合入」平台的阶段执行引擎，负责在当前工作区内完成指定阶段的作业。',
  '规则：',
  '1. 只在当前工作区内读写文件；不要执行任何 git 命令（平台是唯一写动作归属，统一管理版本）。',
  '2. 按指令把产物写到指定路径；过程草稿写 process/，交付物写 delivery/。',
  '3. 完成后把结构化结果写入 .flow/stage-output.json（严格按指令中给出的字段）。',
  '4. 不编造事实：跑不了的命令如实报告失败；文件不存在就说不存在。',
].join('\n')

const BUSY_RETRY_MS = 250
const HTTP_TIMEOUT_MS = 15_000
/** prompt 投递后首个本会话事件的最长等待（超时≈事件流未接通/鉴权或模型配置异常） */
const FIRST_EVENT_TIMEOUT_MS = 60_000
const NEVER: Promise<string> = new Promise(() => {})

interface LocalServer {
  url: string
  password: string
  /** 进程意外退出时 resolve（回合内监护；正常 close 后触发无副作用） */
  exited: Promise<string>
  close(): void
}

export class OpenCodeEngine implements AiEngine {
  id = 'opencode'
  label = 'OpenCode 编码代理'

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const p = spawn('opencode', ['--version'], { shell: process.platform === 'win32' })
        let out = ''
        p.stdout?.on('data', (d) => (out += d))
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))))
      })
      // 「opencode --version」输出形如「opencode v2.0.18」——宽松提取 semver 判主版本
      const ver = raw.match(/(\d+)\.(\d+)\.(\d+)/)
      if (!ver || ver[1] !== '2') {
        return { ok: false, detail: `opencode ${raw}：需要 v2.0.x（/api + Basic 鉴权协议）` }
      }
      const mode = process.env.OPENCODE_HOST
        ? `远程直连 ${process.env.OPENCODE_HOST}（会话跑在远端 server 的项目目录）`
        : '每作业自起临时 server（工作区级隔离）'
      return { ok: true, detail: `opencode v${ver[0]}（${mode}）` }
    } catch (e) {
      return { ok: false, detail: `opencode CLI 不可用：${(e as Error).message}` }
    }
  }

  async *runStage(req: StageWorkRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    // ── 0. server：远程直连 或 每作业临时 server（cwd=任务工作区） ──
    let base: string
    let authHeader: string
    let server: LocalServer | null = null
    if (process.env.OPENCODE_HOST) {
      base = normalizeApiBase(process.env.OPENCODE_HOST)
      authHeader = basicAuth(process.env.OPENCODE_KEY ?? '')
    } else {
      try {
        server = await launchLocalServer(req.workspaceDir)
      } catch (e) {
        yield { kind: 'session_ended', reason: 'failed', summary: `OpenCode server 拉起失败：${(e as Error).message}` }
        return
      }
      base = `${server.url}/api`
      authHeader = basicAuth(server.password)
    }

    const sse = new AbortController()
    const serverExit = server ? server.exited : NEVER

    try {
      // ── 1. 建会话（本地模式：server cwd 即任务工作区，天然隔离） ──
      const createRes = await httpJson(`${base}/session`, {
        method: 'POST',
        headers: jsonHeaders(authHeader),
        body: JSON.stringify({ title: `[${req.taskId}] ${req.job}` }),
      })
      if (!createRes.ok || !createRes.json?.data?.id) {
        yield {
          kind: 'session_ended',
          reason: 'failed',
          summary: `会话创建失败：HTTP ${createRes.status} ${authHint(createRes.status, createRes.bodyText)}`,
        }
        return
      }
      const sessionId: string = createRes.json.data.id
      yield { kind: 'session_started', sessionId }

      // ── 2. 先订事件流（内部缓冲），再投 prompt，避免错过早发事件 ──
      const sub = subscribeEvents(base, authHeader, sse.signal)
      const promptText = `${SYSTEM_PROMPT}\n\n---\n\n${req.instruction}`
      const promptRes = await postPrompt(base, authHeader, sessionId, promptText)
      if (!promptRes.ok) {
        yield {
          kind: 'session_ended',
          reason: 'failed',
          summary: `prompt 投递失败：HTTP ${promptRes.status} ${authHint(promptRes.status, promptRes.bodyText)}`,
        }
        return
      }

      // ── 3. 消费事件直到回合收口 ──
      const toolNames = new Map<string, string>()
      let sawText = false
      let sawTool = false
      let sawFirstEvent = false
      let lastFinish: string | null = null
      let usage: { input: number; output: number } | undefined
      let terminal: { type: string; data: AnyRecord } | null = null
      let loopError: string | null = null

      const abortP = new Promise<'ABORT'>((resolve) => {
        if (signal.aborted) resolve('ABORT')
        else signal.addEventListener('abort', () => resolve('ABORT'), { once: true })
      })
      const firstDeadline = new Promise<'FIRST_TIMEOUT'>((resolve) => {
        setTimeout(() => resolve('FIRST_TIMEOUT'), FIRST_EVENT_TIMEOUT_MS)
      })

      while (!terminal && !loopError) {
        const racers: Array<Promise<unknown>> = [sub.next, abortP, serverExit]
        if (!sawFirstEvent) racers.push(firstDeadline)
        const ev = (await Promise.race(racers)) as SseEvent | 'DONE' | 'ABORT' | 'FIRST_TIMEOUT' | string
        if (ev === 'ABORT') break
        if (ev === 'FIRST_TIMEOUT') {
          loopError = `${FIRST_EVENT_TIMEOUT_MS / 1000}s 内未收到任何本会话事件（事件流未接通，或鉴权/模型配置异常）`
          break
        }
        if (ev === 'DONE') {
          loopError = `事件流提前断开${sub.error ? `：${sub.error.message}` : '（未收到回合收口事件）'}`
          break
        }
        if (typeof ev === 'string') {
          loopError = ev // server 意外退出（带诊断文案）
          break
        }

        const type: string = ev.type ?? ''
        if (!type.startsWith('session.')) continue
        const data = (ev.data ?? {}) as AnyRecord
        if (typeof data.sessionID === 'string' && data.sessionID !== sessionId) continue
        sawFirstEvent = true

        if (type === 'session.text.ended') {
          sawText = true
          if (typeof data.text === 'string' && data.text.trim()) {
            yield { kind: 'assistant_message', text: data.text }
          }
        } else if (type === 'session.tool.input.started') {
          if (data.id && data.name) toolNames.set(String(data.id), String(data.name))
        } else if (type === 'session.tool.called') {
          sawTool = true
          const id = String(data.id ?? '')
          yield { kind: 'tool_call', callId: id, tool: toolNames.get(id) ?? 'unknown', input: safeJson(data.input) }
        } else if (type === 'session.tool.success') {
          const id = String(data.id ?? '')
          yield {
            kind: 'tool_result',
            callId: id,
            tool: toolNames.get(id) ?? 'unknown',
            ok: true,
            summary: firstTextOf(data.content).slice(0, 200) || 'ok',
          }
        } else if (type === 'session.tool.error') {
          const id = String(data.id ?? '')
          yield {
            kind: 'tool_result',
            callId: id,
            tool: toolNames.get(id) ?? 'unknown',
            ok: false,
            summary: String(data.error ?? data.message ?? safeJson(data)).slice(0, 200),
          }
        } else if (type === 'session.step.ended') {
          if (data.finish) lastFinish = String(data.finish)
        } else if (type === 'session.usage.updated') {
          const t = data.tokens
          if (t && typeof t.input === 'number') usage = { input: t.input ?? 0, output: t.output ?? 0 }
        } else if (/^session\.execution\.(succeeded|failed|aborted|ended)$/.test(type)) {
          terminal = { type, data }
        }
      }

      // ── 4. 收口（先判中断，再判诚实结果） ──
      if (signal.aborted || terminal?.type === 'session.execution.aborted') {
        if (!terminal) await tryInterrupt(base, authHeader, sessionId)
        yield { kind: 'session_ended', reason: 'interrupted', summary: '被人中断（via=interrupt）' }
        return
      }
      if (loopError) {
        yield { kind: 'session_ended', reason: 'failed', summary: loopError }
        return
      }
      if (!terminal) {
        await tryInterrupt(base, authHeader, sessionId)
        yield { kind: 'session_ended', reason: 'failed', summary: '回合未收口（事件流停止且无终态事件）' }
        return
      }
      if (terminal.type === 'session.execution.succeeded') {
        if (!sawText && !sawTool) {
          yield { kind: 'session_ended', reason: 'failed', summary: '模型零产出（空回合）：回合成功结束但无任何文本与工具调用' }
          return
        }
        const finish = lastFinish ? `（finish=${lastFinish}）` : ''
        yield { kind: 'session_ended', reason: 'completed', summary: `OpenCode 阶段作业完成${finish}`, usage }
        return
      }
      const detail = String(terminal.data.error ?? terminal.data.message ?? safeJson(terminal.data)).slice(0, 300)
      yield { kind: 'session_ended', reason: 'failed', summary: `执行失败：${terminal.type} ${detail}` }
    } finally {
      sse.abort()
      server?.close()
    }
  }
}

// ─────────────────────────── server 拉起与收杀 ───────────────────────────

/** 拉起以 workspaceDir 为 cwd 的临时 server：v2 会话绑定服务端 cwd，这是工作区隔离的根基 */
function launchLocalServer(workspaceDir: string): Promise<LocalServer> {
  const password = randomBytes(24).toString('base64url')
  const timeoutMs = Number(process.env.OPENCODE_START_TIMEOUT ?? 30_000)
  return new Promise<LocalServer>((resolve, reject) => {
    const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
      shell: process.platform === 'win32', // Windows 下 opencode 是 .cmd/.ps1 垫片，需 shell 拉起
      cwd: workspaceDir,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      windowsHide: true,
    })
    let out = ''
    let url: string | null = null
    let settled = false

    const stop = (): void => killTree(proc)
    const finishOk = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ url: url!, password, exited, close: stop })
    }
    const finishErr = (msg: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(new Error(msg))
    }
    const timer = setTimeout(() => {
      finishErr(
        `opencode serve ${timeoutMs}ms 内未就绪。最近输出：${tailOf(out)}。` +
          `排查：手工运行「opencode serve」看报错；或调 OPENCODE_START_TIMEOUT`,
      )
    }, timeoutMs)

    // 意外退出监护：拉起期 → reject；回合期 → 由 runStage 竞争消费
    const exited = new Promise<string>((resolveExit) => {
      proc.on('exit', (code) => {
        const msg = `opencode serve 意外退出（code=${code}）。最近输出：${tailOf(out)}`
        resolveExit(msg)
        finishErr(msg)
      })
    })

    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      if (!url) {
        // v2.0.x「server listening on <url>」/ 旧版「opencode server listening on <url>」两代都认
        const m = out.match(/(?:opencode\s+)?server\s+listening\s+on\s+(https?:\/\/\S+)/i)
        if (m) url = m[1]
      }
      // 口令来自 env 注入（确定性），无需等 stdout 口令行 → 见 URL 即就绪
      if (url) finishOk()
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    proc.on('error', (e) => finishErr(`opencode 进程拉起失败：${e.message}（PATH 里无 opencode？）`))
  })
}

/** Windows shell 垫片下只杀 cmd 会留孤儿 bun 进程，必须整树杀 */
function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else if (!proc.killed) {
      proc.kill('SIGTERM')
    }
  } catch {
    /* 已退出 */
  }
}

// ─────────────────────────── HTTP 与 SSE ───────────────────────────

interface HttpResult {
  ok: boolean
  status: number
  bodyText: string
  json: AnyRecord | null
}

async function httpJson(url: string, init: RequestInit): Promise<HttpResult> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const raw = await res.text().catch(() => '')
  let json: AnyRecord | null = null
  try {
    json = JSON.parse(raw)
  } catch {
    /* 非 JSON 响应体 */
  }
  return { ok: res.ok, status: res.status, bodyText: raw.slice(0, 300) || '(空响应体)', json }
}

async function postPrompt(base: string, authHeader: string, sessionId: string, text: string): Promise<HttpResult> {
  const url = `${base}/session/${sessionId}/prompt`
  const init: RequestInit = { method: 'POST', headers: jsonHeaders(authHeader), body: JSON.stringify({ text }) }
  let res = await httpJson(url, init)
  if (res.status === 409) {
    // busy collision：退避单次重投（自愈是纠偏不是永动机）
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS))
    res = await httpJson(url, init)
  }
  return res
}

async function tryInterrupt(base: string, authHeader: string, sessionId: string): Promise<void> {
  try {
    await fetch(`${base}/session/${sessionId}/interrupt`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    /* 会话已结束 / server 已死：整树收杀兜底 */
  }
}

type SseEvent = { id?: string; type?: string; data?: AnyRecord }

/** SSE 订阅：立即连接并内部缓冲（避免 prompt 与订阅间的丢事件窗口） */
function subscribeEvents(
  base: string,
  authHeader: string,
  signal: AbortSignal,
): { next: Promise<SseEvent | 'DONE'>; error: Error | null } {
  const queue: Array<SseEvent | 'DONE'> = []
  const waiters: Array<(v: SseEvent | 'DONE') => void> = []
  let done = false
  let error: Error | null = null
  const push = (ev: SseEvent | 'DONE'): void => {
    const w = waiters.shift()
    if (w) w(ev)
    else queue.push(ev)
  }

  void (async () => {
    try {
      const res = await fetch(`${base}/event`, { headers: { Authorization: authHeader }, signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { done: rdDone, value } = await reader.read()
        if (rdDone) break
        buf += value.replace(/\r\n/g, '\n')
        for (;;) {
          const idx = buf.indexOf('\n\n')
          if (idx === -1) break
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data:\s*/, ''))
            .join('\n')
          if (!data) continue
          try {
            push(JSON.parse(data) as SseEvent)
          } catch {
            /* 跳过坏帧 */
          }
        }
      }
    } catch (e) {
      if (!signal.aborted) error = e as Error
    } finally {
      done = true
      while (waiters.length) waiters.shift()!('DONE')
    }
  })()

  return {
    get next(): Promise<SseEvent | 'DONE'> {
      if (queue.length) return Promise.resolve(queue.shift()!)
      if (done) return Promise.resolve('DONE')
      return new Promise((resolve) => waiters.push(resolve))
    },
    get error(): Error | null {
      return error
    },
  }
}

// ─────────────────────────── 小工具 ───────────────────────────

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

function jsonHeaders(authHeader: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: authHeader }
}

function authHint(status: number, bodyText: string): string {
  if (status === 401) return `${bodyText}（鉴权失败：检查 OPENCODE_KEY / OPENCODE_SERVER_PASSWORD）`
  return bodyText
}

function normalizeApiBase(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`
}

function firstTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && typeof c === 'object' && (c as AnyRecord).type === 'text' && typeof (c as AnyRecord).text === 'string') {
      return (c as AnyRecord).text as string
    }
  }
  return ''
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x) ?? ''
  } catch {
    return String(x)
  }
}

function tailOf(s: string, n = 300): string {
  const t = s.trim()
  return t.length > n ? '…' + t.slice(-n) : t || '(无输出)'
}
