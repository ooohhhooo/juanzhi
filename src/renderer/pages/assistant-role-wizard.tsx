import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AutoComplete, Checkbox, Input, Modal, Radio } from 'antd'
import { useQuery } from '@tanstack/react-query'
import * as Lucide from 'lucide-react'
import { Sparkles, PenLine, Loader2 } from 'lucide-react'
import { Btn } from '../design'
import AiErrorExplain from '../components/AiErrorExplain'
import { RoleModal } from './assistant-dialogs'
import type { RolePrefill } from './assistant-dialogs'
import { TEMPLATE_GROUP_LABEL, templatesFor, type RoleTemplate, type TemplateGroup } from '../../main/agent/role-templates'

import '../design/page-assistant-roles.css'

type Scene = 'org' | 'school'
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const prefillOf = (t: RoleTemplate, scene: Scene): RolePrefill => ({
  name: t.names[scene], description: t.description, tools: t.tools, suggestions: t.suggestions, defaultPlaybook: t.defaultPlaybook, notes: t.notes
})

const TASKS = ['看数据', '做汇报', '跟进学员', '和家长沟通', '排课', '做课件', '带新人']
const REPORT_TO = ['老板', '主管', '家长', '同事', '不用汇报']
const STYLES = ['简洁直接', '详细解释', '温和鼓励', '专业严谨']

const TplIcon = ({ name }: { name: string }) => {
  const C = (Lucide as unknown as Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>>)[name] ?? Lucide.User
  return <C size={20} strokeWidth={1.8} />
}

interface Props {
  open: boolean
  scene: Scene
  /** 直接从某个模板进入第 3 步（首次引导的快捷按钮） */
  startTemplate?: string | null
  onClose: () => void
  onSaved: (id: string | null) => void
}

