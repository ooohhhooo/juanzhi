/**
 * 把一页的文本行整理成「行」（Row）：喂给模型的 `[页-行]文字` 与后面按 anchor 定位 bbox 都以它为准。
 *
 * 为什么不直接用 lines_json：
 *  - macOS Vision OCR 返回的行顺序不可靠（实测 `_. It's cold` 排在 13 题之后）、同一行文字常被切成几段；
 *  - pdf.js 文本层会输出康熙部首（⼆ ⼀ ⾳）这类兼容字符，模型看到的和用户看到的不一样；
 * 所以：按 (y, x) 重新排序，把同一水平线上的碎片并成一行，并把部首字符归一成普通汉字。
 * 纯函数、不依赖 electron，供单元测试直接加载。
 */

export interface RawLine {
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 行内某一段碎片：start/end 是它在 Row.text 里的字符区间，x/w 是它在页面上的归一化横坐标 */
export interface PartSpan {
  start: number
  end: number
  x: number
  w: number
}

export interface Row {
  /** 1 起的行号，即提示词里 `[页-行]` 的行 */
  idx: number
  text: string
  x: number
  y: number
  w: number
  h: number
  parts: PartSpan[]
  /** false：没有真实坐标（docx、只有文本层字符串的页），不能据此画框 */
  hasCoords: boolean
}

/** 康熙部首 / CJK 部首补充区的字符 NFKC 归一成普通汉字；其余字符（含全角标点）保持原样 */
export function normalizeText(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if ((c >= 0x2e80 && c <= 0x2eff) || (c >= 0x2f00 && c <= 0x2fdf)) out += ch.normalize('NFKC')
    else if (c === 0xa0 || c === 0x3000) out += ' '
    else if (c < 0x20 && c !== 0x0a && c !== 0x09) out += ''
    else if (c === 0x200b || c === 0xfeff) out += ''
    else out += ch
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

const CJK = /[㐀-鿿＀-￯　-〿]/

function joinFragment(prev: string, next: string): string {
  if (!prev) return next
  const a = prev[prev.length - 1]
  const b = next[0]
  return CJK.test(a) && CJK.test(b) ? prev + next : prev + ' ' + next
}

/** 带真实坐标的行 → 重排并合并后的 Row */
export function buildRows(lines: RawLine[]): Row[] {
  const items = lines
    .map(l => ({ ...l, text: normalizeText(l.text) }))
    .filter(l => l.text && l.w > 0 && l.h > 0)
    .sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x)

  const groups: Array<{ yc: number; h: number; items: typeof items }> = []
  for (const it of items) {
    const yc = it.y + it.h / 2
    const g = groups[groups.length - 1]
    if (g && Math.abs(yc - g.yc) <= 0.6 * Math.max(g.h, it.h)) {
      g.items.push(it)
      g.yc = g.items.reduce((s, i) => s + i.y + i.h / 2, 0) / g.items.length
      g.h = Math.max(g.h, it.h)
    } else {
      groups.push({ yc, h: it.h, items: [it] })
    }
  }

  return groups.map((g, i) => {
    const sorted = g.items.slice().sort((a, b) => a.x - b.x)
    let text = ''
    const parts: PartSpan[] = []
    for (const it of sorted) {
      const joined = joinFragment(text, it.text)
      const start = joined.length - it.text.length
      parts.push({ start, end: joined.length, x: it.x, w: it.w })
      text = joined
    }
    const x0 = Math.min(...sorted.map(s => s.x))
    const x1 = Math.max(...sorted.map(s => s.x + s.w))
    const y0 = Math.min(...sorted.map(s => s.y))
    const y1 = Math.max(...sorted.map(s => s.y + s.h))
    return { idx: i + 1, text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, parts, hasCoords: true }
  })
}

/** 没有坐标的页面（docx、仅有文本层字符串）：按换行切行，不造坐标 */
export function rowsFromPlainText(text: string): Row[] {
  const rows: Row[] = []
  for (const raw of text.split('\n')) {
    const t = normalizeText(raw)
    if (!t) continue
    rows.push({ idx: rows.length + 1, text: t, x: 0, y: 0, w: 0, h: 0, parts: [], hasCoords: false })
  }
  return rows
}

/** 行号 → `[页-行]文字` */
export function formatRows(pageIdx: number, rows: Row[]): string {
  return rows.map(r => `[${pageIdx}-${String(r.idx).padStart(2, '0')}]${r.text}`).join('\n')
}

/** 匹配用的压缩串：NFKC + 小写 + 去掉所有空白；map[i] = 压缩串第 i 个字符在原文里的下标 */
export function squash(s: string): { str: string; map: number[] } {
  let str = ''
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    const n = ch.normalize('NFKC').toLowerCase()
    for (const c of n) {
      if (!/\s/.test(c)) {
        str += c
        map.push(i)
      }
    }
    i += ch.length
  }
  return { str, map }
}

