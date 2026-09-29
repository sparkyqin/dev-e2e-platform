import type { GateInstance, GateKind, GateMaterial, GateOption, PersonRef, RollbackTarget, TaskState } from '@ai-platform/shared'
import { GATE_META, STAGES } from '@ai-platform/shared'
import { newId, nowIso } from '../domain/util.js'
import type { Platform } from './platform.js'

/**
 * 门禁服务（L2 · [机-门禁·四类门] / [机-反盲签决策卡] / [机-会诊单拍板] / [机-超时升级] / [机-铁门永不代答]）
 */

export class GateError extends Error {
  constructor(
    message: string,
    public code: 'not-found' | 'not-raised' | 'not-decider' | 'not-ready' | 'invalid' = 'invalid',
  ) {
    super(message)
    this.name = 'GateError'
  }
}

export interface RaiseGateSpec {
  kind: GateKind
  question: string
  digest: string
  preface: string
  context: string
  materials: GateMaterial[]
  options: GateOption[]
  soleDecider: PersonRef
  /** 覆盖默认超时（playbook 提供） */
  timeoutMs?: number
}

export async function raiseGate(platform: Platform, taskId: string, spec: RaiseGateSpec): Promise<GateInstance> {
  const store = platform.store
  const log = store.eventLog(taskId)
  const state = await store.load(taskId)
  const pb = platform.playbooks.get(state.playbookId)

  // 阶段注册表机械校验（单源纪律）：门举不起来，除非阶段注册表已声明——
  // 新增/变更门必须先改 packages/shared/src/stages.ts 的 exitGates，消灭「改一处漏一处」的漂移
  const declared = STAGES[state.stage].exitGates
  if (!declared.some((g) => g.kind === spec.kind)) {
    throw new GateError(
      `阶段「${STAGES[state.stage].label}」未声明 ${spec.kind} 门：请先在 packages/shared/src/stages.ts 的 exitGates 声明（阶段注册表单源）`,
      'invalid',
    )
  }

  const gate: GateInstance = {
    gateId: newId('gate'),
    kind: spec.kind,
    taskId,
    stage: state.stage,
    question: spec.question,
    digest: spec.digest,
    preface: spec.preface,
    context: spec.context,
    materials: spec.materials,
    options: spec.options,
    soleDecider: { userId: spec.soleDecider.userId, name: spec.soleDecider.name, role: 'sole-decider' },
    participants: [{ userId: spec.soleDecider.userId, name: spec.soleDecider.name, role: 'sole-decider' }],
    raisedAt: nowIso(),
    timeoutMs: spec.timeoutMs ?? pb.customizable.gateTimeoutMs[spec.kind],
    escalated: false,
    status: 'raised',
    decision: null,
  }

  const { state: after } = await store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: `raise-gate:${spec.kind}` } }, (s) => {
    s.gate = gate
    s.status = 'gate-wait'
  })

  await log.append(taskId, gate.stage, { type: 'system' }, 'gate_raised', {
    gateId: gate.gateId,
    gateKind: gate.kind,
    question: gate.question,
    digest: gate.digest,
  })

  // 通知拍板人（深链直达 + request_digest；防重复 + 安静时段合并）
  await platform.notifications.notify({
    taskId,
    taskSeq: after.seq,
    kind: 'gate-raised',
    priority: spec.kind === 'delivery' ? 'high' : 'normal',
    title: `任务#${after.seq} ${GATE_META[spec.kind].label}待你处理`,
    body: `${spec.digest}（决策卡已同屏 preface/context/材料，反盲签）`,
    audience: spec.soleDecider.userId,
    dedupKey: `gate-${gate.gateId}`,
  })

  return gate
}

export interface DecideInput {
  gateId?: string
  stateVersion: number
  action: 'approve' | 'reject' | 'answer' | 'rollback' | 'merge'
  answer?: string
  rollbackTarget?: RollbackTarget
  reason?: string
  asUserId: string
}

