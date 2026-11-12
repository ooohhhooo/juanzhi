/**
 * 教研对照表：以机构大纲 A 的每一节课为一行，把「这节课对应的知识点 / 学校教材里在哪一册哪个单元 / 校内试卷考过的原题 / （可选）机构大纲 B 里对应的课」排在一起，
 * 再给每节课一列「修订建议」（要补 / 要对齐 / 换例题 / 可减或超前）。数字和依据全部由程序算（纯函数，不依赖 electron，单测用内存库直接跑）；AI 最多把依据润色成一两句话（见 research-ai.ts）。
 * 匹配口径与 compare.ts 一致：只用高 / 中把握或老师确认过的对应（isMainMap，排除否决的）；
 * 「讲到 / 考到」看知识点树上相关——自己、子孙都算直接对应；只有祖先（更大的类别）相关时标「较粗」。
 */
import { nodeStats, scopeCounts } from '../stats/core.ts'
import { CLOSURE_CTE, paperScope } from '../stats/filter.ts'
import type { PaperScope, StatsFilter } from '../stats/filter.ts'
import { safeKpName } from '../../shared/code-guard.ts'
import { asSubject } from '../../shared/subject.ts'
import { isMainMap } from './match.ts'
import { GAP_MIN_PAPERS, subtree } from './stats.ts'
import { listOutlines } from './store.ts'
import { lessonName } from './map.ts'
import { compareCourseTextbook } from './compare.ts'
import { coursewareOfLesson, lessonKey, listCourseware } from './courseware.ts'

type Db = any

export const DEFAULT_PER_KP = 3
export const MAX_PER_KP = 10
export const clampPerKp = (n: unknown): number => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.min(MAX_PER_KP, Math.max(1, v)) : DEFAULT_PER_KP }

export interface CwInput { id: string; name: string; text: string }
/** 某一节挂的课件（含全文，只用来判断「讲没讲到」，不进结果表） */
export type CoursewareLookup = (outlineId: string, levelName: string, seq: number) => CwInput[]

/** 只要其中几节课时给：不命中的课不算例题 / 建议，只保留「要对齐」需要的顺序信息（助手的 lesson_kps 用） */
export type LessonPick = (l: { id: number; levelName: string; seq: number; noLabel: string; label: string; title: string }) => boolean
export interface ResearchOptions { courseId: string; courseBId?: string; textbookIds: string[]; perKp?: number; courseware?: CoursewareLookup; lessonFilter?: LessonPick }

export interface ExampleQ { id: string; paperId: string; paperTitle: string; no: string; stem: string; options: string[]; answer: string; errorProne: boolean; errorReason: string }
export interface TbLoc { outlineId: string; outlineName: string; levelName: string; label: string; title: string; pages: string; coarse: boolean }
export interface BRef { levelName: string; label: string; coarse: boolean }
export interface RKp {
  code: string; name: string; group: string; groupCode: string
  /** 范围内在几份卷子里考到 / 总份数 / 题数 / 易错题数 */
  papers: number; paperTotal: number; questions: number; errorCount: number
  frequent: boolean
  /** 各教材里的位置（直接对应优先；只有祖先对应时才给，并标较粗） */
  locs: TbLoc[]
  examples: ExampleQ[]
  /** 选了 B 时，B 里对应的课 */
  bLessons: BRef[]
}
export type AdviceKind = 'add' | 'align' | 'swap' | 'trim'
export const ADVICE_LABEL: Record<AdviceKind, string> = { add: '要补', align: '要对齐', swap: '换例题', trim: '可减或超前' }
export interface AdviceItem { kind: AdviceKind; text: string; /** 依据（程序算出来的事实，AI 润色时只能引用它们） */ basis: string[]; kpCode?: string }
export interface RLesson {
  lessonId: number; outlineId: string; levelName: string; seq: number; label: string; title: string
  /** 大纲里写的课次编号（可能和 seq 不同，如“第 5 课”排在第 3 位） */
  noLabel?: string
  groups: Array<{ name: string; code: string; kps: RKp[] }>
  kps: RKp[]
  courseware: Array<{ id: string; name: string; chars: number }>
  advice: AdviceItem[]
  /** AI 写的一两句话（没配 AI 时为空，只有规则结论） */
  aiAdvice: string
}
export interface OnlyRow { code: string; name: string; group: string; lessons: string[]; papers: number; paperTotal: number }
export interface TbNotInA { code: string; name: string; group: string; units: string[]; papers: number; paperTotal: number; errorCount: number; frequent: boolean }