/**
 * 字符在比例字体里的大致宽度（单位任意，只看相对大小）：窄的 i l t f . , ' 、宽的 m w、全角汉字、等宽的下划线……
 * 一行里挤着两道题时（「16. Look at the ____ (sheep). 17. Those are …」），要靠它估计「17」从哪里开始；
 * 以前按字符个数平均，估计会偏几个字，截图的右边就会切进下一题的题号。
 */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!
  if (c >= 0x2e80) return 2
  if (ch === ' ') return 0.45
  if ('iljtfr.,;:\'!|()[]'.includes(ch)) return 0.34
  if ('mwMW'.includes(ch)) return 0.85
  if (ch === '_') return 0.55
  if (/[A-Z]/.test(ch)) return 0.66
  if (/[0-9]/.test(ch)) return 0.56
  if (ch === '-' ) return 0.36
  return 0.52
}

/** 压缩串里的位置 → 行内横坐标（归一化）；碎片内按字符的大致宽度插值（不再按个数平均） */
export function xAtOffset(row: Row, textOffset: number): number {
  if (!row.hasCoords || row.parts.length === 0) return row.x
  const part = row.parts.find(p => textOffset >= p.start && textOffset < p.end)
    ?? row.parts.reduce((best, p) => (Math.abs(p.start - textOffset) < Math.abs(best.start - textOffset) ? p : best), row.parts[0])
  const chars = [...row.text.slice(part.start, part.end)]
  if (chars.length === 0) return part.x
  const widths = chars.map(charWidth)
  const total = widths.reduce((a, b) => a + b, 0) || 1
  // textOffset 是 UTF-16 下标：按下标算已经过去了多少个字符
  const upto = Math.min(chars.length, Math.max(0, [...row.text.slice(part.start, Math.max(part.start, Math.min(part.end, textOffset)))].length))
  const frac = Math.min(1, Math.max(0, widths.slice(0, upto).reduce((a, b) => a + b, 0) / total))
  return part.x + part.w * frac
}

/** 近似子串匹配（Sellers）：返回编辑距离 ≤ maxEdits 的最佳匹配 {end, edits}，end 为 hay 中的结束下标（不含） */
export function approxFind(hay: string, needle: string, maxEdits: number): { start: number; end: number; edits: number } | null {
  const m = needle.length
  const n = hay.length
  if (m === 0 || n === 0) return null
  let prev = new Array<number>(m + 1)
  let cur = new Array<number>(m + 1)
  for (let i = 0; i <= m; i++) prev[i] = i
  // starts[j] 记录以当前列结尾的最优路径起点，用来估计 start
  let prevStart = new Array<number>(m + 1).fill(0)
  let curStart = new Array<number>(m + 1).fill(0)
  let best: { start: number; end: number; edits: number } | null = null
  for (let j = 1; j <= n; j++) {
    cur[0] = 0
    curStart[0] = j
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1)
      const del = prev[i] + 1      // hay 多一个字符
      const ins = cur[i - 1] + 1   // needle 多一个字符
      let v = sub
      let st = prevStart[i - 1]
      if (del < v) { v = del; st = prevStart[i] }
      if (ins < v) { v = ins; st = curStart[i - 1] }
      cur[i] = v
      curStart[i] = st
    }
    if (cur[m] <= maxEdits && (!best || cur[m] < best.edits)) best = { start: curStart[m], end: j, edits: cur[m] }
    ;[prev, cur] = [cur, prev]
    ;[prevStart, curStart] = [curStart, prevStart]
  }
  return best
}