export async function decideGate(platform: Platform, taskId: string, input: DecideInput): Promise<TaskState> {
  const store = platform.store
  const log = store.eventLog(taskId)

  // fail-closed 预检在 mutate 外完成（mutator 必须是同步纯函数）
  let deliveryReadiness: Awaited<ReturnType<typeof platform.mergeReadiness>> | null = null
  {
    const cur = await store.load(taskId)
    if (cur.gate?.kind === 'delivery' && input.action === 'merge') {
      deliveryReadiness = await platform.mergeReadiness(taskId)
    }
  }

  const { state: after } = await store.mutate(
    taskId,
    {
      expectedVersion: input.stateVersion,
      audit: { actor: input.asUserId, actorName: input.asUserId, action: `decide-gate:${input.action}` },
    },
    (s) => {
      const gate = s.gate
      if (!gate) throw new GateError('当前无门', 'not-found')
      if (input.gateId && gate.gateId !== input.gateId) throw new GateError('门已更新', 'not-found')
      if (gate.status !== 'raised') throw new GateError(`门状态为 ${gate.status}，不可决策`, 'not-raised')

      // 拍板权唯一：sole-decider 或管理员（代拍板留痕）；会诊参与者无拍板权
      const isAdmin = input.asUserId === 'admin'
      const isDecider = gate.soleDecider.userId === input.asUserId
      if (!isDecider && !isAdmin) {
        throw new GateError(
          `拍板权唯一：本门由 ${gate.soleDecider.name} 拍板（会诊不拍板；管理员可代拍板留痕）`,
          'not-decider',
        )
      }

      // 门类校验
      const meta = GATE_META[gate.kind]
      if (gate.kind === 'fact' && input.action === 'answer' && !input.answer?.trim()) {
        throw new GateError('事实门作答不能为空')
      }
      if (input.action === 'rollback' && !input.rollbackTarget) {
        throw new GateError('声明式回退必须指定回退目标')
      }
      if (gate.kind === 'delivery' && input.action === 'merge') {
        // fail-closed：合入前复核就绪条件（流水线真绿 + 反馈全消化）
        if (!deliveryReadiness?.ready) {
          throw new GateError(`不可合入（fail-closed）：${deliveryReadiness?.blockers.join('；') ?? '就绪条件未满足'}`, 'not-ready')
        }
      }
      if (gate.kind === 'delivery' && input.action === 'approve') {
        throw new GateError('交付门只有「合入」动作（永远人工）')
      }

      gate.status = 'decided'
      gate.decision = {
        action: input.action,
        answer: input.answer,
        rollbackTarget: input.rollbackTarget,
        reason: input.reason,
        decidedBy: input.asUserId,
        decidedByName: isDecider ? gate.soleDecider.name : '管理员（代拍板）',
        decidedAt: nowIso(),
        stateVersion: s.stateVersion,
        onBehalf: !isDecider,
      }
      // 门解除 → 重新入队（容器重建恢复；runner 将按决策继续）
      s.status = 'queued'
    },
  )

  const gate = after.gate!
  await log.append(taskId, gate.stage, { type: 'human', userId: input.asUserId, name: gate.decision?.decidedByName }, 'gate_decided', {
    gateId: gate.gateId,
    action: gate.decision!.action,
    decidedBy: gate.decision!.decidedBy,
    decidedByName: gate.decision!.decidedByName,
  })

  // 驳回/回退：通知责任人返工（声明式回退目标明确）
  if (gate.decision!.action === 'rollback' || gate.decision!.action === 'reject') {
    await platform.notifications.notify({
      taskId,
      taskSeq: after.seq,
      kind: 'gate-raised',
      priority: 'high',
      title: `任务#${after.seq} 被驳回，需返工`,
      body: `${gate.soleDecider.name} 驳回并声明式回退到「${gate.decision!.rollbackTarget ?? '上游'}」：${gate.decision!.reason ?? '无理由'}`,
      audience: after.people.owner.userId,
      dedupKey: `rollback-${gate.gateId}`,
    })
  }

  return after
}

