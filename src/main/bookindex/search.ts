/**
 * 书库：搜索。输入单词、句型或一段题干，返回命中的书 / 单元 / 页码 / 原文片段。
 * 排序：整句命中 > 多词命中 > 单词命中；书后词表 / 句型表的命中很可靠，分数最高；目录、前言、附录页降权。
 * 不用 AI：全部在书的原文上比对。
 */
import { candidatePages, loadBook, listBooks } from './store.ts'
import { cjkGrams, cleanQuestion, englishLemmas, englishWords, lemmaKey, splitSentences, STOP, CJK_STOP } from './tokens.ts'
import { hasCjk, normForSearch } from './text.ts'

type Db = any

export type HitLevel = 'sentence' | 'multi' | 'word'
export type HitSource = 'body' | 'word-list' | 'sentence-list' | 'char-list' | 'phrase-list'
export interface BookHit {
  bookId: string
  bookName: string
  /** PDF 的第几页 */
  page: number
  /** 书上印的页码（认不出 = null） */
  printedPage: number | null
  unitKey: string | null
  unitTitle: string | null
  unitSeq: number | null
  /** 语文：所在课文 / 栏目 */
  section: string | null
  level: HitLevel
  score: number
  sources: HitSource[]
  /** 原文片段（命中处前后几十字） */
  snippet: string
  /** 书后词表 / 句型表里的那一条（有的话） */
  listed?: { text: string; gloss: string; appendixPage: number }
  /** 命中了单元标题 / 小节标题 */
  titleMatch?: boolean
}
export interface UnitVote { bookId: string; bookName: string; unitKey: string; unitTitle: string; score: number; matched: string[] }
export interface SearchResult { query: string; cleaned: string; hits: BookHit[]; units: UnitVote[] }

export interface SearchOpts {
  bookIds?: string[]
  subject?: string
  /** 返回多少条（默认 10） */
  limit?: number
  /** 把输入当题干：先去掉题号、选项、下划线 */
  question?: boolean
  /** 目录 / 前言页也返回（默认不返回，除非没有别的） */
  includeFront?: boolean
}

const KIND_WEIGHT: Record<string, number> = { body: 1, appendix: 0.55, front: 0.15, toc: 0.12, back: 0.08, blank: 0 }

interface QInfo {
  raw: string
  norm: string
  cjk: boolean
  /** 英文：词根序列；中文：空 */
  lemmas: string[]
  sig: string[]
  /** 中文：相邻两字 */
  bigrams: string[]
  chars: string[]
  phrase: boolean
}

function analyzeQuery(q: string): QInfo {
  const norm = normForSearch(q)
  const cjk = hasCjk(q)
  if (cjk) {
    const g = cjkGrams(q)
    const compact = norm.replace(/\s/g, '')
    return { raw: q, norm: compact, cjk, lemmas: englishLemmas(q), sig: [], bigrams: g.bi.filter(b => !(CJK_STOP.has(b[0]) && CJK_STOP.has(b[1]))), chars: g.uni, phrase: g.uni.length >= 3 }
  }
  const lemmas = englishLemmas(q)
  const sig = lemmas.filter(l => !STOP.has(l))
  return { raw: q, norm, cjk, lemmas, sig: sig.length ? sig : lemmas, bigrams: [], chars: [], phrase: lemmas.length >= 2 }
}

const containsSeq = (hay: string[], needle: string[]): boolean => {
  if (!needle.length || needle.length > hay.length) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}
const padded = (s: string) => ' ' + s + ' '

