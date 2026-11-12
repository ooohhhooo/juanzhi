// 教研对照表：A（+B）× 多份教材 × 试卷范围；例题排序、较粗匹配、修订建议（要补 / 要对齐 / 换例题 / 可减）、空范围、课件、Excel、AI 小结校验。内存库 + 虚构夹具。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { createOutline, editMap } from '../../src/main/course/store.ts'
import { markBuiltinChecked } from '../../src/main/course/textbook-builtin.ts'
import { researchTable, researchTableWithCourseware, adviceCell, clampPerKp, courseMentions } from '../../src/main/course/research-table.ts'
import { researchXlsx, researchSheetRows } from '../../src/main/course/research-xlsx.ts'
import { addCourseware, listCourseware, removeCourseware, readCoursewareText, dropCoursewareOf, pptxText, lessonKey } from '../../src/main/course/courseware.ts'
import { parseAdviceReply, buildAdviceUser } from '../../src/main/course/research-ai.ts'

const { db } = newDb()
useTree(db, [
  ['GR', null, '语法', 1], ['GR.PAST', 'GR', '一般过去时', 2], ['GR.PAST.REG', 'GR.PAST', '规则变化', 3], ['GR.COMP', 'GR', '比较级', 2], ['GR.PLU', 'GR', '名词复数', 2],
  ['RD', null, '阅读', 1], ['RD.DET', 'RD', '细节理解', 2], ['VO', null, '词汇', 1], ['VO.ANI', 'VO', '动物', 2]
])
const q = (kp, extra = {}) => ({ kp, score: 2, stem: `${kp} 的题干`, ...extra })
const p1 = addPaper(db, { title: '卷一', year: 2025, questions: [q('GR.PAST.REG', { err: true, reason: '忘了加 -ed' }), q('GR.PAST.REG'), q('GR.PLU'), q('GR.COMP'), q('RD.DET')] })
const p2 = addPaper(db, { title: '卷二', year: 2025, questions: [q('GR.PAST.REG'), q('GR.PLU', { err: true }), q('GR.COMP'), q('RD.DET')] })
const p3 = addPaper(db, { title: '卷三', year: 2024, questions: [q('GR.PAST.REG'), q('GR.PLU'), q('RD.DET')] })
addPaper(db, { title: '卷四待审核', status: 'reviewing', questions: [q('VO.ANI')] })
// 例题的选项和答案
const one = db.prepare("SELECT id FROM questions WHERE paper_id = ? AND stem = 'GR.PAST.REG 的题干' ORDER BY ord LIMIT 1")
db.prepare('UPDATE questions SET options = ?, answer = ? WHERE id = ?').run(JSON.stringify(['A. played', 'B. plaied']), 'A', one.get(p1).id)

const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
const mkOutline = (name, kind, levels) => createOutline(db, { name, scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels, kind })
const lidOf = id => Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons WHERE outline_id = ?').all(id).map(r => [r.title, r.id]))
const mapTo = (id, pairs) => { const l = lidOf(id); for (const [kp, t] of pairs) editMap(db, { op: 'add', outlineId: id, kp, lessonId: l[t] }); markBuiltinChecked(db, id, 'english') }

// A：基础级 3 课 + 进阶级 1 课（动物课：试卷里没有、教材里也没有 → 可减）
const A = mkOutline('机构大纲甲', 'course', [{ name: '基础级', lessons: [lesson(1, 'Past'), lesson(2, 'Plural'), lesson(3, 'Animals')] }, { name: '进阶级', lessons: [lesson(1, 'Compare')] }])
mapTo(A, [['GR.PAST.REG', 'Past'], ['GR.PLU', 'Plural'], ['VO.ANI', 'Animals'], ['GR.COMP', 'Compare']])
// B：一般过去时（祖先，较粗）+ 细节理解（A 没有）
const B = mkOutline('机构大纲乙', 'course', [{ name: '一级', lessons: [lesson(1, 'Past B'), lesson(2, 'Reading B')] }])
mapTo(B, [['GR.PAST', 'Past B'], ['RD.DET', 'Reading B'], ['GR.PLU', 'Reading B']])
// 教材：三年级上册 u1 = 比较级；五年级上册 u2 = 名词复数 + 细节理解，u3 = 一般过去时（祖先 → 对规则变化较粗）
const T = mkOutline('示例教材', 'textbook', [{ name: '三年级上册', lessons: [lesson(1, 'Unit 1 Big')] }, { name: '五年级上册', lessons: [lesson(2, 'Unit 2 Plurals'), lesson(3, 'Unit 3 Past')] }])
mapTo(T, [['GR.COMP', 'Unit 1 Big'], ['GR.PLU', 'Unit 2 Plurals'], ['RD.DET', 'Unit 2 Plurals'], ['GR.PAST', 'Unit 3 Past']])
{ // 上传教材的页码在要点里
  const tl = lidOf(T)['Unit 2 Plurals']
  db.prepare('UPDATE course_lessons SET points_json = ? WHERE id = ?').run(JSON.stringify([{ kind: 'other', label: '备注', text: '第 18–25 页' }]), tl)
}

