import React, { useEffect, useState } from 'react'
import { App, Checkbox, Input, InputNumber, Modal, Select, Tabs } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Download, Pencil } from 'lucide-react'
import { Btn } from '../design'
import { SkillsPanel } from './assistant-skills'
import { TOOL_CATEGORIES, toolCategory } from '../../main/agent/role-templates'

const NONE: never[] = []
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export interface RolePrefill { name: string; description: string; tools: string[]; suggestions: string[]; defaultPlaybook?: string; notes: string }

/** 工具勾选：按类别分组（数据、统计、看板与产出、试卷、连接器），每类可全选 */
function ToolPicker({ tools, picked, onChange }: { tools: Array<{ name: string; label: string; level: string }>; picked: string[]; onChange: (v: string[]) => void }) {
  return (
    <div data-testid="role-tools" style={{ display: 'grid', gap: 8 }}>
      {TOOL_CATEGORIES.map(c => {
        const list = tools.filter(t => toolCategory(t.name) === c.id)
        if (!list.length) return null
        const names = list.map(t => t.name)
        const on = names.filter(n => picked.includes(n))
        return (
          <div key={c.id} data-testid={`role-tools-${c.id}`}>
            <Checkbox checked={on.length === names.length} indeterminate={on.length > 0 && on.length < names.length} data-testid={`role-tools-all-${c.id}`}
              onChange={e => onChange(e.target.checked ? [...new Set([...picked, ...names])] : picked.filter(n => !names.includes(n)))}><b>{c.label}</b>（{on.length}/{names.length}）</Checkbox>
            <Checkbox.Group value={on} onChange={v => onChange([...picked.filter(n => !names.includes(n)), ...(v as string[])])} style={{ display: 'grid', gap: 4, margin: '4px 0 0 24px' }}
              options={list.map(t => ({ value: t.name, label: `${t.label}${t.level === 'write' ? '（会改数据，需你同意）' : ''}` }))} />
          </div>
        )
      })}
    </div>
  )
}

