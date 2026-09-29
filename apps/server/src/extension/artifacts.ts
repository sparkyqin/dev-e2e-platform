import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Annotation, ArtifactMeta, Partition, StageId } from '@ai-platform/shared'
import { PARTITION_META } from '@ai-platform/shared'
import { newId, nowIso, readJson, writeJson } from '../domain/util.js'

/**
 * 产物治理（[机-产物分层·三分区] / [机-产物主权流转] / [机-契约单源]）
 *
 * 三分区：process（不入 git）/ delivery（入 git）/ knowledge（可回流）。
 * 主权：非主权方只读 + 批注；契约唯一真源 delivery/contract/api-contract.json，视图只读派生 + 漂移检测。
 */

export const CONTRACT_PATH = 'delivery/contract/api-contract.json'

export class SovereigntyError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SovereigntyError'
  }
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export class ArtifactManager {
  constructor(private taskDir: string) {}

  abs(relPath: string): string {
    return path.join(this.taskDir, relPath)
  }

  partitionOf(relPath: string): Partition {
    if (relPath.startsWith('process/')) return 'process'
    if (relPath.startsWith('delivery/')) return 'delivery'
    if (relPath.startsWith('knowledge/')) return 'knowledge'
    if (relPath.startsWith('host-skills/')) return 'knowledge'
    return 'process'
  }

  async write(relPath: string, content: string, stage: StageId, sovereignRole: string): Promise<ArtifactMeta> {
    const full = this.abs(relPath)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
    const bytes = Buffer.byteLength(content)
    return {
      path: relPath,
      partition: this.partitionOf(relPath),
      bytes,
      updatedAt: nowIso(),
      stage,
      sovereignRole,
    }
  }

  async read(relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(relPath), 'utf8')
    } catch {
      return null
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.abs(relPath))
      return true
    } catch {
      return false
    }
  }

  // ---- 契约单源 ----

  /** 契约写入唯一入口；同步刷新派生视图（只读投影） */
  async writeContract(contract: unknown, derivedViewRelPath: string, render: (c: unknown) => string): Promise<void> {
    const source = JSON.stringify(contract, null, 2)
    await this.write(CONTRACT_PATH, source, 'design', 'owner')
    await this.write(derivedViewRelPath, render(contract), 'design', 'system')
    await this.recordContractState(derivedViewRelPath, source)
  }

  /** 漂移检测：视图内容是否与单源一致 */
  async checkDrift(views: { path: string }[]): Promise<string[]> {
    const drifted: string[] = []
    const source = await this.read(CONTRACT_PATH)
    if (!source) return []
    for (const v of views) {
      const view = await this.read(v.path)
      if (view === null) continue
      const state = await this.contractState()
      const entry = state?.derivedViews.find((d) => d.path === v.path)
      if (!entry || entry.hashOfView !== sha(view) || entry.hashOfSource !== sha(source)) {
        drifted.push(v.path)
      }
    }
    return drifted
  }

  async contractState(): Promise<import('@ai-platform/shared').ContractState | null> {
    return readJson<import('@ai-platform/shared').ContractState>(this.abs('delivery/contract/.contract-state.json'))
  }

  private async recordContractState(viewPath: string, source: string): Promise<void> {
    const view = await this.read(viewPath)
    const state =
      (await this.contractState()) ?? {
        contractPath: CONTRACT_PATH,
        sourceHash: '',
        updatedAt: '',
        derivedViews: [],
      }
    state.sourceHash = sha(source)
    state.updatedAt = nowIso()
    const entry = state.derivedViews.find((d) => d.path === viewPath)
    if (entry) {
      entry.hashOfSource = sha(source)
      entry.hashOfView = sha(view ?? '')
      entry.drifted = false
    } else {
      state.derivedViews.push({ path: viewPath, hashOfSource: sha(source), hashOfView: sha(view ?? ''), drifted: false })
    }
    await writeJson(this.abs('delivery/contract/.contract-state.json'), state)
  }

  // ---- 原位批注 ----

  private annotationsFile(): string {
    return path.join(this.taskDir, 'process', 'annotations.json')
  }

  async listAnnotations(): Promise<Annotation[]> {
    return (await readJson<Annotation[]>(this.annotationsFile())) ?? []
  }

  async addAnnotation(input: {
    artifactPath: string
    anchor?: string
    author: string
    authorName: string
    text: string
    replyTo?: string
    resolve?: boolean
  }): Promise<Annotation> {
    const list = await this.listAnnotations()
    if (input.replyTo) {
      const target = list.find((a) => a.id === input.replyTo)
      if (!target) throw new Error(`批注不存在：${input.replyTo}`)
      target.replies.push({ id: newId('ann'), author: input.author, authorName: input.authorName, text: input.text, ts: nowIso() })
      await writeJson(this.annotationsFile(), list)
      return target
    }
    if (input.resolve) {
      const target = list.find((a) => a.id === input.artifactPath)
      target && (target.resolved = true)
      await writeJson(this.annotationsFile(), list)
      return target as Annotation
    }
    const ann: Annotation = {
      id: newId('ann'),
      artifactPath: input.artifactPath,
      anchor: input.anchor,
      author: input.author,
      authorName: input.authorName,
      text: input.text,
      ts: nowIso(),
      replies: [],
      resolved: false,
    }
    list.push(ann)
    await writeJson(this.annotationsFile(), list)
    return ann
  }
}
