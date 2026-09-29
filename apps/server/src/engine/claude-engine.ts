import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import readline from 'node:readline'
import type { AiEngine, EngineEvent, StageWorkRequest } from './types.js'

/**
 * Claude Code 引擎适配器
 *
 * 通过 Claude Code CLI headless 模式驱动（-p + --output-format stream-json）：
 *  - CLI 解析顺序：本地 node_modules 包二进制 → PATH 上的 claude
 *  - stdin 管道传入指令（避免超长 argv），stdout 逐行解析 JSON 流
 *  - assistant(tool_use) → tool_call；user(tool_result) → tool_result；result → session_ended
 *  - abort → kill 子进程（标记 interrupted，区别于失败）
 */

const require = createRequire(import.meta.url)

function resolveClaudeCli(): string {
  try {
    const pkgPath = require.resolve('@anthropic-ai/claude-code/package.json')
    const bin = path.join(path.dirname(pkgPath), 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    // 桩文件（postinstall 未完成）只有几百字节
    if (existsSync(bin) && (existsSync(bin) ? require('node:fs').statSync(bin).size > 100_000 : false)) return bin
  } catch {
    // 包不存在
  }
  return 'claude'
}

async function cliVersion(cli: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(cli, ['--version'], { shell: process.platform === 'win32' })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(null))
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null))
  })
}

export class ClaudeEngine implements AiEngine {
  id = 'claude'
  label = 'Claude Code 编码代理'

  async available(): Promise<{ ok: boolean; detail: string }> {
    const cli = resolveClaudeCli()
    const version = await cliVersion(cli)
    if (!version) return { ok: false, detail: 'claude CLI 不可用（未安装或未认证）' }
    return { ok: true, detail: `${cli} ${version}（headless stream-json 模式）` }
  }

  async *runStage(req: StageWorkRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const cli = resolveClaudeCli()
    const model = process.env.CLAUDE_MODEL
    const maxTurns = Number(process.env.CLAUDE_MAX_TURNS ?? '40')
    // 默认 acceptEdits（可写文件、不可任意执行命令）；bypassPermissions 仅在显式
    // CLAUDE_ALLOW_BYPASS=true 时允许——需求文本是外部输入，prompt injection 不应直达任意命令
    const permissionMode = process.env.CLAUDE_PERMISSION_MODE ?? 'acceptEdits'
    const allowBypass = process.env.CLAUDE_ALLOW_BYPASS === 'true'

    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose']
    if (model) args.push('--model', model)
    if (maxTurns > 0) args.push('--max-turns', String(maxTurns))
    if (permissionMode === 'bypassPermissions' && allowBypass) {
      args.push('--dangerously-skip-permissions', '--allow-dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', permissionMode)
    }

    const child = spawn(cli, args, {
      cwd: req.workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 下 PATH 解析需要 shell；args 均为安全 token（prompt 经 stdin 传入）
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk' },
    })

    let sessionId = ''
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    // 指令经 stdin 传入（print 模式从 stdin 读 prompt）
    child.stdin.write(req.instruction)
    child.stdin.end()

    const abortHandler = () => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
    signal.addEventListener('abort', abortHandler, { once: true })

    let exitCode: number | null = null
    let ended = false
    const exited = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        exitCode = code
        resolve()
      })
    })

    const rl = readline.createInterface({ input: child.stdout })

    const lineQueue: string[] = []
    let lineResolve: (() => void) | null = null
    rl.on('line', (line) => {
      lineQueue.push(line)
      lineResolve?.()
      lineResolve = null
    })

    try {
      // 逐行消费 stdout JSON 流
      while (true) {
        while (lineQueue.length === 0) {
          if (ended || signal.aborted) break
          await Promise.race([new Promise<void>((r) => (lineResolve = r)), exited.then(() => undefined)])
          if (ended && lineQueue.length === 0) break
        }
        if (lineQueue.length === 0) break
        const line = lineQueue.shift()!
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (ended && msg.type === 'result') {
          continue // 已发过 session_ended（流尾部重复 result 帧），跳过
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id ?? ''
          yield { kind: 'session_started', sessionId }
          continue
        }
        if (msg.type === 'assistant') {
          const content = msg.message?.content ?? []
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              yield { kind: 'assistant_message', text: block.text }
            } else if (block.type === 'tool_use') {
              yield { kind: 'tool_call', callId: block.id ?? '', tool: block.name ?? 'tool', input: safeJson(block.input) }
            }
          }
          continue
        }
        if (msg.type === 'user') {
          const content = msg.message?.content ?? []
          for (const block of content) {
            if (block.type === 'tool_result') {
              const text = typeof block.content === 'string' ? block.content : safeJson(block.content)
              yield {
                kind: 'tool_result',
                callId: block.tool_use_id ?? '',
                tool: 'tool',
                ok: !block.is_error,
                summary: text.slice(0, 200),
              }
            }
          }
          continue
        }
        if (msg.type === 'result') {
          ended = true
          const usage = msg.usage ? { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 } : undefined
          if (msg.is_error) {
            yield { kind: 'session_ended', reason: 'failed', summary: String(msg.result ?? '执行出错').slice(0, 300), usage }
          } else {
            yield { kind: 'session_ended', reason: 'completed', summary: String(msg.result ?? 'Claude Code 阶段作业完成').slice(0, 300), usage }
          }
          child.kill()
          break
        }
        if (msg.type === 'stream_event' || msg.type === 'system') {
          // 细粒度增量事件：忽略（上层已有 assistant/tool 聚合）
          continue
        }
      }
      // 流结束但未见 result（如被中断/超时）
      if (!ended) {
        await exited
        if (signal.aborted) {
          yield { kind: 'session_ended', reason: 'interrupted', summary: '被人中断（via=interrupt）' }
        } else {
          yield {
            kind: 'session_ended',
            reason: exitCode === 0 ? 'completed' : 'failed',
            summary: exitCode === 0 ? 'Claude Code 阶段作业完成' : `进程退出码 ${exitCode}${stderr ? `：${stderr.slice(-200)}` : ''}`,
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler)
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
  }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x) ?? ''
  } catch {
    return String(x)
  }
}
