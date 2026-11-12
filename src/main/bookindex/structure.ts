/**
 * 书库：认目录、认单元、给每一页定“属于哪个单元”（纯函数，不依赖 electron）。
 * 顺序：程序认标题 → 目录页码校准 →（边界对不上的页才）交给 AI 在已认出的单元里选一个。
 */
import { headingOf, toNum } from '../course/textbook.ts'

export type PageKind = 'blank' | 'front' | 'toc' | 'body' | 'appendix' | 'back'
export interface PageIn { page: number; text: string; lines: string[]; empty: boolean }

export interface TocEntry { key: string; title: string; kind: 'unit' | 'lesson' | 'section' | 'appendix'; no: number | null; printed: number }
export interface SectionOut { title: string; printed: number; page: number; lessonNo: number | null }
export interface UnitOut {
  seq: number; key: string; title: string; pageStart: number; pageEnd: number; printedStart: number | null
  sections: SectionOut[]
  /** 起始页上找到了单元标记（Unit N / 第X单元 / 章标题） */
  verified: boolean
}
export type UnitVia = 'toc' | 'heading' | 'blocks'
export interface Structure {
  via: UnitVia
  offset: number | null
  tocPages: number[]
  units: UnitOut[]
  kinds: PageKind[]
  /** 每页所属单元的 seq（无 = null），下标 = 页码 - 1 */
  pageUnit: Array<number | null>
  printed: Array<number | null>
  appendixStart: number | null
  appendixTitles: Array<{ key: string; title: string; page: number }>
  /** 单元边界没法用页面内容确认的页：交给 AI 在已有单元里选 */
  uncertain: number[]
  notes: string[]
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
const CN_UNIT = '[0-9零〇一二两三四五六七八九十百]+'

// ───────────────────────── 印的页码 ─────────────────────────

/** 一页里“只有数字”的行（1–3 位）：可能是印的页码 */
function numericLines(p: PageIn): number[] {
  return p.lines.map(l => l.trim()).filter(l => /^\d{1,3}$/.test(l)).map(Number)
}

/** 全书投票求 “PDF 页 − 印的页码” 的偏移；票数不到四分之一的页就当没有 */
export function detectOffset(pages: PageIn[]): { offset: number | null; first: number; last: number } {
  const votes = new Map<number, number>()
  for (const p of pages) for (const n of new Set(numericLines(p))) {
    const off = p.page - n
    if (off >= 0 && off <= 40) votes.set(off, (votes.get(off) ?? 0) + 1)
  }
  let best = -1, bv = 0
  for (const [o, v] of votes) if (v > bv) { best = o; bv = v }
  if (best < 0 || bv < Math.max(4, pages.length * 0.25)) return { offset: null, first: 0, last: 0 }
  const hit = pages.filter(p => numericLines(p).includes(p.page - best)).map(p => p.page)
  return { offset: best, first: Math.min(...hit), last: Math.max(...hit) }
}

// ───────────────────────── 目录 ─────────────────────────

const TOC_WORD = /^(目\s*录|contents|table of contents)$/i
const LEADER = /^(.*?)[.．·…\s]{2,}(\d{1,3})\s*$/
const stripLead = (s: string) => s.replace(/^[\s.．·]+/, '').trim()

/** 前 20 页里找目录页：有“目录 / Contents”字样，或者（接着上一页）有 3 条以上像目录的行 */
export function findTocPages(pages: PageIn[]): number[] {
  const out: number[] = []
  let inToc = false
  for (const p of pages.slice(0, 20)) {
    const head = p.lines.map(l => l.replace(/\s+/g, ''))
    const word = head.some(l => TOC_WORD.test(l))
    const leaders = p.lines.filter(l => LEADER.test(l)).length
    const nums = p.lines.filter(l => /^\d{1,3}$/.test(l.trim())).length
    const unitTitles = p.lines.filter(l => /^(unit|recycle|appendix)\b/i.test(l.trim())).length
    const looks = leaders >= 3 || (nums >= 3 && unitTitles >= 3) || p.lines.filter(l => mathEntry(l)).length >= 3
    if (word || (inToc && looks)) { out.push(p.page); inToc = true } else if (inToc) break
  }
  return out
}

function mathEntry(line: string): TocEntry | null {
  const t = line.trim()
  let m = /^(\d{1,2})\s+([一-鿿].{0,30}?)\s*(\d{1,3})$/.exec(t)
  if (m) return { key: `chapter:${m[1]}`, title: m[2].trim(), kind: 'unit', no: Number(m[1]), printed: Number(m[3]) }
  m = /^([一-鿿].{0,30}?)\s*(\d{1,2})\s+(\d{1,3})$/.exec(t)
  if (m) return { key: `chapter:${m[2]}`, title: m[1].trim(), kind: 'unit', no: Number(m[2]), printed: Number(m[3]) }
  m = /^([一-鿿]{2,12})\s+(\d{1,3})$/.exec(t)
  if (m) return { key: `item:${m[1]}`, title: m[1], kind: 'unit', no: null, printed: Number(m[2]) }
  return null
}

function leaderEntries(lines: string[]): TocEntry[] {
  const out: TocEntry[] = []
  for (const raw of lines) {
    const m = LEADER.exec(raw)
    if (!m) continue
    const printed = Number(m[2])
    const title = stripLead(m[1])
    let h
    if ((h = new RegExp(`^第\\s*(${CN_UNIT})\\s*(单元|章|模块|专题)`).exec(title))) {
      const no = toNum(h[1]); if (no != null) out.push({ key: `unit:${no}`, title, kind: 'unit', no, printed })
    } else if ((h = /^(unit|module|chapter|part)\s*(\d{1,2})\b/i.exec(title))) {
      out.push({ key: `unit:${h[2]}`, title, kind: 'unit', no: Number(h[2]), printed })
    } else if ((h = /^(\d{1,2})\s*\*?\s*[.．]\s*(\S.*)$/.exec(title))) {
      out.push({ key: `lesson:${h[1]}`, title: h[2].trim(), kind: 'lesson', no: Number(h[1]), printed })
    } else if (/^[◎☆]/.test(title)) {
      out.push({ key: `section:${out.length}`, title: title.replace(/^[◎☆]\s*[.．]?\s*/, ''), kind: 'section', no: null, printed })
    } else if (/^(识字表|写字表|词语表|附录|生字表|词汇表|索引)/.test(title.replace(/\s+/g, ''))) {
      out.push({ key: `appendix:${title.replace(/\s+/g, '')}`, title: title.replace(/\s+/g, ''), kind: 'appendix', no: null, printed })
    }
  }
  return out
}

/** 英文书目录：标题一栏、页码一栏，各自按行读出来；正文单元按出现顺序，附录按附录号，再和页码按顺序配对 */
function englishEntries(lines: string[], probe?: (e: TocEntry, printed: number) => boolean): TocEntry[] {
  const nums = lines.map(l => l.trim()).filter(l => /^\d{1,3}$/.test(l)).map(Number)
  const body: TocEntry[] = [], app: TocEntry[] = []
  for (const raw of lines) {
    const t = raw.trim()
    let m
    if ((m = /^unit\s*(\d{1,2})\b\s*(.*)$/i.exec(t))) body.push({ key: `unit:${m[1]}`, title: t, kind: 'unit', no: Number(m[1]), printed: 0 })
    else if ((m = /^(recycle|review|revision)\s*(\d{1,2})?\b/i.exec(t))) body.push({ key: `${m[1].toLowerCase()}:${m[2] ?? body.length}`, title: t, kind: 'unit', no: m[2] ? Number(m[2]) : null, printed: 0 })
    else if ((m = /^appendix\s*(\d{1,2})\b/i.exec(t))) app.push({ key: `appendix:${m[1]}`, title: t, kind: 'appendix', no: Number(m[1]), printed: 0 })
  }
  app.sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
  const titles = [...body, ...app]
  if (titles.length < 3 || nums.length < titles.length) return []
  const sorted = [...nums.slice(0, titles.length)]
  for (let i = 1; i < sorted.length; i++) if (sorted[i] <= sorted[i - 1]) return []
  // 目录里标题的读出顺序常常是乱的：单元按页面上的标记找自己的页码，剩下的页码按顺序给 Recycle / 附录
  const left = new Set(sorted)
  const done: TocEntry[] = []
  const units = body.filter(e => e.key.startsWith('unit:')).sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
  if (probe) for (const e of units) {
    const hit = [...left].find(pg => probe(e, pg))
    if (hit != null) { done.push({ ...e, printed: hit }); left.delete(hit) }
  }
  if (done.length === units.length && units.length) {
    const rest = [...left].sort((a, b) => a - b)
    const others = [...body.filter(e => !e.key.startsWith('unit:')).sort((a, b) => (a.no ?? 0) - (b.no ?? 0)), ...app]
    others.forEach((e, i) => done.push({ ...e, printed: rest[i] }))
    return done.sort((a, b) => a.printed - b.printed)
  }
  return titles.map((e, i) => ({ ...e, printed: sorted[i] }))
}

export function parseTocEntries(lines: string[], probe?: (e: TocEntry, printed: number) => boolean): TocEntry[] {
  const leader = leaderEntries(lines)
  if (leader.filter(e => e.kind === 'unit').length >= 2) return leader
  const en = englishEntries(lines, probe)
  if (en.filter(e => e.kind === 'unit').length >= 2) return en
  const math: TocEntry[] = []
  for (const l of lines) { const e = mathEntry(l); if (e) math.push(e) }
  // 去重（同一章只留一条），按页码排序
  const seen = new Set<string>()
  const uniq = math.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true))).sort((a, b) => a.printed - b.printed)
  return uniq.length >= 3 ? uniq : []
}

