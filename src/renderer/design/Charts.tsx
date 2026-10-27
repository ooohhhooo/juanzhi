/**
 * 数据展示小件（纯 DOM，不依赖 ECharts，方便断言和打印）：
 * - <BarList>   词条横条图：条形用对应大类的颜色，条旁边永远写数字和文字；
 * - <HeatCell>  知识点 × 题型表里的热力格：单一主色的深浅，格子里写数字；
 * - <ReaderTag> AI 报告里「给谁看」的标签：每种读者一种拇指索引色。
 */
import React from 'react'
import { CATEGORY_BY_KEY, type CategoryKey } from './tokens'

export interface BarListRow {
  /** 词条名 */
  label: string
  /** 数值（决定条的长度） */
  value: number
  /** 数值旁边的文字，如「2/2 份 · 100%」 */
  note: string
  /** 条的颜色取自这个大类 */
  category: CategoryKey
  onClick?: () => void
}

export function BarList({ rows, max, label = '横条图' }: { rows: BarListRow[]; max?: number; label?: string }) {
  const top = max ?? Math.max(1e-9, ...rows.map(r => r.value))
  return (
    <ul className="ewb-bars" aria-label={label}>
      {rows.map(r => {
        const cat = CATEGORY_BY_KEY[r.category]
        return (
          <li key={r.label} className={`ewb-bars__row ewb-cat-${r.category}`}>
            {r.onClick ? <button type="button" className="ewb-bars__label" onClick={r.onClick}>{r.label}</button> : <span className="ewb-bars__label">{r.label}</span>}
            <span className="ewb-bars__track" aria-hidden><span className="ewb-bars__fill" style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} /></span>
            <span className="ewb-bars__note">{r.note}</span>
            <span className="ewb-bars__cat">{cat.label}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** 热力格：rate 0–1，背景是主色按比例混入画布色；文字始终是墨色，对比度够 */
export function HeatCell({ rate, children }: { rate: number; children: React.ReactNode }) {
  const pct = Math.round(Math.min(1, Math.max(0, rate)) * 55)
  return <span className="ewb-heat" style={{ background: `color-mix(in srgb, var(--ewb-primary) ${pct}%, var(--ewb-page))` }}>{children}</span>
}

export type Reader = 'boss' | 'parent' | 'teacher' | 'full'
const READERS: Record<Reader, { label: string; cat: CategoryKey }> = {
  boss: { label: '给老板', cat: 'writing' },
  parent: { label: '给家长', cat: 'vocab' },
  teacher: { label: '给老师', cat: 'communication' },
  full: { label: '完整数据', cat: 'grammar' }
}

export function ReaderTag({ reader }: { reader: Reader }) {
  const r = READERS[reader]
  return <span className={`ewb-reader ewb-cat-${r.cat}`}><i aria-hidden />{r.label}</span>
}
