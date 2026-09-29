#!/usr/bin/env node
/**
 * v1(10 阶段) → v2(5+1 段) 存量任务迁移
 *
 * 用法：
 *   node scripts/migrate-v2.mjs            # dry-run：只打印迁移计划，不落盘
 *   node scripts/migrate-v2.mjs --apply    # 先备份整个 tasks/ 到 tasks-v1-backup-<ts>/ 再落盘
 *
 * 迁移规则（单源：packages/shared/src/stages.ts 的 LEGACY_STAGE_ALIAS）：
 *   - stage / completedStages / stageRounds / currentStepIndex 重映射（轮次取 max，完成集去重保序）
 *   - gate.stage、gate.options[].rollbackTarget、gate.decision?.rollbackTarget 重映射
 *   - artifacts[].stage 重映射（sovereignRole 不动）
 *   - 旧 execute 三阶段（code/verify/deliver）任务补 .flow/execute-phase.json 段内检查点
 *   - 事件流 events.jsonl append-only 不动（web 端有旧 id 展示兜底）；projection.json 重启自动重建
 *
 * 前置纪律：dev server 必须停机；状态里不允许有 running 任务（recover 会转 queued，
 * 但迁移期间不允许并发写）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = path.resolve(HERE, '..', 'data', 'runtime')
const TASKS_DIR = path.join(RUNTIME_DIR, 'tasks')
const APPLY = process.argv.includes('--apply')

const ALIAS = { intake: 'requirement', clarify: 'requirement', review: 'test-design', code: 'execute', verify: 'execute', deliver: 'execute' }
const V2_ORDER = ['requirement', 'architecture', 'design', 'test-design', 'execute', 'merged']
const mapStage = (s) => ALIAS[s] ?? s

/** 原子写（与平台 util.writeJson 同款：tmp + rename，Windows EPERM 重试） */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rename(tmp, file)
      return
    } catch (err) {
      if (attempt === 4) throw err
      await new Promise((r) => setTimeout(r, 20 + attempt * 50))
    }
  }
}