const F = {}
const lessonOf = (r, title) => r.lessons.find(l => l.title === title)
const kpOf = (l, code) => l.kps.find(k => k.code === code)

// ── 基本：A 单独、一份教材 ──
{
  const r = researchTable(db, F, { courseId: A, textbookIds: [T] })
  assert.equal(r.ready, true)
  assert.deepEqual(r.lessons.map(l => l.title), ['Past', 'Plural', 'Animals', 'Compare'], 'A 的每一节一行，按级别和课次')
  assert.equal(r.papers, 3, '待审核的卷子不算')
  const past = lessonOf(r, 'Past'), k = kpOf(past, 'GR.PAST.REG')
  assert.equal(k.group, '语法', '按知识点树顶层分组')
  assert.deepEqual([k.papers, k.questions, k.paperTotal], [3, 4, 3], '3 份卷子、4 道题')
  assert.ok(k.frequent, '3/3 份卷子 = 常考')
  // 较粗：教材只有祖先「一般过去时」
  assert.equal(k.locs.length, 1)
  assert.equal(k.locs[0].coarse, true, '只有祖先对得上标较粗')
  assert.match(k.locs[0].label, /第 3|3/)
  // 直接对应 + 页码
  const plu = kpOf(lessonOf(r, 'Plural'), 'GR.PLU')
  assert.equal(plu.locs[0].coarse, false)
  assert.equal(plu.locs[0].pages, '第 18–25 页', '上传教材带页码范围')
  assert.equal(plu.locs[0].levelName, '五年级上册')
  // 例题：易错优先，带选项和答案、卷名、题号
  assert.equal(k.examples.length, 3, '默认 3 道')
  assert.equal(k.examples[0].errorProne, true, '易错的排第一')
  assert.equal(k.examples[0].paperTitle, '卷一')
  assert.deepEqual(k.examples[0].options, ['A. played', 'B. plaied'])
  assert.equal(k.examples[0].answer, 'A')
  assert.equal(new Set(k.examples.map(e => e.paperId)).size, 3, '先取不同卷子的题')
  const r1 = researchTable(db, F, { courseId: A, textbookIds: [T], perKp: 1 })
  assert.equal(kpOf(lessonOf(r1, 'Past'), 'GR.PAST.REG').examples.length, 1)
  assert.equal(clampPerKp(0), 1); assert.equal(clampPerKp(99), 10); assert.equal(clampPerKp('x'), 3); assert.equal(clampPerKp(undefined), 3)
  // 没考过的知识点：没有例题、papers = 0
  const ani = kpOf(lessonOf(r, 'Animals'), 'VO.ANI')
  assert.deepEqual([ani.papers, ani.examples.length], [0, 0])
  // 教材有、A 没讲：细节理解
  assert.deepEqual(r.tbNotInA.map(x => x.code), ['RD.DET'])
  assert.equal(r.tbNotInA[0].papers, 3)
  assert.match(r.tbNotInA[0].units[0], /五年级上册/)
  assert.equal(r.courseB, null); assert.deepEqual([r.onlyA, r.onlyB], [[], []])
}

