/**
 * 输入框的编辑逻辑（多行文本 + 光标）。纯函数，光标按「字」（码点）计，单测直接加载。
 */
import { textWidth } from './markdown.ts'

export interface Ed { text: string; cur: number }

const chars = (s: string): string[] => [...s]
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

export const empty = (): Ed => ({ text: '', cur: 0 })
export const fromText = (text: string): Ed => ({ text, cur: chars(text).length })

export function insert(e: Ed, s: string): Ed {
  const c = chars(e.text)
  const add = chars(s.replace(/\r\n?/g, '\n'))
  c.splice(e.cur, 0, ...add)
  return { text: c.join(''), cur: e.cur + add.length }
}
export function backspace(e: Ed): Ed {
  if (e.cur === 0) return e
  const c = chars(e.text); c.splice(e.cur - 1, 1)
  return { text: c.join(''), cur: e.cur - 1 }
}
export function del(e: Ed): Ed {
  const c = chars(e.text)
  if (e.cur >= c.length) return e
  c.splice(e.cur, 1)
  return { text: c.join(''), cur: e.cur }
}
export const left = (e: Ed): Ed => ({ ...e, cur: Math.max(0, e.cur - 1) })
export const right = (e: Ed): Ed => ({ ...e, cur: Math.min(chars(e.text).length, e.cur + 1) })

/** 行首 / 行尾（当前行） */
export function lineStart(e: Ed): Ed {
  const c = chars(e.text); let i = e.cur
  while (i > 0 && c[i - 1] !== '\n') i--
  return { ...e, cur: i }
}
export function lineEnd(e: Ed): Ed {
  const c = chars(e.text); let i = e.cur
  while (i < c.length && c[i] !== '\n') i++
  return { ...e, cur: i }
}
/** Ctrl+U：删到行首 */
export function killToStart(e: Ed): Ed {
  const s = lineStart(e).cur
  const c = chars(e.text); c.splice(s, e.cur - s)
  return { text: c.join(''), cur: s }
}
/** Ctrl+K：删到行尾 */
export function killToEnd(e: Ed): Ed {
  const t = lineEnd(e).cur
  const c = chars(e.text); c.splice(e.cur, t - e.cur)
  return { text: c.join(''), cur: e.cur }
}
/** Ctrl+W：删前一个词（中文没有空格，退到上一个空白或标点） */
export function deleteWord(e: Ed): Ed {
  const c = chars(e.text); let i = e.cur
  while (i > 0 && /\s/.test(c[i - 1])) i--
  while (i > 0 && !/[\s，。、；：！？,.;:!?]/.test(c[i - 1])) i--
  c.splice(i, e.cur - i)
  return { text: c.join(''), cur: i }
}

export interface Pos { row: number; col: number; lines: string[] }
export function posOf(e: Ed): Pos {
  const lines = e.text.split('\n')
  let n = e.cur
  for (let r = 0; r < lines.length; r++) {
    const len = chars(lines[r]).length
    if (n <= len) return { row: r, col: n, lines }
    n -= len + 1
  }
  const last = lines.length - 1
  return { row: last, col: chars(lines[last]).length, lines }
}
const offsetOf = (lines: string[], row: number, col: number): number => {
  let n = 0
  for (let r = 0; r < row; r++) n += chars(lines[r]).length + 1
  return n + col
}

/** 上移一行（尽量保持显示列）；已经在第一行返回 null（调用方改翻历史） */
export function up(e: Ed): Ed | null {
  const p = posOf(e)
  if (p.row === 0) return null
  return { ...e, cur: offsetOf(p.lines, p.row - 1, colForWidth(p.lines[p.row - 1], textWidth(chars(p.lines[p.row]).slice(0, p.col).join('')))) }
}
export function down(e: Ed): Ed | null {
  const p = posOf(e)
  if (p.row >= p.lines.length - 1) return null
  return { ...e, cur: offsetOf(p.lines, p.row + 1, colForWidth(p.lines[p.row + 1], textWidth(chars(p.lines[p.row]).slice(0, p.col).join('')))) }
}
function colForWidth(line: string, w: number): number {
  let acc = 0, i = 0
  for (const ch of line) { const cw = textWidth(ch); if (acc + cw > w) break; acc += cw; i++ }
  return clamp(i, 0, chars(line).length)
}

/** 画输入框用：每行拆成「光标前 / 光标处的字 / 光标后」；不是光标所在行 cursor 为 null */
export function viewLines(e: Ed): Array<{ before: string; at: string; after: string } | { plain: string }> {
  const p = posOf(e)
  return p.lines.map((l, r) => {
    if (r !== p.row) return { plain: l }
    const c = chars(l)
    return { before: c.slice(0, p.col).join(''), at: c[p.col] ?? ' ', after: c.slice(p.col + 1).join('') }
  })
}
