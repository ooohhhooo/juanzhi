/**
 * 报告里的「课程对照」内容（M9 §1.9）——只提供纯函数，由报告生成代码在两个分支合并后接入：
 *  · buildTeacherCourseSection：老师版小节「课程对照与选课建议」的课程列表（程序拼，没有 AI）；
 *  · buildFullCourseTable：完整版末尾的「课程对照」表（程序拼，没有 AI）；
 *  · buildAdviceInputs / buildHintInputs：p5_course_advice（老师版可发给家长的话）和 p5_course_hint（家长版结尾一句）的提示词输入；
 *  · courseRowsOf：把看板的课程对照结果转成上面这些函数的输入（只留高 / 中把握和老师确认过的对应，低把握不进报告）。
 * 不依赖 electron 和数据库，单测直接加载。所有文字避免价格、营销、夸大；说「涉及」「可以复习」，不说「学完就能提分」。
 */
import { lessonName } from './map.ts'
import type { CourseDashboard } from './stats.ts'

export interface CourseLessonRef {
  lessonId: number
  outlineName: string
  levelName: string
  noLabel: string
  seq: number
  title: string
  textbookRef: string
  /** 老师确认过的按「高」算 */
  confidence: 'high' | 'medium'
  confirmed: boolean
}

export interface CourseKpRow {
  code: string
  name: string
  papers: number
  paperTotal: number
  /** AI 估计的易错题数 */
  errorCount: number
  /** 白话释义 / 例句（来自知识点库，给话术提示词用；没有就留空） */
  plain?: string
  exampleEn?: string
  exampleZh?: string
  lessons: CourseLessonRef[]
}

export type CourseScene = 'org' | 'school' | 'family' | 'other'

/** 「示例体系 A · 基础级 · 第 5 课《Animals》」 */
export function lessonFullName(l: Pick<CourseLessonRef, 'outlineName' | 'levelName' | 'noLabel' | 'seq' | 'title'>): string {
  return [l.outlineName, l.levelName, lessonName(l)].filter(Boolean).join(' · ')
}

/** 看板结果 → 报告用的行：只留高 / 中把握（或老师确认）的对应，没有对应课的考点不要 */
export function courseRowsOf(d: CourseDashboard, extra?: Map<string, { plain?: string; exampleEn?: string; exampleZh?: string }>): CourseKpRow[] {
  return d.rows.filter(r => r.main.length > 0).map(r => ({
    code: r.code, name: r.name, papers: r.papers, paperTotal: r.paperTotal, errorCount: r.errorCount, ...(extra?.get(r.code) ?? {}),
    lessons: r.main.map(m => ({
      lessonId: m.lessonId, outlineName: m.outlineName, levelName: m.levelName, noLabel: m.noLabel, seq: m.seq, title: m.title, textbookRef: m.textbookRef,
      confidence: m.state === 'confirmed' || m.confidence === 'high' ? 'high' : 'medium', confirmed: m.state === 'confirmed'
    }))
  }))
}

const MAX_LESSONS_IN_LIST = 3
const byConfidence = (a: CourseLessonRef, b: CourseLessonRef) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1)
const top = (r: CourseKpRow, n = MAX_LESSONS_IN_LIST) => r.lessons.slice().sort(byConfidence).slice(0, n)
const oneLine = (s: string) => s.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim()
const confText = (l: CourseLessonRef) => (l.confirmed ? '老师已确认' : l.confidence === 'high' ? '高' : '中')

export const COURSE_DISCLAIMER = '课程对应是 AI 匹配的结果，请老师核对；它说明“哪些课涉及这些考点”，不是“学完就能提分”。'

/** 老师版小节。rows 为空返回空串（没有对应就不出现这一节） */
export function buildTeacherCourseSection(rows: CourseKpRow[], opts: { heading?: string } = {}): string {
  const used = rows.filter(r => r.lessons.length > 0)
  if (!used.length) return ''
  const out: string[] = [`## ${opts.heading ?? '课程对照与选课建议'}`, '', `> ${COURSE_DISCLAIMER}`, '']
  for (const r of used) {
    out.push(`- **${oneLine(r.name)}**${r.errorCount > 0 ? `（AI 估计易错题 ${r.errorCount} 道）` : ''}：可以复习`)
    for (const l of top(r)) {
      const mid = l.confidence === 'medium' && !l.confirmed ? '（可能）' : ''
      out.push(`  - ${lessonFullName(l)}${mid}${l.textbookRef ? `；教材对标：${oneLine(l.textbookRef)}` : ''}`)
    }
    if (r.lessons.length > MAX_LESSONS_IN_LIST) out.push(`  - 另有 ${r.lessons.length - MAX_LESSONS_IN_LIST} 课也涉及`)
  }
  return out.join('\n')
}

