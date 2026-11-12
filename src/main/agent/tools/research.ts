/**
 * 教研 / 主讲老师的工具：教研对照表、教材定位、查某一节课对应的知识点和校内例题、读某一节挂的课件文字。
 * 数字和位置全部由程序算（course/research-table.ts），本文件只负责把结果整理成给模型看的文字，并把对照表存成产出（表格 + 带格式的 xlsx）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef, ToolCtx } from '../types.ts'
import { FilterShape, subjectOf, toFilter, describeFilter, resolveKp } from './data.ts'
import { researchTableWithCourseware, findOutlineByName, locateInTextbooks, adviceCell, ADVICE_LABEL, clampPerKp } from '../../course/research-table.ts'
import type { ResearchTable, RLesson, LessonPick } from '../../course/research-table.ts'
import { researchXlsx, researchSheetRows, locText, schoolCell, exampleText, lessonTitleOf } from '../../course/research-xlsx.ts'
import { coursewareOfLesson, lessonKey, listCourseware } from '../../course/courseware.ts'
import { saveTable, safeFileStem } from '../outputs/store.ts'
import { exportsDir } from '../outputs/export.ts'
import { listOutlines } from '../../course/store.ts'
import { lessonName } from '../../course/map.ts'

const clip = (t: string, n: number): string => { const x = (t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x }

type Ref = { outline: { id: string; name: string } } | { error: string }
const need = (r: Ref): { id: string; name: string } | { text: string; count: number } => 'error' in r ? { text: r.error, count: 0 } : r.outline

/** 教材名列表 → 教材 id；没写 = 本学科已有的全部教材（最多 8 份） */
function pickBooks(ctx: ToolCtx, names: string[] | undefined): { ids: string[] } | { text: string; count: number } {
  if (!names?.length) {
    const all = listOutlines(ctx.db, subjectOf(ctx)).filter(o => o.status === 'active' && o.kind === 'textbook')
    return { ids: all.slice(0, 8).map(o => o.id) }
  }
  const ids: string[] = []
  for (const n of names.slice(0, 8)) {
    const r = need(findOutlineByName(ctx.db, subjectOf(ctx), n, 'textbook'))
    if ('text' in r) return r
    ids.push(r.id)
  }
  return { ids }
}

/** 「第 3 节」「3」「Past」→ 这份大纲里的课（可能多个） */
export function findLessons(lessons: RLesson[], spec: string, level?: string): RLesson[] {
  const t = spec.trim()
  const pool = level ? lessons.filter(l => l.levelName.includes(level)) : lessons
  const num = /^(?:第\s*)?(\d{1,5})\s*(?:节|课|讲)?$/.exec(t)
  if (num) {
    // 同时比课次编号（大纲里写的“第 5 课”）和排序号：两种都命中就都列出来，让用户选
    const n = Number(num[1])
    return pool.filter(l => l.seq === n || /^\d+$/.test((l.noLabel ?? '').trim()) && Number(l.noLabel!.trim()) === n || (/^第\s*(\d+)\s*[课节讲]/.exec((l.noLabel ?? '').trim())?.[1] === String(n)))
  }
  const low = t.toLowerCase()
  const exact = pool.filter(l => l.label === t || l.title.toLowerCase() === low)
  return exact.length ? exact : pool.filter(l => l.label.toLowerCase().includes(low) || l.title.toLowerCase().includes(low))
}

const lessonLine = (l: RLesson): string => `${lessonTitleOf(l)}${l.title && !l.label.includes(l.title) ? ` ${l.title}` : ''}`

