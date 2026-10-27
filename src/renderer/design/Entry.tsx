/**
 * 词条 <Entry>：本设计系统最核心的组件。每个考点就是一个词条。
 *
 * 从上到下：词头（中文考点名，词头蓝加粗，后面跟斜体英文例词）→ 标签行（悬停有白话解释）→ 释义 → 例句（斜体，目标词加粗）
 * → 「出自原卷」缩略图（点击放大，写明哪份卷子第几题）→ 参见（可跳转）。
 * 三种尺寸：compact 紧凑（列表用）、standard 标准（总览用）、full 完整（详情抽屉用）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from 'antd'
import { ArrowRight, X } from 'lucide-react'
import { Icon } from './icons'
import { Btn } from './Basics'
import { CATEGORY_BY_KEY, type CategoryKey } from './tokens'

// ───────────── 例句 ─────────────

export interface EntryExample {
  /** 英文例句。用 **双星号** 标出目标词，例如 "It's time **for** breakfast." */
  en: string
  /** 中文意思（次要色，跟在后面） */
  zh?: string
}

/** 把 "It's time **for** breakfast." 渲染成斜体句子，目标词加粗 */
export function Example({ en, zh, className }: EntryExample & { className?: string }) {
  const parts = en.split(/\*\*(.+?)\*\*/g)
  return (
    <p className={`ewb-eg${className ? ' ' + className : ''}`}>
      <span className="ewb-eg__en" lang="en">
        {parts.map((t, i) => (i % 2 === 1 ? <b key={i}>{t}</b> : <React.Fragment key={i}>{t}</React.Fragment>))}
      </span>
      {zh && <span className="ewb-eg__zh">{zh}</span>}
    </p>
  )
}

// ───────────── 标签 ─────────────

export interface EntryTagSpec {
  /** 标签文字，如「考过 2/2 份」「约 8 分」「易错」「今年新考」「样本不足」 */
  label: string
  /** 悬停（或键盘聚焦）时显示的白话解释，必填：每个标签都要让不懂行的人看得懂 */
  hint: string
  /** 样式：plain 普通 / mistake 易错（易错红）/ new 今年新考（词头蓝）/ thin 样本不足（虚线） */
  kind?: 'plain' | 'mistake' | 'new' | 'thin'
}

export function EntryTag({ label, hint, kind = 'plain' }: EntryTagSpec) {
  return (
    <Tooltip title={hint} placement="top" mouseEnterDelay={0.15}>
      <span className={`ewb-etag${kind === 'plain' ? '' : ' ewb-etag--' + kind}`} tabIndex={0} aria-label={`${label}。${hint}`}>{label}</span>
    </Tooltip>
  )
}

// ───────────── 原卷缩略图与放大 ─────────────

export interface EntrySource {
  /** 图片地址（ewb:// 原卷题目截图，或 data URL） */
  src: string
  /** 卷子名，如「四年级 2024–2025 期末」 */
  paper: string
  /** 题号，如 "7"（显示为「第 7 题」） */
  question: string
  /** 缩略图更高（两行以上的题目用） */
  tall?: boolean
  /** 自己处理点击（例如跳转到审核页）；不传则在原地放大 */
  onOpen?: () => void
}

/** 放大查看：深蓝布面上放一张白纸，Esc 或点击空白处关闭 */
export function Lightbox({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  const closeRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [onClose])
  return createPortal(
    <div className="ewb-lightbox" role="dialog" aria-modal="true" aria-label={caption} onClick={onClose}>
      <div className="ewb-lightbox__frame" onClick={e => e.stopPropagation()}>
        <div className="ewb-lightbox__bar">
          <span>{caption}</span>
          <Btn tone="secondary" icon={X} onClick={onClose} ref={closeRef}>关闭（Esc）</Btn>
        </div>
        <div className="ewb-sheet ewb-lightbox__sheet"><img src={src} alt={caption} /></div>
      </div>
    </div>,
    document.body
  )
}

export function SourceThumb({ src, paper, question, tall, onOpen }: EntrySource) {
  const [open, setOpen] = useState(false)
  const caption = `${paper} · 第 ${question} 题`
  return (
    <>
      <button type="button" className={`ewb-thumb-src${tall ? ' ewb-thumb-src--tall' : ''}`} onClick={() => (onOpen ? onOpen() : setOpen(true))} aria-label={`查看原卷：${caption}`}>
        <span className="ewb-sheet ewb-thumb-src__sheet" style={{ display: 'block' }}><img src={src} alt="" /></span>
        <span className="ewb-thumb-src__cap">{caption}</span>
      </button>
      {open && <Lightbox src={src} caption={caption} onClose={() => setOpen(false)} />}
    </>
  )
}

// ───────────── 词条 ─────────────