/** 新建 / 编辑自定义角色：名称、说明、可用工具、推荐问题、默认 Skill、额外说明；编辑时可导出、删除。新建时可带预填内容（模板 / AI 草稿），onBack 有值时显示「上一步」 */
export function RoleModal({ open, roleId, onClose, onSaved, prefill, onBack }: { open: boolean; roleId: string | null; onClose: () => void; onSaved: (id: string | null) => void; prefill?: RolePrefill | null; onBack?: () => void }) {
  const { message, modal } = App.useApp()
  const qc = useQueryClient()
  const { data: tools = NONE } = useQuery({ queryKey: ['agent', 'tools'], queryFn: () => window.api.agent.tools(), enabled: open })
  const { data: roles = NONE } = useQuery({ queryKey: ['agent', 'customRoles'], queryFn: () => window.api.agent.customRoles(), enabled: open, staleTime: 0 })
  const { data: pbs } = useQuery({ queryKey: ['agent', 'playbooks'], queryFn: () => window.api.agent.playbooks(), enabled: open })
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [sugg, setSugg] = useState('')
  const [playbook, setPlaybook] = useState<string | undefined>(undefined)
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (!open) return
    const r = roleId ? roles.find(x => x.id === roleId) : prefill
    setName(r?.name ?? ''); setDesc(r?.description ?? ''); setPicked(r?.tools ?? []); setSugg((r?.suggestions ?? []).join('\n')); setPlaybook(r?.defaultPlaybook); setNotes(r?.notes ?? '')
  }, [open, roleId, roles, prefill])
  const save = async () => {
    try {
      const r = await window.api.agent.saveRole({
        id: roleId ?? undefined, name, description: desc, tools: picked, suggestions: sugg.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4), defaultPlaybook: playbook, notes
      })
      qc.invalidateQueries({ queryKey: ['agent', 'roles'] }); qc.invalidateQueries({ queryKey: ['agent', 'customRoles'] })
      message.success('角色已保存'); onSaved(r.id); onClose()
    } catch (e) { message.error(clean(e)) }
  }
  const del = () => modal.confirm({
    title: '删除这个角色？', content: '只删除角色本身，以前用它聊过的对话还在。', okText: '删除', cancelText: '不删', okButtonProps: { danger: true, 'data-testid': 'role-delete-ok' } as never,
    onOk: async () => { await window.api.agent.deleteRole(roleId!); qc.invalidateQueries({ queryKey: ['agent', 'roles'] }); qc.invalidateQueries({ queryKey: ['agent', 'customRoles'] }); onSaved(null); onClose() }
  })
  const exp = async () => {
    try { const r = await window.api.agent.exportRole(roleId!); if (r.saved) message.success('已导出，可以把这个文件发给别人导入') } catch (e) { message.error(clean(e)) }
  }
  const hint = (t: string) => <span className="ewb-lib-sub" style={{ display: 'block', margin: '1px 0 3px' }}>{t}</span>
  return (
    <Modal open={open} title={roleId ? '编辑角色' : onBack ? '新建角色 · 第 3 步：看一看，改一改' : '新建角色'} onCancel={onClose} width={600} destroyOnClose
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {roleId && <><Btn tone="danger" data-testid="role-delete" onClick={del}>删除</Btn><Btn tone="secondary" data-testid="role-export" onClick={exp}>导出成文件</Btn></>}
        {!roleId && onBack && <Btn tone="secondary" data-testid="role-back" onClick={onBack}>上一步</Btn>}
        <span style={{ flex: 1 }} />
        <Btn tone="secondary" onClick={onClose}>取消</Btn>
        <Btn tone="primary" data-testid="role-save" disabled={!name.trim()} onClick={save}>保存</Btn>
      </div>}>
      <div data-testid="role-modal" style={{ display: 'grid', gap: 12 }}>
        <label>名称{hint('在角色切换里显示的名字，比如“班主任”“续费跟进”。')}<Input value={name} maxLength={20} placeholder="比如：续费跟进" data-testid="role-name" onChange={e => setName(e.target.value)} /></label>
        <label>说明（怎么说话、关注什么）{hint('写给助手看：你是谁、想让它怎么回答、更关心什么。一两句话就够。')}<Input.TextArea value={desc} rows={3} maxLength={400} data-testid="role-desc" onChange={e => setDesc(e.target.value)} /></label>
        <div>
          <div>可以用哪些查询</div>
          {hint('勾上助手可以用的功能，没勾的它不会用。拿不准就保持默认。')}
          <ToolPicker tools={tools} picked={picked} onChange={setPicked} />
          <span className="ewb-lib-sub">写计划、向你提问、读取分析步骤、取回进度是每个角色都有的。</span>
        </div>
        <label>推荐问题（一行一个，最多 4 个）{hint('进入这个角色时，页面上会出现这几个问题，点一下就能问。')}<Input.TextArea value={sugg} rows={3} data-testid="role-suggest" onChange={e => setSugg(e.target.value)} /></label>
        <label>默认 Skill（可选）{hint('Skill 是一套现成的做事步骤。选一个，助手会优先照着做。')}<Select allowClear style={{ width: '100%' }} value={playbook} placeholder="不选" data-testid="role-playbook" onChange={v => setPlaybook(v)} options={(pbs?.items ?? []).map(p => ({ value: p.name, label: p.name }))} /></label>
        <label>只给这个角色的额外说明（可选）{hint('这个角色要特别遵守的规矩，比如口径、提醒。没有就空着。')}<Input.TextArea value={notes} rows={2} maxLength={1500} data-testid="role-notes" onChange={e => setNotes(e.target.value)} /></label>
      </div>
    </Modal>
  )
}

