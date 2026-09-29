import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { TaskState } from '@ai-platform/shared'
import { personOf } from '@ai-platform/shared'
import { KeyedMutex, nowIso, readJson, writeJson } from '../domain/util.js'
import { raiseGate } from './gates.js'
import type { Platform } from './platform.js'

/**
 * AR 级并行（研发作业流 · 执行段拆分）
 *
 * 父任务评审门通过后：owner 拍板「AR 拆分门」→ 按原子需求 spawn 子任务并行执行
 * （复用调度器并发槽；子任务拷贝父任务设计产物，从 execute 段编码小节起跑）→
 * 父任务转 aggregating（不占槽）→ 子任务各自走 编码→验证→MR→合入 →
 * watcher（tick 扫 + doMerge 钩子）观察全 merged → 举聚合验收门（TSE 拍板）→ 父任务收口 merged。
 *
 * 语义事件：subtask_spawned / subtask_completed（落到父任务流，全程可回溯）。
 */

/** AR 承接开发轮转池（作业逻辑：开发 ×4，按序轮转分配子任务责任人） */
export const AR_DEV_POOL = ['wanghao', 'liuyang', 'chenjing', 'xulei']

/** 子任务从父任务交付区继承的设计产物 */
const INHERITED_DELIVERY = ['architecture.md', 'spec.md', 'design.md', 'test-design.md']
const INHERITED_PROCESS = ['clarify-ir-sr-ar.md', 'decisions.json', 'baseline.md']

export interface ArItem {
  title: string
  summary: string
  acceptance?: string
}

export interface ArPlanFile {
  plannedAt: string
  items: ArItem[]
}

export async function loadArPlan(platform: Platform, taskId: string): Promise<ArItem[]> {
  const plan = await readJson<ArPlanFile>(path.join(platform.store.flowDir(taskId), 'ar-plan.json'))
  return plan?.items ?? []
}

/**
 * 派发子任务：每个 AR 一个任务（同模块/仓/playbook/引擎/剧本；责任人从开发池轮转）。
 * 子任务 startHeld 创建（防调度竞态：先物化到 code 阶段再入队）。
 */
