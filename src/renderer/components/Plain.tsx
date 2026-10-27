import React from 'react'
import { Tooltip } from 'antd'
import { lookupTerm } from '../../shared/glossary'
import { Glossary } from '../design'

/** 带悬停释义的词：虚线下划线，鼠标放上去（或键盘聚焦）显示术语表里的词典式释义：词头、白话一句、例子一句。数据来自 shared/glossary.ts */
export function Term({ term, children }: { term: string; children?: React.ReactNode }) {
  const g = lookupTerm(term)
  const text = children ?? term
  if (!g) return <>{text}</>
  return <span data-term={g.term}><Glossary item={{ term: g.term, plain: g.plain, example: g.example }}>{text}</Glossary></span>
}

/** 「AI 草稿 · 请老师核对」标识（老师核对后换成「已由老师核对」）。状态字段是 aiDraft / confirmedAt */
export function AiDraftBadge({ confirmedAt, style }: { confirmedAt?: string | null; style?: React.CSSProperties }) {
  return confirmedAt
    ? <span className="ewb-status ewb-status--done" data-testid="ai-draft-badge" data-confirmed="1" style={style}>已由老师核对 · {confirmedAt}</span>
    : <Tooltip title="AI 写出来的内容都是草稿：用之前请老师核对，尤其是讲英语规则的地方。"><span className="ewb-status ewb-status--pending" data-testid="ai-draft-badge" data-confirmed="0" tabIndex={0} style={style}>AI 草稿 · 请老师核对</span></Tooltip>
}

/** 等待 AI 时的文案：已用多少秒；推理模型先「思考」再「写」 */
export function waitingText(o: { seconds: number; hasText: boolean; thinking: boolean; retried: boolean }): string {
  if (o.retried && !o.hasText) return `输出内容较长，AI 正在自动加长篇幅重试一次，不需要操作 · 已用 ${o.seconds} 秒（通常 2–3 分钟）`
  if (o.hasText) return `AI 正在写 · 已用 ${o.seconds} 秒（通常 2–3 分钟）`
  return o.thinking ? `AI 正在思考 · 已用 ${o.seconds} 秒（通常 2–3 分钟）` : `AI 正在准备 · 已用 ${o.seconds} 秒（通常 2–3 分钟）`
}
