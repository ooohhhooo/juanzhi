import React, { useMemo, useState } from 'react'
import { Dropdown, Input, Popover, Slider } from 'antd'
import type { MenuProps } from 'antd'
import { ArrowUp, ChevronDown, Hand, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import { getAssistantSlots } from './assistant-slots'
import type { Mentionable } from './assistant-slots'

export const MODE_LABEL: Record<AgentMode, string> = { direct: '直接回答', plan: '先出计划', auto: '自动完成' }
export const MODE_HINT: Record<AgentMode, string> = { direct: '简单问题：最多查几次就答，不写计划', plan: '先给你看计划，你点「按这个做」才开始查', auto: '不停下来问，一口气做完（只有要你拿主意时才问）' }
export const APPROVAL_LABEL: Record<AgentApproval, string> = { 'ask-all': '每次询问', 'ask-external': '只问对外发送' }
const APPROVAL_HINT: Record<AgentApproval, string> = { 'ask-all': '导出文件、对外发送都要你点同意', 'ask-external': '导出到本机文件不再问；发到企业微信 / 外部插件仍每次预览确认' }
export const EFFORT_LABEL: Record<AgentEffort, string> = { auto: '自动', off: '关', low: '低', medium: '中', high: '高' }
const OUTPUTS = ['汇报 Word', 'Excel 表', '看板']

/** 输入框上方的小标签：选中的 Skill / 产出形式 / 数据集 / 连接器 */
export interface Chip { key: string; kind: 'playbook' | 'output' | 'dataset' | 'connector'; label: string }
const KIND_LABEL: Record<Chip['kind'], string> = { playbook: 'Skill', output: '产出', dataset: '数据', connector: '连接器' }
/** 把标签翻成一句话，附在问题后面一起发给助手 */
export function chipsToHint(chips: Chip[]): string {
  const parts = chips.filter(c => c.kind !== 'dataset').map(c => (c.kind === 'playbook' ? `使用 Skill《${c.label}》` : c.kind === 'output' ? `产出形式：${c.label}` : c.kind === 'dataset' ? `数据集：${c.label}` : `连接器：${c.label}`))
  return parts.length ? `\n（${parts.join('；')}）` : ''
}

export interface ComposerProps {
  value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; busy: boolean
  chips: Chip[]; onChips: (c: Chip[]) => void
  playbooks: string[]
  mode: AgentMode; onMode: (m: AgentMode) => void
  approval: AgentApproval; onApproval: (a: AgentApproval) => void
  models: AgentModelInfo[]; model: string; mainModel: string; onModel: (m: string) => void
  effort: AgentEffort; onEffort: (e: AgentEffort) => void; effortChoices: AgentEffort[]; curInfo?: AgentModelInfo
  onResetModel: () => void
  /** 标签区里额外的内容（已选数据集标签），排在选中的 Skill / 产出标签前面 */
  extra?: React.ReactNode
}

export default function Composer(p: ComposerProps) {
  const slots = getAssistantSlots()
  const [mentions, setMentions] = useState<Mentionable[]>([])
  const [modelOpen, setModelOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [otherModel, setOtherModel] = useState('')
  const q = /@([^\s@]*)$/.exec(p.value)
  const addChip = (c: Chip) => { if (!p.chips.some(x => x.key === c.key)) p.onChips([...p.chips, c]) }
  const loadMentions = async () => { try { setMentions((await slots.mentionables?.()) ?? []) } catch { setMentions([]) } }

  const mentionItems = useMemo(() => {
    if (!q) return []
    const key = q[1].toLowerCase()
    const all: Array<Chip & { group: string }> = [
      ...mentions.filter(m => m.group === 'dataset').map(m => ({ key: `dataset:${m.id}`, kind: 'dataset' as const, label: m.label, group: '数据集' })),
      ...p.playbooks.map(n => ({ key: `playbook:${n}`, kind: 'playbook' as const, label: n, group: 'Skill' })),
      ...mentions.filter(m => m.group === 'connector').map(m => ({ key: `connector:${m.id}`, kind: 'connector' as const, label: m.label, group: '连接器' }))
    ]
    return all.filter(i => i.label.toLowerCase().includes(key))
  }, [q?.[1], mentions, p.playbooks.join('|')])   // eslint-disable-line react-hooks/exhaustive-deps

  const plusItems: MenuProps['items'] = [
    { key: 'add', disabled: !slots.dataActions?.addFiles, label: <span data-testid="assistant-plus-add">添加数据文件…{!slots.dataActions?.addFiles && <small className="ewb-lib-sub">（数据功能接入后可用）</small>}</span>, onClick: () => slots.dataActions?.addFiles?.() },
    { key: 'pick', disabled: !slots.dataActions?.pickDataset, label: <span data-testid="assistant-plus-dataset">选择已有数据集</span>, onClick: () => slots.dataActions?.pickDataset?.() },
    { key: 'send', disabled: !slots.dataActions?.pickSendFile, label: <span data-testid="assistant-plus-sendfile">选择要发送的文件…</span>, onClick: () => { void slots.dataActions?.pickSendFile?.().then(f => { if (f) p.onChange((p.value ? p.value + '\n' : '') + `请把这个文件发到企业微信群：${f}`) }) } },
    { key: 'pb', label: <span data-testid="assistant-plus-playbook">使用 Skill…</span>, children: p.playbooks.map(n => ({ key: `pb:${n}`, label: <span data-testid="assistant-plus-playbook-item">{n}</span>, onClick: () => addChip({ key: `playbook:${n}`, kind: 'playbook', label: n }) })) },
    { key: 'out', label: <span data-testid="assistant-plus-output">产出为…</span>, children: OUTPUTS.map(o => ({ key: `out:${o}`, label: <span data-testid="assistant-plus-output-item">{o}</span>, onClick: () => addChip({ key: `output:${o}`, kind: 'output', label: o }) })) }
  ]
  const approvalItems: MenuProps['items'] = (['ask-external', 'ask-all'] as AgentApproval[]).map(a => ({ key: a, label: <span data-testid={`assistant-approval-${a}`} title={APPROVAL_HINT[a]}>{APPROVAL_LABEL[a]}<small className="ewb-lib-sub">　{APPROVAL_HINT[a]}</small></span>, onClick: () => p.onApproval(a) }))
  const modeItems: MenuProps['items'] = (['plan', 'direct', 'auto'] as AgentMode[]).map(m => ({ key: m, label: <span data-testid={`assistant-mode-${m}`}>{MODE_LABEL[m]}<small className="ewb-lib-sub">　{MODE_HINT[m]}</small></span>, onClick: () => p.onMode(m) }))

  const idx = Math.max(0, p.effortChoices.indexOf(p.effort))
  const marks = Object.fromEntries(p.effortChoices.map((e, i) => [i, EFFORT_LABEL[e]]))
  const curModel = p.model || p.mainModel
  const hint = p.effort === 'off' && p.curInfo && !p.curInfo.canTurnOff ? '这个模型默认就会思考，选「关」无法真正关闭。' : p.effort === 'off' ? '不使用思考，最快、最省。' : p.effort === 'auto' ? '由服务商默认决定。' : '思考强度越高，回答越慢、用量越大；用量条按所选模型的价格估算。'

  const modelPop = (
    <div className="ewb-as-pop" data-testid="assistant-modelpop">
      <div className="ewb-as-pop__head">
        <b data-testid="assistant-effort-name">{EFFORT_LABEL[p.effort]}</b>
        <button type="button" className="ewb-as-chiplink" data-testid="assistant-model-name" title="点一下切换模型" onClick={() => setListOpen(o => !o)}>{curModel} <ChevronDown size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /></button>
        <span style={{ flex: 1 }} />
        <button type="button" className="ewb-as-chiplink" data-testid="assistant-model-reset" onClick={() => { p.onResetModel(); setListOpen(false) }}>恢复默认</button>
      </div>
      {listOpen && (
        <div className="ewb-as-pop__list" data-testid="assistant-model-list">
          {p.models.map((m, i) => (
            <button key={m.model} type="button" className="ewb-as-pop__opt" data-testid={`assistant-model-opt-${i}`} disabled={m.toolSupport === 'no'} aria-pressed={m.model === curModel}
              onClick={() => { p.onModel(m.model); setListOpen(false) }}>
              {m.model}{m.roles.length ? `（${m.roles.join('、')}）` : ''}{m.toolSupport === 'no' ? ' · 不支持助手' : ''}
            </button>
          ))}
          <div className="ewb-as-ask__other">
            <Input size="small" placeholder="其他模型：填模型名，回车" value={otherModel} data-testid="assistant-model-other" onChange={e => setOtherModel(e.target.value)}
              onPressEnter={() => { const m = otherModel.trim(); if (m) { p.onModel(m); setOtherModel(''); setListOpen(false) } }} />
          </div>
        </div>
      )}
      <div className="ewb-as-pop__slider" data-testid="assistant-effort-slider">
        <Slider min={0} max={Math.max(1, p.effortChoices.length - 1)} step={null} marks={marks} value={idx} tooltip={{ open: false }} onChange={v => p.onEffort(p.effortChoices[v as number] ?? 'auto')} />
      </div>
      <p className="ewb-lib-sub" data-testid="assistant-effort-hint" style={{ margin: 0 }}>{hint}</p>
    </div>
  )

  return (
    <div className="ewb-as-composer" data-testid="assistant-composer">
      {(
        <div className="ewb-as-chips" data-testid="assistant-chips">
          {p.extra}
          {p.chips.map(c => (
            <span key={c.key} className="ewb-as-tagchip" data-testid="assistant-chip" data-kind={c.kind}>{KIND_LABEL[c.kind]} · {c.label}
              <button type="button" aria-label="去掉" data-testid="assistant-chip-remove" onClick={() => p.onChips(p.chips.filter(x => x.key !== c.key))}><X size={12} /></button></span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <Input.TextArea
          variant="borderless" value={p.value} autoSize={{ minRows: 2, maxRows: 8 }} data-testid="assistant-input" disabled={p.disabled}
          placeholder="描述你要分析什么，或拖入数据文件。输入 @ 可以点名数据、Skill、群"
          onChange={e => { p.onChange(e.target.value); if (/@[^\s@]*$/.test(e.target.value)) void loadMentions() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) { e.preventDefault(); if (mentionItems.length && q) { const i = mentionItems[0]; addChip(i); p.onChange(p.value.replace(/@[^\s@]*$/, '')) } else p.onSend() } }}
        />
        {q && mentionItems.length > 0 && (
          <div className="ewb-as-mention" data-testid="assistant-mention-list">
            {['数据集', 'Skill', '连接器'].map(g => {
              const items = mentionItems.filter(i => i.group === g)
              return items.length ? (
                <div key={g}><div className="ewb-as-mention__g">{g}</div>
                  {items.map(i => <button key={i.key} type="button" className="ewb-as-pop__opt" data-testid="assistant-mention-item" onClick={() => { addChip(i); p.onChange(p.value.replace(/@[^\s@]*$/, '')) }}>{i.label}</button>)}
                </div>) : null
            })}
          </div>
        )}
      </div>
      <div className="ewb-as-composer__bar">
        <Dropdown menu={{ items: plusItems }} trigger={['click']} placement="topLeft">
          <button type="button" className="ewb-as-iconbtn" aria-label="添加" data-testid="assistant-plus"><Plus size={16} /></button>
        </Dropdown>
        <Dropdown menu={{ items: approvalItems, selectedKeys: [p.approval] }} trigger={['click']} placement="topLeft">
          <button type="button" className="ewb-as-chiplink" data-testid="assistant-approval-tag" title={APPROVAL_HINT[p.approval]}>{p.approval === 'ask-all' ? <Hand size={13} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /> : <ShieldCheck size={13} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} />} {APPROVAL_LABEL[p.approval]}</button>
        </Dropdown>
        <Dropdown menu={{ items: modeItems, selectedKeys: [p.mode] }} trigger={['click']} placement="topLeft">
          <button type="button" className="ewb-as-chiplink" data-testid="assistant-mode" title={MODE_HINT[p.mode]}>{MODE_LABEL[p.mode]}</button>
        </Dropdown>
        <span style={{ flex: 1 }} />
        <Popover content={modelPop} trigger="click" placement="topRight" open={modelOpen} onOpenChange={setModelOpen} arrow={false}>
          <button type="button" className="ewb-as-chiplink" data-testid="assistant-model-btn"><SlidersHorizontal size={13} style={{ verticalAlign: '-2px' }} /> <span className="ewb-as-modeltxt">{curModel} · {EFFORT_LABEL[p.effort]}</span></button>
        </Popover>
        <button type="button" className="ewb-as-send" aria-label="发送" title="发送（Enter）" disabled={!p.value.trim() || p.busy || p.disabled} data-testid="assistant-send" onClick={p.onSend}><ArrowUp size={16} strokeWidth={2.2} /></button>
      </div>
    </div>
  )
}
