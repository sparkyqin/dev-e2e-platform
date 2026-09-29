/**
 * 新建任务——参考 mae-flow LaunchWorkspace 模式适配：
 * - 编号分区（1 需求 / 2 干系人 / 3 方式与模板）：常用路径一眼见核心字段
 * - 开发方式卡片单选组：描述可见可比较（文案单源拆自 DEV_MODE_LABEL）
 * - 草稿自动保存（localStorage 防抖 400ms，关弹窗不丢；创建成功即清）
 * - 行内指路式校验：必填空则红框 + 行内提示 + 聚焦第一个错误字段（不用 toast 报错）
 * - 高级选项折叠（multica 披露梯同一原则）：演示剧本 / 无人值守 / AR 并行
 * - 创建成功当场打开工作台（onCreated → #/task/:id，mae 教训：零反馈不可接受）
 */
import { useEffect, useRef, useState } from 'react'
import type { CreateTaskRequest, DevMode, Playbook, UserDir } from '@ai-platform/shared'
import { DEV_MODE_LABEL, DEV_MODES } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { SCENARIO_LABEL } from '../format'

const SCENARIOS: CreateTaskRequest['scenario'][] = ['clean', 'flaky-tool', 'build-fail', 'feedback-loop']
const DRAFT_KEY = 'new-task-draft'

type FormShape = {
  title: string
  requirementText: string
  module: string
  repo: string
  mode: DevMode
  playbookId: string
  scenario: CreateTaskRequest['scenario']
  unattended: boolean
  arParallel: boolean
  architectId: string
  tseId: string
  ownerId: string
}

/** 演示预填（无草稿时的默认：演示平台一键即建）；「清空重填」走空白表单 + placeholder 引导 */
const DEMO_FORM: FormShape = {
  title: '会员积分过期提醒',
  requirementText: '会员中心：积分快过期的会员，在过期前 7 天发提醒（短信/App 内信），过期后积分清零要留痕。',
  module: 'membership-points',
  repo: 'membership-center',
  mode: 'incremental',
  playbookId: 'strict',
  scenario: 'clean',
  unattended: false,
  arParallel: false,
  architectId: 'chenshu',
  tseId: 'wuqian',
  ownerId: 'wanghao',
}

const BLANK_FORM: FormShape = { ...DEMO_FORM, title: '', requirementText: '', module: '', repo: '' }

/** 开发方式卡片文案：单源拆自 DEV_MODE_LABEL（「绿地新建（无需逆向，直达分解）」→ 标题 + 描述） */
const MODE_CARDS = DEV_MODES.map((m) => {
  const label = DEV_MODE_LABEL[m]
  const i = label.search(/[（(]/)
  return { mode: m, title: i < 0 ? label : label.slice(0, i), desc: i < 0 ? '' : label.slice(i + 1).replace(/[）)]$/, '') }
})

/** 载入草稿（坏数据兜底回演示默认，mode/scenario 白名单校验） */
function loadDraft(): FormShape | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const f: FormShape = { ...DEMO_FORM, ...(JSON.parse(raw) as Partial<FormShape>) }
    if (!(DEV_MODES as readonly string[]).includes(f.mode)) f.mode = DEMO_FORM.mode
    if (!SCENARIOS.includes(f.scenario)) f.scenario = 'clean'
    return f
  } catch {
    return null
  }
}