export async function spawnSubtasks(platform: Platform, parent: TaskState, items: ArItem[]): Promise<TaskState[]> {
  const children: TaskState[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const ownerId = AR_DEV_POOL[i % AR_DEV_POOL.length]
    const child = await platform.createTask(
      {
        title: `[AR${i + 1}] ${it.title}`,
        requirementText: `${it.summary}${it.acceptance ? `（验收：${it.acceptance}）` : ''}`,
        module: parent.module,
        repo: parent.repo,
        mode: parent.mode,
        playbookId: parent.playbookId,
        people: {
          requesterId: parent.people.requester.userId,
          ownerId,
          designerId: parent.people.designer.userId,
          architectId: parent.people.architect?.userId,
          tseId: parent.people.tse?.userId,
          reviewerId: parent.people.reviewer.userId,
          mergerId: parent.people.merger.userId,
        },
        unattended: parent.unattended,
        engineId: parent.engineId,
        scenario: parent.scenario,
        arParallel: false,
      },
      { startHeld: true },
    )

    // 拷贝父任务设计产物（交付区）与澄清基线（过程区）——子任务按同一设计并行编码
    const parentDir = platform.store.taskDir(parent.taskId)
    const childDir = platform.store.taskDir(child.taskId)
    for (const rel of INHERITED_DELIVERY) {
      const src = path.join(parentDir, 'delivery', rel)
      if (await fs.stat(src).catch(() => null)) await fs.copyFile(src, path.join(childDir, 'delivery', rel))
    }
    await fs.cp(path.join(parentDir, 'delivery', 'contract'), path.join(childDir, 'delivery', 'contract'), { recursive: true }).catch(() => undefined)
    for (const rel of INHERITED_PROCESS) {
      const src = path.join(parentDir, 'process', rel)
      if (await fs.stat(src).catch(() => null)) await fs.copyFile(src, path.join(childDir, 'process', rel))
    }

    // 物化到执行段：阶段=execute、完成集=设计段全过，原子化入队（与调度器无竞态）
    await platform.store.mutate(
      child.taskId,
      { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'spawn-subtask' } },
      (s) => {
        s.parentTaskId = parent.taskId
        s.arTitle = it.title
        s.stage = 'execute'
        s.currentStepIndex = 5
        s.completedStages = ['requirement', 'architecture', 'design', 'test-design']
        s.stageRounds = { requirement: 1, architecture: 1, design: 1, 'test-design': 1, execute: 1 }
        s.pendingInstructions.push(
          `本任务是父任务 #${parent.seq}「${parent.title}」的 AR 拆分子任务（AR${i + 1}/${items.length}，责任人 ${personOf(ownerId).name}）。` +
            `实现范围=「${it.title}」；架构/功能/测试设计产物已拷贝至本任务交付区，按设计实现（含 UT）；MST 由验证小节统一执行。`,
        )
        s.status = 'queued'
      },
    )
    // 阶段时间轴：子任务从执行段起跑（设计段由父任务完成，子任务事件流不含设计段段段）
    await platform.store.eventLog(child.taskId).append(child.taskId, 'execute', { type: 'system' }, 'stage_entered', {
      stage: 'execute',
      reentry: false,
      round: 1,
    })
    await platform.store.eventLog(child.taskId).append(child.taskId, 'execute', { type: 'system' }, 'subtask_spawned', {
      parentTaskId: parent.taskId,
      subtaskTaskId: child.taskId,
      arTitle: it.title,
      index: i + 1,
      totalSubtasks: items.length,
      ownerName: personOf(ownerId).name,
    })
    await platform.syncArtifacts(child.taskId)
    children.push(child)
  }

  // 父任务：登记子任务清单 → 转聚合等待（不占并发槽）
  await platform.store.mutate(
    parent.taskId,
    { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'subtasks-spawned' } },
    (s) => {
      s.subtasks = children.map((c, i) => ({
        taskId: c.taskId,
        arTitle: items[i].title,
        ownerName: personOf(AR_DEV_POOL[i % AR_DEV_POOL.length]).name,
        status: 'queued' as const,
      }))
      s.gate = null
      s.status = 'aggregating'
    },
  )
  const plog = platform.store.eventLog(parent.taskId)
  for (let i = 0; i < children.length; i++) {
    await plog.append(parent.taskId, 'execute', { type: 'system' }, 'subtask_spawned', {
      parentTaskId: parent.taskId,
      subtaskTaskId: children[i].taskId,
      arTitle: items[i].title,
      index: i + 1,
      totalSubtasks: children.length,
      ownerName: personOf(AR_DEV_POOL[i % AR_DEV_POOL.length]).name,
    })
  }
  await plog.append(parent.taskId, 'execute', { type: 'system' }, 'assistant_message', {
    text: `AR 拆分已派发：${children.length} 个子任务并行执行（${children.map((c, i) => `AR${i + 1}→${personOf(AR_DEV_POOL[i % AR_DEV_POOL.length]).name}`).join('、')}）。父任务转入聚合等待（不占并发槽），全 部合入后举聚合验收门（TSE 拍板）。`,
  })
  await platform.kick()
  return children
}

/**
 * 聚合检查（幂等；tick 扫描 + 子任务 doMerge 钩子双入口，重启可恢复）：
 *  - 回写子任务最新状态到父任务清单（subtask_completed 落父事件流）
 *  - 全部 merged → 举聚合验收门（test 类，TSE 拍板；铁门超时只升级）
 *  - 任一 failed → 升级通知责任人（不自动处置，人在环）
 *
 * 按父任务串行化（KeyedMutex）：多个子任务几乎同时合入时，防止并发调用
 * 各持过期快照回写（子任务状态回退 / subtask_completed 事件重复）。
 */
const aggMutex = new KeyedMutex()

export async function checkParentAggregation(platform: Platform, parentTaskId: string): Promise<void> {
  return aggMutex.run(parentTaskId, () => checkParentAggregationUnsafe(platform, parentTaskId))
}

