import React, { useEffect, useState } from 'react'
import { App, Alert, Button, Card, Collapse, Input, Space, Tag } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const partLabel = { system: 'system（固定指令，利于服务商前缀缓存）', user: 'user（每次调用填入占位符）' } as const

function PromptEditor({ item, onSaved }: { item: PromptView; onSaved: () => void }) {
  const { message } = App.useApp()
  const [text, setText] = useState(item.text)
  const [saving, setSaving] = useState(false)
  useEffect(() => setText(item.text), [item.text])
  const dirty = text !== item.text

  const save = async () => {
    setSaving(true)
    try { await window.api.ai.savePrompt(item.id, item.part, text); message.success('已保存，下一次解析起生效'); onSaved() }
    catch (e) { message.error(clean(e)) }
    finally { setSaving(false) }
  }
  const reset = async () => {
    try { await window.api.ai.resetPrompt(item.id, item.part); message.success('已恢复默认'); onSaved() }
    catch (e) { message.error(clean(e)) }
  }

  return (
    <div style={{ marginBottom: 12 }} data-testid={`prompt-${item.id}-${item.part}`}>
      <Space style={{ marginBottom: 4 }} wrap>
        <b style={{ fontSize: 13 }}>{partLabel[item.part]}</b>
        {item.isCustom ? <Tag color="orange">已自定义</Tag> : <Tag>内置默认</Tag>}
        {item.unknownPlaceholders.length > 0 && <Tag color="error">未知占位符：{item.unknownPlaceholders.map(p => `{{${p}}}`).join('、')}</Tag>}
      </Space>
      <Input.TextArea data-testid={`prompt-text-${item.id}-${item.part}`} rows={12} value={text} onChange={e => setText(e.target.value)} style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }} />
      <Space style={{ marginTop: 6 }}>
        <Button size="small" type="primary" disabled={!dirty} loading={saving} data-testid={`prompt-save-${item.id}-${item.part}`} onClick={save}>保存修改</Button>
        <Button size="small" disabled={!item.isCustom && !dirty} data-testid={`prompt-reset-${item.id}-${item.part}`} onClick={item.isCustom ? reset : () => setText(item.defaultText)}>恢复默认</Button>
        {dirty && <span style={{ color: '#faad14', fontSize: 12 }}>有未保存的修改</span>}
      </Space>
    </div>
  )
}

export default function PromptSettings() {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['prompts'], queryFn: () => window.api.ai.prompts(), staleTime: 0 })
  if (!data) return null
  const groups = [...new Set(data.items.map(i => i.id))]
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['prompts'] })

  return (
    <Card title="提示词" size="small" style={{ marginBottom: 16 }} data-testid="prompt-settings">
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="一般不需要改。改坏了会让解析失败或结果变差；任何时候都可以点「恢复默认」。"
        description={<span>每份试卷解析时都会记录用的是哪个提示词版本（内置版本现为 <b>{data.defaultVersion}</b>，改写后显示为「{data.defaultVersion}+自定义·哈希」）。<code>{'{{占位符}}'}</code> 由程序在每次调用时填入，不要改名；Schema 与 anchor 规则改动后需同步改程序的校验。</span>} />
      <Collapse accordion size="small" items={groups.map(id => {
        const items = data.items.filter(i => i.id === id)
        const custom = items.some(i => i.isCustom)
        return {
          key: id,
          label: <span>{items[0].title} {custom && <Tag color="orange">已自定义</Tag>} {!items[0].usedInM2 && <Tag>后续里程碑使用</Tag>}</span>,
          children: items.map(i => <PromptEditor key={i.part} item={i} onSaved={refresh} />)
        }
      })} />
    </Card>
  )
}
