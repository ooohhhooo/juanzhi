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
import { classifyMaps, evidenceOf, scoreLabel, selectMain } from './score.ts'
import type { MapRole } from './score.ts'
import { GAP_MIN_PAPERS, subtree } from './stats.ts'
import { listOutlines } from './store.ts'
import { lessonName } from './map.ts'
import { compareCourseTextbook } from './compare.ts'
import { importanceOf, kpImportance } from './importance.ts'
import { isUnverifiedNote, matchExample, matchUnit, patternTerms, pickUnits, similarityLabel, vocabTerms } from './lesson-match.ts'
import type { ExampleMatch, LessonKp, LessonText, QuestionInfo, ReviewState, UnitInfo } from './lesson-match.ts'
import { findEdition } from './catalog.ts'
import { parseBuiltinId } from './textbook-builtin.ts'
import { formatLoc } from '../../shared/tb-loc.ts'
import { coursewareOfLesson, lessonKey, listCourseware } from './courseware.ts'
import { listBooks } from '../bookindex/store.ts'
import { searchQuestion } from '../bookindex/search.ts'
import { bookUnitHits, pickBookUnits } from './book-hit.ts'

type Db = any

export const DEFAULT_PER_KP = 3
export const MAX_PER_KP = 10
export const clampPerKp = (n: unknown): number => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.min(MAX_PER_KP, Math.max(1, v)) : DEFAULT_PER_KP }

export interface CwInput { id: string; name: string; text: string }
/** 某一节挂的课件（含全文，只用来判断「讲没讲到」，不进结果表） */
export type CoursewareLookup = (outlineId: string, levelName: string, seq: number) => CwInput[]

/** 只要其中几节课时给：不命中的课不算例题 / 建议，只保留「要对齐」需要的顺序信息（助手的 lesson_kps 用） */
export type LessonPick = (l: { id: number; levelName: string; seq: number; noLabel: string; label: string; title: string }) => boolean
export interface ResearchOptions { /** 试卷范围的默认：和所选教材同年级的全部试卷（筛选条件里没写年级时才用；老师在“更多设置”里选了年级就听老师的） */ grades?: string[]; courseId: string; courseBId?: string; textbookIds: string[]; perKp?: number; courseware?: CoursewareLookup; lessonFilter?: LessonPick }

export interface ExampleQ { id: string; paperId: string; paperTitle: string; no: string; stem: string; options: string[]; answer: string; errorProne: boolean; errorReason: string; /** 题目的知识点审核状态：老师审核过 / 自动通过 / 没审核 */ review?: ReviewState; /** 为什么挂在这节课下（题里有课上的词 / 句型，知识点相同） */ why?: string }
export interface TbLoc { outlineId: string; outlineName: string; /** 版本显示名（内置教材取目录里的版本名；上传的教材用它自己的名字） */ edition: string; levelName: string; label: string; title: string; pages: string; coarse: boolean }
export interface BRef { levelName: string; label: string; coarse: boolean }
export interface RKp {
  code: string; name: string; group: string; groupCode: string
  /** 范围内在几份卷子里考到 / 总份数 / 题数 / 易错题数 */
  papers: number; paperTotal: number; questions: number; errorCount: number
  frequent: boolean
  /** 这节课 × 这个知识点的匹配把握：很像 / 比较像（界面只显示文字；matchScore 0–100 只给 Excel 和排序） */
  matchScore: number
  matchLabel: string
  /** 依据：命中词 / 原文 / 对标教材 */
  evidence: string
  /** 这条「课 ↔ 知识点」是怎么得出来的：规则命中词 / 原文 / 老师确认（没有 = 只是 AI 的判断，不当独立依据） */
  basis?: 'rule' | 'quote' | 'teacher'
  basisText?: string
  /** 校内约占几分（每份卷子平均）/ 易错率 / 排序用的重要度 × 匹配分 */
  avgScore: number
  errorRate: number
  weight: number
  /** 各教材里的位置（直接对应优先；只有祖先对应时才给，并标较粗） */
  locs: TbLoc[]
  examples: ExampleQ[]
  /** 选了 B 时，B 里对应的课 */
  bLessons: BRef[]
}
/** 这节课对应的教材单元（程序直接拿课和单元比出来的，不绕知识点代码） */
export interface UnitRef extends TbLoc { score: number; similarity: string; evidence: string; /** 只是按目录概括的单元（界面加小字「按目录」） */ byCatalog: boolean; /** 书库命中时：书 id#单元 key（内部用，给原题加分） */ unitKey?: string; /** 书库命中时：这个单元在教材目录里对应的知识点（内部用） */ unitKps?: string[]; /** 在上传的整本教材原文里逐字搜到的（书库命中；强依据，界面标「课本原文」） */ byBook?: boolean }
export type AdviceKind = 'add' | 'align' | 'swap' | 'trim'
export const ADVICE_LABEL: Record<AdviceKind, string> = { add: '要补', align: '要对齐', swap: '换例题', trim: '可减或超前' }
export interface AdviceItem { kind: AdviceKind; text: string; /** 依据（程序算出来的事实，AI 润色时只能引用它们） */ basis: string[]; kpCode?: string }
export interface RLesson {
  lessonId: number; outlineId: string; levelName: string; seq: number; label: string; title: string
  /** 大纲里写的课次编号（可能和 seq 不同，如“第 5 课”排在第 3 位） */
  noLabel?: string
  groups: Array<{ name: string; code: string; kps: RKp[] }>
  kps: RKp[]
  /** 对应的教材单元（每个版本最像的 1–2 个，带依据） */
  units: UnitRef[]
  courseware: Array<{ id: string; name: string; chars: number }>
  advice: AdviceItem[]
  /** AI 写的一两句话（没配 AI 时为空，只有规则结论） */
  aiAdvice: string
}
export interface OnlyRow { code: string; name: string; group: string; lessons: string[]; papers: number; paperTotal: number }
export interface TbNotInA { code: string; name: string; group: string; units: string[]; papers: number; paperTotal: number; errorCount: number; frequent: boolean; avgScore?: number }

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
  /** 另有多少条把握不高（或排在每节课前 3 个之后）、没列入对照的；items 最多 60 条，只给老师点开看 */
  weakCount: number
  weak: WeakItem[]
  /** 范围内的试卷有没有填分值（没有就不说“约占几分”） */
  hasScores: boolean
  summary: { lessons: number; kps: number; kpsWithExamples: number; examples: number; adviceItems: number; coursewareFiles: number; onlyA: number; onlyB: number; tbNotInA: number }
}

