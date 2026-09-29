import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { StageId } from '@ai-platform/shared'
import { newId, readJsonTolerant, toRecordArray, toStringArray } from '../domain/util.js'
import type { StageOutput } from '../engine/types.js'
import type { AiEngine } from '../engine/types.js'
import { stageOutputPath } from '../engine/types.js'
import { renderInstruction } from '../engine/stage-prompts.js'
import type { Platform } from './platform.js'
import type { TaskState } from '@ai-platform/shared'

/**
 * 引擎会话执行器：
 *  - 渲染阶段指令 → 引擎 runStage → 语义事件流映射落盘
 *  - 健康监测：连续工具报错 / token 预算（[机-健康徽标]）
 *  - 中断：platform 持有任务级 AbortController（takeover → abortAuxiliarySessions 语义）
 *  - 产出裁决：只读 .flow/stage-output.json（文件证据），不信口头自报
 */

export interface RunEngineOpts {
  vars?: Record<string, string>
  fixDirectives?: string[]
  injectedKnowledge?: string
  purpose: string
}

export interface RunEngineResult {
  output: StageOutput
  completed: boolean
  interrupted: boolean
  failed: boolean
  failureSummary?: string
}

export async function runEngine(platform: Platform, state: TaskState, job: string, opts: RunEngineOpts): Promise<RunEngineResult> {
  const engine: AiEngine = platform.engines.get(state.engineId)
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const actor = { type: 'ai' as const, engine: engine.id, name: engine.label }
  const stage: StageId = state.stage

  const instruction = renderInstruction({
    task: { title: state.title, requirementText: state.requirementText, module: state.module, repo: state.repo, mode: state.mode },
    stage,
    job,
    injectedKnowledge: opts.injectedKnowledge ?? '',
    fixDirectives: opts.fixDirectives ?? [],
    vars: opts.vars ?? {},
    playbook: platform.playbooks.get(state.playbookId),
  })

  // 任务级中断信号（takeover 时 abort）
  const signal = platform.acquireSessionSignal(taskId)

  let completed = false
  let interrupted = false
  let failed = false
  let failureSummary: string | undefined
  let consecutiveErrors = 0
  let assistantText = ''

  await log.append(taskId, stage, actor, 'session_started', {
    sessionId: `eng-${newId('s')}`,
    engine: engine.id,
    autonomy: state.autonomy,
    purpose: opts.purpose,
  })

  if (opts.fixDirectives?.length) {
    await log.append(taskId, stage, { type: 'human' as const, userId: state.people.owner.userId, name: state.people.owner.name }, 'user_message', {
      text: `修复指令：\n${opts.fixDirectives.map((d) => `- ${d}`).join('\n')}`,
      source: 'instruction',
    })
  }

  try {
    for await (const ev of engine.runStage(
      {
        taskId,
        stage,
        job,
        instruction,
        workspaceDir: platform.store.taskDir(taskId),
        scenario: state.scenario,
        fixDirectives: opts.fixDirectives ?? [],
        vars: opts.vars ?? {},
      },
      signal,
    )) {
      switch (ev.kind) {
        case 'session_started':
          break
        case 'assistant_message':
          assistantText = ev.text
          await log.append(taskId, stage, actor, 'assistant_message', { text: ev.text })
          break
        case 'tool_call':
          await log.append(taskId, stage, actor, 'tool_call', { callId: ev.callId, tool: ev.tool, input: ev.input })
          break
        case 'tool_result':
          consecutiveErrors = ev.ok ? 0 : consecutiveErrors + 1
          await log.append(taskId, stage, actor, 'tool_result', { callId: ev.callId, tool: ev.tool, ok: ev.ok, summary: ev.summary })
          // 健康监测：连续 3 次报错 → 黄（主动叫人）；≥6 → 红（预算保护，中断会话）
          if (consecutiveErrors === 3 || consecutiveErrors >= 6) {
            await platform.updateHealth(taskId, { consecutiveToolErrors: consecutiveErrors })
          }
          break
        case 'session_ended': {
          completed = ev.reason === 'completed'
          interrupted = ev.reason === 'interrupted'
          failed = ev.reason === 'failed'
          failureSummary = ev.summary
          await log.append(taskId, stage, actor, 'session_ended', { sessionId: 'eng', reason: ev.reason, summary: ev.summary })
          if (ev.usage) {
            await platform.addTokenUsage(taskId, ev.usage)
          }
          break
        }
      }
      if (signal.aborted) break
    }
  } catch (err) {
    failed = true
    failureSummary = (err as Error).message
    await log.append(taskId, stage, actor, 'session_ended', { sessionId: 'eng', reason: 'failed', summary: failureSummary })
  }

  if (signal.aborted && !interrupted) {
    interrupted = true
    failed = false
    await log.append(taskId, stage, actor, 'session_ended', { sessionId: 'eng', reason: 'interrupted', summary: '被人中断（via=interrupt）' })
  }

  // 产出裁决：读文件证据（形状归一化后再交消费端——指令钉形状 + 读取兜底双保险）。
  // 引擎写的文件宽容读取（损坏≈无产出 → 走重试/失败语义，不让坏 JSON 直接崩 worker）
  // per-job 优先；旧版单文件兜底（升级时 in-flight 任务可能仍写旧路径）
  const raw =
    (await readJsonTolerant<StageOutput>(path.join(platform.store.flowDir(taskId), '..', stageOutputPath(job)))) ??
    (await readJsonTolerant<StageOutput>(path.join(platform.store.flowDir(taskId), 'stage-output.json')))
  const output = normalizeStageOutput(raw)

  return { output, completed, interrupted, failed, failureSummary }
}

