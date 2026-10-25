/**
 * 题目定位：把模型给的 anchor 落到页面坐标，得到「从本题开头到下一题（或下一个大题标题）之前」的归一化 bbox。
 *
 * 文本版：anchor 是 OCR/文本层里的一段原文，用 anchor_ref（页-行）直接定位，退化为页内搜索、再退化为模糊匹配；
 *   一行里可能挤着几道题（"16. … 17. …"），所以起点精确到行内字符位置，再按字符比例折算横坐标。
 * 视觉版：anchor 是模型直接给的 [x,y,w,h]（题号+题干首行），向下延伸到下一题。
 * 纯函数，不依赖 electron。
 */
import type { Row } from './lines.ts'
import { squash, xAtOffset, approxFind } from './lines.ts'
import type { MergedQuestion, MergedSection } from './merge.ts'

export type Bbox = [number, number, number, number]

export interface PageGeom {
  idx: number
  rows: Row[]
}

export interface Start {
  page: number
  /** rows 数组下标 */
  row: number
  /** 起点在行文本里的字符下标 */
  offset: number
  /** 起点的横坐标（归一化） */
  x: number
  fuzzy: boolean
  /** 忽略游标重新扫描才找到的（可能是同一段文字的另一处） */
  rescan?: boolean
}

export interface LocateResult {
  page: number
  bbox: Bbox | null
  source: 'text-anchor' | 'vision' | 'none'
  flags: string[]
}

const PAD = 0.004
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function parseRef(ref: string): { page: number; row: number } | null {
  const m = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(ref || '')
  return m ? { page: Number(m[1]), row: Number(m[2]) } : null
}

function cmp(a: { page: number; row: number; offset: number }, b: { page: number; row: number; offset: number }): number {
  return a.page - b.page || a.row - b.row || a.offset - b.offset
}

function exactIn(row: Row, rowIdx: number, page: number, needle: string, afterOffset: number): Start | null {
  const hay = squash(row.text)
  let from = 0
  for (;;) {
    const at = hay.str.indexOf(needle, from)
    if (at < 0) return null
    const offset = hay.map[at]
    if (offset > afterOffset) return { page, row: rowIdx, offset, x: xAtOffset(row, offset), fuzzy: false }
    from = at + 1
  }
}

function fuzzyIn(row: Row, rowIdx: number, page: number, needle: string): { s: Start; edits: number } | null {
  if (needle.length < 6) return null
  const hay = squash(row.text)
  const m = approxFind(hay.str, needle, Math.floor(needle.length * 0.2))
  if (!m || hay.map.length === 0) return null
  const offset = hay.map[Math.min(m.start, hay.map.length - 1)]
  return { s: { page, row: rowIdx, offset, x: xAtOffset(row, offset), fuzzy: true }, edits: m.edits }
}

