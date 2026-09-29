import type { AiEngine } from './types.js'
import { SimulatedEngine } from './simulated-engine.js'
import { OpenCodeEngine } from './opencode-engine.js'
import { ClaudeEngine } from './claude-engine.js'

/**
 * 引擎管理器（L3 能力插拔）
 *
 * AI_ENGINE=auto|opencode|claude|simulated（env）
 * auto：按可用性探测顺序选择（opencode → claude → simulated）。
 * 每任务固定 engineId；引擎不可用时任务健康降级并升级通知（fail-closed，不静默混跑）。
 */
export class EngineManager {
  private engines = new Map<string, AiEngine>()
  private probeCache: { id: string; ok: boolean; detail: string }[] | null = null

  constructor() {
    const sim = new SimulatedEngine()
    const oc = new OpenCodeEngine()
    const cc = new ClaudeEngine()
    for (const e of [sim, oc, cc]) this.engines.set(e.id, e)
  }

  list(): AiEngine[] {
    return [...this.engines.values()]
  }

  get(id: string): AiEngine {
    return this.engines.get(id) ?? this.engines.get('simulated')!
  }

  /** 探测可用性（带缓存，供 /api/config 与日志展示） */
  async probe(): Promise<{ id: string; ok: boolean; detail: string }[]> {
    if (this.probeCache) return this.probeCache
    const out: { id: string; ok: boolean; detail: string }[] = []
    for (const e of this.engines.values()) {
      try {
        const r = await e.available()
        out.push({ id: e.id, ok: r.ok, detail: r.detail })
      } catch (err) {
        out.push({ id: e.id, ok: false, detail: (err as Error).message })
      }
    }
    this.probeCache = out
    return out
  }

  /** 默认引擎（auto 探测 / 显式指定） */
  async defaultEngineId(): Promise<string> {
    const wanted = (process.env.AI_ENGINE ?? 'auto').trim()
    if (wanted !== 'auto' && this.engines.has(wanted)) return wanted
    for (const p of await this.probe()) {
      if (p.id === 'simulated') continue
      if (p.ok) return p.id
    }
    return 'simulated'
  }
}
