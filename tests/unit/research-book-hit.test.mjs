// 对照表接书库：用上传整本教材的原文逐字搜（原文命中、页码、单元投票、每版本最多 1–2 个单元）；没有书库的册维持「按目录」。
// 另：试卷审核自动通过的判定（一致 / 父子 / 不一致 / 规则认不出 / 低把握）。全部虚构内容。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { buildBook } from '../../src/main/bookindex/build.ts'
import { saveBook, cacheClear } from '../../src/main/bookindex/store.ts'
import { createOutline, editMap } from '../../src/main/course/store.ts'
import { markBuiltinChecked } from '../../src/main/course/textbook-builtin.ts'
import { researchTable } from '../../src/main/course/research-table.ts'
import { bookUnitHits, pickBookUnits } from '../../src/main/course/book-hit.ts'
import { judgeAutoApprove, AUTO_APPROVED_FLAG } from '../../src/main/parse/auto-approve.ts'
import { AiConfigSchema, DEFAULT_AI_CONFIG } from '../../src/main/ai/types.ts'

const pg = (...lines) => lines
const raw = [
  pg('Cover'),
  pg('CONTENTS', 'Unit 1 Hello!', 'Unit 2 Colours', '1', '6'),
  pg('Hi, I’m Zoom.', 'Unit One', '1'),
  pg('Who’s your art teacher?', 'I have an eraser.', 'A pencil box and rulers.', '2'),
  pg('Let’s learn', 'ruler pencil eraser', '3'),
  pg('Look at the plates.', '4'),
  pg('Story time', '5'),
  pg('Good morning.', 'Unit Two', '6'),
  pg('I see red. Colour it blue!', '7'),
  pg('What colour is it? It is green.', '8'),
  pg('Sing a song', '9'),
  pg('Fill in the blanks.', '10'),
  pg('Appendix 1', 'Words in each unit', '单元词汇表', 'Unit 1', 'ruler   尺子 p.2', 'eraser () 橡皮 p.2', 'pencil box 铅笔盒 p.2', 'Unit 2', 'red红色 p.7', 'blue 蓝色 p.7', 'green 绿色 p.8', '11'),
  pg('')
]
const book = await buildBook({ hash: 'rbh1', name: '虚构英语三上', textLayer: async () => raw })

const { db } = newDb()
cacheClear()
useTree(db, [['GR', null, '语法', 1], ['GR.PAST', 'GR', '一般过去时', 2], ['VO', null, '词汇', 1], ['VO.COL', 'VO', '颜色', 2], ['VO.COL.A', 'VO.COL', '颜色词', 3], ['VO.STA', 'VO', '文具', 2], ['VO.STA.A', 'VO.STA', '文具词', 3]])
addPaper(db, { title: '卷一', questions: [{ kp: 'VO.COL.A', score: 2, stem: 'Colour it red.' }, { kp: 'VO.STA.A', score: 2, stem: 'I have a ruler.' }] })
const lesson = (seq, title, points = []) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points, raw: {} })
const mk = (name, kind, levels) => createOutline(db, { name, scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels, kind })
const lid = id => Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons WHERE outline_id = ?').all(id).map(r => [r.title, r.id]))
const mapTo = (id, pairs) => { const l = lid(id); for (const [kp, t] of pairs) editMap(db, { op: 'add', outlineId: id, kp, lessonId: l[t] }); markBuiltinChecked(db, id, 'english') }

const A = mk('机构甲', 'course', [{ name: '基础级', lessons: [
  lesson(1, 'Colours', [{ kind: 'word', label: '词汇', text: 'red, blue, green' }, { kind: 'pattern', label: '句型', text: 'What colour is it?' }]),
  lesson(2, 'Stationery', [{ kind: 'word', label: '词汇', text: 'ruler, eraser' }]),
  lesson(3, 'Nothing', [{ kind: 'word', label: '词汇', text: 'elephant, giraffe' }])
] }])
mapTo(A, [['VO.COL.A', 'Colours'], ['VO.STA.A', 'Stationery'], ['VO.STA.A', 'Nothing']])
// 上传的整本教材（有书库）与另一册没有书库的教材（按目录）
const T = mk('虚构英语三上', 'textbook', [{ name: '三年级上册', lessons: [lesson(1, 'Unit 1 Hello!'), lesson(2, 'Unit 2 Colours')] }])
mapTo(T, [['VO.STA.A', 'Unit 1 Hello!'], ['VO.COL.A', 'Unit 2 Colours']])
const T2 = mk('目录版教材', 'textbook', [{ name: '四年级上册', lessons: [lesson(1, 'Unit 1 Colours and shapes')] }])
mapTo(T2, [['VO.COL.A', 'Unit 1 Colours and shapes']])
saveBook(db, book, { subject: 'english', outlineId: T })

// ── 书库命中函数 ──
{
  const lt = { title: 'Colours', theme: '', points: [{ kind: 'word', text: 'red, blue, green' }, { kind: 'pattern', text: 'What colour is it?' }] }
  const hits = bookUnitHits(db, 'rbh1', lt)
  assert.equal(hits[0].unitKey, 'unit:2', '同一单元命中最多的排第一')
  assert.ok(hits[0].vocab.length >= 2 && hits[0].patterns.length === 1)
  assert.equal(hits[0].page, 8, '印刷页码（不是 PDF 页码 10）')
  assert.match(hits[0].evidence, /^课本原文：同词汇：.*同句型：what colour is it（第 8 页）$/)
  const one = bookUnitHits(db, 'rbh1', { title: 'x', theme: '', points: [{ kind: 'word', text: 'ruler' }] })
  assert.equal(one.length, 0, '只有一个单词命中：不算原文命中')
  assert.equal(bookUnitHits(db, 'rbh1', { title: 'x', theme: '', points: [{ kind: 'word', text: 'elephant, giraffe' }] }).length, 0, '书里没有：不命中')
  const mkh = (unitSeq, score) => ({ bookId: 'b', unitKey: `u${unitSeq}`, unitSeq, unitTitle: '', score, vocab: ['a'], patterns: [], page: 1, evidence: '' })
  assert.deepEqual(pickBookUnits([mkh(1, 90), mkh(2, 80), mkh(3, 70)]).map(x => x.unitSeq), [1, 2], '每个版本最多 2 个，第二名要不低于第一名的 75%')
  assert.deepEqual(pickBookUnits([mkh(1, 90), mkh(2, 50)]).map(x => x.unitSeq), [1])
}

