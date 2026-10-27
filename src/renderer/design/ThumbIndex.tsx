/**
 * 书口拇指索引 <ThumbIndex>：放在分析看板、总览、知识点相关页的右边缘。
 * 六个彩色竖向标签对应六个知识大类，每个标签显示中文名和考点数。当前项凸出 6px。
 * 点击后由调用方跳到该大类的词条组，或按该大类筛选；配合 <PageTurn> 得到「翻页」横向滑入。
 */
import React, { useRef } from 'react'
import { CATEGORIES, type CategoryKey } from './tokens'

export interface ThumbIndexItem {
  key: CategoryKey
  /** 该大类的考点（词条）数 */
  count: number
}

export interface ThumbIndexProps {
  /** 各大类的考点数。缺的大类显示为 0；顺序固定为 语音、词汇、语法、交际、阅读、写作 */
  counts: Partial<Record<CategoryKey, number>>
  /** 当前选中的大类；null / 不传表示都没选 */
  value?: CategoryKey | null
  onChange?: (key: CategoryKey) => void
  /** 贴在滚动区顶部（position: sticky），默认 true */
  sticky?: boolean
  /** 容器窄于约 1100px 时自动收成一排横向的色块（不裁掉）。放在版心（.ewb-page）里的页面用 */
  responsive?: boolean
  'aria-label'?: string
}

export default function ThumbIndex({ counts, value, onChange, sticky = true, responsive, ...rest }: ThumbIndexProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = (i + (e.key === 'ArrowDown' ? 1 : CATEGORIES.length - 1)) % CATEGORIES.length
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>('button[role=tab]')
    btns?.[next]?.focus()
    onChange?.(CATEGORIES[next].key)
  }
  return (
    <ul ref={listRef} className={`ewb-thumbs${sticky ? ' ewb-thumbs--sticky' : ''}${responsive ? ' ewb-thumbs--responsive' : ''}`} role="tablist" aria-orientation="vertical" aria-label={rest['aria-label'] ?? '知识大类'}>
      {CATEGORIES.map((c, i) => {
        const selected = value === c.key
        return (
          <li key={c.key}>
            <button type="button" role="tab" aria-selected={selected} tabIndex={selected || (value == null && i === 0) ? 0 : -1}
              className={`ewb-thumbtab ewb-cat-${c.key}`} data-category={c.key} onClick={() => onChange?.(c.key)} onKeyDown={e => onKey(e, i)}
              title={c.gloss}>
              <span className="ewb-thumbtab__name">{c.label}</span>
              <span className="ewb-thumbtab__count">{counts[c.key] ?? 0} 个</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 翻页：key 变化时内容像翻到词典的另一节，横向滑入 240ms 指数缓出。
 * 系统开启「减少动态效果」时直接切换（design.css 里有 prefers-reduced-motion 兜底）。
 * `order` 传当前大类在索引中的序号，用来判断往前翻还是往后翻。
 */
export function PageTurn({ pageKey, order = 0, children }: { pageKey: string; order?: number; children: React.ReactNode }) {
  const prev = useRef(order)
  const dir = order < prev.current ? 'back' : 'forward'
  prev.current = order
  return (
    <div className="ewb-turn-wrap">
      <div key={pageKey} className="ewb-turn" data-dir={dir}>{children}</div>
    </div>
  )
}
