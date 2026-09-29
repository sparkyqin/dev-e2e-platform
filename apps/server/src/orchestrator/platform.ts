import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Notification, StageId, TaskState } from '@ai-platform/shared'
import { STAGE_SOVEREIGNTY } from '@ai-platform/shared'
import { EventBus, KeyedMutex, newId, nowIso, readDecisionRecords, readJson, sleep, writeJson } from '../domain/util.js'
import { TaskStore } from '../domain/task-store.js'
import { computeHealth } from '../domain/health.js'
import { Projection } from '../runtime/projections.js'
import { Scheduler } from '../runtime/scheduler.js'
import { NotificationService } from '../runtime/notifications.js'
import { MrPlatform } from '../runtime/mr-platform.js'
import { PlaybookRegistry } from '../extension/playbooks.js'
import { SkillLibrary } from '../extension/skills.js'
import { KnowledgeBase } from '../extension/knowledge.js'
import { ArtifactManager, CONTRACT_PATH } from '../extension/artifacts.js'
import { EngineManager } from '../engine/manager.js'
import { TaskRunner } from './runner.js'
import { checkGateTimeouts } from './gates.js'
import { watchDelivery, computeReadiness } from './watcher.js'
import { checkParentAggregation } from './subtasks.js'
import { loadDeliveryState } from './workers.js'
import { loadInjections, saveInjections } from '../domain/event-log.js'
import { seedGreenfield, seedLegacyRepo } from '../runtime/legacy-seed.js'
import { deliveryDirOf, initRepo } from '../runtime/git.js'
import { HttpError } from '../api/auth.js'
import { appendDecisionRecordFile } from '../domain/util.js'
import type { CreateTaskRequest } from '@ai-platform/shared'
import { personOf } from '@ai-platform/shared'

/**
 * Platform —— 装配根（四层架构落位）
 *
 * L1 基础运行时：Scheduler / TaskStore(真源) / Projection(只读投影) / Notification / MrPlatform
 * L2 内核主干：状态机推进（workers/gates/watcher）+ 语义事件流 + 回退环
 * L3 能力扩展：PlaybookRegistry / SkillLibrary / KnowledgeBase / ArtifactManager / EngineManager
 * L4 交互作业：api/routes 消费本类暴露的服务
 */

export type BusEvent =
  | { type: 'event'; taskId: string; event: unknown }
  | { type: 'state'; taskId: string }
  | { type: 'stage'; taskId: string; state: TaskState }
  | { type: 'notification'; notification: Notification }

export class Platform {
  readonly store: TaskStore
  readonly scheduler: Scheduler
  readonly notifications: NotificationService
  readonly mrPlatform: MrPlatform
  readonly projection: Projection
  readonly playbooks: PlaybookRegistry
  readonly skills: SkillLibrary
  readonly knowledge: KnowledgeBase
  readonly engines = new EngineManager()
  readonly bus = new EventBus<BusEvent>()

  private runners = new Map<string, TaskRunner>()
  private sessionAborts = new Map<string, { ctrl: AbortController; reason: string }>()
  private tickTimer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(readonly dataDir: string, opts: { backend?: import('../domain/store-backend.js').StorageBackend } = {}) {
    const runtimeDir = path.join(dataDir, 'runtime')
    const assetsDir = path.join(dataDir, 'assets')
    this.store = new TaskStore(path.join(runtimeDir, 'tasks'), opts.backend)
    this.notifications = new NotificationService(path.join(runtimeDir, 'notifications.json'), {
      start: process.env.QUIET_HOURS_START ?? '22:00',
      end: process.env.QUIET_HOURS_END ?? '08:00',
    })
    this.mrPlatform = new MrPlatform(path.join(runtimeDir, 'mr-platform.json'))
    this.projection = new Projection(path.join(runtimeDir, 'projection.json'))
    this.playbooks = new PlaybookRegistry(path.join(assetsDir, 'playbooks'))
    this.skills = new SkillLibrary(assetsDir)
    this.knowledge = new KnowledgeBase(assetsDir)
    this.scheduler = new Scheduler(path.join(runtimeDir, 'scheduler.json'))

    this.scheduler.onStart = (taskId) => this.startTask(taskId)
    this.store.onWrite = (state) => {
      this.projection.writeThrough(state)
      this.bus.emit({ type: 'state', taskId: state.taskId })
    }
  }

