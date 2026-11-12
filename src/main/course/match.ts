/**
 * 知识点 → 课次 的 AI 匹配：提示词输入的拼装、回答的校验、与已有人工结果的合并。纯函数模块。
 *
 * 防幻觉（M9 §1.6）：
 *  1. 回答里的课次必须是输入里出现过的 id，否则丢弃；
 *  2. quote（课次文本里的原文片段）必须逐字出现在该课次的文本里（忽略空白和大小写），找不到就降为 low 并标「仅凭主题推测」；
 *  3. 人工确认 / 否决过的（locked）永不被覆盖；被否决的 (知识点, 课次) 不会再被 AI 加回来。
 */
import crypto from 'node:crypto'
import { lessonName } from './map.ts'
import type { PointKind } from './map.ts'
import { asSubject } from '../../shared/subject.ts'
import { matchLessonRules, hitsToQuote } from './rules.ts'
import { resolveBridge } from './bridge.ts'
import { BRIDGE_TAG, MATCH_THRESHOLD, MAX_MAIN_PER_LESSON, scoreOf } from './score.ts'
import type { CatalogEdition } from './textbook-builtin.ts'

export type Confidence = 'high' | 'medium' | 'low'
export type MapState = 'suggested' | 'confirmed' | 'rejected'

export interface LessonLite {
  id: number
  levelName: string
  seq: number
  noLabel: string
  title: string
  theme: string
  textbookRef: string
  points: Array<{ kind: PointKind; label: string; text: string }>
}

export interface KpLite { code: string; name: string; plain: string; exampleEn: string; hintWords: string }

const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

/** 课次的检索文本：匹配、quote 校验、搜索都用它 */
export function lessonSearchText(l: { levelName?: string; noLabel?: string; title?: string; theme?: string; textbookRef?: string; points?: Array<{ text: string }> }): string {
  return [l.levelName, l.noLabel, l.title, l.theme, l.textbookRef, ...(l.points ?? []).map(p => p.text)].map(x => (x ?? '').trim()).filter(Boolean).join(' ')
}

/** 紧凑的课程行：#12 | 基础级 | 第 5 课《Animals》 | 主题 | 词汇… | 句型… | 对标… */
const LETTERS = {
  english: { phonics: '音', word: '词', pattern: '句', expression: '表', skill: '能' },
  math: { phonics: '算', word: '点', pattern: '例', expression: '法', skill: '能' },
  chinese: { phonics: '识', word: '词', pattern: '读', expression: '写', skill: '能' }
} as const
export function outlineLine(l: LessonLite, subject?: unknown): string {
  const letter = LETTERS[asSubject(subject)]
  const pts = ['phonics', 'word', 'pattern', 'expression', 'skill'] as const
  const parts = [`#${l.id}`, l.levelName, lessonName(l), cut(l.theme, 40)]
  for (const k of pts) { const t = l.points.filter(p => p.kind === k).map(p => p.text).join('；'); parts.push(t ? `${letter[k]}:${cut(t, 80)}` : '') }
  parts.push(cut(l.textbookRef, 40) ? `对标:${cut(l.textbookRef, 40)}` : '')
  return parts.filter((p, i) => i < 3 || p).join(' | ')
}
export const outlineLines = (ls: LessonLite[], subject?: unknown): string => ls.map(l => outlineLine(l, subject)).join('\n')

export const kpSig = (k: KpLite): string => crypto.createHash('sha1').update([k.name, k.plain, k.exampleEn, k.hintWords].join('\u0001')).digest('hex').slice(0, 12)

/** 一批知识点：K1 | 名称 | 白话释义 | 例词 | 例句（批内编号，不暴露内部代码） */
export function kpBatchBlock(kps: KpLite[]): { text: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>()
  const lines = kps.map((k, i) => {
    const t = `K${i + 1}`
    tokens.set(t, k.code)
    return [t, cut(k.name, 30), cut(k.plain, 60) || '—', cut(k.hintWords, 40) || '—', cut(k.exampleEn, 60) || '—'].join(' | ')
  })
  return { text: lines.join('\n'), tokens }
}

