import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { Platform } from '../orchestrator/platform.js'

/**
 * 演示种子：创建任务 #101「会员积分过期提醒」（simulated 引擎 + strict playbook）
 *
 * 用法：npm run seed [-- [--scenario clean|flaky-tool|build-fail|feedback-loop] [--playbook strict|default|fast]]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

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

  const platform = new Platform(dataDir)
  await platform.init()
  try {
    const scenario = arg('scenario', 'clean') as 'clean' | 'flaky-tool' | 'build-fail' | 'feedback-loop'
    const playbookId = arg('playbook', 'strict')
    const arParallel = arg('ar-parallel', 'false') === 'true'

    const state = await platform.createTask({
      title: '会员积分过期提醒',
      requirementText: '会员中心：积分快过期的会员，在过期前 7 天发提醒（短信/App 内信），过期后积分清零要留痕。',
      module: 'membership-points',
      repo: 'membership-center',
      mode: 'incremental',
      playbookId,
      people: {},
      unattended: false,
      engineId: 'simulated',
      scenario,
      arParallel,
    })
    console.log(`已创建演示任务：#${state.seq} ${state.title}（scenario=${scenario}，playbook=${playbookId}，engine=simulated，arParallel=${arParallel}）`)
    console.log(`任务 ID：${state.taskId}`)
    console.log('打开前端 http://localhost:5173 观察会话厅与任务工作台。')
  } finally {
    await platform.dispose()
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('种子失败：', err)
  process.exit(1)
})
