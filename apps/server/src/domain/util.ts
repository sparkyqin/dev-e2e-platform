import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 基础工具：id / 时间 / 原子写 / 进程内互斥 */

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}${Date.now().toString(36).slice(-4)}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 原子写文件：tmp + rename，避免半写状态（[机-文件状态机]）；Windows 下 rename 被占用时退避重试。
 * 重试耗尽后如实抛错——绝不退化为非原子直接覆写（半写的真源会让任务静默蒸发，比写失败更糟）。
 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file)
        return
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (attempt >= 8 || (e.code !== 'EPERM' && e.code !== 'EACCES')) throw err
        await sleep(5 + attempt * 10)
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(data, null, 2))
}

/**
 * 读 JSON：文件不存在返回 null（正常缺省）；文件存在但解析失败 = 真源损坏——
 * 抛 CorruptFileError 由调用方显式处置（告警/留痕），绝不静默当作"不存在"。
 */
export class CorruptFileError extends Error {
  constructor(
    public file: string,
    public cause: unknown,
  ) {
    super(`文件损坏（JSON 解析失败）：${file}`)
    this.name = 'CorruptFileError'
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  let txt: string
  try {
    txt = await fs.readFile(file, 'utf8')
  } catch {
    return null // 不存在 = 正常缺省
  }
  try {
    return JSON.parse(txt) as T
  } catch (err) {
    // 损坏现场保全：原文挪到 .corrupt 侧车（不覆盖、可取证、可修复），读取端报错
    try {
      await fs.writeFile(`${file}.corrupt-${Date.now()}`, txt, 'utf8')
    } catch {
      /* 侧车写失败不掩盖主错误 */
    }
    throw new CorruptFileError(file, err)
  }
}

/**
 * 可再生数据（投影/调度配置/令牌/技能库/通知队列等派生缓存）的宽容读取：
 * 损坏按缺省处理（真源 state.json 等必须走 readJson 的响亮语义，别用这个）。
 */
export async function readJsonTolerant<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file)
  } catch {
    return null
  }
}

// ---------- 决策记录（process/decisions.json） ----------
// 契约为数组 [{topic, decision, degraded?, ts}]；真实引擎可能写成
// {schemaVersion, decisions:[{title, decision, decidedAt, ...}]} 包装形态——
// 读取归一化兼容两种形态，追加时保持文件原顶层形态（不破坏引擎产物）。

// ---- 引擎产物形状归一化（读取端防线） ----
// 背景：真实引擎对"数组字段"有三种写法（数组 / 对象映射 / 逗号串），对"记录数组"
// 还可能键值倒置。指令层钉形状（stage-prompts）+ 读取层归一化（此处）双保险，
// 消费端永远拿到声明的形状——不让一个畸形字段杀死整个 worker（task-121 实锤）。

/** 任意值 → string[]：数组取字符串项；字符串整体作一项（splitComma 时按逗号拆）；对象映射取字符串值 */
export function toStringArray(v: unknown, opts?: { splitComma?: boolean }): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return []
    return opts?.splitComma ? s.split(',').map((x) => x.trim()).filter(Boolean) : [s]
  }
  if (typeof v === 'object') return Object.values(v).filter((x): x is string => typeof x === 'string')
  return []
}

/** 任意值 → 记录数组：数组原样过滤；对象映射 {key: record} 展开并入 keyField（record 自带字段优先） */
export function toRecordArray<T extends object>(v: unknown, keyField: string): T[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.filter((x): x is T => !!x && typeof x === 'object' && !Array.isArray(x))
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, val]) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? ({ [keyField]: k, ...(val as object) } as T)
        : ({ [keyField]: k, value: val } as T),
    )
  }
  return []
}

export interface DecisionRecord {
  topic: string
  decision: string
  degraded?: boolean
  ts: string
}

function isDecisionWrapper(raw: unknown): raw is { decisions: Record<string, unknown>[] } {
  return (
    !!raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { decisions?: unknown }).decisions)
  )
}

function normalizeDecisionRecords(raw: unknown): DecisionRecord[] {
  const arr = Array.isArray(raw) ? raw : isDecisionWrapper(raw) ? raw.decisions : null
  if (!arr) return []
  const out: DecisionRecord[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.decision !== 'string') continue
    out.push({
      topic: typeof r.topic === 'string' ? r.topic : typeof r.title === 'string' ? r.title : '',
      decision: r.decision,
      degraded: r.degraded === true,
      ts: typeof r.ts === 'string' ? r.ts : typeof r.decidedAt === 'string' ? r.decidedAt : '',
    })
  }
  return out
}

/** 读决策记录（兼容数组与 {decisions:[...]} 包装） */
export async function readDecisionRecords(file: string): Promise<DecisionRecord[]> {
  return normalizeDecisionRecords(await readJson<unknown>(file))
}

/** 追加一条决策记录：数组形态原样追加；包装形态追加进 decisions 且保留其余字段 */
export async function appendDecisionRecordFile(file: string, record: DecisionRecord): Promise<void> {
  const raw = await readJson<unknown>(file)
  if (isDecisionWrapper(raw)) {
    raw.decisions.push(record as unknown as Record<string, unknown>)
    await writeJson(file, raw)
    return
  }
  const list = normalizeDecisionRecords(raw)
  list.push(record)
  await writeJson(file, list)
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** 进程内异步互斥（按 key 串行化，保证单写者语义）；链空闲即回收（Map 不无限增长） */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      // 链尾且仍是自己 → 回收（等待中的新任务会重新建链，串行语义不变）
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }
}

/** 简单事件总线（SSE 投递用） */
export class EventBus<E> {
  private handlers = new Set<(e: E) => void>()

  on(fn: (e: E) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  emit(e: E): void {
    for (const fn of this.handlers) {
      try {
        fn(e)
      } catch {
        // 订阅方异常不阻断发布
      }
    }
  }
}
