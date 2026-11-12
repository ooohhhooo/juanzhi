import React, { useEffect, useState } from 'react'
import { App, Checkbox, Input, Modal, Tag } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, FileUp, FolderUp, FolderOpen, Copy, Pencil, Download, Trash2 } from 'lucide-react'
import { Btn } from '../design'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const ROLE_OPTIONS = [{ value: 'ops', label: '运营' }, { value: 'tutor', label: '辅导老师' }, { value: 'research', label: '教研' }, { value: 'teacher', label: '主讲老师' }]
const roleText = (roles: string[]) => (roles.length ? roles.map(r => ROLE_OPTIONS.find(o => o.value === r)?.label ?? r).join('、') : '全部角色')
const MAX = 64 * 1024

interface Draft { originalName?: string; name: string; description: string; roles: string[]; when: string; body: string }
const EMPTY: Draft = { name: '', description: '', roles: [], when: '', body: '' }

/** 新建 / 编辑一个我的 Skill */
function SkillEditor({ draft, onClose, onSaved }: { draft: Draft | null; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp()
  const [d, setD] = useState<Draft>(EMPTY)
  useEffect(() => { if (draft) setD(draft) }, [draft])
  const size = new TextEncoder().encode(d.body).length
  const save = async () => {
    try {
      const r = await window.api.agent.playbookSave({ name: d.name.trim(), description: d.description, roles: d.roles, when: d.when, body: d.body, originalName: d.originalName })
      message.success('已保存'); r.warnings.forEach(w => message.warning(w, 6)); onSaved(); onClose()
    } catch (e) { message.error(clean(e)) }
  }
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))
  return (
    <Modal open={!!draft} title={d.originalName ? '编辑 Skill' : '新建 Skill'} onCancel={onClose} width={640} destroyOnClose zIndex={1100}
      footer={<><Btn tone="secondary" onClick={onClose}>取消</Btn><Btn tone="primary" data-testid="skill-save" disabled={!d.name.trim() || !d.description.trim() || !d.body.trim() || size > MAX} onClick={save}>保存</Btn></>}>
      <div data-testid="skill-editor" style={{ display: 'grid', gap: 10 }}>
        <label>名称<Input value={d.name} maxLength={40} placeholder="英文小写加连字符，或中文名" data-testid="skill-name" onChange={e => set({ name: e.target.value })} /></label>
        <label>一句说明<Input value={d.description} maxLength={300} data-testid="skill-desc" onChange={e => set({ description: e.target.value })} /></label>
        <div>适用角色（不选 = 全部角色）
          <div><Checkbox.Group value={d.roles} options={ROLE_OPTIONS} data-testid="skill-roles" onChange={v => set({ roles: v as string[] })} /></div>
        </div>
        <label>什么时候用<Input value={d.when} maxLength={300} data-testid="skill-when" onChange={e => set({ when: e.target.value })} /></label>
        <label>正文（Markdown）
          <Input.TextArea value={d.body} rows={14} data-testid="skill-body" placeholder={'# 标题\n一步一步写清楚怎么做……'} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }} onChange={e => set({ body: e.target.value })} />
        </label>
        <span className="ewb-lib-sub" style={size > MAX ? { color: 'var(--ewb-red-ink)' } : undefined}>{Math.round(size / 1024 * 10) / 10} KB / 64 KB</span>
      </div>
    </Modal>
  )
}

