import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError, z } from 'zod'
import {
  USERS,
  personOf,
  type Annotation,
  type EventPage,
  type MetricsView,
  type PlatformConfig,
  type SkillsView,
  type TaskCard,
  type TaskDetail,
  type ArtifactContent,
  type SemanticEventKind,
} from '@ai-platform/shared'
import {
  createTaskSchema,
  decideGateSchema,
  inviteParticipantSchema,
  takeoverSchema,
  resumeAutoSchema,
  instructionSchema,
  annotationSchema,
  adoptSkillSchema,
  mrEventSchema,
} from '@ai-platform/shared'
import { VersionConflictError, TaskNotFoundError } from '../domain/task-store.js'
import { GateError } from '../orchestrator/gates.js'
import { SovereigntyError, ArtifactManager, CONTRACT_PATH } from '../extension/artifacts.js'
import { loadInjections } from '../domain/event-log.js'
import { loadDeliveryState } from '../orchestrator/workers.js'
import { buildMetricsView } from '../runtime/metrics.js'
import { decideGate, inviteParticipant } from '../orchestrator/gates.js'
import { bindIdentity, HttpError, type AuthService } from './auth.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Platform } from '../orchestrator/platform.js'
import type { TriageCategory } from '@ai-platform/shared'

/**
 * L4 交互作业层：REST + SSE
 *
 * 全部路由只消费 Platform 暴露的服务；类型从 shared/api.ts 单源派生（禁止两端手写重复）。
 * 身份唯一来源 = 认证身份（Bearer 令牌 / 会话 Cookie）：请求体 asUserId 必须与登录身份一致，
 * 不一致 → 403 identity-mismatch（知情拒绝）；admin 代拍板以 admin 身份登录后走原有留痕通道。
 */

function sendErr(app: FastifyInstance, reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.code, message: err.message })
  }
  if (err instanceof VersionConflictError) {
    return reply.code(409).send({ error: 'version-conflict', message: err.message, currentVersion: err.current })
  }
  if (err instanceof TaskNotFoundError) {
    return reply.code(404).send({ error: 'not-found', message: err.message })
  }
  if (err instanceof GateError) {
    const code = err.code === 'not-found' ? 404 : err.code === 'not-decider' ? 403 : err.code === 'not-ready' || err.code === 'not-raised' ? 409 : 400
    return reply.code(code).send({ error: err.code, message: err.message })
  }
  if (err instanceof SovereigntyError) {
    return reply.code(403).send({ error: 'sovereignty', message: err.message })
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'validation', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
  }
  app.log.error(err)
  return reply.code(500).send({ error: 'internal', message: (err as Error).message ?? '内部错误' })
}

/** 任务 ID 严格校验（防路径穿越：taskId 参与文件系统路径拼接） */
const TASK_ID_RE = /^task-\d{1,9}$/
const SAFE_KEY_RE = /^[\w-]{1,64}$/

function paramId(req: FastifyRequest): string {
  const id = (req.params as { id?: string }).id ?? ''
  if (!TASK_ID_RE.test(id)) throw new HttpError(400, 'bad-task-id', `非法任务 ID：${id || '(空)'}`)
  return id
}