// ───────── research_table ─────────
export const researchTable: ToolDef = {
  name: 'research_table', label: '生成教研对照表',
  level: 'read',
  description: '教研对照表：以机构大纲 A 的每一节课为一行，列出这节课对应的知识点（按知识点大类分组）、学校教材里这个知识点在哪一册哪个单元（上传的教材带页码范围）、校内试卷里考过的原题（常考 / 易错优先）、选了 B 时 B 里对应的课，以及每节课的修订建议（要补 / 要对齐 / 换例题 / 可减或超前，依据由程序算出）。另出「只有 A 讲 / 只有 B 讲」和「教材有、A 没讲」。生成后存成本次任务的产出表格，并写一份带格式的 xlsx（对照表 / 只有A、只有B / 教材有机构没讲 / 说明）放在本任务的 exports 文件夹里。课件文字（如果挂了）只用来判断「讲没讲到」。course / course_b / textbooks 写名字，不写 textbooks = 用已有的教材（最多 8 份）。',
  schema: z.object({
    course: z.string().max(80).optional().describe('机构大纲 A 的名字；只有一份大纲时可以不写'),
    course_b: z.string().max(80).optional().describe('机构大纲 B 的名字（可选，用来对比 A 和 B）'),
    textbooks: z.array(z.string().max(80)).max(8).optional().describe('教材名列表（内置或上传的），不写 = 已有的教材'),
    per_kp: z.number().int().min(1).max(10).default(3).describe('每个知识点列几道校内例题，1 到 10，默认 3'),
    ...FilterShape
  }),
  run: async (a, ctx) => {
    const subject = subjectOf(ctx)
    const A = need(findOutlineByName(ctx.db, subject, a.course, 'course'))
    if ('text' in A) return A
    let B: { id: string; name: string } | undefined
    if (a.course_b) { const r = need(findOutlineByName(ctx.db, subject, a.course_b, 'course')); if ('text' in r) return r; B = r }
    const bk = pickBooks(ctx, a.textbooks)
    if ('text' in bk) return bk
    const filter = toFilter(a, subject)
    const t = researchTableWithCourseware(ctx.db, ctx.dataDir, filter, { courseId: A.id, courseBId: B?.id, textbookIds: bk.ids, perKp: clampPerKp(a.per_kp) })
    if (!t.ready) return { text: t.reason, count: 0 }
    const scope = { dataDir: ctx.dataDir, sessionId: ctx.sessionId }
    const name = `教研对照表-${A.name}`.slice(0, 80)
    const flat = researchSheetRows(t)
    saveTable(scope, name, flat.header, flat.flat)
    let file = ''
    try {
      const dir = exportsDir(scope)
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `${safeFileStem(name)}.xlsx`)
      fs.writeFileSync(file, await researchXlsx(t, { filterDesc: describeFilter(a), generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), includeReviewing: !!a.include_reviewing }))
    } catch { file = '' }
    return { text: summaryText(t, describeFilter(a), name, file, !!a.include_reviewing), count: t.lessons.length }
  }
}

