import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { GateMaterial, StageId, TaskState } from '@ai-platform/shared'
import { STAGE_ORDER, renderOutputPath, stageEvidenceOutputs } from '@ai-platform/shared'
import { checkParentAggregation, closeParentMerged, loadArPlan, saveArPlan, spawnSubtasks } from './subtasks.js'
import { applyAdvance, applyRollback, canRollbackTo, isReentry } from '../domain/state-machine.js'
import { appendDecisionRecordFile, nowIso, readJson, writeJson } from '../domain/util.js'
import { ArtifactManager, CONTRACT_PATH } from '../extension/artifacts.js'
import { runEngine, clearStageOutput } from './engine-runner.js'
import { raiseGate } from './gates.js'
import type { Platform } from './platform.js'
import { commitAll, deliveryDirOf, ensureBranch } from '../runtime/git.js'

/**
 * 阶段作业（L2 状态机的阶段内活动；阶段 I/O 与退出条件平台兜底）
 *
 * Worker 契约：幂等可续跑——每次进入先看持久化状态（门/产物/轮次）再决定动作；
 * 返回 'continue'（状态已变，继续循环）/ 'wait'（已挂起：门/监听/人在控）/ 'stop'（终局或失败）。
 */

export type WorkerOutcome = 'continue' | 'wait' | 'stop'

export interface WorkerCtx {
  platform: Platform
  state: TaskState
  /** runner 内重试计数（进程内，不持久化） */
  attempts: number
}

export async function runStageWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  switch (ctx.state.stage) {
    case 'requirement':
      return requirementWorker(ctx)
    case 'architecture':
      return architectureWorker(ctx)
    case 'design':
      return designWorker(ctx)
    case 'test-design':
      return testDesignWorker(ctx)
    case 'execute':
      return executeWorker(ctx)
    case 'merged':
      return 'stop'
  }
}

// ==================== 门证据材料（读阶段注册表单源，不再各自硬编码清单） ====================

/**
 * 门证据材料 = 指定作业的证据面产物（阶段注册表声明）+ 显式跨阶段上下文。
 * 新增阶段产物只需在 STAGES 声明，证据同屏自动带上（evidence !== false）。
 */
async function gateMaterials(
  platform: Platform,
  taskId: string,
  stage: StageId,
  jobIds: string[],
  vars: { round?: number | string } = {},
  extras: { path: string; label?: string }[] = [],
): Promise<GateMaterial[]> {
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const materials: GateMaterial[] = []
  const push = async (p: string, label: string): Promise<void> => {
    const content = await am.read(p)
    if (content) materials.push({ ref: p, label, kind: 'artifact', content: content.slice(0, 5000) })
  }
  for (const o of stageEvidenceOutputs(stage, jobIds)) await push(renderOutputPath(o.path, vars), o.label)
  for (const x of extras) await push(x.path, x.label ?? x.path)
  return materials
}

/** 评审门证据同屏：前序阶段全部证据面产物（按阶段轨顺序，完整证据链） */
async function priorEvidenceMaterials(platform: Platform, taskId: string, untilStage: StageId): Promise<GateMaterial[]> {
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const materials: GateMaterial[] = []
  for (const sid of STAGE_ORDER) {
    if (sid === untilStage) break
    for (const o of stageEvidenceOutputs(sid)) {
      const content = await am.read(o.path)
      if (content) materials.push({ ref: o.path, label: o.label, kind: 'artifact', content: content.slice(0, 5000) })
    }
  }
  return materials
}

// ==================== ① 需求（愿景节点1：需求验收 → 系统需求分析） ====================

async function requirementWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId

  // 技能物化（任务开局：团队技能架 → host-skills/ 快照，[机-materialize 快照]）
  const marker = path.join(platform.store.flowDir(taskId), 'skills-materialized')
  if (!(await fs.stat(marker).catch(() => null))) {
    const injected = await platform.skills.materialize(platform.store.taskDir(taskId), state.repo, state.module)
    await fs.writeFile(marker, JSON.stringify({ at: nowIso(), injected }), 'utf8')
    platform.recordSkillsInjected(taskId, injected)
  }

  // ---- 段内检查点①：基线建立（双层自动校验；v1「接单开张」降级为段内检查点，不占阶段格）----
  const baselineOkMarker = path.join(platform.store.flowDir(taskId), 'baseline-ok')
  if (!(await fs.stat(baselineOkMarker).catch(() => null))) {
    const knowledge = await platform.injectKnowledge(taskId, 'requirement')

    const res = await runEngine(platform, state, 'intake', {
      purpose: `${state.mode === 'greenfield' ? '绿地新建' : '存量逆向'}：建立基线（过程区）`,
      injectedKnowledge: knowledge,
      vars: { mode: state.mode, repo: state.repo, module: state.module, title: state.title, requirementText: state.requirementText },
    })
    await clearStageOutput(platform, taskId, 'intake')

    if (res.interrupted) return 'wait'
    if (res.failed) return failTask(platform, taskId, `需求阶段基线建立引擎失败：${res.failureSummary ?? ''}`)

    // 双层自动校验（机器门，不靠人）：程序规则校验 + AI 复核（引擎 baselineReady）
    const am = new ArtifactManager(platform.store.taskDir(taskId))
    const baseline = await am.read('process/baseline.md')
    const ruleOk =
      !!baseline && (state.mode === 'greenfield' ? baseline.includes('绿地') || baseline.includes('新建') : baseline.includes('根级配置') || baseline.includes('改动切片'))
    const aiOk = res.output.baselineReady === true
    if (!ruleOk || !aiOk) {
      if (ctx.attempts < 1) return 'continue' // 重试一次
      return failTask(platform, taskId, `基线双层自动校验未通过（程序规则 ${ruleOk ? '✓' : '✗'} / AI 复核 ${aiOk ? '✓' : '✗'}）`)
    }
    await platform.syncArtifacts(taskId)
    // 检查点落盘：评审驳回回退需求时重跑分解，不重跑基线（reentrySkipsAiRerun）
    await fs.writeFile(baselineOkMarker, JSON.stringify({ at: nowIso(), mode: state.mode }), 'utf8')
    return 'continue' // 检查点已过，重新入轨做三级分解
  }

  // ---- 段内检查点②：IR→SR→AR 三级分解 + 业务事实门 ----
  return requirementClarifyPart(ctx)
}

