/**
 * 课 ↔ 教材书库的原文命中（纯函数 + 内存/本机库，不调用 AI）。
 * 用户上传过整本教材 PDF、建好书库的册：拿课里的词汇和句型去 searchBooks，在书的原文里逐字搜（书后词表、正文都算）。
 * 命中算「原文命中」，是强依据：
 *   · 至少一句课上的句型在书里整句出现；或
 *   · 至少两个不同的课上单词落在同一个单元里。
 * 只有一个单词命中的不算（常用词到处都有）。同一单元命中越多越靠前（单元投票）。
 */
import { searchBooks } from '../bookindex/search.ts'
import type { BookHit } from '../bookindex/search.ts'
import { patternTerms, vocabTerms } from './lesson-match.ts'
import type { LessonText } from './lesson-match.ts'

type Db = any

export interface BookUnitHit {
  bookId: string
  unitKey: string
  unitSeq: number
  unitTitle: string
  score: number
  vocab: string[]
  patterns: string[]
  /** 最能说明问题的一页：印刷页码（认不出时用 PDF 页码） */
  page: number
  /** 老师看得懂的依据：课本原文：同词汇：father、mother · 同句型：who's he */
  evidence: string
}

export const BOOK_MAX_VOCAB = 24
export const BOOK_MAX_PATTERN = 8
const joinWords = (xs: string[], n = 3) => xs.slice(0, n).join('、')

/** 一次搜索里算数的命中：词表命中（可靠）或正文命中，分数在最高分的 80% 以内，最多取 2 个单元 */
function usable(hits: BookHit[], isPattern: boolean): BookHit[] {
  const ok = hits.filter(h => h.unitKey != null && h.unitSeq != null && (isPattern ? (h.level === 'sentence' && h.score >= 70) || (h.level === 'multi' && h.score >= 66) : (h.sources.includes('word-list') || h.sources.includes('phrase-list') ? h.score >= 55 : h.level === 'word' && h.score >= 38)))
  if (!ok.length) return []
  const best = Math.max(...ok.map(h => h.score))
  const keep = ok.filter(h => h.score >= best * 0.8)
  const units = new Set<string>()
  const out: BookHit[] = []
  for (const h of keep.sort((a, b) => b.score - a.score)) {
    if (units.has(h.unitKey!)) continue
    if (units.size >= 2) break
    units.add(h.unitKey!); out.push(h)
  }
  return out
}

export function bookUnitHits(db: Db, bookId: string, lt: LessonText): BookUnitHit[] {
  const byUnit = new Map<string, { unitKey: string; unitSeq: number; unitTitle: string; vocab: Set<string>; patterns: Set<string>; best: BookHit }>()
  const add = (h: BookHit, term: string, isPattern: boolean) => {
    let u = byUnit.get(h.unitKey!)
    if (!u) { u = { unitKey: h.unitKey!, unitSeq: h.unitSeq!, unitTitle: h.unitTitle ?? '', vocab: new Set(), patterns: new Set(), best: h }; byUnit.set(h.unitKey!, u) }
    ;(isPattern ? u.patterns : u.vocab).add(term)
    if (h.score > u.best.score) u.best = h
  }
  for (const p of patternTerms(lt).slice(0, BOOK_MAX_PATTERN)) for (const h of usable(searchBooks(db, p, { bookIds: [bookId], limit: 8 }).hits, true)) add(h, p, true)
  for (const w of vocabTerms(lt).slice(0, BOOK_MAX_VOCAB)) for (const h of usable(searchBooks(db, w, { bookIds: [bookId], limit: 12 }).hits, false)) add(h, w, false)
  const out: BookUnitHit[] = []
  for (const u of byUnit.values()) {
    const vocab = [...u.vocab], patterns = [...u.patterns]
    if (!(patterns.length >= 1 || vocab.length >= 2)) continue
    const score = Math.min(100, 25 + 15 * vocab.length + 30 * patterns.length)
    const page = u.best.printedPage ?? u.best.page
    const parts: string[] = []
    if (vocab.length) parts.push(`同词汇：${joinWords(vocab)}`)
    if (patterns.length) parts.push(`同句型：${joinWords(patterns, 2)}`)
    out.push({ bookId, unitKey: u.unitKey, unitSeq: u.unitSeq, unitTitle: u.unitTitle, score, vocab, patterns, page, evidence: `课本原文：${parts.join(' · ')}（第 ${page} 页）` })
  }
  return out.sort((a, b) => b.score - a.score || a.unitSeq - b.unitSeq)
}

/** 同一版本里最像的 1–2 个单元：第一名一定给；第二名要不低于第一名的 75% */
export function pickBookUnits(ms: BookUnitHit[], minScore = 35): BookUnitHit[] {
  const sorted = ms.filter(m => m.score >= minScore).sort((a, b) => b.score - a.score || (b.vocab.length + b.patterns.length) - (a.vocab.length + a.patterns.length) || a.unitSeq - b.unitSeq)
  if (!sorted.length) return []
  const out = [sorted[0]]
  if (sorted[1] && sorted[1].score >= sorted[0].score * 0.75) out.push(sorted[1])
  return out
}
