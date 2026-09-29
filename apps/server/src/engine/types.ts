import type { StageId } from '@ai-platform/shared'

/**
 * AI 引擎抽象（L3 能力插件 · 编码代理引擎）
 *
 * 平台内核（状态机/门禁/产物/调度）不依赖具体引擎；引擎只负责「干一个阶段的活」：
 * 在任务工作区内按指令产出产物与结构化输出（.flow/stage-output-{job}.json），过程以事件流形式吐出。
 * 实现：OpenCodeEngine / ClaudeEngine / SimulatedEngine。
 */

/**
 * 结构化输出按作业分文件（.flow/stage-output-{job}.json）：
 * 双轨并行（code ∥ 测试轨）时多个作业同时在跑，单文件单写者会互相覆盖。
 * 旧版单文件 stage-output.json 仍可读（升级兼容 in-flight 任务），写入一律走 per-job。
 */
export function stageOutputPath(job: string): string {
  return `.flow/stage-output-${job}.json`
}

export type EngineEvent =
  | { kind: 'session_started'; sessionId: string }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'tool_call'; callId: string; tool: string; input: string }
  | { kind: 'tool_result'; callId: string; tool: string; ok: boolean; summary: string }
  | {
      kind: 'session_ended'
      reason: 'completed' | 'interrupted' | 'failed'
      summary: string
      usage?: { input: number; output: number }
    }

export interface StageWorkRequest {
  taskId: string
  stage: StageId
  /** 阶段标识（如 verify-review / verify-critic / build / test 等子作业） */
  job: string
  /** 渲染后的完整指令（含注入知识与上下文说明） */
  instruction: string
  /** 任务工作区根（引擎工作目录） */
  workspaceDir: string
  /** 演示剧本：clean | flaky-tool | build-fail | feedback-loop */
  scenario: 'clean' | 'flaky-tool' | 'build-fail' | 'feedback-loop'
  /** 本轮修复指令（写/修双模式：修复模式带失败上下文） */
  fixDirectives: string[]
  /** 任务上下文变量（模拟引擎剧本渲染 / 真实引擎已插值进 instruction） */
  vars: Record<string, string>
}

export interface AiEngine {
  id: string
  label: string
  available(): Promise<{ ok: boolean; detail: string }>
  /** 执行一个阶段作业；事件以异步迭代器吐出；abort 时尽快收敛并结束 */
  runStage(req: StageWorkRequest, signal: AbortSignal): AsyncIterable<EngineEvent>
}

/** 各阶段结构化输出（.flow/stage-output.json 的可能形态；引擎按 job 写对应字段） */
export interface StageOutput {
  // intake
  baselineReady?: boolean
  // clarify
  factQuestions?: {
    question: string
    digest: string
    preface: string
    context: string
    assumedAnswer: string
    materials: string[]
  }[]
  atomicsSummary?: string
  // architecture
  architectureReady?: boolean
  // design
  specReady?: boolean
  // test-design
  testDesignReady?: boolean
  // ar-split（执行段 AR 并行拆分）
  arSplitReady?: boolean
  arItems?: {
    title: string
    summary: string
    acceptance?: string
  }[]
  // code
  claimedFiles?: string[]
  done?: boolean
  summary?: string
  // ar-design（AR 级设计摘要）
  arDesignReady?: boolean
  // 测试轨：test-case-design / auto-case-design / auto-case-generate
  testCasesReady?: boolean
  autoCasesReady?: boolean
  files?: string[]
  // verify-review
  verdict?: 'PASS' | 'WARN' | 'FAIL'
  findings?: string[]
  dispatchId?: string
  // verify-critic
  dispatchIds?: string[]
  // build / test
  ok?: boolean
  log?: string
  cases?: number
}

export async function* single<T>(...items: T[]): AsyncIterable<T> {
  for (const it of items) yield it
}

export async function collectStream(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}
