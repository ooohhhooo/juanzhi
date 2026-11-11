/**
 * 「机构课程 vs 学校教材」对比（看板「课程对照」里的第二个视图）。数字全部由程序算，AI 不参与。
 *  · 学校教材每个单元考到的知识点：机构课程哪几课讲到了（有）/ 没讲到（没有）；
 *  · 机构课程讲了、所选教材里没有的知识点（超前 / 拓展）；
 *  · 叠加试卷：学校常考（在较多份卷子里出现）但机构课没覆盖的考点，标成优先。
 * 「讲到」的判断：知识点树上相关就算——机构课对应的知识点是教材知识点自己、它的子孙、或它的祖先（匹配结果常落在二级考点）。
 * 只看高 / 中把握或老师确认过的对应（isMainMap），和看板其余部分一致。
 */
import { nodeStats, scopeCounts } from '../stats/core.ts'
import { paperScope } from '../stats/filter.ts'
import type { StatsFilter } from '../stats/filter.ts'
import { safeKpName } from '../../shared/code-guard.ts'
import { asSubject } from '../../shared/subject.ts'
import { isMainMap } from './match.ts'
import { subtree, GAP_MIN_PAPERS } from './stats.ts'
import { listOutlines } from './store.ts'
import { lessonName } from './map.ts'

type Db = any

/** coarse = 机构课只挂在更大的类别（教材知识点的祖先）上，靠祖先关系算「讲到」，比较粗 */
export interface CompareLesson { lessonId: number; levelName: string; label: string; coarse: boolean }
export interface CompareKp {
  code: string; name: string; plain: string
  /** 在几份卷子里出现（子树汇总）/ 范围内总份数 */
  papers: number; paperTotal: number
  errorCount: number
  /** 学校常考：在不少于 minPapers 份卷子里出现 */
  frequent: boolean
  /** 机构课程里讲到它的课；空 = 没讲到 */
  lessons: CompareLesson[]
  /** 讲到了，但每一课都只是大类对应（较粗） */
  coarseOnly: boolean
}
export interface CompareUnit {
  outlineId: string; outlineName: string; levelName: string; lessonId: number; label: string; title: string
  kps: CompareKp[]
  covered: number; total: number
}
export interface PriorityRow { code: string; name: string; papers: number; paperTotal: number; errorCount: number; units: string[] }
export interface ExtraLesson { lessonId: number; levelName: string; label: string; kps: Array<{ code: string; name: string }>; totalKps: number }

export interface CompareResult {
  ready: boolean
  /** ready = false 时的原因（白话） */
  reason: string
  course: { id: string; name: string } | null
  textbooks: Array<{ id: string; name: string }>
  papers: number
  minPapers: number
  /** 试卷太少（少于 3 份），不标「学校常考」 */
  smallSample: boolean
  units: CompareUnit[]
  /** 教材里考到、机构课没讲到的知识点（去重），常考的在前 */
  uncovered: PriorityRow[]
  /** 其中学校常考的 */
  priority: PriorityRow[]
  /** 机构课讲了、教材里没有 */
  extra: ExtraLesson[]
  summary: { textbookKps: number; covered: number; uncovered: number; priority: number; extraKps: number; extraLessons: number }
}

const emptyResult = (reason: string, over: Partial<CompareResult> = {}): CompareResult => ({
  ready: false, reason, course: null, textbooks: [], papers: 0, minPapers: 2, smallSample: true, units: [], uncovered: [], priority: [], extra: [],
  summary: { textbookKps: 0, covered: 0, uncovered: 0, priority: 0, extraKps: 0, extraLessons: 0 }, ...over
})

interface MapLite { kp_code: string; lesson_id: number; confidence: string; state: string }
const mainMaps = (db: Db, outlineIds: string[]): MapLite[] => {
  const ph = outlineIds.map(() => '?').join(',')
  return (db.prepare(`SELECT kp_code, lesson_id, confidence, state FROM course_kp_map WHERE outline_id IN (${ph}) AND state <> 'rejected'`).all(...outlineIds) as MapLite[]).filter(isMainMap)
}

