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

/** 一页拆成上下两半识别时，本批只管这一页的哪一部分 */
export type PagePart =
  /** 视觉：图片按高度裁，y0–y1 是 0–1 的比例 */
  | { kind: 'image'; y0: number; y1: number; label: '上半部分' | '下半部分' }
  /** 文字：rows 数组下标 [from, to)（行号 idx 不变，所以 anchor_ref 仍然对得上） */
  | { kind: 'rows'; from: number; to: number; label: '上半部分' | '下半部分' }

export interface Batch {
  mode: Mode
  pages: number[]
  /** 只有「单页写不完、拆成上下两半」时才有 */
  part?: PagePart
}

/** 拆半时两半之间的重叠比例（避免正好切在一道题中间时丢内容） */
export const SPLIT_OVERLAP = 0.08

/**
 * 单页写不完、加大上限后仍被截断：把这一页拆成上下两半（图片按高度切，留约 8% 重叠；文字页按行对半，重叠几行）。
 * 重叠处同一道题被两半各识别一次时，由 mergeBatch 按（大题, 题号）去重，保留先出现的（跨半页被切断的题按续写合并）。
 * 已经是半页、或页面没法再拆（文字页不到 2 行）时返回 null。
 */
export function splitPageBatch(b: Batch, input: PageInput | undefined): [Batch, Batch] | null {
  if (b.pages.length !== 1 || b.part) return null
  const half = SPLIT_OVERLAP / 2
  if (b.mode === 'vision') {
    return [
      { mode: b.mode, pages: b.pages, part: { kind: 'image', y0: 0, y1: 0.5 + half, label: '上半部分' } },
      { mode: b.mode, pages: b.pages, part: { kind: 'image', y0: 0.5 - half, y1: 1, label: '下半部分' } }
    ]
  }
  const n = input?.rows.length ?? 0
  if (n < 2) return null
  const mid = Math.ceil(n / 2)
  const ov = Math.max(1, Math.round(n * half))
  return [
    { mode: b.mode, pages: b.pages, part: { kind: 'rows', from: 0, to: Math.min(n, mid + ov), label: '上半部分' } },
    { mode: b.mode, pages: b.pages, part: { kind: 'rows', from: Math.max(0, mid - ov), to: n, label: '下半部分' } }
  ]
}

/** 半页识别出的位置框（相对裁出来的那块）换算回整页 */
export function remapAnchor(a: [number, number, number, number], part: PagePart | undefined): [number, number, number, number] {
  if (!part || part.kind !== 'image') return a
  const k = part.y1 - part.y0
  const c = (v: number) => Math.min(1, Math.max(0, v))
  return [a[0], c(part.y0 + a[1] * k), a[2], c(a[3] * k)]
}

/** 给提示词看的一句话：本批只是这一页的哪一部分 */
export function partNote(part: PagePart | undefined): string {
  if (!part) return ''
  return part.kind === 'image'
    ? `；注意：这一页内容太多，已拆成上下两半，本批只是该页的${part.label}（图片已裁切，位置框 anchor 请相对这张裁切后的图片；图片边缘处被切断的题请标记 continues_next / continued_from_prev，与另一半重叠的部分照常识别即可）`
    : `；注意：这一页内容太多，已拆成上下两半，本批只是该页的${part.label}（只给了其中一部分行；两半之间有几行重叠，重叠的题照常识别即可）`
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

export function ocrTextFor(pages: PageInput[], idxs: number[], part?: PagePart): string {
  return idxs.map(i => {
    const p = pages.find(x => x.idx === i)
    if (!p) return ''
    return formatRows(p.idx, part?.kind === 'rows' ? p.rows.slice(part.from, part.to) : p.rows)
  }).filter(Boolean).join('\n')
}

function pageRange(idxs: number[]): string {
  return idxs.length === 1 ? `第 ${idxs[0]} 页` : `第 ${idxs[0]}–${idxs[idxs.length - 1]} 页`
}

export function batchInfoText(opts: { seq: number; total: number | null; pages: number[]; pageCount: number; part?: PagePart }): string {
  const head = opts.total ? `第 ${opts.seq}/${opts.total} 批` : `第 ${opts.seq} 批（内容较多，已拆小）`
  return `${head}，本批为试卷${pageRange(opts.pages)}（全卷共 ${opts.pageCount} 页）${partNote(opts.part)}`
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