function summaryText(t: ResearchTable, desc: string, name: string, file: string, includeReviewing: boolean): string {
  const s = t.summary
  const out = [
    `教研对照表《${t.course!.name}》${t.courseB ? ` 对 《${t.courseB.name}》` : ''}${t.textbooks.length ? `，教材：${t.textbooks.map(b => `《${b.name}》`).join('、')}` : '，没选教材'}`,
    `范围：${desc}，${includeReviewing ? '试卷（含待审核）' : '已审核试卷'} ${t.papers} 份${t.smallSample ? '（少于 3 份，不标「常考」）' : ''}；每个知识点最多 ${t.perKp} 道例题`,
    `共 ${s.lessons} 节课、${s.kps} 个知识点（${s.kpsWithExamples} 个有校内例题）、${s.coursewareFiles} 份课件；修订建议 ${s.adviceItems} 条${t.courseB ? `；只有 A 讲 ${s.onlyA} 个、只有 B 讲 ${s.onlyB} 个` : ''}${t.textbooks.length ? `；教材有、A 没讲 ${s.tbNotInA} 个` : ''}`,
    `已存成产出表格「${name}」（在产出里可以导出 xlsx）${file ? `；带格式的 Excel 已写到：${file}` : ''}`,
    '', '各节课：'
  ]
  for (const l of t.lessons.slice(0, 30)) {
    const kpText = l.kps.slice(0, 4).map(k => `${k.name}（${k.matchLabel}${k.avgScore ? `，校内约占 ${k.avgScore} 分` : ''}，${k.papers}/${k.paperTotal} 份${k.errorCount ? '，易错' : ''}）`).join('、')
    const kinds = (['add', 'align', 'swap', 'trim'] as const).map(k => [k, l.advice.filter(x => x.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${ADVICE_LABEL[k]} ${n}`).join('、')
    out.push(`- ${lessonLine(l)}：${l.kps.length ? `${l.kps.length} 个知识点：${kpText}${l.kps.length > 4 ? ' 等' : ''}` : '没有对应的知识点'}${l.courseware.length ? `｜课件：${l.courseware.map(c => c.name).join('、')}` : ''}${kinds ? `｜建议：${kinds}` : ''}`)
  }
  if (t.lessons.length > 30) out.push(`……还有 ${t.lessons.length - 30} 节课，完整内容在表格里`)
  if (t.tbNotInA.length) out.push('', `教材有、A 没讲（前 ${Math.min(8, t.tbNotInA.length)}）：${t.tbNotInA.slice(0, 8).map(r => `${r.name}（${r.papers}/${r.paperTotal} 份卷子${r.frequent ? '，常考' : ''}）`).join('；')}`)
  if (t.courseB) {
    if (t.onlyA.length) out.push(`只有 A 讲（前 8）：${t.onlyA.slice(0, 8).map(r => r.name).join('、')}`)
    if (t.onlyB.length) out.push(`只有 B 讲（前 8）：${t.onlyB.slice(0, 8).map(r => r.name).join('、')}`)
  }
  out.push('', '说明：知识点对应是 AI 匹配的结果（内置教材来自目录），请教研核对；修订建议的依据在表格「修订建议」列里，每条都带数字和位置。要看某一节的例题和课件，用 lesson_kps / courseware_read。')
  return out.join('\n')
}

// ───────── textbook_locate ─────────
export const textbookLocate: ToolDef = {
  name: 'textbook_locate', label: '查教材里在哪一册哪个单元',
  level: 'read',
  description: '查某个知识点（写中文名或代码，如「一般过去时」）在各内置 / 上传教材里的哪一册哪个单元（上传的教材带页码范围）；只有更大的类别对得上时标「较粗」。也可以写关键词（如「Unit 3」「分数」），会在教材单元的标题里找。textbooks 不写 = 已有的全部教材。',
  schema: z.object({
    kp: z.string().min(1).max(80).describe('知识点的中文名或代码，或单元标题里的关键词'),
    textbooks: z.array(z.string().max(80)).max(8).optional().describe('教材名列表；不写 = 已有的全部教材')
  }),
  run: (a, ctx) => {
    const subject = subjectOf(ctx)
    let ids: string[] | undefined
    if (a.textbooks?.length) { const bk = pickBooks(ctx, a.textbooks); if ('text' in bk) return bk; ids = bk.ids }
    const cands = resolveKp(ctx.db, a.kp, subject)
    if (cands.length) {
      const r = locateInTextbooks(ctx.db, subject, cands.slice(0, 4).map(c => c.code), ids)
      if (!r.books.length) return { text: '软件里还没有添加教材，请先到“课程”里添加内置教材或上传教材。', count: 0 }
      const out = [`在 ${r.books.length} 份教材里查：${r.books.map(b => `《${b.name}》`).join('、')}`]
      let n = 0
      for (const c of cands.slice(0, 4)) {
        const locs = r.byCode.get(c.code) ?? []
        out.push('', `${c.name}（代码 ${c.code}）：${locs.length ? '' : '这些教材里没有找到'}`)
        for (const l of locs.slice(0, 30)) { out.push(`- ${locText(l)}${l.title ? `《${clip(l.title, 30)}》` : ''}`); n++ }
        if (locs.length > 30) out.push(`……还有 ${locs.length - 30} 处`)
      }
      if (cands.length > 1) out.push('', `「${a.kp}」可能指多个知识点，上面都列了；要精确的话请用准确的名字或代码。`)
      return { text: out.join('\n'), count: n }
    }
    // 关键词：在教材单元的标题 / 检索文字里找
    const books = listOutlines(ctx.db, subject).filter(o => o.status === 'active' && o.kind === 'textbook' && (!ids || ids.includes(o.id)))
    if (!books.length) return { text: '软件里还没有添加教材，请先到“课程”里添加内置教材或上传教材。', count: 0 }
    const kw = a.kp.trim().toLowerCase()
    const rows = ctx.db.prepare(`SELECT o.name oname, lv.name lvname, l.no_label, l.title, l.search_text FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id JOIN course_outlines o ON o.id = l.outline_id
      WHERE l.outline_id IN (SELECT value FROM json_each(?)) ORDER BY o.name, lv.sort, l.seq`).all(JSON.stringify(books.map(b => b.id))) as any[]
    const hit = rows.filter(r => String(r.search_text ?? '').toLowerCase().includes(kw) || String(r.title ?? '').toLowerCase().includes(kw)).slice(0, 30)
    if (!hit.length) return { text: `没有叫「${a.kp}」的知识点，教材单元标题里也没有找到。可以换个说法，或先用 stats_overview 看看有哪些知识点。`, count: 0 }
    return { text: [`知识点里没有「${a.kp}」，在教材单元标题里找到：`, ...hit.map(r => `- ${r.oname === r.lvname ? '' : `${r.oname}：`}${r.lvname} ${r.no_label ?? ''}《${clip(r.title ?? '', 30)}》`)].join('\n'), count: hit.length }
  }
}

// ───────── lesson_kps ─────────
export const lessonKps: ToolDef = {
  name: 'lesson_kps', label: '查这节课对应的知识点和例题',
  level: 'read',
  description: '查机构大纲里某一节课对应的知识点（高 / 中把握和老师确认过的）、每个知识点在教材里的位置、校内试卷里考过的原题（题干、选项、答案、卷名、题号、是否易错），以及这节课的修订建议。lesson 写「第 3 节」「3」或标题关键词；同一大纲有多个级别时用 level 区分。textbooks 不写 = 已有的教材。',
  schema: z.object({
    course: z.string().max(80).optional().describe('机构大纲的名字；只有一份时可以不写'),
    lesson: z.string().min(1).max(60).describe('课的编号或标题关键词，如「第 3 节」「Past」'),
    level: z.string().max(40).optional().describe('级别名（大纲里有多个级别时用）'),
    textbooks: z.array(z.string().max(80)).max(8).optional(),
    per_kp: z.number().int().min(1).max(10).default(3).describe('每个知识点列几道例题，默认 3'),
    ...FilterShape
  }),
  run: (a, ctx) => {
    const subject = subjectOf(ctx)
    const A = need(findOutlineByName(ctx.db, subject, a.course, 'course'))
    if ('text' in A) return A
    const bk = pickBooks(ctx, a.textbooks)
    if ('text' in bk) return bk
    // 只算被问到的那一节（其余节不查例题、不出建议），整张表算一遍太慢
    const pick: LessonPick = l => findLessons([l as unknown as RLesson], a.lesson, a.level).length > 0
    const t = researchTableWithCourseware(ctx.db, ctx.dataDir, toFilter(a, subject), { courseId: A.id, textbookIds: bk.ids, perKp: clampPerKp(a.per_kp), lessonFilter: pick })
    if (!t.ready) return { text: t.reason, count: 0 }
    const hit = findLessons(t.lessons, a.lesson, a.level)
    if (!hit.length) return { text: `《${A.name}》里没有找到「${a.lesson}」。可以写课的编号（如「第 3 节」）或标题里的词。`, count: 0 }
    if (hit.length > 1) return { text: `「${a.lesson}」对应多节课，请指定级别（level）或写得更具体：\n${hit.slice(0, 12).map(l => `- ${lessonLine(l)}`).join('\n')}`, count: hit.length }
    const l = hit[0]
    const out = [`《${A.name}》${lessonLine(l)}｜范围：${describeFilter(a)}，${a.include_reviewing ? '试卷（含待审核）' : '已审核试卷'} ${t.papers} 份`]
    if (!l.kps.length) out.push('这节课还没有对应的知识点（可能没匹配，或对应都是低把握 / 被否决的）。')
    for (const g of l.groups) {
      out.push('', `【${g.name}】`)
      for (const k of g.kps) {
        out.push(`- ${k.name}（代码 ${k.code}）：${schoolCell(k, t.hasScores)}｜匹配把握：${k.matchLabel}${k.evidence ? `（${k.evidence}）` : ''}`)
        k.examples.forEach((e, i) => out.push(`  例题 ${exampleText(e, i).split('\n').map((x, j) => (j ? `    ${clip(x, 160)}` : x)).join('\n')}`))
      }
    }
    if (t.textbooks.length) out.push('', `教材位置：${l.units.length ? l.units.map(u => `${locText(u)}（${u.similarity}；${u.evidence}${u.byCatalog ? '；按目录' : ''}${u.byBook ? '；课本原文' : ''}）`).join('；') : '所选教材里没有足够像的单元'}`)
    out.push('', '修订建议（程序规则，带依据）：', adviceCell(l))
    if (l.courseware.length) out.push('', `这节挂了课件：${l.courseware.map(c => `${c.name}（${c.chars} 字）`).join('、')}；要读内容用 courseware_read。`)
    return { text: out.join('\n'), count: l.kps.length }
  }
}

// ───────── courseware_read ─────────
export const coursewareRead: ToolDef = {
  name: 'courseware_read', label: '读课件文字',
  level: 'read',
  description: '读某一节课挂的课件文字（用户在「课程 → 教研对照」里给这一节挂的 PDF / Word / PPT，文字只在本机读出来）。lesson 写「第 3 节」或标题关键词；一节有多份课件时用 file 指定文件名。长文分段读：from 是起始字位置，一次最多 max_chars 字（默认 6000，最多 20000），nextFrom 不为空说明后面还有。没挂课件会说明。',
  schema: z.object({
    course: z.string().max(80).optional().describe('机构大纲的名字；只有一份时可以不写'),
    lesson: z.string().min(1).max(60).describe('课的编号或标题关键词'),
    level: z.string().max(40).optional().describe('级别名'),
    file: z.string().max(120).optional().describe('课件文件名（一节有多份时）'),
    from: z.number().int().min(0).default(0),
    max_chars: z.number().int().min(500).max(20000).default(6000)
  }),
  run: (a, ctx) => {
    const subject = subjectOf(ctx)
    const A = need(findOutlineByName(ctx.db, subject, a.course, 'course'))
    if ('text' in A) return A
    const rows = ctx.db.prepare(`SELECT l.id, l.seq, l.no_label, l.title, lv.name level_name FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id WHERE l.outline_id = ? ORDER BY lv.sort, l.seq`).all(A.id) as any[]
    const lessons = rows.map(r => ({ lessonId: r.id, levelName: r.level_name, seq: r.seq, label: lessonName({ seq: r.seq, noLabel: r.no_label, title: r.title }), noLabel: String(r.no_label ?? ''), title: r.title ?? '' })) as unknown as RLesson[]
    const hit = findLessons(lessons, a.lesson, a.level)
    if (!hit.length) return { text: `《${A.name}》里没有找到「${a.lesson}」。`, count: 0 }
    if (hit.length > 1) return { text: `「${a.lesson}」对应多节课，请指定级别（level）或写得更具体：\n${hit.slice(0, 12).map(l => `- ${lessonLine(l)}`).join('\n')}`, count: hit.length }
    const l = hit[0]
    let files = coursewareOfLesson(ctx.dataDir, A.id, lessonKey(l.levelName, l.seq))
    if (!files.length) return { text: `《${A.name}》${lessonLine(l)} 还没有挂课件（在“课程 → 教研对照”里点这一节的“挂课件”）。${listCourseware(ctx.dataDir, A.id).length ? '这份大纲的其他节挂了课件。' : ''}`, count: 0 }
    if (a.file) { const f = files.filter(x => x.name.includes(a.file!)); if (!f.length) return { text: `这一节的课件有：${files.map(x => x.name).join('、')}，没有叫「${a.file}」的。`, count: 0 }; files = f }
    if (files.length > 1) return { text: `这一节挂了 ${files.length} 份课件，请用 file 指定：${files.map(x => `${x.name}（${x.chars} 字）`).join('、')}`, count: files.length }
    const f = files[0]
    const from = Math.min(a.from ?? 0, f.text.length), end = Math.min(f.text.length, from + (a.max_chars ?? 6000))
    return { text: `${lessonLine(l)} 的课件「${f.name}」第 ${from}–${end} 字 / 共 ${f.text.length} 字${end < f.text.length ? `，后面还有（nextFrom=${end}）` : ''}\n\n${f.text.slice(from, end)}`, count: 1 }
  }
}

export const RESEARCH_TOOLS: ToolDef[] = [researchTable, textbookLocate, lessonKps, coursewareRead]