  // ---------- 生命周期 ----------

  async init(): Promise<void> {
    await this.store.init()
    await Promise.all([
      this.notifications.init(),
      this.mrPlatform.init(),
      this.projection.init(),
      this.scheduler.init(),
      this.playbooks.init(),
      this.skills.init(),
    ])
    await this.recover()
    // 轮询间隔可配（测试用 TICK_MS=50 加速；默认 400ms）
    this.tickTimer = setInterval(() => void this.tick(), Number(process.env.TICK_MS ?? 400))
  }

  async dispose(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    for (const [, r] of this.runners) r.stop()
    // 等待在跑 runner 收敛（中断中的引擎会话尽快返回；兜底 5s/个）
    await Promise.all([...this.runners.values()].map((r) => r.done()))
    this.runners.clear()
    // 等在途 tick 收敛后再关存储（避免查询打到已关闭的池；兜底 5s）
    const deadline = Date.now() + 5000
    while (this.ticking && Date.now() < deadline) await sleep(20)
    await this.store.close()
  }

  /** 重启恢复（场景9 [机-重启恢复]）：状态在文件，按阶段矩阵恢复，不丢状态、不幻影交付 */
  private async recover(): Promise<void> {
    const all = await this.store.listAll()
    for (const s of all) {
      if (s.status === 'running') {
        // 重启时运行中任务回到队列（阶段可续跑；合入是远端动作，不会重复合入）
        await this.store.mutate(s.taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'recover' } }, (st) => {
          st.status = 'queued'
        })
      }
    }
    await this.projection.rebuild(all)
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await checkGateTimeouts(this)
      const all = await this.store.listAll()
      for (const s of all) {
        const listening = s.status === 'watching' || (s.status === 'gate-wait' && s.gate?.kind === 'delivery')
        if (listening) await watchDelivery(this, s.taskId).catch(() => undefined)
        // AR 聚合扫描（幂等；doMerge 钩子的兜底，重启可恢复）
        if (s.status === 'aggregating') await checkParentAggregation(this, s.taskId).catch(() => undefined)
      }
      await this.notifications.flushMorningDigest()
      // 重新拉取（watchDelivery 可能已改变状态），再调度
      const states = (await this.store.listAll()).map((s) => ({ taskId: s.taskId, status: s.status, createdAt: s.createdAt }))
      await this.scheduler.tick(states)
    } finally {
      this.ticking = false
    }
  }

  /** 手动触发一次调度（门解除/指令注入后立即生效） */
  async kick(): Promise<void> {
    await this.tick()
  }

  // ---------- 任务 ----------

  /** 建任务全局串行（进程内）：seq 分配 → 工作区落盘 → 真源落盘必须原子，否则并发建任务撞 seq 互相覆盖 */
  private createMutex = new KeyedMutex()

  async nextSeq(): Promise<number> {
    const all = await this.store.listAll()
    return all.reduce((m, s) => Math.max(m, s.seq), 99) + 1
  }

  async createTask(req: CreateTaskRequest, internal?: { startHeld?: boolean }): Promise<TaskState> {
    return this.createMutex.run('create-task', async () => {
      const seq = await this.nextSeq()
      const taskId = `task-${seq}`
    const taskDir = this.store.taskDir(taskId)
    const ddir = deliveryDirOf(taskDir)

    // 工作区三分区 + .flow
    for (const d of ['.flow', 'process', 'knowledge', 'host-skills']) await fs.mkdir(path.join(taskDir, d), { recursive: true })

    // 存量/绿地种子 + git 建仓（交付区即代码仓，过程区物理隔离在 git 之外）
    if (req.mode === 'greenfield') await seedGreenfield(ddir)
    else await seedLegacyRepo(ddir)
    await initRepo(ddir)

    const engineId = req.engineId ?? (await this.engines.defaultEngineId())
    const state: TaskState = {
      schemaVersion: 1,
      taskId,
      seq,
      title: req.title,
      module: req.module,
      repo: req.repo,
      requirementText: req.requirementText,
      mode: req.mode,
      paradigm: this.playbooks.get(req.playbookId).customizable.paradigm,
      playbookId: req.playbookId,
      stage: 'requirement',
      status: internal?.startHeld ? 'user-held' : 'queued',
      stateVersion: 1,
      currentStepIndex: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stageRounds: { requirement: 1 },
      completedStages: [],
      repairRounds: 0,
      unattended: req.unattended,
      autonomy: 'auto',
      arParallel: req.arParallel,
      people: {
        requester: personOf(req.people.requesterId ?? 'zhangming'),
        owner: personOf(req.people.ownerId ?? 'wanghao'),
        designer: personOf(req.people.designerId ?? 'liwan'),
        architect: personOf(req.people.architectId ?? 'chenshu'),
        tse: personOf(req.people.tseId ?? 'wuqian'),
        reviewer: personOf(req.people.reviewerId ?? 'zhaolei'),
        merger: personOf(req.people.mergerId ?? 'zhoujie'),
        admin: personOf('admin'),
      },
      engineId,
      gate: null,
      pendingInstructions: [],
      pendingConfirmations: [],
      mr: null,
      health: { level: 'green', facts: [] },
      artifacts: [],
      tokenUsage: { input: 0, output: 0, budget: 2_000_000 },
      scenario: req.scenario,
    }
    await this.store.create(state)
    await this.store.eventLog(taskId).append(taskId, 'requirement', { type: 'system' }, 'stage_entered', {
      stage: 'requirement',
      reentry: false,
      round: 1,
    })
    await this.kick()
    return state
    })
  }

  private async startTask(taskId: string): Promise<void> {
    const cur = await this.store.loadOrNull(taskId)
    if (!cur || cur.status !== 'queued') return
    await this.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'start' } }, (s) => {
      if (s.status === 'queued') s.status = 'running'
    })
    const runner = new TaskRunner(this, taskId) // 构造即开跑（donePromise 兜底收敛）
    this.runners.set(taskId, runner)
  }

  async onRunnerDone(taskId: string): Promise<void> {
    this.runners.delete(taskId)
    this.releaseSession(taskId)
    void this.kick()
  }

  // ---------- 会话中断（[机-接管 via=interrupt] / abortAuxiliarySessions） ----------

  acquireSessionSignal(taskId: string): AbortSignal {
    let entry = this.sessionAborts.get(taskId)
    if (!entry || entry.ctrl.signal.aborted) {
      entry = { ctrl: new AbortController(), reason: '' }
      this.sessionAborts.set(taskId, entry)
    }
    return entry.ctrl.signal
  }

  abortSession(taskId: string, reason: string): void {
    const entry = this.sessionAborts.get(taskId)
    if (entry && !entry.ctrl.signal.aborted) {
      entry.reason = reason
      entry.ctrl.abort()
    }
  }

  sessionAbortReason(taskId: string): string {
    return this.sessionAborts.get(taskId)?.reason ?? ''
  }

  releaseSession(taskId: string): void {
    this.sessionAborts.delete(taskId)
  }

  // ---------- 健康与预算 ----------

  async updateHealth(taskId: string, input: { consecutiveToolErrors: number; stalledMs?: number }): Promise<void> {
    const st = await this.store.loadOrNull(taskId)
    if (!st) return
    const pb = this.playbooks.get(st.playbookId)
    const { health, changed } = computeHealth(
      {
        consecutiveToolErrors: input.consecutiveToolErrors,
        tokenUsage: st.tokenUsage,
        stalledMs: input.stalledMs ?? null,
        repairRounds: st.repairRounds,
        maxRepairRounds: pb.customizable.maxRepairRounds,
      },
      st.health,
    )
    if (!changed && health.level === st.health.level) return
    await this.store.mutate(taskId, { expectedVersion: null }, (s) => {
      s.health = health
    })
    await this.store.eventLog(taskId).append(taskId, st.stage, { type: 'system' }, 'health_changed', {
      from: st.health.level,
      to: health.level,
      facts: health.facts.map((f) => f.message),
    })
    if (health.level !== 'green') {
      await this.notifications.notify({
        taskId,
        taskSeq: st.seq,
        kind: 'health-warn',
        priority: health.level === 'red' ? 'critical' : 'high',
        title: `任务#${st.seq} 健康徽标转${health.level === 'red' ? '红' : '黄'}（主动叫人）`,
        body: health.facts.map((f) => f.message).join('；'),
        audience: st.people.owner.userId,
        dedupKey: `health-${taskId}-${health.level}-${Date.now()}`,
      })
      if (health.level === 'red') {
        this.abortSession(taskId, 'health-red')
      }
    }
  }

  async addTokenUsage(taskId: string, usage: { input: number; output: number }): Promise<void> {
    const st = await this.store.loadOrNull(taskId)
    if (!st) return
    await this.store.mutate(taskId, { expectedVersion: null }, (s) => {
      s.tokenUsage.input += usage.input
      s.tokenUsage.output += usage.output
    })
    await this.updateHealth(taskId, { consecutiveToolErrors: 0 })
  }

  // ---------- 知识 / 技能 / 产物 ----------

  async injectKnowledge(taskId: string, stage: StageId): Promise<string> {
    const st = await this.store.load(taskId)
    const marker = path.join(this.store.flowDir(taskId), 'skills-materialized')
    const markerData = (await readJson<{ injected: { id: string; name: string; version: number }[] }>(marker)) ?? { injected: [] }
    const { text, summary } = await this.knowledge.inject({
      stage,
      repo: st.repo,
      module: st.module,
      requirementText: st.requirementText,
      workspaceDir: this.store.taskDir(taskId),
      skillsInjected: markerData.injected,
    })
    const flowDir = this.store.flowDir(taskId)
    const list = await loadInjections(flowDir)
    list.push(summary)
    await saveInjections(flowDir, list.slice(-20))
    return text
  }

  recordSkillsInjected(taskId: string, injected: { id: string; name: string; version: number }[]): void {
    void injected
  }

  /** 同步产物索引（三分区 + 主权）到真源；新写/变更文件同时落 artifact_written 语义事件（可回放） */
  async syncArtifacts(taskId: string): Promise<void> {
    const taskDir = this.store.taskDir(taskId)
    const am = new ArtifactManager(taskDir)
    const st = await this.store.load(taskId)
    const existing = new Map(st.artifacts.map((a) => [a.path, a]))
    const out: typeof st.artifacts = []
    const written: typeof st.artifacts = []
    for (const partition of ['process', 'delivery', 'knowledge', 'host-skills'] as const) {
      const root = path.join(taskDir, partition)
      async function walk(dir: string): Promise<void> {
        let entries: import('node:fs').Dirent[]
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name === '.git' || e.name.startsWith('.contract-state')) continue
          const full = path.join(dir, e.name)
          if (e.isDirectory()) await walk(full)
          else {
            const rel = path.relative(taskDir, full).split(path.sep).join('/')
            const stat = await fs.stat(full).catch(() => null)
            if (!stat) continue
            const prev = existing.get(rel)
            const content = await fs.readFile(full, 'utf8').catch(() => '')
            // 内容指纹（前 16 位哈希 + 长度）：同字节数不同内容不再漏记 artifact_written
            const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
            const changed = !prev || prev.bytes !== stat.size || prev.contentHash !== digest
            const sovereignRole =
              ['delivery/spec.md', 'delivery/design.md'].includes(rel) && st.completedStages.includes('design')
                ? 'owner'
                : rel === 'delivery/architecture.md' && st.completedStages.includes('architecture')
                  ? 'owner'
                  : rel === 'delivery/test-design.md' && st.completedStages.includes('test-design')
                    ? 'owner'
                    : rel === CONTRACT_PATH
                      ? 'owner'
                      : STAGE_SOVEREIGNTY[prev?.stage ?? st.stage]
            const entry = {
              path: rel,
              partition: am.partitionOf(rel),
              bytes: stat.size,
              updatedAt: changed ? nowIso() : (prev?.updatedAt ?? nowIso()),
              stage: prev?.stage ?? st.stage,
              sovereignRole,
              contentHash: digest,
            }
            // 新文件或内容变更 → artifact_written 留痕（append-only，任务历程可回放）
            if (changed) written.push(entry)
            out.push(entry)
          }
        }
      }
      await walk(root)
    }
    const before = JSON.stringify(st.artifacts)
    const after = JSON.stringify(out.slice(0, 200))
    if (before !== after) {
      await this.store.mutate(taskId, { expectedVersion: null }, (s) => {
        s.artifacts = out.slice(0, 200)
      })
    }
    const log = this.store.eventLog(taskId)
    for (const w of written.slice(0, 50)) {
      await log.append(taskId, st.stage, { type: 'ai', engine: st.engineId }, 'artifact_written', {
        path: w.path,
        partition: w.partition,
        bytes: w.bytes,
        sovereignRole: w.sovereignRole,
      })
    }
  }

  // ---------- 交付就绪（fail-closed 合入复核） ----------

  async mergeReadiness(taskId: string) {
    const st = await this.store.load(taskId)
    if (!st.mr) {
      return { pipelineGreenOnCurrentSha: false, allFeedbackDigested: false, humanApproved: false, ready: false, blockers: ['尚未创建 MR'] }
    }
    const ds = await loadDeliveryState(this, taskId)
    return computeReadiness(st.mr.sha, ds)
  }

  // ---------- 技能沉淀（场景10） ----------

  async distillSkills(taskId: string): Promise<void> {
    const marker = path.join(this.store.flowDir(taskId), 'distilled')
    if (await fs.stat(marker).catch(() => null)) return
    const st = await this.store.load(taskId)
    const am = new ArtifactManager(this.store.taskDir(taskId))
    const annotations = (await am.listAnnotations()).flatMap((a) => [a.text, ...a.replies.map((r) => r.text)])
    const events = await this.store.eventLog(taskId).read({ kinds: ['rollback'] })
    const rollbackReasons = events.map((e) => (e.payload as { reason: string }).reason)
    const ds = await loadDeliveryState(this, taskId)
    const decisions = await readDecisionRecords(path.join(this.store.taskDir(taskId), 'process', 'decisions.json')).then((rs) => rs.map((d) => d.decision))
    const fresh = await this.skills.proposeCandidates(
      {
        annotations,
        rollbackReasons,
        feedbackTexts: ds.feedback.map((f) => f.text),
        decisions,
        docTexts: [
          st.requirementText,
          ...(
            await Promise.all(
              ['delivery/architecture.md', 'delivery/spec.md', 'delivery/design.md', 'delivery/test-design.md'].map((p) => am.read(p)),
            )
          ).map((c) => c ?? ''),
        ].filter(Boolean),
        repo: st.repo,
        module: st.module,
      },
      taskId,
    )
    await fs.writeFile(marker, JSON.stringify({ at: nowIso(), fresh: fresh.length }), 'utf8')
    if (fresh.length > 0) {
      await this.notifications.notify({
        taskId,
        taskSeq: st.seq,
        kind: 'skill-candidate',
        priority: 'normal',
        title: `有 ${fresh.length} 条候选技能待评审（候选不自动生效）`,
        body: fresh.map((s) => `· ${s.name}：${s.pattern}`).join('\n'),
        audience: st.people.owner.userId,
        dedupKey: `skills-${taskId}`,
      })
    }
  }

  // ---------- 交互（接管 / 恢复 / 指令） ----------

  /** 人接管（[机-接管 via=interrupt]）：中断在跑会话，标记 interrupted（≠失败），默认保持人在控 */
  async takeover(taskId: string, asUserId: string): Promise<TaskState> {
    const st = await this.store.load(taskId)
    const wasRunning = st.status === 'running'
    if (!['running', 'watching', 'gate-wait', 'failed', 'user-held'].includes(st.status)) {
      throw new Error(`状态 ${st.status} 不可接管`)
    }
    if (wasRunning) this.abortSession(taskId, 'takeover')
    const { state } = await this.store.mutate(
      taskId,
      { expectedVersion: null, audit: { actor: asUserId, actorName: asUserId, action: 'takeover' } },
      (s) => {
        s.autonomy = 'human'
        if (s.status !== 'gate-wait') {
          s.status = 'user-held'
          s.lifecycleNote = 'interrupted'
        }
      },
    )
    await this.store.eventLog(taskId).append(taskId, st.stage, { type: 'human', userId: asUserId }, 'takeover', {
      direction: 'human',
      via: 'interrupt',
      note: '接管：中断在跑会话（lifecycle=interrupted，非失败）；保持人在控直到显式恢复自动',
    })
    if (wasRunning) {
      const runner = this.runners.get(taskId)
      runner?.stop()
    }
    await this.kick()
    return state
  }

  /** 显式恢复自动迭代 */
  async resumeAuto(taskId: string): Promise<TaskState> {
    const { state } = await this.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'platform', actorName: '平台', action: 'resume-auto' } }, (s) => {
      s.autonomy = 'auto'
      s.lifecycleNote = undefined
      if (s.status === 'user-held' || s.status === 'failed') s.status = 'queued'
    })
    await this.store.eventLog(taskId).append(taskId, state.stage, { type: 'human' }, 'takeover', { direction: 'auto', via: 'resume' })
    await this.kick()
    return state
  }

  /** 追加指令（会话内追问 / 修复指令）：挂起或失败任务自动回队列并恢复自动（指令即人工放行） */
  async instruction(taskId: string, text: string, asUserId: string): Promise<TaskState> {
    const st = await this.store.load(taskId)
    const { state } = await this.store.mutate(
      taskId,
      { expectedVersion: null, audit: { actor: asUserId, actorName: asUserId, action: 'instruction' } },
      (s) => {
        s.pendingInstructions.push(text)
        if (s.status === 'user-held' || s.status === 'failed') {
          s.status = 'queued'
          s.lifecycleNote = undefined
          // 人在控时的追加指令 = 人工放行本轮自动执行（如需持续单步可再次接管）
          if (s.autonomy === 'human') s.autonomy = 'auto'
        }
      },
    )
    await this.store.eventLog(taskId).append(taskId, st.stage, { type: 'human', userId: asUserId }, 'user_message', { text, source: 'instruction' })
    await this.kick()
    return state
  }

  /**
   * 待追认闭环（场景2 后半段）：事实门超时降级推进后的人工追认。
   * 追认写 finalAnswer/resolvedAt/resolvedBy，并落决策记录（process/decisions.json）——
   * 假设不作数的事实，最终以人的答案留痕；不改变任务状态（降级时任务已在推进）。
   */
  async resolvePendingConfirmation(taskId: string, confirmationId: string, finalAnswer: string, asUserId: string): Promise<TaskState> {
    const me = personOf(asUserId)
    const st = await this.store.load(taskId)
    const { state } = await this.store.mutate(
      taskId,
      { expectedVersion: null, audit: { actor: asUserId, actorName: me.name, action: 'resolve-pending-confirmation' } },
      (s) => {
        const pc = s.pendingConfirmations.find((p) => p.id === confirmationId)
        if (!pc) throw new HttpError(404, 'not-found', `待追认项不存在：${confirmationId}`)
        if (pc.resolvedAt) throw new HttpError(409, 'already-resolved', '该项已追认（不可重复）')
        pc.resolvedAt = nowIso()
        pc.resolvedBy = me.name
        pc.finalAnswer = finalAnswer
      },
    )
    const pc = state.pendingConfirmations.find((p) => p.id === confirmationId)!
    await this.store.eventLog(taskId).append(taskId, st.stage, { type: 'human', userId: asUserId, name: me.name }, 'user_message', {
      text: `待追认已确认（原假设「${pc.assumedAnswer.slice(0, 120)}」→ 事实「${finalAnswer.slice(0, 200)}」）`,
      source: 'instruction',
    })
    await appendDecisionRecordFile(path.join(this.store.taskDir(taskId), 'process', 'decisions.json'), {
      topic: `追认（原降级假设：${pc.question.split('\n')[0]}）`,
      decision: finalAnswer,
      degraded: false,
      ts: nowIso(),
    })
    await this.syncArtifacts(taskId) // decisions.json 变更落索引留痕
    return state
  }

  /** 晨间摘要手动触发（演示用） */
  async flushDigest(): Promise<import('@ai-platform/shared').Notification[]> {
    return this.notifications.flushMorningDigest()
  }
}

export function newTaskId(): string {
  return newId('task')
}