async function requirementClarifyPart(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const gate = state.gate

  if (gate && gate.kind === 'fact') {
    if (gate.status === 'raised') return 'wait' // 事实门等待（超时降级由 tick 处理）
    // 已决策/已降级：记录业务事实，继续
    const answer = gate.decision?.answer ?? gate.degraded?.assumedAnswer ?? ''
    const degraded = gate.status === 'degraded'
    await appendDecisionRecord(platform, taskId, {
      topic: gate.question.split('\n')[0],
      decision: answer,
      degraded,
      ts: nowIso(),
    })
    if (!degraded) {
      // 解除待追认
      await platform.store.mutate(taskId, { expectedVersion: null }, (s) => {
        s.pendingConfirmations = s.pendingConfirmations.filter((p) => p.gateId !== gate.gateId || p.resolvedAt)
      })
    }
    await log.append(taskId, state.stage, { type: 'ai', engine: state.engineId }, 'assistant_message', {
      text: `业务事实已${degraded ? '按默认假设推进（待人工追认，未替答事实）' : '确认'}：${answer.slice(0, 200)}`,
    })
    return advanceStage(platform, taskId, 'architecture')
  }

  const knowledge = await platform.injectKnowledge(taskId, 'requirement')

  const directives = await consumeInstructions(platform, taskId)
  const res = await runEngine(platform, state, 'clarify', {
    purpose: 'IR→SR→AR 三级分解：需求落成可验收原子项',
    fixDirectives: directives,
    injectedKnowledge: knowledge,
    vars: { title: state.title, requirementText: state.requirementText, module: state.module },
  })
  const output = res.output
  await clearStageOutput(platform, taskId, 'clarify')

  if (res.interrupted) return 'wait'
  if (res.failed) return failTask(platform, taskId, `需求分解引擎失败：${res.failureSummary ?? ''}`)

  // 产物落索引 + artifact_written 留痕（本阶段产物记本阶段账，不等下一阶段补记）
  await platform.syncArtifacts(taskId)

  const questions = output.factQuestions ?? []
  if (questions.length > 0) {
    const q = questions[0]
    const materials: GateMaterial[] = []
    for (const ref of q.materials ?? []) {
      const am = new ArtifactManager(platform.store.taskDir(taskId))
      const content = await am.read(ref)
      materials.push({ ref, label: ref, kind: 'artifact', content: content?.slice(0, 4000) })
    }
    await raiseGate(platform, taskId, {
      kind: 'fact',
      question: q.question,
      digest: q.digest,
      preface: q.preface,
      context: q.context,
      materials,
      options: [{ action: 'answer', label: '作答（成组质询，各题独立作答）', tone: 'primary' }],
      soleDecider: state.people.requester,
    })
    return 'wait'
  }

  await log.append(taskId, state.stage, { type: 'ai', engine: state.engineId }, 'assistant_message', {
    text: `可验收原子项已落成：${output.atomicsSummary ?? '（见 process/clarify-ir-sr-ar.md）'}。任务转「系统架构设计」。`,
  })
  return advanceStage(platform, taskId, 'architecture')
}

// ==================== ③ 系统架构设计（研发作业流 · 架构阶段） ====================

async function architectureWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const gate = state.gate
  const decider = state.people.architect ?? state.people.owner

  if (gate && gate.kind === 'fact') {
    if (gate.status === 'raised') return 'wait'
    const decision = gate.decision
    if (gate.status === 'degraded' || decision?.action === 'approve') {
      await log.append(taskId, state.stage, { type: 'system' }, 'assistant_message', {
        text: '架构方案已拍板：产物主权由架构师移交开发；进入功能设计。',
      })
      await platform.syncArtifacts(taskId)
      return advanceStage(platform, taskId, 'design')
    }
    if (decision?.action === 'rollback') {
      return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'requirement', `架构拍板打回：${decision.reason ?? ''}`)
    }
    return 'wait'
  }

  const knowledge = await platform.injectKnowledge(taskId, 'architecture')
  const directives = await consumeInstructions(platform, taskId)
  const res = await runEngine(platform, state, 'architecture', {
    purpose: '架构设计 SPEC：架构分析 + 架构边界设计 + 业务流分析',
    fixDirectives: directives,
    injectedKnowledge: knowledge,
    vars: { title: state.title, requirementText: state.requirementText, module: state.module },
  })
  await clearStageOutput(platform, taskId, 'architecture')
  if (res.interrupted) return 'wait'
  if (res.failed) return failTask(platform, taskId, `架构阶段引擎失败：${res.failureSummary ?? ''}`)

  await platform.syncArtifacts(taskId)

  // 证据同屏（读阶段注册表单源）：架构 SPEC + 业务决策记录
  const materials = await gateMaterials(platform, taskId, 'architecture', ['architecture'], {}, [
    { path: 'process/decisions.json', label: '业务决策记录' },
  ])

  await raiseGate(platform, taskId, {
    kind: 'fact',
    question: '架构审视（架构门由架构师拍）：架构分析 / 架构边界设计 / 业务流分析是否通过？',
    digest: '架构设计 SPEC 三件套，架构师拍板后主权移交开发',
    preface: `架构师已与 AI 完成架构共创：${state.people.architect ? `主笔 ${state.people.architect.name}` : '（本任务未配置架构师，由责任人代理拍板）'}，产出在交付区。`,
    context: '架构边界（模块/服务职责与接口归属）与业务流（端到端时序）已明确；功能设计将在此边界内展开。',
    materials,
    options: [
      { action: 'approve', label: '架构通过（主权移交开发）', tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'requirement', label: '打回需求', tone: 'danger' },
    ],
    soleDecider: decider,
  })
  return 'wait'
}

// ==================== ③ 定规格设计（场景3） ====================

async function designWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const gate = state.gate

  if (gate && gate.kind === 'fact') {
    if (gate.status === 'raised') return 'wait'
    const decision = gate.decision
    if (gate.status === 'degraded' || decision?.action === 'approve') {
      // 拍板通过（或超时降级推进待追认）：主权移交开发（设计师主笔 → 开发）
      await log.append(taskId, state.stage, { type: 'system' }, 'assistant_message', {
        text: '功能方案已拍板：产物主权由设计师移交开发；进入测试设计。',
      })
      await platform.syncArtifacts(taskId)
      return advanceStage(platform, taskId, 'test-design')
    }
    if (decision?.action === 'rollback') {
      return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'requirement', `设计拍板打回：${decision.reason ?? ''}`)
    }
    return 'wait'
  }

  const knowledge = await platform.injectKnowledge(taskId, 'design')
  const directives = await consumeInstructions(platform, taskId)
  const res = await runEngine(platform, state, 'design', {
    purpose: 'WHAT/HOW 双产物：spec/design（含功能 FMEA）+ 契约单源',
    fixDirectives: directives,
    injectedKnowledge: knowledge,
    vars: { title: state.title, requirementText: state.requirementText, module: state.module },
  })
  await clearStageOutput(platform, taskId, 'design')
  if (res.interrupted) return 'wait'
  if (res.failed) return failTask(platform, taskId, `设计阶段引擎失败：${res.failureSummary ?? ''}`)

  await platform.syncArtifacts(taskId)

  // 契约单源 + 派生视图漂移检测
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const contract = await am.read(CONTRACT_PATH)
  if (contract) {
    // 单源解析失败不杀阶段：如实留痕（材料里仍有原文证据），拍板人可见
    try {
      await am.writeContract(JSON.parse(contract), 'process/contract-view.md', (c) => renderContractView(c))
    } catch (err) {
      await log.append(taskId, state.stage, { type: 'system' }, 'assistant_message', {
        text: `契约单源解析失败（不阻断拍板，原文已入证据材料）：${(err as Error).message}`,
      })
    }
  }

  // 证据同屏（读阶段注册表单源）：WHAT/HOW 双产物 + 契约单源
  const materials = await gateMaterials(platform, taskId, 'design', ['design'])
  const drift = await am.checkDrift([{ path: 'process/contract-view.md' }])

  await raiseGate(platform, taskId, {
    kind: 'fact',
    question: `方案确认（澄清/设计门由开发拍）：功能设计 spec/design 是否通过？${drift.length > 0 ? '\n⚠ 契约派生视图存在漂移，请先处理。' : ''}`,
    digest: 'WHAT/HOW 双产物（含功能 FMEA）+ 契约单源，开发拍板后主权移交',
    preface: '设计师已与 AI 完成多轮打磨，过程草稿在过程区未污染交付；契约已入单源。',
    context: '功能设计在架构边界内展开（实现设计/规格接口/功能 FMEA）；按流程需开发拍板方案通过后，主权移交开发并进入测试设计。',
    materials,
    options: [
      { action: 'approve', label: '方案通过（主权移交开发）', tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'architecture', label: '打回系统架构设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'requirement', label: '打回需求', tone: 'danger' },
    ],
    soleDecider: state.people.owner,
  })
  return 'wait'
}

// ==================== ④ 测试设计 + 方案评审连拍（愿景节点4 · 设计段收口双门） ====================