export function compareCourseTextbook(db: Db, filter: StatsFilter, courseId: string, textbookIds: string[]): CompareResult {
  const subject = asSubject(filter.subject)
  const cards = listOutlines(db, subject).filter(o => o.status === 'active')
  const course = cards.find(c => c.id === courseId && c.kind === 'course')
  const books = textbookIds.map(id => cards.find(c => c.id === id && c.kind === 'textbook')).filter((c): c is NonNullable<typeof c> => !!c)
  if (!course) return emptyResult('请先选一份机构课程')
  if (!books.length) return emptyResult('请至少选一份学校教材', { course: { id: course.id, name: course.name } })
  const head = { course: { id: course.id, name: course.name }, textbooks: books.map(b => ({ id: b.id, name: b.name })) }
  if (course.match.state === 'none' || course.match.state === 'stale') {
    return emptyResult(course.match.state === 'stale' ? `「${course.name}」的课程内容更新过，需要先重新匹配知识点` : `「${course.name}」还没有把知识点对应到课，请先到“课程大纲”里开始匹配`, head)
  }
  const nbooks = books.filter(b => b.match.state === 'none' || b.match.state === 'stale')
  if (nbooks.length) return emptyResult(`「${nbooks[0].name}」还没有把知识点对应到课，请先到“课程大纲”里开始匹配`, head)

  const scope = paperScope(filter)
  const counts = scopeCounts(db, scope)
  const stat = new Map(nodeStats(db, scope).map(n => [n.code, n]))
  const kpRows = new Map((db.prepare('SELECT code, parent_code, name, plain FROM kps').all() as any[]).map(r => [r.code as string, r]))
  const sub = subtree(db)
  const nameOf = (c: string) => safeKpName(kpRows.get(c)?.name ?? c)
  const minPapers = Math.max(2, Math.ceil(counts.papers * 0.3))
  const smallSample = counts.papers < GAP_MIN_PAPERS

  // 机构课：知识点 → 课
  const cLessons = new Map((db.prepare('SELECT l.id, l.seq, l.no_label, l.title, lv.name level_name FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id WHERE l.outline_id = ?').all(course.id) as any[]).map(l => [l.id as number, l]))
  const refOf = (lid: number, coarse = false): CompareLesson | null => {
    const l = cLessons.get(lid)
    return l ? { lessonId: lid, levelName: l.level_name, label: lessonName({ seq: l.seq, noLabel: l.no_label ?? '', title: l.title ?? '' }), coarse } : null
  }
  const courseByKp = new Map<string, Set<number>>()
  for (const m of mainMaps(db, [course.id])) {
    if (!courseByKp.has(m.kp_code)) courseByKp.set(m.kp_code, new Set())
    courseByKp.get(m.kp_code)!.add(m.lesson_id)
  }
  const ancestors = (c: string): string[] => {
    const out: string[] = []
    let cur = kpRows.get(c)?.parent_code as string | null | undefined
    for (let i = 0; cur && i < 6; i++) { out.push(cur); cur = kpRows.get(cur)?.parent_code }
    return out
  }
  /** 机构课里讲到这个教材知识点的课（自己、子孙、祖先） */
  const coursesFor = (code: string): CompareLesson[] => {
    const direct = new Set<number>()
    for (const c of sub.get(code) ?? [code]) for (const l of courseByKp.get(c) ?? []) direct.add(l)
    const coarse = new Set<number>()
    for (const c of ancestors(code)) for (const l of courseByKp.get(c) ?? []) if (!direct.has(l)) coarse.add(l)
    return [...direct.values()].map(l => refOf(l, false)).concat([...coarse].map(l => refOf(l, true))).filter((x): x is CompareLesson => !!x).sort((a, b) => (a.levelName < b.levelName ? -1 : a.levelName > b.levelName ? 1 : 0) || a.lessonId - b.lessonId)
  }

  // 教材：单元 → 知识点
  const units: CompareUnit[] = []
  const tbCodes = new Set<string>()
  const kpCache = new Map<string, CompareKp>()
  const kpInfo = (code: string): CompareKp => {
    let k = kpCache.get(code)
    if (!k) {
      const st = stat.get(code)
      const papers = st?.papers ?? 0
      k = { code, name: nameOf(code), plain: String(kpRows.get(code)?.plain ?? ''), papers, paperTotal: counts.papers, errorCount: st?.errorCount ?? 0, frequent: !smallSample && papers >= minPapers, lessons: [], coarseOnly: false }
      k.lessons = coursesFor(code)
      k.coarseOnly = k.lessons.length > 0 && k.lessons.every(l => l.coarse)
      kpCache.set(code, k)
    }
    return k
  }
  for (const b of books) {
    const lessons = db.prepare(`SELECT l.id, l.seq, l.no_label, l.title, lv.name level_name, lv.sort, o.name outline_name FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id JOIN course_outlines o ON o.id = l.outline_id
      WHERE l.outline_id = ? ORDER BY lv.sort, l.seq, l.id`).all(b.id) as any[]
    const byLesson = new Map<number, string[]>()
    for (const m of mainMaps(db, [b.id])) { if (!byLesson.has(m.lesson_id)) byLesson.set(m.lesson_id, []); byLesson.get(m.lesson_id)!.push(m.kp_code) }
    for (const l of lessons) {
      const codes = [...new Set(byLesson.get(l.id) ?? [])].sort((a, z) => (stat.get(z)?.papers ?? 0) - (stat.get(a)?.papers ?? 0) || (a < z ? -1 : 1))
      codes.forEach(c => tbCodes.add(c))
      const kps = codes.map(kpInfo)
      units.push({ outlineId: b.id, outlineName: b.name, levelName: l.level_name, lessonId: l.id, label: lessonName({ seq: l.seq, noLabel: l.no_label ?? '', title: l.title ?? '' }), title: l.title ?? '', kps, total: kps.length, covered: kps.filter(k => k.lessons.length > 0).length })
    }
  }

  // 没讲到的教材知识点（去重）+ 学校常考
  const where = new Map<string, string[]>()
  for (const u of units) for (const k of u.kps) if (k.lessons.length === 0) { if (!where.has(k.code)) where.set(k.code, []); where.get(k.code)!.push(`${u.levelName} ${u.label}`) }
  const uncovered: PriorityRow[] = [...where.entries()].map(([code, us]) => {
    const k = kpInfo(code)
    return { code, name: k.name, papers: k.papers, paperTotal: counts.papers, errorCount: k.errorCount, units: us }
  }).sort((a, b) => b.papers - a.papers || b.errorCount - a.errorCount || (a.code < b.code ? -1 : 1))
  const priority = uncovered.filter(r => !smallSample && r.papers >= minPapers)

  // 机构课讲了、教材里没有：教材知识点相关（自己 / 子孙 / 祖先）的都不算
  const related = (c: string): boolean => [...(sub.get(c) ?? [c]), ...ancestors(c)].some(x => tbCodes.has(x))
  const extraByLesson = new Map<number, Set<string>>()
  const totalByLesson = new Map<number, number>()
  for (const [code, ls] of courseByKp) {
    for (const lid of ls) totalByLesson.set(lid, (totalByLesson.get(lid) ?? 0) + 1)
    if (related(code)) continue
    for (const lid of ls) { if (!extraByLesson.has(lid)) extraByLesson.set(lid, new Set()); extraByLesson.get(lid)!.add(code) }
  }
  const extra: ExtraLesson[] = [...extraByLesson.entries()].map(([lid, cs]) => ({ ...refOf(lid)!, kps: [...cs].map(code => ({ code, name: nameOf(code) })), totalKps: totalByLesson.get(lid) ?? cs.size }))
    .filter(e => e.lessonId).sort((a, b) => a.lessonId - b.lessonId)
  const extraKpSet = new Set(extra.flatMap(e => e.kps.map(k => k.code)))

  const covered = [...tbCodes].filter(c => kpInfo(c).lessons.length > 0).length
  return {
    ready: true, reason: '', ...head, papers: counts.papers, minPapers, smallSample, units, uncovered, priority, extra,
    summary: { textbookKps: tbCodes.size, covered, uncovered: tbCodes.size - covered, priority: priority.length, extraKps: extraKpSet.size, extraLessons: extra.length }
  }
}

