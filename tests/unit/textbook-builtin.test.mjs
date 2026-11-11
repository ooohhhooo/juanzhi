// 内置教材：迁移 v15、添加 / 更新 / 删除、对比计算（用内存库 + 虚构夹具）。
import assert from 'node:assert/strict'
import { newDb, migrations, addPaper } from './helpers/db.mjs'
import { createOutline, listOutlines, removeOutline, editMap, applyTextbookMaps } from '../../src/main/course/store.ts'
import { addBuiltinTextbook, refreshBuiltinTextbook } from '../../src/main/course/textbook-builtin.ts'
import { CATALOG, findEdition } from '../../src/main/course/catalog.ts'
import { courseDashboard } from '../../src/main/course/stats.ts'
import { compareCourseTextbook, compareToCsv, compareToText } from '../../src/main/course/compare.ts'

const q1 = (db, sql, ...a) => db.prepare(sql).get(...a)

// 详细断言用一份自造的小目录（不随真实目录的更新而变）；真实目录在文件末尾整本添加一遍
const U = (no, title, kps) => ({ no, title, lessons: [], kps })
const FIX = {
  id: 'english-pep', subject: 'english', edition: '人教PEP', textbookValue: '人教PEP', checkedAt: '2026-11-11', sources: [{ title: 't', url: 'u' }],
  books: [
    { grade: 3, semester: '上', editionYear: '2024', units: [U(1, 'Hello!', ['PH.LETTER', 'GR.PRON.PERSONAL']), U(2, 'Colours', ['VO.TOPIC.CLOTHES']), U(3, 'Look at me!', ['VO.TOPIC.BODY'])] },
    { grade: 4, semester: '上', editionYear: '2025', units: [U(1, 'My classroom', ['VO.TOPIC.SCHOOL', 'GR.PRON.DEMO']), U(2, 'My schoolbag', ['VO.TOPIC.SCHOOL', 'GR.NOUN.PLURAL.REG']), U(3, 'My friends', ['VO.TOPIC.FAMILY', 'GR.PRON.POSS.ADJ'])] }
  ]
}

// ── 迁移 v15：只加列 / 索引，旧课程全部是「机构课程」，修订号不变，重复执行无害 ──
{
  const ms = migrations()
  assert.equal(ms.length, 15)
  const { db } = newDb(':memory:', 14)
  db.prepare("INSERT INTO course_outlines (id, name, scene) VALUES ('o1', '旧课程', 'org')").run()
  const rev0 = q1(db, 'SELECT rev FROM data_rev WHERE id = 1').rev
  db.exec('BEGIN'); ms[14](db); db.exec('PRAGMA user_version = 15'); db.exec('COMMIT')
  const cols = db.prepare('PRAGMA table_info(course_outlines)').all().map(c => c.name)
  assert.ok(cols.includes('kind') && cols.includes('builtin_id'))
  const o = q1(db, "SELECT kind, builtin_id FROM course_outlines WHERE id = 'o1'")
  assert.equal(o.kind, 'course'); assert.equal(o.builtin_id, null)
  assert.equal(q1(db, 'SELECT rev FROM data_rev WHERE id = 1').rev, rev0, '迁移不让数据修订号虚增')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_course_outlines_kind'").get())
  ms[14](db)   // 重复执行无害
  assert.equal(listOutlines(db, 'english')[0].kind, 'course')
  assert.equal(newDb().version, 15)
}

// ── 夹具：英语，3 份卷子 ──
const { db } = newDb()
const P = (title, qs) => addPaper(db, { title, year: 2025, grade: '4', questions: qs })
P('卷一', [{ kp: 'VO.TOPIC.SCHOOL', err: true, score: 2 }, { kp: 'GR.NOUN.PLURAL.REG', score: 2 }, { kp: 'PH.LETTER', score: 2 }, { kp: 'VO.TOPIC.ANIMAL', score: 2 }])
P('卷二', [{ kp: 'VO.TOPIC.SCHOOL', score: 2 }, { kp: 'GR.NOUN.PLURAL.REG', score: 2 }, { kp: 'PH.LETTER', score: 2 }, { kp: 'GR.PRON.DEMO', score: 2 }, { kp: 'VO.TOPIC.ANIMAL', score: 2 }])
P('卷三', [{ kp: 'VO.TOPIC.SCHOOL', score: 2 }, { kp: 'GR.NOUN.PLURAL.REG', score: 2 }, { kp: 'PH.LETTER', score: 2 }])
const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
const courseId = createOutline(db, { name: '机构课 A', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '基础级', lessons: [lesson(1, 'Plurals'), lesson(2, 'Animals')] }] })
const lid = Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons WHERE outline_id = ?').all(courseId).map(r => [r.title, r.id]))
assert.equal(editMap(db, { op: 'add', outlineId: courseId, kp: 'GR.NOUN.PLURAL.REG', lessonId: lid.Plurals }), true)
assert.equal(editMap(db, { op: 'add', outlineId: courseId, kp: 'VO.TOPIC.ANIMAL', lessonId: lid.Animals }), true)

