import React, { useEffect, useState } from 'react'
import { Segmented } from 'antd'
import { useNavigate } from 'react-router-dom'
import { ROLE_GUIDES, getRoleGuide } from '../../shared/roles'
import { useRoleGuideDismissed, useRoleGuideRole } from '../hooks/useUiPrefs'
import { Btn } from '../design'
import '../design/page-library.css'

/**
 * 首页的角色引导：「我是运营 / 我是辅导老师」两条三步路线，每步一句白话 + 一个跳转按钮。
 * 内容来自 shared/roles.ts（设计代理做首页时读同一份）。可以收起；收起后只留一行「查看使用说明」。
 */
const SEEN_KEY = 'ewb-guide-seen'      // 本机看过一次引导（localStorage）
const SESSION_KEY = 'ewb-guide-session' // 这次启动里已经展开过（sessionStorage）：同一次启动里切页回来仍是展开的，下次启动才自动折叠成一行

export default function RoleGuide() {
  const nav = useNavigate()
  const [role, setRole] = useRoleGuideRole()
  const [dismissed, setDismissed, loading] = useRoleGuideDismissed()
  // 看过一次后，下次启动折叠成一行（首屏留给试卷列表）；用户点「展开三步上手」再展开
  const [autoCollapsed, setAutoCollapsed] = useState(() => { try { return localStorage.getItem(SEEN_KEY) === '1' && sessionStorage.getItem(SESSION_KEY) !== '1' } catch { return false } })
  const showing = !loading && !dismissed && !autoCollapsed
  useEffect(() => { if (showing) { try { localStorage.setItem(SEEN_KEY, '1'); sessionStorage.setItem(SESSION_KEY, '1') } catch { /* 存不上就每次都展开，不影响使用 */ } } }, [showing])
  if (loading) return null
  if (dismissed || autoCollapsed) {
    return (
      <div data-testid="role-guide-collapsed" className="ewb-lib-sub" style={{ marginBottom: 16, fontSize: 14, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
        <span>不知道从哪开始？</span>
        <Btn tone="quiet" size="small" data-testid="role-guide-reopen" onClick={() => { setAutoCollapsed(false); void setDismissed(false) }}>展开三步上手</Btn>
        <span aria-hidden>·</span>
        <Btn tone="quiet" size="small" data-testid="open-help" onClick={() => nav('/help')}>查看使用说明</Btn>
      </div>
    )
  }
  const g = getRoleGuide(role)
  return (
    <section className="ewb-lib-guide" data-testid="role-guide" aria-label="第一次用？三步上手">
      <div className="ewb-lib-guide__head">
        <h2 className="ewb-lib-guide__title">第一次用？选你的角色，三步上手</h2>
        <Segmented data-testid="role-guide-role" value={role} onChange={v => setRole(v as 'ops' | 'tutor')} options={ROLE_GUIDES.map(r => ({ label: r.label, value: r.id }))} />
        <div className="ewb-lib-guide__tools">
          <Btn tone="quiet" size="small" data-testid="open-help" onClick={() => nav('/help')}>使用说明</Btn>
          <Btn tone="quiet" size="small" data-testid="role-guide-dismiss" onClick={() => setDismissed(true)}>收起</Btn>
        </div>
      </div>
      <p className="ewb-lib-guide__intro" data-testid="role-guide-intro">{g.intro}</p>
      <ol className="ewb-lib-steps">
        {g.steps.map((s, i) => (
          <li key={s.title} className="ewb-lib-step" data-testid={`role-step-${g.id}-${i + 1}`}>
            <span className="ewb-lib-stepn" aria-hidden>{i + 1}</span>
            <div style={{ minWidth: 0 }}>
              <h3 className="ewb-lib-step__title">{s.title}</h3>
              <p className="ewb-lib-step__text">{s.text}</p>
            </div>
            <span className="ewb-lib-step__side">
              <Btn tone="secondary" size="small" data-testid={`role-step-go-${g.id}-${i + 1}`} onClick={() => nav(s.path)}>{s.cta}</Btn>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