const emptyResult = (reason: string, over: Partial<ResearchTable> = {}): ResearchTable => ({
  ready: false, reason, subject: 'english', course: null, courseB: null, textbooks: [], papers: 0, minPapers: 2, smallSample: true, perKp: DEFAULT_PER_KP,
  lessons: [], onlyA: [], onlyB: [], tbNotInA: [], weakCount: 0, weak: [], hasScores: false, summary: { lessons: 0, kps: 0, kpsWithExamples: 0, examples: 0, adviceItems: 0, coursewareFiles: 0, onlyA: 0, onlyB: 0, tbNotInA: 0 }, ...over
})

interface MapLite { kp_code: string; lesson_id: number; confidence: string; state: string; source?: string; quote?: string; reason?: string; kind?: string; score?: number }
/** 一个体系里的主要匹配（匹配分过线；机构课程每节课最多 3 个主知识点，教材单元不限）。带分数和依据 */
const mainMaps = (db: Db, outlineId: string): Array<MapLite & { score: number; evidence: string }> => {
  const kind = String((db.prepare('SELECT kind FROM course_outlines WHERE id = ?').get(outlineId) as any)?.kind ?? 'course')
  return selectMain((db.prepare("SELECT kp_code, lesson_id, confidence, state, source, quote, reason FROM course_kp_map WHERE outline_id = ? AND state <> 'rejected'").all(outlineId) as MapLite[]).map(m => ({ ...m, kind }))).map(m => ({ ...m, evidence: evidenceOf(m) }))
}
/** 课 ↔ 知识点的来历：老师确认 / 规则命中词；其他（单靠 AI 判断、教材桥）不算独立依据。书库原文得出的（basis = book）在 examplesForLesson 里另外补上 */
const basisOf = (m: { source?: string; quote?: string; state: string; confidence: string }): { basis?: 'rule' | 'quote' | 'teacher'; basisText?: string } => {
  const q = (m.quote ?? '').trim()
  if (m.state === 'confirmed' || m.source === 'manual') return { basis: 'teacher' }
  if (m.source === 'rule' && q) return { basis: 'rule', basisText: q }
  return {}
}
/** 把握不高、没列入对照的匹配（表下面折叠小字用；只看，不要求操作） */
export interface WeakItem { lesson: string; kp: string; evidence: string }
export const weakOf = (db: Db, outlineId: string, label: (lessonId: number) => string, nameOf: (code: string) => string, max = 60): { count: number; items: WeakItem[] } => {
  const kind = String((db.prepare('SELECT kind FROM course_outlines WHERE id = ?').get(outlineId) as any)?.kind ?? 'course')
  const weak = classifyMaps((db.prepare("SELECT kp_code, lesson_id, confidence, state, source, quote, reason FROM course_kp_map WHERE outline_id = ? AND state <> 'rejected'").all(outlineId) as MapLite[]).map(m => ({ ...m, kind }))).filter(m => m.role === 'weak' || m.role === 'side')
  weak.sort((x, y) => y.score - x.score)
  return { count: weak.length, items: weak.slice(0, max).map(m => ({ lesson: label(m.lesson_id), kp: nameOf(m.kp_code), evidence: evidenceOf(m) || m.reason || '' })) }
}