// ───────────────────────── 导出 / 复制 ─────────────────────────

/** 以 = + - @ Tab 回车 开头的格子前面加单引号：名称是用户自己上传的，不能让 Excel 当公式执行 */
const cell = (v: string | number): string => {
  let t = String(v)
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** 对比结果 → CSV（带 BOM，Excel 直接打开）：每行一个「单元 × 知识点」，再附「机构课讲了、教材里没有」 */
export function compareToCsv(r: CompareResult, head: { filterDesc: string }): string {
  const lines: Array<Array<string | number>> = [
    ['说明', '机构课程与学校教材的知识点对比（AI 匹配的结果，请教研核对）'],
    ['范围', head.filterDesc], ['机构课程', r.course?.name ?? ''], ['学校教材', r.textbooks.map(t => t.name).join('、')], [],
    ['教材', '年级学期', '单元', '知识点', '机构课程', '讲到的课', '对应精细度', '出现份数', '总份数', '学校常考', 'AI 估计易错题数']
  ]
  for (const u of r.units) {
    if (!u.kps.length) lines.push([u.outlineName, u.levelName, u.label, '（这个单元没有对应的知识点）', '', '', '', '', '', '', ''])
    for (const k of u.kps) lines.push([u.outlineName, u.levelName, u.label, k.name, k.lessons.length ? '讲到' : '没讲到', k.lessons.map(l => `${l.levelName} ${l.label}${l.coarse ? '（大类）' : ''}`).join('；'), !k.lessons.length ? '' : k.coarseOnly ? '大类对应，较粗' : '直接对应', k.papers, k.papers ? k.paperTotal : r.papers, k.frequent ? '是' : '', k.errorCount])
  }
  lines.push([], ['机构课程讲了、所选教材里没有的（超前 / 拓展）'], ['年级 / 级别', '课', '知识点'])
  for (const e of r.extra) lines.push([e.levelName, e.label, e.kps.map(k => k.name).join('、')])
  return '﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** 对比结果 → 一段能直接发给同事的文字（复制用） */
export function compareToText(r: CompareResult): string {
  if (!r.ready) return r.reason
  const s = r.summary
  const out: string[] = [
    `${r.course?.name} 对照 ${r.textbooks.map(t => t.name).join('、')}`,
    `学校教材共考到 ${s.textbookKps} 个知识点：机构课程讲到 ${s.covered} 个，没讲到 ${s.uncovered} 个${r.smallSample ? '' : `（其中学校常考的 ${s.priority} 个）`}。`
  ]
  if (r.priority.length) out.push('', '学校常考、机构课没讲到的（优先补）：', ...r.priority.map(p => `· ${p.name}（${p.papers}/${p.paperTotal} 份卷子出现；${p.units.slice(0, 2).join('、')}）`))
  const rest = r.uncovered.filter(u => !r.priority.some(p => p.code === u.code))
  if (rest.length) out.push('', '教材里有、机构课没讲到的其他知识点：', ...rest.slice(0, 20).map(p => `· ${p.name}（${p.units[0]}）`))
  if (r.extra.length) out.push('', '机构课讲了、教材里没有的（超前 / 拓展）：', ...r.extra.slice(0, 20).map(e => `· ${e.levelName} ${e.label}：${e.kps.map(k => k.name).join('、')}`))
  out.push('', '以上是 AI 匹配的结果，请教研核对。')
  return out.join('\n')
}