// ───────────────────────── 单元起始页的标记 ─────────────────────────

const normT = (s: string) => s.replace(/[\s.．·…、，。：:！!？?“”"'’]/g, '').toLowerCase()

/** 这一页上有没有该单元的标记（Unit One / 第一单元 / 章标题） */
export function pageHasUnitMarker(p: PageIn, e: Pick<TocEntry, 'key' | 'title' | 'no'>): boolean {
  const head = p.lines.slice(0, 4).concat(p.lines.slice(-4))
  if (e.key.startsWith('unit:') && /^第/.test(e.title)) return head.some(l => { const t = l.replace(/\s+/g, ''); return t.includes(`第${cnNum(e.no ?? 0)}单元`) || t.includes(`第${e.no}单元`) })
  if (e.key.startsWith('unit:')) {
    const n = e.no ?? 0
    const word = Object.entries(WORD_NUM).find(([, v]) => v === n)?.[0] ?? ''
    return head.some(l => new RegExp(`^unit\\s*(${n}|${word})\\b`, 'i').test(l.trim()))
  }
  if (/^(recycle|review|revision)/.test(e.key)) { const [w, n] = e.key.split(':'); return p.lines.some(l => new RegExp(`^${w}\\s*${n}\\b`, 'i').test(l.trim())) }
  // 数学：整行就是“章号 + 章标题”（或没有章号的活动标题）
  const t = normT(e.title.replace(/^\d+\s*/, ''))
  if (t.length < 2) return false
  const want = normT(`${e.no ?? ''}${t}`)
  return p.lines.some(l => normT(l) === want)
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function cnNum(n: number): string {
  if (n <= 10) return CN_DIGITS[n]
  if (n < 20) return '十' + CN_DIGITS[n - 10]
  return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '')
}

// ───────────────────────── 没有目录：按正文标题 ─────────────────────────

function headingEntries(pages: PageIn[]): Array<{ entry: TocEntry; page: number }> {
  const out: Array<{ entry: TocEntry; page: number }> = []
  const seen = new Set<string>()
  for (const p of pages) {
    const cand = p.lines.slice(0, 4).concat(p.lines.slice(-4))
    for (const l of cand) {
      const t = l.trim()
      let key: string | null = null, no: number | null = null
      const m = /^unit\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(t)
      const rc = /^(recycle|review)\s*(\d{1,2})?\b/i.exec(t)
      if (m) { no = WORD_NUM[m[1].toLowerCase()] ?? Number(m[1]); key = `unit:${no}` }
      else if (rc && p.lines.indexOf(l) < 3) { no = null; key = `${rc[1].toLowerCase()}:${rc[2] ?? p.page}` }
      else { const h = headingOf(t, 0); if (h && /^第/.test(h.title) && !h.hasLeader) { key = h.key; no = Number(h.key.split(':')[1]) } }
      if (key && !seen.has(key)) { seen.add(key); out.push({ entry: { key, title: t, kind: 'unit', no, printed: 0 }, page: p.page }); break }
    }
  }
  // 单元号必须递增，否则丢掉乱序的
  const ok: typeof out = []
  let lastNo = 0
  for (const x of out) {
    if (x.entry.no == null) { ok.push(x); continue }
    if (x.entry.no > lastNo) { ok.push(x); lastNo = x.entry.no }
  }
  return ok.length >= 2 ? ok : []
}

// ───────────────────────── 总流程 ─────────────────────────

const FALLBACK_BLOCK = 10

export function analyzeStructure(pages: PageIn[]): Structure {
  const n = pages.length
  const notes: string[] = []
  const byNo = (p: number) => pages[p - 1]
  const off = detectOffset(pages)
  const tocPages = findTocPages(pages)
  const entries = tocPages.length ? parseTocEntries(tocPages.flatMap(p => byNo(p).lines), off.offset == null ? undefined : (e, pr) => { const q = pr + off.offset!; return q >= 1 && q <= n && pageHasUnitMarker(byNo(q), e) }) : []
  const unitEntries = entries.filter(e => e.kind === 'unit')

  let via: UnitVia = 'toc'
  let starts: Array<{ entry: TocEntry; page: number; verified: boolean }> = []
  let offset = off.offset
  const uncertain = new Set<number>()

  if (unitEntries.length >= 2) {
    // 偏移：先用全书页码投票；对不上第一个单元时，用标记反推
    const markerAt = (e: TocEntry, from: number, to: number): number | null => {
      for (let p = Math.max(1, from); p <= Math.min(n, to); p++) if (!tocPages.includes(p) && pageHasUnitMarker(byNo(p), e)) return p
      return null
    }
    const first = unitEntries[0]
    if (offset == null || !(markerAt(first, first.printed + offset - 1, first.printed + offset + 1))) {
      const guess = markerAt(first, first.printed, first.printed + 40)
      if (guess != null) { offset = guess - first.printed; notes.push('页码偏移用第一个单元的标题反推') }
    }
    if (offset == null) { notes.push('没能把目录页码对应到 PDF 页'); }
    else {
      for (const e of unitEntries) {
        const exp = e.printed + offset
        if (exp < 1 || exp > n) continue
        if (pageHasUnitMarker(byNo(exp), e)) { starts.push({ entry: e, page: exp, verified: true }); continue }
        const near = markerAt(e, exp - 3, exp + 3)
        if (near != null) { starts.push({ entry: e, page: near, verified: true }); continue }
        starts.push({ entry: e, page: exp, verified: false })
        for (let q = exp - 2; q <= exp + 2; q++) if (q >= 1 && q <= n) uncertain.add(q)
      }
    }
  }
  // 目录和正文对不上（多半是文字识别把目录读乱了）：不信目录，改按正文标题切
  let tocTrusted = starts.length >= 2
  if (tocTrusted) {
    const bad = starts.filter(s => !s.verified).length > starts.length * 0.2
    // 正文里能认出的单元标题比目录读出来的还多：目录多半被文字识别读乱了
    const more = headingEntries(pages.filter(p => !tocPages.includes(p.page))).length > starts.length
    if (bad || more) {
      tocTrusted = false
      uncertain.clear()
      notes.push('目录页读出来的页码和正文对不上，没有采用目录')
    }
  }
  if (!tocTrusted) {
    starts = []
    const h = headingEntries(pages.filter(p => !tocPages.includes(p.page)))
    if (h.length >= 2) { via = 'heading'; starts = h.map(x => ({ ...x, verified: true })); notes.push('没有可用的目录，单元按正文里的标题切') }
  }
  // 起始页必须递增
  starts = starts.filter((s, i) => i === 0 || s.page > starts[i - 1].page)

  const appendixTitles = (tocTrusted ? entries : []).filter(e => e.kind === 'appendix').map(e => ({ key: e.key, title: e.title, page: (offset ?? 0) + e.printed })).filter(a => a.page >= 1 && a.page <= n && offset != null)
  let appendixStart: number | null = appendixTitles.length ? Math.min(...appendixTitles.map(a => a.page)) : null
  if (appendixStart == null) {
    // 没有目录里的附录：找“Appendix N / 词汇表”开头的页
    const lastBody = starts.length ? starts[starts.length - 1].page : 1
    const ap = pages.find(p => p.page > lastBody + 1 && /^appendix\b/i.test(p.lines[0]?.trim() ?? ''))
    if (ap) appendixStart = ap.page
  }

  // 书后：后记 / 封底
  let bodyEnd = (appendixStart ?? n + 1) - 1
  if (appendixStart == null) {
    for (let p = n; p > 1; p--) { const t = byNo(p).text.replace(/\s/g, ''); if (/后记|绿色印刷|YIWUJIAOYU/i.test(t) || byNo(p).empty) bodyEnd = p - 1; else break }
  }

  let units: UnitOut[] = []
  if (starts.length >= 2) {
    units = starts.map((s, i) => ({
      seq: i + 1, key: s.entry.key, title: s.entry.title, pageStart: s.page,
      pageEnd: Math.max(s.page, (i + 1 < starts.length ? starts[i + 1].page - 1 : bodyEnd)),
      printedStart: offset != null ? s.page - offset : null, sections: [], verified: s.verified
    }))
  } else {
    via = 'blocks'
    const first = tocPages.length ? tocPages[tocPages.length - 1] + 1 : 1
    const end = bodyEnd
    for (let s = first, i = 1; s <= end; s += FALLBACK_BLOCK, i++) {
      const e = Math.min(end, s + FALLBACK_BLOCK - 1)
      units.push({ seq: i, key: `block:${i}`, title: `第 ${s}–${e} 页`, pageStart: s, pageEnd: e, printedStart: offset != null ? s - offset : null, sections: [], verified: false })
    }
    notes.push('没有认出目录和单元标题，已按每 10 页一块切开，单元名只是页码范围')
  }

  // 小节（语文课文、栏目）：挂到所在的单元上
  if (offset != null && via === 'toc') {
    for (const e of entries) {
      if (e.kind === 'unit' || e.kind === 'appendix') continue
      const pg = e.printed + offset
      const u = units.find(x => pg >= x.pageStart && pg <= x.pageEnd)
      if (u) u.sections.push({ title: e.title, printed: e.printed, page: pg, lessonNo: e.kind === 'lesson' ? e.no : null })
    }
  }

  const kinds: PageKind[] = []
  const pageUnit: Array<number | null> = []
  const printed: Array<number | null> = []
  const firstUnitPage = units.length ? units[0].pageStart : n + 1
  const sameOff = off.offset != null && off.offset === offset
  const pLo = sameOff ? off.first : firstUnitPage
  const pHi = sameOff ? off.last : (units.length ? units[units.length - 1].pageEnd : 0)
  for (let p = 1; p <= n; p++) {
    const pg = byNo(p)
    const u = units.find(x => p >= x.pageStart && p <= x.pageEnd)
    let k: PageKind
    if (tocPages.includes(p)) k = 'toc'
    else if (u) k = pg.empty ? 'blank' : 'body'
    else if (appendixStart != null && p >= appendixStart && p <= n) k = pg.empty ? 'blank' : (/后记|绿色印刷/.test(pg.lines.join('').replace(/\s/g, '')) ? 'back' : 'appendix')
    else if (p < firstUnitPage) k = pg.empty ? 'blank' : 'front'
    else k = pg.empty ? 'blank' : 'back'
    kinds.push(k)
    pageUnit.push(u && k !== 'toc' ? u.seq : null)
    printed.push(offset != null && p >= pLo && p <= pHi ? p - offset : null)
  }
  return { via, offset, tocPages, units, kinds, pageUnit, printed, appendixStart, appendixTitles, uncertain: [...uncertain].sort((a, b) => a - b), notes }
}

/** AI 分页接口：给一批页（页码 + 前几十字）和已认出的单元列表，返回每页的单元 key（认不出 = null）。只允许从列表里选 */
export type UnitClassifier = (pages: Array<{ page: number; head: string }>, units: Array<{ key: string; title: string; seq: number }>) => Promise<Record<string, string | null>>

/** 对边界不确定的页问 AI；回答不在单元列表里的一律丢掉，保持程序给的归属 */
export async function resolveUncertain(st: Structure, pages: PageIn[], classify: UnitClassifier | undefined): Promise<number> {
  if (!classify || !st.uncertain.length || !st.units.length) return 0
  const cand = st.uncertain.filter(p => st.kinds[p - 1] === 'body')
  if (!cand.length) return 0
  const unitList = st.units.map(u => ({ key: u.key, title: u.title, seq: u.seq }))
  let ans: Record<string, string | null>
  try { ans = await classify(cand.map(p => ({ page: p, head: pages[p - 1].text.slice(0, 120) })), unitList) } catch { return 0 }
  let changed = 0
  for (const p of cand) {
    const k = ans[String(p)]
    const u = st.units.find(x => x.key === k)
    if (!u) continue
    if (st.pageUnit[p - 1] !== u.seq) { st.pageUnit[p - 1] = u.seq; changed++ }
  }
  return changed
}