const PAGE_RE = /第\s*\d+(?:\s*[–\-—~～]\s*\d+)?\s*页/
const json = <T>(s: string | null | undefined, fb: T): T => { try { const v = s ? JSON.parse(s) : fb; return (v ?? fb) as T } catch { return fb } }

interface LessonInfo { theme: string; points: Array<{ kind: string; label?: string; text: string }>; noLabel: string; id: number; outlineId: string; outlineName: string; levelName: string; levelIdx: number; seq: number; label: string; title: string; pages: string }
function lessonsOf(db: Db, outlineId: string, outlineName: string): LessonInfo[] {
  const levelIdx = new Map((db.prepare('SELECT id FROM course_levels WHERE outline_id = ? ORDER BY sort, id').all(outlineId) as any[]).map((r, i) => [r.id as number, i]))
  const rows = db.prepare(`SELECT l.id, l.level_id, l.seq, l.no_label, l.title, l.theme, l.points_json, lv.name level_name FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id
    WHERE l.outline_id = ? ORDER BY lv.sort, lv.id, l.seq, l.id`).all(outlineId) as any[]
  return rows.map(r => {
    const pts = json<Array<{ text?: string }>>(r.points_json, [])
    const pages = pts.map(p => PAGE_RE.exec(String(p?.text ?? ''))?.[0] ?? '').find(Boolean) ?? ''
    return { theme: String(r.theme ?? ''), points: json<Array<{ kind: string; label?: string; text: string }>>(r.points_json, []).filter(x => x && typeof x.text === 'string'), noLabel: String(r.no_label ?? ''), id: r.id, outlineId, outlineName, levelName: r.level_name, levelIdx: levelIdx.get(r.level_id) ?? 0, seq: r.seq, label: lessonName({ seq: r.seq, noLabel: r.no_label ?? '', title: r.title ?? '' }), title: r.title ?? '', pages: pages.replace(/\s+/g, ' ') }
  })
}

/** 教材的版本显示名：内置目录用目录里的版本名，上传的教材用它的名字 */
export const editionNameOf = (c: { name: string; builtinId?: string }): string => { const p = c.builtinId ? parseBuiltinId(c.builtinId) : null; return (p && findEdition(p.editionId)?.edition) || c.name }

const oneLine = (s: string, n: number): string => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 范围默认 = 当前学科、和所选教材同年级的全部试卷；筛选条件里已经有年级 / 指定了试卷就不动 */
export function withGradeScope(db: Db, filter: StatsFilter, grades?: string[]): StatsFilter {
  const gs = [...new Set((grades ?? []).filter(g => /^[1-6]$/.test(g)))]
  if (!gs.length || filter.grade || filter.paperIds) return filter
  if (gs.length === 1) return { ...filter, grade: gs[0] as StatsFilter['grade'] }
  const sc = paperScope(filter)
  const ids = (db.prepare(`SELECT p.id FROM papers p WHERE ${sc.where} AND p.grade IN (${gs.map(() => '?').join(',')}) LIMIT 1000`).all(...sc.params, ...gs) as any[]).map(r => r.id as string)
  return { ...filter, paperIds: ids.length ? ids : ['00000000-0000-4000-8000-000000000000'] }
}

