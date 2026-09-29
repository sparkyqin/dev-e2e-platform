import { z } from 'zod'
import { ROLLBACK_TARGETS } from './stages.js'
import type { StageId, DevMode, RollbackTarget } from './stages.js'
import type { GateAction, GateKind } from './gates.js'
import type { TaskState, JourneyEntry } from './task.js'
import type { Annotation } from './artifacts.js'
import type { InjectionSummary } from './knowledge.js'
import type { FeedbackItem, PipelineRun, EvidenceEntry, MrRef, MrState, MergeReadiness } from './delivery.js'
import type { Notification } from './notifications.js'
import type { Skill, SkillAuditEntry } from './skills.js'
import type { Playbook } from './playbook.js'

/**
 * REST API 契约 —— api-types 单一真源（[机-契约单源]）
 * 前后端皆从此文件只读派生，禁止在两端各自手写重复类型。
 */

// ---------- 用户目录 ----------

export interface UserDir {
  userId: string
  name: string
  role: string
  /** 会话厅显示的角色标签 */
  tags: string[]
}

// ---------- 认证与会话（身份唯一来源 = 认证身份） ----------

/** 登录后的会话身份（服务端 req.user；浏览器 Cookie 或 Bearer 令牌换得） */
export interface SessionUser {
  userId: string
  name: string
  role: string
  isAdmin: boolean
}

/** 公开的登录模式探测（GET /api/auth/options） */
export interface AuthOptions {
  /** true=允许免令牌切换演示身份（开发/演示；生产必须 false） */
  demoMode: boolean
  mode: 'token' | 'oidc'
}

export interface LoginRequest {
  userId: string
  token: string
}

export interface DemoLoginRequest {
  userId: string
}

export interface SwitchUserRequest {
  userId: string
}

export interface SessionResponse {
  user: SessionUser
}

// ---------- 任务 ----------

export const createTaskSchema = z.object({
  title: z.string().min(1),
  requirementText: z.string().min(1),
  module: z.string().default(''),
  repo: z.string().default(''),
  mode: z.enum(['greenfield', 'incremental', 'reverse-full', 'refactor']).default('incremental'),
  playbookId: z.string().default('default'),
  people: z
    .object({
      requesterId: z.string().optional(),
      ownerId: z.string().optional(),
      designerId: z.string().optional(),
      architectId: z.string().optional(),
      tseId: z.string().optional(),
      reviewerId: z.string().optional(),
      mergerId: z.string().optional(),
    })
    .default({}),
  unattended: z.boolean().default(false),
  engineId: z.string().optional(),
  scenario: z.enum(['clean', 'flaky-tool', 'build-fail', 'feedback-loop']).default('clean'),
  /** 执行段 AR 并行拆分（review 通过后 owner 拍板，spawn 子任务并行执行） */
  arParallel: z.boolean().default(false),
})
export type CreateTaskRequest = z.infer<typeof createTaskSchema>

/** 会话厅卡片（第一层） */
export interface TaskCard {
  taskId: string
  seq: number
  title: string
  module: string
  repo: string
  stage: StageId
  status: TaskState['status']
  health: TaskState['health']
  gateKind: GateKind | null
  gateQuestion: string | null
  /** 门等待时：唯一拍板人姓名（谁在阻塞，一眼可见） */
  gateDeciderName: string | null
  /** 门等待时：举门时间 ISO（前端算「已等多久」） */
  gateRaisedAt: string | null
  engineId: string
  unattended: boolean
  autonomy: 'auto' | 'human'
  updatedAt: string
  createdAt: string
  repairRounds: number
  /** AR 并行：父任务的子任务概览（聚合进度）；普通任务为 null */
  subtasks: { taskId: string; arTitle: string; status: TaskState['status'] }[] | null
  /** 子任务指向父任务 */
  parentTaskId: string | null
  arTitle: string | null
}