/** 完整版末尾的表：知识点 | 出现份数 | AI 估计易错题数 | 对应课程（最多 3） | 把握 */
export function buildFullCourseTable(rows: CourseKpRow[], opts: { heading?: string } = {}): string {
  const used = rows.filter(r => r.lessons.length > 0)
  if (!used.length) return ''
  const out: string[] = [`## ${opts.heading ?? '课程对照'}`, '', `> ${COURSE_DISCLAIMER}`, '', '| 知识点 | 出现份数 | AI 估计易错题数 | 对应课程（最多 3 课） | 把握 |', '|---|---|---|---|---|']
  for (const r of used) {
    const ls = top(r)
    out.push(`| ${oneLine(r.name)} | ${r.papers}/${r.paperTotal} | ${r.errorCount} | ${ls.map(l => lessonFullName(l)).join('；')}${r.lessons.length > ls.length ? `；另 ${r.lessons.length - ls.length} 课` : ''} | ${ls.map(confText).join('、')} |`)
  }
  return out.join('\n')
}

// ───────────────────────── 话术 / 一句话建议的输入 ─────────────────────────

export const SCENE_TEXT: Record<CourseScene, string> = { org: '培训机构的老师对家长说', school: '学校老师对家长说', family: '家长自己用（孩子在上的课）', other: '老师对家长说' }

export interface AdviceInputs {
  placeholders: { SCENE: string; FILTER_DESC: string; SAMPLE_WARNING: string; LOST_POINTS: string; COURSE_MATCH: string; EVIDENCE: string }
  /** 令牌里的数字 → 完整课名（输出后程序据此替换，不在这里的令牌一律删除） */
  labels: Map<number, string>
  /** 实际放进提示词的考点 */
  used: CourseKpRow[]
}

export const token = (lessonId: number): string => `[课#${lessonId}]`

function inputs(rows: CourseKpRow[], max: number, o: { scene: CourseScene; filterDesc: string; sampleWarning: string; evidenceText: string; lessonsPer: number }): AdviceInputs {
  // 有 AI 估计易错题的考点优先，其次出现份数多的
  const used = rows.filter(r => r.lessons.length > 0).slice().sort((a, b) => b.errorCount - a.errorCount || b.papers - a.papers || (a.code < b.code ? -1 : 1)).slice(0, max)
  const labels = new Map<number, string>()
  const lost = used.map(r => [oneLine(r.name), oneLine(r.plain ?? '') || '—', r.exampleEn ? oneLine(`${r.exampleEn} ${r.exampleZh ?? ''}`) : '—'].join(' | '))
  const match = used.map(r => {
    const ls = top(r, o.lessonsPer)
    for (const l of ls) labels.set(l.lessonId, lessonFullName(l))
    return `${oneLine(r.name)} → ${ls.map(l => `${token(l.lessonId)} ${lessonFullName(l)}`).join('；')}`
  })
  return {
    placeholders: {
      SCENE: SCENE_TEXT[o.scene], FILTER_DESC: o.filterDesc || '（未限定）', SAMPLE_WARNING: o.sampleWarning || '无',
      LOST_POINTS: lost.join('\n') || '（无）', COURSE_MATCH: match.join('\n') || '（无）', EVIDENCE: o.evidenceText || '（无）'
    },
    labels, used
  }
}

/** p5_course_advice 的输入：取前 5 个有对应课的考点（提示词要求最多谈 3 个），每个最多 2 课 */
export function buildAdviceInputs(rows: CourseKpRow[], o: { scene: CourseScene; filterDesc: string; sampleWarning: string; evidenceText: string }): AdviceInputs {
  return inputs(rows, 5, { ...o, lessonsPer: 2 })
}

/** p5_course_hint 的输入：只放 1 个考点、最多 2 课（结尾一句话） */
export function buildHintInputs(rows: CourseKpRow[], o: { scene: CourseScene; filterDesc: string; sampleWarning: string; evidenceText: string }): AdviceInputs {
  return inputs(rows, 1, { ...o, lessonsPer: 2 })
}

/** 家长版加一句课程建议后的字数门槛：超过 300 字就不加（返回 null 并给出告警），不放宽原有门槛 */
export const PARENT_MAX_CHARS = 300
export function appendParentHint(parentText: string, hint: string): { text: string; warning: string | null } {
  const h = hint.trim()
  if (!h) return { text: parentText, warning: null }
  const next = `${parentText.replace(/\s+$/, '')}\n${h}`
  if (next.replace(/\s/g, '').length > PARENT_MAX_CHARS) return { text: parentText, warning: '加上课程建议会超过 300 字，已省略' }
  return { text: next, warning: null }
}
