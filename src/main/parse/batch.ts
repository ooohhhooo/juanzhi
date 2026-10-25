/**
 * 把一份试卷切成批次，并填充提示词占位符。
 * 批次 = 同一输入方式（文本/视觉）下连续的若干页；长卷按页数与字数两个上限切，失败时可对半拆小。
 */
import type { Row } from './lines.ts'
import { formatRows } from './lines.ts'
import type { Mode } from './merge.ts'

export interface PageInput {
  idx: number
  /** 'skip'：空白页等，不发给模型 */
  mode: Mode | 'skip'
  rows: Row[]
  chars: number
  imageRel: string
}

export interface Batch {
  mode: Mode
  pages: number[]
}

export interface BatchLimits {
  maxPages: number
  maxChars: number
  maxVisionPages: number
}

export const DEFAULT_LIMITS: BatchLimits = { maxPages: 3, maxChars: 3000, maxVisionPages: 3 }

export function planBatches(pages: PageInput[], limits: BatchLimits = DEFAULT_LIMITS): Batch[] {
  const batches: Batch[] = []
  let cur: { mode: Mode; pages: number[]; chars: number } | null = null
  for (const p of pages) {
    if (p.mode === 'skip') continue
    const cap = p.mode === 'text' ? limits.maxPages : Math.min(limits.maxPages, limits.maxVisionPages)
    const fits = cur && cur.mode === p.mode && cur.pages.length < cap && (p.mode === 'vision' || cur.chars + p.chars <= limits.maxChars)
    if (cur && fits) {
      cur.pages.push(p.idx)
      cur.chars += p.chars
    } else {
      if (cur) batches.push({ mode: cur.mode, pages: cur.pages })
      cur = { mode: p.mode, pages: [p.idx], chars: p.chars }
    }
  }
  if (cur) batches.push({ mode: cur.mode, pages: cur.pages })
  return batches
}

/** 对半拆小；只有一页时无法再拆，返回 null */
export function halveBatch(b: Batch): [Batch, Batch] | null {
  if (b.pages.length < 2) return null
  const mid = Math.ceil(b.pages.length / 2)
  return [{ mode: b.mode, pages: b.pages.slice(0, mid) }, { mode: b.mode, pages: b.pages.slice(mid) }]
}

export function ocrTextFor(pages: PageInput[], idxs: number[]): string {
  return idxs.map(i => {
    const p = pages.find(x => x.idx === i)
    return p ? formatRows(p.idx, p.rows) : ''
  }).filter(Boolean).join('\n')
}

function pageRange(idxs: number[]): string {
  return idxs.length === 1 ? `第 ${idxs[0]} 页` : `第 ${idxs[0]}–${idxs[idxs.length - 1]} 页`
}

export function batchInfoText(opts: { seq: number; total: number | null; pages: number[]; pageCount: number }): string {
  const head = opts.total ? `第 ${opts.seq}/${opts.total} 批` : `第 ${opts.seq} 批（内容较多，已拆小）`
  return `${head}，本批为试卷${pageRange(opts.pages)}（全卷共 ${opts.pageCount} 页）`
}

export function pageListText(idxs: number[]): string {
  return `共 ${idxs.length} 张图，依次为试卷${idxs.map(i => `第 ${i}`).join('、')} 页`
}

/** 把 `{{NAME}}` 替换成值；未提供的占位符保持原样（便于在界面上发现提示词里写错了名字） */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

export function unknownPlaceholders(tpl: string, known: string[]): string[] {
  const found = new Set<string>()
  for (const m of tpl.matchAll(/\{\{([A-Z_]+)\}\}/g)) if (!known.includes(m[1])) found.add(m[1])
  return [...found]
}
