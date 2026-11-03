/**
 * 报告里的「课程对照」三段（M9 §1.9）的登记：老师版小节 + 话术、完整版表格、家长版一句话。
 * 纯逻辑（谁跑、怎么拼、300 字门槛）在 course-part-logic.ts；这里只负责读库和调用 AI。
 * 只在勾了「加入课程对照」且有已匹配的体系时才跑；每一段独立失败、独立重试；AI 写的话过禁用词清理和事实核对。
 */
import { getDb } from '../db'
import { promptVersionFor } from '../ai/prompts'
import { fixBackticks, markdownToWechat, stripInternalCodes } from '../../shared/report-post'
import { stripCodes } from '../../shared/code-guard'
import { finishAdvice } from '../course/advice-post'
import { buildFullCourseTable, courseRowsOf } from '../course/report-section'
import { courseDashboard } from '../course/stats'
import { prepareAdvice } from '../course/service'
import type { AdviceScope } from '../course/service'
import type { UnverifiedItem } from '../ai/chunk'
import { partChat } from './part-ai'
import { registerReportPart } from './parts-run'
import type { PartContext } from './parts-run'
import { COURSE_FULL_ID, COURSE_HINT_ID, COURSE_PART_METAS, COURSE_TEACHER_ID, composeParentHint, composeTeacherCourse, courseEnabled, courseOutlineIds, courseSkipReason } from './course-part-logic'

type Base = Omit<PartContext, 'signal' | 'mainMarkdown'>
const scopeOf = (c: Base): AdviceScope => ({ filter: c.prepared.src.filter, outlineIds: courseOutlineIds(c.options) })

/** 看板的对照行（低把握、被老师否决的已在 courseRowsOf / 看板里排除） */
function rowsOf(c: Base) {
  const dash = courseDashboard(getDb(), scopeOf(c).filter, scopeOf(c).outlineIds)
  return { dash, rows: courseRowsOf(dash) }
}

function skipFor(c: Base, ai: 'advice' | 'hint' | null): string | null {
  const { dash, rows } = rowsOf(c)
  const eligible = ai ? prepareAdvice(getDb(), scopeOf(c), ai).eligible : undefined
  return courseSkipReason({ ready: dash.ready, outlineCount: dash.outlines.length, rows, eligible })
}

const toUnverified = (f: Array<{ sentence: string; kind: 'unverified' | 'conflict'; reason: string }>): UnverifiedItem[] => f.map(x => ({ sentence: x.sentence, kind: x.kind, reason: x.reason }))
const cleanAi = (s: string): string => stripCodes(stripInternalCodes(fixBackticks(s), []))

const [TEACHER, FULL, HINT] = COURSE_PART_METAS

registerReportPart({
  ...TEACHER,
  enabled: c => courseEnabled(COURSE_TEACHER_ID, c.reader, c.options),
  skip: c => skipFor(c, 'advice'),
  async run(ctx) {
    const db = getDb()
    const p = prepareAdvice(db, scopeOf(ctx), 'advice')
    if (p.promptError) throw new Error(`提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）`)
    const r = await partChat({ system: p.system, user: p.user, kind: 'p5_course_advice', signal: ctx.signal, json: false })
    const fin = finishAdvice(cleanAi(r.content), p.labels, { statements: p.evidenceStatements })
    if (!fin.ok) throw new Error(`${fin.failReason ?? '内容不合格'}。可以点「重试这一部分」`)
    const rows = courseRowsOf(p.dash)
    return { markdown: composeTeacherCourse(rows, fin.text), model: r.model, promptVersion: promptVersionFor('p5_course_advice'), usage: r.usage, unverified: toUnverified(fin.findings), warnings: fin.warnings }
  }
})

registerReportPart({
  ...FULL,
  enabled: c => courseEnabled(COURSE_FULL_ID, c.reader, c.options),
  skip: c => skipFor(c, null),
  async run(ctx) {
    return { markdown: buildFullCourseTable(rowsOf(ctx).rows) }
  }
})

registerReportPart({
  ...HINT,
  enabled: c => courseEnabled(COURSE_HINT_ID, c.reader, c.options),
  skip: c => skipFor(c, 'hint'),
  async run(ctx) {
    const p = prepareAdvice(getDb(), scopeOf(ctx), 'hint')
    if (p.promptError) throw new Error(`提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）`)
    const r = await partChat({ system: p.system, user: p.user, kind: 'p5_course_hint', signal: ctx.signal, json: false })
    // 一句话：不查字数范围，只要不是空的；只取第一行
    const fin = finishAdvice(cleanAi(r.content), p.labels, { range: null, minChars: 6, statements: p.evidenceStatements })
    const base = { model: r.model, promptVersion: promptVersionFor('p5_course_hint'), usage: r.usage }
    if (!fin.ok) return { markdown: '', ...base, warnings: [...fin.warnings, '课程建议内容太少，已省略'] }
    const line = fin.text.split('\n').map(s => s.trim()).find(Boolean) ?? ''
    // 家长版字数口径 = 复制到微信（含换行和序号）；加上这一句超过 300 字就丢掉
    const out = composeParentHint(ctx.mainMarkdown, line, md => markdownToWechat(md, { spaced: true }).length)
    const kept = out.markdown !== ''
    return { markdown: out.markdown, ...base, warnings: [...fin.warnings, ...out.warnings], unverified: kept ? toUnverified(fin.findings) : [] }
  }
})