async function testDesignWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const gate = state.gate
  const decider = state.people.tse ?? state.people.owner

  // ---- 连拍第二门：方案评审门（评审人唯一拍板，铁门超时只升级；通过=设计段收口放行进编码） ----
  if (gate && gate.kind === 'review') {
    if (gate.status === 'raised') return 'wait' // 等拍板（超时升级由 tick 处理）
    const decision = gate.decision
    const round = state.repairRounds + 1
    // 评审报告（首轮与每轮返工均留痕）
    const report = [
      `# 评审报告（第 ${round} 轮）`,
      '',
      `- 任务：#${state.seq} ${state.title}`,
      `- 评审人：${gate.soleDecider.name}（唯一拍板）`,
      `- 会诊：${gate.participants.filter((p) => p.role === 'consulted').map((p) => p.name).join('、') || '无'}`,
      `- 结论：${decision?.action === 'approve' ? '通过放行' : `驳回，声明式回退到「${decision?.rollbackTarget}」`}`,
      `- 理由：${decision?.reason ?? '—'}`,
      '',
      '## 批注与讨论',
      ...(await reviewAnnotations(platform, taskId)),
    ].join('\n')
    const am = new ArtifactManager(platform.store.taskDir(taskId))
    await am.write(`process/review-report-r${round}.md`, report, 'test-design', 'reviewer')
    await platform.syncArtifacts(taskId)

    if (decision?.action === 'approve') {
      await log.append(taskId, state.stage, { type: 'system' }, 'assistant_message', {
        text: '方案评审通过（设计段收口）：放行进入执行与编码。',
      })
      return advanceStage(platform, taskId, 'execute')
    }
    if (decision?.action === 'rollback' || decision?.action === 'reject') {
      return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'design', `评审门驳回：${decision.reason ?? ''}`)
    }
    return 'wait'
  }

  // ---- 第一门：测试设计门（TSE 拍板；通过后连拍举评审门，不换阶段） ----
  if (gate && gate.kind === 'fact') {
    if (gate.status === 'raised') return 'wait'
    const decision = gate.decision
    if (gate.status === 'degraded' || decision?.action === 'approve') {
      await log.append(taskId, state.stage, { type: 'system' }, 'assistant_message', {
        text: '测试设计已拍板：产物主权由 TSE 移交开发；连拍举方案评审门（设计段收口）。',
      })
      await platform.syncArtifacts(taskId)
      return raiseReviewGate(platform, taskId)
    }
    if (decision?.action === 'rollback') {
      return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'design', `测试设计拍板打回：${decision.reason ?? ''}`)
    }
    return 'wait'
  }

  const knowledge = await platform.injectKnowledge(taskId, 'test-design')
  const directives = await consumeInstructions(platform, taskId)
  const res = await runEngine(platform, state, 'test-design', {
    purpose: '测试 SPEC：需求测试分析 + 测试策略分析 + 测试点设计',
    fixDirectives: directives,
    injectedKnowledge: knowledge,
    vars: { title: state.title, requirementText: state.requirementText, module: state.module },
  })
  await clearStageOutput(platform, taskId, 'test-design')
  if (res.interrupted) return 'wait'
  if (res.failed) return failTask(platform, taskId, `测试设计阶段引擎失败：${res.failureSummary ?? ''}`)

  await platform.syncArtifacts(taskId)

  // 证据同屏（读阶段注册表单源）：测试 SPEC + 规格（上文）
  const materials = await gateMaterials(platform, taskId, 'test-design', ['test-design'], {}, [
    { path: 'delivery/spec.md', label: '规格 spec（上文）' },
  ])

  await raiseGate(platform, taskId, {
    kind: 'fact',
    question: '测试设计确认（测试设计门由 TSE 拍）：需求测试分析 / 测试策略 / 测试点设计是否通过？',
    digest: '测试 SPEC 三件套，TSE 拍板后主权移交开发',
    preface: `TSE 已与 AI 完成测试设计共创：${state.people.tse ? `主笔 ${state.people.tse.name}` : '（本任务未配置 TSE，由责任人代理拍板）'}，产出在交付区。`,
    context: '测试点覆盖验收标准与边界（含 DFX 口径）；测试策略明确分层（UT/MST/自动化用例归属）；评审门将以测试设计覆盖度作为证据充分性判据。',
    materials,
    options: [
      { action: 'approve', label: '测试设计通过（连拍举评审门）', tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'design', label: '打回功能设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'requirement', label: '打回需求', tone: 'danger' },
    ],
    soleDecider: decider,
  })
  return 'wait'
}

/** 举方案评审门（设计段收口）：证据同屏前序阶段全部证据面产物（按阶段轨顺序，完整证据链） */
async function raiseReviewGate(platform: Platform, taskId: string): Promise<WorkerOutcome> {
  const state = await platform.store.load(taskId)
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const materials = await priorEvidenceMaterials(platform, taskId, 'execute')
  const drift = await am.checkDrift([{ path: 'process/contract-view.md' }])
  if (drift.length > 0) materials.push({ ref: 'drift', label: `⚠ 契约视图漂移：${drift.join(', ')}`, kind: 'evidence' })

  await raiseGate(platform, taskId, {
    kind: 'review',
    question: '方案评审：证据已同屏（需求/架构/功能设计/测试设计/契约/决策记录），是否放行进编码？',
    digest: '评审人唯一拍板；可邀请会诊；驳回请声明式回退',
    preface: '架构师/TSE/开发均已拍板各自方案（主权在开发）；设计段收口评审。',
    context: '评审门判证据充分性（非主观质量）：架构边界清晰、双产物完整、契约单源无漂移、测试设计覆盖验收标准。',
    materials,
    options: [
      { action: 'approve', label: '通过，放行进编码', tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'test-design', label: '驳回：回退测试设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'design', label: '驳回：回退功能设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'architecture', label: '驳回：回退架构设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'requirement', label: '驳回：回退需求', tone: 'danger' },
    ],
    soleDecider: state.people.reviewer,
  })
  return 'wait'
}

async function reviewAnnotations(platform: Platform, taskId: string): Promise<string[]> {
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const list = await am.listAnnotations()
  return list.map((a) => `- [${a.authorName}] ${a.artifactPath}${a.anchor ? `（${a.anchor}）` : ''}：${a.text}${a.replies.map((r) => `\n  - [${r.authorName}] ${r.text}`).join('')}`)
}

// ==================== ⑤ 执行与编码（愿景节点5：全功能团队×N；吸收 v1 code+verify+deliver） ====================

/** 执行段段内检查点（.flow/execute-phase.json）：AR设计→编码→验证→交付是段内循环，不是阶段边界 */
export type ExecutePhase = 'ar-design' | 'code' | 'verify' | 'deliver'

export async function loadExecutePhase(platform: Platform, taskId: string): Promise<ExecutePhase> {
  const f = await readJson<{ phase: ExecutePhase }>(path.join(platform.store.flowDir(taskId), 'execute-phase.json'))
  // 文件缺失 = 全新进入（advanceStage 已清）或 ar-design 中途崩溃 → 从 AR 级设计起跑；
  // mid-code/mid-verify 崩溃时文件已是对应值，不受默认值影响。
  return f?.phase ?? 'ar-design'
}

export async function saveExecutePhase(platform: Platform, taskId: string, phase: ExecutePhase): Promise<void> {
  await writeJson(path.join(platform.store.flowDir(taskId), 'execute-phase.json'), { phase })
}

export async function clearExecutePhase(platform: Platform, taskId: string): Promise<void> {
  try {
    await fs.rm(path.join(platform.store.flowDir(taskId), 'execute-phase.json'), { force: true })
  } catch {
    // ignore
  }
  await clearRailMarkers(platform, taskId)
}

async function executeWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { state } = ctx

  // AR 并行父任务：执行段走「拆分门 → 子任务并行 → 聚合验收门」而非直接编码
  if (state.arParallel && !state.parentTaskId) return parentExecuteWorker(ctx)

  return executeMainWorker(ctx)
}

