/**
 * 登录页：身份唯一来源 = 服务端会话
 * - 演示模式（DEMO_MODE）：用户目录点选 → 免令牌 demo-login（开发/演示便利，生产关闭）
 * - 严格模式：userId + 令牌（data/runtime/auth-tokens.json，管理员可轮换）
 */
import { useState } from 'react'
import { USERS } from '@ai-platform/shared'
import { useApp } from '../store'

export default function LoginView(): React.JSX.Element {
  const { demoMode, logIn, demoLogIn, pushToast } = useApp()
  const [userId, setUserId] = useState('zhangming')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await logIn(userId, token.trim())
    } catch (e) {
      pushToast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-head">
          <span className="brand-mark xl">AI</span>
          <div>
            <strong>AI 研发平台</strong>
            <small>需求 → 代码合入</small>
          </div>
        </div>

        {demoMode ? (
          <>
            <p className="login-hint">
              演示模式：点选身份直接进入（<code>DEMO_MODE=false</code> 时此入口关闭，须令牌登录）
            </p>
            <div className="login-users">
              {USERS.map((u) => (
                <button
                  key={u.userId}
                  className="login-user"
                  onClick={() => {
                    if (busy) return
                    setBusy(true)
                    demoLogIn(u.userId).catch((e) => pushToast((e as Error).message, 'err')).finally(() => setBusy(false))
                  }}
                >
                  <span className="identity-avatar">{u.name.slice(0, 1)}</span>
                  <span className="login-user-meta">
                    <strong>{u.name}</strong>
                    <small>{u.role}</small>
                    <em>{u.tags.join(' · ')}</em>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="login-hint">令牌登录：令牌由管理员在服务端 <code>data/runtime/auth-tokens.json</code> 分配</p>
            <div className="login-form">
              <label>
                用户
                <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  {USERS.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.name}（{u.userId}）
                    </option>
                  ))}
                </select>
              </label>
              <label>
                令牌
                <input
                  type="password"
                  value={token}
                  placeholder="tok_…"
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                />
              </label>
              <button className="login-submit" disabled={busy || token.trim().length < 8} onClick={() => void submit()}>
                {busy ? '登录中…' : '登录'}
              </button>
            </div>
            <p className="login-hint dim">API 客户端亦可直接 <code>Authorization: Bearer &lt;token&gt;</code></p>
          </>
        )}
      </div>
    </div>
  )
}
