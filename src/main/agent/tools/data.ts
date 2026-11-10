/**
 * 试卷数据的只读工具：复用现有的统计函数（stats/*）、课程对照（course/*）和事实核对（shared/factcheck）。
 * 数据库句柄从 ctx.db 来，所以可以用内存库直接单测。
 * 后续接运营数据（学员、班级、出勤……）时，照这个样子再写一个文件，在 index.ts 里注册即可。
 */
import { z } from 'zod'
import { CLOSURE_CTE, paperScope } from '../../stats/filter.ts'
import type { StatsFilter } from '../../stats/filter.ts'
import { loadKps, nodeStats, questionsOfKp, scopeCounts } from '../../stats/core.ts'
import { collectEvidence } from '../../stats/evidence.ts'
import { checkRules } from '../../../shared/factcheck.ts'
import { isMainMap } from '../../course/match.ts'
import { lessonName } from '../../course/map.ts'
import type { ToolDef, ToolCtx } from '../types.ts'
import { sessionSubject } from '../store.ts'
import { subjectName } from '../../../shared/subject.ts'
import type { SubjectId } from '../../../shared/subject.ts'
import { READER_LABEL, stripInternalCodes } from '../../../shared/report-post.ts'
import type { ReportReader } from '../../../shared/report-post.ts'

const oneLine = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ───────── 公共：筛选参数 ─────────
const FilterShape = {
  grade: z.enum(['1', '2', '3', '4', '5', '6']).optional().describe('年级，1 到 6'),
  semester: z.enum(['上', '下']).optional().describe('学期'),
  school_year_start: z.number().int().min(2000).max(2100).optional().describe('学年的起始年，例如 2025 表示 2025-2026 学年'),
  exam_type: z.enum(['单元测试', '期中', '期末', '月考', '其他']).optional().describe('考试类型'),
  textbook: z.string().min(1).max(100).optional().describe('教材名'),
  region: z.string().min(1).max(100).optional().describe('地区'),
  include_reviewing: z.boolean().optional().describe('是否把还没审核完的试卷也算进来，默认不算')
}
type FilterArgs = { grade?: StatsFilter['grade']; semester?: StatsFilter['semester']; school_year_start?: number; exam_type?: StatsFilter['exam_type']; textbook?: string; region?: string; include_reviewing?: boolean }
/** 筛选里的学科由会话决定，模型不能自己改：所有统计都强制带上会话的学科 */
const subjectOf = (ctx: ToolCtx): SubjectId => sessionSubject(ctx.db, ctx.sessionId)
const toFilter = (a: FilterArgs, subject: SubjectId = 'english'): StatsFilter => {
  const f: StatsFilter = { subject }
  if (a.grade) f.grade = a.grade
  if (a.semester) f.semester = a.semester
  if (a.school_year_start) f.school_year_start = a.school_year_start
  if (a.exam_type) f.exam_type = a.exam_type
  if (a.textbook) f.textbook = a.textbook
  if (a.region) f.region = a.region
  if (a.include_reviewing) f.includeReviewing = true
  return f
}
const describeFilter = (a: FilterArgs): string => {
  const p: string[] = []
  if (a.grade) p.push(`${a.grade} 年级`)
  if (a.semester) p.push(`${a.semester}学期`)
  if (a.school_year_start) p.push(`${a.school_year_start}-${a.school_year_start + 1} 学年`)
  if (a.exam_type) p.push(a.exam_type)
  if (a.textbook) p.push(a.textbook)
  if (a.region) p.push(a.region)
  return p.length ? p.join('、') : '全部试卷'
}

