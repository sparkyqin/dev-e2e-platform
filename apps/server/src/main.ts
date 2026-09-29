import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Platform } from './orchestrator/platform.js'
import { AuthService } from './api/auth.js'
import { buildApp } from './api/app.js'

/**
 * 服务入口：env 加载 → Platform 装配 → 认证基座 → Fastify 监听
 *
 * env：AI_ENGINE / OPENCODE_HOST / OPENCODE_KEY / CLAUDE_MODEL / DATA_DIR / PORT
 *      QUIET_HOURS_START / QUIET_HOURS_END / SIM_DELAY
 * 安全：DEMO_MODE（默认 true=开发/演示；生产必须显式 false，关闭免令牌切换/种子/注入后门）
 *      AUTH_SECRET（会话签名，留空自动生成持久化）/ COOKIE_SECURE（反代 TLS 后置 true）
 *      CORS_ORIGINS（白名单；空=同源）/ MR_WEBHOOK_SECRET（MR 事件 HMAC 签名）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnvFile(file: string): void {
  let txt: string
  try {
    txt = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(__dirname, '../../../.env'))

  const dataDir = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data'))
  const port = Number(process.env.PORT ?? 3000)
  const host = process.env.HOST ?? '0.0.0.0'

  // 存储后端：DATABASE_URL → PG（状态/事件/审计真源）；默认文件
  const dbUrl = process.env.DATABASE_URL
  const backend = dbUrl
    ? (await import('./domain/pg-store.js')).createPgBackend(dbUrl, process.env.DATABASE_SCHEMA ?? 'public')
    : undefined
  const platform = new Platform(dataDir, backend ? { backend } : {})
  await platform.init()

  const demoMode = process.env.DEMO_MODE !== 'false' // 默认 true（开发/演示）；生产必须 DEMO_MODE=false
  const auth = new AuthService(dataDir, {
    demoMode,
    secret: process.env.AUTH_SECRET || undefined,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  })
  await auth.init()

  // 生产模式：同进程托管 web 产物（hash 路由无需回退）
  const webDist = path.resolve(__dirname, '../../../web/dist')

  const app = await buildApp(platform, { webDir: webDist, auth })
  await app.listen({ port, host })

  const engine = await platform.engines.defaultEngineId()
  app.log.info(`平台就绪：http://localhost:${port}（data=${dataDir}，engine=${engine}，storage=${dbUrl ? 'pg' : 'file'}）`)
  app.log.info(`认证：DEMO_MODE=${demoMode}，令牌文件=${path.join(dataDir, 'runtime', 'auth-tokens.json')}${demoMode ? '（演示模式可免令牌切换身份）' : '（生产模式：Bearer 令牌或 /api/auth/login）'}`)

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info(`${sig} 收到，优雅退出…`)
    await platform.dispose()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('启动失败：', err)
  process.exit(1)
})