// ── 添加内置教材 ──
const pep = FIX
const added = addBuiltinTextbook(db, pep, ['4上', '3上'])
{
  const card = listOutlines(db, 'english').find(c => c.id === added.id)
  assert.equal(card.kind, 'textbook'); assert.equal(card.builtinId, 'english-pep:3上,4上'); assert.equal(card.scene, 'school')
  assert.equal(card.levels, 2); assert.equal(card.lessons, 6)
  assert.equal(card.name, '人教PEP 三年级上册、四年级上册')
  assert.equal(card.match.state, 'done', '内置教材不需要 AI 匹配')
  assert.deepEqual(db.prepare('SELECT name FROM course_levels WHERE outline_id = ? ORDER BY sort').all(added.id).map(r => r.name), ['三年级上册', '四年级上册'], '先三年级后四年级')
  const maps = db.prepare('SELECT * FROM course_kp_map WHERE outline_id = ?').all(added.id)
  assert.equal(maps.length, added.maps)
  assert.ok(maps.every(m => m.source === 'builtin' && m.state === 'confirmed' && m.locked === 1 && m.confidence === 'high'))
  const u = db.prepare("SELECT l.id FROM course_lessons l WHERE l.outline_id = ? AND l.title = 'My classroom'").get(added.id)
  assert.deepEqual(maps.filter(m => m.lesson_id === u.id).map(m => m.kp_code).sort(), ['GR.PRON.DEMO', 'VO.TOPIC.SCHOOL'])
  const nCheck = q1(db, 'SELECT COUNT(*) c FROM course_kp_check WHERE outline_id = ?', added.id).c
  assert.equal(nCheck, q1(db, "SELECT COUNT(*) c FROM kps WHERE subject = 'english' AND deprecated = 0").c, '本学科每个知识点都记为已检查')
  assert.equal(q1(db, "SELECT result FROM course_kp_check WHERE outline_id = ? AND kp_code = 'PH.LETTER'", added.id).result, 'matched')
  assert.equal(q1(db, "SELECT result FROM course_kp_check WHERE outline_id = ? AND kp_code = 'VO.TOPIC.FOOD'", added.id).result, 'none')
  assert.throws(() => addBuiltinTextbook(db, pep, ['3上', '4上']), /已经添加过/)
  assert.throws(() => addBuiltinTextbook(db, pep, []), /至少选一册/)
  assert.throws(() => addBuiltinTextbook(db, pep, ['9下']), /至少选一册/)
  // 主看板也能把教材当课程用：不会提示「还没匹配」
  const d = courseDashboard(db, {}, [added.id])
  assert.equal(d.ready, true)
  assert.ok(d.rows.some(r => r.main.length > 0))
}