/** 把模型给的「知识点」（代码或中文名）找到对应的知识点；可能有多个候选 */
export function resolveKp(db: any, input: string, subject: SubjectId = 'english'): Array<{ code: string; name: string }> {
  const t = input.trim()
  if (!t) return []
  // 只在本学科的知识点里找（别的学科的同名节点不算）
  const mine = new Set((db.prepare('SELECT code FROM kps WHERE subject = ?').all(subject) as Array<{ code: string }>).map(r => r.code))
  const kps = loadKps(db).filter(k => mine.has(k.code))
  const byCode = kps.filter(k => k.code.toLowerCase() === t.toLowerCase())
  if (byCode.length) return byCode.map(k => ({ code: k.code, name: k.name }))
  const exact = kps.filter(k => k.name === t)
  if (exact.length) return exact.map(k => ({ code: k.code, name: k.name }))
  const lower = t.toLowerCase()
  return kps.filter(k => k.name.toLowerCase().includes(lower) || lower.includes(k.name.toLowerCase()) && k.name.length >= 2).slice(0, 6).map(k => ({ code: k.code, name: k.name }))
}

const pickKp = (db: any, input: string, subject: SubjectId): { kp: { code: string; name: string } } | { text: string; count: number } => {
  const c = resolveKp(db, input, subject)
  if (c.length === 0) return { text: `没有找到叫「${input}」的知识点。可以先用 stats_overview 看看有哪些常考的知识点，再用它的名字重试。`, count: 0 }
  if (c.length > 1) return { text: `「${input}」可能是下面几个知识点之一，请用准确的名字或代码重新调用：\n${c.map(k => `- ${k.name}（代码 ${k.code}）`).join('\n')}`, count: c.length }
  return { kp: c[0] }
}

