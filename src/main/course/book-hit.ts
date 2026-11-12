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
import { matchLessonRules } from './rules.ts'

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

// ───────────────────────── 课在课本里命中的单元 → 这节课的知识点 ─────────────────────────

/**
 * 教材单元的一个知识点是怎么来的（只认程序 / 老师得出的，AI 挑的不算）：
 *  words = 单元自己的词表 / 句子套标志词规则过线；catalog = 内置教材目录里这个单元列了它；teacher = 老师确认 / 手工指定。
 */
export interface UnitKpEv { code: string; via: 'words' | 'catalog' | 'teacher' }
export interface BookUnitForKp { unitTitle: string; /** 第 4 页 */ pages: string; score: number; kps: UnitKpEv[] }
export interface BookKpPick { code: string; score: number; via: UnitKpEv['via']; /** 课上命中这个知识点的标志词（目录得出的为空） */ words: string[]; evidence: string }

/** 只靠目录 / 老师确认（课上没有这个知识点的标志词）时，课在课本里的命中要够强（同句型，或至少 3 个单词） */
export const BOOK_KP_STRONG_HIT = 60
const VIA_TAIL: Record<UnitKpEv['via'], string> = { words: '，单元词表也是这一类', catalog: '，目录里这个单元也列了它', teacher: '，老师确认过这个单元讲它' }

/**
 * 课在课本原文里命中了某个单元（原文逐字命中，一类强依据），这个单元有程序得出的知识点：
 *  ① 课上自己也有这个知识点的标志词（1 个强词，或至少 2 个不同的弱词）→ 两类依据（课本原文 + 命中词），挂上；
 *  ② 课上没有标志词，但知识点来自内置目录 / 老师确认、且课本命中够强 → 两类依据（课本原文 + 目录），把握「比较像」；
 *     这种只在这节课别的知识点一个都没有时补（见 capBookKps），免得把单元里别的内容硬塞给这节课；
 *  只有一个常用词、或单元的知识点只是词表推出来而课上没有对应词的，一律不挂。
 * near(code)：这节课已经有相同 / 父子的知识点了就跳过。按分数从高到低返回（调用方再按每课 3 个的上限截）。
 */
export function bookLessonKps(lessonText: string, units: BookUnitForKp[], near: (code: string) => boolean): BookKpPick[] {
  const best = new Map<string, BookKpPick>()
  for (const u of units) {
    const where = `${u.unitTitle} ${u.pages}`
    for (const k of u.kps) {
      if (near(k.code)) continue
      const r = matchLessonRules(lessonText, [k.code])[0]
      let pick: BookKpPick | null = null
      if (r && (r.strongN >= 1 || r.weakN >= 2)) {
        const words = r.hits.map(h => h.word)
        pick = { code: k.code, via: k.via, words, score: Math.max(66, Math.min(90, r.score + 16)), evidence: `课本原文 + 命中词：${joinWords(words, 4)}（课本 ${where}${VIA_TAIL[k.via]}）` }
      } else if (k.via !== 'words' && u.score >= BOOK_KP_STRONG_HIT) {
        pick = { code: k.code, via: k.via, words: [], score: 62, evidence: k.via === 'catalog' ? `课本原文 + 目录：课本 ${where}，目录里这个单元列了它` : `课本原文 + 老师确认：课本 ${where}，老师确认过这个单元讲它` }
      }
      if (!pick) continue
      const had = best.get(k.code)
      if (!had || pick.score > had.score) best.set(k.code, pick)
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.words.length - a.words.length || (a.code < b.code ? -1 : 1))
}

/** 只靠目录 / 老师确认补的知识点每节课最多几个 */
export const BOOK_KP_FALLBACK_MAX = 2
/**
 * 这节课实际挂哪些：先挂课上有标志词的（补到每课 cap 个为止）；
 * 只有这节课一个知识点都没有（已有的 + 有标志词的都没有）时，才用目录 / 老师确认的补，最多 BOOK_KP_FALLBACK_MAX 个。
 */
export function capBookKps(picks: BookKpPick[], existing: number, cap: number): BookKpPick[] {
  const own = picks.filter(p => p.words.length)
  if (existing + own.length > 0) return own.slice(0, Math.max(0, cap - existing))
  return picks.filter(p => !p.words.length).slice(0, Math.min(BOOK_KP_FALLBACK_MAX, cap))
}
