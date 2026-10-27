/**
 * 术语释义 <Glossary>：界面上剩下的每个专业词都包一层，悬停（或键盘聚焦）显示词典式释义：词头、白话一句、例子一句。
 * 术语表集中在 src/shared/glossary.ts（报告和界面共用）；它还不存在时用 glossaryData.ts 里的占位数据。
 *
 *   <Glossary term="分值占比" />                 显示「分值占比」，悬停出释义
 *   <Glossary term="分值占比">占比</Glossary>     显示别的字，释义仍查「分值占比」
 *   <Glossary item={{ term, plain, example }} />  直接给数据
 * 查不到术语时只渲染普通文字，不报错。
 */
import React from 'react'
import { Popover } from 'antd'
import { lookup, type GlossaryItem } from './glossaryData'

export interface GlossaryProps {
  /** 要查的术语词头 */
  term?: string
  /** 直接提供释义（不查表） */
  item?: GlossaryItem
  /** 显示的文字，默认就是术语本身 */
  children?: React.ReactNode
}

function renderBold(s: string) {
  return s.split(/\*\*(.+?)\*\*/g).map((t, i) => (i % 2 === 1 ? <b key={i}>{t}</b> : <React.Fragment key={i}>{t}</React.Fragment>))
}

export default function Glossary({ term, item, children }: GlossaryProps) {
  const entry = item ?? (term ? lookup(term) : undefined)
  const shown = children ?? entry?.term ?? term
  if (!entry) return <>{shown}</>
  const content = (
    <div>
      <p className="ewb-gloss-pop__term">{entry.term}</p>
      <p className="ewb-gloss-pop__plain">{entry.plain}</p>
      {entry.example && <p className="ewb-gloss-pop__eg">例：{renderBold(entry.example)}</p>}
    </div>
  )
  return (
    <Popover content={content} placement="top" mouseEnterDelay={0.2} trigger={['hover', 'focus']} classNames={{ root: 'ewb-gloss-pop' }}>
      <span className="ewb-gloss" tabIndex={0} aria-label={`${entry.term}：${entry.plain}`}>{shown}</span>
    </Popover>
  )
}
