import React from 'react'
import { App, Popconfirm, Popover } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { Btn, StatusLabel, UsageNote } from '../design'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 一句白话：这份卷子为什么被标成疑似重复（和主进程 similarText 同一个说法） */
export function similarSentence(p: Pick<Paper, 'similar_title' | 'similar_ratio'>): string {
  const pct = Math.round((p.similar_ratio ?? 0) * 100)
  return `疑似重复：像是《${p.similar_title || '另一份已有的卷子'}》的一部分（${pct}% 的题在那份卷子里也有）`
}

/**
 * 疑似重复 / 部分重复的卷子：默认不计入统计，免得同一份卷子被算两次。给老师两个选择：
 *  · 「确实是新卷，计入统计」——不是重复，以后不再提示；
 *  · 「删除这份」——确实重复了，删掉。
 * 只在 similar_state = suspect 时显示。compact = 只显示一个小标签（表格里空间小时用，悬停看说明和操作）。
 */
export default function SimilarNotice({ paper, compact }: { paper: Paper; compact?: boolean }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  if (paper.similar_state !== 'suspect') return null
  const refresh = () => { qc.invalidateQueries({ queryKey: ['papers'] }); qc.invalidateQueries({ queryKey: ['stats'] }) }
  const accept = async () => { try { await window.api.papers.acceptSimilar(paper.id); message.success('已确认是新卷，这份会计入统计'); refresh() } catch (e) { message.error(clean(e)) } }
  const remove = async () => { try { await window.api.papers.remove(paper.id); message.success('已删除'); refresh() } catch (e) { message.error(clean(e)) } }
  const buttons = (
    <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
      <Btn tone="secondary" size="small" data-testid="similar-accept" onClick={accept}>确实是新卷，计入统计</Btn>
      <Popconfirm title="确定删除这份卷子？" okText="删除" cancelText="取消" onConfirm={remove}><Btn tone="danger" size="small" data-testid="similar-delete">删除这份</Btn></Popconfirm>
    </span>
  )
  if (compact) {
    return (
      <Popover content={<div style={{ maxWidth: 340 }}><div style={{ marginBottom: 8 }}>{similarSentence(paper)}。默认不计入统计，免得同一份卷子被算两次。被标出来的也可能是旧卷（后来又导入了更完整的一份）。</div>{buttons}</div>}>
        <span data-testid="similar-tag" style={{ marginInlineStart: 8, verticalAlign: 'middle' }}><StatusLabel kind="pending">疑似重复</StatusLabel></span>
      </Popover>
    )
  }
  return (
    <UsageNote kind="caution" data-testid="similar-notice" actions={buttons}>
      <b>{similarSentence(paper)}</b>。默认不计入统计，免得同一份卷子被算两次。被标出来的也可能是旧卷（后来又导入了更完整的一份）：如果是，删掉这份旧的；如果确实是另一份新卷，点「确实是新卷」。
    </UsageNote>
  )
}
