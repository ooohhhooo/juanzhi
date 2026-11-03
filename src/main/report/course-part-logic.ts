/**
 * 报告里「课程对照」三段的纯逻辑（M9 §1.9）：谁在什么条件下跑、怎么拼 Markdown、家长版一句话怎么收尾、缓存键里放什么。
 * 不依赖 electron 和数据库，单测直接加载；真正调用 AI、读库的部分在 course-parts.ts。
 *   course_teacher  老师版：课程列表（程序拼）+ 150–200 字「可发给家长的话」（AI）
 *   course_full     完整版：末尾「课程对照」表（程序拼，没有 AI）
 *   course_hint     家长版：结尾追加一句 ≤ 40 字的课程建议（AI）；加上会超过 300 字就丢掉并记告警
 *   老板版不加。
 */
import { appendParentHint, buildTeacherCourseSection, PARENT_MAX_CHARS } from '../course/report-section.ts'
import type { CourseKpRow } from '../course/report-section.ts'
import type { PartMeta } from './parts.ts'
import type { ReportReader } from '../../shared/report-post.ts'
import type { ReportOptions } from '../../shared/report-options.ts'

export const COURSE_TEACHER_ID = 'course_teacher'
export const COURSE_FULL_ID = 'course_full'
export const COURSE_HINT_ID = 'course_hint'
export const ADVICE_HEADING = '可发给家长的话'
export const HINT_SOFT_MAX = 40
export const HINT_HARD_MAX = 60

export const COURSE_PART_METAS: PartMeta[] = [
  { id: COURSE_TEACHER_ID, label: '课程对照与选课建议', placement: 'before_advice', order: 40, readers: ['teacher'], ai: true },
  { id: COURSE_FULL_ID, label: '课程对照', placement: 'tail', order: 50, readers: ['full'], ai: false },
  { id: COURSE_HINT_ID, label: '课程建议一句话', placement: 'tail', order: 60, readers: ['parent'], ai: true, omitWhenEmpty: true }
]

/** 选项里勾了的课程体系 id（去重、去空） */
export const courseOutlineIds = (o: ReportOptions | undefined): string[] => [...new Set((o?.course?.outlineIds ?? []).filter(x => typeof x === 'string' && x))]

/** 这个读者、这些选项下，这一段要不要跑 */
export function courseEnabled(partId: string, reader: ReportReader, options: ReportOptions | undefined): boolean {
  if (!courseOutlineIds(options).length) return false
  if (partId === COURSE_TEACHER_ID) return reader === 'teacher'
  if (partId === COURSE_FULL_ID) return reader === 'full'
  if (partId === COURSE_HINT_ID) return reader === 'parent' && options?.parentHint === true
  return false
}

/** 这次跳过的原因（null = 可以跑）。rows 是已经去掉低把握后的对照行 */
export function courseSkipReason(o: { ready: boolean; outlineCount: number; rows: CourseKpRow[]; eligible?: number }): string | null {
  if (o.outlineCount === 0) return '勾选的课程体系已被停用或删除，没有加入课程对照'
  if (!o.ready) return '课程体系还没有匹配完，没有加入课程对照（先到「课程大纲」页点“开始匹配”）'
  if (!o.rows.some(r => r.lessons.length > 0)) return '这个范围内的易错点 / 主要考点没有对应到高、中把握的课，没有加入课程对照'
  if (o.eligible !== undefined && o.eligible === 0) return '当前范围内没有“易错点 + 有对应课”的考点，写不出课程建议'
  return null
}

/** 老师版小节：课程列表 + 「可发给家长的话」。advice 是已收尾、已核对事实的文字 */
export function composeTeacherCourse(rows: CourseKpRow[], advice: string): string {
  const list = buildTeacherCourseSection(rows)
  if (!list) return ''
  return `${list}\n\n### ${ADVICE_HEADING}\n\n> AI 草稿：发给家长前请老师读一遍，点上面的「我已核对」后才能用「复制给家长」。\n\n${advice.trim()}`
}

/** 从整份报告里取出「可发给家长的话」正文（到下一个标题或文末为止）；没有返回 null */
export function extractCourseAdvice(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex(l => new RegExp(`^###\\s+${ADVICE_HEADING}\\s*$`).test(l))
  if (at < 0) return null
  const body: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break
    if (/^>\s*AI 草稿/.test(lines[i])) continue
    body.push(lines[i])
  }
  const t = body.join('\n').trim()
  return t || null
}

export interface HintResult { markdown: string; warnings: string[] }

// appendParentHint 数的是去掉空白后的字数；主文去掉 Markdown 符号后交给它再核一遍
const plainOf = (md: string): string => md.replace(/[#>*_`|-]/g, '')

/**
 * 家长版一句话收尾。measure 是家长版「复制到微信」的字数口径（含换行和序号）：
 * 加上这一句后超过 300 字就丢弃（markdown 为空），记告警「加上课程建议会超过 300 字，已省略」，不放宽原有门槛。
 */
export function composeParentHint(mainMarkdown: string, hintText: string, measure: (md: string) => number): HintResult {
  const hint = hintText.replace(/\s+/g, ' ').trim()
  if (!hint) return { markdown: '', warnings: ['AI 没有写出可用的课程建议，已省略'] }
  const warnings: string[] = []
  const len = hint.replace(/[\s　]/g, '').length
  if (len > HINT_HARD_MAX) return { markdown: '', warnings: [`课程建议有 ${len} 字，远超 ${HINT_SOFT_MAX} 字，已省略`] }
  if (len > HINT_SOFT_MAX) warnings.push(`课程建议有 ${len} 字，建议不超过 ${HINT_SOFT_MAX} 字`)
  const gate = appendParentHint(plainOf(mainMarkdown), hint)
  const withHint = measure(`${mainMarkdown.replace(/\s+$/, '')}\n\n${hint}`)
  if (gate.warning || withHint > PARENT_MAX_CHARS) return { markdown: '', warnings: ['加上课程建议会超过 300 字，已省略'] }
  return { markdown: hint, warnings }
}

/** 参与缓存键的选项：课程体系 id 排序（顺序不同不算两份）+ 体系和对应的指纹（体系 / 对应一变，报告就「已过期」）。没勾课程时原样返回 */
export function cacheOptionsOf(options: ReportOptions, courseSig: string): ReportOptions & { courseSig?: string } {
  const ids = courseOutlineIds(options)
  if (!ids.length) return options
  return { ...options, course: { outlineIds: [...ids].sort() }, courseSig }
}