/** 能拿来核对的文字：只有标题、主题、要点、教材对标；不含级别名和「第 N 课」这类标签（否则 quote 写个「基础级」「第 5 课」就算过） */
export function lessonQuoteText(l: { title?: string; theme?: string; textbookRef?: string; points?: Array<{ text: string }> }): string {
  return [l.title, l.theme, l.textbookRef, ...(l.points ?? []).map(p => p.text)].map(x => (x ?? '').trim()).filter(Boolean).join(' ')
}

/** quote 太短没有证明力：至少 3 个汉字，或 2 个英文单词，或 1 个 5 个字母以上的英文单词 */
export function quoteLongEnough(q: string, subject?: unknown): boolean {
  const cjk = (q.match(/[\u4e00-\u9fff]/g) ?? []).length
  // 语文、数学的课程内容多是短词和算式（「口算」「3/4+1/4」）：放宽到 2 个汉字，或 3 个以上的数字 / 字母
  if (asSubject(subject) !== 'english' && (cjk >= 2 || (q.match(/[0-9A-Za-z]/g) ?? []).length >= 3)) return true
  const words = q.match(/[A-Za-z]+/g) ?? []
  return cjk >= 3 || words.length >= 2 || words.some(w => w.length >= 5)
}

/** quote 和知识点有没有关系：含知识点的例词 / 例句里的单词（3 个字母以上），或知识点名里连续两个汉字 */
export function quoteTouchesKp(q: string, kp: Partial<KpLite> | undefined, subject?: unknown): boolean {
  if (!kp) return true
  const low = q.toLowerCase()
  if (asSubject(subject) !== 'english') {
    // 语文、数学：例词 / 例子里的汉字双字组、算式或字母串出现在原文里就算有关（不要求英文单词）
    const src = [kp.hintWords ?? '', kp.exampleEn ?? '', kp.name ?? ''].join(' ')
    const grams = new Set<string>()
    for (const run of src.split(/[^\u4e00-\u9fff]+/)) for (let i = 0; i + 1 < run.length; i++) grams.add(run.slice(i, i + 2))
    if ([...grams].some(g => q.includes(g))) return true
    if ((src.toLowerCase().match(/[a-z0-9][a-z0-9/.²³]{1,}/g) ?? []).some(w => low.includes(w))) return true
    return !src.trim()
  }
  const words = [kp.hintWords ?? '', kp.exampleEn ?? ''].join(' ').split(/[^A-Za-z']+/).map(w => w.toLowerCase()).filter(w => w.length >= 3)
  if (words.some(w => low.includes(w))) return true
  const name = kp.name ?? ''
  for (let i = 0; i + 1 < name.length; i++) if (/[\u4e00-\u9fff]{2}/.test(name.slice(i, i + 2)) && q.includes(name.slice(i, i + 2))) return true
  return !words.length && !name   // 没有任何可比的信息就不卡
}

const norm = (s: string) => s.toLowerCase().replace(/[\s　]+/g, '')

// ───────────────────────── 以课找知识点 ─────────────────────────

export type Source = 'rule' | 'ai' | 'bridge'
/** 一条候选：某节课 × 某个知识点，来自规则 / AI / 教材桥 */
export interface Candidate { lessonId: number; code: string; source: Source; confidence: Confidence; quote: string; reason: string; quoteOk?: boolean }
export interface LessonEntry { lessonId: number; maps: Candidate[] }
export interface MatchParse { entries: LessonEntry[]; problems: string[]; dropped: number }

const tierOf = (score: number): Confidence => (score >= 80 ? 'high' : score >= MATCH_THRESHOLD ? 'medium' : 'low')

/** 规则命中 → 候选（程序先认；quote 存命中词，reason 说明） */
export function ruleCandidates(lesson: LessonLite, codes: Iterable<string>): Candidate[] {
  return matchLessonRules(lessonQuoteText(lesson), codes).map(m => {
    const quote = hitsToQuote(m.hits)
    return { lessonId: lesson.id, code: m.code, source: 'rule' as const, confidence: tierOf(m.score), quote, reason: `规则命中：${quote}`.slice(0, 80) }
  })
}

/** 教材桥 → 候选：对标的教材单元的知识点（限定在要匹配的知识点里）；没对上返回空 */
export function bridgeCandidates(lesson: LessonLite, subject: string, catalog: CatalogEdition[], codes: Set<string>): Candidate[] {
  const hit = lesson.textbookRef ? resolveBridge(lesson.textbookRef, subject, catalog) : null
  if (!hit) return []
  return hit.kps.filter(c => codes.has(c)).map(code => ({ lessonId: lesson.id, code, source: 'bridge' as const, confidence: 'medium' as const, quote: '', reason: `${BRIDGE_TAG}：${hit.label}`.slice(0, 80) }))
}

/** 候选的分数（和库里存好之后算的一致） */
export const candidateScore = (c: Candidate): number => scoreOf({ kp_code: c.code, lesson_id: c.lessonId, confidence: c.confidence, state: 'suggested', source: c.source, quote: c.quote, reason: c.reason })

/** 同一 (课, 知识点) 的候选合并成一条：规则 > AI > 教材桥；教材桥只做加分 / 补依据 */
export function mergeCandidates(list: Candidate[]): Candidate[] {
  const by = new Map<string, Candidate[]>()
  for (const c of list) { const k = `${c.lessonId}|${c.code}`; if (!by.has(k)) by.set(k, []); by.get(k)!.push(c) }
  const rank: Record<Source, number> = { rule: 0, ai: 1, bridge: 2 }
  const out: Candidate[] = []
  for (const group of by.values()) {
    group.sort((a, b) => rank[a.source] - rank[b.source])
    const main = { ...group[0] }
    const bridge = group.find(c => c.source === 'bridge')
    if (bridge && main.source !== 'bridge') {
      main.reason = `${main.reason}｜${bridge.reason}`.slice(0, 160)
      main.confidence = tierOf(candidateScore(main))
    }
    out.push(main)
  }
  return out
}

/** 规则 / 教材桥已经认得够多的课，不用再问 AI：过线的候选不少于这个数 */
export const AI_ENOUGH = 2
export function lessonsNeedingAi(lessonIds: number[], cands: Candidate[]): number[] {
  const n = new Map<number, number>()
  for (const c of cands) if (candidateScore(c) >= MATCH_THRESHOLD) n.set(c.lessonId, (n.get(c.lessonId) ?? 0) + 1)
  return lessonIds.filter(id => (n.get(id) ?? 0) < AI_ENOUGH)
}

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

/**
 * 校验 AI 的回答（以课为单位）。格式：{"results":[{"lesson":"#12","kps":[{"kp":"K3","confidence":"high","quote":"…","reason":"…"}]}]}
 * 防幻觉：课次必须是输入里出现过的；知识点必须是批里的 K 编号；quote 必须逐字出现在课次文字里，找不到就降为 low；每节课最多 3 个。
 */
export function parseLessonResponse(text: string, ctx: { tokens: Map<string, string>; lessons: Map<number, { searchText: string; quoteText?: string }>; kps?: Map<string, Partial<KpLite>>; subject?: unknown }): MatchParse {
  let j: any
  try { j = JSON.parse(stripFence(text)) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    try { j = m ? JSON.parse(m[0]) : null } catch { j = null }
  }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : []
  if (!list.length && !(j && typeof j === 'object')) return { entries: [], problems: ['AI 的回答不是有效的 JSON'], dropped: 0 }
  const byLesson = new Map<number, LessonEntry>()
  let dropped = 0
  const problems: string[] = []
  for (const it of list) {
    const m = /^#?(\d+)$/.exec(String(it?.lesson ?? '').trim())
    const id = m ? parseInt(m[1], 10) : NaN
    const lesson = ctx.lessons.get(id)
    if (!lesson) { dropped++; continue }
    let e = byLesson.get(id)
    if (!e) { e = { lessonId: id, maps: [] }; byLesson.set(id, e) }
    const items: any[] = Array.isArray(it.kps) ? it.kps : it.kp ? [it] : []
    for (const k of items) {
      const code = ctx.tokens.get(String(k?.kp ?? '').trim().toUpperCase())
      if (!code) { dropped++; continue }
      if (e.maps.some(x => x.code === code)) continue
      if (e.maps.length >= MAX_MAIN_PER_LESSON) { dropped++; continue }
      let confidence: Confidence
      const quote = typeof k.quote === 'string' ? k.quote.trim().slice(0, 120) : ''
      const quoteOk = !!quote && quoteLongEnough(quote, ctx.subject) && norm(lesson.quoteText ?? lesson.searchText).includes(norm(quote))
      let reason = typeof k.reason === 'string' ? k.reason.trim().slice(0, 60) : ''
      if (!quoteOk) { confidence = 'low'; reason = reason ? `仅凭主题推测：${reason}` : '仅凭主题推测（没有找到课次里的原文依据）' }
      else if (!quoteTouchesKp(quote, ctx.kps?.get(code), ctx.subject)) { confidence = 'medium'; reason = reason ? `原文依据与考点关联不明显：${reason}` : '原文依据与考点关联不明显' }
      else confidence = 'high'   // 核对通过并且和知识点有关：中等分（65）；再高要靠规则 / 教材桥 / 老师确认
      e.maps.push({ lessonId: id, code, source: 'ai', confidence, quote: quoteOk ? quote : '', reason, quoteOk })
    }
  }
  if (dropped) problems.push(`有 ${dropped} 条回答对不上输入里的知识点或课次（或超过每课 ${MAX_MAIN_PER_LESSON} 个），已丢弃`)
  return { entries: [...byLesson.values()], problems, dropped }
}

export interface ExistingMap { kp: string; locked: boolean; state: MapState; source: string }
export interface LessonPlan {
  /** 要删掉的旧的自动结果（没锁定、没被人工处理过的） */
  deleteKps: string[]
  insert: Candidate[]
}

/**
 * 一节课的新候选与库里已有的合并：锁定 / 确认 / 否决过的不动；被否决的 (课, 知识点) 不会再被规则或 AI 加回；
 * 旧的自动结果里属于本次重算范围（scopeKps）的整体换成新的。
 */
export function planLessonMerge(existing: ExistingMap[], cands: Candidate[], scopeKps: Set<string>): LessonPlan {
  const fixed = new Set(existing.filter(e => e.locked || e.state !== 'suggested').map(e => e.kp))
  const deleteKps = existing.filter(e => !fixed.has(e.kp) && scopeKps.has(e.kp)).map(e => e.kp)
  const insert = cands.filter(c => !fixed.has(c.code) && scopeKps.has(c.code))
  return { deleteKps, insert }
}

/** 是否算「主要对应」（单条口径：老师确认的，或没被否决且匹配分过线；每课最多 3 个主知识点的上限见 score.ts 的 classifyMaps / selectMain） */
export { isMainMap } from './score.ts'

/** 知识点列表按批切分：先按一级大类分组，每批不超过 size（课程很大、知识点很多时用） */
export function batchKps<T extends { code: string }>(kps: T[], size = 150): T[][] {
  const out: T[][] = []
  for (let i = 0; i < kps.length; i += size) out.push(kps.slice(i, i + size))
  return out.length ? out : [[]]
}

/** 把课次行切成若干段，每段不超过 maxChars（超大课程才会超过一段） */
export function chunkLines(lines: string[], maxChars = 60000): string[][] {
  const out: string[][] = []
  let cur: string[] = [], n = 0
  for (const l of lines) {
    if (cur.length && n + l.length > maxChars) { out.push(cur); cur = []; n = 0 }
    cur.push(l); n += l.length + 1
  }
  if (cur.length) out.push(cur)
  return out.length ? out : [[]]
}