// ───────── stats_overview ─────────
export const statsOverview: ToolDef = {
  name: 'stats_overview', label: '看整体情况', planSafe: true,
  level: 'read',
  description: '查看某个范围内试卷的整体情况：卷子数、题数，最常考的知识点前几名，最易错的知识点前几名（含常见错误原因）。不写筛选 = 全部已审核的试卷。返回的知识点都带代码，可以拿去调用 kp_questions / course_for_kp。',
  schema: z.object({ ...FilterShape, top: z.number().int().min(1).max(15).default(6).describe('最常考 / 最易错各列几个，默认 6') }),
  run: (a, ctx) => {
    const db = ctx.db
    const scope = paperScope(toFilter(a, subjectOf(ctx)))
    const c = scopeCounts(db, scope)
    const head = `范围：${describeFilter(a)}（只含老师已审核的试卷${a.include_reviewing ? '和待审核的试卷' : ''}）\n卷子 ${c.papers} 份，题目 ${c.questions} 道`
    if (c.papers === 0) return { text: `${head}\n这个范围里还没有可以统计的试卷。`, count: 0 }
    const nodes = nodeStats(db, scope, 2).filter(n => n.level === 2 && n.papers > 0)
    const top = a.top ?? 6
    const freq = [...nodes].sort((x, y) => y.papers - x.papers || y.questions - x.questions || (x.code < y.code ? -1 : 1)).slice(0, top)
    const errs = nodes.filter(n => n.errorCount > 0).sort((x, y) => y.errorCount - x.errorCount || y.errorCount / y.questions - x.errorCount / x.questions || (x.code < y.code ? -1 : 1)).slice(0, top)
    const reasonsBy = new Map<string, string[]>()
    if (errs.length) {
      const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
        SELECT c.anc AS node, q.error_reason AS reason, COUNT(DISTINCT q.id) AS cnt
        FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
        CROSS JOIN question_kps k ON k.question_id = q.id
        CROSS JOIN closure c ON c.code = k.kp_code
        WHERE ${scope.where} AND q.error_prone = 1 AND q.error_reason IS NOT NULL AND q.error_reason <> '' AND c.anc IN (${errs.map(() => '?').join(',')})
        GROUP BY c.anc, q.error_reason ORDER BY cnt DESC`).all(...scope.params, ...errs.map(e => e.code)) as Array<{ node: string; reason: string; cnt: number }>
      for (const r of rows) { const l = reasonsBy.get(r.node) ?? []; if (l.length < 2) l.push(`${oneLine(r.reason, 50)}（${r.cnt} 道）`); reasonsBy.set(r.node, l) }
    }
    const out = [head, '', `最常考的知识点（前 ${freq.length}）：`]
    freq.forEach((n, i) => out.push(`${i + 1}. ${n.name}（代码 ${n.code}）：出现在 ${n.papers}/${c.papers} 份卷子里，共 ${n.questions} 道题`))
    out.push('', errs.length ? `最易错的知识点（前 ${errs.length}，按老师审核时标记的易错题数）：` : '没有被标记为易错的题。')
    errs.forEach((n, i) => out.push(`${i + 1}. ${n.name}（代码 ${n.code}）：${n.errorCount}/${n.questions} 道题易错${reasonsBy.get(n.code)?.length ? `；常见原因：${reasonsBy.get(n.code)!.join('；')}` : ''}`))
    out.push('', '说明：「易错」是 AI 估计、老师审核过的，软件里没有学生的实际成绩。')
    return { text: out.join('\n'), count: freq.length + errs.length }
  }
}

// ───────── kp_questions ─────────
export const kpQuestions: ToolDef = {
  name: 'kp_questions', label: '查考这个知识点的题',
  level: 'read',
  description: '列出考某个知识点的题目（易错的排前面）：题号、卷名、题干摘要、易错原因、题目 ID。引用题目时用 [[q:题目ID]]。kp 可以写知识点的中文名或代码。',
  schema: z.object({
    kp: z.string().min(1).max(80).describe('知识点的中文名或代码'),
    limit: z.number().int().min(1).max(20).default(8).describe('最多列几道，默认 8'),
    ...FilterShape
  }),
  run: (a, ctx) => {
    const p = pickKp(ctx.db, a.kp, subjectOf(ctx))
    if ('text' in p) return p
    const limit = a.limit ?? 8
    const cards = questionsOfKp(ctx.db, paperScope(toFilter(a, subjectOf(ctx))), p.kp.code, limit + 1)
    if (cards.length === 0) return { text: `在「${describeFilter(a)}」里，没有考「${p.kp.name}」的题。`, count: 0 }
    const shown = cards.slice(0, limit)
    const lines = shown.map((q, i) => `${i + 1}. [[q:${q.id}]] 《${oneLine(q.paperTitle, 30)}》第 ${q.no} 题（${q.qtypeName}）：${oneLine(q.stem, 60) || '（题干未识别）'}${q.error_prone ? `｜易错：${oneLine(q.error_reason, 50) || '（未写原因）'}` : ''}`)
    const more = cards.length > limit ? `\n还有更多题没有列出，可以调大 limit 或加筛选。` : ''
    return { text: `知识点：${p.kp.name}（代码 ${p.kp.code}），范围：${describeFilter(a)}\n${lines.join('\n')}${more}`, count: shown.length }
  }
}

// ───────── course_for_kp ─────────
export const courseForKp: ToolDef = {
  name: 'course_for_kp', label: '查对应的课',
  level: 'read',
  description: '查某个知识点对应课程大纲里的哪几课（只含把握较高或老师确认过的对应）。引用课次时用 [[lesson:课次ID]]。kp 可以写知识点的中文名或代码。',
  schema: z.object({ kp: z.string().min(1).max(80).describe('知识点的中文名或代码') }),
  run: (a, ctx) => {
    const db = ctx.db
    const p = pickKp(db, a.kp, subjectOf(ctx))
    if ('text' in p) return p
    const outlines = db.prepare("SELECT COUNT(*) c FROM course_outlines WHERE active = 1 AND status = 'active' AND subject = ?").get(subjectOf(ctx)).c as number
    if (!outlines) return { text: '软件里还没有导入（或启用）课程大纲，无法查对应的课。', count: 0 }
    const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
      SELECT m.kp_code, m.lesson_id, m.confidence, m.state, m.reason, l.seq, l.no_label, l.title, lv.name AS level_name, o.name AS outline_name
      FROM closure c JOIN course_kp_map m ON m.kp_code = c.code
      JOIN course_lessons l ON l.id = m.lesson_id JOIN course_levels lv ON lv.id = l.level_id
      JOIN course_outlines o ON o.id = m.outline_id AND o.active = 1 AND o.status = 'active' AND o.subject = '${subjectOf(ctx)}'
      WHERE c.anc = ? ORDER BY o.name, lv.sort, l.seq`).all(p.kp.code) as any[]
    const main = rows.filter(isMainMap)
    if (main.length === 0) {
      const checked = (db.prepare("SELECT COUNT(*) c FROM course_kp_check k JOIN course_outlines o ON o.id = k.outline_id WHERE k.kp_code = ? AND o.active = 1 AND o.subject = ?").get(p.kp.code, subjectOf(ctx)) as any).c as number
      return { text: `「${p.kp.name}」在课程大纲里${checked ? '没有找到对应的课（已经检查过）' : '暂时没有对应的课（可能还没做课程匹配）'}。`, count: 0 }
    }
    const conf: Record<string, string> = { high: '把握高', medium: '把握中', low: '把握低' }
    const lines = main.slice(0, 12).map(r => `- [[lesson:${r.lesson_id}]] ${r.outline_name} / ${r.level_name} / ${lessonName({ seq: r.seq, noLabel: r.no_label, title: r.title })}（${r.state === 'confirmed' ? '老师确认过' : conf[r.confidence] ?? r.confidence}${r.reason ? '；' + oneLine(r.reason, 50) : ''}）`)
    return { text: `「${p.kp.name}」对应的课（共 ${main.length} 课${main.length > 12 ? '，只列前 12' : ''}）：\n${lines.join('\n')}`, count: main.length }
  }
}

