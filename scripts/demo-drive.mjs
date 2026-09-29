// 演示链路驱动器：模拟前端操作序列（轮询状态 → 以门的拍板人身份决策 → MR 注入 → 合入）
// 支持 AR 并行：父任务聚合等待时递归驱动各子任务（各自 编码→验证→测试门→MR→交付门）
// 认证：DEMO_MODE 下 demo-login 建会话，决策前 switch 到门的 soleDecider（身份唯一来源=会话）
// 用法：node scripts/demo-drive.mjs <taskId>
const BASE = 'http://localhost:8787'

let cookie = ''
let currentUser = ''

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0]
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function ensureSessionAs(userId) {
  if (currentUser === userId) return
  if (!currentUser) {
    const { user } = await j('POST', '/api/auth/demo-login', { userId })
    currentUser = user.userId
    console.log(`会话：以 ${user.name}（${user.userId}）登录`)
    return
  }
  const { user } = await j('POST', '/api/auth/switch', { userId })
  currentUser = user.userId
  console.log(`会话：切换为 ${user.name}（${user.userId}）`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getDetail(id) {
  return j('GET', `/api/tasks/${id}`)
}

// 拍板人动态取门的 soleDecider：fact(clarify)=需求方 / fact(architecture)=架构师 /
// fact(design)=开发 / fact(test-design)=TSE / fact(AR 拆分)=开发 / review=检视人 /
// test=开发 / test(AR 聚合验收)=TSE / delivery=合入方
const FACT_ANSWER = '积分快过期的定义：距过期≤7天；提醒渠道：App 内信优先、短信兜底；清零留痕：写审计表。'

async function decideCurrent(taskId, d) {
  const g = d.state.gate
  if (!g) return null
  if (g.status !== 'raised') return null
  const asUserId = g.soleDecider.userId // 动态取门的唯一拍板人
  await ensureSessionAs(asUserId) // 身份唯一来源=会话：以拍板人身份决策
  const body = { stateVersion: d.state.stateVersion, action: g.kind === 'delivery' ? 'merge' : 'approve', asUserId }
  if (g.kind === 'fact' && g.options.some((o) => o.action === 'answer')) {
    body.action = 'answer'
    body.answer = FACT_ANSWER
  }
  try {
    return await j('POST', `/api/tasks/${taskId}/gate/decide`, body)
  } catch (e) {
    // 409 版本冲突 = 门已被超时降级/他人决策（先到先得）：重新轮询即可，不视为失败
    if (String(e.message).includes('409')) return null
    throw e
  }
}

const pad = (n) => '  '.repeat(n)

async function driveTask(taskId, depth = 0, maxSteps = 150) {
  for (let step = 0; step < maxSteps; step++) {
    const d = await getDetail(taskId)
    const s = d.state
    const t = s.arTitle ? `[AR] ${s.arTitle}` : s.title
    console.log(`${pad(depth)}[${s.stage}/${s.status}] v${s.stateVersion} gate=${s.gate ? `${s.gate.kind}:${s.gate.status}` : '-'} rounds=${s.repairRounds} · ${t}`)

    if (s.status === 'merged' || s.status === 'archived') return true
    if (s.status === 'failed') {
      console.log(`${pad(depth)}!! 任务失败：`, s.health.facts.map((f) => f.message).join('; '))
      return false
    }

    // AR 聚合等待：逐个驱动子任务（各自走完 编码→验证→MR→合入）
    if (s.status === 'aggregating' && s.subtasks?.length) {
      console.log(`${pad(depth)}↳ AR 聚合等待：驱动 ${s.subtasks.length} 个子任务`)
      for (const sub of s.subtasks) {
        if (sub.status === 'merged' || sub.status === 'archived') continue
        const ok = await driveTask(sub.taskId, depth + 1)
        if (!ok) {
          console.log(`${pad(depth)}!! 子任务失败：${sub.taskId}（${sub.arTitle}）`)
          return false
        }
      }
      await sleep(400)
      continue
    }

    // 门等待 → 决策
    if (s.status === 'gate-wait' && s.gate && s.gate.status === 'raised') {
      const st = await decideCurrent(taskId, d)
      console.log(`${pad(depth)}   -> 决策 ${st.state?.gate?.decision?.action ?? st.gate?.decision?.action ?? '(已清)'} by ${s.gate.soleDecider.name}`)
      continue
    }

    // deliver/watching：MR 注入流水线绿 + approve → 举交付门
    if (s.stage === 'deliver' && s.mr && !d.delivery?.mergeReadiness?.ready) {
      const mrState = d.delivery?.mrState
      if (mrState !== 'merged') {
        const hasGreen = d.delivery?.pipelines?.some((p) => p.state === 'success' && p.sha === s.mr.sha)
        if (!hasGreen) {
          await j('POST', `/api/tasks/${taskId}/mr/events`, { type: 'pipeline-run', value: 'success' })
          console.log(`${pad(depth)}   -> 注入流水线 success`)
          continue
        }
        const approved = d.delivery?.feedback?.some((f) => f.status === 'logged' || f.status === 'waived' || f.status === 'fixed')
        if (!approved) {
          await j('POST', `/api/tasks/${taskId}/mr/events`, { type: 'approve', author: '外部评审人' })
          console.log(`${pad(depth)}   -> 注入 approve`)
        }
        await sleep(400)
        continue
      }
    }

    await sleep(500)
  }
  console.log(`${pad(depth)}!! 驱动步数耗尽：${taskId}`)
  return false
}

async function main() {
  const taskId = process.argv[2]
  if (!taskId) {
    console.error('用法：node demo-drive.mjs <taskId>')
    process.exit(1)
  }
  await ensureSessionAs('zhangming') // 先建会话（后续按门拍板人切换）
  console.log(`== 演示驱动开始：${taskId} ==`)
  const ok = await driveTask(taskId)
  if (!ok) process.exit(2)

  const d = await getDetail(taskId)
  console.log(`== 终态：${d.state.stage}/${d.state.status} ==`)
  const page = await j('GET', `/api/tasks/${taskId}/events?afterSeq=0`)
  const kinds = {}
  for (const e of page.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  console.log('事件流统计：', JSON.stringify(kinds))
  console.log(`产物 ${d.state.artifacts.length} 个：`, d.state.artifacts.map((a) => a.path).join(', '))
  console.log(`历程 ${d.journey.length} 条；批注 ${d.annotations.length} 条`)
  if (d.state.subtasks?.length) {
    console.log('AR 谱系：')
    for (const sub of d.state.subtasks) console.log(`  - ${sub.taskId}「${sub.arTitle}」（${sub.ownerName}）→ ${sub.status}`)
  }
  const m = await j('GET', '/api/metrics')
  console.log(
    `度量：任务 ${m.summary.taskCount}（合入 ${m.summary.mergedCount}·活跃 ${m.summary.activeCount}）· TTM 中位 ${Math.round((m.summary.medianTtmMs ?? 0) / 1000)}s · 回退均值 ${m.summary.avgRollbacks} · 事件 ${m.summary.totalEvents}`,
  )
}

main().catch((e) => {
  console.error('驱动失败：', e.message)
  process.exit(1)
})
