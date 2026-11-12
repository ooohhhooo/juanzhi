// 书库 → 教材课次（单元、页码、单元词表），知识点由程序算（单元词表规则 / 内置目录）；对照表里课本原文命中带出知识点。全部虚构内容。
import assert from 'node:assert/strict'
import { newDb, addPaper } from './helpers/db.mjs'
import { buildBook } from '../../src/main/bookindex/build.ts'
import { saveBook, cacheClear } from '../../src/main/bookindex/store.ts'
import { alignCatalogUnits, lessonsFromBook, syncOutlineFromBook, syncPendingBooks, titleCore, unitHead, unitRuleKps } from '../../src/main/bookindex/outline.ts'
import { createOutline, editMap, getOutline, listOutlines, matchState, applyTextbookMaps } from '../../src/main/course/store.ts'
import { markBuiltinChecked } from '../../src/main/course/textbook-builtin.ts'
import { researchTable } from '../../src/main/course/research-table.ts'
import { bookLessonKps } from '../../src/main/course/book-hit.ts'

const pg = (...lines) => lines
const raw = [
  pg('Cover'),
  pg('CONTENTS', 'Unit 1 Hello!', 'Unit 2 Colours', 'Unit 3 Look at me!', '1', '6', '9'),
  pg('Hi, I’m Zoom.', 'Unit One', '1'),
  pg('Who’s your art teacher?', 'I have an eraser.', 'A pencil box and rulers.', '2'),
  pg('Let’s learn', 'ruler pencil eraser crayon', '3'),
  pg('Look at the plates.', '4'),
  pg('Story time', '5'),
  pg('Good morning.', 'Unit Two', '6'),
  pg('I see red. Colour it blue!', '7'),
  pg('What colour is it? It is green.', '8'),
  pg('Touch your nose.', 'Unit Three', '9'),
  pg('This is my face. Look at my arm.', '10'),
  pg('Appendix 1', 'Words in each unit', '单元词汇表', 'Unit 1', 'ruler   尺子 p.2', 'eraser () 橡皮 p.2', 'pencil box 铅笔盒 p.2', 'crayon 蜡笔 p.3', 'pencil 铅笔 p.3', 'Unit 2', 'red红色 p.7', 'blue 蓝色 p.7', 'green 绿色 p.8', 'Unit 3', 'face 脸 p.10', 'arm 胳膊 p.10', 'nose 鼻子 p.9', '11'),
  pg('')
]
const book = await buildBook({ hash: 'bko1', name: '虚构英语三上', textLayer: async () => raw })
assert.equal(book.structure.via, 'toc')
assert.equal(book.structure.units.length, 3)

const { db } = newDb()
cacheClear()
const lesson = (seq, title, points = []) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points, raw: {} })
const mk = (name, kind, levels) => createOutline(db, { name, scene: kind === 'course' ? 'org' : 'school', termNote: '', sourceName: '虚构.pdf', sourceHash: 'bko1', mapping: null, warnings: [], aiModel: 'mock', status: 'active', levels, kind })
const lid = id => Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons WHERE outline_id = ?').all(id).map(r => [r.title, r.id]))
const mapsOf = id => db.prepare('SELECT m.kp_code, m.source, m.state, m.locked, l.title FROM course_kp_map m JOIN course_lessons l ON l.id = m.lesson_id WHERE m.outline_id = ? ORDER BY l.seq, m.kp_code').all(id)

// ── 小工具 ──
{
  assert.equal(unitHead('Unit 1 Hello!'), 'Unit 1')
  assert.equal(unitHead('第三单元 秋天'), '第三单元')
  assert.equal(unitHead('Recycle 1'), 'Recycle 1')
  assert.equal(titleCore('Unit 1 Hello!'), 'hello')
  assert.deepEqual(alignCatalogUnits(['Unit 1 Hello!', 'Unit 2 Colours', 'Unit 3 Look at me!', 'Recycle 1'], ['Unit 1 Hello', 'Unit 2 Colours', 'Unit 3 Look at me']), [0, 1, 2, null])
  // 旧版书 + 新版目录：标题对不上，不按单元序号硬配
  assert.deepEqual(alignCatalogUnits(['Unit 1 Hello!', 'Unit 2 Colours', 'Unit 3 Look at me!'], ['Unit 1 Making friends', 'Unit 2 Different families', 'Unit 3 Amazing animals']), [null, null, null])
  // 只碰巧对上一个（不到一半）：当作不是同一版，一个都不对
  assert.deepEqual(alignCatalogUnits(['Unit 1 Hello!', 'Unit 2 Colours', 'Unit 3 Animals', 'Unit 4 Food'], ['Unit 1 Making friends', 'Unit 2 Colours', 'Unit 3 Pets', 'Unit 4 Plants']), [null, null, null, null])
  // 单元号不同的不对
  assert.deepEqual(alignCatalogUnits(['Unit 1 Colours', 'Unit 2 Hello'], ['Unit 2 Colours', 'Unit 1 Hello']), [null, null])
  // 单元词表套规则：要好几个同类词；单个常用词不算
  assert.deepEqual(unitRuleKps({ title: 'Unit 1', points: [{ label: '单词', text: 'ruler, eraser, crayon' }] }, ['VO.TOPIC.SCHOOL']).map(x => x.code), ['VO.TOPIC.SCHOOL'])
  assert.deepEqual(unitRuleKps({ title: 'Unit 1', points: [{ label: '单词', text: 'ruler, apple' }] }, ['VO.TOPIC.SCHOOL']), [])
}