export function researchTable(db: Db, filter0: StatsFilter, opts: ResearchOptions): ResearchTable {
  const filter = withGradeScope(db, filter0, opts.grades)
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
  const imp = kpImportance(db, filter)
  const scoreByKey = new Map<string, { score: number; evidence: string; basis?: 'rule' | 'quote' | 'teacher'; basisText?: string }>()   // 机构大纲 A：课|知识点 → 匹配分、依据
  const nameOf = (c: string) => safeKpName(kpRows.get(c)?.name ?? c)
  const minPapers = Math.max(2, Math.ceil(counts.papers * 0.3))
  const smallSample = counts.papers < GAP_MIN_PAPERS
  const ancestors = (c: string): string[] => { const out: string[] = []; let cur = kpRows.get(c)?.parent_code as string | null | undefined; for (let i = 0; cur && i < 6; i++) { out.push(cur); cur = kpRows.get(cur)?.parent_code } return out }
  const topOf = (c: string): { code: string; name: string } => { let cur = c; for (let i = 0; i < 8; i++) { const p = kpRows.get(cur)?.parent_code as string | null | undefined; if (!p || !kpRows.has(p)) break; cur = p } return { code: cur, name: nameOf(cur) } }

  // 知识点 → 课（某个体系内）
  type ByKp = Map<string, Set<number>>
  const byKpOf = (outlineId: string): ByKp => { const m: ByKp = new Map(); for (const x of mainMaps(db, outlineId)) { if (!m.has(x.kp_code)) m.set(x.kp_code, new Set()); m.get(x.kp_code)!.add(x.lesson_id); scoreByKey.set(`${outlineId}|${x.lesson_id}|${x.kp_code}`, { score: x.score, evidence: x.evidence, ...basisOf(x) }) } return m }
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
  const tbs = books.map(b => ({ b, edition: editionNameOf(b), info: new Map(lessonsOf(db, b.id, b.name).map(l => [l.id, l])), byKp: byKpOf(b.id) }))

  const locsOf = (code: string): TbLoc[] => {
    const out: TbLoc[] = []
    for (const t of tbs) {
      const r = relatedLessons(t.byKp, code)
      const pick = (ids: number[], coarse: boolean, max: number) => ids.map(id => t.info.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).slice(0, max).map(l => ({ outlineId: t.b.id, outlineName: t.b.name, edition: t.edition, levelName: l.levelName, label: l.label, title: l.title, pages: l.pages, coarse }))
      const d = pick(r.direct, false, 12)
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
      k = { code, name: nameOf(code), group: g.name, groupCode: g.code, papers, paperTotal: counts.papers, questions: st?.questions ?? 0, errorCount: st?.errorCount ?? 0, frequent: !smallSample && papers >= minPapers, matchScore: 0, matchLabel: '', evidence: '', avgScore: importanceOf(imp, code).avgScore, errorRate: importanceOf(imp, code).errorRate, weight: 0, locs: locsOf(code), examples: [], bLessons: bRefsOf(code) }
      kpCache.set(code, k)
    }
    return k
  }
  /** 轻量版：只有名字和校内统计，不查教材位置 / 例题（只为「要对齐」排顺序用） */
  const lightKp = (code: string): RKp => {
    const st = stat.get(code)
    return { code, name: nameOf(code), group: '', groupCode: '', papers: st?.papers ?? 0, paperTotal: counts.papers, questions: st?.questions ?? 0, errorCount: st?.errorCount ?? 0, frequent: false, matchScore: 0, matchLabel: '', evidence: '', avgScore: 0, errorRate: 0, weight: 0, locs: [], examples: [], bLessons: [] }
  }
  const kpOrder = (x: RKp, y: RKp) => y.weight - x.weight || (y.errorCount > 0 ? 1 : 0) - (x.errorCount > 0 ? 1 : 0) || y.papers - x.papers || y.questions - x.questions || (kpRows.get(x.code)?.sort ?? 0) - (kpRows.get(y.code)?.sort ?? 0) || (x.code < y.code ? -1 : 1)
  const groupOrder = (a: string, b: string) => (kpRows.get(a)?.sort ?? 0) - (kpRows.get(b)?.sort ?? 0) || (a < b ? -1 : 1)

  /** 这一节课里的这个知识点：知识点的校内统计 + 这节课 × 这个知识点的匹配分和依据；排序用「校内重要度 × 匹配分」 */
  const lessonKp = (code: string, lessonId: number): RKp => {
    const base = kpOf(code)
    const sc = scoreByKey.get(`${A.id}|${lessonId}|${code}`)
    const matchScore = sc?.score ?? 0
    const i = importanceOf(imp, code)
    return { ...base, examples: [], matchScore, matchLabel: scoreLabel(matchScore), evidence: sc?.evidence ?? '', basis: sc?.basis, basisText: sc?.basisText, avgScore: i.avgScore, errorRate: Math.round(i.errorRate * 100) / 100, weight: Math.round(i.weight * matchScore) / 100 }
  }
  const kpNear = (a: string, b: string): boolean => a === b || (sub.get(a) ?? [a]).includes(b) || (sub.get(b) ?? [b]).includes(a)

  // 课 ↔ 教材单元：课的标题 / 主题 / 词汇 / 句型 / 知识点，直接和每个单元比（不调用 AI，同样的输入同样的结果）
  const unitIndex = tbs.map(t => {
    const rev = new Map<number, string[]>()
    for (const [code, ls] of t.byKp) for (const l of ls) { if (!rev.has(l)) rev.set(l, []); rev.get(l)!.push(code) }
    const units: Array<{ info: LessonInfo; u: UnitInfo }> = []
    for (const info of t.info.values()) {
      const body = info.points.filter(p => p.label !== '说明').map(p => p.text).join('、')
      const lines = body.split(/、?(?=(?:话题|核心问题|句型（概括）|句型\(概括\)|句型|语法)[：:])/).map(x => x.trim()).filter(Boolean)
      const note = info.points.filter(p => p.label === '说明').map(p => p.text).join(' ')
      units.push({ info, u: { id: info.id, title: info.title, lines, kps: rev.get(info.id) ?? [], unverified: isUnverifiedNote(note) || lines.some(x => /^句型（概括）|^句型\(概括\)/.test(x)) } })
    }
    return { t, units }
  })
  // 上传过整本教材、建好书库的册：用书的原文逐字搜（强依据）；没有书库的册沿用目录里的单元内容
  const bookOf = new Map<string, string>()
  {
    const all = books.length ? listBooks(db) : []
    for (const b of books) { const hit = all.find(x => x.outlineId === b.id); if (hit) bookOf.set(b.id, hit.id) }
  }
  /** 书库里的单元对应教材课程体系里的哪一课（单元）：先按标题，再按单元号（Unit 2 / 第2单元） */
  const infoOfUnit = (t: (typeof tbs)[number], title: string, key: string): LessonInfo | undefined => {
    const nt = norm(title)
    const infos = [...t.info.values()]
    const byTitle = infos.find(i => { const n = norm(i.title); return n && nt && (n === nt || n.includes(nt) || nt.includes(n)) })
    if (byTitle) return byTitle
    const no = /^unit:(\d+)$/.exec(key)?.[1]
    if (!no) return undefined
    const re = new RegExp(`(?:unit|module|lesson)\\s*${no}(?!\\d)|第\\s*${no}\\s*(?:单元|课|模块)`, 'i')
    return infos.find(i => re.test(i.title) || re.test(i.label))
  }
  const levelOfUnit = (t: (typeof tbs)[number], title: string, key: string): string => {
    const raw = (infoOfUnit(t, title, key) ?? [...t.info.values()][0])?.levelName ?? ''
    return /[一二三四五六七八九]年级(?:上|下|全一|全)册?/.exec(raw)?.[0] ?? raw   // 整本上传时级别名常是文件名：只取「三年级上册」
  }
  const unitKpsOf = (t: (typeof tbs)[number], title: string, key: string): string[] => {
    const info = infoOfUnit(t, title, key)
    if (!info) return []
    const out: string[] = []
    for (const [code, ls] of t.byKp) if (ls.has(info.id)) out.push(code)
    return out
  }
  const bookUnitsOf = (lt: LessonText): UnitRef[] => {
    const byEd = new Map<string, Array<{ t: (typeof tbs)[number]; h: ReturnType<typeof bookUnitHits>[number] }>>()
    for (const t of tbs) {
      const bid = bookOf.get(t.b.id)
      if (!bid) continue
      for (const h of bookUnitHits(db, bid, lt)) { if (!byEd.has(t.edition)) byEd.set(t.edition, []); byEd.get(t.edition)!.push({ t, h }) }
    }
    const out: UnitRef[] = []
    for (const list of byEd.values()) {
      for (const h of pickBookUnits(list.map(x => x.h))) {
        const t = list.find(x => x.h === h)!.t
        out.push({ unitKps: unitKpsOf(t, h.unitTitle, h.unitKey), unitKey: `${h.bookId}#${h.unitKey}`, outlineId: t.b.id, outlineName: t.b.name, edition: t.edition, levelName: levelOfUnit(t, h.unitTitle, h.unitKey), label: '', title: h.unitTitle, pages: `第 ${h.page} 页`, coarse: false, score: h.score, similarity: similarityLabel(h.score), evidence: h.evidence, byCatalog: false, byBook: true })
      }
    }
    return out
  }
  const unitsOf = (lt: LessonText, lessonKps: Array<{ code: string; name: string }>): UnitRef[] => {
    const fromBooks = bookOf.size ? bookUnitsOf(lt) : []
    const haveBook = new Set(fromBooks.map(u => u.outlineId))
    const byEdition = new Map<string, Array<{ ix: (typeof unitIndex)[number]; info: LessonInfo; m: ReturnType<typeof matchUnit> & {} }>>()
    for (const ix of unitIndex) for (const { info, u } of ix.units) {
      if (haveBook.has(ix.t.b.id)) continue   // 这册书库里已经搜到了，不再用目录
      const m = matchUnit(lt, lessonKps, u, kpNear)
      if (!m) continue
      if (!byEdition.has(ix.t.edition)) byEdition.set(ix.t.edition, [])
      byEdition.get(ix.t.edition)!.push({ ix, info, m })
    }
    const out: UnitRef[] = []
    for (const list of byEdition.values()) {
      const chosen = pickUnits(list.map(x => x.m))
      for (const c of chosen) {
        const x = list.find(y => y.m === c)!
        out.push({ outlineId: x.ix.t.b.id, outlineName: x.ix.t.b.name, edition: x.ix.t.edition, levelName: x.info.levelName, label: x.info.label, title: x.info.title, pages: x.info.pages, coarse: false, score: c.score, similarity: similarityLabel(c.score), evidence: c.evidence, byCatalog: c.byCatalog })
      }
    }
    return [...fromBooks, ...out]
  }

  // 课 ↔ 校内原题：课的词汇 / 句型在题干里逐字找，再用题目已审核的知识点代码对上；每节课只列最相关的几道
  const qCache = new Map<string, ExampleQ[]>()
  const rowsOfKp = (code: string): ExampleQ[] => { let r = qCache.get(code); if (!r) { r = exampleRows(db, scope, code, 30); qCache.set(code, r) } return r }
  const examplesForLesson = (lt: LessonText, lessonKps: RKp[], lessonBookUnits: string[] = [], bookKps: string[] = []): Array<{ q: ExampleQ; m: ExampleMatch }> => {
    const pool = new Map<string, ExampleQ>()
    for (const k of lessonKps) for (const q of rowsOfKp(k.code)) pool.set(q.id, q)
    for (const q of textExampleRows(db, scope, [...vocabTerms(lt), ...patternTerms(lt)].slice(0, 14), 60)) pool.set(q.id, q)
    if (!pool.size) return []
    const ids = [...pool.keys()]
    const kpsOf = new Map<string, Array<{ code: string; primary: boolean }>>()
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      for (const r of db.prepare(`SELECT question_id, kp_code, is_primary FROM question_kps WHERE question_id IN (${part.map(() => '?').join(',')})`).all(...part) as any[]) {
        if (!kpsOf.has(r.question_id)) kpsOf.set(r.question_id, [])
        kpsOf.get(r.question_id)!.push({ code: r.kp_code, primary: !!r.is_primary })
      }
    }
    // 课这边的依据：规则命中词 / 老师确认；或者课在书库原文里命中的单元，目录里写着这个知识点（原文得出）
    const lk: LessonKp[] = lessonKps.map(k => ({ code: k.code, name: k.name, strong: k.matchScore >= 72, ...(k.basis ? { basis: k.basis, basisText: k.basisText } : bookKps.some(b => kpNear(k.code, b)) ? { basis: 'book' as const } : {}) }))
    const out: Array<{ q: ExampleQ; m: ExampleMatch }> = []
    const infoOf = (q: ExampleQ, bookUnits?: string[]): QuestionInfo => ({ id: q.id, stem: q.stem, options: q.options, errorProne: q.errorProne, kps: kpsOf.get(q.id) ?? [], review: q.review, bookUnits })
    for (const q of pool.values()) {
      const m = matchExample(lt, lk, infoOf(q), kpNear, lessonBookUnits)
      if (m) out.push({ q, m })
    }
    // 书库加分：题干在书里命中的单元，和课命中的是同一个（只对前几名查，省时间）
    if (lessonBookUnits.length && bookOf.size) {
      const bookIds = [...bookOf.values()]
      out.sort((a, b) => b.m.score - a.m.score)
      for (const x of out.slice(0, Math.max(9, perKp * 3))) {
        const units = searchQuestion(db, [x.q.stem, ...x.q.options].join('\n'), { bookIds, limit: 4 }).hits.filter(h => h.unitKey && h.score >= 55).map(h => `${h.bookId}#${h.unitKey}`)
        if (!units.length) continue
        const m2 = matchExample(lt, lk, infoOf(x.q, units), kpNear, lessonBookUnits)
        if (m2) x.m = m2
      }
    }
    // 最相关的在前；同分易错的在前，再按新学年；同一份卷子尽量不重复
    out.sort((a, b) => b.m.score - a.m.score || (b.q.errorProne ? 1 : 0) - (a.q.errorProne ? 1 : 0) || (a.q.id < b.q.id ? -1 : 1))
    const seen = new Set<string>(), first: typeof out = [], rest: typeof out = []
    for (const x of out) { (seen.has(x.q.paperId) ? rest : first).push(x); seen.add(x.q.paperId) }
    return [...first, ...rest].slice(0, perKp)
  }

  // 教材有、A 没讲（复用 compare.ts）
  let tbNotInA: TbNotInA[] = []
  const tbUnitKps = new Map<string, Set<string>>()   // 教材单元（outlineId|lessonId）→ 知识点
  if (books.length) {
    const cmp = compareCourseTextbook(db, filter, A.id, books.map(b => b.id))
    if (!cmp.ready) return emptyResult(cmp.reason, head)
    tbNotInA = cmp.uncovered.map(u => ({ code: u.code, name: u.name, group: topOf(u.code).name, units: u.units, papers: u.papers, paperTotal: u.paperTotal, errorCount: u.errorCount, frequent: !smallSample && u.papers >= minPapers, avgScore: importanceOf(imp, u.code).avgScore }))
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
    const lt: LessonText = { title: l.title, theme: l.theme, points: l.points.map(p => ({ kind: p.kind, text: p.text })) }
    const raw = codes.map(c => lessonKp(c, l.id))
    // 排序：校内重要度 × 匹配分（高的在前）；知识点大类也按其中最高的排
    const best = new Map<string, number>()
    for (const k of raw) best.set(k.groupCode, Math.max(best.get(k.groupCode) ?? 0, k.weight))
    const kps = raw.sort((x, y) => (best.get(y.groupCode) ?? 0) - (best.get(x.groupCode) ?? 0) || groupOrder(x.groupCode, y.groupCode) || kpOrder(x, y))
    const units = unitIndex.length ? unitsOf(lt, kps.map(k => ({ code: k.code, name: k.name }))) : []
    for (const e of examplesForLesson(lt, kps, units.map(u => u.unitKey).filter((x): x is string => !!x), units.flatMap(u => u.unitKps ?? []))) {
      const target = kps.find(k => k.code === e.m.kpCode) ?? kps[0]
      if (target) target.examples.push({ ...e.q, why: e.m.evidence })
    }
    const groups: RLesson['groups'] = []
    for (const k of kps) { let g = groups.find(x => x.code === k.groupCode); if (!g) { g = { name: k.group, code: k.groupCode, kps: [] }; groups.push(g) } g.kps.push(k) }
    const cw = opts.courseware?.(A.id, l.levelName, l.seq) ?? []
    const advice = adviceOf({ lesson: l, kps, cw, books: tbs.map(t => t.b), hasBooks: books.length > 0, smallSample, minPapers, paperTotal: counts.papers, uncoveredByCode, tbUnitKps, tbs, aCodes: aMap, relatedLessons, kpOf, kpRows, runningMax, subOf: sub })
    lessons.push({ lessonId: l.id, outlineId: A.id, levelName: l.levelName, seq: l.seq, noLabel: l.noLabel, label: l.label, title: l.title, groups, kps, units, courseware: cw.map(c => ({ id: c.id, name: c.name, chars: c.text.length })), advice, aiAdvice: '' })
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

  const lessonLabel = new Map(aLessons.map(x => [x.id, `${x.levelName} ${x.label}`]))
  const wk = weakOf(db, A.id, id => lessonLabel.get(id) ?? '', nameOf)
  const allKps = new Set(lessons.flatMap(x => x.kps.map(k => k.code)))
  const summary = {
    lessons: lessons.length, kps: allKps.size, kpsWithExamples: new Set(lessons.flatMap(x => x.kps.filter(k => k.examples.length > 0).map(k => k.code))).size,
    examples: lessons.reduce((n, x) => n + x.kps.reduce((m, k) => m + k.examples.length, 0), 0), adviceItems: lessons.reduce((n, x) => n + x.advice.length, 0),
    coursewareFiles: lessons.reduce((n, x) => n + x.courseware.length, 0), onlyA: onlyA.length, onlyB: onlyB.length, tbNotInA: tbNotInA.length
  }
  return { ready: true, reason: '', ...head, papers: counts.papers, minPapers, smallSample, lessons, onlyA, onlyB, tbNotInA, weakCount: wk.count, weak: wk.items, hasScores: imp.hasScores, summary }
}