/** 普通执行段：门优先分派（决策后回到举门的小节继续），无门按段内检查点推进 */
async function executeMainWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const gate = state.gate

  if (gate && gate.kind === 'test') return verifyGateBranch(ctx) // 测试门（验证小节收口）
  if (gate && gate.kind === 'fact' && state.mr) return deliverFeedbackGateBranch(ctx) // MR 反馈决策门（交付小节）
  if (gate && gate.kind === 'delivery') return deliverMergeBranch(ctx) // 交付门（合入）

  const phase = await loadExecutePhase(platform, state.taskId)
  if (phase === 'ar-design') return executeArDesignPart(ctx)
  if (phase === 'verify') return executeVerifyPart(ctx)
  if (phase === 'deliver') return executeDeliverPart(ctx)
  return executeCodePart(ctx)
}

/** 父任务执行段：AR 拆分门（owner 拍）→ spawn 子任务并行 → 聚合验收门（TSE 拍）→ 收口 */
async function parentExecuteWorker(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const log = platform.store.eventLog(taskId)
  const gate = state.gate

  // ---- 聚合验收门（test 类铁门，TSE 拍板；超时只升级） ----
  if (gate && gate.kind === 'test' && gate.stage === 'execute') {
    if (gate.status === 'raised') return 'wait'
    const decision = gate.decision
    if (decision?.action === 'approve') return closeParentMerged(platform, taskId)
    if (decision?.action === 'rollback') {
      // 验收不通过：清空拆分清单重新派发（修复轮 +1；AR 谱系保留在事件流）
      await platform.store.mutate(
        taskId,
        { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'ar-resplit' } },
        (s) => {
          s.subtasks = []
          s.gate = null
          s.status = 'queued'
          s.repairRounds += 1
        },
      )
      await log.append(taskId, 'execute', { type: 'system' }, 'rollback', {
        from: 'execute',
        to: 'execute',
        reason: `聚合验收不通过：${decision.reason ?? ''}（清空拆分，重新派发 AR）`,
        declaredBy: decision.decidedBy,
        declaredByName: decision.decidedByName,
        reentrySkipsAiRerun: false,
      })
      return 'continue'
    }
    return 'wait'
  }

  // ---- AR 拆分门（fact 类，owner 拍板；超时可降级按方案推进待追认） ----
  if (gate && gate.kind === 'fact' && gate.stage === 'execute') {
    if (gate.status === 'raised') return 'wait'
    const decision = gate.decision
    if (gate.status === 'degraded' || decision?.action === 'approve') {
      const items = await loadArPlan(platform, taskId)
      if (items.length === 0) {
        await log.append(taskId, 'execute', { type: 'system' }, 'assistant_message', {
          text: '拆分方案缺失（ar-plan.json 不存在），重新生成拆分方案。',
        })
        await platform.store.mutate(taskId, { expectedVersion: null }, (s) => {
          s.gate = null
          s.status = 'queued'
        })
        return 'continue'
      }
      const parent = await platform.store.load(taskId)
      await spawnSubtasks(platform, parent, items)
      return 'wait'
    }
    if (decision?.action === 'rollback') {
      return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'design', `AR 拆分打回：${decision.reason ?? ''}`)
    }
    return 'wait'
  }

  // 已派发（防御：aggregating 由 tick 扫描，不应进入 worker）
  if ((state.subtasks?.length ?? 0) > 0) return 'wait'

  // ---- 首次进入执行段：跑 AR 拆分作业 → 落拆分方案 → 举拆分门（owner 拍板，证据同屏） ----
  const knowledge = await platform.injectKnowledge(taskId, 'execute')
  const res = await runEngine(platform, state, 'ar-split', {
    purpose: 'AR 拆分：把审核通过的方案拆为可并行的原子需求（每个 AR 可独立实现/独立验收/独立 MR）',
    injectedKnowledge: knowledge,
    vars: { title: state.title, requirementText: state.requirementText, module: state.module },
  })
  await clearStageOutput(platform, taskId, 'ar-split')
  if (res.interrupted) return 'wait'
  if (res.failed) return failTask(platform, taskId, `AR 拆分作业引擎失败：${res.failureSummary ?? ''}`)

  const items =
    res.output.arItems && res.output.arItems.length > 0
      ? res.output.arItems
      : [{ title: state.title, summary: state.requirementText, acceptance: '主流程验收通过' }]
  await saveArPlan(platform, taskId, items)

  // 证据同屏（读阶段注册表单源）：拆分方案 + 三级分解 + 规格
  const materials = await gateMaterials(platform, taskId, 'execute', ['ar-split'], {}, [
    { path: 'process/clarify-ir-sr-ar.md', label: '三级分解（拆分输入）' },
    { path: 'delivery/spec.md', label: '规格 spec（拆分输入）' },
  ])

  await raiseGate(platform, taskId, {
    kind: 'fact',
    question: `AR 拆分确认（执行段由责任人拍板）：是否按以下 ${items.length} 个原子需求并行执行？\n${items
      .map((it, i) => `${i + 1}. ${it.title}${it.acceptance ? `（验收：${it.acceptance}）` : ''}`)
      .join('\n')}`,
    digest: `AR 并行拆分：${items.length} 个子任务，开发轮转承接（调度器并发槽内并行）`,
    preface: '评审门已放行。执行段按原子需求并行：每个 AR 一个子任务（拷贝父任务设计产物，从执行段编码小节起跑），各自走 编码→验证→MR→合入。',
    context: '子任务全部合入后举聚合验收门（TSE 拍板）收口父任务；任一子任务失败会升级通知责任人。并行度受调度器并发槽约束。',
    materials,
    options: [
      { action: 'approve', label: `确认拆分，派发 ${items.length} 个子任务`, tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'design', label: '打回功能设计', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'requirement', label: '打回需求', tone: 'danger' },
    ],
    soleDecider: state.people.owner,
  })
  return 'wait'
}

/** 轨道完成标记（.flow/rail-{code|test}.json）：双轨并行后重试/修复轮只重跑未完成轨 */
export async function railDone(platform: Platform, taskId: string, rail: 'code' | 'test'): Promise<boolean> {
  const f = await readJson<{ done: boolean }>(path.join(platform.store.flowDir(taskId), `rail-${rail}.json`))
  return f?.done === true
}

async function markRailDone(platform: Platform, taskId: string, rail: 'code' | 'test'): Promise<void> {
  await writeJson(path.join(platform.store.flowDir(taskId), `rail-${rail}.json`), { done: true, at: nowIso() })
}

/** 清轨道标记（回退进执行段/watcher 自动修复时调用：修复轮重跑开发轨） */
export async function clearRailMarkers(platform: Platform, taskId: string): Promise<void> {
  for (const rail of ['code', 'test'] as const) {
    try {
      await fs.rm(path.join(platform.store.flowDir(taskId), `rail-${rail}.json`), { force: true })
    } catch {
      // ignore
    }
  }
}

/** 执行段 · AR 级设计小节（编码前置：设计→实现的聚焦衔接；单任务与 AR 子任务同构） */
async function executeArDesignPart(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId

  const fresh = await platform.store.load(taskId)
  const knowledge = await platform.injectKnowledge(taskId, 'execute')
  const directives = await consumeInstructions(platform, taskId)
  const res = await runEngine(platform, fresh, 'ar-design', {
    purpose: 'AR 级设计：基于设计产物出实现设计摘要（编码前置）',
    fixDirectives: directives,
    injectedKnowledge: knowledge,
    vars: { title: fresh.title, requirementText: fresh.requirementText, module: fresh.module, arTitle: fresh.arTitle ?? '' },
  })
  await clearStageOutput(platform, taskId, 'ar-design')

  if (res.interrupted) {
    const after = await platform.store.load(taskId)
    if (after.health.level === 'red') {
      return failTask(platform, taskId, `连续工具报错超预算，健康红线停止（待修复）：${res.failureSummary ?? ''}`)
    }
    return 'wait'
  }
  if (res.failed || res.output.arDesignReady !== true) {
    if (ctx.attempts < 2) return 'continue'
    return failTask(platform, taskId, `AR 级设计未能完成：${res.failureSummary ?? '自报未完成'}`)
  }

  await platform.syncArtifacts(taskId)
  await saveExecutePhase(platform, taskId, 'code') // 段内检查点：AR 设计过 → 编码小节
  return 'continue'
}

