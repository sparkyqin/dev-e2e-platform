import type { FeedbackItem, TriageCategory } from '@ai-platform/shared'
import { applyRollback, canRollbackTo } from '../domain/state-machine.js'
import { newId, nowIso } from '../domain/util.js'
import { raiseGate } from './gates.js'
import { clearRailMarkers, loadDeliveryState, saveDeliveryState, saveExecutePhase } from './workers.js'
import type { Platform } from './platform.js'

/**
 * 交付合入监听（场景7 / [机-持续检视闭环] / [机-反馈分诊] / [机-交付事实远端真实] / [机-幂等重放]）
 *
 * MR 创建是监听态非终态。Watcher 轮询远端（mock CodeHub）：
 *  - 流水线/评论 → 反馈 5 源聚合（外部 ID 幂等去重）
 *  - 分诊：自动可修（不惊动人，退回编码修复模式）/ 需人决策（举卡成门待办）/ 仅提示（记录留痕）
 *  - SHA 校验：新推送后旧证据失效
 *  - 就绪（流水线真绿 + 反馈全消化）→ 举交付门（永远人工）
 */

export async function watchDelivery(platform: Platform, taskId: string): Promise<void> {
  const st = await platform.store.load(taskId)
  // 监听态持续聚合反馈；交付门等待期间同样聚合（反馈随时可能到达，不能因门已举而漏听 → 防盲签）
  const listening = st.status === 'watching' || (st.status === 'gate-wait' && st.gate?.kind === 'delivery')
  if (!listening || !st.mr) return
  const mr = platform.mrPlatform.get(st.mr.mrId)
  if (!mr) return

  const ds = await loadDeliveryState(platform, taskId)
  const log = platform.store.eventLog(taskId)
  let changed = false

  // ---- 远端流水线自动运行（模拟 CI：每个新 SHA 跑一次；feedback-loop 剧本首轮失败） ----
  if (!ds.pipelinedShas.includes(mr.sha)) {
    const isFirst = ds.pipelinedShas.length === 0
    const fail = st.scenario === 'feedback-loop' && isFirst
    const run = await platform.mrPlatform.addPipeline(mr.mrId, mr.sha, fail ? 'failed' : 'success', fail ? '远端流水线失败：单测 compile error（SHA ' + mr.sha.slice(0, 8) + '）' : `远端流水线通过（SHA ${mr.sha.slice(0, 8)}）`)
    ds.pipelinedShas.push(mr.sha)
    changed = true
    void run
  }

  // ---- 聚合新流水线结果（幂等：runId 去重） ----
  for (const run of mr.pipelines) {
    if (ds.processedExternalIds.includes(run.runId)) continue
    ds.processedExternalIds.push(run.runId)
    ds.evidence.push({
      kind: 'pipeline',
      ref: run.runId,
      sha: run.sha,
      ok: run.state === 'success',
      ts: nowIso(),
      stale: run.sha !== mr.sha,
    })
    if (run.state === 'failed' && run.sha === mr.sha) {
      ds.feedback.push({
        feedbackId: newId('fb'),
        source: 'pipeline',
        externalId: run.runId,
        text: `远端流水线失败：${run.summary}`,
        sha: run.sha,
        ts: nowIso(),
        triage: 'auto-fixable',
        status: 'new',
      })
    }
    changed = true
  }

  // ---- 聚合新评论（幂等：externalId 去重） ----
  for (const c of mr.comments) {
    if (ds.processedExternalIds.includes(c.externalId)) continue
    ds.processedExternalIds.push(c.externalId)
    const triage = triageComment(c.text, c.triage)
    ds.feedback.push({
      feedbackId: newId('fb'),
      source: c.kind === 'review-comment' ? 'review-comment' : 'mr-comment',
      externalId: c.externalId,
      author: c.author,
      text: c.text,
      sha: c.sha,
      ts: c.ts,
      triage,
      status: 'new',
    })
    changed = true
  }

  // ---- 分诊 ----
  // 注意顺序：先把反馈状态落盘（真源），再做可观测副作用（回退/举门）——
  // 否则存在「门已举、盘上反馈仍缺」的窗口，就绪检测会误判 allDigested=true（every([])）。
  const autoFixItems: typeof ds.feedback = []
  const humanItems: typeof ds.feedback = []
  const infoItems: typeof ds.feedback = []
  for (const f of ds.feedback) {
    if (f.status !== 'new') continue
    if (f.triage === 'auto-fixable') {
      f.status = 'queued-fix' // 不惊动人：退回编码修复模式（对抗式闭环），改完重验重推
      autoFixItems.push(f)
      changed = true
    } else if (f.triage === 'needs-human') {
      f.status = 'gate-raised'
      humanItems.push(f)
      changed = true
    } else {
      f.status = 'logged'
      infoItems.push(f)
      changed = true
    }
  }

  if (changed) await saveDeliveryState(platform, taskId, ds)

  for (const f of autoFixItems) {
    await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'feedback-auto-fix' } }, (s) => {
      if (canRollbackTo(s.stage, 'execute')) {
        applyRollback(s, 'execute', `MR 反馈自动修复：${f.text.slice(0, 80)}`)
        s.pendingInstructions.push(`MR 反馈（${f.source}）请修复：${f.text}`)
      }
    })
    // 段内检查点归位：修复模式回编码小节（watcher 直改真源，不经 rollbackStage，手动归位）
    await saveExecutePhase(platform, taskId, 'code')
    await clearRailMarkers(platform, taskId) // 修复轮重跑开发轨（与 rollbackStage 同款归位）
    await log.append(taskId, 'execute', { type: 'system' }, 'rollback', {
      from: 'execute',
      to: 'execute',
      reason: `反馈分诊=自动可修（不惊动人）：${f.text.slice(0, 60)}`,
      declaredBy: 'platform',
      declaredByName: '平台（delivery_watch）',
      reentrySkipsAiRerun: false,
    })
  }

  for (const f of humanItems) {
    await raiseGate(platform, taskId, {
      kind: 'fact',
      question: `MR 反馈需你决策：\n「${f.text}」\n（来自 ${f.source}${f.author ? ` · ${f.author}` : ''}，SHA ${f.sha.slice(0, 8)}）`,
      digest: '反馈分诊=需人决策：采纳修复 or 不采纳留痕',
      preface: 'MR 处于监听态，反馈持续聚合分诊；本条被判定需要人决策（如评审要求改架构）。',
      context: '自动可修的反馈不会惊动你；这条需要你拍板处理方式。',
      materials: [{ ref: 'feedback', label: '反馈原文', kind: 'evidence', content: f.text }],
      options: [
        { action: 'rollback', rollbackTarget: 'execute', label: '采纳：回编码按意见修复', tone: 'primary' },
        { action: 'approve', label: '不采纳（waive，留痕）', tone: 'neutral' },
      ],
      soleDecider: st.people.owner,
    })
  }

  for (const f of infoItems) {
    await log.append(taskId, 'execute', { type: 'system' }, 'assistant_message', {
      text: `反馈仅提示已记录留痕：${f.text.slice(0, 100)}`,
    })
  }

  // ---- 就绪检测：流水线真绿（当前 SHA）+ 反馈全消化 → 举交付门（永远人工） ----
  if (!st.gate) {
    const readiness = computeReadiness(st.mr.sha, ds)
    if (readiness.ready) {
      await platform.mrPlatform.markMergeable(mr.mrId)
      const readyDs = await loadDeliveryState(platform, taskId)
      const materials = [
        { ref: 'pipeline', label: '远端流水线（真绿）', kind: 'evidence' as const, content: `当前 SHA ${st.mr.sha.slice(0, 8)} 流水线通过（远端真实，非本地宣称）` },
        { ref: 'feedback', label: '反馈消化情况', kind: 'evidence' as const, content: readyDs.feedback.map((f) => `- [${f.status}] ${f.source}: ${f.text.slice(0, 60)}`).join('\n') || '（无反馈）' },
      ]
      await raiseGate(platform, taskId, {
        kind: 'delivery',
        question: '交付确认：远端流水线真绿、反馈全消化，是否合入？（合入为终态，永远人工、不可代答）',
        digest: '交付门：SHA 校验 + 幂等重放 + fail-closed 合入',
        preface: 'MR 监听态结束条件已满足：流水线在当前 SHA 真实通过，5 类反馈全部消化。',
        context: '合入是终态；合入后发现问题仍可回退编码（回退环）。',
        materials,
        options: [{ action: 'merge', label: '确认合入（终态）', tone: 'primary' }],
        soleDecider: st.people.merger,
      })
    }
  }
}

export function triageComment(text: string, hint?: TriageCategory): TriageCategory {
  if (hint) return hint
  if (/阻塞|必须|需要改|不通过|驳回|改架构/.test(text)) return 'needs-human'
  if (/nit|建议|可选|提示|fyi/i.test(text)) return 'info-only'
  return 'auto-fixable'
}

export function computeReadiness(currentSha: string, ds: import('./workers.js').DeliveryStateFile) {
  const pipelineGreen = ds.evidence.some((e) => e.kind === 'pipeline' && e.sha === currentSha && e.ok && !e.stale)
  const allDigested = ds.feedback.every((f) => ['fixed', 'logged', 'waived'].includes(f.status))
  const blockers: string[] = []
  if (!pipelineGreen) blockers.push('远端流水线未在当前 SHA 真绿')
  if (!allDigested) blockers.push(`存在未消化反馈（${ds.feedback.filter((f) => !['fixed', 'logged', 'waived'].includes(f.status)).length} 条）`)
  return { pipelineGreenOnCurrentSha: pipelineGreen, allFeedbackDigested: allDigested, humanApproved: false, ready: pipelineGreen && allDigested, blockers }
}
