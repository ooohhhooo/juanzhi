import React, { useState } from 'react'
import { MessageCircle, Plug, PlugZap, Puzzle, Trash2 } from 'lucide-react'
import { App, Checkbox, Input, Modal, Select } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Panel, UsageNote } from '../design'
import '../design/page-report.css'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 「打开石墨文档导入页」按钮：导出 Word / Markdown 后放在导出结果旁边（其他页面也可直接引用） */
export function ShimoImportButton({ size = 'small' }: { size?: 'small' | 'middle' }): React.ReactElement {
  return (
    <span className="ewb-rep-row" style={{ gap: 8 }}>
      <Btn tone="secondary" size={size} data-testid="shimo-open" onClick={() => void window.api.connectors.openShimo()}>打开石墨文档</Btn>
      <span className="ewb-rep-note" style={{ margin: 0 }}>石墨支持导入 Word、Markdown 文件。</span>
    </span>
  )
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0 && line.trim()) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return env
}

export default function ConnectorSettings(): React.ReactElement {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data: types = [] } = useQuery({ queryKey: ['connector-types'], queryFn: () => window.api.connectors.types(), staleTime: Infinity })
  const { data: list = [] } = useQuery({ queryKey: ['connectors'], queryFn: () => window.api.connectors.list(), staleTime: 0 })
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('wecom')
  const [name, setName] = useState('')
  const [webhook, setWebhook] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['connectors'] })

  const reset = () => { setName(''); setWebhook(''); setCommand(''); setArgsText(''); setEnvText(''); setFormError(null) }

  const add = async () => {
    setFormError(null)
    try {
      const config = type === 'wecom'
        ? { webhook }
        : { command, args: argsText.split('\n').map(s => s.trim()).filter(Boolean), env: parseEnv(envText) }
      const v = await window.api.connectors.save({ type, name, config })
      await refresh()
      setOpen(false); reset()
      message.success('已添加')
      void test(v.id)
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

  const typeName = (t: string) => types.find(x => x.id === t)?.name ?? t

  return (
    <div className="ewb-set-panel">
      <Panel title="连接器" data-testid="connectors-panel" aside={<Btn tone="primary" size="small" icon={Plug} data-testid="connector-add" onClick={() => { reset(); setOpen(true) }}>添加连接</Btn>}>
        <p className="ewb-rep-note">让 Agent 把结果发到企业微信群，或连接其他工具。每次对外发送，都会先给你看完整内容，你点「发送」才会发出。</p>
        {list.length === 0 && <p className="ewb-rep-note" data-testid="connector-empty">还没有连接。</p>}
        {list.map(c => (
          <div key={c.id} className="ewb-rep-block" data-testid={`connector-${c.name}`} style={{ marginTop: 10 }}>
            <div className="ewb-rep-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <strong data-testid="connector-name">{c.name}</strong>
              <span className="ewb-lib-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{c.type === 'mcp' ? <Puzzle size={12} /> : <MessageCircle size={12} />}{typeName(c.type)}</span>
              <code className="ewb-rep-code" data-testid="connector-summary">{c.summary}</code>
              <Btn tone="secondary" size="small" icon={PlugZap} loading={busy === c.id} data-testid="connector-test" onClick={() => void test(c.id)}>{c.type === 'mcp' ? '测试并读取工具' : '测试连接'}</Btn>
              <Btn tone="quiet" size="small" icon={Trash2} data-testid="connector-remove" onClick={() => remove(c.id, c.name)}>删除</Btn>
            </div>
            {results[c.id] && <UsageNote kind={results[c.id].ok ? 'tip' : 'mistake'} title={results[c.id].ok ? '连接正常' : '没连上'} data-testid="connector-result">{results[c.id].message}</UsageNote>}
            {c.type === 'mcp' && c.tools && (
              <div data-testid="mcp-tools" style={{ marginTop: 6 }}>
                <p className="ewb-rep-note">勾选允许 Agent 使用的工具（使用时都会先让你确认）：</p>
                {c.tools.length === 0 && <p className="ewb-rep-note">这个服务器没有提供工具。</p>}
                <Checkbox.Group
                  value={c.allowed ?? []}
                  onChange={async v => { await window.api.connectors.setAllowed(c.id, v as string[]); await refresh() }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  {c.tools.map(t => <Checkbox key={t.name} value={t.name} data-testid={`mcp-tool-${t.name}`}>{t.name}{t.description ? ` · ${t.description}` : ''}</Checkbox>)}
                </Checkbox.Group>
              </div>
            )}
          </div>
        ))}
      </Panel>

      <Panel title="石墨文档" data-testid="shimo-panel">
        <p className="ewb-rep-note">把报告导出为 Word 或 Markdown，再到石墨文档里导入。</p>
        <ShimoImportButton />
      </Panel>

      <Modal title="添加连接" open={open} onCancel={() => setOpen(false)} onOk={() => void add()} okText="添加" cancelText="取消" okButtonProps={{ ...{ 'data-testid': 'connector-save' } }} destroyOnClose>
        <div data-testid="connector-form" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Select value={type} onChange={v => { setType(v); setFormError(null) }} options={types.map(t => ({ value: t.id, label: t.name }))} data-testid="connector-type" />
          <p className="ewb-rep-note" style={{ margin: 0 }}>{types.find(t => t.id === type)?.description}</p>
          <Input placeholder={type === 'wecom' ? '名称，例如：三年级辅导群' : '名称，例如：笔记工具'} maxLength={30} value={name} onChange={e => setName(e.target.value)} data-testid="connector-form-name" />
          {type === 'wecom' ? (
            <Input.Password placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" value={webhook} onChange={e => setWebhook(e.target.value)} autoComplete="off" data-testid="connector-form-webhook" />
          ) : (
            <>
              <Input placeholder="命令，例如 npx" value={command} onChange={e => setCommand(e.target.value)} data-testid="connector-form-command" />
              <Input.TextArea placeholder="参数，每行一个" rows={3} value={argsText} onChange={e => setArgsText(e.target.value)} data-testid="connector-form-args" />
              <Input.TextArea placeholder="环境变量，每行 名称=值（保存后只显示名称）" rows={3} value={envText} onChange={e => setEnvText(e.target.value)} data-testid="connector-form-env" />
              <UsageNote kind="caution" title="只连你信任的程序">MCP 服务器会在这台电脑上运行，能做它被允许做的任何事。</UsageNote>
            </>
          )}
          {formError && <UsageNote kind="mistake" title="不能保存" data-testid="connector-form-error">{formError}</UsageNote>}
        </div>
      </Modal>
    </div>
  )
}