/** 范围内考到这个知识点（含子树）的原题：易错 → 主知识点 → 新学年优先；有题干的才算 */
/** 题的审核状态：对照表只看已确认（审核完成）的试卷，里面的题都算老师审核过；带「自动通过」标记且老师没改过的标 auto，和人工审核区分开 */
const reviewOf = (r: { reviewed?: number; flags_json?: string }): ReviewState => (r.reviewed && json<string[]>(r.flags_json, []).includes('auto_approved') ? 'auto' : 'manual')
function exampleRows(db: Db, scope: PaperScope, code: string, limit: number): ExampleQ[] {
  const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT q.id, q.paper_id, p.title, q.no_label, q.no, q.stem, q.options, q.answer, q.error_prone, q.error_reason, MAX(k.is_primary) AS prim, q.reviewed, q.flags_json
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
    options: json<string[]>(r.options, []).map(String), answer: String(r.answer ?? ''), errorProne: !!r.error_prone, errorReason: String(r.error_reason ?? ''), review: reviewOf(r)
  }))
}

/** 题干里逐字出现这些词 / 句型的原题（SQL 只做粗筛，是否算数由 lesson-match 判断） */
function textExampleRows(db: Db, scope: PaperScope, terms: string[], limit: number): ExampleQ[] {
  const ts = [...new Set(terms.map(t => t.trim()).filter(t => t.length >= 2))].slice(0, 14)
  if (!ts.length) return []
  const like = ts.map(() => "q.stem LIKE ? ESCAPE '\\'").join(' OR ')
  const rows = db.prepare(`SELECT q.id, q.paper_id, p.title, q.no_label, q.no, q.stem, q.options, q.answer, q.error_prone, q.error_reason, q.reviewed, q.flags_json
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
    WHERE ${scope.where} AND q.stem IS NOT NULL AND q.stem <> '' AND (${like})
    ORDER BY q.error_prone DESC, p.school_year_start DESC, p.created_at, p.rowid, q.ord LIMIT ?`).all(...scope.params, ...ts.map(t => `%${t.replace(/[\\%_]/g, m => '\\' + m)}%`), limit) as any[]
  return rows.map(r => ({
    id: r.id, paperId: r.paper_id, paperTitle: r.title ?? '', no: r.no_label ?? String(r.no ?? ''), stem: String(r.stem ?? ''),
    options: json<string[]>(r.options, []).map(String), answer: String(r.answer ?? ''), errorProne: !!r.error_prone, errorReason: String(r.error_reason ?? ''), review: reviewOf(r)
  }))
}