/** 助手设置：机构说明（每次对话都会带上）和上下文上限 */
export interface SettingsExtra {
  scene?: 'org' | 'school'; onScene: (s: 'org' | 'school') => void
  curRoleName?: string; curRoleCustom?: boolean
  onNewRole: () => void; onImportRole: () => void; onEditRole: () => void
}
export function AssistantSettingsModal({ open, onClose, extra }: { open: boolean; onClose: () => void; extra?: SettingsExtra }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['agent', 'settings'], queryFn: () => window.api.agent.settings(), enabled: open, staleTime: 0 })
  const [ctx, setCtx] = useState('')
  const [limit, setLimit] = useState<number | null>(null)
  const [tab, setTab] = useState('general')
  useEffect(() => { if (open && data) { setCtx(data.orgContext); setLimit(data.contextLimit) } }, [open, data])
  const max = data?.orgContextMax ?? 4000
  const save = async () => {
    try {
      await window.api.agent.saveSettings({ orgContext: ctx, contextLimit: limit })
      qc.invalidateQueries({ queryKey: ['agent', 'settings'] }); message.success('已保存'); onClose()
    } catch (e) { message.error(clean(e)) }
  }
  return (
    <Modal open={open} title="助手设置" onCancel={onClose} width={640} destroyOnClose afterClose={() => setTab('general')}
      footer={tab === 'skills' ? <Btn tone="secondary" onClick={onClose}>关闭</Btn> : <><Btn tone="secondary" onClick={onClose}>取消</Btn><Btn tone="primary" data-testid="assistant-settings-save" onClick={save}>保存</Btn></>}>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'general', label: <span data-testid="assistant-settings-tab-general">通用</span> },
        { key: 'skills', label: <span data-testid="assistant-settings-tab-skills">Skill</span> }
      ]} />
      {tab === 'skills' ? <SkillsPanel /> : <div data-testid="assistant-settings" style={{ display: 'grid', gap: 16 }}>
        {extra && (
          <div>
            <b>你的场景</b>
            <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>助手里的叫法（班级 / 年级、学员 / 学生）按你的场景显示。</p>
            <div className="ewb-as-seg ewb-as-seg--small" role="group" aria-label="场景" style={{ display: 'inline-flex' }}>
              <button type="button" data-testid="assistant-scene-org" aria-pressed={extra.scene === 'org'} onClick={() => extra.onScene('org')}>培训机构</button>
              <button type="button" data-testid="assistant-scene-school" aria-pressed={extra.scene === 'school'} onClick={() => extra.onScene('school')}>学校</button>
            </div>
          </div>
        )}
        {extra && (
          <div>
            <b>角色</b>
            <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>角色决定助手能查什么、怎么说话。可以自己建一个，或导入别人发来的角色文件。</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn tone="secondary" size="small" icon={Plus} data-testid="assistant-role-new" onClick={() => { onClose(); extra.onNewRole() }}>新建角色</Btn>
              <Btn tone="secondary" size="small" icon={Download} data-testid="assistant-role-import" onClick={() => { onClose(); extra.onImportRole() }}>导入角色</Btn>
              {extra.curRoleCustom && <Btn tone="secondary" size="small" icon={Pencil} data-testid="assistant-role-edit" onClick={() => { onClose(); extra.onEditRole() }}>编辑「{extra.curRoleName}」</Btn>}
            </div>
          </div>
        )}
        <div>
          <b>机构说明</b>
          <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>写给助手的背景：我们怎么叫级别、续费周期、到课怎么算、常用口径……每次对话都会带上，不用每次重复说。</p>
          <Input.TextArea value={ctx} rows={5} data-testid="assistant-org-context" placeholder="例如：我们把一级叫“启蒙”，续费周期按学期算……" onChange={e => setCtx(e.target.value)} />
          <span className="ewb-lib-sub" data-testid="assistant-org-count" style={ctx.length > max ? { color: 'var(--ewb-red-ink)' } : undefined}>{ctx.length} / {max} 字{ctx.length > max ? `——超出的 ${ctx.length - max} 字不会发给助手，请精简` : ''}</span>
        </div>
        <div>
          <b>上下文上限</b>
          <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>对话用到上限的约 70% 时，助手会自动把前面的内容整理成摘要再继续。不填就按模型的默认值（现在是 {data?.contextLimitEffective?.toLocaleString() ?? '…'} token）。</p>
          <InputNumber value={limit} min={8000} max={1000000} step={8000} placeholder={String(data?.contextLimitDefault ?? 64000)} data-testid="assistant-context-limit" onChange={v => setLimit(v === null ? null : Number(v))} style={{ width: 180 }} /> token
        </div>
      </div>}
    </Modal>
  )
}