// ── 对比 ──
{
  const r = compareCourseTextbook(db, {}, courseId, [added.id])
  assert.equal(r.ready, true, r.reason)
  assert.equal(r.units.length, 6)
  assert.equal(r.summary.textbookKps, 9)
  assert.equal(r.summary.covered, 1, '只有 名词复数 被机构课讲到')
  assert.equal(r.summary.uncovered, 8)
  const plural = r.units.flatMap(u => u.kps).find(k => k.code === 'GR.NOUN.PLURAL.REG')
  assert.equal(plural.lessons.length, 1); assert.match(plural.lessons[0].label, /Plurals/)
  assert.equal(plural.papers, 3)
  // 学校常考（3 份卷子都出现）但没覆盖：词汇·学校生活、字母；指示代词只在 1 份里出现，不算常考
  assert.deepEqual(r.priority.map(p => p.code).sort(), ['PH.LETTER', 'VO.TOPIC.SCHOOL'])
  assert.ok(r.uncovered.some(u => u.code === 'GR.PRON.DEMO') && !r.priority.some(p => p.code === 'GR.PRON.DEMO'))
  assert.ok(r.uncovered[0].papers >= r.uncovered[r.uncovered.length - 1].papers, '没讲到的按卷子出现份数排序')
  // 机构课讲了教材里没有的：动物
  assert.equal(r.extra.length, 1)
  assert.deepEqual(r.extra[0].kps.map(k => k.code), ['VO.TOPIC.ANIMAL'])
  assert.equal(r.summary.extraKps, 1)
  // 文字 / CSV
  const csv = compareToCsv(r, { filterDesc: '全部卷子' })
  assert.ok(csv.startsWith('﻿') && /机构课 A/.test(csv) && /没讲到/.test(csv) && /超前 \/ 拓展/.test(csv))
  assert.equal(csv.split('\r\n').filter(l => /,讲到,/.test(l)).length, 1)
  const txt = compareToText(r)
  assert.match(txt, /学校常考、机构课没讲到的/); assert.match(txt, /核对/)
  // 教材知识点在更粗的层级被机构课讲到，也算讲到（祖先）：把机构课的名词复数改挂到上一级 GR.NOUN.PLURAL
  editMap(db, { op: 'reset', kp: 'GR.NOUN.PLURAL.REG', lessonId: lid.Plurals })
  editMap(db, { op: 'add', outlineId: courseId, kp: 'GR.NOUN.PLURAL', lessonId: lid.Plurals })
  const r2 = compareCourseTextbook(db, {}, courseId, [added.id])
  assert.equal(r2.summary.covered, 1, '祖先层级的对应也算讲到')
  const k2 = r2.units.flatMap(u => u.kps).find(k => k.code === 'GR.NOUN.PLURAL.REG')
  assert.equal(k2.coarseOnly, true, '只有大类对应：标成较粗')
  assert.equal(k2.lessons[0].coarse, true)
  assert.equal(r.units.flatMap(u => u.kps).find(k => k.code === 'GR.NOUN.PLURAL.REG').coarseOnly, false, '直接对应不标粗')
  const csv2 = compareToCsv(r2, { filterDesc: '全部卷子' })
  assert.match(csv2, /对应精细度/); assert.match(csv2, /大类对应，较粗/)
  // 状态不对时给白话原因，不抛错
  assert.equal(compareCourseTextbook(db, {}, 'nope', [added.id]).ready, false)
  assert.equal(compareCourseTextbook(db, {}, courseId, []).ready, false)
  assert.equal(compareCourseTextbook(db, {}, added.id, [added.id]).ready, false, '教材不能当机构课程')
  const fresh = createOutline(db, { name: '没匹配的课', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: 'X', lessons: [lesson(1, 'x')] }] })
  assert.match(compareCourseTextbook(db, {}, fresh, [added.id]).reason, /还没有把知识点对应到课/)
}