// ───────── fact_check ─────────
export const factCheck: ToolDef = {
  name: 'fact_check', label: '核对讲解',
  level: 'read',
  description: '把一段讲解文字（尤其是语法规则的说法）拿去和已审核的题目解释、知识点释义核对。找出「与题目解释矛盾」和「查不到依据」的句子。通过只表示和软件里审核过的资料一致，不代表一定正确。',
  schema: z.object({ text: z.string().min(1).max(4000).describe('要核对的文字') }),
  run: (a, ctx) => {
    const ev = collectEvidence(ctx.db, paperScope({ subject: subjectOf(ctx) }), {})
    const found = checkRules(a.text, ev.statements)
    if (found.length === 0) return { text: '没有发现和软件里审核过的资料矛盾的规则句（也可能这段话里没有规则句）。', count: 0 }
    const kind = { conflict: '与题目解释矛盾', unverified: '查不到依据' } as const
    return { text: found.map((f, i) => `${i + 1}. 【${kind[f.kind]}】${f.sentence}（${f.reason}）`).join('\n'), count: found.length }
  }
}

// ───────── papers_list ─────────
const STATUS_LABEL: Record<string, string> = { done: '已审核', reviewing: '待审核', parsing: '识别中', queued: '排队中', imported: '已导入', error: '出错', failed: '出错' }
export const papersList: ToolDef = {
  name: 'papers_list', label: '看有哪些试卷', planSafe: true,
  level: 'read',
  description: '列出试卷库里的试卷：卷名、年级、学期、学年、考试类型、学校、状态、题数。可以按年级等筛选；默认列出全部状态（统计类工具只算已审核的）。',
  schema: z.object({ ...FilterShape, limit: z.number().int().min(1).max(100).default(40).describe('最多列几份，默认 40') }),
  run: (a, ctx) => {
    const db = ctx.db
    const conds: string[] = ['p.is_sample = 0', 'p.subject = ?']
    const params: unknown[] = [subjectOf(ctx)]
    for (const k of ['grade', 'semester', 'school_year_start', 'exam_type', 'textbook', 'region'] as const) if (a[k] !== undefined) { conds.push(`p.${k} = ?`); params.push(a[k]) }
    const all = db.prepare(`SELECT p.id, p.title, p.grade, p.semester, p.school_year_start, p.exam_type, p.school, p.status, (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS qn
      FROM papers p WHERE ${conds.join(' AND ')} ORDER BY p.created_at DESC`).all(...params) as any[]
    if (!all.length) return { text: `「${describeFilter(a)}」里没有试卷。`, count: 0 }
    const limit = a.limit ?? 40
    const by = new Map<string, number>()
    for (const p of all) by.set(STATUS_LABEL[p.status] ?? p.status, (by.get(STATUS_LABEL[p.status] ?? p.status) ?? 0) + 1)
    const lines = all.slice(0, limit).map((p, i) => `${i + 1}. 《${oneLine(p.title, 40) || '（无标题）'}》${p.grade ? ` ${p.grade} 年级` : ''}${p.semester ? ` ${p.semester}学期` : ''}${p.school_year_start ? ` ${p.school_year_start}学年` : ''}${p.exam_type ? ` ${p.exam_type}` : ''}${p.school ? `｜${oneLine(p.school, 20)}` : ''}｜${STATUS_LABEL[p.status] ?? p.status}｜${p.qn} 题`)
    return { text: `范围：${describeFilter(a)}，共 ${all.length} 份（${[...by].map(([k, v]) => `${k} ${v}`).join('、')}）${all.length > limit ? `，只列最新 ${limit} 份` : ''}\n${lines.join('\n')}`, count: Math.min(all.length, limit) }
  }
}