export interface ResearchTable {
  ready: boolean
  reason: string
  subject: string
  course: { id: string; name: string } | null
  courseB: { id: string; name: string } | null
  textbooks: Array<{ id: string; name: string }>
  papers: number
  minPapers: number
  smallSample: boolean
  perKp: number
  lessons: RLesson[]
  onlyA: OnlyRow[]
  onlyB: OnlyRow[]
  tbNotInA: TbNotInA[]
  summary: { lessons: number; kps: number; kpsWithExamples: number; examples: number; adviceItems: number; coursewareFiles: number; onlyA: number; onlyB: number; tbNotInA: number }
}

const emptyResult = (reason: string, over: Partial<ResearchTable> = {}): ResearchTable => ({
  ready: false, reason, subject: 'english', course: null, courseB: null, textbooks: [], papers: 0, minPapers: 2, smallSample: true, perKp: DEFAULT_PER_KP,
  lessons: [], onlyA: [], onlyB: [], tbNotInA: [], summary: { lessons: 0, kps: 0, kpsWithExamples: 0, examples: 0, adviceItems: 0, coursewareFiles: 0, onlyA: 0, onlyB: 0, tbNotInA: 0 }, ...over
})

interface MapLite { kp_code: string; lesson_id: number; confidence: string; state: string }
const mainMaps = (db: Db, outlineId: string): MapLite[] =>
  (db.prepare("SELECT kp_code, lesson_id, confidence, state FROM course_kp_map WHERE outline_id = ? AND state <> 'rejected'").all(outlineId) as MapLite[]).filter(isMainMap)

const PAGE_RE = /第\s*\d+(?:\s*[–\-—~～]\s*\d+)?\s*页/
const json = <T>(s: string | null | undefined, fb: T): T => { try { const v = s ? JSON.parse(s) : fb; return (v ?? fb) as T } catch { return fb } }

interface LessonInfo { noLabel: string; id: number; outlineId: string; outlineName: string; levelName: string; levelIdx: number; seq: number; label: string; title: string; pages: string }
function lessonsOf(db: Db, outlineId: string, outlineName: string): LessonInfo[] {
  const levelIdx = new Map((db.prepare('SELECT id FROM course_levels WHERE outline_id = ? ORDER BY sort, id').all(outlineId) as any[]).map((r, i) => [r.id as number, i]))
  const rows = db.prepare(`SELECT l.id, l.level_id, l.seq, l.no_label, l.title, l.points_json, lv.name level_name FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id
    WHERE l.outline_id = ? ORDER BY lv.sort, lv.id, l.seq, l.id`).all(outlineId) as any[]
  return rows.map(r => {
    const pts = json<Array<{ text?: string }>>(r.points_json, [])
    const pages = pts.map(p => PAGE_RE.exec(String(p?.text ?? ''))?.[0] ?? '').find(Boolean) ?? ''
    return { noLabel: String(r.no_label ?? ''), id: r.id, outlineId, outlineName, levelName: r.level_name, levelIdx: levelIdx.get(r.level_id) ?? 0, seq: r.seq, label: lessonName({ seq: r.seq, noLabel: r.no_label ?? '', title: r.title ?? '' }), title: r.title ?? '', pages: pages.replace(/\s+/g, ' ') }
  })
}

const oneLine = (s: string, n: number): string => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