function paramKey(req: FastifyRequest, name: 'nid' | 'sid'): string {
  const v = (req.params as Record<string, string | undefined>)[name] ?? ''
  if (!SAFE_KEY_RE.test(v)) throw new HttpError(400, 'bad-param', `非法参数 ${name}：${v || '(空)'}`)
  return v
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

async function buildTaskDetail(platform: Platform, taskId: string): Promise<TaskDetail> {
  const state = await platform.store.load(taskId)
  const am = new ArtifactManager(platform.store.taskDir(taskId))
  const log = platform.store.eventLog(taskId)

  let contract: TaskDetail['contract'] = null
  const cs = await am.contractState()
  if (cs) {
    const drifted = await am.checkDrift(cs.derivedViews.map((v) => ({ path: v.path })))
    contract = { path: CONTRACT_PATH, sourceHash: cs.sourceHash, driftedViews: drifted }
  }

  let delivery: TaskDetail['delivery'] = null
  if (state.mr) {
    const mr = platform.mrPlatform.get(state.mr.mrId)
    const ds = await loadDeliveryState(platform, taskId)
    const readiness = await platform.mergeReadiness(taskId)
    delivery = {
      mr: state.mr,
      mrState: mr?.state ?? 'open',
      feedback: ds.feedback,
      pipelines: mr?.pipelines ?? [],
      evidence: ds.evidence,
      mergeReadiness: readiness,
    }
  }

  return {
    state,
    gate: state.gate,
    annotations: await am.listAnnotations(),
    injections: await loadInjections(platform.store.flowDir(taskId)),
    delivery,
    journey: await log.journey(),
    contract,
  }
}

export function registerRoutes(app: FastifyInstance, platform: Platform, auth: AuthService): void {
  // ---------- 认证与会话 ----------

  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    demoMode: auth.demoMode,
    tasks: platform.projection.list().length,
    ts: new Date().toISOString(),
  }))

  /** 公开：登录模式探测（前端据此渲染登录页；不泄露令牌） */
  app.get('/api/auth/options', { config: { public: true } }, async () => ({
    demoMode: auth.demoMode,
    mode: 'token' as const,
  }))

  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const parsed = z.object({ userId: z.string().min(1), token: z.string().min(8) }).safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', message: 'userId 与 token 必填' })
    }
    const user = auth.verifyToken(parsed.data.token)
    if (!user || user.userId !== parsed.data.userId) {
      return reply.code(401).send({ error: 'bad-credentials', message: '令牌无效或与用户不匹配' })
    }
    auth.setSessionCookie(reply, user)
    return { user }
  })

  /** 演示模式专用：免令牌切换身份（生产 DEMO_MODE=false 时路由不存在） */
  if (auth.demoMode) {
    app.post('/api/auth/demo-login', { config: { public: true } }, async (req, reply) => {
      const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', message: 'userId 必填' })
      }
      const user = auth.userOf(parsed.data.userId)
      if (!user) return reply.code(400).send({ error: 'unknown-user', message: `未知用户：${parsed.data.userId}` })
      auth.setSessionCookie(reply, user)
      return { user }
    })

    app.post('/api/auth/switch', async (req, reply) => {
      const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation', message: 'userId 必填' })
      }
      const user = auth.userOf(parsed.data.userId)
      if (!user) return reply.code(400).send({ error: 'unknown-user', message: `未知用户：${parsed.data.userId}` })
      auth.setSessionCookie(reply, user)
      return { user }
    })
  }

  app.get('/api/auth/me', async (req) => ({ user: req.user }))

  app.post('/api/auth/logout', async (req, reply) => {
    auth.clearSessionCookie(reply)
    return { ok: true }
  })

  // ---------- 用户目录 ----------

  app.get('/api/users', async (): Promise<typeof USERS> => USERS)

  // ---------- 任务 ----------

  app.post('/api/tasks', async (req, reply) => {
    try {
      const body = createTaskSchema.parse(req.body ?? {})
      const state = await platform.createTask(body)
      return reply.code(201).send(state)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.get('/api/tasks', async (): Promise<TaskCard[]> => platform.projection.list())

  // ---------- 质量度量（TTM / 阶段耗时 / 门等待 / 回退；事件流只读派生） ----------

  app.get('/api/metrics', async (): Promise<MetricsView> => buildMetricsView(platform))

  app.get('/api/tasks/:id', async (req, reply) => {
    try {
      return await buildTaskDetail(platform, paramId(req))
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- 语义事件流（分页 + SSE） ----------

  app.get('/api/tasks/:id/events', async (req, reply) => {
    try {
      const taskId = paramId(req)
      const q = req.query as { afterSeq?: string; kinds?: string; toolsOnly?: string }
      const filter: { afterSeq?: number; kinds?: SemanticEventKind[]; toolsOnly?: boolean } = {}
      if (q.afterSeq !== undefined) filter.afterSeq = Number(q.afterSeq) || 0
      if (q.kinds) filter.kinds = q.kinds.split(',').filter(Boolean) as SemanticEventKind[]
      if (q.toolsOnly === 'true' || q.toolsOnly === '1') filter.toolsOnly = true
      const events = await platform.store.eventLog(taskId).read(filter)
      const page: EventPage = { events, lastSeq: events.length > 0 ? events[events.length - 1].seq : (filter.afterSeq ?? 0) }
      return page
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.get('/api/tasks/:id/events/stream', async (req, reply) => {
    const taskId = paramId(req)
    if (!(await platform.store.exists(taskId))) {
      return reply.code(404).send({ error: 'not-found', message: `任务不存在：${taskId}` })
    }
    const q = req.query as { afterSeq?: string }
    let lastSeq = Number(q.afterSeq ?? 0) || 0

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(': connected\n\n')

    const write = (event: string, data: unknown): void => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        // 连接已断
      }
    }

    const poll = async (): Promise<void> => {
      try {
        const events = await platform.store.eventLog(taskId).read({ afterSeq: lastSeq })
        if (events.length > 0) {
          lastSeq = events[events.length - 1].seq
          write('events', events)
        }
      } catch {
        // ignore
      }
    }
    await poll()

    const off = platform.bus.on((ev) => {
      if (ev.type === 'state' && ev.taskId === taskId) {
        write('state', { taskId })
        void poll()
      } else if (ev.type === 'stage' && ev.taskId === taskId) {
        write('state', { taskId, stage: ev.state.stage, status: ev.state.status })
        void poll()
      } else if (ev.type === 'notification') {
        write('notification', ev.notification)
      }
    })
    const timer = setInterval(() => void poll(), 700)
    const heartbeat = setInterval(() => write('ping', { ts: Date.now() }), 15_000)
    req.raw.on('close', () => {
      clearInterval(timer)
      clearInterval(heartbeat)
      off()
    })
    return reply
  })

  // ---------- 产物 / 批注 ----------

  app.get('/api/tasks/:id/artifact', async (req, reply) => {
    try {
      const taskId = paramId(req)
      const q = req.query as { path?: string }
      if (!q.path) return reply.code(400).send({ error: 'validation', message: 'path 必填' })
      const state = await platform.store.load(taskId)
      const content = await platform.store.readArtifact(taskId, q.path)
      if (content === null) return reply.code(404).send({ error: 'not-found', message: `产物不存在：${q.path}` })
      const meta = state.artifacts.find((a) => a.path === q.path)
      const am = new ArtifactManager(platform.store.taskDir(taskId))
      const out: ArtifactContent = {
        path: q.path,
        partition: am.partitionOf(q.path),
        content,
        sovereignRole: meta?.sovereignRole ?? 'reader',
        writable: false, // 产物写入仅由引擎/平台执行；人走批注
      }
      return out
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.post('/api/tasks/:id/annotations', async (req, reply) => {
    try {
      const taskId = paramId(req)
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = annotationSchema.parse(req.body ?? {})
      const am = new ArtifactManager(platform.store.taskDir(taskId))
      const ann = await am.addAnnotation({
        artifactPath: body.artifactPath,
        anchor: body.anchor,
        author: me.userId,
        authorName: me.name,
        text: body.text,
        replyTo: body.replyTo,
        annotationId: body.annotationId,
        resolve: body.resolve,
      })
      return reply.code(201).send(ann satisfies Annotation)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- 门禁 ----------

  app.post('/api/tasks/:id/gate/decide', async (req, reply) => {
    try {
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = decideGateSchema.parse(req.body ?? {})
      // 身份唯一来源=登录身份；admin 代拍板走原有 onBehalf 留痕通道
      const state = await decideGate(platform, paramId(req), { ...body, asUserId: me.userId })
      await platform.kick()
      return state
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.post('/api/tasks/:id/gate/invite', async (req, reply) => {
    try {
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = inviteParticipantSchema.parse(req.body ?? {})
      const person = personOf(body.userId)
      const state = await inviteParticipant(platform, paramId(req), person.userId, person.name, me.userId)
      return state
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  /** 演示：把当前门的计时快进到超时（不必等真实超时；交付门 timeout=0 永不放行）——限演示模式/管理员 */
  app.post('/api/tasks/:id/gate/force-timeout', async (req, reply) => {
    try {
      const me = req.user
      if (!auth.demoMode && !me?.isAdmin) {
        throw new HttpError(403, 'demo-only', '演示功能：仅 DEMO_MODE 或管理员可用')
      }
      const taskId = paramId(req)
      const state = await platform.store.mutate(taskId, { expectedVersion: null, audit: { actor: 'demo', actorName: '演示', action: 'force-timeout' } }, (s) => {
        if (!s.gate || s.gate.status !== 'raised') throw new GateError('当前无待决策门', 'not-raised')
        if (s.gate.timeoutMs <= 0) throw new GateError('交付门永不超时放行（铁门）', 'invalid')
        s.gate.raisedAt = new Date(Date.now() - s.gate.timeoutMs - 1000).toISOString()
      })
      await platform.kick()
      return state
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- 交互（接管 / 恢复 / 指令） ----------

  app.post('/api/tasks/:id/takeover', async (req, reply) => {
    try {
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = takeoverSchema.parse(req.body ?? {})
      return await platform.takeover(paramId(req), me.userId)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.post('/api/tasks/:id/resume-auto', async (req, reply) => {
    try {
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = resumeAutoSchema.parse(req.body ?? {})
      return await platform.resumeAuto(paramId(req))
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.post('/api/tasks/:id/instruction', async (req, reply) => {
    try {
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = instructionSchema.parse(req.body ?? {})
      return await platform.instruction(paramId(req), body.text, me.userId)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- MR 事件接入（真实远端 CodeHub webhook / 演示注入共用契约） ----------

  /**
   * 签名契约（生产）：MR_WEBHOOK_SECRET 配置后，需带 `X-Signature: sha256=<hex>`，
   * 签名对象 = HMAC-SHA256(secret, JSON.stringify(body))（与请求体字节一致的规范 JSON）。
   * DEMO_MODE 下允许免签注入（演示剧本驱动）。
   */
  app.post('/api/tasks/:id/mr/events', async (req, reply) => {
    try {
      const taskId = paramId(req)
      const body = mrEventSchema.parse(req.body ?? {})
      const secret = process.env.MR_WEBHOOK_SECRET
      if (secret) {
        const sig = String(req.headers['x-signature'] ?? '').replace(/^sha256=/, '')
        const expected = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')
        if (sig.length !== expected.length || !timingSafeEqualStr(sig, expected)) {
          throw new HttpError(403, 'bad-signature', 'X-Signature 校验失败（HMAC-SHA256，签名对象=规范 JSON 请求体）')
        }
      } else if (!auth.demoMode) {
        throw new HttpError(403, 'signature-required', '生产模式必须配置 MR_WEBHOOK_SECRET 并携带 X-Signature')
      }
      const st = await platform.store.load(taskId)
      if (!st.mr) throw new GateError('任务尚未创建 MR（不在监听态）', 'not-raised')
      const mr = st.mr
      const triageMap: Record<string, TriageCategory> = { auto: 'auto-fixable', human: 'needs-human', info: 'info-only' }
      const triage = body.triage ? triageMap[body.triage] : undefined

      switch (body.type) {
        case 'pipeline-run': {
          const state = body.value === 'failed' ? 'failed' : body.value === 'pending' ? 'pending' : 'success'
          await platform.mrPlatform.addPipeline(mr.mrId, mr.sha, state, `远端流水线（演示注入）：${state}`)
          break
        }
        case 'comment':
        case 'review-comment': {
          const author = body.author ?? '外部评审人'
          await platform.mrPlatform.addComment(mr.mrId, {
            author,
            text: body.value ?? '（演示评论）',
            kind: body.type === 'review-comment' ? 'review-comment' : 'comment',
            sha: mr.sha,
            triage,
          })
          break
        }
        case 'approve': {
          await platform.mrPlatform.addComment(mr.mrId, {
            author: body.author ?? '外部评审人',
            text: body.value ?? 'LGTM，同意合入',
            kind: 'review-comment',
            sha: mr.sha,
            triage: 'info-only',
          })
          await platform.mrPlatform.markMergeable(mr.mrId)
          break
        }
        case 'post-merge-issue': {
          await platform.mrPlatform.addComment(mr.mrId, {
            author: body.author ?? '值班工程师',
            text: body.value ?? '合入后线上问题：需要人决策处理',
            kind: 'comment',
            sha: mr.sha,
            triage: 'needs-human',
          })
          break
        }
      }
      await platform.kick()
      return await buildTaskDetail(platform, taskId)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- 通知（只看本人收件箱；admin 可查看他人） ----------

  app.get('/api/notifications', async (req) => {
    const me = req.user!
    const q = req.query as { userId?: string }
    const owner = q.userId && q.userId !== me.userId ? (me.isAdmin ? q.userId : me.userId) : me.userId
    return { items: platform.notifications.inbox(owner) }
  })

  app.post('/api/notifications/:nid/read', async (req, reply) => {
    await platform.notifications.markRead(paramKey(req, 'nid'))
    return { ok: true }
  })

  app.post('/api/notifications/read-all', async (req) => {
    const me = req.user!
    const body = (req.body ?? {}) as { userId?: string }
    await platform.notifications.markAllRead(body.userId && body.userId !== me.userId && me.isAdmin ? body.userId : me.userId)
    return { ok: true }
  })

  /** 演示：手动触发晨间摘要合并——限演示模式/管理员 */
  app.post('/api/notifications/digest/flush', async (req, reply) => {
    if (!auth.demoMode && !req.user?.isAdmin) {
      return reply.code(403).send({ error: 'demo-only', message: '演示功能：仅 DEMO_MODE 或管理员可用' })
    }
    const merged = await platform.flushDigest()
    return { merged: merged.length }
  })

  // ---------- 平台配置 ----------

  app.get('/api/config', async (): Promise<PlatformConfig> => {
    const all = await platform.store.listAll()
    const states = all.map((s) => ({ taskId: s.taskId, status: s.status, createdAt: s.createdAt }))
    return {
      engine: {
        active: await platform.engines.defaultEngineId(),
        available: (await platform.engines.probe()).map((p) => ({ id: p.id, available: p.ok, detail: p.detail })),
      },
      scheduler: platform.scheduler.snapshot(states),
      quietHours: platform.notifications.quietHours(),
      dataDir: platform.dataDir,
    }
  })

  app.get('/api/config/scheduler', async () => {
    const all = await platform.store.listAll()
    const states = all.map((s) => ({ taskId: s.taskId, status: s.status, createdAt: s.createdAt }))
    return platform.scheduler.snapshot(states)
  })

  app.post('/api/config/scheduler', async (req, reply) => {
    try {
      if (!req.user?.isAdmin) {
        throw new HttpError(403, 'admin-only', '调度并发为运维参数：仅管理员可修改')
      }
      const body = zPosInt.parse(req.body ?? {})
      await platform.scheduler.setMaxConcurrent(body.maxConcurrent)
      await platform.kick()
      const all = await platform.store.listAll()
      return platform.scheduler.snapshot(all.map((s) => ({ taskId: s.taskId, status: s.status, createdAt: s.createdAt })))
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  // ---------- 知识 / 技能 / 模板 ----------

  app.get('/api/skills', async (): Promise<SkillsView> => ({
    library: await platform.skills.all(),
    candidates: await platform.skills.candidates(),
    audit: await platform.skills.auditLog(),
  }))

  app.post('/api/skills/:sid/actions', async (req, reply) => {
    try {
      const sid = paramKey(req, 'sid')
      const me = bindIdentity(req, (req.body as { asUserId?: string } | undefined)?.asUserId)
      const body = adoptSkillSchema.parse(req.body ?? {})
      if (body.action === 'adopt') {
        return await platform.skills.adopt(sid, me.userId, me.name)
      }
      if (body.action === 'reject') {
        await platform.skills.reject(sid, me.userId, me.name, body.reason)
        return { ok: true }
      }
      await platform.skills.deprecate(sid, me.userId, me.name, body.reason ?? '（未填理由）')
      return { ok: true }
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })

  app.get('/api/playbooks', async () => platform.playbooks.list())

  // ---------- 演示种子（限演示模式/管理员） ----------

  app.post('/api/demo/seed', async (req, reply) => {
    try {
      if (!auth.demoMode && !req.user?.isAdmin) {
        throw new HttpError(403, 'demo-only', '演示功能：仅 DEMO_MODE 或管理员可用')
      }
      const body = demoSeedSchema.parse(req.body ?? {})
      const state = await platform.createTask({
        title: body.title ?? '会员积分过期提醒',
        requirementText: body.requirementText ?? '会员中心：积分快过期的会员，在过期前 7 天发提醒（短信/App 内信），过期后积分清零要留痕。',
        module: body.module ?? 'membership-points',
        repo: body.repo ?? 'membership-center',
        mode: 'incremental',
        playbookId: body.playbookId ?? 'strict',
        people: {},
        unattended: false,
        engineId: 'simulated',
        scenario: body.scenario ?? 'clean',
        arParallel: body.arParallel ?? false,
      })
      return reply.code(201).send(state)
    } catch (err) {
      return sendErr(app, reply, err)
    }
  })
}

// zod 局部 schema（仅服务端用）
const zPosInt = z.object({ maxConcurrent: z.number().int().min(1).max(16) })
const demoSeedSchema = z.object({
  title: z.string().min(1).optional(),
  requirementText: z.string().min(1).optional(),
  module: z.string().optional(),
  repo: z.string().optional(),
  playbookId: z.string().optional(),
  scenario: z.enum(['clean', 'flaky-tool', 'build-fail', 'feedback-loop']).optional(),
  arParallel: z.boolean().optional(),
})