// ── 修订建议（没有课件） ──
{
  const r = researchTable(db, F, { courseId: A, textbookIds: [T] })
  const kinds = l => l.advice.map(a => a.kind)
  // 名词复数课：同教材单元里还有细节理解，A 整份都没讲 → 要补；有易错原题 → 换例题
  const plural = lessonOf(r, 'Plural')
  const add = plural.advice.find(a => a.kind === 'add')
  assert.ok(add && /细节理解/.test(add.text), '要补：同一教材单元的细节理解')
  assert.ok(add.basis.some(b => /3\/3/.test(b)), '依据里写着校内份数')
  assert.ok(kinds(plural).includes('swap'))
  const swap = plural.advice.find(a => a.kind === 'swap')
  assert.ok(swap.basis.some(b => /《卷二》/.test(b)) && swap.basis.some(b => /易错/.test(b)), '换例题：给出卷名和题号')
  // 比较级课：教材最早在三年级上册，而前面的课已讲到五年级 → 对齐
  const comp = lessonOf(r, 'Compare')
  assert.ok(kinds(comp).includes('align'), '册次顺序和教材倒置 → 要对齐')
  // 动物课：教材没有、校内 0 份 → 可减或超前
  const ani = lessonOf(r, 'Animals')
  assert.ok(kinds(ani).includes('trim'))
  assert.match(adviceCell(ani), /【可减或超前】/)
  assert.match(adviceCell(plural), /暂无|【要补】/)
  // 没有课件时不判断「课件里没有」
  assert.ok(!r.lessons.some(l => l.advice.some(a => a.kind === 'add' && /课件/.test(a.text))))
  assert.match(adviceCell({ advice: [], aiAdvice: '', courseware: [] }), /挂上这一节的课件/)
}

// ── A + B ──
{
  const r = researchTable(db, F, { courseId: A, courseBId: B, textbookIds: [T] })
  const k = kpOf(lessonOf(r, 'Past'), 'GR.PAST.REG')
  assert.equal(k.bLessons.length, 1); assert.equal(k.bLessons[0].coarse, true, 'B 里只有祖先 = 较粗')
  const plu = kpOf(lessonOf(r, 'Plural'), 'GR.PLU')
  assert.equal(plu.bLessons[0].label.includes('2'), true)
  assert.equal(kpOf(lessonOf(r, 'Animals'), 'VO.ANI').bLessons.length, 0)
  assert.deepEqual(r.onlyA.map(x => x.code).sort(), ['GR.COMP', 'VO.ANI'], '只有 A 讲（A 的祖先 / 子孙关系算相关）')
  assert.deepEqual(r.onlyB.map(x => x.code), ['RD.DET'], '只有 B 讲')
  assert.equal(r.onlyB[0].lessons[0].includes('一级'), true)
  // B 和 A 同一份 = 当作没选 B
  assert.equal(researchTable(db, F, { courseId: A, courseBId: A, textbookIds: [] }).courseB, null)
}

// ── 多教材：两份教材各给位置 ──
{
  const T2 = mkOutline('示例教材二', 'textbook', [{ name: '六年级下册', lessons: [lesson(9, 'Unit 9 Plural')] }])
  mapTo(T2, [['GR.PLU', 'Unit 9 Plural']])
  const r = researchTable(db, F, { courseId: A, textbookIds: [T, T2, T] })
  assert.equal(r.textbooks.length, 2, '重复的教材去重')
  const plu = kpOf(lessonOf(r, 'Plural'), 'GR.PLU')
  assert.deepEqual(plu.locs.map(l => l.outlineName), ['示例教材', '示例教材二'])
  // 不选教材：没有教材位置、不出「教材有 A 没讲」
  const r0 = researchTable(db, F, { courseId: A, textbookIds: [] })
  assert.equal(r0.ready, true); assert.deepEqual(r0.tbNotInA, []); assert.deepEqual(kpOf(lessonOf(r0, 'Plural'), 'GR.PLU').locs, [])
}