/** 助手设置里的「Skill」页签：内置（只读，可复制）和我的 Skill 的列表、新建 / 编辑 / 删除 / 导入 / 导出 */
export function SkillsPanel() {
  const { message, modal } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['agent', 'playbooks'], queryFn: () => window.api.agent.playbooks(), staleTime: 0 })
  const [draft, setDraft] = useState<Draft | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['agent', 'playbooks'] }) }
  const items = data?.items ?? []
  const mine = items.filter(i => i.source === 'user')
  const builtin = items.filter(i => i.source === 'builtin' && !mine.some(m => m.name === i.name))
  const open = async (name: string, asCopy: boolean) => {
    try {
      const p = await window.api.agent.playbookGet(name)
      if (p) setDraft({ originalName: asCopy ? undefined : p.name, name: p.name, description: p.description, roles: p.roles, when: p.when, body: p.body })
    } catch (e) { message.error(clean(e)) }
  }
  const imp = async (kind: 'file' | 'folder') => {
    try {
      const r = await window.api.agent.playbookImport(kind)
      if (!r.picked) return
      if (!r.ok) { message.error(r.error); return }
      refresh(); message.success(`已导入「${r.name}」${r.note ? `。${r.note}` : ''}`, 6); r.warnings.forEach(w => message.warning(w, 6))
    } catch (e) { message.error(clean(e)) }
  }
  const del = (name: string) => modal.confirm({
    title: `删除 Skill「${name}」？`, content: '只删这份文件；如果有同名的内置 Skill，会恢复使用内置的。', okText: '删除', cancelText: '不删', zIndex: 1100, okButtonProps: { danger: true, 'data-testid': 'skill-delete-ok' } as never,
    onOk: async () => { try { await window.api.agent.playbookDelete(name); refresh(); message.success('已删除') } catch (e) { message.error(clean(e)) } }
  })
  const exp = async (name: string) => { try { const r = await window.api.agent.playbookExport(name); if (r.saved) message.success('已导出为 .md 文件') } catch (e) { message.error(clean(e)) } }
  const row = (i: (typeof items)[number], isMine: boolean) => (
    <div key={`${i.source}:${i.name}`} data-testid="skill-item" data-name={i.name} style={{ display: 'grid', gap: 2, padding: '8px 0', borderBottom: '1px solid var(--ewb-line, #eee)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b data-testid="skill-item-name">{i.name}</b>
        <Tag bordered={false} data-testid="skill-item-source">{!isMine ? '内置' : i.origin === 'imported' ? '导入' : '我的'}</Tag>
        <span style={{ flex: 1 }} />
        {!isMine && <Btn tone="secondary" size="small" icon={Copy} data-testid="skill-copy" onClick={() => open(i.name, true)}>复制为我的 Skill</Btn>}
        {isMine && <Btn tone="secondary" size="small" icon={Pencil} data-testid="skill-edit" onClick={() => open(i.name, false)}>编辑</Btn>}
        <Btn tone="secondary" size="small" icon={Download} data-testid="skill-export" onClick={() => exp(i.name)}>导出</Btn>
        {isMine && <Btn tone="danger" size="small" icon={Trash2} data-testid="skill-delete" onClick={() => del(i.name)}>删除</Btn>}
      </div>
      <span className="ewb-lib-sub">{i.description}</span>
      <span className="ewb-lib-sub">适用：{roleText(i.roles)}</span>
    </div>
  )
  return (
    <div data-testid="skills-panel" style={{ display: 'grid', gap: 12 }}>
      <p className="ewb-lib-sub" style={{ margin: 0 }}>Skill 是写给助手的分析方法说明。助手遇到相关任务时会先读它再照着做。</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn tone="primary" size="small" icon={Plus} data-testid="skill-new" onClick={() => setDraft({ ...EMPTY })}>新建 Skill</Btn>
        <Btn tone="secondary" size="small" icon={FileUp} data-testid="skill-import-file" onClick={() => imp('file')}>导入 .md 文件</Btn>
        <Btn tone="secondary" size="small" icon={FolderUp} data-testid="skill-import-folder" onClick={() => imp('folder')}>导入文件夹（SKILL.md）</Btn>
        <Btn tone="secondary" size="small" icon={FolderOpen} data-testid="skill-open-dir" onClick={() => { void window.api.agent.playbookOpenDir().catch(e => message.error(clean(e))) }}>打开 Skill 文件夹</Btn>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto' }} data-testid="skill-list">
        <b>我的 Skill</b>
        {mine.length ? mine.map(i => row(i, true)) : <p className="ewb-lib-sub" data-testid="skill-mine-empty" style={{ margin: '4px 0 8px' }}>还没有。可以新建、导入，或把内置的复制一份来改。</p>}
        <b style={{ display: 'block', marginTop: 12 }}>内置 Skill</b>
        {builtin.map(i => row(i, false))}
      </div>
      <SkillEditor draft={draft} onClose={() => setDraft(null)} onSaved={refresh} />
    </div>
  )
}