export function researchTable(db: Db, filter: StatsFilter, opts: ResearchOptions): ResearchTable {
  const subject = asSubject(filter.subject)
  const perKp = clampPerKp(opts.perKp ?? DEFAULT_PER_KP)
  const cards = listOutlines(db, subject).filter(o => o.status === 'active')
  const A = cards.find(c => c.id === opts.courseId && c.kind === 'course')
  const B = opts.courseBId && opts.courseBId !== opts.courseId ? cards.find(c => c.id === opts.courseBId && c.kind === 'course') : undefined
  const books = [...new Set(opts.textbookIds)].map(id => cards.find(c => c.id === id && c.kind === 'textbook')).filter((c): c is NonNullable<typeof c> => !!c)
  if (!A) return emptyResult('请先选一份机构大纲（A）', { subject, perKp })
  const head = { subject, perKp, course: { id: A.id, name: A.name }, courseB: B ? { id: B.id, name: B.name } : null, textbooks: books.map(b => ({ id: b.id, name: b.name })) }
  const needMatch = (c: { name: string; match: { state: string } }): string => c.match.state === 'none' ? `「${c.name}」还没有把知识点对应到课，请先到“课程大纲”里开始匹配` : c.match.state === 'stale' ? `「${c.name}」的课程内容更新过，需要先重新匹配知识点` : ''
  for (const c of [A, B, ...books]) { const r = c ? needMatch(c) : ''; if (r) return emptyResult(r, head) }

  const scope = paperScope(filter)
  const counts = scopeCounts(db, scope)
  const stat = new Map(nodeStats(db, scope).map(n => [n.code, n]))
  const kpRows = new Map((db.prepare('SELECT code, parent_code, name, level, sort, hint_words FROM kps').all() as any[]).map(r => [r.code as string, r]))
  const sub = subtree(db)
  const nameOf = (c: string) => safeKpName(kpRows.get(c)?.name ?? c)
  const minPapers = Math.max(2, Math.ceil(counts.papers * 0.3))
  const smallSample = counts.papers < GAP_MIN_PAPERS
  const ancestors = (c: string): string[] => { const out: string[] = []; let cur = kpRows.get(c)?.parent_code as string | null | undefined; for (let i = 0; cur && i < 6; i++) { out.push(cur); cur = kpRows.get(cur)?.parent_code } return out }
  const topOf = (c: string): { code: string; name: string } => { let cur = c; for (let i = 0; i < 8; i++) { const p = kpRows.get(cur)?.parent_code as string | null | undefined; if (!p || !kpRows.has(p)) break; cur = p } return { code: cur, name: nameOf(cur) } }

  // 知识点 → 课（某个体系内）
  type ByKp = Map<string, Set<number>>
  const byKpOf = (outlineId: string): ByKp => { const m: ByKp = new Map(); for (const x of mainMaps(db, outlineId)) { if (!m.has(x.kp_code)) m.set(x.kp_code, new Set()); m.get(x.kp_code)!.add(x.lesson_id) } return m }
  /** 自己、子孙 = 直接；只有祖先 = 较粗 */
  const relatedLessons = (byKp: ByKp, code: string): { direct: number[]; coarse: number[] } => {
    const direct = new Set<number>(), coarse = new Set<number>()
    for (const c of sub.get(code) ?? [code]) for (const l of byKp.get(c) ?? []) direct.add(l)
    for (const c of ancestors(code)) for (const l of byKp.get(c) ?? []) if (!direct.has(l)) coarse.add(l)
    return { direct: [...direct], coarse: [...coarse] }
  }
  const hasRelated = (codes: Set<string>, c: string): boolean => [...(sub.get(c) ?? [c]), ...ancestors(c)].some(x => codes.has(x))

  const aLessons = lessonsOf(db, A.id, A.name)
  const aMap = byKpOf(A.id)
  const aByLesson = new Map<number, string[]>()
  for (const [code, ls] of aMap) for (const l of ls) { if (!aByLesson.has(l)) aByLesson.set(l, []); aByLesson.get(l)!.push(code) }

  const bInfo = B ? new Map(lessonsOf(db, B.id, B.name).map(l => [l.id, l])) : new Map<number, LessonInfo>()
  const bMap: ByKp = B ? byKpOf(B.id) : new Map()
  const tbs = books.map(b => ({ b, info: new Map(lessonsOf(db, b.id, b.name).map(l => [l.id, l])), byKp: byKpOf(b.id) }))

  const locsOf = (code: string): TbLoc[] => {
    const out: TbLoc[] = []
    for (const t of tbs) {
      const r = relatedLessons(t.byKp, code)
      const pick = (ids: number[], coarse: boolean, max: number) => ids.map(id => t.info.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).slice(0, max).map(l => ({ outlineId: t.b.id, outlineName: t.b.name, levelName: l.levelName, label: l.label, title: l.title, pages: l.pages, coarse }))
      const d = pick(r.direct, false, 4)
      out.push(...(d.length ? d : pick(r.coarse, true, 2)))
    }
    return out
  }
  const bRefsOf = (code: string): BRef[] => {
    if (!B) return []
    const r = relatedLessons(bMap, code)
    const ref = (ids: number[], coarse: boolean) => ids.map(id => bInfo.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).map(l => ({ levelName: l.levelName, label: l.label, coarse }))
    const d = ref(r.direct, false)
    return d.length ? d : ref(r.coarse, true)
  }

  const exampleCache = new Map<string, ExampleQ[]>()
  const examplesOf = (code: string): ExampleQ[] => {
    const hit = exampleCache.get(code)
    if (hit) return hit
    const rows = exampleRows(db, scope, code, perKp * 6 + 12)
    // 易错优先；同一份卷子尽量不重复出现（先每份卷子一道，不够再补）
    const seen = new Set<string>(), first: ExampleQ[] = [], rest: ExampleQ[] = []
    for (const r of rows) { (seen.has(r.paperId) ? rest : first).push(r); seen.add(r.paperId) }
    const out = [...first, ...rest].slice(0, perKp)
    exampleCache.set(code, out)
    return out
  }

  const kpCache = new Map<string, RKp>()
  const kpOf = (code: string): RKp => {
    let k = kpCache.get(code)
    if (!k) {
      const st = stat.get(code)
      const g = topOf(code)
      const papers = st?.papers ?? 0
      k = { code, name: nameOf(code), group: g.name, groupCode: g.code, papers, paperTotal: counts.papers, questions: st?.questions ?? 0, errorCount: st?.errorCount ?? 0, frequent: !smallSample && papers >= minPapers, locs: locsOf(code), examples: examplesOf(code), bLessons: bRefsOf(code) }
      kpCache.set(code, k)
    }
    return k
  }
  /** 轻量版：只有名字和校内统计，不查教材位置 / 例题（只为「要对齐」排顺序用） */
  const lightKp = (code: string): RKp => {
    const st = stat.get(code)
    return { code, name: nameOf(code), group: '', groupCode: '', papers: st?.papers ?? 0, paperTotal: counts.papers, questions: st?.questions ?? 0, errorCount: st?.errorCount ?? 0, frequent: false, locs: [], examples: [], bLessons: [] }
  }
  const kpOrder = (x: RKp, y: RKp) => (y.errorCount > 0 ? 1 : 0) - (x.errorCount > 0 ? 1 : 0) || y.papers - x.papers || y.questions - x.questions || (kpRows.get(x.code)?.sort ?? 0) - (kpRows.get(y.code)?.sort ?? 0) || (x.code < y.code ? -1 : 1)
  const groupOrder = (a: string, b: string) => (kpRows.get(a)?.sort ?? 0) - (kpRows.get(b)?.sort ?? 0) || (a < b ? -1 : 1)

  // 教材有、A 没讲（复用 compare.ts）
  let tbNotInA: TbNotInA[] = []
  const tbUnitKps = new Map<string, Set<string>>()   // 教材单元（outlineId|lessonId）→ 知识点
  if (books.length) {
    const cmp = compareCourseTextbook(db, filter, A.id, books.map(b => b.id))
    if (!cmp.ready) return emptyResult(cmp.reason, head)
    tbNotInA = cmp.uncovered.map(u => ({ code: u.code, name: u.name, group: topOf(u.code).name, units: u.units, papers: u.papers, paperTotal: u.paperTotal, errorCount: u.errorCount, frequent: !smallSample && u.papers >= minPapers }))
    for (const t of tbs) for (const [code, ls] of t.byKp) for (const l of ls) { const key = `${t.b.id}|${l}`; if (!tbUnitKps.has(key)) tbUnitKps.set(key, new Set()); tbUnitKps.get(key)!.add(code) }
  }
  const uncoveredByCode = new Map(tbNotInA.map(u => [u.code, u]))

  // 每节课
  const lessons: RLesson[] = []
  const runningMax = new Map<string, number>()   // 教材 id → 前面各课里最靠后的教材位置
  for (const l of aLessons) {
    const codes = aByLesson.get(l.id) ?? []
    if (opts.lessonFilter && !opts.lessonFilter(l)) {
      alignAdvice({ tbs, relatedLessons, runningMax }, codes.map(lightKp), [])   // 不在要的课里：只更新「前面已讲到哪一册」
      continue
    }
    const kps = codes.map(kpOf).sort((x, y) => groupOrder(x.groupCode, y.groupCode) || kpOrder(x, y))
    const groups: RLesson['groups'] = []
    for (const k of kps) { let g = groups.find(x => x.code === k.groupCode); if (!g) { g = { name: k.group, code: k.groupCode, kps: [] }; groups.push(g) } g.kps.push(k) }
    const cw = opts.courseware?.(A.id, l.levelName, l.seq) ?? []
    const advice = adviceOf({ lesson: l, kps, cw, books: tbs.map(t => t.b), hasBooks: books.length > 0, smallSample, minPapers, paperTotal: counts.papers, uncoveredByCode, tbUnitKps, tbs, aCodes: aMap, relatedLessons, kpOf, kpRows, runningMax })
    lessons.push({ lessonId: l.id, outlineId: A.id, levelName: l.levelName, seq: l.seq, noLabel: l.noLabel, label: l.label, title: l.title, groups, kps, courseware: cw.map(c => ({ id: c.id, name: c.name, chars: c.text.length })), advice, aiAdvice: '' })
  }

  // 只有 A 讲 / 只有 B 讲
  let onlyA: OnlyRow[] = [], onlyB: OnlyRow[] = []
  if (B) {
    const aCodes = new Set(aMap.keys()), bCodes = new Set(bMap.keys())
    const lessonNames = (info: Map<number, LessonInfo>, ids: Set<number>) => [...ids].map(id => info.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).map(x => `${x.levelName} ${x.label}`)
    const aInfo = new Map(aLessons.map(x => [x.id, x]))
    const row = (code: string, ls: string[]): OnlyRow => { const k = kpOf(code); return { code, name: k.name, group: k.group, lessons: ls, papers: k.papers, paperTotal: counts.papers } }
    const sortRows = (r: OnlyRow[]) => r.sort((x, y) => groupOrder(topOf(x.code).code, topOf(y.code).code) || y.papers - x.papers || (x.code < y.code ? -1 : 1))
    onlyA = sortRows([...aCodes].filter(c => !hasRelated(bCodes, c)).map(c => row(c, lessonNames(aInfo, aMap.get(c)!))))
    onlyB = sortRows([...bCodes].filter(c => !hasRelated(aCodes, c)).map(c => row(c, lessonNames(bInfo, bMap.get(c)!))))
  }

  const allKps = new Set(lessons.flatMap(x => x.kps.map(k => k.code)))
  const summary = {
    lessons: lessons.length, kps: allKps.size, kpsWithExamples: [...allKps].filter(c => kpOf(c).examples.length > 0).length,
    examples: [...allKps].reduce((n, c) => n + kpOf(c).examples.length, 0), adviceItems: lessons.reduce((n, x) => n + x.advice.length, 0),
    coursewareFiles: lessons.reduce((n, x) => n + x.courseware.length, 0), onlyA: onlyA.length, onlyB: onlyB.length, tbNotInA: tbNotInA.length
  }
  return { ready: true, reason: '', ...head, papers: counts.papers, minPapers, smallSample, lessons, onlyA, onlyB, tbNotInA, summary }
}