/**
 * 执行段 · 编码小节 —— 双轨并行（愿景：全功能团队×N）
 * 开发轨（code）∥ 测试轨（测试用例设计→自动化 DESIGN→自动化生成），每轨独立引擎会话。
 * 轨道完成标记让重试/修复轮只重跑未完成轨：修复模式（directives 非空）只重跑开发轨
 * （测试轨产物派生自测试 SPEC 而非代码，代码修复不使其失效）。
 */
async function executeCodePart(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId

  const fresh = await platform.store.load(taskId)

  const knowledge = await platform.injectKnowledge(taskId, 'execute')
  const directives = await consumeInstructions(platform, taskId)
  const vars = { title: fresh.title, requirementText: fresh.requirementText, module: fresh.module }
  const repair = directives.length > 0

  // ---- 开发轨（写/修双模式；自报完成以文件证据裁决） ----
  const runDevRail = async (): Promise<{ ok: boolean; reason?: string }> => {
    const res = await runEngine(platform, fresh, 'code', {
      purpose: repair ? '修复模式：按指令改写代码' : '写模式：按 spec/design 实现',
      fixDirectives: directives,
      injectedKnowledge: knowledge,
      vars,
    })
    const output = res.output
    await clearStageOutput(platform, taskId, 'code')

    if (res.interrupted) {
      const after = await platform.store.load(taskId)
      if (after.health.level === 'red') {
        return { ok: false, reason: `连续工具报错超预算，健康红线停止（待修复）：${res.failureSummary ?? ''}` }
      }
      return { ok: false, reason: '__interrupted__' }
    }
    if (res.failed || output.done !== true) {
      return { ok: false, reason: `编码小节未能完成（自报未完成/引擎失败）：${res.failureSummary ?? '连续试错'}` }
    }
    // 自报完成以文件证据裁决（不只信自报）
    const claimed = output.claimedFiles ?? []
    const wsRoot = platform.store.taskDir(taskId)
    const missing: string[] = []
    for (const f of claimed) {
      const full = path.join(wsRoot, f)
      if (!path.normalize(full).startsWith(path.normalize(wsRoot))) continue
      if (!(await fs.stat(full).catch(() => null))) missing.push(f)
    }
    if (missing.length > 0) {
      return { ok: false, reason: `自报完成但文件不存在（不信自报）：${missing.join(', ')}` }
    }
    await markRailDone(platform, taskId, 'code')
    return { ok: true }
  }

  // ---- 测试轨（串行链：用例设计 → 自动化 DESIGN → 自动化生成；产物派生自测试 SPEC） ----
  const runTestRail = async (): Promise<{ ok: boolean; reason?: string }> => {
    for (const [job, purpose, readyField] of [
      ['test-case-design', '测试轨①：测试用例设计（测试点→可执行用例集）', 'testCasesReady'],
      ['auto-case-design', '测试轨②：自动化用例 DESIGN（框架/选址/数据构造）', 'autoCasesReady'],
      ['auto-case-generate', '测试轨③：自动化用例生成（delivery/test/auto/）', 'autoCasesReady'],
    ] as const) {
      const res = await runEngine(platform, fresh, job, { purpose, injectedKnowledge: knowledge, vars })
      await clearStageOutput(platform, taskId, job)
      if (res.interrupted) return { ok: false, reason: '__interrupted__' }
      if (res.failed || res.output[readyField] !== true) {
        return { ok: false, reason: `测试轨 ${job} 未能完成：${res.failureSummary ?? '自报未完成'}` }
      }
    }
    await markRailDone(platform, taskId, 'test')
    return { ok: true }
  }

  const devDone = await railDone(platform, taskId, 'code')
  const testDone = (await railDone(platform, taskId, 'test')) || repair // 修复轮视为测试轨有效（不重跑）

  const ok: { ok: true } = { ok: true }
  const results = await Promise.all<{ ok: boolean; reason?: string }>([
    devDone ? Promise.resolve(ok) : runDevRail(),
    testDone ? Promise.resolve(ok) : runTestRail(),
  ])

  const interrupted = results.some((r) => r.reason === '__interrupted__')
  if (interrupted) return 'wait'
  const failedRail = results.find((r) => !r.ok)
  if (failedRail) {
    if (ctx.attempts < 2) return 'continue' // 会话失败重试（预算内；只重跑未完成轨）
    return failTask(platform, taskId, failedRail.reason ?? '编码小节失败')
  }

  await platform.syncArtifacts(taskId)
  await saveExecutePhase(platform, taskId, 'verify') // 段内检查点：双轨编码过 → 验证小节
  return 'continue'
}

/** 执行段 · 验证小节：测试门决策分支（通过→交付小节；驳回→段内修复/回退测试设计） */
async function verifyGateBranch(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const gate = state.gate
  if (gate && gate.status === 'raised') return 'wait'
  const decision = gate?.decision
  if (decision?.action === 'approve') {
    // 决策已消化：清已决门（编码→验证→交付是段内小节不是阶段边界，没有 applyAdvance 帮忙清门，
    // 必须显式清——否则 executeMainWorker 的门分派会无限回到本分支）
    await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'digest-test-gate' } }, (s) => {
      if (s.gate?.gateId === gate?.gateId) s.gate = null
    })
    await saveExecutePhase(platform, taskId, 'deliver') // 段内检查点：验证过 → 交付小节
    return 'continue'
  }
  if (decision?.action === 'rollback') {
    return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'execute', `测试门驳回：${decision.reason ?? ''}`)
  }
  return 'wait'
}

interface VerifyStateFile {
  round: number
  dims: { dimension: string; dispatchId: string; verdict: 'PASS' | 'WARN' | 'FAIL'; findings: string[] }[]
}