// ───────────────────────── 修订建议（程序规则） ─────────────────────────

interface AdviceCtx {
  lesson: LessonInfo; kps: RKp[]; cw: CwInput[]; books: Array<{ id: string; name: string }>; hasBooks: boolean
  smallSample: boolean; minPapers: number; paperTotal: number
  uncoveredByCode: Map<string, TbNotInA>
  tbUnitKps: Map<string, Set<string>>
  tbs: Array<{ b: { id: string; name: string }; edition: string; info: Map<number, LessonInfo>; byKp: Map<string, Set<number>> }>
  aCodes: Map<string, Set<number>>
  relatedLessons: (byKp: Map<string, Set<number>>, code: string) => { direct: number[]; coarse: number[] }
  kpOf: (code: string) => RKp
  kpRows: Map<string, any>
  runningMax: Map<string, number>
  subOf: Map<string, string[]>
}

/** 一个知识点在教材里直接出现在这么多个册次以上，就当螺旋式知识点，不拿它判断顺序 */
const SPIRAL_LEVELS = 3
/** 每节课「同单元要补」最多列几条 */
export const MAX_ADD_UNIT = 5
const locText = (l: TbLoc): string => formatLoc(l)
const schoolText = (k: RKp): string => `校内 ${k.papers}/${k.paperTotal} 份卷子考过、共 ${k.questions} 题${k.avgScore > 0 ? `、约占 ${k.avgScore} 分` : ''}${k.errorCount ? `、其中 ${k.errorCount} 题易错` : ''}`

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
  // 要补（同一教材单元里还考到、A 整份大纲都没讲）：只挂和这节课知识点有关的（子孙 / 兄弟），或校内常考的；最多 MAX_ADD_UNIT 条，其余合成一句
  if (c.hasBooks) {
    const seen = new Set<string>()
    const cand: Array<{ code: string; unit: string }> = []
    const parentOf = (x: string): string | null => (c.kpRows.get(x)?.parent_code as string | null | undefined) ?? null
    const related = (code: string): boolean => c.kps.some(k => {
      const kp = parentOf(k.code), cp = parentOf(code)
      return (c.subOf.get(k.code) ?? [k.code]).includes(code) || (!!kp && kp === cp)
    })
    for (const t of c.tbs) for (const k of c.kps) {
      const r = c.relatedLessons(t.byKp, k.code)
      for (const lid of r.direct) {
        const u = t.info.get(lid)
        for (const code of c.tbUnitKps.get(`${t.b.id}|${lid}`) ?? []) {
          if (seen.has(code)) continue
          const unc = c.uncoveredByCode.get(code)
          if (!unc || !(unc.frequent || related(code))) continue
          seen.add(code)
          cand.push({ code, unit: formatLoc({ outlineName: t.b.name, edition: t.edition, levelName: u?.levelName ?? '', label: u?.label ?? '', title: u?.title ?? '', pages: '', coarse: false }) })
        }
      }
    }
    cand.sort((x, y) => { const a = c.uncoveredByCode.get(x.code)!, b = c.uncoveredByCode.get(y.code)!; return (b.avgScore ?? 0) - (a.avgScore ?? 0) || (b.frequent ? 1 : 0) - (a.frequent ? 1 : 0) || b.papers - a.papers || b.errorCount - a.errorCount || (x.code < y.code ? -1 : 1) })
    for (const x of cand.slice(0, MAX_ADD_UNIT)) {
      const u = c.uncoveredByCode.get(x.code)!
      const basis = [`与本节知识点同在教材 ${x.unit}`, `机构大纲 A 整份都没有讲到「${u.name}」`, `校内 ${u.papers}/${u.paperTotal} 份卷子考过${(u.avgScore ?? 0) > 0 ? `、约占 ${u.avgScore} 分` : ''}${u.errorCount ? `、${u.errorCount} 题易错` : ''}`]
      out.push({ kind: 'add', kpCode: x.code, basis, text: `「${u.name}」：${basis.join('；')}。` })
    }
    if (cand.length > MAX_ADD_UNIT) {
      const n = cand.length - MAX_ADD_UNIT
      const text = `另有 ${n} 个知识点同在这些单元、机构没讲，见下方“教材有、机构大纲没讲的”。`
      out.push({ kind: 'add', basis: [`另有 ${n} 个知识点同在这些教材单元、机构大纲整份没讲`], text })
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
  if ((c.hasBooks || !c.smallSample) && c.paperTotal > 0) {   // 范围里一份卷子都没有时不说“可减”（什么都没考到是因为没卷子）
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
      const pick = (ids: Set<number>, isCoarse: boolean) => [...ids].map(id => info.get(id)).filter((x): x is LessonInfo => !!x).sort((a, z) => a.levelIdx - z.levelIdx || a.seq - z.seq).map(l => ({ outlineId: b.id, outlineName: b.name, edition: editionNameOf(b), levelName: l.levelName, label: l.label, title: l.title, pages: l.pages, coarse: isCoarse }))
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
