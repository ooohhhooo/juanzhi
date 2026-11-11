/**
 * 教材 / 整本书 → 「一个单元一行」（纯函数，不依赖 electron，单测直接加载）。
 *
 * 做法（不让 AI 逐条抄书）：
 *  1. 先找目录页（前 15 页里写着「目录 / Contents」，或连续的「第X单元 …… 页码」行），用文字规则解析出单元和起始页——这一步不用 AI；
 *     没有目录就按正文里的「第 X 单元 / Unit X」标题切；都没有再按页数均分；
 *  2. 每个单元只取标题、小节标题（字号大的行 / 规则匹配的行）和一小段开头文字，交给 AI 从「当前学科现有的知识点树」里挑 2–8 个知识点代码；
 *  3. AI 回答逐条核对：代码必须在树里（不在的丢弃）；引用的原文必须真在给 AI 的那几行里，否则把握程度降为「低」。
 * 最后整本书只有十几到几十行：单元名 + 页码范围 + 知识点。
 */
import { normForFind } from './doc-extract.ts'
import type { Sheet } from './table-read.ts'
import type { SheetMapping } from './map.ts'

/** h = 行高占页高的比例（0–1），字号大的行更高，用来认标题；没有就不用 */
export interface TextLine { page: number; text: string; h?: number }

export interface UnitPlan {
  id: number
  /** 去重用：类型 + 序号，如 unit:3 */
  key: string
  title: string
  pageStart: number
  pageEnd: number
  /** 小节标题 / 栏目名（交给 AI 的主要依据） */
  headings: string[]
  /** 开头的几行正文 */
  opening: string[]
  /** AI 看到的全部行（标题 + 小节标题 + 开头），核对引用的原文用 */
  sourceLines: string[]
}
export type UnitSource = 'toc' | 'heading' | 'blocks'

export const MAX_HEADINGS = 40
export const OPENING_CHARS = 500
/** 没认出单元时，每块大约多少页；块数最多 MAX_FALLBACK_BLOCKS */
export const FALLBACK_PAGES = 10
export const MAX_FALLBACK_BLOCKS = 40
/** 目录一般在前 15 页 */
export const TOC_SCAN_PAGES = 15
/** 每个单元最多挑几个知识点 */
export const MAX_KPS_PER_UNIT = 8

// ───────────────────────── 标题识别 ─────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 阿拉伯数字（含全角）、一二三…十百 → 数字；认不出返回 null */
export function toNum(s: string): number | null {
  const t = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (/^\d+$/.test(t)) return Number(t)
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(t)) return null
  let total = 0, cur = 0
  for (const ch of t) {
    if (ch === '百') { total += (cur || 1) * 100; cur = 0 } else if (ch === '十') { total += (cur || 1) * 10; cur = 0 } else cur = cur * (t.includes('十') || t.includes('百') ? 1 : 10) + CN_DIGIT[ch]
  }
  return total + cur
}

const NUM = '[0-9０-９零〇一二两三四五六七八九十百]+'
const TIERS: Array<Array<{ re: RegExp; num: number; type: number }>> = [
  [
    { re: new RegExp(`^第\\s*(${NUM})\\s*(单元|章|模块|专题|讲|篇)`), num: 1, type: 2 },
    { re: /^(unit|module|chapter|part)\s*[.:：-]?\s*(\d{1,3})(?![\d])/i, num: 2, type: 1 }
  ],
  [
    { re: new RegExp(`^第\\s*(${NUM})\\s*(课|节)`), num: 1, type: 2 },
    { re: /^(lesson)\s*[.:：-]?\s*(\d{1,3})(?![\d])/i, num: 2, type: 1 }
  ]
]
const TYPE_MAP: Record<string, string> = { 单元: 'unit', 章: 'chapter', 模块: 'module', 专题: 'topic', 讲: 'lecture', 篇: 'part', 课: 'lesson', 节: 'section' }
const MAX_HEADING_CHARS = 60
const LEADER = /[.．·…]{2,}\s*(\d{1,4})\s*$/