/** 文本版：依次为每题找起点；questions 必须按卷面顺序排列，找到的起点要求单调向后 */
export function locateTextStarts(questions: MergedQuestion[], pages: Map<number, PageGeom>): Array<Start | null> {
  const out: Array<Start | null> = []
  let cursor = { page: 0, row: -1, offset: -1 }
  const pageNos = [...pages.keys()].sort((a, b) => a - b)

  for (const q of questions) {
    if (q.mode !== 'text' || typeof q.anchor !== 'string') { out.push(null); continue }
    const needle = squash(q.anchor).str
    if (needle.length < 2) { out.push(null); continue }
    const ref = parseRef(q.anchor_ref)
    let found: Start | null = null
    let rescanned = false

    const rowAt = (page: number, rowNo: number) => {
      const g = pages.get(page)
      const i = g ? g.rows.findIndex(r => r.idx === rowNo) : -1
      return g && i >= 0 ? { row: g.rows[i], i } : null
    }

    // (a) anchor_ref 指的那一行里精确命中，且不在上一题之前
    let refHit: Start | null = null
    if (ref) {
      const r = rowAt(ref.page, ref.row)
      if (r) {
        const sameRow = cursor.page === ref.page && cursor.row === r.i
        refHit = exactIn(r.row, r.i, ref.page, needle, sameRow ? cursor.offset : -1)
        if (refHit && cmp(refHit, cursor) > 0) found = refHit
      }
    }

    // (b) 题目自己声明的页，然后其余页，从上一题起点往后精确搜索
    const order = [q.page, ...pageNos.filter(p => p !== q.page)]
    if (!found) {
      search: for (const p of order) {
        const g = pages.get(p)
        if (!g) continue
        for (let i = 0; i < g.rows.length; i++) {
          if (p < cursor.page || (p === cursor.page && i < cursor.row)) continue
          const after = p === cursor.page && i === cursor.row ? cursor.offset : -1
          const s = exactIn(g.rows[i], i, p, needle, after)
          if (s && cmp(s, cursor) > 0) { found = s; break search }
        }
      }
    }

    // (c) 上面都没有但 anchor_ref 那行有命中（可能模型给的顺序和卷面略有出入）
    if (!found && refHit) found = refHit

    // (c2) 游标可能被前面某道题的一次误判带到了后面：忽略游标，在声明页里从头精确找。
    //      找到也不让游标往回退，免得把前面已定位的题弄乱
    if (!found) {
      search2: for (const p of order) {
        const g = pages.get(p)
        if (!g) continue
        for (let i = 0; i < g.rows.length; i++) {
          const s = exactIn(g.rows[i], i, p, needle, -1)
          // 重新扫描可能命中同一段文字的另一处（两个大题里都有「1. What is this?」），所以标出来，让老师抽查
          if (s) { found = s; rescanned = true; break search2 }
        }
      }
    }

    // (d) 模糊匹配：先 anchor_ref 那行，再声明页里从上一题往后的行
    if (!found) {
      let best: { s: Start; edits: number } | null = null
      const tryFuzzy = (page: number, i: number) => {
        const g = pages.get(page)
        if (!g || !g.rows[i]) return
        const r = fuzzyIn(g.rows[i], i, page, needle)
        if (r && (!best || r.edits < best.edits)) best = r
      }
      if (ref) { const r = rowAt(ref.page, ref.row); if (r) tryFuzzy(ref.page, r.i) }
      if (!best) {
        const g = pages.get(q.page)
        if (g) for (let i = 0; i < g.rows.length; i++) if (q.page > cursor.page || i >= cursor.row) tryFuzzy(q.page, i)
      }
      if (best) found = (best as { s: Start }).s
    }

    if (found && rescanned) found = { ...found, rescan: true }
    out.push(found)
    if (found && cmp(found, cursor) > 0) cursor = { page: found.page, row: found.row, offset: found.offset }
  }
  return out
}

function headingRowIndexes(g: PageGeom, sections: MergedSection[], exceptNo: string): number[] {
  const hits: number[] = []
  const needles = sections
    .filter(s => s.no !== exceptNo)
    .map(s => squash(s.title).str.slice(0, 8))
    .filter(n => n.length >= 3)
  g.rows.forEach((r, i) => {
    const t = squash(r.text).str
    if (needles.some(n => t.includes(n))) hits.push(i)
  })
  return hits
}

