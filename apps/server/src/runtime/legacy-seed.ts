import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 存量仓种子（场景1 演示用）
 *
 * 「会员中心」存量缩影：模拟 3 万行跨 2 微服务的存量仓（此处为可演示的缩影），
 * 供增量/全量逆向建立基线、编码阶段在其上改造。
 */

const LEGACY_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'membership-center',
      version: '2.3.0',
      private: true,
      scripts: { build: 'node scripts/build.js', test: 'node --test test/' },
    },
    null,
    2,
  ),
  'README.md': `# membership-center 会员中心\n\n存量服务：会员资料 / 积分域 / 消息触达。\n积分域：获取、消耗、过期（定时任务驱动）。\n注意：push-legacy-client 自 v2.1 起停止维护。\n`,
  'src/index.js': `'use strict'\n// 会员中心入口：路由挂载与定时任务注册\nconst express = require('express')\nconst { registerCron } = require('./services/cron-registry')\nconst pointsService = require('./services/points-service')\n\nconst app = express()\napp.use(express.json())\n\napp.post('/api/points/earn', async (req, res) => res.json(await pointsService.earn(req.body)))\napp.post('/api/points/spend', async (req, res) => res.json(await pointsService.spend(req.body)))\n\nregisterCron('points-expiry', '0 0 1 * *', () => pointsService.clearExpired())\n\nmodule.exports = app\n`,
  'src/config.js': `'use strict'\nmodule.exports = {\n  db: { url: process.env.DB_URL ?? 'postgres://membership' },\n  push: { legacyEndpoint: 'http://push-legacy.internal/v1' },\n  points: { expiryPolicy: 'natural-month' },\n}\n`,
  'src/services/points-service.js': `'use strict'\n// 积分域：获取/消耗/过期\nconst userRepo = require('../repositories/user-repo')\n\nasync function earn({ userId, points, reason }) {\n  // ... 入账\n  return { userId, points, reason }\n}\n\nasync function spend({ userId, points }) {\n  // ... 扣减\n  return { userId, points }\n}\n\nasync function clearExpired() {\n  // 月度过期清零（次月 1 日由 cron 触发）\n  return { cleared: true }\n}\n\nmodule.exports = { earn, spend, clearExpired }\n`,
  'src/services/push-legacy-client.js': `'use strict'\n// 旧推送客户端（v2.1 起停止维护，接口可用性存疑）\nasync function send(payload) {\n  throw new Error('LegacyPushClient.send is not a function（接口不存在）')\n}\n\nmodule.exports = { send }\n`,
  'src/repositories/user-repo.js': `'use strict'\n// 用户仓储\nasync function findActiveWithPoints() {\n  return []\n}\n\nmodule.exports = { findActiveWithPoints }\n`,
  'src/services/cron-registry.js': `'use strict'\n// 定时任务注册表\nconst jobs = new Map()\nfunction registerCron(name, spec, fn) {\n  jobs.set(name, { name, spec, fn })\n}\nmodule.exports = { registerCron, jobs }\n`,
  'scripts/build.js': `console.log('build ok')\n`,
}

export async function seedLegacyRepo(deliveryDir: string): Promise<void> {
  for (const [rel, content] of Object.entries(LEGACY_FILES)) {
    const full = path.join(deliveryDir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
  }
}

export async function seedGreenfield(deliveryDir: string): Promise<void> {
  await fs.mkdir(path.join(deliveryDir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(deliveryDir, 'package.json'),
    JSON.stringify({ name: 'greenfield-app', version: '0.1.0', private: true, scripts: { build: 'node scripts/build.js' } }, null, 2),
    'utf8',
  )
  await fs.mkdir(path.join(deliveryDir, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(deliveryDir, 'scripts', 'build.js'), `console.log('build ok')\n`, 'utf8')
}
