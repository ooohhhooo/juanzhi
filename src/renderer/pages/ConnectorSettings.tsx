import React, { useState } from 'react'
import {
  BellRing, ExternalLink, FileUp, FolderOpen, GitBranch, Globe, Link as LinkIcon, MessageCircle, MessagesSquare, NotebookText,
  Plug, PlugZap, Puzzle, Terminal, Trash2, ChevronLeft, type LucideIcon
} from 'lucide-react'
import { App, Checkbox, Input, Modal, Segmented } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Panel, StatusLabel, UsageNote } from '../design'
import { MCP_PRESETS, PRESET_GROUPS, buildCustomConfig, buildPresetConfig, getPreset, validateCustom, validatePresetValues, type McpPreset } from '../../shared/connector-presets'
import '../design/page-report.css'
import '../design/page-connectors.css'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ICONS: Record<string, LucideIcon> = { MessagesSquare, Globe, BellRing, NotebookText, GitBranch, FolderOpen, Link: LinkIcon }

/** 「打开石墨文档导入页」按钮：导出 Word / Markdown 后放在导出结果旁边（其他页面也可直接引用） */
export function ShimoImportButton({ size = 'small' }: { size?: 'small' | 'middle' }): React.ReactElement {
  return (
    <span className="ewb-rep-row" style={{ gap: 8 }}>
      <Btn tone="secondary" size={size} data-testid="shimo-open" onClick={() => void window.api.connectors.openShimo()}>打开石墨文档</Btn>
      <span className="ewb-rep-note" style={{ margin: 0 }}>石墨支持导入 Word、Markdown 文件。</span>
    </span>
  )
}

type Pick = { kind: 'wecom' } | { kind: 'preset'; preset: McpPreset } | { kind: 'custom' }

function Item({ icon: I, name, desc, tag, onClick, id }: { icon: LucideIcon; name: string; desc: string; tag?: string; onClick: () => void; id: string }): React.ReactElement {
  return (
    <button type="button" className="ewb-conn-item" onClick={onClick} data-testid={`connector-pick-${id}`}>
      <span className="ewb-conn-item__icon" aria-hidden><I size={16} /></span>
      <span className="ewb-conn-item__body">
        <span className="ewb-conn-item__name">{name}{tag && <span className="ewb-lib-tag">{tag}</span>}</span>
        <span className="ewb-conn-item__desc">{desc}</span>
      </span>
    </button>
  )
}

