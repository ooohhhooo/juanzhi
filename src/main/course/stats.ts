/**
 * 看板「课程对照」页签的计算（M9 §1.7）。数据库由调用方传入，数字全部由程序算，AI 不参与。
 *  · 块 1：容易出错的考点 → 对应课程（易错题数大于 0 的二级考点 + 「重难点」综合排名靠前的主要考点；复用 stats 的统计，不重新算数）；
 *  · 块 2：课程体系 × 级别 交叉（涉及的易错考点数、占本范围分值约百分之几；只算高 / 中把握和老师确认过的对应）；
 *  · 块 3：常考但课程没覆盖的考点（样本太少不下结论）。
 * 注意：这里的「丢分」指「卷子上常见的易错点」——软件里没有学生成绩，文字里一律说「易错」，不说孩子丢了分。
 */
import { hot, nodeStats, scopeCounts } from '../stats/core.ts'
import { paperScope } from '../stats/filter.ts'
import type { StatsFilter } from '../stats/filter.ts'
import { isMainMap } from './match.ts'
import { lessonName } from './map.ts'
import { listOutlines } from './store.ts'
import type { OutlineCard } from './store.ts'

type Db = any

export interface LessonRef {
  outlineId: string
  outlineName: string
  levelId: number
  levelName: string
  lessonId: number
  seq: number
  noLabel: string
  title: string
  theme: string
  textbookRef: string
  confidence: 'high' | 'medium' | 'low'
  state: 'suggested' | 'confirmed' | 'rejected'
  source: 'ai' | 'manual'
  reason: string
  quote: string
  /** 来自哪个知识点（子树里的三级知识点也算在二级考点名下） */
  kp: string
}

export interface CourseRow {
  code: string
  name: string
  /** 白话释义（知识点库里有就带上） */
  plain: string
  papers: number
  paperTotal: number
  questions: number
  errorCount: number
  score: number
  tags: Array<'易错' | '主要考点'>
  /** 高 / 中把握，或老师确认过的 */
  main: LessonRef[]
  /** 低把握，待确认（不进统计和报告） */
  maybe: LessonRef[]
  /** 这个考点在所选体系里被检查过吗（AI 看过但没找到 = true 且 main 为空） */
  checked: boolean
}

export interface CrossCell { outlineId: string; levelId: number; levelName: string; kpCount: number; scoreShare: number | null; codes: string[] }

export interface GapRow { code: string; name: string; papers: number; paperTotal: number; errorCount: number; questions: number }

export interface CourseDashboard {
  papers: number
  outlines: Array<Pick<OutlineCard, 'id' | 'name' | 'scene' | 'match'> & { levels: Array<{ id: number; name: string }> }>
  /** 所有选中的体系都已匹配完（块 2、3 才有意义） */
  ready: boolean
  rows: CourseRow[]
  cross: CrossCell[]
  gaps: { rows: GapRow[]; smallSample: boolean; minPapers: number; computed: boolean }
  summary: { lostPoints: number; withCourse: number; without: number }
}

/** 默认每类取多少个 */
export const ERR_ROWS = 12
export const HOT_ROWS = 6
/** 少于这么多份卷子不下「课程没覆盖」的结论 */
export const GAP_MIN_PAPERS = 3

/** code → 它和所有子孙（含自己） */
function subtree(db: Db): Map<string, string[]> {
  const kids = new Map<string, string[]>()
  for (const k of db.prepare('SELECT code, parent_code FROM kps').all() as any[]) {
    if (!kids.has(k.parent_code ?? '')) kids.set(k.parent_code ?? '', [])
    kids.get(k.parent_code ?? '')!.push(k.code)
  }
  const out = new Map<string, string[]>()
  const walk = (c: string, depth: number): string[] => {
    const acc = [c]
    if (depth < 5) for (const ch of kids.get(c) ?? []) acc.push(...walk(ch, depth + 1))
    return acc
  }
  for (const k of db.prepare('SELECT code FROM kps').all() as any[]) out.set(k.code, walk(k.code, 0))
  return out
}

interface MapRowDb { outline_id: string; kp_code: string; lesson_id: number; confidence: string; reason: string | null; quote: string | null; source: string; state: string }