/** 范围内考到这个知识点（含子树）的原题：易错 → 主知识点 → 新学年优先；有题干的才算 */
function exampleRows(db: Db, scope: PaperScope, code: string, limit: number): ExampleQ[] {
  const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT q.id, q.paper_id, p.title, q.no_label, q.no, q.stem, q.options, q.answer, q.error_prone, q.error_reason, MAX(k.is_primary) AS prim
    FROM closure c
    CROSS JOIN question_kps k ON k.kp_code = c.code
    CROSS JOIN questions q ON q.id = k.question_id
    CROSS JOIN papers p ON p.id = q.paper_id
    WHERE c.anc = ? AND ${scope.where} AND q.stem IS NOT NULL AND q.stem <> ''
    GROUP BY q.id
    ORDER BY q.error_prone DESC, prim DESC, p.school_year_start DESC, p.created_at, p.rowid, q.ord
    LIMIT ?`).all(code, ...scope.params, limit) as any[]
  return rows.map(r => ({
    id: r.id, paperId: r.paper_id, paperTitle: r.title ?? '', no: r.no_label ?? String(r.no ?? ''), stem: String(r.stem ?? ''),
    options: json<string[]>(r.options, []).map(String), answer: String(r.answer ?? ''), errorProne: !!r.error_prone, errorReason: String(r.error_reason ?? '')
  }))
}

// ───────────────────────── 修订建议（程序规则） ─────────────────────────

interface AdviceCtx {
  lesson: LessonInfo; kps: RKp[]; cw: CwInput[]; books: Array<{ id: string; name: string }>; hasBooks: boolean
  smallSample: boolean; minPapers: number; paperTotal: number
  uncoveredByCode: Map<string, TbNotInA>
  tbUnitKps: Map<string, Set<string>>
  tbs: Array<{ b: { id: string; name: string }; info: Map<number, LessonInfo>; byKp: Map<string, Set<number>> }>
  aCodes: Map<string, Set<number>>
  relatedLessons: (byKp: Map<string, Set<number>>, code: string) => { direct: number[]; coarse: number[] }
  kpOf: (code: string) => RKp
  kpRows: Map<string, any>
  runningMax: Map<string, number>
}

/** 一个知识点在教材里直接出现在这么多个册次以上，就当螺旋式知识点，不拿它判断顺序 */
const SPIRAL_LEVELS = 3
const locText = (l: TbLoc): string => `${l.outlineName === l.levelName ? '' : `${l.outlineName} `}${l.levelName} ${l.label}${l.pages ? `（${l.pages}）` : ''}${l.coarse ? '（较粗）' : ''}`.replace(/\s+/g, ' ').trim()
const schoolText = (k: RKp): string => `校内 ${k.papers}/${k.paperTotal} 份卷子考过、共 ${k.questions} 题${k.errorCount ? `、其中 ${k.errorCount} 题易错` : ''}`

/** 课件里有没有提到这个知识点：知识点名，或词表里长一点的词，出现在课件文字里就算 */
export function courseMentions(textNorm: string, name: string, hintWords: string): boolean {
  const cands = [name, ...String(hintWords ?? '').split(/[,，、;；\s/|]+/)].map(norm).filter(w => w.length >= 2)
  return cands.some(w => textNorm.includes(w))
}

/** 要对齐：按知识点判断。出现在 ≥3 个册次的螺旋式知识点跳过；取这节课的主知识点
 *  （教材里有直接对应、非较粗；校内题最多 → 卷子最多）的位置，和前面已讲到的最靠后位置比，倒置才提示 */
function alignAdvice(c: Pick<AdviceCtx, 'tbs' | 'relatedLessons' | 'runningMax'>, kps: RKp[], out: AdviceItem[]): void {
  for (const t of c.tbs) {
    let main: { k: RKp; ord: number; at: LessonInfo } | null = null
    for (const k of kps) {
      const us = c.relatedLessons(t.byKp, k.code).direct.map(id => t.info.get(id)).filter((x): x is LessonInfo => !!x)
      if (!us.length) continue
      if (new Set(us.map(u => u.levelIdx)).size >= SPIRAL_LEVELS) continue
      const first = us.reduce((m, u) => (u.levelIdx * 10000 + u.seq < m.levelIdx * 10000 + m.seq ? u : m))
      const better = !main || k.questions > main.k.questions || (k.questions === main.k.questions && k.papers > main.k.papers)
      if (better) main = { k, ord: first.levelIdx * 10000 + first.seq, at: first }
    }
    if (!main) continue
    const { ord, at } = main
    const prev = c.runningMax.get(t.b.id)
    if (prev !== undefined && Math.floor(ord / 10000) < Math.floor(prev / 10000)) {
      const basis = [`本节主要知识点「${main.k.name}」最早出现在教材 ${t.b.name === at.levelName ? '' : `${t.b.name} `}${at.levelName} ${at.label}`.replace(/\s+/g, ' '), '前面的课已经讲到教材里更靠后的册']
      out.push({ kind: 'align', kpCode: main.k.code, basis, text: `和《${t.b.name}》的册次顺序不一致：${basis.join('；')}。` })
    }
    c.runningMax.set(t.b.id, Math.max(prev ?? ord, ord))
  }
}

function adviceOf(c: AdviceCtx): AdviceItem[] {
  const out: AdviceItem[] = []
  const hasCw = c.cw.length > 0
  const text = norm(c.cw.map(x => x.text).join('\n'))
  const mentioned = (k: RKp): boolean => courseMentions(text, k.name, c.kpRows.get(k.code)?.hint_words ?? '')
  const relevant = (k: RKp): boolean => k.frequent || k.locs.some(l => !l.coarse) || k.errorCount > 0

  // 要补（课件里没有）：大纲说这节讲、学校考 / 教材有，课件里却没出现
  if (hasCw) {
    for (const k of c.kps.filter(x => relevant(x) && !mentioned(x)).slice(0, 6)) {
      const basis = [schoolText(k), ...(k.locs.length ? [`教材：${k.locs.slice(0, 2).map(locText).join('；')}`] : []), `课件「${c.cw.map(x => x.name).join('、')}」里没有出现「${k.name}」`]
      out.push({ kind: 'add', kpCode: k.code, basis, text: `「${k.name}」：${basis.join('；')}。` })
    }
  }
  // 要补（同一教材单元里还考到、A 整份大纲都没讲）
  if (c.hasBooks) {
    const seen = new Set<string>()
    const cand: Array<{ code: string; unit: string }> = []
    for (const t of c.tbs) for (const k of c.kps) {
      const r = c.relatedLessons(t.byKp, k.code)
      for (const lid of r.direct) {
        const u = t.info.get(lid)
        for (const code of c.tbUnitKps.get(`${t.b.id}|${lid}`) ?? []) {
          if (seen.has(code) || !c.uncoveredByCode.has(code)) continue
          seen.add(code)
          cand.push({ code, unit: `${t.b.name === u?.levelName ? '' : `${t.b.name} `}${u?.levelName ?? ''} ${u?.label ?? ''}`.replace(/\s+/g, ' ').trim() })
        }
      }
    }
    cand.sort((x, y) => { const a = c.uncoveredByCode.get(x.code)!, b = c.uncoveredByCode.get(y.code)!; return b.papers - a.papers || b.errorCount - a.errorCount || (x.code < y.code ? -1 : 1) })
    for (const x of cand.slice(0, 4)) {
      const u = c.uncoveredByCode.get(x.code)!
      const basis = [`与本节知识点同在教材 ${x.unit}`, `机构大纲 A 整份都没有讲到「${u.name}」`, `校内 ${u.papers}/${u.paperTotal} 份卷子考过${u.errorCount ? `、${u.errorCount} 题易错` : ''}`]
      out.push({ kind: 'add', kpCode: x.code, basis, text: `「${u.name}」：${basis.join('；')}。` })
    }
  }
  alignAdvice(c, c.kps, out)
  // 换例题：常考 / 易错、有校内原题的知识点，建议用原题做例题
  const swap = c.kps.filter(k => k.examples.length && (k.frequent || k.errorCount > 0)).slice(0, 4)
  for (const k of swap) {
    const e = k.examples[0]
    const used = hasCw && norm(c.cw.map(x => x.text).join('\n')).includes(norm(e.stem).slice(0, 14))
    if (used) continue
    const basis = [schoolText(k), `原题：《${oneLine(e.paperTitle, 30)}》第 ${e.no} 题${e.errorProne ? '（易错）' : ''}`]
    out.push({ kind: 'swap', kpCode: k.code, basis, text: `「${k.name}」建议用校内原题做例题：${basis.join('；')}。` })
  }
  // 可减或超前：这节讲了，教材和校内都没考
  if (c.hasBooks || !c.smallSample) {
    for (const k of c.kps.filter(x => x.papers === 0 && (!c.hasBooks || x.locs.length === 0) && (!hasCw || mentioned(x))).slice(0, 5)) {
      const basis = [c.hasBooks ? '所选教材里没有对应单元' : '没有选教材', `校内 0/${c.paperTotal} 份卷子考过`, hasCw ? '课件里讲了' : '大纲里列了']
      out.push({ kind: 'trim', kpCode: k.code, basis, text: `「${k.name}」：${basis.join('；')}，可以考虑精简，或当作拓展。` })
    }
  }
  return out
}

/** 一节课的修订建议拼成一格文字（Excel 的「修订建议」列、界面预览都用它） */
export function adviceCell(l: Pick<RLesson, 'advice' | 'aiAdvice' | 'courseware'>): string {
  const lines: string[] = []
  if (l.aiAdvice) lines.push(`小结：${l.aiAdvice}`)
  for (const a of l.advice) lines.push(`【${ADVICE_LABEL[a.kind]}】${a.text}`)
  if (!l.advice.length) lines.push(l.courseware.length ? '没有发现需要改的地方。' : '暂无建议（挂上这一节的课件后，可以判断要补 / 可减的内容）。')
  return lines.join('\n')
}

/** 按名字找大纲：先全名相等，再包含；找不到或有多个都返回说明（助手工具、界面都用） */
export function findOutlineByName(db: Db, subject: unknown, name: string | undefined, kind: 'course' | 'textbook'): { outline: { id: string; name: string } } | { error: string } {
  const all = listOutlines(db, asSubject(subject)).filter(o => o.status === 'active' && o.kind === kind)
  const label = kind === 'course' ? '机构大纲' : '教材'
  if (!all.length) return { error: kind === 'course' ? '软件里还没有机构大纲，请先到“课程”里上传。' : '软件里还没有添加教材，请先到“课程”里添加内置教材或上传教材。' }
  const t = (name ?? '').trim().replace(/[《》]/g, '')
  if (!t) return all.length === 1 ? { outline: { id: all[0].id, name: all[0].name } } : { error: `请指定${label}的名字。现有：${all.map(o => `《${o.name}》`).join('、')}` }
  const exact = all.filter(o => o.name === t)
  const hit = exact.length ? exact : all.filter(o => o.name.includes(t) || t.includes(o.name))
  if (hit.length === 1) return { outline: { id: hit[0].id, name: hit[0].name } }
  return { error: hit.length ? `「${t}」匹配到多个${label}，请写得更具体：${hit.map(o => `《${o.name}》`).join('、')}` : `没有找到叫「${t}」的${label}。现有：${all.map(o => `《${o.name}》`).join('、')}` }
}

/** 知识点在各教材里的位置（教材定位工具用）：自己 / 子孙 = 直接；只有祖先 = 较粗。bookIds 缺省 = 本学科全部教材 */
export function locateInTextbooks(db: Db, subject: unknown, codes: string[], bookIds?: string[]): { books: Array<{ id: string; name: string }>; byCode: Map<string, TbLoc[]> } {
  const sub = asSubject(subject)
  const books = listOutlines(db, sub).filter(o => o.status === 'active' && o.kind === 'textbook' && (!bookIds || bookIds.includes(o.id)))
  const subs = subtree(db)
  const parent = new Map((db.prepare('SELECT code, parent_code FROM kps').all() as any[]).map(r => [r.code as string, r.parent_code as string | null]))
  const anc = (c: string): string[] => { const out: string[] = []; let cur = parent.get(c); for (let i = 0; cur && i < 6; i++) { out.push(cur); cur = parent.get(cur) } return out }
  const byCode = new Map<string, TbLoc[]>()
  const per = books.map(b => {
    const info = new Map(lessonsOf(db, b.id, b.name).map(l => [l.id, l]))
    const m = new Map<string, Set<number>>()
    for (const x of mainMaps(db, b.id)) { if (!m.has(x.kp_code)) m.set(x.kp_code, new Set()); m.get(x.kp_code)!.add(x.lesson_id) }
    return { b, info, m }
  })
  for (const code of codes) {
    const out: TbLoc[] = []
    for (const { b, info, m } of per) {
      const direct = new Set<number>(), coarse = new Set<number>()
      for (const c of subs.get(code) ?? [code]) for (const l of m.get(c) ?? []) direct.add(l)
      for (const c of anc(code)) for (const l of m.get(c) ?? []) if (!direct.has(l)) coarse.add(l)
      const pick = (ids: Set<number>, isCoarse: boolean) => [...ids].map(id => info.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).map(l => ({ outlineId: b.id, outlineName: b.name, levelName: l.levelName, label: l.label, title: l.title, pages: l.pages, coarse: isCoarse }))
      const d = pick(direct, false)
      out.push(...(d.length ? d : pick(coarse, true)))
    }
    byCode.set(code, out)
  }
  return { books: books.map(b => ({ id: b.id, name: b.name })), byCode }
}

const tableCache = new Map<string, ResearchTable>()
const TABLE_CACHE_MAX = 4

/** 带上数据目录里挂的课件（按节）再生成。结果按「库里数据有没有被写过 + 大纲版本 + 教材 + 筛选 + 每题例题数 + 课件索引」缓存在内存里（最多 4 份），
 *  窗口重新聚焦、重复点击时不再重算；返回的是副本，调用方可以随便改（比如写 AI 小结）。带 lessonFilter 的不缓存。 */
export function researchTableWithCourseware(db: Db, dataDir: string, filter: StatsFilter, opts: Omit<ResearchOptions, 'courseware'>): ResearchTable {
  const build = () => researchTable(db, filter, { ...opts, courseware: (outlineId, levelName, seq) => coursewareOfLesson(dataDir, outlineId, lessonKey(levelName, seq)).map(c => ({ id: c.id, name: c.name, text: c.text })) })
  if (opts.lessonFilter) return build()
  let key = ''
  try {
    const ids = [...new Set([opts.courseId, opts.courseBId ?? '', ...opts.textbookIds].filter(Boolean))]
    const revs = ids.map(id => `${id}:${(db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(id) as any)?.rev ?? '-'}`)
    // total_changes()：这个连接写过多少行；试卷、题目、对应、知识点任何改动都会让它变，所以不会读到旧数据
    const changes = Number((db.prepare('SELECT total_changes() AS n').get() as any)?.n ?? -1)
    const cw = listCourseware(dataDir, opts.courseId).map(c => `${c.id}@${c.addedAt}`).join(',')
    key = JSON.stringify([changes, revs, opts.textbookIds, opts.courseBId ?? '', filter, clampPerKp(opts.perKp ?? DEFAULT_PER_KP), cw])
  } catch { key = '' }
  const hit = key ? tableCache.get(key) : undefined
  if (hit) { tableCache.delete(key); tableCache.set(key, hit); return structuredClone(hit) }
  const t = build()
  if (key) { tableCache.set(key, structuredClone(t)); while (tableCache.size > TABLE_CACHE_MAX) tableCache.delete(tableCache.keys().next().value as string) }
  return t
}

export { lessonKey }