/** 会诊邀请（isInvitedReviewParticipant：可看可批注，不拍板） */
export async function inviteParticipant(platform: Platform, taskId: string, userId: string, name: string, asUserId: string): Promise<TaskState> {
  const store = platform.store
  const { state } = await store.mutate(
    taskId,
    { expectedVersion: null, audit: { actor: asUserId, actorName: asUserId, action: 'invite-participant' } },
    (s) => {
      if (!s.gate || s.gate.status !== 'raised') throw new GateError('当前无待决策门', 'not-found')
      if (s.gate.participants.some((p) => p.userId === userId)) return
      s.gate.participants.push({ userId, name, role: 'consulted' })
    },
  )
  if (state.gate) {
    await platform.notifications.notify({
      taskId,
      taskSeq: state.seq,
      kind: 'gate-raised',
      priority: 'normal',
      title: `任务#${state.seq} 邀请你参与会诊（${GATE_META[state.gate.kind].label}）`,
      body: '会诊意见可冲突，拍板权唯一（你不拍板，可批注）',
      audience: userId,
      dedupKey: `consult-${state.gate.gateId}-${userId}`,
    })
  }
  return state
}

/**
 * 门超时处理（[机-超时升级] / 事实门超时降级）：
 *  - review/test → 升级通知（不自动放行）
 *  - fact → 降级：用默认假设推进非阻塞部分 + 待人工追认（不替答事实）
 *  - delivery → 永不超时放行
 */
export async function checkGateTimeouts(platform: Platform, now = Date.now()): Promise<void> {
  const states = await platform.store.listAll()
  for (const s of states) {
    const gate = s.gate
    if (!gate || gate.status !== 'raised' || gate.timeoutMs <= 0) continue
    if (now - Date.parse(gate.raisedAt) < gate.timeoutMs) continue
    const meta = GATE_META[gate.kind]

    if (meta.timeoutPolicy === 'escalate' && !gate.escalated) {
      await platform.store.mutate(s.taskId, { expectedVersion: null }, (st) => {
        if (st.gate?.gateId === gate.gateId) {
          st.gate.escalated = true
          st.gate.escalatedAt = nowIso()
        }
      })
      await platform.notifications.notify({
        taskId: s.taskId,
        taskSeq: s.seq,
        kind: 'gate-escalated',
        priority: 'critical',
        title: `任务#${s.seq} ${meta.label}超时升级（不自动放行）`,
        body: `${gate.soleDecider.name} 超时未决策，已升级通知管理员。铁门永不代答。`,
        audience: 'admin',
        dedupKey: `escalate-${gate.gateId}`,
        force: true,
      })
    } else if (meta.timeoutPolicy === 'degrade') {
      // 事实门降级：默认假设推进非阻塞部分，标记待人工事后追认
      await platform.store.mutate(s.taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'gate-degraded' } }, (st) => {
        if (st.gate?.gateId !== gate.gateId || st.gate.status !== 'raised') return
        const pendingId = newId('pdc')
        st.gate.status = 'degraded'
        st.gate.degraded = {
          assumedAnswer: gate.degraded?.assumedAnswer ?? '默认假设（超时未答）',
          note: '不替答事实：待人工事后追认',
          at: nowIso(),
          pendingConfirmationId: pendingId,
        }
        st.pendingConfirmations.push({
          id: pendingId,
          gateId: gate.gateId,
          question: gate.question,
          assumedAnswer: '默认假设（超时未答）',
          raisedAt: nowIso(),
        })
        st.status = 'queued'
      })
      await platform.store.eventLog(s.taskId).append(s.taskId, gate.stage, { type: 'system' }, 'gate_decided', {
        gateId: gate.gateId,
        action: 'degrade',
        decidedBy: 'system',
        decidedByName: '平台（超时降级）',
      })
      await platform.notifications.notify({
        taskId: s.taskId,
        taskSeq: s.seq,
        kind: 'gate-escalated',
        priority: 'high',
        title: `任务#${s.seq} 事实门超时，已按默认假设推进`,
        body: '未替答事实：请在待追认清单中确认（决策卡入口见深链）',
        audience: gate.soleDecider.userId,
        dedupKey: `degrade-${gate.gateId}`,
      })
    }
  }
}