export interface Heading { key: string; title: string; hasLeader: boolean }

/** 一行文字是不是单元标题（tier 0 = 单元 / 章 / Unit…，1 = 课 / Lesson）；带点线页码的目录条目 hasLeader = true */
export function headingOf(line: string, tier = 0): Heading | null {
  const t = line.replace(/\s+/g, ' ').trim()
  if (!t || t.length > MAX_HEADING_CHARS + 20) return null
  for (const p of TIERS[tier]) {
    const m = p.re.exec(t)
    if (!m) continue
    const n = toNum(m[p.num])
    if (n == null) continue
    const rawType = m[p.type]
    const hasLeader = LEADER.test(t)
    const title = (hasLeader ? t.replace(/[.．·…\s]{2,}\d{1,4}\s*$/, '') : t).trim()
    if (title.length > MAX_HEADING_CHARS) return null
    // 「第三单元的学习目标是……」这种句子不是标题
    if (/^第\s*\S+?(单元|章|模块|专题|讲|篇|课|节)\s*[的中里，,。；;]/.test(t)) return null
    return { key: `${TYPE_MAP[rawType] ?? rawType.toLowerCase()}:${n}`, title, hasLeader }
  }
  return null
}

const TOC_WORD = /^(目\s*录|contents|table of contents)\s*$/i

// ───────────────────────── 目录 ─────────────────────────

export interface TocEntry { title: string; key: string; page: number }
export interface TocResult { tocPages: number[]; entries: TocEntry[] }

/** 目录条目：「第一单元 山水之间 …… 3」或「Unit 1 Hello 3」；返回标题和页码 */
export function tocEntryOf(line: string): { title: string; page: number } | null {
  const t = line.replace(/\s+/g, ' ').trim()
  const m = LEADER.exec(t)
  if (m) {
    const title = t.replace(/[.．·…\s]{2,}\d{1,4}\s*$/, '').trim()
    return title.length >= 2 && title.length <= MAX_HEADING_CHARS ? { title, page: Number(m[1]) } : null
  }
  // 没有点线：必须是「单元标题 + 空格 + 页码」
  const m2 = /^(.{2,60}?)\s+(\d{1,4})$/.exec(t)
  if (m2 && (headingOf(m2[1], 0) || headingOf(m2[1], 1))) return { title: m2[1].trim(), page: Number(m2[2]) }
  return null
}

/**
 * 在前 15 页里找目录：本页写着「目录 / Contents」，或本页有 3 条以上目录条目；目录可以连续好几页。
 * 条目里取单元标题（第 X 单元 / Unit X…）；没有这类标题再试「课」；都没有，条目不多（≤ 40）时全部当单元；页码要递增。
 */
export function parseToc(pages: Array<{ page: number; lines: string[] }>): TocResult {
  const head = pages.slice(0, TOC_SCAN_PAGES)
  const tocPages: number[] = []
  const raw: Array<{ title: string; page: number }> = []
  let started = false
  for (const p of head) {
    const entries = p.lines.map(tocEntryOf).filter((x): x is { title: string; page: number } => !!x)
    const hasWord = p.lines.slice(0, 8).some(l => TOC_WORD.test(l.replace(/\s+/g, ' ').trim()))
    const isToc = hasWord ? entries.length >= 1 : started ? entries.length >= 2 : entries.length >= 3
    if (!isToc) { if (started) break; continue }
    started = true
    tocPages.push(p.page)
    raw.push(...entries)
  }
  const pick = (tier: number): TocEntry[] => {
    const out: TocEntry[] = []
    for (const e of raw) { const h = headingOf(e.title, tier); if (h) out.push({ title: h.title, key: h.key, page: e.page }) }
    return out
  }
  let list = pick(0)
  if (list.length < 2) list = pick(1)
  if (list.length < 2 && raw.length >= 2 && raw.length <= 40) list = raw.map((e, i) => ({ title: e.title, key: `item:${i + 1}`, page: e.page }))
  // 去重（同一个单元只留第一条）、页码必须递增
  const seen = new Set<string>()
  const entries: TocEntry[] = []
  for (const e of list) {
    if (seen.has(e.key)) continue
    if (entries.length && e.page < entries[entries.length - 1].page) continue
    seen.add(e.key); entries.push(e)
  }
  return { tocPages, entries: entries.length >= 2 ? entries : [] }
}

