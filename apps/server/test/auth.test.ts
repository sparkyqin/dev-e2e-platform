import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { makePlatform } from './helpers.js'
import { AuthService, RateLimiter } from '../src/api/auth.js'
import { buildApp } from '../src/api/app.js'
import type { Platform } from '../src/orchestrator/platform.js'

/**
 * 认证与边界加固（P0）应用级测试：
 * 401 拦截 / 演示登录会话 / 身份伪造拒绝 / taskId 校验 / 严格模式后门关闭 / Bearer 令牌 / 限流
 */

let platform: Platform
let disposePlatform: () => Promise<void>
let dir: string
let app: FastifyInstance
let strictApp: FastifyInstance
let auth: AuthService

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const set = res.headers['set-cookie']
  const first = Array.isArray(set) ? set[0] : (set as string)
  return first?.split(';')[0] ?? ''
}

beforeAll(async () => {
  const ctx = await makePlatform()
  platform = ctx.platform
  disposePlatform = ctx.dispose
  dir = ctx.dir

  auth = new AuthService(dir, { demoMode: true })
  await auth.init()
  app = await buildApp(platform, { auth, log: false, rateLimiter: new RateLimiter(100000, 100000) })

  const strictAuth = new AuthService(dir, { demoMode: false })
  await strictAuth.init()
  strictApp = await buildApp(platform, { auth: strictAuth, log: false, rateLimiter: new RateLimiter(100000, 100000) })
})

afterAll(async () => {
  await app.close()
  await strictApp.close()
  await disposePlatform()
})

