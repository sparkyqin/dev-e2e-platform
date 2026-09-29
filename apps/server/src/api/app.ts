import path from 'node:path'
import { exists } from '../domain/util.js'
import type { Platform } from '../orchestrator/platform.js'
import { registerRoutes } from './routes.js'
import type { AuthService, RateLimiter } from './auth.js'

/**
 * Fastify 装配：认证 + 限流 + CORS 策略 + REST/SSE 路由 + web 静态托管（hash 路由，无需 SPA 回退）
 *
 * 安全基线（生产部署必读 README「生产部署」节）：
 * - 认证：Bearer 令牌 / 签名会话 Cookie；除 public 路由（config.public）外全部要求登录
 * - 限流：进程内滑动窗口（全局限额 + 认证端点收紧）
 * - CORS：CORS_ORIGINS 白名单 → DEMO_MODE 放开（开发/演示）→ 生产默认同源（不注册）
 */
export async function buildApp(
  platform: Platform,
  opts: { webDir?: string; log?: boolean; auth: AuthService; rateLimiter?: RateLimiter } ,
): Promise<import('fastify').FastifyInstance> {
  const { auth } = opts
  const { default: Fastify } = await import('fastify')
  const app: import('fastify').FastifyInstance = Fastify({
    logger: opts.log === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 4 * 1024 * 1024,
  })

  // 保留原始请求体字节（req.rawBody）：MR webhook 的 HMAC 签名必须作用于请求体原文，
  // 不能用 JSON.parse 后再 stringify 的结果（转义/精度差异会让签名永不相等）
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' as const },
    (req, body, done: (err: Error | null, res?: unknown) => void) => {
      try {
        const buf = body as Buffer
        const json = buf.length === 0 ? undefined : JSON.parse(buf.toString('utf8'))
        ;(req as import('fastify').FastifyRequest & { rawBody?: Buffer }).rawBody = buf
        done(null, json)
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // ---- CORS：白名单（逗号分隔）→ DEMO_MODE 放开 → 生产同源（web 同进程托管，无需跨域） ----
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const { default: cors } = await import('@fastify/cors')
  if (origins.length > 0) {
    await app.register(cors, { origin: origins, credentials: true })
  } else if (auth.demoMode) {
    await app.register(cors, { origin: true, credentials: true })
  }

  // ---- 限流（/api/* 全量；认证端点收紧） ----
  const limiter =
    opts.rateLimiter ??
    new (await import('./auth.js')).RateLimiter(Number(process.env.RATE_LIMIT_PER_MIN ?? 600))
  app.addHook('onRequest', limiter.hook)

  // ---- 认证：解析 Bearer / 会话 Cookie → req.user；public 路由豁免（config.public） ----
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return // 静态资源与页面不拦
    if (req.method === 'OPTIONS') return // CORS 预检
    const routePublic = (req.routeOptions?.config as { public?: boolean } | undefined)?.public === true
    if (routePublic) return
    const user = auth.resolve(req)
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized', message: '未登录或会话过期（POST /api/auth/login）' })
      return
    }
    req.user = user
  })

  registerRoutes(app, platform, auth)

  // 静态托管前端产物（生产模式：node main.ts 直接服务 apps/web/dist）
  const webDir = opts.webDir
  if (webDir && (await exists(path.join(webDir, 'index.html')))) {
    const { default: fastifyStatic } = await import('@fastify/static')
    await app.register(fastifyStatic, { root: webDir, prefix: '/' })
    app.log.info(`web 静态托管：${webDir}`)
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not-found', message: `无此路由：${req.raw.url}` })
    }
    return reply.code(404).send({ error: 'not-found', message: '资源不存在' })
  })

  return app
}