// ───────── course_coverage ─────────
export const courseCoverage: ToolDef = {
  name: 'course_coverage', label: '看课程覆盖',
  level: 'read',
  description: '课程对照总览：已启用的课程大纲有哪些、匹配进度，以及在这批试卷里「常考但课程没有对应课」的知识点（课程缺口）。要看某个知识点对应哪几课用 course_for_kp。',
  schema: z.object({ ...FilterShape }),
  run: (a, ctx) => {
    const db = ctx.db
    const outlines = db.prepare("SELECT id, name FROM course_outlines WHERE active = 1 AND status = 'active' AND subject = ? ORDER BY name").all(subjectOf(ctx)) as any[]
    if (!outlines.length) return { text: '软件里还没有导入（或启用）课程大纲。', count: 0 }
    const scope = paperScope(toFilter(a, subjectOf(ctx)))
    const c = scopeCounts(db, scope)
    const out = [`已启用的课程大纲：${outlines.map(o => `《${o.name}》`).join('、')}`, `范围：${describeFilter(a)}，已审核试卷 ${c.papers} 份`]
    for (const o of outlines) {
      const lessons = (db.prepare('SELECT COUNT(*) c FROM course_lessons WHERE outline_id = ?').get(o.id) as any).c
      const checked = (db.prepare('SELECT COUNT(DISTINCT kp_code) c FROM course_kp_check WHERE outline_id = ?').get(o.id) as any).c
      out.push(`- 《${o.name}》：${lessons} 课，已匹配 ${checked} 个知识点`)
    }
    if (c.papers === 0) return { text: out.join('\n') + '\n这个范围里还没有已审核的试卷，算不出课程缺口。', count: outlines.length }
    const ids = outlines.map(o => o.id)
    const ph = ids.map(() => '?').join(',')
    const nodes = nodeStats(db, scope, 2).filter(n => n.level === 2 && n.papers > 0).sort((x, y) => y.papers - x.papers || y.errorCount - x.errorCount)
    const covered = new Set<string>()
    const checkedKps = new Set<string>()
    for (const r of db.prepare(`WITH RECURSIVE ${CLOSURE_CTE} SELECT DISTINCT c.anc AS node, m.confidence, m.state FROM course_kp_map m JOIN closure c ON c.code = m.kp_code WHERE m.outline_id IN (${ph}) AND m.state <> 'rejected'`).all(...ids) as any[]) if (isMainMap(r)) covered.add(r.node)
    for (const r of db.prepare(`WITH RECURSIVE ${CLOSURE_CTE} SELECT DISTINCT c.anc AS node FROM course_kp_check k JOIN closure c ON c.code = k.kp_code WHERE k.outline_id IN (${ph})`).all(...ids) as any[]) checkedKps.add(r.node)
    const minPapers = Math.max(2, Math.ceil(c.papers * 0.3))
    const gaps = nodes.filter(n => n.papers >= minPapers && checkedKps.has(n.code) && !covered.has(n.code))
    const coveredTop = nodes.filter(n => covered.has(n.code)).slice(0, 8)
    out.push('', coveredTop.length ? `常考且课程里有对应课的知识点（前 ${coveredTop.length}）：${coveredTop.map(n => `${n.name}（代码 ${n.code}，${n.papers}/${c.papers} 份卷子）`).join('；')}` : '常考知识点里还没有课程对应（可能还没做课程匹配）。')
    out.push(gaps.length ? `课程缺口（至少出现在 ${minPapers} 份卷子里、但课程里没有对应课）：\n${gaps.slice(0, 15).map((n, i) => `${i + 1}. ${n.name}（代码 ${n.code}）：${n.papers}/${c.papers} 份卷子，${n.questions} 道题${n.errorCount ? `，易错 ${n.errorCount} 道` : ''}`).join('\n')}` : '没有发现课程缺口（常考的知识点都有对应课，或者还没匹配完）。')
    if (c.papers < 3) out.push('说明：试卷少于 3 份，缺口结论只作参考。')
    return { text: out.join('\n'), count: gaps.length }
  }
}