export default function ConnectorSettings(): React.ReactElement {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data: list = [] } = useQuery({ queryKey: ['connectors'], queryFn: () => window.api.connectors.list(), staleTime: 0 })
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<Pick | null>(null)
  const [name, setName] = useState('')
  const [webhook, setWebhook] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['connectors'] })

  const reset = () => { setPick(null); setName(''); setWebhook(''); setValues({}); setMode('stdio'); setCommand(''); setArgsText(''); setEnvText(''); setUrl(''); setHeadersText(''); setFormError(null) }
  const uniqueName = (base: string): string => {
    const used = new Set(list.map(c => c.name))
    if (!used.has(base)) return base
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`
  }
  const choose = (p: Pick) => {
    setFormError(null); setPick(p)
    setName(uniqueName(p.kind === 'wecom' ? '企业微信群' : p.kind === 'preset' ? p.preset.name : '自定义 MCP'))
  }

  const add = async () => {
    if (!pick) return
    setFormError(null)
    try {
      let type = 'mcp'
      let config: Record<string, unknown>
      if (pick.kind === 'wecom') { type = 'wecom'; config = { webhook } }
      else if (pick.kind === 'preset') {
        const v = validatePresetValues(pick.preset, values)
        if (!v.ok) { setFormError(v.error); return }
        config = buildPresetConfig(pick.preset, values) as unknown as Record<string, unknown>
      } else {
        const input = { mode, command, argsText, envText, url, headersText }
        const v = validateCustom(input)
        if (!v.ok) { setFormError(v.error); return }
        config = buildCustomConfig(input) as unknown as Record<string, unknown>
      }
      const saved = await window.api.connectors.save({ type, name, config })
      await refresh()
      setOpen(false); reset()
      message.success('已添加')
      void test(saved.id)
    } catch (e) { setFormError(clean(e)) }
  }

  const test = async (id: string) => {
    setBusy(id)
    try {
      const r = await window.api.connectors.test(id)
      setResults(s => ({ ...s, [id]: { ok: r.ok, message: r.message } }))
      qc.setQueryData(['connectors'], r.connectors)
    } catch (e) { setResults(s => ({ ...s, [id]: { ok: false, message: clean(e) } })) } finally { setBusy(null) }
  }

  const remove = (id: string, nm: string) => Modal.confirm({
    title: `删除「${nm}」？`, content: '只删除卷知里的这条连接，不影响对方。', okText: '删除', cancelText: '取消',
    onOk: async () => { await window.api.connectors.remove(id); await refresh() }
  })

  const kindLabel = (c: ConnectorView): string => c.type === 'wecom' ? '企业微信群' : c.preset ? (getPreset(c.preset)?.name ?? 'MCP') : c.transport === 'http' ? 'MCP · 网址' : 'MCP · 本地命令'
  const presetFields = pick?.kind === 'preset' ? pick.preset.fields : []

  return (
    <div className="ewb-set-panel">
      <Panel title="连接器" data-testid="connectors-panel" aside={<Btn tone="primary" size="small" icon={Plug} data-testid="connector-add" onClick={() => { reset(); setOpen(true) }}>添加连接</Btn>}>
        <p className="ewb-rep-note">每次对外发送，都会先给你看完整内容，你点「发送」才会发出。</p>
        {list.length === 0 && <p className="ewb-rep-note" data-testid="connector-empty">还没有连接。</p>}
        {list.map(c => {
          const res = results[c.id] ?? c.lastTest
          const nTools = c.tools?.length
          return (
            <div key={c.id} className="ewb-rep-block" data-testid={`connector-${c.name}`} style={{ marginTop: 10 }}>
              <div className="ewb-rep-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong data-testid="connector-name">{c.name}</strong>
                <span className="ewb-lib-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{c.type === 'mcp' ? <Puzzle size={12} /> : <MessageCircle size={12} />}{kindLabel(c)}</span>
                <span data-testid="connector-status"><StatusLabel kind={res ? (res.ok ? 'done' : 'failed') : 'queued'}>{res ? (res.ok ? '已连接' : '出错') : '未测试'}</StatusLabel></span>
                {c.type === 'mcp' && nTools != null && <span className="ewb-rep-note" style={{ margin: 0 }} data-testid="connector-tool-count">{nTools} 个工具</span>}
                <code className="ewb-rep-code" data-testid="connector-summary">{c.summary}</code>
                <Btn tone="secondary" size="small" icon={PlugZap} loading={busy === c.id} data-testid="connector-test" onClick={() => void test(c.id)}>测试连接</Btn>
                <Btn tone="quiet" size="small" icon={Trash2} data-testid="connector-remove" onClick={() => remove(c.id, c.name)}>删除</Btn>
              </div>
              {res && <UsageNote kind={res.ok ? 'tip' : 'mistake'} title={res.ok ? '连接正常' : '出错了'} data-testid="connector-result">{res.message}</UsageNote>}
              {c.type === 'mcp' && c.tools && (
                <div data-testid="mcp-tools" style={{ marginTop: 6 }}>
                  <p className="ewb-rep-note">勾选允许助手使用的工具。助手每次使用，都会先给你看完整内容，你点「发送」才会执行。</p>
                  {c.tools.length === 0 && <p className="ewb-rep-note">这个服务器没有提供工具。</p>}
                  {c.tools.length > 0 && (
                    <div className="ewb-rep-row" style={{ gap: 8, marginBottom: 6 }}>
                      <Btn tone="quiet" size="small" data-testid="mcp-readonly-only" disabled={!c.tools.some(t => t.readOnly)} onClick={async () => { await window.api.connectors.setAllowed(c.id, c.tools!.filter(t => t.readOnly).map(t => t.name)); await refresh() }}>只选读取类</Btn>
                      <Btn tone="quiet" size="small" data-testid="mcp-none" onClick={async () => { await window.api.connectors.setAllowed(c.id, []); await refresh() }}>全不选</Btn>
                    </div>
                  )}
                  <Checkbox.Group
                    value={c.allowed ?? []}
                    onChange={async v => { await window.api.connectors.setAllowed(c.id, v as string[]); await refresh() }}
                    className="ewb-conn-tools"
                  >
                    {c.tools.map(t => (
                      <Checkbox key={t.name} value={t.name} data-testid={`mcp-tool-${t.name}`}>
                        {t.name}{t.description ? ` · ${t.description}` : ''}{t.readOnly && <span className="ewb-conn-ro">只读</span>}
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                </div>
              )}
            </div>
          )
        })}
      </Panel>

      <Modal title={pick ? '填写连接信息' : '添加连接'} open={open} onCancel={() => setOpen(false)} width={640} destroyOnClose afterClose={reset}
        footer={pick ? (
          <div className="ewb-rep-row" style={{ justifyContent: 'space-between' }}>
            <Btn tone="quiet" size="small" icon={ChevronLeft} data-testid="connector-back" onClick={() => { setPick(null); setFormError(null) }}>返回</Btn>
            <span className="ewb-rep-row" style={{ gap: 8 }}>
              <Btn tone="secondary" size="small" onClick={() => setOpen(false)}>取消</Btn>
              <Btn tone="primary" size="small" data-testid="connector-save" onClick={() => void add()}>添加</Btn>
            </span>
          </div>
        ) : null}>
        {!pick ? (
          <div data-testid="connector-picker">
            <section className="ewb-conn-group">
              <h4 className="ewb-conn-group__title">消息群</h4>
              <div className="ewb-conn-grid">
                <Item id="wecom" icon={MessageCircle} name="企业微信群机器人" desc="把结果发到企业微信群。" onClick={() => choose({ kind: 'wecom' })} />
              </div>
            </section>
            {PRESET_GROUPS.map(g => (
              <section key={g.id} className="ewb-conn-group">
                <h4 className="ewb-conn-group__title">{g.label}</h4>
                <div className="ewb-conn-grid">
                  {MCP_PRESETS.filter(p => p.group === g.id).map(p => (
                    <Item key={p.id} id={p.id} icon={ICONS[p.icon] ?? Puzzle} name={p.name} desc={p.desc} tag={p.confidence === 'confirm' ? '需要自行确认' : undefined} onClick={() => choose({ kind: 'preset', preset: p })} />
                  ))}
                </div>
              </section>
            ))}
            <section className="ewb-conn-group">
              <h4 className="ewb-conn-group__title">其他</h4>
              <div className="ewb-conn-grid">
                <Item id="custom" icon={Terminal} name="自定义 MCP" desc="任意 MCP 服务器：本机命令，或一个网址。" onClick={() => choose({ kind: 'custom' })} />
              </div>
            </section>
            <section className="ewb-conn-group" style={{ marginBottom: 0 }}>
              <h4 className="ewb-conn-group__title">导出后导入</h4>
              <div className="ewb-conn-tip" data-testid="shimo-panel">
                <span className="ewb-conn-item__icon" aria-hidden><FileUp size={16} /></span>
                <span className="ewb-conn-tip__text"><strong>石墨文档</strong>　不用连接：把报告导出为 Word 或 Markdown，再到石墨里导入。</span>
                <ShimoImportButton />
              </div>
            </section>
          </div>
        ) : (
          <div data-testid="connector-form" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Input placeholder={pick.kind === 'wecom' ? '名称，例如：三年级辅导群' : '名称'} maxLength={30} value={name} onChange={e => setName(e.target.value)} data-testid="connector-form-name" />
            {pick.kind === 'wecom' && (
              <Input.Password placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" value={webhook} onChange={e => setWebhook(e.target.value)} autoComplete="off" data-testid="connector-form-webhook" />
            )}
            {pick.kind === 'preset' && (
              <>
                <p className="ewb-rep-note" style={{ margin: 0 }}>{pick.preset.desc}{pick.preset.note ? ` ${pick.preset.note}` : ''}</p>
                {presetFields.map(f => {
                  const common = { placeholder: `${f.label}${f.placeholder ? `，例如 ${f.placeholder}` : ''}`, value: values[f.key] ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValues(s => ({ ...s, [f.key]: e.target.value })), autoComplete: 'off', 'data-testid': `connector-field-${f.key}` }
                  return f.secret ? <Input.Password key={f.key} {...common} /> : <Input key={f.key} {...common} />
                })}
                {presetFields.some(f => f.secret) && <p className="ewb-rep-note" style={{ margin: 0 }}>密钥加密保存在这台电脑上，保存后界面不再显示。</p>}
                <span className="ewb-rep-row" style={{ gap: 8 }}>
                  <Btn tone="quiet" size="small" icon={ExternalLink} data-testid="connector-docs" onClick={() => void window.api.connectors.openDocs(pick.preset.id)}>查看说明文档</Btn>
                  {pick.preset.confidence === 'confirm' && <span className="ewb-rep-note" style={{ margin: 0 }}>这项的服务范围以对方当前提供的为准，请自行确认。</span>}
                </span>
              </>
            )}
            {pick.kind === 'custom' && (
              <>
                <Segmented value={mode} onChange={v => { setMode(v as 'stdio' | 'http'); setFormError(null) }} data-testid="connector-form-mode"
                  options={[{ value: 'stdio', label: '本地命令' }, { value: 'http', label: '网址' }]} />
                {mode === 'stdio' ? (
                  <>
                    <Input placeholder="命令，例如 npx" value={command} onChange={e => setCommand(e.target.value)} data-testid="connector-form-command" />
                    <Input.TextArea placeholder="参数，每行一个" rows={3} value={argsText} onChange={e => setArgsText(e.target.value)} data-testid="connector-form-args" />
                    <Input.TextArea placeholder="环境变量，每行 名称=值（保存后只显示名称）" rows={3} value={envText} onChange={e => setEnvText(e.target.value)} data-testid="connector-form-env" />
                  </>
                ) : (
                  <>
                    <Input placeholder="网址，例如 https://example.com/mcp" value={url} onChange={e => setUrl(e.target.value)} autoComplete="off" data-testid="connector-form-url" />
                    <Input.TextArea placeholder="请求头（可选），每行 名称: 值，例如 Authorization: Bearer …（保存后只显示名称）" rows={3} value={headersText} onChange={e => setHeadersText(e.target.value)} data-testid="connector-form-headers" />
                  </>
                )}
              </>
            )}
            {(pick.kind === 'custom' || pick.kind === 'preset') && (
              <UsageNote kind="caution" title="只连你信任的服务">
                {(pick.kind === 'custom' && mode === 'http') || (pick.kind === 'preset' && pick.preset.transport.kind === 'http')
                  ? '助手发给它的内容会离开这台电脑；每次发送前都会先让你确认。'
                  : 'MCP 服务器会在这台电脑上运行，能做它被允许做的任何事。'}
              </UsageNote>
            )}
            {formError && <UsageNote kind="mistake" title="不能保存" data-testid="connector-form-error">{formError}</UsageNote>}
          </div>
        )}
      </Modal>
    </div>
  )
}
