/**
 * 极简 Markdown 解析（只覆盖 P2/P3 输出会用到的：标题、列表、引用块、表格、代码围栏、粗体、段落、分隔线），纯函数，单测直接跑。
 * 不执行任何 HTML：所有文字都按纯文本交给 React 渲染，所以模型输出里的 <script> 之类只是字面文字。
 */
import { splitCitations } from './citation.ts'

export type Inline = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'cite'; token: string }
export type Align = 'left' | 'center' | 'right' | null
export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'table'; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][] }
  | { type: 'quote'; lines: Inline[][] }
  | { type: 'p'; inline: Inline[] }
  | { type: 'hr' }

/** 普通文字里切出引用 */
function plain(text: string, out: Inline[]): void {
  for (const piece of splitCitations(text)) out.push(piece.type === 'cite' ? piece : { type: 'text', text: piece.text })
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  // 先按 **粗体** 切，再在每一段里切引用：模型常把引用包进粗体（**[卷名 · 3]**），不能让引用把粗体切断、露出字面的 **
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) {
    const i = m.index ?? 0
    if (i > last) plain(text.slice(last, i), out)
    for (const piece of splitCitations(m[1])) out.push(piece.type === 'cite' ? piece : { type: 'bold', text: piece.text })
    last = i + m[0].length
  }
  if (last < text.length) plain(text.slice(last), out)
  return out
}

/** 按竖线切表格的一行（去掉首尾的竖线；\| 是转义的竖线） */
export function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

const SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const alignOf = (c: string): Align => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null)

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join(' ')) }); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { flush(); continue }
    // 代码围栏：模型偶尔会用 ``` 包住整段输出或表格；按等宽文字原样显示，里面的内容不再解析
    const fence = /^```+\s*([\w-]*)\s*$/.exec(trimmed)
    if (fence) {
      flush()
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !/^```+\s*$/.test(lines[j].trim())) body.push(lines[j++])
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') })
      i = j
      continue
    }
    // 表格：一行带竖线 + 下一行是 |---|---| 分隔行
    if (trimmed.includes('|') && i + 1 < lines.length && SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      flush()
      const head = splitRow(trimmed)
      const aligns = splitRow(lines[i + 1]).map(alignOf)
      const rows: Inline[][][] = []
      let j = i + 2
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) { rows.push(splitRow(lines[j]).map(c => parseInline(c))); j++ }
      blocks.push({ type: 'table', header: head.map(c => parseInline(c)), align: head.map((_, k) => aligns[k] ?? null), rows })
      i = j - 1
      continue
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed)
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); continue }
    if (/^([-*_])\1{2,}$/.test(trimmed)) { flush(); blocks.push({ type: 'hr' }); continue }
    if (/^>\s?/.test(trimmed)) {
      flush()
      const last = blocks[blocks.length - 1]
      const content = parseInline(trimmed.replace(/^>\s?/, ''))
      if (last && last.type === 'quote') last.lines.push(content)
      else blocks.push({ type: 'quote', lines: [content] })
      continue
    }
    const ul = /^[-*+]\s+(.+)$/.exec(trimmed)
    const ol = /^\d+[.、)]\s*(.+)$/.exec(trimmed)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      const last = blocks[blocks.length - 1]
      const item = parseInline((ul ?? ol)![1])
      if (last && last.type === kind) last.items.push(item)
      else blocks.push({ type: kind, items: [item] })
      continue
    }
    // 列表项下缩进的续行并入上一项
    if (/^\s+\S/.test(line)) {
      const last = blocks[blocks.length - 1]
      if (last && (last.type === 'ul' || last.type === 'ol') && para.length === 0) {
        last.items[last.items.length - 1].push(...parseInline(' ' + trimmed))
        continue
      }
    }
    // 每个非空行单独成段：提示词要求「每章固定三行：**结论** / **依据** / **建议**」，按标准 Markdown 把相邻行并成一段会让三行挤在一起
    blocks.push({ type: 'p', inline: parseInline(trimmed) })
  }
  flush()
  return blocks
}

/** 取出 `### 代码｜名称` 对应的小节（到下一个 ## / ### 为止），没有则返回 null */
export function sectionFor(md: string, code: string): string | null {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const head = (l: string) => /^###\s+(.+?)\s*[｜|]/.exec(l.trim())?.[1]?.replace(/[`*]/g, '').trim()
  const start = lines.findIndex(l => head(l) === code)
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i].trim())) { end = i; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

/** 文中所有 `### 代码｜名称` 小节的代码 */
export function headingCodes(md: string): string[] {
  const out: string[] = []
  for (const l of md.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^###\s+(.+?)\s*[｜|]/.exec(l.trim())
    if (m) out.push(m[1].replace(/[`*]/g, '').trim())   // 模型有时把代码写成 `CODE` 或 **CODE**
  }
  return out
}
