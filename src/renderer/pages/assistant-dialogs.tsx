import React, { useEffect, useState } from 'react'
import { App, Checkbox, Input, InputNumber, Modal, Select } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn } from '../design'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 新建 / 编辑自定义角色：名称、说明、可用工具、推荐问题、默认剧本、额外说明；编辑时可导出、删除 */
export function RoleModal({ open, roleId, onClose, onSaved }: { open: boolean; roleId: string | null; onClose: () => void; onSaved: (id: string | null) => void }) {
  const { message, modal } = App.useApp()
  const qc = useQueryClient()
  const { data: tools = [] } = useQuery({ queryKey: ['agent', 'tools'], queryFn: () => window.api.agent.tools(), enabled: open })
  const { data: roles = [] } = useQuery({ queryKey: ['agent', 'customRoles'], queryFn: () => window.api.agent.customRoles(), enabled: open, staleTime: 0 })
  const { data: pbs } = useQuery({ queryKey: ['agent', 'playbooks'], queryFn: () => window.api.agent.playbooks(), enabled: open })
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [sugg, setSugg] = useState('')
  const [playbook, setPlaybook] = useState<string | undefined>(undefined)
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (!open) return
    const r = roleId ? roles.find(x => x.id === roleId) : null
    setName(r?.name ?? ''); setDesc(r?.description ?? ''); setPicked(r?.tools ?? []); setSugg((r?.suggestions ?? []).join('\n')); setPlaybook(r?.defaultPlaybook); setNotes(r?.notes ?? '')
  }, [open, roleId, roles])
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
  return (
    <Modal open={open} title={roleId ? '编辑角色' : '新建角色'} onCancel={onClose} width={560} destroyOnClose
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {roleId && <><Btn tone="danger" data-testid="role-delete" onClick={del}>删除</Btn><Btn tone="secondary" data-testid="role-export" onClick={exp}>导出成文件</Btn></>}
        <span style={{ flex: 1 }} />
        <Btn tone="secondary" onClick={onClose}>取消</Btn>
        <Btn tone="primary" data-testid="role-save" disabled={!name.trim()} onClick={save}>保存</Btn>
      </div>}>
      <div data-testid="role-modal" style={{ display: 'grid', gap: 10 }}>
        <label>名称<Input value={name} maxLength={20} placeholder="比如：续费跟进" data-testid="role-name" onChange={e => setName(e.target.value)} /></label>
        <label>说明（怎么说话、关注什么）<Input.TextArea value={desc} rows={3} maxLength={400} data-testid="role-desc" onChange={e => setDesc(e.target.value)} /></label>
        <div>
          <div>可以用哪些查询</div>
          <Checkbox.Group value={picked} onChange={v => setPicked(v as string[])} data-testid="role-tools" style={{ display: 'grid', gap: 4 }}
            options={tools.map(t => ({ value: t.name, label: `${t.label}${t.level === 'write' ? '（会改数据，需你同意）' : ''}` }))} />
          <span className="ewb-lib-sub">写计划、向你提问、读取分析步骤、取回进度是每个角色都有的。</span>
        </div>
        <label>推荐问题（一行一个，最多 4 个）<Input.TextArea value={sugg} rows={3} data-testid="role-suggest" onChange={e => setSugg(e.target.value)} /></label>
        <label>默认分析步骤（可选）<Select allowClear style={{ width: '100%' }} value={playbook} placeholder="不选" data-testid="role-playbook" onChange={v => setPlaybook(v)} options={(pbs?.items ?? []).map(p => ({ value: p.name, label: p.name }))} /></label>
        <label>只给这个角色的额外说明（可选）<Input.TextArea value={notes} rows={2} maxLength={1500} data-testid="role-notes" onChange={e => setNotes(e.target.value)} /></label>
      </div>
    </Modal>
  )
}

/** 助手设置：机构说明（每次对话都会带上）和上下文上限 */
export function AssistantSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['agent', 'settings'], queryFn: () => window.api.agent.settings(), enabled: open, staleTime: 0 })
  const [ctx, setCtx] = useState('')
  const [limit, setLimit] = useState<number | null>(null)
  useEffect(() => { if (open && data) { setCtx(data.orgContext); setLimit(data.contextLimit) } }, [open, data])
  const max = data?.orgContextMax ?? 4000
  const save = async () => {
    try {
      await window.api.agent.saveSettings({ orgContext: ctx, contextLimit: limit })
      qc.invalidateQueries({ queryKey: ['agent', 'settings'] }); message.success('已保存'); onClose()
    } catch (e) { message.error(clean(e)) }
  }
  return (
    <Modal open={open} title="助手设置" onCancel={onClose} width={560} destroyOnClose
      footer={<><Btn tone="secondary" onClick={onClose}>取消</Btn><Btn tone="primary" data-testid="assistant-settings-save" onClick={save}>保存</Btn></>}>
      <div data-testid="assistant-settings" style={{ display: 'grid', gap: 12 }}>
        <div>
          <b>机构说明</b>
          <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>写给助手的背景：我们怎么叫级别、续费周期、到课怎么算、常用口径……每次对话都会带上，不用每次重复说。</p>
          <Input.TextArea value={ctx} rows={8} data-testid="assistant-org-context" placeholder="例如：我们把一级叫“启蒙”，续费周期按学期算……" onChange={e => setCtx(e.target.value)} />
          <span className="ewb-lib-sub" data-testid="assistant-org-count" style={ctx.length > max ? { color: 'var(--ewb-red-ink)' } : undefined}>{ctx.length} / {max} 字{ctx.length > max ? `——超出的 ${ctx.length - max} 字不会发给助手，请精简` : ''}</span>
        </div>
        <div>
          <b>上下文上限</b>
          <p className="ewb-lib-sub" style={{ margin: '2px 0 6px' }}>对话用到上限的约 70% 时，助手会自动把前面的内容整理成摘要再继续。不填就按模型的默认值（现在是 {data?.contextLimitEffective?.toLocaleString() ?? '…'} token）。</p>
          <InputNumber value={limit} min={8000} max={1000000} step={8000} placeholder={String(data?.contextLimitDefault ?? 64000)} data-testid="assistant-context-limit" onChange={v => setLimit(v === null ? null : Number(v))} style={{ width: 180 }} /> token
        </div>
      </div>
    </Modal>
  )
}