/** 执行段 · 验证小节（多维并行评审 + Critic 终审 + 构建 + 测试 → 举测试门） */
async function executeVerifyPart(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const pb = platform.playbooks.get(state.playbookId)
  const log = platform.store.eventLog(taskId)
  const flowDir = platform.store.flowDir(taskId)

  const vs: VerifyStateFile = (await readJson<VerifyStateFile>(path.join(flowDir, 'verify-state.json'))) ?? { round: 0, dims: [] }
  const directives = await consumeInstructions(platform, taskId)
  const reentry = vs.dims.length > 0 && directives.length > 0

  // ---- 多维并行评审（各维独立判定；修复轮仅复检失败维度=回请原维度复检） ----
  // 注：各维分派/报告独立（事件流与文件可观测"并行"），执行串行化以保证 stage-output 单写者无竞态。
  const dimsToRun = reentry ? vs.dims.filter((d) => d.verdict === 'FAIL').map((d) => d.dimension) : pb.customizable.reviewDimensions
  if (dimsToRun.length > 0) {
    await log.append(taskId, 'execute', { type: 'system' }, 'assistant_message', {
      text: `多维并行评审：${dimsToRun.join(' / ')} 各维独立判定${reentry ? '（回请原维度复检）' : ''}。`,
    })
    const results: { dimension: string; dispatchId: string; r: Awaited<ReturnType<typeof runEngine>> }[] = []
    for (const dimension of dimsToRun) {
      const dispatchId = `dsp-${Math.random().toString(36).slice(2, 10)}`
      const r = await runEngine(platform, state, 'verify-review', {
        purpose: `维度评审「${dimension}」`,
        vars: { dimension, dispatchId, round: String(vs.round + 1) },
      })
      results.push({ dimension, dispatchId, r })
    }
    // 全量重跑轮丢弃旧轮的 Critic 汇总条目（本轮终审会重新生成；避免陈旧 FAIL 永久滞留）
    let updated = vs.dims.filter((d) => !dimsToRun.includes(d.dimension) && (reentry || d.dimension !== 'Critic 终审'))
    for (const { dimension, dispatchId, r } of results) {
      // 评审报告防伪：dispatchId 必须回带 + 报告文件必须存在且含分派 ID
      const am = new ArtifactManager(platform.store.taskDir(taskId))
      const reportFile = `process/review/dim-${dimension}-r${vs.round + 1}.md`
      const reportText = await am.read(reportFile)
      const authentic = r.output.dispatchId === dispatchId && !!reportText && reportText.includes(dispatchId)
      const verdict = authentic ? (r.output.verdict ?? 'FAIL') : 'FAIL'
      const findings = authentic ? (r.output.findings ?? []) : ['评审报告防伪校验失败（分派 ID 不匹配或报告缺失）']
      updated = updated.filter((d) => d.dimension !== dimension)
      updated.push({ dimension, dispatchId, verdict, findings })
    }
    vs.dims = updated
    vs.round += 1
    await writeJson(path.join(flowDir, 'verify-state.json'), vs)
    await clearStageOutput(platform, taskId, 'verify-review')
  }

  // ---- Critic 终审（汇总 + 来源交叉校验防伪） ----
  if (pb.customizable.criticEnabled && vs.dims.length > 0) {
    const dispatchIds = vs.dims.map((d) => d.dispatchId)
    const r = await runEngine(platform, state, 'verify-critic', {
      purpose: 'Critic 终审：汇总各维度 + 来源交叉校验',
      vars: { dispatchIds: dispatchIds.join(','), verdicts: vs.dims.map((d) => d.verdict).join(','), round: String(vs.round) },
    })
    await clearStageOutput(platform, taskId, 'verify-critic')
    const cited = (r.output.dispatchIds ?? []).filter((d) => dispatchIds.includes(d))
    if (cited.length !== dispatchIds.length || (vs.dims.some((d) => d.verdict === 'FAIL') && r.output.verdict !== 'FAIL')) {
      vs.dims.push({ dimension: 'Critic 终审', dispatchId: 'critic', verdict: 'FAIL', findings: ['Critic 交叉校验失败：未完整引用分派记录或与各维结论矛盾'] })
      await writeJson(path.join(flowDir, 'verify-state.json'), vs)
    }
  }

  const failed = vs.dims.filter((d) => d.verdict === 'FAIL')
  if (failed.length > 0) {
    if (state.repairRounds + 1 > pb.customizable.maxRepairRounds) {
      return failTask(platform, taskId, `修复轮次超限（${state.repairRounds}/${pb.customizable.maxRepairRounds}），升级人工介入：${failed.map((f) => f.dimension).join('、')}`, 'repair-exceeded')
    }
    return rollbackStage(
      platform,
      taskId,
      'execute',
      `验证不通过（${failed.map((f) => f.dimension).join('、')}）`,
      failed.flatMap((f) => f.findings).slice(0, 8),
    )
  }

  // ---- 编译构建（重试预算；反幻觉：失败如实记录） ----
  const buildBudget = pb.customizable.retryBudget.build
  let buildOk = false
  for (let attempt = 1; attempt <= buildBudget; attempt++) {
    const r = await runEngine(platform, state, 'build', {
      purpose: `编译构建（第 ${attempt}/${buildBudget} 次）`,
      fixDirectives: directives, // 修复指令透传：修复后的构建以修复上下文执行
      vars: { round: String(vs.round) },
    })
    await clearStageOutput(platform, taskId, 'build')
    buildOk = r.output.ok === true
    if (buildOk) break
    if (attempt >= buildBudget) {
      return failTask(platform, taskId, `构建失败，重试预算（${buildBudget}）耗尽，停止升级（不烧资源，不假装通过）：${(r.output.log ?? '').split('\n').slice(-3).join(' ')}`, 'build-failed')
    }
  }

  // ---- 测试执行 ----
  const testBudget = pb.customizable.retryBudget.test
  let testOk = false
  let testCases = 0
  for (let attempt = 1; attempt <= testBudget; attempt++) {
    const r = await runEngine(platform, state, 'test', {
      purpose: `测试执行（第 ${attempt}/${testBudget} 次）`,
      fixDirectives: directives,
      vars: { round: String(vs.round) },
    })
    await clearStageOutput(platform, taskId, 'test')
    testOk = r.output.ok === true
    testCases = r.output.cases ?? 0
    if (testOk) break
    if (attempt >= testBudget) {
      return failTask(platform, taskId, `测试失败，重试预算（${testBudget}）耗尽：如实记录，不阻断上报`, 'build-failed')
    }
  }

  // ---- 测试门（测试是否真跑、是否通过——证据同屏，读阶段注册表单源按轮次渲染路径） ----
  await platform.syncArtifacts(taskId) // 评审报告/构建日志/测试报告落索引 + artifact_written 留痕
  const materials = await gateMaterials(platform, taskId, 'execute', ['build', 'test', 'test-case-design'], { round: vs.round })
  const dimReports = vs.dims.map((d) => `- ${d.dimension}：${d.verdict}`).join('\n')
  materials.push({ ref: 'dims', label: '维度评审结论', kind: 'report', content: dimReports })
  // 测试轨产物并入证据同屏：自动化用例清单（delivery/test/auto/ 动态目录，读盘列文件）
  const autoDir = path.join(platform.store.taskDir(taskId), 'delivery', 'test', 'auto')
  const autoFiles = await fs.readdir(autoDir).catch(() => [] as string[])
  if (autoFiles.length > 0) {
    materials.push({ ref: 'auto-cases', label: '自动化用例清单（测试轨生成）', kind: 'report', content: autoFiles.map((f) => `- delivery/test/auto/${f}`).join('\n') })
  }

  await raiseGate(platform, taskId, {
    kind: 'test',
    question: `测试确认：${testCases} 个用例真跑且通过、构建通过${autoFiles.length > 0 ? `，测试轨产出 ${autoFiles.length} 个自动化用例文件` : ''}，是否认可进入交付？`,
    digest: '测试门：判「测试是否真跑、是否通过」（证据同屏含测试轨产物，非口头自报）',
    preface: '多维评审 + Critic 终审 + 构建 + 测试 + 测试轨（用例设计/自动化生成）已完成；测试证据见材料选区。',
    context: `维度结论：${dimReports}`,
    materials,
    options: [
      { action: 'approve', label: '认可，进入交付合入', tone: 'primary' },
      { action: 'rollback', rollbackTarget: 'execute', label: '不认可：回退编码修复', tone: 'danger' },
      { action: 'rollback', rollbackTarget: 'test-design', label: '回退测试设计', tone: 'danger' },
    ],
    soleDecider: state.people.owner,
  })
  return 'wait'
}

// ==================== ⑦ 交付合入（场景7） ====================

export interface DeliveryStateFile {
  lastSeenVersion: number
  processedExternalIds: string[]
  pipelinedShas: string[]
  feedback: import('@ai-platform/shared').FeedbackItem[]
  evidence: import('@ai-platform/shared').EvidenceEntry[]
}

export async function loadDeliveryState(platform: Platform, taskId: string): Promise<DeliveryStateFile> {
  return (
    (await readJson<DeliveryStateFile>(path.join(platform.store.flowDir(taskId), 'delivery-state.json'))) ?? {
      lastSeenVersion: 0,
      processedExternalIds: [],
      pipelinedShas: [],
      feedback: [],
      evidence: [],
    }
  )
}

