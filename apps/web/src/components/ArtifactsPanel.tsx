/**
 * 材料区：产物三分区（process 不入 git / delivery 入 git / knowledge 可回流）
 * - 点击查看内容（只读；人走批注，产物写入仅由引擎/平台执行）
 * - 查看器带行号：点行号锚定批注到具体行（锚点不再是裸输入框）
 * - 原位批注：讨论串回复 + 解决/重开（annotationId 定位）+ 锚点跳转高亮
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
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
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

  /** 点行号锚定/取消锚定（锚点即行号，所见即所得） */
  const toggleAnchor = (n: number): void => {
    const tag = `L${n}`
    setAnnAnchor((prev) => (prev === tag ? '' : tag))
  }

  /** 锚点标签点击 → 定位到该行（滚动 + 保持高亮） */
  const jumpTo = (anchor: string): void => {
    setAnnAnchor(anchor)
    const m = /^L(\d+)$/.exec(anchor)
    if (m) document.getElementById(`ln-${m[1]}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const annotate = async (): Promise<void> => {
    if (!openPath || !annText.trim()) return
    setBusy(true)
    try {
      await api.annotate(taskId, { artifactPath: openPath, anchor: annAnchor || undefined, text: annText, asUserId: me.userId })
      setAnnText('')
      setAnnAnchor('')
      await refreshDetail()
      pushToast(`批注已留${annAnchor ? `（锚定 ${annAnchor}）` : ''}`, 'ok')
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (a: Annotation): Promise<void> => {
    setBusy(true)
    try {
      await api.annotate(taskId, { artifactPath: a.artifactPath, annotationId: a.id, resolve: !a.resolved, asUserId: me.userId })
      await refreshDetail()
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const reply = async (a: Annotation): Promise<void> => {
    if (!replyText.trim()) return
    setBusy(true)
    try {
      await api.annotate(taskId, { artifactPath: a.artifactPath, text: replyText, replyTo: a.id, asUserId: me.userId })
      setReplyText('')
      setReplyTo(null)
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
          <div className="viewer-lines">
            {(content ?? '读取中…').split('\n').map((line, i) => {
              const n = i + 1
              const on = annAnchor === `L${n}`
              return (
                <div key={n} id={`ln-${n}`} className={`vline ${on ? 'hl' : ''}`}>
                  <button className={`ln ${on ? 'on' : ''}`} onClick={() => toggleAnchor(n)} title="锚定批注到此行">
                    {n}
                  </button>
                  <span className="lc">{line === '' ? ' ' : line}</span>
                </div>
              )
            })}
          </div>
          <div className="viewer-ann">
            <h5>
              批注（{annotationsFor(openPath).length}）· 当前主权角色 {sovereignNow}，非主权方只读+批注
            </h5>
            <div className="ann-new">
              {annAnchor ? (
                <span className="anchor-chip">
                  锚定 {annAnchor}
                  <button onClick={() => setAnnAnchor('')} title="清除锚点">
                    ✕
                  </button>
                </span>
              ) : (
                <small className="anchor-hint">点上方行号，可把批注锚定到具体行（可选）</small>
              )}
              <textarea rows={2} placeholder={`以「${me.name}」身份留批注…`} value={annText} onChange={(e) => setAnnText(e.target.value)} />
              <button className="btn sm primary" disabled={busy || !annText.trim()} onClick={() => void annotate()}>
                留批注
              </button>
            </div>
            {annotationsFor(openPath).length === 0 && <div className="viewer-empty">还没有批注。点行号锚定 + 写下第一条，或直接留言。</div>}
            {annotationsFor(openPath).map((a) => (
              <div key={a.id} className={`ann-item ${a.resolved ? 'resolved' : ''}`}>
                <div className="ann-line">
                  <strong>{a.authorName}</strong>
                  {a.anchor && (
                    <button className="tag anchor-jump" onClick={() => jumpTo(a.anchor!)} title="跳到锚定行">
                      {a.anchor}
                    </button>
                  )}
                  {a.resolved && <span className="tag ok">已解决</span>}
                  <time>{fmtTime(a.ts)}</time>
                  <button className="link" disabled={busy} onClick={() => void resolve(a)}>
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
                {replyTo === a.id ? (
                  <div className="ann-reply-box">
                    <textarea rows={2} placeholder={`回复 ${a.authorName}…`} value={replyText} onChange={(e) => setReplyText(e.target.value)} />
                    <div className="reply-actions">
                      <button
                        className="btn sm"
                        onClick={() => {
                          setReplyTo(null)
                          setReplyText('')
                        }}
                      >
                        取消
                      </button>
                      <button className="btn sm primary" disabled={busy || !replyText.trim()} onClick={() => void reply(a)}>
                        回复
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="link reply-btn"
                    onClick={() => {
                      setReplyTo(a.id)
                      setReplyText('')
                    }}
                  >
                    回复
                  </button>
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