async function main() {
  const entries = await fs.promises.readdir(TASKS_DIR, { withFileTypes: true }).catch(() => [])
  const taskDirs = entries.filter((e) => e.isDirectory() && /^task-\d+$/.test(e.name)).map((e) => e.name)
  if (taskDirs.length === 0) {
    console.log('没有可迁移的任务目录。')
    return
  }

  // ---- 前置检查：0 running ----
  const states = []
  for (const dir of taskDirs) {
    const sf = path.join(TASKS_DIR, dir, '.flow', 'state.json')
    const st = JSON.parse(await fs.promises.readFile(sf, 'utf8'))
    states.push({ dir, sf, st })
  }
  const running = states.filter(({ st }) => st.status === 'running')
  if (running.length > 0) {
    console.error(`!! 有 ${running.length} 个 running 任务（${running.map((r) => r.st.taskId).join('、')}）——先停 dev server 等任务收敛后再迁移。`)
    process.exit(1)
  }

  // ---- 迁移计划 ----
  const plan = []
  const stats = {}
  for (const { dir, sf, st } of states) {
    const oldStage = st.stage
    const newStage = mapStage(oldStage)
    if (!V2_ORDER.includes(newStage)) {
      console.error(`!! ${st.taskId}: 未知阶段 "${oldStage}"，跳过（人工检查）`)
      continue
    }

    const changes = []
    if (newStage !== oldStage) {
      changes.push(`stage: ${oldStage} → ${newStage}`)
      st.stage = newStage
    }

    // completedStages：映射 + 去重保序
    const oldCompleted = Array.isArray(st.completedStages) ? st.completedStages : []
    const newCompleted = [...new Set(oldCompleted.map(mapStage))]
    if (JSON.stringify(newCompleted) !== JSON.stringify(oldCompleted)) {
      changes.push(`completedStages: ${oldCompleted.length} → ${newCompleted.length} 项（去重）`)
      st.completedStages = newCompleted
    }

    // stageRounds：合并映射（requirement=max(intake,clarify)、execute=max(code,verify,deliver)，其余直通）
    const oldRounds = { ...(st.stageRounds ?? {}) }
    const newRounds = {}
    for (const [k, v] of Object.entries(oldRounds)) {
      const nk = mapStage(k)
      if (newRounds[nk] === undefined || v > newRounds[nk]) newRounds[nk] = v
    }
    // 保证 V2 顺序观感（非必须，但干净）
    const orderedRounds = {}
    for (const sid of V2_ORDER) if (newRounds[sid] !== undefined) orderedRounds[sid] = newRounds[sid]
    if (JSON.stringify(orderedRounds) !== JSON.stringify(oldRounds)) {
      changes.push(`stageRounds: {${Object.keys(oldRounds).join(',')}} → {${Object.keys(orderedRounds).join(',')}}`)
      st.stageRounds = orderedRounds
    }

    // currentStepIndex：新轨序号
    const newStep = V2_ORDER.indexOf(newStage) + 1
    if (st.currentStepIndex !== newStep) {
      changes.push(`currentStepIndex: ${st.currentStepIndex} → ${newStep}`)
      st.currentStepIndex = newStep
    }

    // gate：stage / options[].rollbackTarget / decision.rollbackTarget
    if (st.gate) {
      const g = st.gate
      if (g.stage !== newStage) changes.push(`gate.stage: ${g.stage} → ${newStage}`)
      g.stage = newStage
      for (const opt of g.options ?? []) {
        if (opt.rollbackTarget) {
          const nt = mapStage(opt.rollbackTarget)
          if (nt !== opt.rollbackTarget) changes.push(`gate.option "${opt.label}": rollbackTarget ${opt.rollbackTarget} → ${nt}`)
          opt.rollbackTarget = nt
        }
      }
      if (g.decision?.rollbackTarget) {
        const nt = mapStage(g.decision.rollbackTarget)
        if (nt !== g.decision.rollbackTarget) changes.push(`gate.decision.rollbackTarget: ${g.decision.rollbackTarget} → ${nt}`)
        g.decision.rollbackTarget = nt
      }
    }

    // artifacts[].stage
    let artChanged = 0
    for (const a of st.artifacts ?? []) {
      const na = mapStage(a.stage)
      if (na !== a.stage) {
        a.stage = na
        artChanged++
      }
    }
    if (artChanged > 0) changes.push(`artifacts: ${artChanged} 项 stage 重映射`)

    // execute-phase.json：旧 execute 三阶段 → 段内检查点
    let writePhase = null
    if (newStage === 'execute' && ['code', 'verify', 'deliver'].includes(oldStage)) {
      writePhase = oldStage
      changes.push(`execute-phase.json: { phase: "${oldStage}" }`)
    }

    const key = `${oldStage}/${st.status} → ${newStage}/${st.status}`
    stats[key] = (stats[key] ?? 0) + 1
    plan.push({ dir, sf, st, changes, writePhase })
  }

  // ---- 打印计划 ----
  console.log(`== v1→v2 迁移${APPLY ? '（APPLY）' : '（DRY-RUN，加 --apply 落盘）'} ==`)
  console.log(`任务总数：${plan.length}`)
  for (const [k, n] of Object.entries(stats).sort()) console.log(`  ${k} ×${n}`)
  const noChange = plan.filter((p) => p.changes.length === 0 && !p.writePhase)
  console.log(`无变化：${noChange.length} 个`)
  for (const p of plan) {
    if (p.changes.length === 0) continue
    console.log(`  ${p.st.taskId}（v${p.st.stateVersion}）:`)
    for (const c of p.changes) console.log(`    - ${c}`)
  }

  if (!APPLY) {
    console.log('\ndry-run 结束——未写任何文件。')
    return
  }

  // ---- 备份 + 落盘 ----
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupDir = path.join(RUNTIME_DIR, `tasks-v1-backup-${ts}`)
  await fs.promises.cp(TASKS_DIR, backupDir, { recursive: true })
  console.log(`\n备份完成：${backupDir}`)

  let written = 0
  for (const p of plan) {
    if (p.changes.length === 0) continue
    await writeJsonAtomic(p.sf, p.st)
    if (p.writePhase) {
      await writeJsonAtomic(path.join(TASKS_DIR, p.dir, '.flow', 'execute-phase.json'), { phase: p.writePhase })
    }
    written++
  }
  console.log(`落盘完成：${written} 个 state.json 已重写（事件流未动；projection.json 由服务重启时 rebuild）。`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