// ── 进对照表 ──
{
  const r = researchTable(db, {}, { courseId: A, textbookIds: [T, T2] })
  assert.equal(r.ready, true, r.reason)
  const col = r.lessons.find(l => l.title === 'Colours')
  const fromBook = col.units.filter(u => u.byBook)
  assert.equal(fromBook.length, 1, '书库只给 1 个单元')
  assert.match(fromBook[0].evidence, /课本原文/)
  assert.equal(fromBook[0].pages, '第 8 页')
  assert.equal(fromBook[0].levelName, '三年级上册'); assert.equal(fromBook[0].byCatalog, false)
  const st = r.lessons.find(l => l.title === 'Stationery')
  assert.ok(st.units.some(u => u.byBook && /第 2 页/.test(u.pages)), '文具课：书后词表指向第 2 页')
  const none = r.lessons.find(l => l.title === 'Nothing')
  assert.ok(!none.units.some(u => u.byBook), '书里没有这些词：不硬凑')
}

// ── 课 ↔ 原题：课的知识点只是 AI 判断（不算独立依据），但课在书库原文命中的单元对应同一个知识点 → 原文得出，可以进表 ──
{
  const cols = db.prepare("SELECT id FROM course_lessons WHERE outline_id = ? AND title = 'Colours'").get(A).id
  db.prepare("UPDATE course_kp_map SET state = 'suggested', source = 'ai', confidence = 'high', quote = 'red, blue' WHERE outline_id = ? AND lesson_id = ?").run(A, cols)
  const withBook = researchTable(db, {}, { courseId: A, textbookIds: [T] })
  const ex1 = withBook.lessons.find(l => l.title === 'Colours').kps.flatMap(k => k.examples)
  assert.ok(ex1.length >= 1 && /课：课本原文；题：已审核/.test(ex1[0].why), ex1.map(e => e.why).join('|'))
  const noBook = researchTable(db, {}, { courseId: A, textbookIds: [T2] })   // 只选没有书库的册：AI 判断不是独立依据
  const ex2 = noBook.lessons.find(l => l.title === 'Colours').kps.flatMap(k => k.examples)
  assert.ok(!ex2.some(e => /同知识点/.test(e.why ?? '')), '没有规则命中词 / 书库原文：不凭 AI 的判断就挂原题')
}

// ── 自动通过 ──
{
  const parent = c => ({ 'GR.TENSE.PAST.REG': 'GR.TENSE.PAST', 'GR.TENSE.PAST': 'GR.TENSE', 'GR.TENSE': 'GR' })[c] ?? null
  const q = (stem, kpMain, extra = {}) => ({ stem, options: [], answer: '', kpMain, confidence: 1, flags: [], ...extra })
  const past = 'Yesterday I visited my grandma. She was very happy.'
  const a = judgeAutoApprove(q(past, 'GR.TENSE.PAST'), parent)
  assert.equal(a.ok, true, a.why); assert.ok(a.hits.length >= 1)
  const b = judgeAutoApprove(q(past, 'GR.TENSE.PAST.REG'), parent)
  assert.equal(b.ok, true, '父子关系：规则认出一般过去时，AI 标了它的子项')
  assert.equal(judgeAutoApprove(q(past, 'RD.DET'), parent).ok, false, '不一致：留在待审核')
  assert.equal(judgeAutoApprove(q('这是一道没有任何标志词的题。', 'GR.TENSE.PAST'), parent).ok, false, '规则认不出：留在待审核')
  assert.equal(judgeAutoApprove(q(past, 'GR.TENSE.PAST', { confidence: 0.5 }), parent).ok, false, '低把握：留在待审核')
  assert.equal(judgeAutoApprove(q(past, 'GR.TENSE.PAST', { flags: ['kp_uncertain'] }), parent).ok, false)
  assert.equal(judgeAutoApprove(q(past, 'GR.TENSE.PAST', { flags: ['ocr_unclear'] }), parent).ok, false)
  assert.equal(judgeAutoApprove(q(past, 'GR.TENSE.PAST', { flags: ['locate_fuzzy'] }), parent).ok, true)
  assert.equal(judgeAutoApprove(q(past, 'GR.TENSE.PAST', { kpSuggestion: '待归类：X' }), parent).ok, false)
  assert.equal(judgeAutoApprove(q(past, null), parent).ok, false)
  assert.equal(AUTO_APPROVED_FLAG, 'auto_approved')
}

// 设置里的开关：默认打开；老配置里没有这一项也按打开处理
{
  assert.equal(DEFAULT_AI_CONFIG.auto_approve, true)
  const { auto_approve, ...old } = DEFAULT_AI_CONFIG
  assert.equal(AiConfigSchema.parse(old).auto_approve, true)
  assert.equal(AiConfigSchema.parse({ ...old, auto_approve: false }).auto_approve, false)
}

console.log('research-book-hit.test OK')
