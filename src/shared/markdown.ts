/**
 * 极简 Markdown 解析（只覆盖 P2/P3 输出会用到的：标题、列表、引用块、粗体、段落、分隔线），纯函数，单测直接跑。
 * 不执行任何 HTML：所有文字都按纯文本交给 React 渲染，所以模型输出里的 <script> 之类只是字面文字。
 */
import { splitCitations } from './citation.ts'

export type Inline = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'cite'; token: string }
export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][] }
  | { type: 'quote'; lines: Inline[][] }
  | { type: 'p'; inline: Inline[] }
  | { type: 'hr' }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  for (const piece of splitCitations(text)) {
    if (piece.type === 'cite') { out.push(piece); continue }
    let last = 0
    for (const m of piece.text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
      const i = m.index ?? 0
      if (i > last) out.push({ type: 'text', text: piece.text.slice(last, i) })
      out.push({ type: 'bold', text: m[1] })
      last = i + m[0].length
    }
    if (last < piece.text.length) out.push({ type: 'text', text: piece.text.slice(last) })
  }
  return out
}

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join(' ')) }); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { flush(); continue }
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
    para.push(trimmed)
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
