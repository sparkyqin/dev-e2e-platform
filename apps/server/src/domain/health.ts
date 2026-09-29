import type { HealthFact, HealthLevel, TaskHealth } from '@ai-platform/shared'
import { nowIso } from './util.js'

/**
 * 健康徽标（[机-健康徽标]）
 *
 * taskHealthFacts：工具连续报错等异常计数超过阈值 → 徽标变黄/红，主动叫人（通知）。
 * Token 预算超阈预警（warning 80% / exceeded 100%）。
 */

export interface HealthInput {
  consecutiveToolErrors: number
  tokenUsage: { input: number; output: number; budget: number }
  stalledMs: number | null
  repairRounds: number
  maxRepairRounds: number
}

export function emptyHealth(budget: number): TaskHealth {
  return { level: 'green', facts: [] }
}

export function computeHealth(input: HealthInput, prev: TaskHealth): { health: TaskHealth; changed: boolean } {
  const facts: HealthFact[] = []
  const ts = nowIso()

  if (input.consecutiveToolErrors >= 3) {
    facts.push({
      code: 'tool-error-streak',
      message: `工具连续报错 ${input.consecutiveToolErrors} 次（如接口不存在/命令失败）`,
      count: input.consecutiveToolErrors,
      ts,
    })
  }
  const used = input.tokenUsage.input + input.tokenUsage.output
  if (input.tokenUsage.budget > 0 && used >= input.tokenUsage.budget) {
    facts.push({ code: 'token-exceeded', message: 'Token 预算已超限（exceeded）', count: 1, ts })
  } else if (input.tokenUsage.budget > 0 && used >= input.tokenUsage.budget * 0.8) {
    facts.push({ code: 'token-warning', message: 'Token 预算超阈预警（warning ≥80%）', count: 1, ts })
  }
  if (input.stalledMs !== null && input.stalledMs > 10 * 60_000) {
    facts.push({ code: 'stalled', message: '长时间无事件推进（疑似卡死）', count: 1, ts })
  }
  if (input.repairRounds >= input.maxRepairRounds) {
    facts.push({ code: 'repair-rounds', message: `修复轮次已达上限 ${input.maxRepairRounds}`, count: input.repairRounds, ts })
  }

  let level: HealthLevel = 'green'
  if (facts.some((f) => ['token-exceeded', 'stalled', 'repair-rounds'].includes(f.code)) || input.consecutiveToolErrors >= 6) {
    level = 'red'
  } else if (facts.length > 0) {
    level = 'yellow'
  }

  const changed = level !== prev.level
  return { health: { level, facts }, changed }
}
