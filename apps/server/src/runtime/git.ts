import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * Git 操作（[机-fail-closed 合入]：涉及真实推送的动作失败即停止，绝不偷偷放行）
 *
 * 平台是唯一写动作归属（单写者）：引擎只改文件，git 提交/分支/合入全部由平台执行。
 * delivery/ 目录即代码仓（与过程区物理隔离，过程区天然不在 git 内）。
 */

/** Windows shell 模式下 spawn 不做参数引用：含空格/中文/括号的参数必须手动加引号 */
function shellQuote(arg: string): string {
  if (process.platform !== 'win32') return arg
  return /^[\w./\\:=,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '')}"`
}

export function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', args.map(shellQuote), { cwd, shell: process.platform === 'win32' })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => resolve({ ok: false, out, err: String(e) }))
    p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }))
  })
}

export async function initRepo(deliveryDir: string): Promise<void> {
  await git(deliveryDir, 'init', '-b', 'main')
  await git(deliveryDir, 'config', 'user.email', 'platform@ai-platform.local')
  await git(deliveryDir, 'config', 'user.name', 'ai-platform')
  await git(deliveryDir, 'add', '-A')
  await git(deliveryDir, 'commit', '-m', 'chore: 初始基线（平台建仓）')
}

export async function commitAll(deliveryDir: string, message: string): Promise<string | null> {
  await git(deliveryDir, 'add', '-A')
  const st = await git(deliveryDir, 'status', '--porcelain')
  if (!st.out) return null // 无变更
  const c = await git(deliveryDir, 'commit', '-m', message)
  if (!c.ok) return null
  const sha = await git(deliveryDir, 'rev-parse', 'HEAD')
  return sha.ok ? sha.out : null
}

export async function currentSha(deliveryDir: string): Promise<string | null> {
  const r = await git(deliveryDir, 'rev-parse', 'HEAD')
  return r.ok ? r.out : null
}

export async function ensureBranch(deliveryDir: string, branch: string): Promise<void> {
  const cur = await git(deliveryDir, 'branch', '--show-current')
  if (cur.out === branch) return
  await git(deliveryDir, 'checkout', '-b', branch)
}

export async function changedFiles(deliveryDir: string, base = 'main'): Promise<string[]> {
  const r = await git(deliveryDir, 'diff', '--name-only', `${base}...HEAD`)
  if (!r.ok) return []
  return r.out.split('\n').filter(Boolean)
}

export async function diffStat(deliveryDir: string, base = 'main'): Promise<string> {
  const r = await git(deliveryDir, 'diff', '--stat', `${base}...HEAD`)
  return r.ok ? r.out : ''
}

export function deliveryDirOf(taskDir: string): string {
  return path.join(taskDir, 'delivery')
}