/**
 * stage-output.json 形状归一化：真实引擎可能把数组字段写成对象映射/逗号串、
 * 或漏嵌套字段（decisions.json / api-contract.json 同款病）。此处统一成
 * StageOutput 声明的形状，worker 只面对契约——畸形字段降级为空值/占位，
 * 不再以 TypeError 杀死整个阶段（task-121：interfaces.map is not a function）。
 * 导出供回归测试钉死各形态兼容（shape-contracts.test.ts）。
 */
export function normalizeStageOutput(raw: StageOutput | null): StageOutput {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as unknown as Record<string, unknown>
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : x == null ? undefined : String(x))
  const out: Record<string, unknown> = { ...r }

  if (r.factQuestions != null) {
    out.factQuestions = toRecordArray<Record<string, unknown>>(r.factQuestions, 'question').map((q) => ({
      question: str(q.question) ?? '（引擎未给出问题文本）',
      digest: str(q.digest) ?? '',
      preface: str(q.preface) ?? '',
      context: str(q.context) ?? '',
      assumedAnswer: str(q.assumedAnswer) ?? '',
      materials: toStringArray(q.materials),
    }))
  }
  if (r.atomicsSummary != null) out.atomicsSummary = str(r.atomicsSummary) ?? ''
  if (r.arItems != null) {
    out.arItems = toRecordArray<Record<string, unknown>>(r.arItems, 'title').map((it) => ({
      title: str(it.title) ?? '未命名原子项',
      summary: str(it.summary) ?? '',
      acceptance: str(it.acceptance),
    }))
  }
  if (r.claimedFiles != null) out.claimedFiles = toStringArray(r.claimedFiles)
  if (r.findings != null) out.findings = toStringArray(r.findings)
  if (r.files != null) out.files = toStringArray(r.files)
  if (r.dispatchIds != null) out.dispatchIds = toStringArray(r.dispatchIds, { splitComma: true })
  if (r.verdict != null) out.verdict = str(r.verdict)
  if (r.summary != null) out.summary = str(r.summary)
  if (r.log != null) out.log = str(r.log)

  return out as StageOutput
}

/** 读 stage-output 后清理（避免下一轮误读旧产出；per-job + 旧版单文件一并清） */
export async function clearStageOutput(platform: Platform, taskId: string, job?: string): Promise<void> {
  const files = job
    ? [path.join(platform.store.flowDir(taskId), '..', stageOutputPath(job))]
    : [path.join(platform.store.flowDir(taskId), 'stage-output.json')]
  try {
    for (const file of files) await fs.rm(file, { force: true })
  } catch {
    // ignore
  }
}

export function lastAssistantHint(): string {
  return ''
}