// ── 原子性：中途出错什么都不留 / 保持原样 ──
{
  const ed2 = { ...FIX, books: [FIX.books[0]] }
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON course_kp_map BEGIN SELECT RAISE(ABORT, 'boom'); END")
  const nOut = q1(db, 'SELECT COUNT(*) c FROM course_outlines').c
  assert.throws(() => addBuiltinTextbook(db, ed2, ['3上']), /boom/)
  assert.equal(q1(db, 'SELECT COUNT(*) c FROM course_outlines').c, nOut, '添加失败不留空教材')
  assert.equal(db.isTransaction, false)
  db.exec('DROP TRIGGER boom')
  const ok = addBuiltinTextbook(db, ed2, ['3上'])   // 之后还能正常添加（不会提示已经添加过）
  const snap = () => JSON.stringify([db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(ok.id), db.prepare('SELECT kp_code, lesson_id FROM course_kp_map WHERE outline_id = ? ORDER BY 1, 2').all(ok.id), db.prepare('SELECT seq, title FROM course_lessons WHERE outline_id = ? ORDER BY seq').all(ok.id)])
  const before = snap()
  const changed = { ...ed2, books: [{ ...ed2.books[0], units: [U(1, 'Hello!!', ['PH.LETTER'])] }] }
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON course_kp_map BEGIN SELECT RAISE(ABORT, 'boom'); END")
  assert.throws(() => refreshBuiltinTextbook(db, ok.id, [changed]), /boom/)
  assert.equal(snap(), before, '刷新失败：对应、课次、修订号都保持原样')
  assert.equal(db.isTransaction, false)
  db.exec('DROP TRIGGER boom')
  removeOutline(db, ok.id)
  // 界面传来的知识点代码要属于本学科
  const eng = createOutline(db, { name: '英语课', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', subject: 'english', levels: [{ name: 'L', lessons: [lesson(1, 'x')] }] })
  const n = applyTextbookMaps(db, eng, [{ seq: 1, kps: [{ code: 'MA.NUM.INT.COUNT', confidence: 'high', quote: '', reason: '', confirmed: false, manual: false }, { code: 'PH.LETTER', confidence: 'high', quote: '', reason: '', confirmed: false, manual: false }] }], { model: 'm', promptVersion: 'v' })
  assert.equal(n, 1, '别的学科的代码被丢弃，只写入英语的 PH.LETTER')
  assert.deepEqual(db.prepare('SELECT kp_code FROM course_kp_map WHERE outline_id = ?').all(eng).map(r => r.kp_code), ['PH.LETTER'])
}

// ── 重新从内置更新：对应被重写；删除级联 ──
{
  const before = db.prepare('SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ?').get(added.id).c
  db.prepare("UPDATE course_kp_map SET state = 'rejected' WHERE outline_id = ? AND kp_code = 'PH.LETTER'").run(added.id)
  db.prepare("DELETE FROM course_kp_map WHERE outline_id = ? AND kp_code = 'VO.TOPIC.BODY'").run(added.id)
  const r = refreshBuiltinTextbook(db, added.id, [FIX])
  assert.equal(r.maps, before)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ?').get(added.id).c, before, '手工改动被目录结果覆盖')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ? AND state = 'rejected'").get(added.id).c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM course_lessons WHERE outline_id = ?').get(added.id).c, 6)
  assert.throws(() => refreshBuiltinTextbook(db, courseId, [FIX]), /不是内置的/)
  assert.throws(() => refreshBuiltinTextbook(db, added.id, []), /不在内置目录/)
  assert.equal(removeOutline(db, added.id), true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM course_levels WHERE outline_id = ?').get(added.id).c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ?').get(added.id).c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM course_kp_check WHERE outline_id = ?').get(added.id).c, 0)
  assert.ok(addBuiltinTextbook(db, pep, ['3上', '4上']).id, '删除后可以再次添加')
}

// ── 无序号的单元（no = null）：用 label 显示，顺序按数组顺序 ──
{
  const r = addBuiltinTextbook(db, findEdition('math-renjiao'), ['1上'])
  const ls = db.prepare('SELECT seq, no_label, title FROM course_lessons WHERE outline_id = ? ORDER BY seq').all(r.id)
  assert.deepEqual(ls.map(l => l.seq), ls.map((_, i) => i + 1))
  assert.equal(ls[0].no_label, '准备课'); assert.equal(ls[1].no_label, '第1单元')
  removeOutline(db, r.id)
}

// ── 真实目录：六个版本、每一册都能添加，每个单元都有知识点对应，对应的代码都在知识点库里 ──
{
  const subjectOf = { math: 'math', chinese: 'chinese', english: 'english' }
  for (const ed of CATALOG) {
    const r = addBuiltinTextbook(db, ed, ed.books.map(b => `${b.grade}${b.semester}`))
    const units = ed.books.reduce((n, b) => n + b.units.length, 0)
    assert.equal(r.lessons, units, `${ed.id} 单元数`)
    assert.ok(r.maps >= units, `${ed.id} 每个单元至少有一个知识点对应`)
    const card = listOutlines(db, subjectOf[ed.subject]).find(c => c.id === r.id)
    assert.ok(card && card.kind === 'textbook' && card.match.state === 'done', `${ed.id} 出现在 ${ed.subject} 学科的列表里`)
    const empty = db.prepare('SELECT l.title FROM course_lessons l WHERE l.outline_id = ? AND NOT EXISTS (SELECT 1 FROM course_kp_map m WHERE m.lesson_id = l.id)').all(r.id)
    assert.ok(empty.length <= Math.ceil(units * 0.1), `${ed.id} 没有任何知识点的单元不多（${empty.map(e => e.title).join('、')}）`)
  }
}
console.log('course-textbook ok')