describe('认证与会话', () => {
  it('未登录访问 API → 401；/api/health 公开 → 200', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/api/tasks' })
    expect(r1.statusCode).toBe(401)
    expect(r1.json().error).toBe('unauthorized')

    const r2 = await app.inject({ method: 'GET', url: '/api/health' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().ok).toBe(true)

    const r3 = await app.inject({ method: 'GET', url: '/api/auth/options' })
    expect(r3.statusCode).toBe(200)
    expect(r3.json().demoMode).toBe(true)
  })

  it('演示登录 → 会话 Cookie → 携带访问 200；/api/auth/me 返回会话身份', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/demo-login', payload: { userId: 'zhangming' } })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().user.userId).toBe('zhangming')
    const cookie = cookieOf(r1)
    expect(cookie).toMatch(/^apsid=/)

    const r2 = await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } })
    expect(r2.statusCode).toBe(200)

    const r3 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(r3.json().user.userId).toBe('zhangming')
  })

  it('伪造 asUserId（与登录身份不符）→ 403 identity-mismatch', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/demo-login', payload: { userId: 'zhangming' } })
    const cookie = cookieOf(login)
    // 以张明登录，却以王浩名义决策/接管 → 拒绝（身份唯一来源=会话）
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-1/gate/decide',
      headers: { cookie },
      payload: { stateVersion: 0, action: 'approve', asUserId: 'wanghao' },
    })
    expect(r1.statusCode).toBe(403)
    expect(r1.json().error).toBe('identity-mismatch')

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-1/takeover',
      headers: { cookie },
      payload: { asUserId: 'wanghao' },
    })
    expect(r2.statusCode).toBe(403)

    const r3 = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-1/annotations',
      headers: { cookie },
      payload: { asUserId: 'wanghao', artifactPath: 'a.md', text: 'x' },
    })
    expect(r3.statusCode).toBe(403)
  })

  it('令牌登录：Bearer 令牌直通 + Cookie 会话；错误令牌 401', async () => {
    const tokens = (await import('node:fs')).readFileSync(`${dir}/runtime/auth-tokens.json`, 'utf8')
    const tok = (JSON.parse(tokens) as { tokens: Record<string, string> }).tokens.wanghao
    const r1 = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: `Bearer ${tok}` } })
    expect(r1.statusCode).toBe(200)

    const r2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'wanghao', token: tok } })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().user.userId).toBe('wanghao')

    const r3 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'wanghao', token: 'tok_wrong_wrong_wrong' } })
    expect(r3.statusCode).toBe(401)

    const r4 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tok}` } })
    expect(r4.json().user.isAdmin).toBe(false)
  })

  it('admin 令牌 → isAdmin；演示端点在严格模式对非管理员 403，对管理员放行', async () => {
    const fs = await import('node:fs')
    const tokens = (JSON.parse(fs.readFileSync(`${dir}/runtime/auth-tokens.json`, 'utf8')) as { tokens: Record<string, string> }).tokens
    const adminTok = tokens.admin
    expect(adminTok).toBeTruthy()

    // 严格模式：非管理员 force-timeout / demo-seed → 403
    const userTok = tokens.zhangming
    const f1 = await strictApp.inject({ method: 'POST', url: '/api/tasks/task-1/gate/force-timeout', headers: { authorization: `Bearer ${userTok}` }, payload: {} })
    expect(f1.statusCode).toBe(403)
    expect(f1.json().error).toBe('demo-only')

    const s1 = await strictApp.inject({ method: 'POST', url: '/api/demo/seed', headers: { authorization: `Bearer ${userTok}` }, payload: {} })
    expect(s1.statusCode).toBe(403)

    // 管理员放行（seed 会真的建任务 → 用 title 区分）
    const s2 = await strictApp.inject({
      method: 'POST',
      url: '/api/demo/seed',
      headers: { authorization: `Bearer ${adminTok}` },
      payload: { title: 'auth-test-seed', scenario: 'clean' },
    })
    expect(s2.statusCode).toBe(201)
  })

  it('严格模式：demo-login/switch 路由不可用（401/404，不铸会话）；MR 注入需签名 → 403', async () => {
    const r1 = await strictApp.inject({ method: 'POST', url: '/api/auth/demo-login', payload: { userId: 'zhangming' } })
    expect([401, 404]).toContain(r1.statusCode)
    expect(r1.headers['set-cookie']).toBeUndefined() // 关键：绝不铸造演示会话

    const fs = await import('node:fs')
    const tokens = (JSON.parse(fs.readFileSync(`${dir}/runtime/auth-tokens.json`, 'utf8')) as { tokens: Record<string, string> }).tokens
    const r2 = await strictApp.inject({
      method: 'POST',
      url: '/api/tasks/task-1/mr/events',
      headers: { authorization: `Bearer ${tokens.zhangming}` },
      payload: { type: 'comment', value: 'x' },
    })
    expect(r2.statusCode).toBe(403)
    expect(r2.json().error).toBe('signature-required')
  })

  it('taskId 路径校验：非法格式 → 400（防路径穿越）', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/demo-login', payload: { userId: 'zhangming' } })
    const cookie = cookieOf(login)
    for (const bad of ['task-1%2f..%2fetc', 'task_abc', 'task-', 'task-99999999999', '%2e%2e']) {
      const r = await app.inject({ method: 'GET', url: `/api/tasks/${bad}`, headers: { cookie } })
      expect([400, 404]).toContain(r.statusCode)
      if (r.statusCode === 400) expect(r.json().error).toBe('bad-task-id')
    }
    // 合法但不存在 → 404 not-found（通过校验层，命中任务查不到）
    const r2 = await app.inject({ method: 'GET', url: '/api/tasks/task-99999', headers: { cookie } })
    expect(r2.statusCode).toBe(404)
  })

  it('限流：认证端点超限 → 429', async () => {
    const tightAuth = new AuthService(dir, { demoMode: false })
    await tightAuth.init()
    const tight = await buildApp(platform, { auth: tightAuth, log: false, rateLimiter: new RateLimiter(100000, 3) })
    let last = 0
    for (let i = 0; i < 5; i++) {
      const r = await tight.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: 'x', token: 'tok_invalid_invalid' } })
      last = r.statusCode
    }
    expect(last).toBe(429)
    await tight.close()
  })
})
