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
import type { ToolDef } from '../types.ts'

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
const toFilter = (a: FilterArgs): StatsFilter => {
  const f: StatsFilter = {}
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
export function resolveKp(db: any, input: string): Array<{ code: string; name: string }> {
  const t = input.trim()
  if (!t) return []
  const kps = loadKps(db)
  const byCode = kps.filter(k => k.code.toLowerCase() === t.toLowerCase())
  if (byCode.length) return byCode.map(k => ({ code: k.code, name: k.name }))
  const exact = kps.filter(k => k.name === t)
  if (exact.length) return exact.map(k => ({ code: k.code, name: k.name }))
  const lower = t.toLowerCase()
  return kps.filter(k => k.name.toLowerCase().includes(lower) || lower.includes(k.name.toLowerCase()) && k.name.length >= 2).slice(0, 6).map(k => ({ code: k.code, name: k.name }))
}

const pickKp = (db: any, input: string): { kp: { code: string; name: string } } | { text: string; count: number } => {
  const c = resolveKp(db, input)
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
    const scope = paperScope(toFilter(a))
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
    const p = pickKp(ctx.db, a.kp)
    if ('text' in p) return p
    const limit = a.limit ?? 8
    const cards = questionsOfKp(ctx.db, paperScope(toFilter(a)), p.kp.code, limit + 1)
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
    const p = pickKp(db, a.kp)
    if ('text' in p) return p
    const outlines = db.prepare("SELECT COUNT(*) c FROM course_outlines WHERE active = 1 AND status = 'active'").get().c as number
    if (!outlines) return { text: '软件里还没有导入（或启用）课程大纲，无法查对应的课。', count: 0 }
    const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
      SELECT m.kp_code, m.lesson_id, m.confidence, m.state, m.reason, l.seq, l.no_label, l.title, lv.name AS level_name, o.name AS outline_name
      FROM closure c JOIN course_kp_map m ON m.kp_code = c.code
      JOIN course_lessons l ON l.id = m.lesson_id JOIN course_levels lv ON lv.id = l.level_id
      JOIN course_outlines o ON o.id = m.outline_id AND o.active = 1 AND o.status = 'active'
      WHERE c.anc = ? ORDER BY o.name, lv.sort, l.seq`).all(p.kp.code) as any[]
    const main = rows.filter(isMainMap)
    if (main.length === 0) {
      const checked = (db.prepare("SELECT COUNT(*) c FROM course_kp_check k JOIN course_outlines o ON o.id = k.outline_id WHERE k.kp_code = ? AND o.active = 1").get(p.kp.code) as any).c as number
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
    const ev = collectEvidence(ctx.db, paperScope({}), {})
    const found = checkRules(a.text, ev.statements)
    if (found.length === 0) return { text: '没有发现和软件里审核过的资料矛盾的规则句（也可能这段话里没有规则句）。', count: 0 }
    const kind = { conflict: '与题目解释矛盾', unverified: '查不到依据' } as const
    return { text: found.map((f, i) => `${i + 1}. 【${kind[f.kind]}】${f.sentence}（${f.reason}）`).join('\n'), count: found.length }
  }
}

export const DATA_TOOLS: ToolDef[] = [statsOverview, kpQuestions, courseForKp, factCheck]
