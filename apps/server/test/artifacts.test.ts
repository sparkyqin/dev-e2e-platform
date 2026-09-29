import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactManager, CONTRACT_PATH } from '../src/extension/artifacts.js'

const dirs: string[] = []

async function tmpWs(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'am-test-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
})

describe('产物三分区', () => {
  it('partitionOf：process/delivery/knowledge/host-skills 正确归区', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    expect(am.partitionOf('process/baseline.md')).toBe('process')
    expect(am.partitionOf('delivery/spec.md')).toBe('delivery')
    expect(am.partitionOf('delivery/src/a.js')).toBe('delivery')
    expect(am.partitionOf('knowledge/notes.md')).toBe('knowledge')
    expect(am.partitionOf('host-skills/s.md')).toBe('knowledge')
    expect(am.partitionOf('other.txt')).toBe('process') // 未声明分区兜底过程区
  })

  it('write/read 往返 + 元信息', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    const meta = await am.write('process/baseline.md', '# 基线', 'intake', 'ai')
    expect(meta.partition).toBe('process')
    expect(meta.bytes).toBeGreaterThan(0)
    expect(await am.read('process/baseline.md')).toBe('# 基线')
    expect(await am.exists('process/baseline.md')).toBe(true)
    expect(await am.read('process/nope.md')).toBeNull()
  })
})

describe('契约单源与漂移检测', () => {
  it('writeContract 落单源 + 派生视图；未漂移时 checkDrift 为空', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    await am.writeContract({ version: '1', service: 's', interfaces: [] }, 'process/contract-view.md', (c) => `view of ${JSON.stringify(c)}`)
    expect(await am.read(CONTRACT_PATH)).toBeTruthy()
    expect(await am.read('process/contract-view.md')).toBeTruthy()
    expect(await am.checkDrift([{ path: 'process/contract-view.md' }])).toEqual([])
  })

  it('手改派生视图后检测出漂移', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    await am.writeContract({ version: '1', service: 's', interfaces: [] }, 'process/contract-view.md', (c) => `view of ${JSON.stringify(c)}`)
    // 模拟有人手改视图（绕过单源）
    await am.write('process/contract-view.md', 'view of 手改内容', 'design', 'someone')
    expect(await am.checkDrift([{ path: 'process/contract-view.md' }])).toEqual(['process/contract-view.md'])
  })

  it('无契约时 checkDrift 返回空（不误报）', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    expect(await am.checkDrift([{ path: 'process/contract-view.md' }])).toEqual([])
  })
})

describe('原位批注', () => {
  it('新增批注 / 回复 / 解析', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    const ann = await am.addAnnotation({ artifactPath: 'delivery/spec.md', anchor: 'L12', author: 'zhaolei', authorName: '赵磊', text: '验收标准缺边界' })
    expect(ann.id).toBeTruthy()
    await am.addAnnotation({ artifactPath: ann.id, author: 'wanghao', authorName: '王浩', text: '已补充月末边界', replyTo: ann.id })
    const list = await am.listAnnotations()
    expect(list).toHaveLength(1)
    expect(list[0].replies).toHaveLength(1)
  })

  it('解决 / 重开：按 annotationId 定位（回归：旧实现误用 artifactPath 查找，永不命中）', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    const ann = await am.addAnnotation({ artifactPath: 'delivery/spec.md', anchor: 'L12', author: 'zhaolei', authorName: '赵磊', text: '验收标准缺边界' })
    const r1 = await am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'zhaolei', authorName: '赵磊', annotationId: ann.id, resolve: true })
    expect(r1.resolved).toBe(true)
    const r2 = await am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'zhaolei', authorName: '赵磊', annotationId: ann.id, resolve: false })
    expect(r2.resolved).toBe(false)
    // resolve 落盘
    expect((await am.listAnnotations())[0].resolved).toBe(false)
  })

  it('解决不存在的批注 → 明确报错（不再静默返回 undefined）', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    await expect(am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'x', authorName: 'x', annotationId: 'ann-nope', resolve: true })).rejects.toThrow('批注不存在')
  })

  it('空文本守卫：新批注与回复必须有内容（text 可选但非 resolve 模式必填）', async () => {
    const ws = await tmpWs()
    const am = new ArtifactManager(ws)
    const ann = await am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'zhaolei', authorName: '赵磊', text: '验收标准缺边界' })
    await expect(am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'x', authorName: 'x' })).rejects.toThrow('批注内容不能为空')
    await expect(am.addAnnotation({ artifactPath: 'delivery/spec.md', author: 'x', authorName: 'x', text: '', replyTo: ann.id })).rejects.toThrow('回复内容不能为空')
  })
})
