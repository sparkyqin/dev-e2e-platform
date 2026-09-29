import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { USERS } from '@ai-platform/shared'
import type { SessionUser } from '@ai-platform/shared'
import { readJson, writeJson } from '../domain/util.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * 认证与会话（生产基座 P0：身份唯一来源）
 *
 * - 令牌模式（AUTH_MODE=token，本期默认）：`data/runtime/auth-tokens.json` 首启为全部用户生成
 *   `tok_<48hex>`；轮换 = 编辑文件重启（或定期再生成）。API 客户端用 `Authorization: Bearer <token>`。
 * - 浏览器会话：`POST /api/auth/login`（userId + token）→ 签名 Cookie（HttpOnly/SameSite=Lax，
 *   HMAC-SHA256，12h）。无服务端会话存储，签名密钥首启生成于 `data/runtime/.auth-secret`。
 * - OIDC 适配位：企业 SSO 接入时实现同构替换（本期未带 IdP，不做半吊子代码）。
 * - DEMO_MODE=true 时提供 /api/auth/demo-login（免令牌切换演示身份）；生产必须 DEMO_MODE=false。
 *
 * 身份收敛：所有操作的 asUserId 一律取自认证身份（req.user），请求体伪造 asUserId → 403。
 */

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

/** 会话身份契约从 shared 单源派生 */
export type AuthUser = SessionUser

interface SecretFile {
  v: string
}

interface TokenFile {
  tokens: Record<string, string>
  generatedAt: string
}

const SESSION_TTL_MS = 12 * 3600_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export class AuthService {
  readonly cookieName = 'apsid'
  readonly demoMode: boolean
  private readonly cookieSecure: boolean
  private secret = ''
  private tokens: Record<string, string> = {}

  constructor(
    dataDir: string,
    opts: { demoMode?: boolean; secret?: string; cookieSecure?: boolean } = {},
  ) {
    this.demoMode = opts.demoMode ?? true
    this.cookieSecure = opts.cookieSecure ?? false
    if (opts.secret) this.secret = opts.secret
    this.runtimeDir = path.join(dataDir, 'runtime')
  }

  private readonly runtimeDir: string

  async init(): Promise<void> {
    // 会话签名密钥：env 优先，否则首启生成并持久化（文件属主权限由部署侧约束）
    if (!this.secret) {
      const secretFile = path.join(this.runtimeDir, '.auth-secret')
      this.secret = (await readJson<SecretFile>(secretFile))?.v ?? ''
      if (!this.secret) {
        this.secret = randomBytes(32).toString('hex')
        await writeJson(secretFile, { v: this.secret } satisfies SecretFile)
      }
    }
    // 用户令牌：文件单源（首启生成全量；轮换=编辑文件后重启）
    const tokenFile = path.join(this.runtimeDir, 'auth-tokens.json')
    const saved = await readJson<TokenFile>(tokenFile)
    this.tokens = saved?.tokens ?? {}
    const missing = [...new Set(USERS.map((u) => u.userId))].filter((id) => !this.tokens[id])
    if (!saved || missing.length > 0) {
      for (const id of missing) this.tokens[id] = `tok_${randomBytes(24).toString('hex')}`
      await writeJson(tokenFile, { tokens: this.tokens, generatedAt: new Date().toISOString() } satisfies TokenFile)
    }
  }

  userOf(userId: string): AuthUser | null {
    const u = USERS.find((x) => x.userId === userId)
    if (!u) return null
    return { userId: u.userId, name: u.name, role: u.role, isAdmin: u.userId === 'admin' }
  }

  verifyToken(token: string): AuthUser | null {
    if (!token) return null
    for (const [userId, tok] of Object.entries(this.tokens)) {
      if (safeEq(tok, token)) return this.userOf(userId)
    }
    return null
  }

  mintSession(user: AuthUser): string {
    const payload = Buffer.from(JSON.stringify({ u: user.userId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url')
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${sig}`
  }

  verifySession(sid: string | undefined): AuthUser | null {
    if (!sid) return null
    const dot = sid.indexOf('.')
    if (dot <= 0) return null
    const payload = sid.slice(0, dot)
    const sig = sid.slice(dot + 1)
    const expect = createHmac('sha256', this.secret).update(payload).digest('base64url')
    if (!safeEq(expect, sig)) return null
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string; exp: number }
      if (Date.now() > data.exp) return null
      return this.userOf(data.u)
    } catch {
      return null
    }
  }

  /** 从请求解析认证身份：Bearer 令牌（API 客户端）→ 会话 Cookie（浏览器） */
  resolve(req: FastifyRequest): AuthUser | null {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (bearer) {
      const u = this.verifyToken(bearer)
      if (u) return u
    }
    const cookies = parseCookies(req.headers.cookie ?? '')
    return this.verifySession(cookies[this.cookieName])
  }

  setSessionCookie(reply: FastifyReply, user: AuthUser): void {
    const sid = this.mintSession(user)
    reply.header(
      'set-cookie',
      `${this.cookieName}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${this.cookieSecure ? '; Secure' : ''}`,
    )
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.header('set-cookie', `${this.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
  }
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** 身份绑定：操作者身份一律取认证身份；请求体伪造 asUserId 拒绝（403 知情） */
export function bindIdentity(req: FastifyRequest, asUserId: string | undefined): AuthUser {
  const me = req.user
  if (!me) throw new HttpError(401, 'unauthorized', '未登录或会话过期')
  if (asUserId && asUserId !== me.userId) {
    const claimed = USERS.find((u) => u.userId === asUserId)
    throw new HttpError(403, 'identity-mismatch', `身份不符：当前以「${me.name}」登录，请求以「${claimed?.name ?? asUserId}」操作（拒绝）`)
  }
  return me
}

/**
 * 进程内滑动窗口限流（单实例规模；多实例部署换共享存储实现，接口不变）
 * - 全局：RATE_LIMIT_PER_MIN（默认 600/min · IP）
 * - 凭证端点收紧：/api/auth/login 与 /api/auth/demo-login 10/min（防令牌枚举；
 *   switch/me/logout 为已认证动作，走全局额度）
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private limitPerMin: number,
    private authLimitPerMin = 10,
  ) {}

  readonly hook = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.url.startsWith('/api/')) return
    const path = req.url.split('?')[0]
    const isCredential = path === '/api/auth/login' || path === '/api/auth/demo-login'
    const limit = isCredential ? this.authLimitPerMin : this.limitPerMin
    const now = Date.now()
    const key = `${isCredential ? 'auth' : 'api'}:${req.ip}`
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (arr.length >= limit) {
      await reply.code(429).send({ error: 'rate-limited', message: '请求过于频繁，请稍后再试' })
      return
    }
    arr.push(now)
    this.hits.set(key, arr)
    if (this.hits.size > 20_000) this.hits.clear() // 兜底防内存膨胀
  }
}