// ── 空范围、没匹配、否决的对应不算 ──
{
  const r = researchTable(db, { grade: '6' }, { courseId: A, textbookIds: [T] })
  assert.equal(r.ready, true); assert.equal(r.papers, 0)
  assert.ok(r.lessons.every(l => l.kps.every(k => k.examples.length === 0 && k.papers === 0)), '范围里没有卷子：没有例题')
  assert.ok(r.lessons.every(l => l.advice.every(a => a.kind !== 'swap')))
  const nomatch = mkOutline('没匹配的大纲', 'course', [{ name: '级', lessons: [lesson(1, 'X')] }])
  const bad = researchTable(db, F, { courseId: nomatch, textbookIds: [] })
  assert.equal(bad.ready, false); assert.match(bad.reason, /还没有把知识点对应到课/)
  assert.equal(researchTable(db, F, { courseId: 'nope', textbookIds: [] }).ready, false)
  assert.equal(researchTable(db, F, { courseId: T, textbookIds: [] }).ready, false, '教材不能当 A')
  // 否决的对应排除
  const l = lidOf(A)
  editMap(db, { op: 'reject', kp: 'GR.PLU', lessonId: l.Plural })
  const r2 = researchTable(db, F, { courseId: A, textbookIds: [] })
  assert.equal(lessonOf(r2, 'Plural').kps.length, 0, '否决的对应不出现')
  assert.equal(adviceCell(lessonOf(r2, 'Plural')).length > 0, true)
  editMap(db, { op: 'reset', kp: 'GR.PLU', lessonId: l.Plural })
  editMap(db, { op: 'add', outlineId: A, kp: 'GR.PLU', lessonId: l.Plural })
  // 别的学科看不到
  assert.equal(researchTable(db, { subject: 'math' }, { courseId: A, textbookIds: [] }).ready, false)
}