export async function saveDeliveryState(platform: Platform, taskId: string, ds: DeliveryStateFile): Promise<void> {
  await writeJson(path.join(platform.store.flowDir(taskId), 'delivery-state.json'), ds)
}

/** 执行段 · 交付小节：交付门决策分支（合入=永远人工；就绪条件已在 decide 时 fail-closed 复核） */
async function deliverMergeBranch(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const gate = state.gate
  if (gate && gate.status === 'raised') return waitAsWatching(platform, taskId)
  if (gate?.decision?.action === 'merge') {
    return doMerge(platform, taskId)
  }
  return waitAsWatching(platform, taskId)
}

/** 执行段 · 交付小节：MR 反馈决策门（fact）决策后消化 */
async function deliverFeedbackGateBranch(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const gate = state.gate
  if (!gate) return waitAsWatching(platform, taskId)
  if (gate.status === 'raised') return waitAsWatching(platform, taskId)
  const decision = gate.decision
  const ds = await loadDeliveryState(platform, taskId)
  if (decision?.action === 'rollback') {
    for (const f of ds.feedback) if (f.status === 'gate-raised') f.status = 'queued-fix'
    await saveDeliveryState(platform, taskId, ds)
    return rollbackStage(platform, taskId, decision.rollbackTarget ?? 'execute', `MR 反馈需人决策：${decision.reason ?? ''}`)
  }
  if (decision && (decision.action === 'approve' || decision.action === 'answer')) {
    for (const f of ds.feedback) if (f.status === 'gate-raised') f.status = 'waived'
    await saveDeliveryState(platform, taskId, ds)
    await platform.store.eventLog(taskId).append(taskId, 'execute', { type: 'human', userId: decision.decidedBy, name: decision.decidedByName }, 'assistant_message', {
      text: `反馈 waived（不采纳，留痕）：${decision.reason ?? decision.answer ?? ''}`,
    })
    // 决策已消化：清除已决门（否则 watcher 的就绪检测被 decided 门卡住，交付门永不举起）
    await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'digest-feedback-gate' } }, (s) => {
      if (s.gate?.gateId === gate.gateId) s.gate = null
    })
    return waitAsWatching(platform, taskId)
  }
  // 超时降级（decision=null）：门保留展示待追认；反馈未消化 → 就绪 fail-closed（不举交付门，铁门不代答）
  return waitAsWatching(platform, taskId)
}

/** 执行段 · 交付小节（MR 材料 → 一仓一 MR → 监听态；再交付=修复后重推新 SHA） */
async function executeDeliverPart(ctx: WorkerCtx): Promise<WorkerOutcome> {
  const { platform, state } = ctx
  const taskId = state.taskId
  const fresh = await platform.store.load(taskId)

  const ddir = deliveryDirOf(platform.store.taskDir(taskId))

  if (!fresh.mr) {
    // 首次交付：生成 MR 材料 → 提交 → 建 MR（一仓一 MR）→ 监听态
    const res = await runEngine(platform, fresh, 'deliver', {
      purpose: '生成交付材料（MR 描述 + 证据索引）',
      vars: { title: fresh.title },
    })
    await clearStageOutput(platform, taskId, 'deliver')
    if (res.interrupted) return 'wait'
    if (res.failed) return failTask(platform, taskId, `交付材料生成失败：${res.failureSummary ?? ''}`)

    const branch = `feature/task-${fresh.seq}`
    await ensureBranch(ddir, branch)
    const sha = await commitAll(ddir, `feat: ${fresh.title} (task#${fresh.seq})`)
    if (!sha) return failTask(platform, taskId, '交付提交失败：无变更可提交（fail-closed，不空跑 MR）')

    const mr = await platform.mrPlatform.createMr({
      repo: fresh.repo,
      branch,
      sha,
      title: `#${fresh.seq} ${fresh.title}`,
      participants: { reviewer: fresh.people.reviewer.name, approver: fresh.people.owner.name, merger: fresh.people.merger.name },
    })
    await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'create-mr' } }, (s) => {
      s.mr = { mrId: mr.mrId, url: `mock-codehub:///${mr.mrId}`, branch, sha, repo: fresh.repo, title: mr.title }
      s.status = 'watching'
    })
    await platform.store.eventLog(taskId).append(taskId, 'execute', { type: 'system' }, 'assistant_message', {
      text: `MR ${mr.mrId} 已创建（一仓一 MR）：进入监听态（非终态）。合入条件：反馈全消化 + 远端流水线真绿 + 合入方拍板。`,
    })
    await platform.notifications.notify({
      taskId,
      taskSeq: fresh.seq,
      kind: 'mr-watching',
      priority: 'normal',
      title: `任务#${fresh.seq} 进入 MR 监听态`,
      body: `${mr.mrId}：反馈聚合 / 分诊 / 重验将由平台值守，合入永远人工。`,
      audience: fresh.people.owner.userId,
      dedupKey: `mr-watch-${mr.mrId}`,
    })
    await platform.syncArtifacts(taskId) // MR 描述等交付材料落索引 + artifact_written 留痕
    return 'wait'
  }

  // 再交付（修复后重推）：提交新 SHA → 旧证据失效（SHA 校验）→ 已修复反馈标记
  const ds = await loadDeliveryState(platform, taskId)
  const oldSha = fresh.mr.sha
  const sha = await commitAll(ddir, `fix: 反馈修复 (task#${fresh.seq})`)
  if (!sha) {
    return waitAsWatching(platform, taskId)
  }
  for (const e of ds.evidence) if (e.sha === oldSha) e.stale = true
  for (const f of ds.feedback) if (f.sha === oldSha && (f.status === 'queued-fix' || f.status === 'fixing')) f.status = 'fixed'
  await saveDeliveryState(platform, taskId, ds)
  await platform.mrPlatform.updateSha(fresh.mr.mrId, sha)
  await platform.store.mutate(taskId, { expectedVersion: null }, (s) => {
    if (s.mr) s.mr.sha = sha
    s.status = 'watching'
  })
  await platform.store.eventLog(taskId).append(taskId, 'execute', { type: 'system' }, 'assistant_message', {
    text: `修复已推送：SHA ${sha.slice(0, 8)}。旧 SHA 证据已失效（SHA 校验），等待远端流水线重跑。`,
  })
  return 'wait'
}

async function waitAsWatching(platform: Platform, taskId: string): Promise<WorkerOutcome> {
  await platform.store.mutate(taskId, { expectedVersion: null }, (s) => {
    if (s.stage === 'execute') s.status = 'watching'
  })
  return 'wait'
}

async function doMerge(platform: Platform, taskId: string): Promise<WorkerOutcome> {
  const st = await platform.store.load(taskId)
  if (!st.mr) return 'stop'
  await platform.mrPlatform.merge(st.mr.mrId)
  await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'merge' } }, (s) => {
    applyAdvance(s, 'merged') // execute → merged：完成集收口 + 清门
    s.status = 'merged'
  })
  await platform.store.eventLog(taskId).append(taskId, 'execute', { type: 'system' }, 'stage_exited', {
    stage: 'execute',
    reason: 'completed',
    round: st.stageRounds['execute'] ?? 1,
  })
  await platform.notifications.notify({
    taskId,
    taskSeq: st.seq,
    kind: 'merged',
    priority: 'high',
    title: `任务#${st.seq} 已合入（终态）`,
    body: `MR ${st.mr.mrId} 由 ${st.people.merger.name} 拍板合入；工作区回收归档。`,
    audience: st.people.owner.userId,
    dedupKey: `merged-${st.mr.mrId}`,
  })
  await platform.notifications.notify({
    taskId,
    taskSeq: st.seq,
    kind: 'merged',
    priority: 'normal',
    title: `任务#${st.seq} 已合入`,
    body: '需求已交付，感谢确认业务事实。',
    audience: st.people.requester.userId,
    dedupKey: `merged-req-${st.mr.mrId}`,
  })

  // 技能沉淀（场景10）：合入后从执行证据提炼候选（不自动生效，人采纳）
  await platform.distillSkills(taskId)

  // AR 子任务合入钩子：回写父任务聚合进度（幂等；全 merged 时举聚合验收门）
  if (st.parentTaskId) {
    await checkParentAggregation(platform, st.parentTaskId).catch(() => undefined)
  }
  return 'stop'
}