// ── 课 ↔ 书库单元带出的知识点（纯函数） ──
{
  const near = () => false
  const u = (kps, score = 70) => [{ unitTitle: 'Unit 1 Hello!', pages: '第 2 页', score, kps }]
  const two = bookLessonKps('ruler, eraser', u([{ code: 'VO.TOPIC.SCHOOL', via: 'words' }]), near)
  assert.equal(two.length, 1); assert.ok(two[0].score >= 60, String(two[0].score))
  assert.equal(two[0].evidence, '课本原文 + 命中词：ruler、eraser（课本 Unit 1 Hello! 第 2 页，单元词表也是这一类）')
  assert.deepEqual(bookLessonKps('ruler', u([{ code: 'VO.TOPIC.SCHOOL', via: 'words' }]), near), [], '只有一个常用词：不挂')
  assert.deepEqual(bookLessonKps('look at the plates', u([{ code: 'VO.TOPIC.SCHOOL', via: 'words' }]), near), [], '单元词表推出来、课上没有对应词：不挂')
  const cat = bookLessonKps('look at the plates', u([{ code: 'FN.GREET', via: 'catalog' }]), near)
  assert.equal(cat.length, 1); assert.equal(cat[0].score, 62); assert.match(cat[0].evidence, /^课本原文 \+ 目录/)
  assert.deepEqual(bookLessonKps('look at the plates', u([{ code: 'FN.GREET', via: 'catalog' }], 55), near), [], '只靠目录时课本命中要够强')
  assert.deepEqual(bookLessonKps('ruler, eraser', u([{ code: 'VO.TOPIC.SCHOOL', via: 'words' }]), c => c === 'VO.TOPIC.SCHOOL'), [], '课里已有相同 / 父子的知识点：跳过')
}