/** 标题在这一行里出现吗（比较用：去掉空白标点、英文转小写；用标题的前 10 个字符，免得被「第一单元 山水之间」后面的小字干扰） */
export function lineHasTitle(line: string, title: string): boolean {
  const t = normForFind(title)
  if (t.length < 2) return false
  return normForFind(line).includes(t.slice(0, 10))
}

/**
 * 目录里的页码是书上印的页码，和 PDF 的第几页之间有偏移（封面、前言）。
 * 用第一个单元的标题去正文里找：从「印的页码 + 0」开始往后试，哪一页上有这个标题，偏移就是几。
 * getLines 由调用方提供（文字版直接取，扫描版才 OCR，所以 maxProbe 限制最多看几页）。找不到返回 null。
 */
export async function findPageOffset(entries: TocEntry[], sel: number[], skip: Set<number>, getLines: (page: number) => Promise<string[]>, maxProbe = 40): Promise<number | null> {
  const first = entries[0]
  if (!first) return null
  const set = new Set(sel)
  let probed = 0
  for (let off = 0; off <= 60 && probed < maxProbe; off++) {
    const page = first.page + off
    if (!set.has(page) || skip.has(page)) continue
    probed++
    if ((await getLines(page)).some(l => lineHasTitle(l, first.title))) return off
  }
  return null
}

/** 目录条目 + 偏移 → 每个单元的 [起, 止] PDF 页；落在所选页码范围之外的单元丢掉 */
export function unitPageRanges(entries: TocEntry[], offset: number, sel: number[]): Array<{ entry: TocEntry; start: number; end: number }> {
  const lo = sel[0], hi = sel[sel.length - 1]
  const starts = entries.map(e => ({ entry: e, start: e.page + offset })).filter(x => x.start >= lo && x.start <= hi)
  return starts.map((x, i) => ({ ...x, end: i + 1 < starts.length ? Math.max(x.start, starts[i + 1].start - 1) : hi }))
}

// ───────────────────────── 单元摘要（只取标题 / 小节标题 / 开头） ─────────────────────────

const SECTION_RE = new RegExp(`^(?:第\\s*${NUM}\\s*(?:课|节|讲|课时)|${NUM}[、.．]\\s*\\S|\\d+(?:\\.\\d+)+\\s*\\S|(?:lesson|section|topic|activity|story|let'?s)\\b|[A-Z][A-Z ]{3,24}$)`, 'i')
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 一个单元的全部文字行 → 小节标题（字号大的行、规则匹配的行）和开头几行 */
export function outlineOf(title: string, items: TextLine[]): { headings: string[]; opening: string[] } {
  const hs: number[] = items.map(i => i.h).filter((h): h is number => typeof h === 'number' && h > 0).sort((a, b) => a - b)
  const median = hs.length ? hs[Math.floor(hs.length / 2)] : 0
  const useSize = hs.length >= items.length * 0.5 && median > 0
  const titleKey = normForFind(title)
  const headings: string[] = []
  const seen = new Set<string>()
  const isHead = (i: TextLine): boolean => {
    const t = clean(i.text)
    if (t.length < 2 || t.length > 40 || /^\d+$/.test(t)) return false
    if (useSize && i.h && i.h >= median * 1.25) return true
    return SECTION_RE.test(t)
  }
  const bodyOfFirst: string[] = []
  const firstPage = items[0]?.page
  for (const i of items) {
    const t = clean(i.text)
    if (!t) continue
    if (isHead(i)) {
      const k = normForFind(t)
      if (k && k !== titleKey && !seen.has(k) && headings.length < MAX_HEADINGS) { seen.add(k); headings.push(t) }
    } else if (i.page === firstPage && t.length >= 4) bodyOfFirst.push(t)
  }
  const opening: string[] = []
  let len = 0
  for (const t of bodyOfFirst) { if (len + t.length > OPENING_CHARS) break; opening.push(t); len += t.length }
  return { headings, opening }
}

