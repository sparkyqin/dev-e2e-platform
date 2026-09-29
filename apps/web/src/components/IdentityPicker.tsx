/**
 * 身份切换器：演示模式 = /api/auth/switch 重铸会话（体验不同拍板人视角）
 * 严格模式（DEMO_MODE=false）：不提供切换（身份=令牌登录者），仅登出
 */
import { useState } from 'react'
import { USERS } from '@ai-platform/shared'
import { useApp } from '../store'

export default function IdentityPicker(): React.JSX.Element {
  const { me, demoMode, setMe, logout, pushToast } = useApp()
  const [open, setOpen] = useState(false)
  return (
    <div className={`identity ${open ? 'open' : ''}`}>
      <button className="identity-btn" onClick={() => setOpen((o) => !o)} title={demoMode ? '切换当前操作者身份（演示模式）' : '当前登录身份'}>
        <span className="identity-avatar">{me.name.slice(0, 1)}</span>
        <span className="identity-name">
          <strong>{me.name}</strong>
          <small>{me.role}</small>
        </span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="identity-menu" onMouseLeave={() => setOpen(false)}>
          {demoMode &&
            USERS.map((u) => (
              <button
                key={u.userId}
                className={`identity-item ${u.userId === me.userId ? 'current' : ''}`}
                onClick={() => {
                  setOpen(false)
                  setMe(u.userId).catch((e) => pushToast((e as Error).message, 'err'))
                }}
              >
                <span className="identity-avatar sm">{u.name.slice(0, 1)}</span>
                <span>
                  <strong>{u.name}</strong>
                  <small>{u.role}</small>
                  <em>{u.tags.join(' · ')}</em>
                </span>
              </button>
            ))}
          <button
            className="identity-item logout"
            onClick={() => {
              setOpen(false)
              void logout()
            }}
          >
            <span className="identity-avatar sm">⏻</span>
            <span>
              <strong>退出登录</strong>
              <small>结束当前会话</small>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