/** 由起点算 bbox：本题起点 → 下一题起点（同页）/ 下一个大题标题 / 页面末行 */
export function boxFromStart(
  qi: number, questions: MergedQuestion[], starts: Array<Start | null>,
  pages: Map<number, PageGeom>, sections: MergedSection[]
): Bbox | null {
  const s = starts[qi]
  if (!s) return null
  const g = pages.get(s.page)
  if (!g || g.rows.length === 0 || !g.rows[s.row].hasCoords) return null
  const rows = g.rows

  // 下一道已定位且在同一页、位置靠后的题
  let end: { row: number; offset: number; x: number } | null = null
  for (let j = qi + 1; j < starts.length; j++) {
    const n = starts[j]
    if (n && n.page === s.page && cmp(n, s) > 0) { end = { row: n.row, offset: n.offset, x: n.x }; break }
    if (n && n.page !== s.page) break
  }
  // 起点之后出现的别的大题标题也是边界
  const headings = headingRowIndexes(g, sections, questions[qi].section).filter(i => i > s.row)
  if (headings.length && (!end || headings[0] <= end.row)) end = { row: headings[0], offset: 0, x: rows[headings[0]].x }

  const pieces: Array<[number, number, number, number]> = [] // x0, y0, x1, y1
  const addRow = (r: Row, x0: number, x1: number) => pieces.push([x0, r.y, x1, r.y + r.h])
  const right = (r: Row) => r.x + r.w

  if (end && end.row === s.row) {
    // 同一行里挤着多道题：只取起点到下一题起点之间
    addRow(rows[s.row], s.x, Math.max(end.x, s.x + 0.02))
  } else {
    addRow(rows[s.row], s.x, right(rows[s.row]))
    const last = end ? (end.offset > 6 ? end.row : end.row - 1) : rows.length - 1
    for (let i = s.row + 1; i <= last && i < rows.length; i++) {
      if (!rows[i].hasCoords) continue
      if (end && i === end.row) addRow(rows[i], rows[i].x, Math.max(end.x, rows[i].x + 0.02))
      else addRow(rows[i], rows[i].x, right(rows[i]))
    }
  }

  const x0 = Math.min(...pieces.map(p => p[0])) - PAD
  const y0 = Math.min(...pieces.map(p => p[1])) - PAD
  const x1 = Math.max(...pieces.map(p => p[2])) + PAD
  const y1 = Math.max(...pieces.map(p => p[3])) + PAD
  const bx = clamp01(x0), by = clamp01(y0)
  return [round3(bx), round3(by), round3(clamp01(x1) - bx), round3(clamp01(y1) - by)]
}

/** 视觉版：anchor 框住「题号+题干首行」；向下延伸到同页下一题的顶部，最后一题给一个保守的高度 */
export function boxFromVision(qi: number, questions: MergedQuestion[]): Bbox | null {
  const a = questions[qi].anchor
  if (!Array.isArray(a)) return null
  const [ax, ay, aw, ah] = a
  let bottom = Math.min(0.98, ay + Math.max(ah * 3, 0.1))
  let right = Math.min(0.98, Math.max(ax + aw + 0.02, 0.5))
  for (let j = qi + 1; j < questions.length; j++) {
    const n = questions[j]
    if (n.mode !== 'vision' || !Array.isArray(n.anchor) || n.page !== questions[qi].page) continue
    const [nx, ny, , nh] = n.anchor
    if (Math.abs(ny - ay) < Math.max(ah, nh) * 0.6 && nx > ax) {
      // 同一行里的下一题：只取到它的左边
      right = Math.max(ax + 0.03, nx - 0.005)
      bottom = Math.min(bottom, ay + Math.max(ah, nh) + PAD)
    } else if (ny > ay) {
      bottom = ny - PAD
    }
    break
  }
  const x0 = clamp01(ax - 0.01), y0 = clamp01(ay - PAD)
  const w = Math.max(0.03, clamp01(right) - x0)
  const h = Math.max(ah, clamp01(bottom) - y0)
  return [round3(x0), round3(y0), round3(Math.min(w, 1 - x0)), round3(Math.min(h, 1 - y0))]
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** 一次性定位所有题，返回与 questions 对齐的结果 */
export function locateAll(questions: MergedQuestion[], sections: MergedSection[], pages: Map<number, PageGeom>): LocateResult[] {
  const starts = locateTextStarts(questions, pages)
  return questions.map((q, i) => {
    if (q.mode === 'vision') {
      const bbox = boxFromVision(i, questions)
      const flags = bbox ? [] : ['locate_failed']
      return { page: q.page, bbox, source: bbox ? 'vision' : 'none', flags } satisfies LocateResult
    }
    const s = starts[i]
    if (!s) return { page: q.page, bbox: null, source: 'none', flags: ['locate_failed'] } satisfies LocateResult
    const bbox = boxFromStart(i, questions, starts, pages, sections)
    const flags = s.fuzzy ? ['locate_fuzzy'] : s.rescan ? ['locate_rescan'] : []
    return { page: s.page, bbox, source: bbox ? 'text-anchor' : 'none', flags } satisfies LocateResult
  })
}
