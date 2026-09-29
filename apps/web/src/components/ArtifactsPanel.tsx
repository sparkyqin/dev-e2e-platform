/**
 * 材料区：产物三分区（process 不入 git / delivery 入 git / knowledge 可回流）
 * - 点击查看内容（只读；人走批注，产物写入仅由引擎/平台执行）
 * - 原位批注（讨论串 + 解决标记）
 * - 契约单源漂移警示
 * - 知识注入摘要（OKL 三层实际塞了什么）
 */
import { useCallback, useEffect, useState } from 'react'
import type { Annotation, ArtifactMeta, InjectionSummary, Partition, TaskDetail } from '@ai-platform/shared'
import { PARTITION_META, STAGE_SOVEREIGNTY } from '@ai-platform/shared'
import type { StageId } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { fmtBytes, fmtTime, stageShort } from '../format'

const PARTITIONS: Partition[] = ['delivery', 'process', 'knowledge']

export default function ArtifactsPanel({ taskId, detail, refreshDetail, focusPath }: { taskId: string; detail: TaskDetail; refreshDetail: () => Promise<void>; focusPath?: string | null }): React.JSX.Element {
  const { me, pushToast } = useApp()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [annText, setAnnText] = useState('')
  const [annAnchor, setAnnAnchor] = useState('')
  const [busy, setBusy] = useState(false)
  const state = detail.state

  const load = useCallback(
    async (path: string) => {
      try {
        const c = await api.artifact(taskId, path)
        setContent(c.content)
      } catch (e) {
        setContent(`（读取失败：${(e as Error).message}）`)
      }
    },
    [taskId],
  )

  useEffect(() => {
    if (openPath) void load(openPath)
  }, [openPath, load])

  // 任务看板产物卡直达：外部 focusPath 播种打开（点击看板卡 → 材料页自动展开该产物）
  useEffect(() => {
    if (focusPath) setOpenPath(focusPath)
  }, [focusPath])

  const annotationsFor = (path: string): Annotation[] => detail.annotations.filter((a) => a.artifactPath === path)

  const annotate = async (): Promise<void> => {
    if (!openPath || !annText.trim()) return
    setBusy(true)
    try {
      await api.annotate(taskId, { artifactPath: openPath, anchor: annAnchor || undefined, text: annText, asUserId: me.userId })
      setAnnText('')
      setAnnAnchor('')
      await refreshDetail()
      pushToast('批注已留（原位讨论，随产物路径锚定）', 'ok')
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (a: Annotation): Promise<void> => {
    setBusy(true)
    try {
      await api.annotate(taskId, { artifactPath: a.artifactPath, text: a.text, asUserId: me.userId, resolve: !a.resolved })
      await refreshDetail()
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const sovereignNow = STAGE_SOVEREIGNTY[state.stage as StageId] ?? 'owner'
  const injections = detail.injections

  return (
    <div className="artifacts">
      {detail.contract && detail.contract.driftedViews.length > 0 && (
        <div className="notice err in-panel">
          ⚠ 契约派生视图漂移：{detail.contract.driftedViews.join(', ')}（契约单源 {detail.contract.path}）
        </div>
      )}
      {PARTITIONS.map((part) => {
        const list = state.artifacts.filter((a) => a.partition === part)
        if (list.length === 0 && part !== 'delivery') return null
        return (
          <section key={part} className={`artifact-group part-${part}`}>
            <h4>
              <span className={`part-dot p-${part}`} title={`${PARTITION_META[part].desc}${PARTITION_META[part].inGit ? '（入 git）' : '（不入 git）'}`} />
              {PARTITION_META[part].label}
              <small>{PARTITION_META[part].inGit ? '入 git' : '不入 git'}</small>
              <span className="count">{list.length}</span>
            </h4>
            <ul>
              {list.length === 0 && <li className="empty">（暂无）</li>}
              {list.map((a: ArtifactMeta) => (
                <li key={a.path}>
                  <button className={`artifact-row ${openPath === a.path ? 'on' : ''}`} onClick={() => setOpenPath(openPath === a.path ? null : a.path)}>
                    <code>{a.path}</code>
                    <span className="artifact-meta">
                      {fmtBytes(a.bytes)} · {stageShort(a.stage)}
                      {a.sovereignRole === sovereignNow ? <span className="tag sov">主权·{a.sovereignRole}</span> : <span className="tag ro">只读</span>}
                      {annotationsFor(a.path).length > 0 && <span className="tag ann">💬 {annotationsFor(a.path).length}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {openPath && (
        <div className="artifact-viewer">
          <div className="viewer-head">
            <code>{openPath}</code>
            <button className="icon-btn" onClick={() => setOpenPath(null)}>
              ✕
            </button>
          </div>
          <pre>{content ?? '读取中…'}</pre>
          <div className="viewer-ann">
            <h5>
              批注（{annotationsFor(openPath).length}）· 当前主权角色 {sovereignNow}，非主权方只读+批注
            </h5>
            <div className="ann-new">
              <input placeholder="锚点（小节标题/行号，可选）" value={annAnchor} onChange={(e) => setAnnAnchor(e.target.value)} />
              <textarea rows={2} placeholder={`以「${me.name}」身份留批注…`} value={annText} onChange={(e) => setAnnText(e.target.value)} />
              <button className="btn sm primary" disabled={busy || !annText.trim()} onClick={() => void annotate()}>
                留批注
              </button>
            </div>
            {annotationsFor(openPath).map((a) => (
              <div key={a.id} className={`ann-item ${a.resolved ? 'resolved' : ''}`}>
                <div className="ann-line">
                  <strong>{a.authorName}</strong>
                  {a.anchor && <span className="tag">{a.anchor}</span>}
                  <time>{fmtTime(a.ts)}</time>
                  <button className="link" onClick={() => void resolve(a)}>
                    {a.resolved ? '重开' : '标记解决'}
                  </button>
                </div>
                <p>{a.text}</p>
                {a.replies.length > 0 && (
                  <div className="ann-replies">
                    {a.replies.map((r) => (
                      <div key={r.id}>
                        <strong>{r.authorName}</strong> {r.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {injections.length > 0 && (
        <section className="injections">
          <h4 title="OKL 三层按需叠加注入：实际塞了什么、什么形态（可观测）">知识注入摘要（{injections.length} 次）</h4>
          {injections.map((inj: InjectionSummary, i) => (
            <details key={i} className="inj-item">
              <summary>
                {stageShort(inj.stage)}：文档 {inj.injected.length} 篇 · 技能 {inj.skillsInjected.length} 个 · {inj.totalChars} 字符
              </summary>
              <ul>
                {inj.injected.map((d) => (
                  <li key={d.path}>
                    [{d.layer}] {d.title} · {d.chars}字 · {d.form}
                  </li>
                ))}
                {inj.skillsInjected.map((s) => (
                  <li key={s.id}>
                    [skill] {s.name} v{s.version}
                  </li>
                ))}
                <li className="hint">{inj.note}</li>
              </ul>
            </details>
          ))}
        </section>
      )}
    </div>
  )
}