/** 任务工作台详情（第二/三层） */
export interface TaskDetail {
  state: TaskState
  /** 当前打开的门（含材料/批注/决策） */
  gate: TaskState['gate']
  annotations: Annotation[]
  injections: InjectionSummary[]
  delivery: {
    mr: MrRef | null
    mrState: MrState
    feedback: FeedbackItem[]
    pipelines: PipelineRun[]
    evidence: EvidenceEntry[]
    mergeReadiness: MergeReadiness
  } | null
  journey: JourneyEntry[]
  contract: { path: string; sourceHash: string; driftedViews: string[] } | null
}

// ---------- 门禁 ----------

export const decideGateSchema = z.object({
  stateVersion: z.number().int().nonnegative(),
  action: z.enum(['approve', 'reject', 'answer', 'rollback', 'merge']),
  answer: z.string().optional(),
  rollbackTarget: z.enum(ROLLBACK_TARGETS).optional(),
  reason: z.string().optional(),
  /** 当前操作者（演示环境无鉴权，由前端身份切换器提供） */
  asUserId: z.string(),
})
export type DecideGateRequest = z.infer<typeof decideGateSchema>

export const inviteParticipantSchema = z.object({
  stateVersion: z.number().int().nonnegative(),
  userId: z.string(),
  asUserId: z.string(),
})
export type InviteParticipantRequest = z.infer<typeof inviteParticipantSchema>

// ---------- 交互 ----------

export const takeoverSchema = z.object({ asUserId: z.string() })
export type TakeoverRequest = z.infer<typeof takeoverSchema>

export const resumeAutoSchema = z.object({
  stateVersion: z.number().int().nonnegative(),
  asUserId: z.string(),
})
export type ResumeAutoRequest = z.infer<typeof resumeAutoSchema>

export const instructionSchema = z.object({
  text: z.string().min(1),
  asUserId: z.string(),
})
export type InstructionRequest = z.infer<typeof instructionSchema>

export const annotationSchema = z.object({
  artifactPath: z.string(),
  anchor: z.string().optional(),
  text: z.string().min(1),
  asUserId: z.string(),
  replyTo: z.string().optional(),
  resolve: z.boolean().optional(),
})
export type AnnotationRequest = z.infer<typeof annotationSchema>

// ---------- 产物 / 事件 ----------

export interface ArtifactContent {
  path: string
  partition: string
  content: string
  sovereignRole: string
  writable: boolean
}

export interface EventPage {
  events: import('./events.js').SemanticEvent[]
  lastSeq: number
}

// ---------- 调度 / 平台配置 ----------

export interface SchedulerConfig {
  maxConcurrent: number
  running: string[]
  queued: string[]
  gateWaiting: string[]
  watching: string[]
}

export interface PlatformConfig {
  engine: { active: string; available: { id: string; available: boolean; detail: string }[] }
  scheduler: SchedulerConfig
  quietHours: { start: string; end: string }
  dataDir: string
}

// ---------- 知识 / 技能 / 模板 ----------

export interface SkillsView {
  library: Skill[]
  candidates: Skill[]
  audit: SkillAuditEntry[]
}

export const adoptSkillSchema = z.object({
  action: z.enum(['adopt', 'reject', 'deprecate']),
  reason: z.string().optional(),
  asUserId: z.string(),
})
export type AdoptSkillRequest = z.infer<typeof adoptSkillSchema>

// ---------- 演示 / 外部注入 ----------

export const mrEventSchema = z.object({
  type: z.enum(['pipeline-run', 'comment', 'review-comment', 'approve', 'post-merge-issue']),
  /** pipeline-run: success|failed|pending；comment: 文本 */
  value: z.string().optional(),
  author: z.string().optional(),
  /** 分诊提示（演示用）：auto|human|info */
  triage: z.enum(['auto', 'human', 'info']).optional(),
})
export type MrEventRequest = z.infer<typeof mrEventSchema>

// ---------- 通用 ----------

export interface ApiError {
  error: string
  message: string
  /** 乐观锁冲突时返回当前最新版本 */
  currentVersion?: number
}