/** 选中体系里所有知识点 → 课次的对应（没被否决的） */
function loadRefs(db: Db, outlineIds: string[]): { byKp: Map<string, LessonRef[]>; checked: Set<string> } {
  const byKp = new Map<string, LessonRef[]>()
  const checked = new Set<string>()
  if (!outlineIds.length) return { byKp, checked }
  const ph = outlineIds.map(() => '?').join(',')
  for (const r of db.prepare(`SELECT outline_id, kp_code FROM course_kp_check WHERE outline_id IN (${ph})`).all(...outlineIds) as any[]) checked.add(r.kp_code)
  const maps = db.prepare(`SELECT outline_id, kp_code, lesson_id, confidence, reason, quote, source, state FROM course_kp_map WHERE outline_id IN (${ph}) AND state <> 'rejected'`).all(...outlineIds) as MapRowDb[]
  const lessons = new Map((db.prepare(`SELECT l.id, l.level_id, lv.name level_name, lv.sort lv_sort, l.seq, l.no_label, l.title, l.theme, l.textbook_ref, o.name outline_name
    FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id JOIN course_outlines o ON o.id = l.outline_id WHERE l.outline_id IN (${ph})`).all(...outlineIds) as any[]).map(l => [l.id as number, l]))
  for (const m of maps) {
    const l = lessons.get(m.lesson_id)
    if (!l) continue
    const ref: LessonRef = {
      outlineId: m.outline_id, outlineName: l.outline_name, levelId: l.level_id, levelName: l.level_name, lessonId: l.id, seq: l.seq, noLabel: l.no_label ?? '', title: l.title ?? '',
      theme: l.theme ?? '', textbookRef: l.textbook_ref ?? '', confidence: m.confidence as LessonRef['confidence'], state: m.state as LessonRef['state'], source: m.source as LessonRef['source'],
      reason: m.reason ?? '', quote: m.quote ?? '', kp: m.kp_code
    }
    if (!byKp.has(m.kp_code)) byKp.set(m.kp_code, [])
    byKp.get(m.kp_code)!.push(ref)
  }
  return { byKp, checked }
}

const order = (a: LessonRef, b: LessonRef) => (a.outlineName < b.outlineName ? -1 : a.outlineName > b.outlineName ? 1 : 0) || a.levelId - b.levelId || a.seq - b.seq