// ── 课件：挂上后判断「课件里没有」 ──
{
  assert.equal(courseMentions('thepasttenseplayed', '一般过去时', ''), false)
  assert.equal(courseMentions('一般过去时的用法', '一般过去时', ''), true)
  assert.equal(courseMentions('we learn played watched', '一般过去时', 'played, watched'), true, '词表里的词也算')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-cw-'))
  try {
    const it = addCourseware(dir, A, lessonKey('基础级', 2), '复数课件.pdf', '本课讲 cats dogs 的复数规则，名词复数的变化。')
    assert.equal(listCourseware(dir, A).length, 1)
    assert.equal(readCoursewareText(dir, A, it.id).text.includes('cats'), true)
    assert.equal(addCourseware(dir, A, lessonKey('基础级', 2), '复数课件.pdf', '改过').chars, 2, '同名覆盖')
    assert.equal(listCourseware(dir, A).length, 1)
    addCourseware(dir, A, lessonKey('基础级', 2), '复数课件.pdf', '本课讲 cats dogs 的复数规则，名词复数的变化。')
    addCourseware(dir, A, lessonKey('基础级', 1), '过去时课件.docx', '今天讲 played 和 watched。')   // 没有写「一般过去时」，但词表里没有这些词 → 不算讲到
    const r = researchTableWithCourseware(db, dir, F, { courseId: A, textbookIds: [T] })
    const plural = lessonOf(r, 'Plural'), past = lessonOf(r, 'Past')
    assert.equal(plural.courseware[0].name, '复数课件.pdf')
    assert.ok(!plural.advice.some(a => a.kind === 'add' && a.kpCode === 'GR.PLU'), '课件里提到了名词复数 → 不用补')
    assert.ok(past.advice.some(a => a.kind === 'add' && a.kpCode === 'GR.PAST.REG' && /课件/.test(a.text)), '课件里没出现一般过去时 / 规则变化 → 要补')
    assert.equal(r.summary.coursewareFiles, 2)
    // Excel（给「基础级 第 2 课」再挂一个知识点，让它占两行）
    editMap(db, { op: 'add', outlineId: A, kp: 'RD.DET', lessonId: lidOf(A).Plural })
    const r3 = researchTableWithCourseware(db, dir, F, { courseId: A, textbookIds: [T] })
    const buf = await researchXlsx(r3, { filterDesc: "全部试卷", generatedAt: '2026-11-12 10:00' })
    const zip = await JSZip.loadAsync(buf)
    const names = (await zip.file('xl/workbook.xml').async('string')).match(/name="([^"]+)"/g)
    assert.deepEqual(names, ['name="对照表"', 'name="教材有机构没讲"', 'name="说明"'])
    const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string')
    assert.match(sheet1, /state="frozen"/, '冻结首行')
    assert.match(sheet1, /<mergeCell ref="A\d+:A\d+"\/>/, '一节课多行时合并课程列')
    assert.match(sheet1, /wrapText|ht="/)
    const sst = await zip.file('xl/sharedStrings.xml').async('string')
    for (const s of ['基础级 第 1 课', '规则变化', '卷一', '修订建议', '示例教材', '第 18–25 页', '答案：A']) assert.ok(sst.includes(s), `共享字符串里有「${s}」`)
    assert.ok(!/手机|电话|\d{11}/.test(sst), '不含学员信息')
    const rb = researchTable(db, F, { courseId: A, courseBId: B, textbookIds: [T] })
    const zb = await JSZip.loadAsync(await researchXlsx(rb, { filterDesc: 'x', generatedAt: 'y' }))
    assert.deepEqual((await zb.file('xl/workbook.xml').async('string')).match(/name="([^"]+)"/g), ['name="对照表"', 'name="只有A、只有B"', 'name="教材有机构没讲"', 'name="说明"'])
    const flat = researchSheetRows(rb)
    assert.equal(flat.header.includes('「机构大纲乙」里对应的课'), true)
    assert.equal(flat.flat.length, flat.rows.length - 1)
    assert.equal(removeCourseware(dir, A, it.id), true); assert.equal(listCourseware(dir, A).length, 1)
    dropCoursewareOf(dir, A); assert.equal(listCourseware(dir, A).length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// ── pptx 文字 ──
{
  const zip = new JSZip()
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Second &amp; last</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>一般过去时</a:t></a:r></a:p><a:p><a:r><a:t>played</a:t></a:r><a:r><a:t> / watched</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><a:p><a:r><a:t>先复习</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>')
  const t = await pptxText(await zip.generateAsync({ type: 'uint8array' }))
  assert.equal(t, '【第 1 页】\n一般过去时\nplayed / watched\n（备注）先复习\n\n【第 2 页】\nSecond & last')
  await assert.rejects(() => pptxText(new Uint8Array([1, 2, 3])), /打不开/)
  const noSlides = await new JSZip().file('a.txt', 'x').generateAsync({ type: 'uint8array' })
  await assert.rejects(() => pptxText(noSlides), /没有找到幻灯片/)
}

// ── AI 小结的校验：只能用依据里的数字 ──
{
  const l = { levelName: '基础级', label: '第 2 课', advice: [{ kind: 'swap', text: '「名词复数」建议用校内原题做例题', basis: ['校内 3/3 份卷子考过', '原题：《卷二》第 2 题'] }] }
  assert.match(buildAdviceUser(l, 'x'.repeat(5000)), /【换例题】/)
  assert.ok(buildAdviceUser(l, 'x'.repeat(5000)).length < 1900, '课件摘录有长度上限')
  assert.equal(parseAdviceReply('{"summary":"校内 3/3 份卷子考过，建议用《卷二》第 2 题做例题。"}', l), '校内 3/3 份卷子考过，建议用《卷二》第 2 题做例题。')
  assert.equal(parseAdviceReply('```json\n{"summary":"第 2 课校内 3/3 份卷子考过。"}\n```', l)?.includes('3/3'), true)
  assert.equal(parseAdviceReply('{"summary":"校内 9/10 份卷子考过"}', l), null, '编了数字 → 丢掉')
  assert.equal(parseAdviceReply('不是 JSON', l), null)
  assert.equal(parseAdviceReply('{"summary":""}', l), null)
  assert.equal(parseAdviceReply(`{"summary":"${'字'.repeat(300)}"}`, l), null, '超长丢掉')
}
// ── 助手工具：research_table / textbook_locate / lesson_kps / courseware_read ──
{
  const { RESEARCH_TOOLS, findLessons } = await import('../../src/main/agent/tools/research.ts')
  const { createSession } = await import('../../src/main/agent/store.ts')
  const { listOutputs, readTableRows } = await import('../../src/main/agent/outputs/store.ts')
  const [tTable, tLocate, tLesson, tRead] = ['research_table', 'textbook_locate', 'lesson_kps', 'courseware_read'].map(n => RESEARCH_TOOLS.find(t => t.name === n))
  assert.ok(tTable && tLocate && tLesson && tRead)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-rt-'))
  try {
    const sid = createSession(db, { id: 'rs1', role: 'research', scene: 'org', title: 't' })
    const ctx = { db, sessionId: sid, dataDir: dir }
    // 名字对不上 / 缺：提示现有的
    assert.match((await tTable.run({ course: '不存在的大纲', per_kp: 3 }, ctx)).text, /没有找到.*现有：.*《机构大纲甲》/)
    assert.match((await tTable.run({ per_kp: 3 }, ctx)).text, /请指定机构大纲的名字/, '有多份大纲时必须指定')
    assert.match((await tTable.run({ course: '机构大纲甲', textbooks: ['乱写'], per_kp: 3 }, ctx)).text, /没有找到叫「乱写」的教材/)
    // 生成：摘要 + 产出表格 + xlsx 文件
    const out = await tTable.run({ course: '机构大纲甲', course_b: '乙', textbooks: ['示例教材'], per_kp: 2 }, ctx)
    assert.equal(out.count, 4)
    assert.match(out.text, /共 4 节课/); assert.match(out.text, /Past|第 1 课/); assert.match(out.text, /只有 A 讲/); assert.match(out.text, /教材有、A 没讲/)
    const tables = listOutputs({ dataDir: dir, sessionId: sid }).filter(e => e.type === 'table')
    assert.equal(tables.length, 1); assert.match(tables[0].name, /^教研对照表-机构大纲甲/)
    const saved = readTableRows({ dataDir: dir, sessionId: sid }, tables[0].id)
    assert.ok(saved.columns.includes('修订建议') && saved.rows.length >= 4, '产出表格含修订建议列')
    const xlsx = path.join(dir, 'agent-outputs', sid, 'exports', '教研对照表-机构大纲甲.xlsx')
    assert.ok(fs.existsSync(xlsx) || out.text.includes('.xlsx'), '带格式的 xlsx 已写')
    // 教材定位
    const loc = tLocate.run({ kp: '名词复数' }, ctx)
    assert.match(loc.text, /示例教材/); assert.match(loc.text, /第 18–25 页/)
    assert.match(tLocate.run({ kp: '一般过去时' }, ctx).text, /较粗|Unit 3/)
    assert.match(tLocate.run({ kp: 'Unit 3' }, ctx).text, /Unit 3 Past/, '关键词在单元标题里找')
    assert.match(tLocate.run({ kp: '根本没有的词xyz' }, ctx).text, /没有叫/)
    // 这节课的知识点和例题
    assert.deepEqual(findLessons([{ seq: 3, label: '第 3 课', title: 'Animals', levelName: '基础级' }, { seq: 1, label: '第 1 课', title: 'Compare', levelName: '进阶级' }], '第 3 节').map(l => l.title), ['Animals'])
    const ls = tLesson.run({ course: '机构大纲甲', lesson: '第 1 节', level: '基础', textbooks: ['示例教材'], per_kp: 2 }, ctx)
    assert.match(ls.text, /规则变化/); assert.match(ls.text, /《卷一》第/); assert.match(ls.text, /修订建议/)
    assert.match(tLesson.run({ course: '机构大纲甲', lesson: '1' }, ctx).text, /对应多节课/, '两个级别都有第 1 课：要求指定级别')
    // 读课件
    addCourseware(dir, A, lessonKey('基础级', 2), '复数课件.pdf', '0123456789'.repeat(100))
    const rd = tRead.run({ course: '机构大纲甲', lesson: '第 2 节', level: '基础', max_chars: 500 }, ctx)
    assert.match(rd.text, /共 1000 字，后面还有（nextFrom=500）/)
    assert.equal(tRead.run({ course: '机构大纲甲', lesson: '第 2 节', level: '基础', from: 500, max_chars: 500 }, ctx).text.endsWith('0123456789'), true)
    assert.match(tRead.run({ course: '机构大纲甲', lesson: '第 3 节', level: '基础' }, ctx).text, /还没有挂课件/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

console.log('research-table.test.mjs OK')