async function checkParentAggregationUnsafe(platform: Platform, parentTaskId: string): Promise<void> {
  const parent = await platform.store.loadOrNull(parentTaskId)
  if (!parent || parent.status !== 'aggregating' || !parent.subtasks?.length) return

  const log = platform.store.eventLog(parentTaskId)
  let mergedCount = 0
  let failed: { arTitle: string; taskId: string } | null = null
  let changed = false
  const fresh: typeof parent.subtasks = []
  for (const ref of parent.subtasks) {
    const st = await platform.store.loadOrNull(ref.taskId)
    const status = st?.status ?? ref.status
    if (ref.status !== status) changed = true
    if (status === 'merged' || status === 'archived') {
      if (ref.status !== 'merged' && ref.status !== 'archived') {
        await log.append(parentTaskId, 'execute', { type: 'system' }, 'subtask_completed', {
          parentTaskId,
          subtaskTaskId: ref.taskId,
          arTitle: ref.arTitle,
          mergedCount: mergedCount + 1,
          totalSubtasks: parent.subtasks.length,
        })
      }
      mergedCount += 1
    } else if (status === 'failed' && !failed) {
      failed = { arTitle: ref.arTitle, taskId: ref.taskId }
    }
    fresh.push({ ...ref, status })
  }
  if (changed) {
    await platform.store.mutate(
      parentTaskId,
      { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'aggregate-refresh' } },
      (s) => {
        s.subtasks = fresh
      },
    )
  }

  if (failed) {
    await platform.notifications.notify({
      taskId: parentTaskId,
      taskSeq: parent.seq,
      kind: 'health-warn',
      priority: 'high',
      title: `任务#${parent.seq} AR 子任务失败，需人工介入`,
      body: `子任务「${failed.arTitle}」（${failed.taskId}）已停止/升级。父任务保持聚合等待，处置后继续聚合。`,
      audience: parent.people.owner.userId,
      dedupKey: `ar-failed-${failed.taskId}`,
    })
    return
  }

  if (mergedCount === parent.subtasks.length) {
    // 全部合入 → 聚合验收门（TSE 拍板；test 类铁门，超时只升级不代答）
    const decider = parent.people.tse ?? parent.people.owner
    await raiseGate(platform, parentTaskId, {
      kind: 'test',
      question: `AR 聚合验收：${parent.subtasks.length} 个子任务已全部合入，是否验收通过并收口父任务？`,
      digest: 'AR 并行执行全部合入（各子任务 MR 流水线真绿）；TSE 验收父任务整体交付',
      preface: '子任务各自完成 编码→验证→MR→合入（见子任务清单与各 MR）；父任务交付=设计产物集 + AR 拆分谱系。',
      context: '验收通过则父任务收口（TTM 停表）；不通过则清空拆分重新派发（修复轮 +1）。',
      materials: parent.subtasks.map((s) => ({
        ref: s.taskId,
        label: `${s.taskId} · ${s.arTitle}（${s.ownerName}）`,
        kind: 'evidence' as const,
        content: `子任务 ${s.taskId} 状态：${s.status}`,
      })),
      options: [
        { action: 'approve', label: '验收通过，父任务收口', tone: 'primary' },
        { action: 'rollback', rollbackTarget: 'execute', label: '不通过：清空拆分重新派发', tone: 'danger' },
      ],
      soleDecider: decider,
    })
  }
}

/** 聚合验收通过 → 父任务收口（阶段直达终态；代码交付在各子任务 MR，父交付=设计产物集+谱系） */
export async function closeParentMerged(platform: Platform, taskId: string): Promise<'stop'> {
  const st = await platform.store.load(taskId)
  await platform.store.mutate(
    taskId,
    { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'merge' } },
    (s) => {
      if (!s.completedStages.includes('execute')) s.completedStages.push('execute')
      s.stage = 'merged'
      s.currentStepIndex = 6
      s.stageRounds.merged = 1
      s.gate = null
      s.status = 'merged'
    },
  )
  const log = platform.store.eventLog(taskId)
  await log.append(taskId, 'execute', { type: 'system' }, 'stage_exited', {
    stage: 'execute',
    reason: 'completed',
    round: st.stageRounds['execute'] ?? 1,
  })
  await log.append(taskId, 'merged', { type: 'system' }, 'assistant_message', {
    text: `AR 聚合验收通过：${st.subtasks?.length ?? 0} 个子任务全部合入，父任务收口（父交付=架构/功能/测试设计产物集 + AR 谱系；代码交付见各子任务 MR）。`,
  })
  await platform.notifications.notify({
    taskId,
    taskSeq: st.seq,
    kind: 'merged',
    priority: 'high',
    title: `任务#${st.seq} AR 并行交付完成（聚合验收通过）`,
    body: `${st.subtasks?.length ?? 0} 个 AR 子任务全部合入。全流程可回溯：${taskId} 事件流含完整拆分/完成谱系。`,
    audience: st.people.requester.userId,
    dedupKey: `merged-parent-${taskId}`,
  })
  await platform.distillSkills(taskId)
  return 'stop'
}

/** 持久化 AR 拆分方案（拆分门拍板时读取；stage-output 会被阶段清理） */
export async function saveArPlan(platform: Platform, taskId: string, items: ArItem[]): Promise<void> {
  await writeJson(path.join(platform.store.flowDir(taskId), 'ar-plan.json'), { plannedAt: nowIso(), items })
}
