/**
 * 终端里的 Markdown：把助手的回答拆成块（标题、段落、列表、引用、代码、表格、分隔线），行内拆成带样式的片段。
 * 纯函数，不依赖 Ink / electron，单测直接加载。渲染（上色、换行）在 app.tsx。
 * 回答里的引用标签 [[query:6]] / [[q:ID]] / [[lesson:ID]] 在终端里点不开，改成淡色的短标记。
 */

export interface Span { t: string; b?: boolean; i?: boolean; code?: boolean; dim?: boolean }

export type MdBlock =
  | { k: 'h'; level: number; spans: Span[] }
  | { k: 'p'; spans: Span[] }
  | { k: 'li'; depth: number; marker: string; spans: Span[] }
  | { k: 'quote'; spans: Span[] }
  | { k: 'code'; lang: string; lines: string[] }
  | { k: 'table'; header: string[]; rows: string[][]; align: Array<'l' | 'r' | 'c'> }
  | { k: 'hr' }

/** 一个字符占几列：中日韩全角、全角符号、emoji 占 2 列，组合符 / 零宽占 0 列 */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

/** 字符串在终端里占几列 */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0)!)
  return w
}

/** 截到最多 max 列（超出加省略号） */
export function clipWidth(s: string, max: number): string {
  if (textWidth(s) <= max) return s
  let w = 0, out = ''
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!)
    if (w + cw > max - 1) break
    out += ch; w += cw
  }
  return out + '…'
}

const padTo = (s: string, w: number, a: 'l' | 'r' | 'c'): string => {
  const gap = Math.max(0, w - textWidth(s))
  if (a === 'r') return ' '.repeat(gap) + s
  if (a === 'c') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l) }
  return s + ' '.repeat(gap)
}

/** 引用标签换成短标记 */
export function simplifyRefs(s: string): string {
  return s
    .replace(/\[\[query:(\d+)\]\]/g, '〔#$1〕')
    .replace(/\[\[q:[^\]]+\]\]/g, '〔题〕')
    .replace(/\[\[lesson:[^\]]+\]\]/g, '〔课〕')
    .replace(/\[\[stu:[^\]]+\]\]/g, '〔学员〕')
}

/** 行内：`代码`、**粗体**、*斜体*、[文字](网址)。不嵌套（粗体里的斜体当粗体） */
export function inlineSpans(src: string): Span[] {
  const s = simplifyRefs(src)
  const out: Span[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|〔[#题课学员\d]+〕/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: m[1], code: true })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: m[2] ?? m[3], b: true })
    else if (m[4] !== undefined) out.push({ t: m[4], i: true })
    else if (m[5] !== undefined) out.push({ t: m[5] }, { t: ` (${m[6]})`, dim: true })
    else out.push({ t: m[0], dim: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ t: s.slice(last) })
  return out
}

const splitRow = (line: string): string[] => {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map(c => c.trim())
}
const isSepRow = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let para: string[] = []
  const flush = (): void => { if (para.length) { out.push({ k: 'p', spans: inlineSpans(para.join(' ')) }); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      out.push({ k: 'code', lang: fence[1], lines: body })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { flush(); out.push({ k: 'h', level: h[1].length, spans: inlineSpans(h[2].replace(/\s*#+\s*$/, '')) }); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ k: 'hr' }); continue }
    // 表格：当前行像表头，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      flush()
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l') as 'l' | 'r' | 'c')
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      i--
      out.push({ k: 'table', header, rows: rows.map(r => header.map((_, c) => r[c] ?? '')), align: header.map((_, c) => align[c] ?? 'l') })
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const depth = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2))
      out.push({ k: 'li', depth, marker: /\d/.test(li[2]) ? li[2] : '•', spans: inlineSpans(li[3]) })
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) { flush(); out.push({ k: 'quote', spans: inlineSpans(q[1]) }); continue }
    para.push(line.trim())
  }
  flush()
  return out
}

/** 表格画成方框线。放不下（比 maxWidth 宽）返回 null，调用方改用「列名：值」逐行显示 */
export function tableLines(t: Extract<MdBlock, { k: 'table' }>, maxWidth: number): string[] | null {
  const cell = (s: string): string => inlineSpans(s).map(x => x.t).join('')
  const head = t.header.map(cell)
  const rows = t.rows.map(r => r.map(cell))
  const widths = head.map((h, c) => Math.max(textWidth(h), ...rows.map(r => textWidth(r[c] ?? '')), 1))
  const total = widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1
  if (total > maxWidth) return null
  const bar = (l: string, m: string, r: string): string => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r
  const row = (cells: string[]): string => '│' + widths.map((w, c) => ' ' + padTo(cells[c] ?? '', w, t.align[c] ?? 'l') + ' ').join('│') + '│'
  return [bar('┌', '┬', '┐'), row(head), bar('├', '┼', '┤'), ...rows.map(row), bar('└', '┴', '┘')]
}

/** 表格放不下时：每行一条「列名：值 · 列名：值」 */
export function tableFallback(t: Extract<MdBlock, { k: 'table' }>): string[] {
  const cell = (s: string): string => inlineSpans(s).map(x => x.t).join('')
  return t.rows.map(r => t.header.map((h, c) => `${cell(h)}：${cell(r[c] ?? '')}`).join(' · '))
}