// ───────── reports_list / report_read ─────────
const readerOf = (r: any): ReportReader => (['boss', 'parent', 'teacher', 'full'].includes(r.reader) ? r.reader : 'full')
export const reportsList: ToolDef = {
  name: 'reports_list', label: '看已生成的报告', planSafe: true,
  level: 'read',
  description: '列出「报告」页里已经生成的考情分析报告：编号、版本（老板版 / 家长版 / 老师版 / 完整数据版）、范围、生成时间、是否已由老师核对。读内容用 report_read。',
  schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  run: (a, ctx) => {
    const rows = ctx.db.prepare("SELECT rowid AS n, id, reader, filter_json, created_at, confirmed_at, length(markdown) AS len FROM reports WHERE kind = 'report' AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(subjectOf(ctx), a.limit ?? 20) as any[]
    if (!rows.length) return { text: '还没有生成过报告（可以到「报告」页生成）。', count: 0 }
    const lines = rows.map(r => {
      let scope = ''
      try { const f = JSON.parse(r.filter_json ?? '{}'); scope = describeFilter({ grade: f.grade, semester: f.semester, school_year_start: f.school_year_start, exam_type: f.exam_type, textbook: f.textbook, region: f.region }) + (f.paperIds?.length ? `（选中的 ${f.paperIds.length} 份）` : '') } catch { /* 旧格式 */ }
      return `- 编号 ${r.id}｜${READER_LABEL[readerOf(r)]}｜${scope}｜${r.created_at}${r.confirmed_at ? '｜已由老师核对' : '｜AI 草稿'}｜约 ${r.len ?? 0} 字`
    })
    return { text: lines.join('\n'), count: rows.length }
  }
}
export const reportRead: ToolDef = {
  name: 'report_read', label: '读报告',
  level: 'read',
  description: '读一份已生成报告的正文（Markdown）。reportId 来自 reports_list。长报告分段读：from 是起始字位置，一次最多 8000 字，nextFrom 不为空说明后面还有。',
  schema: z.object({ reportId: z.string().min(1).max(80), from: z.number().int().min(0).default(0) }),
  run: (a, ctx) => {
    const r = ctx.db.prepare("SELECT id, reader, markdown, created_at, confirmed_at FROM reports WHERE kind = 'report' AND id = ? AND subject = ?").get(a.reportId, subjectOf(ctx)) as any
    if (!r) return { text: '找不到这份报告，请先用 reports_list 看编号。', count: 0 }
    const md = stripInternalCodes(String(r.markdown ?? ''))
    const from = Math.min(a.from ?? 0, md.length), end = Math.min(md.length, from + 8000)
    return { text: `${READER_LABEL[readerOf(r)]}，生成于 ${r.created_at}${r.confirmed_at ? '，已由老师核对' : '，AI 草稿（老师还没核对）'}；第 ${from}–${end} 字 / 共 ${md.length} 字${end < md.length ? `，后面还有（nextFrom=${end}）` : ''}\n\n${md.slice(from, end)}`, count: 1 }
  }
}

export const DATA_TOOLS: ToolDef[] = [statsOverview, kpQuestions, courseForKp, factCheck, papersList, courseCoverage, reportsList, reportRead]
