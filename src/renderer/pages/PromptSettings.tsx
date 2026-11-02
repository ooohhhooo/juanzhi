import React, { useEffect, useState } from 'react'
import { App, Collapse, Input, Space } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, Glossary, Panel, UsageNote } from '../design'
import '../design/page-report.css'

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
        <b>{partLabel[item.part]}</b>
        {item.isCustom ? <span className="ewb-set-pill ewb-set-pill--custom" style={{ marginInlineStart: 0 }}>已自定义</span> : <span className="ewb-set-pill" style={{ marginInlineStart: 0 }}>内置默认</span>}
        {item.defaultUpdated && <span className="ewb-set-pill" style={{ marginInlineStart: 0 }} data-testid={`prompt-updated-${item.id}-${item.part}`}>默认版已更新（{item.version}），可对比</span>}
        {item.unknownPlaceholders.length > 0 && <span className="ewb-set-pill ewb-set-pill--bad" style={{ marginInlineStart: 0 }}>未知占位符：{item.unknownPlaceholders.map(p => `{{${p}}}`).join('、')}</span>}
      </Space>
      <Input.TextArea data-testid={`prompt-text-${item.id}-${item.part}`} rows={12} value={text} onChange={e => setText(e.target.value)} className="ewb-set-mono" />
      {item.defaultUpdated && (
        <Collapse ghost size="small" style={{ marginTop: 4 }} items={[{ key: 'cmp', label: <span>看新的内置默认版（{item.version}）和你的版本对比</span>, children: (
          <div data-testid={`prompt-compare-${item.id}-${item.part}`}>
            <p style={{ margin: '0 0 6px' }}>你自定义过这个提示词，所以一直在用你自己的版本，没有被换掉。内置默认版之后升级了（{item.version}），新版内容如下，想用的话可以参考修改你的版本，或点「恢复默认」直接换成新版。</p>
            <Input.TextArea rows={10} value={item.defaultText} readOnly className="ewb-set-mono" />
          </div>
        ) }]} />
      )}
      <Space style={{ marginTop: 6 }}>
        <Btn tone="primary" size="small" disabled={!dirty} loading={saving} data-testid={`prompt-save-${item.id}-${item.part}`} onClick={save}>保存修改</Btn>
        <Btn tone="secondary" size="small" disabled={!item.isCustom && !dirty} data-testid={`prompt-reset-${item.id}-${item.part}`} onClick={item.isCustom ? reset : () => setText(item.defaultText)}>恢复默认</Btn>
        {dirty && <span className="ewb-set-dirty">有未保存的修改</span>}
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
    <div className="ewb-set-panel"><Panel title={<Glossary term="提示词">提示词</Glossary>} data-testid="prompt-settings">
      <UsageNote kind="caution" title="一般不需要改。改坏了会让解析失败或结果变差；任何时候都可以点「恢复默认」。">
        <span>每份试卷解析时都会记录用的是哪个提示词版本（内置版本现为 <b>{data.defaultVersion}</b>，老师版及其口诀 / 变形题提示词已升到 <b>v3.0</b>；改写后显示为「基于的内置版本+自定义·哈希」）。<code>{'{{占位符}}'}</code> 由程序在每次调用时填入，不要改名；Schema 与 anchor 规则改动后需同步改程序的校验。</span>
      </UsageNote>
      <Collapse accordion size="small" items={groups.map(id => {
        const items = data.items.filter(i => i.id === id)
        const custom = items.some(i => i.isCustom)
        return {
          key: id,
          label: <span>{items[0].title} {custom && <span className="ewb-set-pill ewb-set-pill--custom">已自定义</span>} {items.some(i => i.defaultUpdated) && <span className="ewb-set-pill">默认版已更新，可对比</span>} {!items[0].usedInM2 && <span className="ewb-set-pill">当前版本未使用</span>}</span>,
          children: items.map(i => <PromptEditor key={i.part} item={i} onSaved={refresh} />)
        }
      })} />
    </Panel></div>
  )
}
