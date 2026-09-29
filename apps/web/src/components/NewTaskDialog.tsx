/**
 * 新建任务（一句话需求进平台）：开发方式分流 / playbook / 演示剧本 / 无人值守
 * 创建即排队，由调度器按并发槽派发
 */
import { useEffect, useState } from 'react'
import type { CreateTaskRequest, DevMode, Playbook, UserDir } from '@ai-platform/shared'
import { DEV_MODE_LABEL, DEV_MODES } from '@ai-platform/shared'
import { api } from '../api'
import { useApp } from '../store'
import { SCENARIO_LABEL } from '../format'

const SCENARIOS: CreateTaskRequest['scenario'][] = ['clean', 'flaky-tool', 'build-fail', 'feedback-loop']

export default function NewTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (taskId: string) => void }): React.JSX.Element {
  const { pushToast } = useApp()
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [users, setUsers] = useState<UserDir[]>([])
  const [form, setForm] = useState({
    title: '会员积分过期提醒',
    requirementText: '会员中心：积分快过期的会员，在过期前 7 天发提醒（短信/App 内信），过期后积分清零要留痕。',
    module: 'membership-points',
    repo: 'membership-center',
    mode: 'incremental' as DevMode,
    playbookId: 'strict',
    scenario: 'clean' as CreateTaskRequest['scenario'],
    unattended: false,
    arParallel: false,
    architectId: 'chenshu',
    tseId: 'wuqian',
    ownerId: 'wanghao',
  })
  const [busy, setBusy] = useState(false)

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

  const submit = async (): Promise<void> => {
    if (!form.title.trim() || !form.requirementText.trim()) {
      pushToast('标题与需求一句话必填', 'warn')
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
      pushToast(`任务 #${st.seq} 已创建并进入调度`, 'ok')
      onCreated(st.taskId)
    } catch (e) {
      pushToast(`创建失败：${(e as Error).message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const userSel = (value: string, onChange: (v: string) => void, label: string): React.JSX.Element => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(users.length > 0 ? users : [{ userId: value, name: value, role: '', tags: [] }]).map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.name}（{u.userId}）
          </option>
        ))}
      </select>
    </label>
  )

  const sel = playbooks.find((p) => p.id === form.playbookId)

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h2>新建任务 · 一句话需求</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>任务标题</span>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label className="field">
            <span>需求一句话</span>
            <textarea rows={3} value={form.requirementText} onChange={(e) => setForm({ ...form, requirementText: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>模块</span>
              <input value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} />
            </label>
            <label className="field">
              <span>代码仓</span>
              <input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
            </label>
          </div>
          <div className="field-row">
            {userSel(form.ownerId, (v) => setForm({ ...form, ownerId: v }), '责任人（开发）')}
            {userSel(form.architectId, (v) => setForm({ ...form, architectId: v }), '架构师（架构门拍板）')}
            {userSel(form.tseId, (v) => setForm({ ...form, tseId: v }), 'TSE（测试设计门拍板）')}
          </div>
          <label className="field">
            <span>开发方式（存量/绿地分流）</span>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as DevMode })}>
              {DEV_MODES.map((m) => (
                <option key={m} value={m}>
                  {DEV_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>流程模板 playbook</span>
            <select value={form.playbookId} onChange={(e) => setForm({ ...form, playbookId: e.target.value })}>
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
          <label className="field">
            <span>演示剧本（模拟引擎故障注入，选 clean 即顺滑链路）</span>
            <select value={form.scenario} onChange={(e) => setForm({ ...form, scenario: e.target.value as CreateTaskRequest['scenario'] })}>
              {SCENARIOS.map((s) => (
                <option key={s} value={s}>
                  {SCENARIO_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.unattended} onChange={(e) => setForm({ ...form, unattended: e.target.checked })} />
            <span>夜间无人值守模式（铁门挂起：事实门超时降级推进+待追认，铁门永不代答）</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.arParallel} onChange={(e) => setForm({ ...form, arParallel: e.target.checked })} />
            <span>
              执行段 AR 并行拆分（审核通过后责任人拍板拆分门 → 按原子需求派发子任务并行执行：拷贝设计产物、从编码起跑、开发轮转承接；全部合入后 TSE
              聚合验收收口）
            </span>
          </label>
        </div>
        <footer>
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