function snippetOf(text: string, qi: QInfo, matched: string[]): string {
  let at = -1, len = 0
  const low = text.toLowerCase()
  if (qi.cjk) {
    const whole = qi.norm
    at = text.indexOf(whole); len = whole.length
    if (at < 0) for (const b of qi.bigrams) { at = text.indexOf(b); if (at >= 0) { len = 2; break } }
    if (at < 0) for (const c of qi.chars) { at = text.indexOf(c); if (at >= 0) { len = 1; break } }
  } else {
    const words = englishWords(qi.raw).filter(w => !STOP.has(lemmaKey(w)))
    const order = (matched.length ? words.filter(w => matched.includes(lemmaKey(w))) : words).concat(words)
    // 先整句，再逐词
    const wi = low.replace(/[’‘]/g, "'").indexOf(qi.norm)
    if (qi.phrase && wi >= 0) { at = wi; len = qi.norm.length } else {
      for (const w of order) {
        const m = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z]*`, 'i').exec(text)
        if (m) { at = m.index; len = m[0].length; break }
      }
    }
  }
  if (at < 0) return text.slice(0, 90)
  const from = Math.max(0, at - 36), to = Math.min(text.length, at + len + 54)
  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')
}

interface Scored { score: number; level: HitLevel; matched: string[] }

/** 一页文字对查询的命中程度（0 = 没命中） */
function scorePage(norm: string, pageLemmas: string[] | null, qi: QInfo, weights: Map<string, number>): Scored | null {
  if (qi.cjk) {
    if (qi.norm.length >= 2 && norm.includes(qi.norm)) return { score: qi.phrase ? 100 : 62, level: qi.phrase ? 'sentence' : 'word', matched: [qi.norm] }
    if (qi.norm.length === 1 && norm.includes(qi.norm)) return { score: 30, level: 'word', matched: [qi.norm] }
    const bg = qi.bigrams
    if (bg.length >= 2) {
      let tot = 0, got = 0
      const m: string[] = []
      for (const b of bg) { const w = weights.get(b) ?? 1; tot += w; if (norm.includes(b)) { got += w; m.push(b) } }
      const frac = tot ? got / tot : 0
      if (frac >= 0.5 && m.length >= 2) return { score: 35 + 40 * frac, level: 'multi', matched: m }
      if (m.length === 1 && frac >= 0.3) return { score: 12 + 10 * frac, level: 'word', matched: m }
    }
    return null
  }
  const pl = pageLemmas ?? []
  if (qi.phrase) {
    if (padded(norm).includes(padded(qi.norm))) return { score: 100, level: 'sentence', matched: qi.lemmas }
    if (containsSeq(pl, qi.lemmas)) return { score: 92, level: 'sentence', matched: qi.lemmas }
  } else if (qi.lemmas.length === 1) {
    if (pl.includes(qi.lemmas[0])) {
      const tf = pl.filter(x => x === qi.lemmas[0]).length
      return { score: 40 + Math.min(10, tf * 2), level: 'word', matched: qi.lemmas }
    }
    return null
  }
  const set = new Set(pl)
  let tot = 0, got = 0
  const m: string[] = []
  for (const l of qi.sig) { const w = weights.get(l) ?? 1; tot += w; if (set.has(l)) { got += w; m.push(l) } }
  const frac = tot ? got / tot : 0
  if (m.length >= 2 && frac >= 0.5) return { score: 30 + 45 * frac, level: 'multi', matched: m }
  if (m.length === 1 && (qi.sig.length === 1 || (weights.get(m[0]) ?? 0) >= 1.5)) return { score: 14 + 8 * frac, level: 'word', matched: m }
  return null
}

function searchOne(db: Db, qi: QInfo, bookIds: string[], includeFront: boolean): { hits: BookHit[]; votes: Map<string, UnitVote> } {
  const hits = new Map<string, BookHit>()
  const votes = new Map<string, UnitVote>()
  const tokens = qi.cjk ? [...new Set([...qi.bigrams, ...(qi.bigrams.length ? [] : qi.chars)])] : [...new Set(qi.sig)]
  const cand = candidatePages(db, bookIds, tokens)
  // 词的权重：候选页里越少见越重要
  const df = new Map<string, number>()
  const pageData: Array<{ bookId: string; page: number; norm: string; lemmas: string[] | null }> = []
  for (const c of cand) {
    const b = loadBook(db, c.bookId)
    const p = b?.pages[c.page - 1]
    if (!b || !p || !p.text) continue
    const norm = normForSearch(p.text)
    const lemmas = qi.cjk ? null : englishLemmas(p.text)
    pageData.push({ bookId: c.bookId, page: c.page, norm, lemmas })
    const present = qi.cjk ? qi.bigrams.filter(t => norm.includes(t)) : [...new Set(qi.sig.filter(t => lemmas!.includes(t)))]
    for (const t of present) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const weights = new Map<string, number>()
  for (const t of qi.cjk ? qi.bigrams : qi.sig) weights.set(t, Math.log(1 + (pageData.length + 1) / ((df.get(t) ?? 0) + 1)))

  const add = (h: BookHit) => {
    const key = `${h.bookId}#${h.page}`
    const old = hits.get(key)
    if (!old) { hits.set(key, h); return }
    const best = h.score > old.score ? h : old
    const other = best === h ? old : h
    best.sources = [...new Set([...best.sources, ...other.sources])]
    best.listed = best.listed ?? other.listed
    best.titleMatch = best.titleMatch || other.titleMatch
    best.score = Math.max(best.score, other.score) + 2
    if (best.level !== 'sentence' && other.level === 'sentence') best.level = 'sentence'
    hits.set(key, best)
  }

  // 1) 正文页
  for (const d of pageData) {
    const b = loadBook(db, d.bookId)!
    const p = b.pages[d.page - 1]
    const s = scorePage(d.norm, d.lemmas, qi, weights)
    if (!s) continue
    const kw = KIND_WEIGHT[p.kind] ?? 0.5
    if (kw < 0.2 && !includeFront) continue
    const u = p.unitSeq != null ? b.units.find(x => x.seq === p.unitSeq) : undefined
    const sec = u ? [...u.sections].reverse().find(x => x.page <= p.page) : undefined
    let score = s.score * kw
    // 单元 / 小节标题命中：加分，并且把单元的第一页排前面
    const titleHit = !!u && ((qi.cjk ? normForSearch(u.title).includes(qi.norm) && qi.norm.length >= 3 : false) || (!!sec && sec.page === p.page && normForSearch(sec.title).includes(qi.cjk ? qi.norm : qi.norm)) || (!qi.cjk && qi.phrase && normForSearch(u.title).includes(qi.norm)))
    if (titleHit) score += 15
    add({
      bookId: d.bookId, bookName: b.name, page: p.page, printedPage: p.printed, unitKey: u?.key ?? null, unitTitle: u?.title ?? null, unitSeq: u?.seq ?? null,
      section: sec?.title ?? null, level: s.level, score, sources: ['body'], snippet: snippetOf(p.text, qi, s.matched), titleMatch: titleHit || undefined
    })
  }

  // 2) 书后的词表 / 句型表 / 识字表 / 词语表：命中的条目直接指向单元和页码
  for (const id of bookIds) {
    const b = loadBook(db, id)
    if (!b || !b.items.length) continue
    for (const it of b.items) {
      const itNorm = normForSearch(it.text)
      let score = 0
      let level: HitLevel = 'word'
      if (it.kind === 'word' || it.kind === 'sentence') {
        if (qi.cjk) continue
        const il = englishLemmas(it.text)
        if (!il.length) continue
        const sameSeq = il.length === qi.lemmas.length && il.every((x, i) => x === qi.lemmas[i])
        if (sameSeq) { score = 98; level = il.length > 1 ? 'sentence' : 'word' }
        else if (it.kind === 'sentence' && qi.lemmas.length >= 2 && containsSeq(il, qi.lemmas)) { score = 88; level = 'sentence' }
        else if (it.kind === 'sentence' && il.length >= 3 && containsSeq(qi.lemmas, il)) { score = 70; level = 'sentence' }
        else if (it.kind === 'sentence' && qi.sig.length >= 2) {
          const hit = qi.sig.filter(x => il.includes(x)).length
          if (hit >= 2 && hit / qi.sig.length >= 0.7) { score = 55 + 10 * hit / qi.sig.length; level = 'multi' }
        } else if (it.kind === 'word' && qi.phrase === false) {
          // 查单个词，书上词表里是词组 “pencil box”：词组包含它，低一档
          if (il.length > 1 && il.includes(qi.lemmas[0])) { score = 58; level = 'word' }
        }
        // 多词查询里包含词表里的词：只给单元投票，不单独成条
        if (!score && qi.lemmas.length >= 3 && it.kind === 'word' && containsSeq(qi.lemmas, il) && !STOP.has(il[0])) {
          if (it.unitKey) addVote(votes, b, id, it.unitKey, 1, it.text)
          continue
        }
      } else {
        if (!qi.cjk) continue
        if (itNorm && qi.norm === itNorm) { score = 90; level = 'word' }
        else if (itNorm.length >= 2 && qi.norm.includes(itNorm) && qi.norm.length >= 4) { if (it.unitKey) addVote(votes, b, id, it.unitKey, 1, it.text); continue }
      }
      if (!score) continue
      if (!it.pdfRef) continue
      const p = b.pages[it.pdfRef - 1]
      const u = it.unitKey ? b.units.find(x => x.key === it.unitKey) : undefined
      const sec = u ? [...u.sections].reverse().find(x => x.page <= it.pdfRef!) : undefined
      add({
        bookId: id, bookName: b.name, page: it.pdfRef, printedPage: it.printedRef ?? p?.printed ?? null, unitKey: it.unitKey, unitTitle: u?.title ?? null, unitSeq: u?.seq ?? null,
        section: sec?.title ?? null, level, score,
        sources: [it.kind === 'sentence' ? 'sentence-list' : it.kind === 'word' ? 'word-list' : it.kind === 'phrase' ? 'phrase-list' : 'char-list'],
        snippet: it.gloss ? `${it.text}　${it.gloss}` : it.text, listed: { text: it.text, gloss: it.gloss, appendixPage: it.appPage }
      })
      if (it.unitKey) addVote(votes, b, id, it.unitKey, level === 'sentence' ? 3 : 2, it.text)
    }
  }
  return { hits: [...hits.values()], votes }
}

function addVote(votes: Map<string, UnitVote>, b: { name: string; units: Array<{ key: string; title: string }> }, bookId: string, unitKey: string, w: number, text: string): void {
  const u = b.units.find(x => x.key === unitKey)
  if (!u) return
  const k = `${bookId}#${unitKey}`
  const v = votes.get(k) ?? { bookId, bookName: b.name, unitKey, unitTitle: u.title, score: 0, matched: [] }
  if (!v.matched.includes(text)) { v.matched.push(text); v.score += w }
  votes.set(k, v)
}

function targetBooks(db: Db, opts: SearchOpts): string[] {
  const all = listBooks(db)
  return all.filter(b => (!opts.bookIds || opts.bookIds.includes(b.id)) && (!opts.subject || !b.subject || b.subject === opts.subject)).map(b => b.id)
}

/** 搜索（单词 / 句型 / 一小段文字） */
export function searchBooks(db: Db, query: string, opts: SearchOpts = {}): SearchResult {
  const limit = opts.limit ?? 10
  const cleaned = (opts.question ? cleanQuestion(query) : query).trim()
  const bookIds = targetBooks(db, opts)
  const empty: SearchResult = { query, cleaned, hits: [], units: [] }
  if (!cleaned || !bookIds.length) return empty
  // 题干常常是几句话：整段搜一遍，再逐句搜，页上取最高分
  const queries = [cleaned]
  if (opts.question) { const ss = splitSentences(cleaned); if (ss.length > 1) queries.push(...ss.filter(s => s.length >= 6)) }
  const merged = new Map<string, BookHit>()
  const votes = new Map<string, UnitVote>()
  for (const q of queries) {
    const qi = analyzeQuery(q)
    if (!qi.cjk && !qi.lemmas.length) continue
    if (qi.cjk && !qi.chars.length) continue
    const r = searchOne(db, qi, bookIds, !!opts.includeFront)
    for (const h of r.hits) {
      const key = `${h.bookId}#${h.page}`
      const old = merged.get(key)
      if (!old || h.score > old.score) merged.set(key, old ? { ...h, sources: [...new Set([...h.sources, ...old.sources])], listed: h.listed ?? old.listed } : h)
    }
    for (const [k, v] of r.votes) { const o = votes.get(k); if (!o) votes.set(k, v); else { for (const m of v.matched) if (!o.matched.includes(m)) { o.matched.push(m); o.score += 1 } } }
  }
  let hits = [...merged.values()].sort((a, b) => b.score - a.score || a.page - b.page)
  // 同一本书同一个单元里，词表命中和正文命中都保留，但总数按 limit 截
  hits = hits.slice(0, limit)
  const units = [...votes.values()].sort((a, b) => b.score - a.score).slice(0, 5)
  return { query, cleaned, hits, units }
}

/** 一段题干（含题号、选项、下划线） */
export const searchQuestion = (db: Db, stem: string, opts: SearchOpts = {}): SearchResult => searchBooks(db, stem, { ...opts, question: true })