export function courseDashboard(db: Db, filter: StatsFilter, outlineIds: string[], opts: { errRows?: number; hotRows?: number } = {}): CourseDashboard {
  const scope = paperScope(filter)
  const counts = scopeCounts(db, scope)
  const cards = listOutlines(db).filter(o => outlineIds.includes(o.id) && o.status === 'active')
  const ids = cards.map(c => c.id)
  const levelsOf = new Map<string, Array<{ id: number; name: string }>>()
  for (const lv of db.prepare('SELECT id, outline_id, name FROM course_levels ORDER BY sort, id').all() as any[]) {
    if (!levelsOf.has(lv.outline_id)) levelsOf.set(lv.outline_id, [])
    levelsOf.get(lv.outline_id)!.push({ id: lv.id, name: lv.name })
  }
  const outlines = cards.map(c => ({ id: c.id, name: c.name, scene: c.scene, match: c.match, levels: levelsOf.get(c.id) ?? [] }))
  const ready = cards.length > 0 && cards.every(c => c.match.state === 'done')
  const empty: CourseDashboard = { papers: counts.papers, outlines, ready, rows: [], cross: [], gaps: { rows: [], smallSample: counts.papers < GAP_MIN_PAPERS, minPapers: 2, computed: false }, summary: { lostPoints: 0, withCourse: 0, without: 0 } }
  if (!cards.length || counts.papers === 0) return empty

  // 块 1 的行：易错题数 > 0 的二级考点（按易错题数）+ 重难点排名靠前的二级考点
  const nodes = nodeStats(db, scope, 2).filter(n => n.level === 2)
  const errList = nodes.filter(n => n.errorCount > 0).sort((a, b) => b.errorCount - a.errorCount || b.papers - a.papers || (a.code < b.code ? -1 : 1)).slice(0, opts.errRows ?? ERR_ROWS)
  const hotList = hot(db, filter, 2, opts.hotRows ?? HOT_ROWS, scope, false).rows
  const picked = new Map<string, CourseRow>()
  const plainOf = new Map((db.prepare('SELECT code, plain FROM kps').all() as any[]).map(r => [r.code as string, String(r.plain ?? '')]))
  const toRow = (n: (typeof nodes)[number]): CourseRow => ({ code: n.code, name: n.name, plain: plainOf.get(n.code) ?? '', papers: n.papers, paperTotal: counts.papers, questions: n.questions, errorCount: n.errorCount, score: n.score, tags: [], main: [], maybe: [], checked: false })
  for (const n of errList) { const r = toRow(n); r.tags.push('易错'); picked.set(n.code, r) }
  for (const h of hotList) {
    const ex = picked.get(h.code)
    if (ex) { ex.tags.push('主要考点'); continue }
    const n = nodes.find(x => x.code === h.code)
    if (n) { const r = toRow(n); r.tags.push('主要考点'); picked.set(n.code, r) }
  }
  const sub = subtree(db)
  const { byKp, checked } = loadRefs(db, ids)
  const rows = [...picked.values()]
  for (const r of rows) {
    const codes = sub.get(r.code) ?? [r.code]
    const seen = new Set<number>()
    const all: LessonRef[] = []
    for (const c of codes) for (const ref of byKp.get(c) ?? []) if (!seen.has(ref.lessonId)) { seen.add(ref.lessonId); all.push(ref) }
    r.main = all.filter(isMainMap).sort(order)
    r.maybe = all.filter(x => !isMainMap(x)).sort(order)
    r.checked = codes.some(c => checked.has(c))
  }
  // 排序：有易错的在前（易错题数多的靠前），其余按原来的重难点顺序
  rows.sort((a, b) => (b.errorCount > 0 ? 1 : 0) - (a.errorCount > 0 ? 1 : 0) || b.errorCount - a.errorCount || b.papers - a.papers || (a.code < b.code ? -1 : 1))

  // 块 2：体系 × 级别
  const cross: CrossCell[] = []
  for (const o of outlines) {
    for (const lv of o.levels) {
      const hit = rows.filter(r => r.main.some(m => m.levelId === lv.id))
      cross.push({
        outlineId: o.id, levelId: lv.id, levelName: lv.name, kpCount: hit.length, codes: hit.map(r => r.code),
        scoreShare: counts.totalScore > 0 ? hit.reduce((n, r) => n + r.score, 0) / counts.totalScore : null
      })
    }
  }

  // 块 3：常考但没有任何高 / 中把握对应的二级考点
  const smallSample = counts.papers < GAP_MIN_PAPERS
  const minPapers = Math.max(2, Math.ceil(counts.papers * 0.3))
  let gapRows: GapRow[] = []
  if (!smallSample && ready) {
    for (const n of nodes) {
      if (n.papers < minPapers) continue
      const codes = sub.get(n.code) ?? [n.code]
      const has = codes.some(c => (byKp.get(c) ?? []).some(isMainMap))
      if (!has) gapRows.push({ code: n.code, name: n.name, papers: n.papers, paperTotal: counts.papers, errorCount: n.errorCount, questions: n.questions })
    }
    gapRows = gapRows.sort((a, b) => b.papers - a.papers || b.errorCount - a.errorCount || (a.code < b.code ? -1 : 1))
  }
  const withCourse = rows.filter(r => r.main.length > 0).length
  return {
    papers: counts.papers, outlines, ready, rows, cross, gaps: { rows: gapRows, smallSample, minPapers, computed: !smallSample && ready },
    summary: { lostPoints: rows.length, withCourse, without: rows.length - withCourse }
  }
}

/** 没覆盖清单 → CSV（带 BOM，Excel 直接打开）；字段里的引号、逗号、换行按 RFC 4180 转义 */
export function gapsToCsv(gaps: GapRow[], head: { filterDesc: string; outlineNames: string[]; scene: string }): string {
  // 以 = + - @ Tab 回车 开头的格子前面加单引号：考点名 / 体系名是用户自己上传的，不能让 Excel 当公式执行
  const q = (s: string | number) => { let t = String(s); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const lines = [
    ['说明', `${head.scene === 'school' ? '教学进度里没有安排的常考点' : '常考但课程没覆盖的考点'}（AI 匹配的结果，请教研核对）`],
    ['范围', head.filterDesc], ['课程体系', head.outlineNames.join('、')], [],
    ['考点', '出现份数', '总份数', '题数', 'AI 估计易错题数']
  ].map(r => r.map(q).join(','))
  for (const g of gaps) lines.push([g.name, g.papers, g.paperTotal, g.questions, g.errorCount].map(q).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}