// ── 任务 1：上传的教材课次换成书库单元 ──
// 原来 AI 只整理出两个单元（模拟 AI 抽错），老师确认过两条：一条在书里也有的 Unit 2 上，一条在书里没有的 Unit 9 上
const T = mk('虚构英语三上', 'textbook', [{ name: '虚构英语三上', lessons: [lesson(1, 'Unit 2'), lesson(2, 'Unit 9')] }])
applyTextbookMaps(db, T, [
  { seq: 1, kps: [{ code: 'GR.TENSE.PAST', confidence: 'high', quote: 'Unit 2', reason: 'AI', confirmed: false, manual: false }, { code: 'FN.POLITE', confidence: 'high', quote: '', reason: '', confirmed: true, manual: false }] },
  { seq: 2, kps: [{ code: 'GR.TENSE.FUT', confidence: 'high', quote: '', reason: '', confirmed: true, manual: false }] }
], { model: 'mock', promptVersion: 'x' })
assert.notEqual(matchState(db, T).state, 'done')
saveBook(db, book, { subject: 'english', outlineId: T })
{
  const r = syncOutlineFromBook(db, T, 'bko1', [])
  assert.ok(r, '同步了')
  assert.equal(r.lessons, 3); assert.equal(r.catalog, null)
  const d = getOutline(db, T)
  const ls = d.levels.flatMap(l => l.lessons)
  assert.deepEqual(ls.map(l => l.title), ['Unit 1 Hello!', 'Unit 2 Colours', 'Unit 3 Look at me!'], '课次 = 书库单元')
  assert.deepEqual(ls.map(l => l.noLabel), ['Unit 1', 'Unit 2', 'Unit 3'])
  assert.equal(d.levels[0].name, '虚构英语三上', '只有一个级别时沿用原来的级别名')
  const u1 = ls[0].points
  assert.match(u1.find(p => p.label === '页码').text, /^第 1–5 页（PDF 第 3–7 页）$/)
  assert.equal(u1.find(p => p.label === '单词').text, 'ruler, eraser, pencil box, crayon, pencil', '单元词表')
  assert.equal(d.card.fromBook, true)
  assert.equal(matchState(db, T).state, 'done', '不再需要 AI 匹配')
  assert.equal(listOutlines(db).find(o => o.id === T).fromBook, true)
  const ms = mapsOf(T)
  assert.ok(ms.some(m => m.kp_code === 'VO.TOPIC.SCHOOL' && m.title === 'Unit 1 Hello!' && m.source === 'rule'), JSON.stringify(ms))
  assert.ok(ms.some(m => m.kp_code === 'VO.TOPIC.BODY' && m.title === 'Unit 3 Look at me!' && m.source === 'rule'), '身体部位词')
  assert.ok(!ms.some(m => m.kp_code === 'GR.TENSE.PAST'), 'AI 以前挑的作废')
  assert.ok(ms.some(m => m.kp_code === 'FN.POLITE' && m.state === 'confirmed' && m.title === 'Unit 2 Colours'), '老师确认过的按单元搬到新课次上（不是按序号）')
  assert.ok(!ms.some(m => m.kp_code === 'GR.TENSE.FUT'), '书里没有这个单元：老师那条对不上，丢掉')
  assert.equal(r.teacherKept, 1); assert.equal(r.teacherLost, 1)
  assert.ok(!ms.some(m => m.source === 'rule' && m.title === 'Unit 2 Colours'), '颜色单元没有过线的标志词：不硬挂')
  // 再同步一次：结果一样，版本号不变
  const rev = db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(T).rev
  syncOutlineFromBook(db, T, 'bko1', [])
  assert.equal(db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(T).rev, rev)
  assert.deepEqual(mapsOf(T), ms)
  assert.equal(syncPendingBooks(db, []), 0, '已经是书库课次的不重复同步')
}
// 不该动的：机构课程、内置教材、书库没认出单元
{
  const C = mk('机构乙', 'course', [{ name: '一级', lessons: [lesson(1, 'x')] }])
  assert.equal(syncOutlineFromBook(db, C, 'bko1', []), null)
  db.prepare("UPDATE course_outlines SET builtin_id = 'english-pep:3上' WHERE id = ?").run(C)
  assert.equal(syncOutlineFromBook(db, C, 'bko1', []), null)
  const flat = await buildBook({ hash: 'bko2', name: '没有单元的书', textLayer: async () => Array.from({ length: 12 }, (_, i) => pg(`some text on page ${i + 1} about things`, String(i + 1))) })
  assert.notEqual(flat.structure.via, 'toc'); assert.notEqual(flat.structure.via, 'heading')
  const T2 = mk('没有单元的书', 'textbook', [{ name: '书', lessons: [lesson(1, '第 1–10 页')] }])
  saveBook(db, flat, { subject: 'english', outlineId: T2 })
  assert.equal(lessonsFromBook(db, 'bko2'), null)
  assert.equal(syncOutlineFromBook(db, T2, 'bko2', []), null, 'AI 整理的课次照用')
  assert.equal(getOutline(db, T2).levels[0].lessons[0].title, '第 1–10 页')
  assert.equal(getOutline(db, T2).card.fromBook, false)
}