/** 新建角色三步向导：1 选模板 / 让助手生成 / 空白；2 回答几个问题让 AI 生成草稿；3 编辑页（预填）保存 */
export default function RoleWizard({ open, scene, startTemplate, onClose, onSaved }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [prefill, setPrefill] = useState<RolePrefill | null>(null)
  const [from, setFrom] = useState<1 | 2>(1)
  const { data: status } = useQuery({ queryKey: ['agent', 'status'], queryFn: () => window.api.agent.status(), staleTime: 0, enabled: open })
  const templates = useMemo(() => templatesFor(scene), [scene])
  useEffect(() => {
    if (!open) return
    const t = startTemplate ? templates.find(x => x.id === startTemplate) : null
    if (t) { setPrefill(prefillOf(t, scene)); setFrom(1); setStep(3) } else { setPrefill(null); setStep(1) }
  }, [open, startTemplate, templates, scene])

  // 第 2 步的回答
  const [job, setJob] = useState('')
  const [tasks, setTasks] = useState<string[]>([])
  const [reportTo, setReportTo] = useState('')
  const [style, setStyle] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [errNonce, setErrNonce] = useState(0)
  const reqRef = useRef('')
  const cancelled = useRef(false)
  useEffect(() => { if (open) { setJob(''); setTasks([]); setReportTo(''); setStyle(''); setExtra(''); setErr(''); setBusy(false) } }, [open])

  const generate = async () => {
    const reqId = `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    reqRef.current = reqId; cancelled.current = false
    setBusy(true); setErr('')
    try {
      const d = await window.api.agent.roleDraft(reqId, { job, tasks, reportTo, style, extra })
      if (cancelled.current) return
      setPrefill({ name: d.name, description: d.description, tools: d.tools, suggestions: d.suggestions, defaultPlaybook: d.defaultPlaybook, notes: d.notes })
      setFrom(2); setStep(3)
    } catch (e) {
      if (cancelled.current) return
      setErr(clean(e)); setErrNonce(n => n + 1)
    } finally { setBusy(false) }
  }
  const cancelGen = () => { cancelled.current = true; window.api.agent.roleDraftCancel(reqRef.current).catch(() => undefined); setBusy(false) }
  const close = () => { if (busy) cancelGen(); onClose() }

  const groups = (['manage', 'service', 'teach'] as TemplateGroup[]).map(g => ({ g, list: templates.filter(t => t.group === g) })).filter(x => x.list.length)
  const aiOff = !status?.configured
  const pickTpl = (t: RoleTemplate) => { setPrefill(prefillOf(t, scene)); setFrom(1); setStep(3) }
  const jobOptions = [...new Set(templates.map(t => t.names[scene]))].map(v => ({ value: v }))

  return (
    <>
      <Modal open={open && step === 1} title="新建角色 · 第 1 步：你是做什么的？" onCancel={close} width={760} footer={null} destroyOnClose>
        <div data-testid="role-wizard" style={{ display: 'grid', gap: 14 }}>
          <p className="ewb-lib-sub" style={{ margin: 0 }}>选一个最像你的，下一步可以再改。</p>
          <div className="ewb-rw-grid">
            <button type="button" className="ewb-rw-card ewb-rw-card--ai" data-testid="role-wizard-ai" disabled={aiOff} title={aiOff ? '先在设置里配置 AI 服务' : undefined} onClick={() => setStep(2)}>
              <span className="ewb-rw-card__icon"><Sparkles size={20} strokeWidth={1.8} /></span>
              <span className="ewb-rw-card__name">让助手帮我生成</span>
              <span className="ewb-rw-card__who">{aiOff ? '先在设置里配置 AI 服务' : '回答几个小问题，助手帮你写'}</span>
            </button>
            <button type="button" className="ewb-rw-card" data-testid="role-wizard-blank" onClick={() => { setPrefill(null); setFrom(1); setStep(3) }}>
              <span className="ewb-rw-card__icon"><PenLine size={20} strokeWidth={1.8} /></span>
              <span className="ewb-rw-card__name">从空白开始</span>
              <span className="ewb-rw-card__who">自己一项一项填</span>
            </button>
          </div>
          {groups.map(({ g, list }) => (
            <div key={g}>
              <b>{TEMPLATE_GROUP_LABEL[g]}</b>
              <div className="ewb-rw-grid">
                {list.map(t => (
                  <button key={t.id} type="button" className="ewb-rw-card" data-testid={`role-tpl-${t.id}`} onClick={() => pickTpl(t)}>
                    <span className="ewb-rw-card__icon"><TplIcon name={t.icon} /></span>
                    <span className="ewb-rw-card__name">{t.names[scene]}</span>
                    <span className="ewb-rw-card__who">{t.who[scene]}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={open && step === 2} title="新建角色 · 第 2 步：告诉助手你的情况" onCancel={close} width={620} destroyOnClose
        footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {busy
            ? <Btn tone="secondary" data-testid="role-ai-cancel" onClick={cancelGen}>取消</Btn>
            : <><Btn tone="secondary" data-testid="role-ai-back" onClick={() => setStep(1)}>上一步</Btn><Btn tone="primary" data-testid="role-ai-generate" disabled={!job.trim()} onClick={generate}>生成</Btn></>}
        </div>}>
        <div data-testid="role-ai-form" style={{ display: 'grid', gap: 14 }}>
          <div>你的岗位（可以选，也可以自己写）
            <AutoComplete style={{ width: '100%', display: 'block' }} value={job} options={jobOptions} onChange={setJob} disabled={busy} placeholder="比如：班主任" data-testid="role-ai-job" filterOption={(i, o) => !!o?.value && String(o.value).includes(i)} />
          </div>
          <div>平时最常做的事（可多选）
            <div><Checkbox.Group value={tasks} onChange={v => setTasks(v as string[])} options={TASKS} disabled={busy} data-testid="role-ai-tasks" /></div>
          </div>
          <div>汇报给谁
            <div><Radio.Group value={reportTo} onChange={e => setReportTo(e.target.value)} options={REPORT_TO} optionType="button" size="small" disabled={busy} data-testid="role-ai-report" /></div>
          </div>
          <div>希望助手怎么说话
            <div><Radio.Group value={style} onChange={e => setStyle(e.target.value)} options={STYLES} optionType="button" size="small" disabled={busy} data-testid="role-ai-style" /></div>
          </div>
          <div>还有什么补充（可不填）
            <Input.TextArea value={extra} rows={2} maxLength={300} disabled={busy} onChange={e => setExtra(e.target.value)} data-testid="role-ai-extra" placeholder="比如：我带三个班，主要管续费" />
          </div>
          {busy && <div data-testid="role-ai-loading" className="ewb-lib-sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Loader2 size={14} className="ewb-rw-spin" />助手正在写，通常十几秒……</div>}
          {err && !busy && (
            <div data-testid="role-ai-error">
              <b>没能生成：</b>{err}
              <AiErrorExplain message={err} task="agent-role-draft" nonce={errNonce} />
              <div style={{ marginTop: 6 }}><Btn tone="secondary" size="small" data-testid="role-ai-usetpl" onClick={() => setStep(1)}>改用模板</Btn></div>
            </div>
          )}
        </div>
      </Modal>

      <RoleModal open={open && step === 3} roleId={null} prefill={prefill} onBack={() => setStep(from)} onClose={close} onSaved={onSaved} />
    </>
  )
}
