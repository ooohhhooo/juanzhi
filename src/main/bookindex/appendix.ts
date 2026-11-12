/**
 * 书库：解析书后附录（纯函数）。
 * 英语：按单元排列的单词表（Words in each unit）和句型表（Useful expressions），每条带书上印的页码。
 * 语文：识字表、写字表、词语表（按课文号），课文号再对到单元。
 * 附录是书里印好的，程序直接读，不让 AI 参与，所以是最可靠的数据源。
 */
import type { PageIn, Structure } from './structure.ts'

export type AppendixKind = 'word' | 'sentence' | 'char-read' | 'char-write' | 'phrase'
export interface AppendixItem {
  kind: AppendixKind
  text: string
  gloss: string
  unitKey: string | null
  /** 书上印的页码（附录里 p.5 这种）；语文没有 */
  printedRef: number | null
  /** 换算成 PDF 页（换算不了 = null） */
  pdfRef: number | null
  /** 这一条在 PDF 的哪一页（附录页） */
  appPage: number
  lessonNo: number | null
}

const CJK = /[㐀-鿿]/
const JUNK = /^(appendix\s*\d*|words in each unit|vocabulary|useful expressions|proverbs|songs in each unit|单元词汇表|词汇表|常用表达法|谚语|歌曲)$/i
const NOTE = /^[（(]注[:：]/
const PAGE_REF = /\bp\.\s*(\d{1,3})\s*$/i

type Mode = 'words' | 'sentences' | 'skip'
function modeOfTitle(title: string): Mode {
  const t = title.toLowerCase()
  if (/words in each unit|单元词汇/.test(t)) return 'words'
  if (/useful expressions|常用表达/.test(t)) return 'sentences'
  return 'skip'
}

/** “eraser () 橡皮” → { text: 'eraser', gloss: '橡皮' }；音标被字体吃掉后留下的 // 和 () 清掉 */
export function splitWordEntry(entry: string): { text: string; gloss: string } | null {
  const e = entry.replace(PAGE_REF, '').replace(/\s+/g, ' ').trim()
  const cut = e.search(/[㐀-鿿/]/)
  let en = (cut < 0 ? e : e.slice(0, cut)).replace(/[(\uff08]\s*[)\uff09]/g, '').replace(/\s+/g, ' ').trim()
  let gloss = (cut < 0 ? '' : e.slice(cut)).replace(/^\/[^/]*\//, '').replace(/^\/+/, '').replace(/[(\uff08]\s*[)\uff09]/g, '').trim()
  en = en.replace(/[\s,;]+$/, '').trim()
  // 释义异常长：多半是文字识别把相邻几条读成了一行，宁可丢掉也不存乱的
  if (!/[a-z]/i.test(en) || en.length > 40 || gloss.length > 50) return null
  return { text: en, gloss }
}

export function parseEnglishAppendix(pages: PageIn[], st: Structure): AppendixItem[] {
  const out: AppendixItem[] = []
  if (st.appendixStart == null) return out
  const modes = new Map<number, Mode>()
  for (const a of st.appendixTitles) { const m = /(\d+)/.exec(a.key); if (m) modes.set(Number(m[1]), modeOfTitle(a.title)) }
  // 目录里没有（或没读出来）附录标题时，看附录页自己：“Appendix N” 后面几行里有没有 “Words in each unit / Useful expressions”
  for (const p of pages) {
    if (p.page < st.appendixStart || st.kinds[p.page - 1] !== 'appendix') continue
    p.lines.forEach((l, i) => {
      const ap = /^appendix\s*(\d{1,2})\b(.*)$/i.exec(l.trim())
      if (!ap || modes.has(Number(ap[1]))) return
      const near = [ap[2], ...p.lines.slice(i + 1, i + 3)].map(modeOfTitle).find(m => m !== 'skip')
      if (near) modes.set(Number(ap[1]), near)
    })
  }
  if (![...modes.values()].some(m => m !== 'skip')) return out
  const off = st.offset
  const toPdf = (pr: number | null) => (pr != null && off != null && pr + off >= 1 && pr + off <= pages.length ? pr + off : null)
  let mode: Mode = 'skip'
  let curApp = -1
  let unit: string | null = null
  let buf: string[] = []
  let gl: string[] = []
  for (const p of pages) {
    if (p.page < st.appendixStart || st.kinds[p.page - 1] !== 'appendix') continue
    let seenAp = false   // 一页里只认第一个“Appendix N”（有的版式一页顶上连印两个）
    for (const raw of p.lines) {
      const line = raw.trim()
      const ap = /^appendix\s*(\d{1,2})\b/i.exec(line)
      if (ap && seenAp) continue
      if (ap) {
        seenAp = true
        const nm = modes.get(Number(ap[1])) ?? 'skip'; if (Number(ap[1]) !== curApp && nm !== mode) { unit = null; curApp = Number(ap[1]) } mode = nm; buf = []; gl = []; const after = line.replace(/^appendix\s*\d+\s*[:：]?\s*/i, ''); if (after) { const m2 = modeOfTitle(after); if (m2 !== 'skip') mode = m2 } continue }
      if (JUNK.test(line)) {
        const m2 = modeOfTitle(line)
        // 标题印在页尾的版式（Useful expressions 在上一页末尾）：只在没有附录号时才靠它切换
        if (m2 !== 'skip' && mode === 'skip') mode = m2
        continue
      }
      if (mode === 'skip' || NOTE.test(line) || /^\d{1,3}$/.test(line)) continue
      const um = /^unit\s*(\d{1,2})\s*$/i.exec(line)
      if (um) { unit = `unit:${um[1]}`; buf = []; gl = []; continue }
      if (/^recycle\s*(\d)/i.test(line) && !CJK.test(line)) { unit = `recycle:${/(\d)/.exec(line)![1]}`; buf = []; continue }
      if (mode === 'words') {
        buf.push(line)
        const pm = PAGE_REF.exec(line)
        if (pm) {
          const w = splitWordEntry(buf.join(' '))
          buf = []
          if (w) out.push({ kind: 'word', ...w, unitKey: unit, printedRef: Number(pm[1]), pdfRef: toPdf(Number(pm[1])), appPage: p.page, lessonNo: null })
        }
      } else {
        if (CJK.test(line)) {
          gl.push(line)
          const pm = PAGE_REF.exec(line)
          if (pm && buf.length) {
            const text = buf.join(' ').replace(/\s+/g, ' ').trim()
            out.push({ kind: 'sentence', text, gloss: gl.join('').replace(PAGE_REF, '').trim(), unitKey: unit, printedRef: Number(pm[1]), pdfRef: toPdf(Number(pm[1])), appPage: p.page, lessonNo: null })
            buf = []; gl = []
          } else if (pm) gl = []
        } else buf.push(line)
      }
    }
  }
  return out
}

// ───────────────────────── 语文 ─────────────────────────

const clean = (s: string) => s.replace(/语文园地/g, '').replace(/[.．·。\s]+/g, ' ').trim()

export function parseChineseAppendix(pages: PageIn[], st: Structure): AppendixItem[] {
  const out: AppendixItem[] = []
  if (st.appendixStart == null) return out
  // 课文号 → 单元 / 课文所在页
  const lessonUnit = new Map<number, { unit: string; page: number }>()
  for (const u of st.units) for (const s of u.sections) if (s.lessonNo != null) lessonUnit.set(s.lessonNo, { unit: u.key, page: s.page })
  let mode: 'read' | 'write' | 'phrase' | null = null
  let lesson: number | null = null
  const push = (kind: AppendixKind, text: string, appPage: number) => {
    const lu = lesson != null ? lessonUnit.get(lesson) : undefined
    out.push({ kind, text, gloss: lesson != null ? `第 ${lesson} 课` : '', unitKey: lu?.unit ?? null, printedRef: null, pdfRef: lu?.page ?? null, appPage, lessonNo: lesson })
  }
  for (const p of pages) {
    if (p.page < st.appendixStart || st.kinds[p.page - 1] !== 'appendix') continue
    for (const raw of p.lines) {
      const flat = raw.replace(/\s+/g, '')
      if (flat === '识字表') { mode = 'read'; lesson = null; continue }
      if (flat === '写字表') { mode = 'write'; lesson = null; continue }
      if (flat === '词语表') { mode = 'phrase'; lesson = null; continue }
      if (!mode || /^\d{1,3}$/.test(flat) || /共\d+个|蓝色的字|后记/.test(flat)) continue
      const lm = /^[.．·\s]*(\d{1,2})\s*[.．]\s*(.*)$/.exec(raw.trim())
      let rest = raw
      if (lm && Number(lm[1]) >= 1 && Number(lm[1]) <= 60) { lesson = Number(lm[1]); rest = lm[2] }
      else if (mode === 'write') {
        const wm = /^[.．·\s]*(\d{1,2})\s*[.．]\s*[.．\s]*(.*)$/.exec(raw.trim())
        if (wm) { lesson = Number(wm[1]); rest = wm[2] }
      }
      if (lesson == null) continue
      const body = clean(rest)
      if (!body) continue
      if (mode === 'phrase') { for (const w of body.split(' ')) if (w && CJK.test(w) && w.length <= 8) push('phrase', w, p.page) }
      else for (const ch of body.replace(/\s/g, '')) if (CJK.test(ch)) push(mode === 'read' ? 'char-read' : 'char-write', ch, p.page)
    }
  }
  return out
}

export function parseAppendix(pages: PageIn[], st: Structure): AppendixItem[] {
  const en = parseEnglishAppendix(pages, st)
  if (en.length) return en
  return parseChineseAppendix(pages, st)
}