// ── 任务 2：课本原文命中的课带出知识点 ──
addPaper(db, { title: '校内卷', grade: '3', questions: [{ kp: 'VO.TOPIC.SCHOOL', score: 2, stem: 'I have a new pencil box.' }, { kp: 'GR.TENSE.PAST', score: 2, stem: 'I went home.' }] })
const A = mk('机构甲', 'course', [{ name: '基础级', lessons: [
  lesson(1, 'Stationery', [{ kind: 'word', label: '词汇', text: 'ruler, eraser' }]),
  lesson(2, 'Plates', [{ kind: 'word', label: '词汇', text: 'ruler' }, { kind: 'pattern', label: '句型', text: 'Look at the plates.' }]),
  lesson(3, 'Colours', [{ kind: 'word', label: '词汇', text: 'red, blue, green' }, { kind: 'pattern', label: '句型', text: 'What colour is it?' }]),
  lesson(4, 'Two colours', [{ kind: 'word', label: '词汇', text: 'blue, green' }])
] }])
markBuiltinChecked(db, A, 'english')
{
  const r = researchTable(db, {}, { courseId: A, textbookIds: [T] })
  assert.equal(r.ready, true, r.reason)
  const st = r.lessons.find(l => l.title === 'Stationery')
  assert.ok(st.units.some(u => u.byBook && u.title === 'Unit 1 Hello!'))
  const k = st.kps.find(x => x.code === 'VO.TOPIC.SCHOOL')
  assert.ok(k, '两个文具词 + 课本 Unit 1 的单词表也是文具：挂上「学校生活」')
  assert.equal(k.basis, 'book'); assert.match(k.evidence, /^课本原文 \+ 命中词：ruler、eraser/)
  assert.ok(k.matchScore >= 60)
  assert.ok(k.examples.some(e => /pencil box/.test(e.stem) && /同知识点：学校生活（课：课本原文/.test(e.why)), '校内原题挂得上：' + JSON.stringify(k.examples.map(e => e.why)))
  const pl = r.lessons.find(l => l.title === 'Plates')
  assert.ok(pl.units.some(u => u.byBook && u.title === 'Unit 1 Hello!'), '课本命中 Unit 1')
  assert.deepEqual(pl.kps, [], '只有一个文具词：不挂')
  const col0 = r.lessons.find(l => l.title === 'Colours')
  assert.deepEqual(col0.kps.map(k => [k.code, k.matchScore]), [['FN.POLITE', 62]], '颜色课没有自己的知识点：按老师确认过的单元知识点补')
  assert.match(col0.kps[0].evidence, /^课本原文 \+ 老师确认/)
  assert.ok(r.lessons.find(l => l.title === 'Two colours').units.some(u => u.byBook), '课本命中了')
  assert.deepEqual(r.lessons.find(l => l.title === 'Two colours').kps, [], '课本命中不够强（两个单词）：不凭目录 / 老师确认补')
  assert.ok(!r.tbNotInA.some(u => u.code === 'VO.TOPIC.SCHOOL'), '带出来的知识点不再算「教材有、机构没讲」')
}
// 内置目录（单元标题对得上）：目录里的知识点进教材单元；课本命中够强的课，课上没有标志词也能挂（课本原文 + 目录）
{
  const editions = [{ id: 'english-fake', subject: 'english', edition: '人教PEP', textbookValue: '人教PEP', checkedAt: '2026-01-01', sources: [{ title: 'x', url: 'x' }], books: [{ grade: 3, semester: '上', units: [
    { no: 1, title: 'Unit 1 Hello!', kps: ['FN.GREET', 'GR.VERB.BE', 'NOT.A.CODE'] }, { no: 2, title: 'Unit 2 Colours', kps: ['GR.ADJ.USE'] }, { no: 3, title: 'Unit 3 Look at me!', kps: ['VO.TOPIC.BODY'] }] }] }]
  db.prepare("UPDATE book_files SET edition = '人教版 三年级上册' WHERE id = 'bko1'").run()
  const r0 = syncOutlineFromBook(db, T, 'bko1', editions)
  assert.equal(r0.linkedUnits, 3); assert.equal(r0.catalog, '人教PEP 三年级上册')
  const ms = mapsOf(T)
  assert.ok(ms.some(m => m.kp_code === 'FN.GREET' && m.title === 'Unit 1 Hello!' && m.source === 'builtin'))
  assert.ok(!ms.some(m => m.kp_code === 'NOT.A.CODE'), '知识点树里没有的代码不写')
  assert.ok(ms.some(m => m.kp_code === 'VO.TOPIC.BODY' && m.source === 'rule'), '词表和目录都有：留词表那条（带命中词）')
  const r = researchTable(db, {}, { courseId: A, textbookIds: [T] })
  const pl = r.lessons.find(l => l.title === 'Plates')
  assert.ok(pl.kps.length >= 1 && pl.kps.length <= 3, '每节课最多 3 个主知识点')
  assert.ok(pl.kps.every(k => k.basis === 'book' && /^课本原文 \+ 目录/.test(k.evidence) && k.matchScore === 62), JSON.stringify(pl.kps.map(k => [k.code, k.evidence])))
  assert.ok(!pl.kps.some(k => k.code === 'VO.TOPIC.SCHOOL'), '词表推出来的仍然要课上有标志词')
  const col = r.lessons.find(l => l.title === 'Colours')
  assert.ok(col.kps.some(k => k.code === 'GR.ADJ.USE') && col.kps.length <= 2, JSON.stringify(col.kps.map(k => k.code)))
  const st = r.lessons.find(l => l.title === 'Stationery')
  assert.deepEqual(st.kps.map(k => k.code), ['VO.TOPIC.SCHOOL'], '有自己标志词的课：不再用目录里同单元的其他知识点凑数')
  // 目录对不上（换成旧版标题）：一个目录知识点都不挂
  const old = structuredClone(editions); old[0].books[0].units = [{ no: 1, title: 'Unit 1 Making friends', kps: ['FN.GREET'] }, { no: 2, title: 'Unit 2 Different families', kps: ['GR.ADJ.USE'] }, { no: 3, title: 'Unit 3 Amazing animals', kps: [] }]
  const r1 = syncOutlineFromBook(db, T, 'bko1', old)
  assert.equal(r1.catalog, null); assert.equal(r1.byCatalog, 0)
  assert.ok(!mapsOf(T).some(m => m.source === 'builtin'))
}

console.log('book-outline.test OK')