export default function NewTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (taskId: string) => void }): React.JSX.Element {
  const { pushToast } = useApp()
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [users, setUsers] = useState<UserDir[]>([])
  const [initial] = useState(loadDraft)
  const [form, setForm] = useState<FormShape>(() => initial ?? DEMO_FORM)
  /** none=未改（演示预填） · restored=载入草稿 · saved=已自动保存 */
  const [draftState, setDraftState] = useState<'none' | 'restored' | 'saved'>(initial ? 'restored' : 'none')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const dirtyRef = useRef(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const reqRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void api
      .playbooks()
      .then((p) => setPlaybooks(p.filter((x) => x.published)))
      .catch(() => setPlaybooks([]))
    void api
      .users()
      .then(setUsers)
      .catch(() => setUsers([]))
  }, [])

  /** 草稿自动保存：任何改动 400ms 后落 localStorage */
  useEffect(() => {
    if (!dirtyRef.current) return
    const t = window.setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form))
      setDraftState('saved')
    }, 400)
    return () => window.clearTimeout(t)
  }, [form])

  const upd = (patch: Partial<FormShape>): void => {
    dirtyRef.current = true
    setForm((f) => ({ ...f, ...patch }))
  }

  const clearAll = (): void => {
    dirtyRef.current = true
    setForm(BLANK_FORM)
    setTouched(false)
    setDraftState('saved')
    localStorage.setItem(DRAFT_KEY, JSON.stringify(BLANK_FORM))
    titleRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (!form.title.trim() || !form.requirementText.trim()) {
      setTouched(true)
      // 指路式：聚焦第一个错误字段
      ;(form.title.trim() ? reqRef : titleRef).current?.focus()
      return
    }
    setBusy(true)
    try {
      const st = await api.createTask({
        title: form.title,
        requirementText: form.requirementText,
        module: form.module,
        repo: form.repo,
        mode: form.mode,
        playbookId: form.playbookId,
        people: { architectId: form.architectId, tseId: form.tseId, ownerId: form.ownerId },
        unattended: form.unattended,
        scenario: form.scenario,
        arParallel: form.arParallel,
      })
      localStorage.removeItem(DRAFT_KEY) // 创建成功即清草稿
      dirtyRef.current = false
      pushToast(`任务 #${st.seq} 已创建并进入调度`, 'ok')
      onCreated(st.taskId)
    } catch (e) {
      pushToast(`创建失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const errOf = (v: string): boolean => touched && !v.trim()
  const userSel = (value: string, onChange: (v: string) => void, label: string, hint: string): React.JSX.Element => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(users.length > 0 ? users : [{ userId: value, name: value, role: '', tags: [] }]).map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.name}（{u.userId}）
          </option>
        ))}
      </select>
      <small className="hint">{hint}</small>
    </label>
  )

  const sel = playbooks.find((p) => p.id === form.playbookId)

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h2>新建任务</h2>
          <span className="draft-chip">
            {draftState === 'restored' && <span>已恢复上次草稿</span>}
            {draftState === 'saved' && <span className="saved">✓ 草稿已自动保存</span>}
            <button className="link" onClick={clearAll} title="清空表单重新填写（保留角色与模板默认值）">
              清空重填
            </button>
          </span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <h3 className="form-sec">
            <i>1</i> 任务与需求 <em className="sec-pill">必填</em>
          </h3>
          <label className={`field ${errOf(form.title) ? 'field-err' : ''}`}>
            <span>
              任务标题 <em className="req-star">*</em>
            </span>
            <input
              ref={titleRef}
              value={form.title}
              placeholder="例如：会员积分过期提醒（80 字内说清做什么）"
              onChange={(e) => upd({ title: e.target.value })}
            />
            {errOf(form.title) && <em className="err-msg">请填写任务标题</em>}
          </label>
          <label className={`field ${errOf(form.requirementText) ? 'field-err' : ''}`}>
            <span>
              需求描述 <em className="req-star">*</em>
            </span>
            <textarea
              ref={reqRef}
              rows={3}
              value={form.requirementText}
              placeholder={'好需求 = 做什么 + 范围 + 验收要求。例如：积分快过期的会员，过期前 7 天发提醒（短信/App 内信），过期清零要留痕'}
              onChange={(e) => upd({ requirementText: e.target.value })}
            />
            {errOf(form.requirementText) && <em className="err-msg">请描述需求（做什么、范围、验收要求）</em>}
          </label>
          <div className="field-row">
            <label className="field">
              <span>模块</span>
              <input value={form.module} placeholder="例如 membership-points" onChange={(e) => upd({ module: e.target.value })} />
            </label>
            <label className="field">
              <span>代码仓</span>
              <input value={form.repo} placeholder="例如 membership-center" onChange={(e) => upd({ repo: e.target.value })} />
            </label>
          </div>

          <h3 className="form-sec">
            <i>2</i> 干系人
          </h3>
          <div className="field-row triple">
            {userSel(form.ownerId, (v) => upd({ ownerId: v }), '责任人（开发）', '对交付结果负责')}
            {userSel(form.architectId, (v) => upd({ architectId: v }), '架构师', '架构阶段拍板')}
            {userSel(form.tseId, (v) => upd({ tseId: v }), 'TSE', '测试设计门拍板')}
          </div>

          <h3 className="form-sec">
            <i>3</i> 开发方式与流程模板
          </h3>
          <div className="mode-cards" role="radiogroup" aria-label="开发方式（存量/绿地分流）">
            {MODE_CARDS.map((c) => (
              <button
                key={c.mode}
                type="button"
                role="radio"
                aria-checked={form.mode === c.mode}
                className={`mode-card ${form.mode === c.mode ? 'on' : ''}`}
                onClick={() => upd({ mode: c.mode })}
              >
                <strong>{c.title}</strong>
                <small>{c.desc}</small>
              </button>
            ))}
          </div>
          <label className="field">
            <span>流程模板 playbook</span>
            <select value={form.playbookId} onChange={(e) => upd({ playbookId: e.target.value })}>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.id}）
                </option>
              ))}
              {playbooks.length === 0 && <option value={form.playbookId}>{form.playbookId}</option>}
            </select>
            {sel && (
              <small className="hint">
                {sel.description} · 门风格 {sel.customizable.gateVetoStyle} · 评审维度 {sel.customizable.reviewDimensions.length} 个 ·
                Critic {sel.customizable.criticEnabled ? '开' : '关'} · 修复上限 {sel.customizable.maxRepairRounds} 轮
              </small>
            )}
          </label>

          <details className="side-fold adv-fold">
            <summary>高级选项（演示剧本 · 无人值守 · AR 并行）</summary>
            <div className="adv-body">
              <label className="field">
                <span>演示剧本（模拟引擎故障注入，选 clean 即顺滑链路）</span>
                <select value={form.scenario} onChange={(e) => upd({ scenario: e.target.value as CreateTaskRequest['scenario'] })}>
                  {SCENARIOS.map((s) => (
                    <option key={s} value={s}>
                      {SCENARIO_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={form.unattended} onChange={(e) => upd({ unattended: e.target.checked })} />
                <span>夜间无人值守模式（铁门挂起：事实门超时降级推进+待追认，铁门永不代答）</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={form.arParallel} onChange={(e) => upd({ arParallel: e.target.checked })} />
                <span>
                  执行段 AR 并行拆分（审核通过后责任人拍板拆分门 → 按原子需求派发子任务并行执行：拷贝设计产物、从编码起跑、开发轮转承接；全部合入后
                  TSE 聚合验收收口）
                </span>
              </label>
            </div>
          </details>
        </div>
        <footer>
          <span className="foot-hint">创建即排队，由调度器按并发槽派发</span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建任务'}
          </button>
        </footer>
      </div>
    </div>
  )
}