export interface EntrySeeAlso {
  /** 被参见的词条名，如「be 动词一般疑问句」 */
  term: string
  onClick?: () => void
}

export interface EntryProps {
  /** 词头：中文考点名，如「物主代词」 */
  term: string
  /** 斜体英文例词，如 ['my', 'your', 'his']，显示为「my · your · his」 */
  examples?: string[]
  /** 尺寸：compact 紧凑（列表）/ standard 标准（总览，默认）/ full 完整（详情抽屉） */
  size?: 'compact' | 'standard' | 'full'
  /** 知识大类：词头右侧显示一个带色块的小字（颜色旁边永远有字） */
  category?: CategoryKey
  /** 标签行。每个标签必须带白话解释 hint */
  tags?: EntryTagSpec[]
  /** 白话释义。数组表示多个义项，会标 ①②③ */
  plain?: string | string[]
  /** 例句。compact 不显示，standard 只显示第一条，full 全部显示 */
  examplesSentences?: EntryExample[]
  /** 原卷例题。compact 不显示，standard 只显示第一张，full 全部显示 */
  sources?: EntrySource[]
  /** 参见（standard 和 full 显示） */
  see?: EntrySeeAlso[]
  /** 词头右侧的附加内容，如「3/4 份 · 75%」 */
  aside?: React.ReactNode
  /** 词头和释义之间插入的内容（full 里放 <UsageNote>） */
  children?: React.ReactNode
  /** 底部操作区（带文字的按钮） */
  footer?: React.ReactNode
  /** 点击词头（打开详情）。不传则词头是纯文字 */
  onOpen?: () => void
  /** 当前选中（淡蓝底） */
  selected?: boolean
  /** 词头的标题级别，默认 3 */
  headingLevel?: 2 | 3 | 4
  id?: string
  'data-testid'?: string
}

const SENSE = ['①', '②', '③', '④', '⑤', '⑥']

export default function Entry({
  term, examples, size = 'standard', category, tags, plain, examplesSentences, sources, see, aside, children, footer, onOpen, selected, headingLevel = 3, id, ...rest
}: EntryProps) {
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const senses = plain === undefined ? [] : Array.isArray(plain) ? plain : [plain]
  const egs = examplesSentences ?? []
  const shownEgs = size === 'full' ? egs : size === 'standard' ? egs.slice(0, 1) : []
  const shownSrc = size === 'full' ? sources ?? [] : size === 'standard' ? (sources ?? []).slice(0, 1) : []
  const cat = category ? CATEGORY_BY_KEY[category] : null
  return (
    <article id={id} data-testid={rest['data-testid']} className={`ewb-entry ewb-entry--${size}${selected ? ' ewb-entry--selected' : ''}`}>
      <header className="ewb-entry__head">
        <H className="ewb-entry__term">{onOpen ? <button type="button" onClick={onOpen}>{term}</button> : term}</H>
        {examples && examples.length > 0 && <span className="ewb-entry__ex" lang="en">{examples.join(' · ')}</span>}
        <span className="ewb-entry__aside">
          {cat && <span className={`ewb-entry__cat ewb-cat-${cat.key}`}><i aria-hidden />{cat.label}</span>}
          {aside}
        </span>
      </header>
      {tags && tags.length > 0 && <ul className="ewb-entry__tags" aria-label="标签">{tags.map(t => <li key={t.label}><EntryTag {...t} /></li>)}</ul>}
      {children}
      {senses.length === 1 && <p className="ewb-entry__def">{senses[0]}</p>}
      {senses.length > 1 && (
        <ol className="ewb-entry__senses">
          {(size === 'compact' ? senses.slice(0, 1) : senses).map((s, i) => <li key={i}><span className="ewb-entry__sensenum" aria-hidden>{SENSE[i] ?? i + 1}</span><span>{s}</span></li>)}
        </ol>
      )}
      {shownEgs.length > 0 && <ul className="ewb-entry__egs">{shownEgs.map((e, i) => <li key={i}><Example {...e} /></li>)}</ul>}
      {shownSrc.length > 0 && (
        <section className="ewb-entry__src" aria-label="出自原卷">
          <h4 className="ewb-entry__src-title">出自原卷</h4>
          <div className="ewb-entry__src-list">{shownSrc.map((s, i) => <SourceThumb key={i} {...s} />)}</div>
        </section>
      )}
      {size !== 'compact' && see && see.length > 0 && (
        <p className="ewb-entry__see">
          <Icon as={ArrowRight} />参见
          {see.map(s => s.onClick ? <button key={s.term} type="button" onClick={s.onClick}>「{s.term}」</button> : <span key={s.term}>「{s.term}」</span>)}
        </p>
      )}
      {footer && <div className="ewb-entry__foot">{footer}</div>}
    </article>
  )
}