// ==================== 公共流转 ====================

async function advanceStage(platform: Platform, taskId: string, to: StageId): Promise<WorkerOutcome> {
  const log = platform.store.eventLog(taskId)
  const from = prevOf(to)
  const { state } = await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: `advance:${to}` } }, (s) => {
    applyAdvance(s, to)
  })
  // 进入执行段：清段内检查点（防御旧残留；正常路径无检查点文件）
  if (to === 'execute') await clearExecutePhase(platform, taskId)
  await log.append(taskId, from, { type: 'system' }, 'stage_exited', {
    stage: from,
    reason: 'completed',
    round: state.stageRounds[from] ?? 1,
  })
  await log.append(taskId, to, { type: 'system' }, 'stage_entered', {
    stage: to,
    reentry: isReentry(state, to),
    round: state.stageRounds[to] ?? 1,
  })
  platform.bus.emit({ type: 'stage', taskId, state })
  return 'continue'
}

async function rollbackStage(platform: Platform, taskId: string, target: StageId, reason: string, directives: string[] = []): Promise<WorkerOutcome> {
  const log = platform.store.eventLog(taskId)
  const before = await platform.store.load(taskId)
  const from = before.stage
  const { state } = await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: `rollback:${target}` } }, (s) => {
    if (!canRollbackTo(s.stage, target)) {
      throw new Error(`非法回退边：${s.stage} → ${target}`)
    }
    applyRollback(s, target, reason)
    s.pendingInstructions.push(...directives, reason)
  })
  await log.append(taskId, from, { type: 'system' }, 'rollback', {
    from,
    to: target,
    reason,
    declaredBy: 'platform',
    declaredByName: '平台',
    reentrySkipsAiRerun: isReentry(state, target),
  })
  await log.append(taskId, state.stage, { type: 'system' }, 'stage_entered', {
    stage: state.stage,
    reentry: true,
    round: state.stageRounds[state.stage] ?? 1,
  })
  // 段内检查点归位：回退进执行段 → 回到编码小节（修复模式，轨道标记清空重跑开发轨）；回退出执行段 → 清检查点
  if (target === 'execute') {
    await saveExecutePhase(platform, taskId, 'code')
    await clearRailMarkers(platform, taskId) // 修复轮重跑开发轨；测试轨按需重跑（产物派生自测试 SPEC，重生成幂等）
  } else await clearExecutePhase(platform, taskId)
  platform.bus.emit({ type: 'stage', taskId, state })
  return 'continue'
}

function prevOf(stage: StageId): StageId {
  const order: StageId[] = [...STAGE_ORDER]
  const i = order.indexOf(stage)
  return order[Math.max(0, i - 1)]
}

async function failTask(platform: Platform, taskId: string, reason: string, notifyKind: 'build-failed' | 'repair-exceeded' | undefined = undefined): Promise<WorkerOutcome> {
  const st = await platform.store.load(taskId)
  await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'fail' } }, (s) => {
    s.status = 'failed'
    s.lifecycleNote = 'failed'
  })
  await platform.store.eventLog(taskId).append(taskId, st.stage, { type: 'system' }, 'health_changed', {
    from: st.health.level,
    to: 'red',
    facts: [reason],
  })
  await platform.notifications.notify({
    taskId,
    taskSeq: st.seq,
    kind: notifyKind ?? 'build-failed',
    priority: 'critical',
    title: `任务#${st.seq} 停止待修复（反幻觉：不假装通过）`,
    body: reason,
    audience: st.people.owner.userId,
    dedupKey: `fail-${taskId}-${Date.now()}`,
    force: true,
  })
  platform.bus.emit({ type: 'state', taskId })
  return 'stop'
}

async function appendDecisionRecord(platform: Platform, taskId: string, record: { topic: string; decision: string; degraded?: boolean; ts: string }): Promise<void> {
  const file = path.join(platform.store.taskDir(taskId), 'process', 'decisions.json')
  await appendDecisionRecordFile(file, record)
  // 决策追记变更了 decisions.json → 本阶段内落索引（变更留痕记本阶段账，不等下一阶段补记）
  await platform.syncArtifacts(taskId)
}

async function consumeInstructions(platform: Platform, taskId: string): Promise<string[]> {
  let out: string[] = []
  await platform.store.mutate(taskId, { expectedVersion: null }, (s) => {
    out = s.pendingInstructions
    s.pendingInstructions = []
  })
  return out
}

export function renderContractView(c: unknown): string {
  // 契约单源的派生视图：忠实渲染引擎写的真源内容，不预设单一形态。
  // 实测三种形态并存（task-121 对象映射 {接口名:{methods}} / 早期数组
  // [{id,method,path}] / task-122 完全另形无 interfaces）——视图层全部兼容。
  const contract = (c && typeof c === 'object' ? c : {}) as { version?: string; service?: string; interfaces?: unknown }
  const lines: string[] = [
    `# 契约视图（只读派生 · 单源 api-contract.json v${contract.version ?? '?'}）`,
    '',
    `- 服务：${contract.service ?? '-'}`,
    '',
  ]
  const ifaces = contract.interfaces
  if (Array.isArray(ifaces)) {
    for (const item of ifaces) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, unknown>
      if (typeof it.method === 'string' && typeof it.path === 'string') {
        lines.push(`- \`${it.method} ${it.path}\`（${String(it.id ?? '-')}${typeof it.description === 'string' ? `：${it.description}` : ''}）`)
      } else {
        const name = String(it.id ?? it.name ?? '未命名接口')
        lines.push(`- **${name}**（${String(it.layer ?? 'domain')}）${typeof it.description === 'string' ? `：${it.description}` : ''}`)
        pushMethodLines(lines, it.methods)
      }
    }
  } else if (ifaces && typeof ifaces === 'object') {
    // 对象映射形态：{ 接口名: { description, layer, methods: { 名: { signature, ... } } } }
    for (const [name, val] of Object.entries(ifaces as Record<string, unknown>)) {
      const it = val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {}
      lines.push(`- **${name}**（${String(it.layer ?? 'domain')}）${typeof it.description === 'string' ? `：${it.description}` : ''}`)
      pushMethodLines(lines, it.methods)
    }
  } else if (ifaces != null) {
    lines.push(`- （interfaces 形态未识别（${typeof ifaces}），以单源原文为准）`)
  } else {
    lines.push('- （单源未声明 interfaces 字段，接口契约以 endpoints/其他字段为准，见单源原文）')
  }
  lines.push('', '> 本文件为派生视图：以 delivery/contract/api-contract.json 为唯一真源，漂移检测见 .contract-state.json')
  return lines.join('\n')
}

function pushMethodLines(lines: string[], methods: unknown): void {
  if (!methods || typeof methods !== 'object' || Array.isArray(methods)) return
  for (const [mn, m] of Object.entries(methods as Record<string, unknown>)) {
    const mm = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {}
    const sig = typeof mm.signature === 'string' ? mm.signature : ''
    lines.push(`  - \`${mn}${sig}\`${typeof mm.description === 'string' ? ` — ${mm.description}` : ''}`)
  }
}
