/**
 * typed fetch 客户端 —— 类型全部来自 @ai-platform/shared/api.ts 单源（[机-契约单源]）
 * REST 路由一一对应；SSE 在 TaskView 中直接用 EventSource（Cookie 同源自动携带）。
 * 会话过期（401，非认证端点）派发全局事件 → store 置为未登录态渲染登录页。
 */
import type {
  AdoptSkillRequest,
  Annotation,
  AnnotationRequest,
  ApiError,
  ArtifactContent,
  AuthOptions,
  CreateTaskRequest,
  DecideGateRequest,
  DemoLoginRequest,
  EventPage,
  InstructionRequest,
  InviteParticipantRequest,
  LoginRequest,
  MetricsView,
  MrEventRequest,
  Notification,
  PlatformConfig,
  Playbook,
  ResumeAutoRequest,
  SchedulerConfig,
  SemanticEventKind,
  SessionResponse,
  SessionUser,
  SkillsView,
  SwitchUserRequest,
  TakeoverRequest,
  TaskCard,
  TaskDetail,
  TaskState,
  UserDir,
} from '@ai-platform/shared'
import type { AnnotationReply } from '@ai-platform/shared'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message ?? `HTTP ${status}`)
  }
  get code(): string {
    return this.body.error
  }
  get currentVersion(): number | undefined {
    return this.body.currentVersion
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let parsed: ApiError = { error: `http-${res.status}`, message: `HTTP ${res.status}` }
    try {
      parsed = (await res.json()) as ApiError
    } catch {
      /* ignore */
    }
    // 会话过期（认证端点自身的 401 除外）→ 全局未登录事件（store 切登录页）
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('ai:unauthorized'))
    }
    throw new ApiRequestError(res.status, parsed)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------- 认证与会话 ----------

export const api = {
  authOptions: (): Promise<AuthOptions> => req('GET', '/api/auth/options'),
  login: (r: LoginRequest): Promise<SessionResponse> => req('POST', '/api/auth/login', r),
  demoLogin: (r: DemoLoginRequest): Promise<SessionResponse> => req('POST', '/api/auth/demo-login', r),
  switchUser: (r: SwitchUserRequest): Promise<SessionResponse> => req('POST', '/api/auth/switch', r),
  me: (): Promise<{ user: SessionUser }> => req('GET', '/api/auth/me'),
  logout: (): Promise<{ ok: boolean }> => req('POST', '/api/auth/logout', {}),

  // ---------- 用户 ----------

  users: (): Promise<UserDir[]> => req('GET', '/api/users'),

  // ---------- 任务 ----------

  createTask: (r: CreateTaskRequest): Promise<TaskState> => req('POST', '/api/tasks', r),
  listTasks: (): Promise<TaskCard[]> => req('GET', '/api/tasks'),
  getTask: (id: string): Promise<TaskDetail> => req('GET', `/api/tasks/${id}`),

  // ---------- 质量度量 ----------

  metrics: (): Promise<MetricsView> => req('GET', '/api/metrics'),

  // ---------- 语义事件流 ----------

  events: (id: string, filter: { afterSeq?: number; kinds?: SemanticEventKind[]; toolsOnly?: boolean } = {}): Promise<EventPage> => {
    const q = new URLSearchParams()
    if (filter.afterSeq !== undefined) q.set('afterSeq', String(filter.afterSeq))
    if (filter.kinds?.length) q.set('kinds', filter.kinds.join(','))
    if (filter.toolsOnly) q.set('toolsOnly', 'true')
    return req('GET', `/api/tasks/${id}/events?${q.toString()}`)
  },

  // ---------- 产物 / 批注 ----------

  artifact: (id: string, path: string): Promise<ArtifactContent> =>
    req('GET', `/api/tasks/${id}/artifact?path=${encodeURIComponent(path)}`),
  annotate: (id: string, r: AnnotationRequest): Promise<Annotation | AnnotationReply> =>
    req('POST', `/api/tasks/${id}/annotations`, r),

  // ---------- 门禁 ----------

  decideGate: (id: string, r: DecideGateRequest): Promise<TaskState> => req('POST', `/api/tasks/${id}/gate/decide`, r),
  invite: (id: string, r: InviteParticipantRequest): Promise<TaskState> => req('POST', `/api/tasks/${id}/gate/invite`, r),
  forceTimeout: (id: string): Promise<TaskState> => req('POST', `/api/tasks/${id}/gate/force-timeout`, {}),

  // ---------- 交互 ----------

  takeover: (id: string, r: TakeoverRequest): Promise<TaskState> => req('POST', `/api/tasks/${id}/takeover`, r),
  resumeAuto: (id: string, r: ResumeAutoRequest): Promise<TaskState> => req('POST', `/api/tasks/${id}/resume-auto`, r),
  instruction: (id: string, r: InstructionRequest): Promise<TaskState> => req('POST', `/api/tasks/${id}/instruction`, r),

  // ---------- MR 演示注入 ----------

  mrEvent: (id: string, r: MrEventRequest): Promise<TaskDetail> => req('POST', `/api/tasks/${id}/mr/events`, r),

  // ---------- 通知 ----------

  notifications: (userId?: string): Promise<{ items: Notification[] }> =>
    req('GET', userId ? `/api/notifications?userId=${encodeURIComponent(userId)}` : '/api/notifications'),
  markRead: (nid: string): Promise<{ ok: boolean }> => req('POST', `/api/notifications/${nid}/read`, {}),
  markAllRead: (userId: string): Promise<{ ok: boolean }> => req('POST', '/api/notifications/read-all', { userId }),
  flushDigest: (): Promise<{ merged: number }> => req('POST', '/api/notifications/digest/flush', {}),

  // ---------- 平台配置 ----------

  config: (): Promise<PlatformConfig> => req('GET', '/api/config'),
  scheduler: (): Promise<SchedulerConfig> => req('GET', '/api/config/scheduler'),
  setScheduler: (maxConcurrent: number): Promise<SchedulerConfig> =>
    req('POST', '/api/config/scheduler', { maxConcurrent }),

  // ---------- 知识 / 技能 / 模板 ----------

  skills: (): Promise<SkillsView> => req('GET', '/api/skills'),
  skillAction: (sid: string, r: AdoptSkillRequest): Promise<unknown> => req('POST', `/api/skills/${sid}/actions`, r),
  playbooks: (): Promise<Playbook[]> => req('GET', '/api/playbooks'),
}