export function buildUnit(id: number, key: string, title: string, pageStart: number, pageEnd: number, items: TextLine[]): UnitPlan {
  const { headings, opening } = outlineOf(title, items)
  return { id, key, title, pageStart, pageEnd, headings, opening, sourceLines: [title, ...headings, ...opening] }
}

// ───────────────────────── 没有目录：按正文标题切 / 均分 ─────────────────────────

/** 全部文字（按页、按行）→ 单元：目录页上的条目去掉，页眉里重复的标题只取第一次出现；至少 2 个不同标题才算「有单元」，否则返回 null */
export function splitByHeadings(all: TextLine[], tocPages: number[] = []): UnitPlan[] | null {
  const toc = new Set(tocPages)
  const pages = [...new Set(all.map(l => l.page))].sort((a, b) => a - b)
  for (const p of pages) {   // 没认出目录页时，一页里有 3 个以上不同标题也当目录
    const ls = all.filter(l => l.page === p)
    for (const tier of [0, 1]) if (new Set(ls.map(l => headingOf(l.text, tier)?.key).filter(Boolean)).size >= 3) toc.add(p)
  }
  for (const tier of [0, 1]) {
    const seen = new Set<string>()
    const marks: Array<{ idx: number; h: Heading }> = []
    all.forEach((l, idx) => {
      if (toc.has(l.page)) return
      const h = headingOf(l.text, tier)
      if (!h || h.hasLeader || seen.has(h.key)) return
      seen.add(h.key); marks.push({ idx, h })
    })
    if (marks.length < 2) continue
    return marks.map((m, i) => {
      const items = all.slice(m.idx, i + 1 < marks.length ? marks[i + 1].idx : all.length)
      return buildUnit(i + 1, m.h.key, m.h.title, items[0].page, items[items.length - 1].page, items)
    })
  }
  return null
}

/** 没有单元标题：按页数均分成块（每块约 FALLBACK_PAGES 页，块数不超过 MAX_FALLBACK_BLOCKS）；返回每块的页码范围 */
export function fallbackRanges(sel: number[]): Array<{ start: number; end: number }> {
  const per = Math.max(FALLBACK_PAGES, Math.ceil(sel.length / MAX_FALLBACK_BLOCKS))
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < sel.length; i += per) out.push({ start: sel[i], end: sel[Math.min(i + per, sel.length) - 1] })
  return out
}
export const blockTitle = (start: number, end: number): string => (start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`)

/** 预计 AI 调用次数 = 单元数（一个单元一次小调用） */
export const estimateCalls = (units: Array<unknown>): number => units.length

/** 扫描版 OCR 的大致用时（分钟，向上取整）：按每页约 3 秒估；教材只 OCR 目录页和每单元前 2 页，所以传入的是要 OCR 的页数 */
export const ocrMinutes = (pages: number): number => Math.max(1, Math.ceil((pages * 3) / 60))
/** 扫描版教材大概要 OCR 多少页：目录页 + 每单元前 2 页（单元数不知道时按每 15 页一个单元估） */
export const estimateOcrPages = (selected: number): number => Math.min(selected, TOC_SCAN_PAGES + Math.ceil(selected / 15) * 2)

// ───────────────────────── AI 回答：挑知识点代码 ─────────────────────────

export type Conf = 'high' | 'medium' | 'low'
export interface UnitKp { code: string; confidence: Conf; quote: string; reason: string }
export interface UnitKpParse { ok: boolean; kps: UnitKp[]; invalid: string[] }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

/** 引用的原文是不是真在给 AI 的那几行里（逐行比对） */
export function quoteInSource(quote: string, sourceLines: string[]): boolean {
  const q = normForFind(quote)
  if (q.length < 2) return false
  return sourceLines.some(l => normForFind(l).includes(q))
}

/**
 * 校验回答：{"kps":[{"code":"…","confidence":"high","quote":"…"}]}。
 * 代码不在知识点树里的丢弃（记到 invalid）；同一个代码只留一次；最多 8 个；
 * 引用的原文找不到的，把握降为「低」并标明「仅凭单元主题推测」。
 */
export function parseUnitKpResponse(text: string, validCodes: Set<string>, sourceLines: string[]): UnitKpParse {
  let j: any
  try { j = JSON.parse(stripFence(text)) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    try { j = m ? JSON.parse(m[0]) : null } catch { j = null }
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.kps)) return { ok: false, kps: [], invalid: [] }
  const kps: UnitKp[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const x of j.kps.slice(0, 40)) {
    if (!x || typeof x !== 'object') continue
    const code = typeof x.code === 'string' ? x.code.trim() : ''
    if (!code) continue
    if (!validCodes.has(code)) { invalid.push(code.slice(0, 40)); continue }
    if (seen.has(code) || kps.length >= MAX_KPS_PER_UNIT) continue
    seen.add(code)
    const quote = typeof x.quote === 'string' ? clean(x.quote).slice(0, 80) : ''
    const ok = quoteInSource(quote, sourceLines)
    let confidence: Conf = x.confidence === 'high' || x.confidence === 'medium' ? x.confidence : 'low'
    if (!ok) confidence = 'low'
    kps.push({ code, confidence, quote: ok ? quote : '', reason: ok ? '单元标题 / 小节标题里有对应的原文' : '仅凭单元主题推测（没有找到原文依据）' })
  }
  return { ok: true, kps, invalid }
}

/** 一个单元的把握程度：有高 / 中的知识点就是「中以上」；没有任何知识点，或全是低 = 需要核对 */
export const unitNeedsReview = (kps: UnitKp[]): boolean => kps.length === 0 || kps.every(k => k.confidence === 'low')

/** 给 AI 的候选知识点：一行一个「代码 | 路径名称」，只放第 2 级及以下的节点 */
export function kpCandidateLines(kps: Array<{ code: string; parent_code: string | null; name: string; level: number }>): { text: string; codes: Set<string> } {
  const byCode = new Map(kps.map(k => [k.code, k]))
  const lines: string[] = []
  const codes = new Set<string>()
  for (const k of kps) {
    if (k.level < 2) continue
    const path: string[] = [k.name]
    let p = k.parent_code ? byCode.get(k.parent_code) : undefined
    for (let n = 0; p && n < 3; n++) { path.unshift(p.name); p = p.parent_code ? byCode.get(p.parent_code) : undefined }
    lines.push(`${k.code} | ${path.join(' / ')}`)
    codes.add(k.code)
  }
  return { text: lines.join('\n'), codes }
}

// ───────────────────────── 成表 ─────────────────────────

export interface UnitResult { unit: UnitPlan; kps: UnitKp[] }

export const TEXTBOOK_HEADER = ['序号', '书名', '单元', 'PDF 页码']
/** 固定的列映射：书名放在「级别」列，单元名是课程标题，页码放备注 */
export const TEXTBOOK_MAPPING: SheetMapping = {
  headerRows: 1, levelName: '', skipMarkers: [], uncertain: [],
  columns: [{ col: 0, field: 'seq' }, { col: 1, field: 'level' }, { col: 2, field: 'title' }, { col: 3, field: 'note' }]
}
export const pageRangeText = (u: { pageStart: number; pageEnd: number }): string => (u.pageStart === u.pageEnd ? `第 ${u.pageStart} 页` : `第 ${u.pageStart}–${u.pageEnd} 页`)

/** 各单元 → 一张表：每个单元一行（序号就是单元序号，保存时靠它把知识点对到这一行） */
export function textbookToSheet(bookName: string, units: UnitPlan[]): Sheet {
  const book = bookName.slice(0, 60) || '教材'
  return { name: book.slice(0, 31), hidden: false, rows: [TEXTBOOK_HEADER, ...units.map(u => [String(u.id), book, u.title.slice(0, 300), pageRangeText(u)])], mergedFilled: false }
}
