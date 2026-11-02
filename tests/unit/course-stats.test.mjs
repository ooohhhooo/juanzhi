// 看板「课程对照」的计算（丢分考点 → 对应课程、体系 × 级别交叉、常考但没覆盖）和替换比对。用内存库 + 虚构夹具。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { courseDashboard, gapsToCsv, GAP_MIN_PAPERS } from '../../src/main/course/stats.ts'
import { createOutline, applyMatchBatch, editMap, replaceOutline, diffOutline, listOutlines, targetKps, setOutlineActive, confirmDraft, getOutline, searchLessons } from '../../src/main/course/store.ts'
import { planReplace, lessonHash, countsOf } from '../../src/main/course/replace-diff.ts'

const lesson = (seq, title, word) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: word }], raw: {} })

// ── replace-diff（纯函数） ──
{
  const mk = (levelName, seq, title) => { const l = lesson(seq, title, 'w'); return { levelName, seq, hash: lessonHash(l) } }
  const old = [{ id: 1, ...mk('甲', 1, 'a') }, { id: 2, ...mk('甲', 2, 'b') }, { id: 3, ...mk('乙', 1, 'c') }, { id: 4, ...mk('甲', 2, 'b重复') }]
  const plan = planReplace(old, [
    { name: '甲', lessons: [lesson(1, 'a', 'w'), lesson(2, 'b改了', 'w'), lesson(2, 'b重复', 'w'), lesson(9, '新', 'w')] },
    { name: '丙', lessons: [lesson(1, 'x', 'w')] }
  ])
  assert.deepEqual(countsOf(plan), { added: 2, changed: 1, removed: 1 }, '甲1 不变；甲2 改了；甲2(重复)按出现顺序配对且没变；甲9、丙1 是新增；乙1 被删')
  assert.deepEqual(plan.changed.map(c => c.id), [2])
  assert.deepEqual(plan.same.map(c => c.id).sort(), [1, 4])
  assert.deepEqual(plan.removedIds, [3])
}

// ── 夹具：语法下三个二级考点 + 一个三级；3 份卷子 ──
const { db } = newDb()
useTree(db, [['GR', null, '语法', 1], ['GR.PAST', 'GR', '一般过去时', 2], ['GR.PAST.REG', 'GR.PAST', '规则变化', 3], ['GR.COMP', 'GR', '比较级', 2], ['GR.PLU', 'GR', '名词复数', 2], ['RD', null, '阅读', 1], ['RD.DET', 'RD', '细节理解', 2]])
db.prepare("UPDATE kps SET plain = ?, example_en = ? WHERE code = 'GR.PAST'").run('说过去发生的事', 'I played football yesterday.')
const P = (title, qs) => addPaper(db, { title, year: 2025, grade: '4', questions: qs })
P('卷一', [{ kp: 'GR.PAST.REG', err: true, reason: '加 -ed', score: 2 }, { kp: 'GR.COMP', err: true, score: 2 }, { kp: 'GR.PLU', score: 2 }, { kp: 'RD.DET', score: 3 }])
P('卷二', [{ kp: 'GR.PAST.REG', err: true, score: 2 }, { kp: 'GR.COMP', score: 2 }, { kp: 'GR.PLU', score: 2 }, { kp: 'RD.DET', score: 3 }])
P('卷三', [{ kp: 'GR.PAST.REG', score: 2 }, { kp: 'GR.PLU', score: 2 }, { kp: 'RD.DET', score: 3 }])
const oid = createOutline(db, {
  name: '示例体系 A', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active',
  levels: [{ name: '基础级', lessons: [lesson(1, 'Hello', 'hello'), lesson(2, 'Past', 'played, watched'), lesson(3, 'Plural', 'cats, dogs')] }, { name: '进阶级', lessons: [lesson(1, 'Compare', 'taller')] }]
})
const lid = Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons').all().map(r => [r.title, r.id]))
const kps = targetKps(db)
const sigs = new Map(kps.map(k => [k.code, k.sig]))
const E = (code, ...ls) => ({ code, none: !ls.length, maps: ls.map(([title, confidence]) => ({ lessonId: lid[title], confidence, quote: 'q', reason: 'r', quoteOk: true })) })
const meta = { rev: 1, model: 'm', promptVersion: 'v', sigs }
const F = {}

// 还没匹配：ready = false，没有交叉和没覆盖
{
  const d = courseDashboard(db, F, [oid])
  assert.equal(d.ready, false)
  assert.equal(d.gaps.computed, false)
  assert.ok(d.rows.length > 0 && d.rows.every(r => r.main.length === 0))
}

applyMatchBatch(db, oid, [
  E('GR.PAST.REG', ['Past', 'high']),               // 三级知识点的对应算在二级考点「一般过去时」名下
  E('GR.COMP', ['Compare', 'medium'], ['Hello', 'low']),
  E('GR.PLU', ['Plural', 'high']),
  E('RD.DET')                                         // 阅读细节：AI 看过，没有对应
], meta)

{
  const d = courseDashboard(db, F, [oid])
  assert.equal(d.ready, true)
  assert.equal(d.papers, 3)
  const by = Object.fromEntries(d.rows.map(r => [r.code, r]))
  // 易错题数 > 0 的二级考点：一般过去时（2 道）、比较级（1 道）；重难点排名靠前的补进来
  assert.equal(by['GR.PAST'].errorCount, 2)
  assert.deepEqual(by['GR.PAST'].tags.includes('易错'), true)
  assert.deepEqual(by['GR.PAST'].main.map(m => m.title), ['Past'], '三级知识点的对应并进二级考点')
  assert.deepEqual(by['GR.COMP'].main.map(m => m.title), ['Compare'], 'medium 算主要对应')
  assert.deepEqual(by['GR.COMP'].maybe.map(m => m.title), ['Hello'], 'low 单独放在“可能相关”，不进主要对应')
  assert.equal(by['GR.COMP'].main[0].levelName, '进阶级')
  assert.ok(d.rows[0].errorCount >= d.rows[1].errorCount, '易错题多的排前面')
  assert.equal(by['RD.DET']?.checked, true)
  assert.equal(by['RD.DET']?.main.length ?? 0, 0)
  // 汇总
  assert.equal(d.summary.lostPoints, d.rows.length)
  assert.equal(d.summary.withCourse + d.summary.without, d.summary.lostPoints)
  // 交叉：基础级涉及 一般过去时 + 名词复数（若它入选）；进阶级涉及 比较级
  const cell = (level) => d.cross.find(c => c.levelName === level)
  assert.deepEqual(cell('进阶级').codes, ['GR.COMP'])
  assert.ok(cell('基础级').codes.includes('GR.PAST'))
  assert.ok(cell('进阶级').scoreShare > 0 && cell('进阶级').scoreShare < 1)
  // 没覆盖：出现在 ≥ max(2, 30%) 份卷子里、且没有高 / 中对应的二级考点 → 阅读细节（3 份都考了）
  assert.equal(d.gaps.computed, true)
  assert.deepEqual(d.gaps.rows.map(g => g.code), ['RD.DET'])
  assert.equal(d.gaps.rows[0].papers, 3)
  const csv = gapsToCsv(d.gaps.rows, { filterDesc: '全部', outlineNames: ['示例体系 A'], scene: 'org' })
  assert.ok(csv.startsWith('﻿'), 'CSV 带 BOM')
  assert.match(csv, /常考但课程没覆盖的考点（AI 匹配的结果，请教研核对）/)
  assert.match(csv, /细节理解,3,3,3,0/)
  assert.match(gapsToCsv([], { filterDesc: 'x', outlineNames: [], scene: 'school' }), /教学进度里没有安排的常考点/, '学校场景换措辞')
}

// 人工修正立即生效：否决后没有对应；老师说“其实有”→ 从没覆盖里消失；low 被确认后算主要对应
{
  editMap(db, { op: 'reject', kp: 'GR.COMP', lessonId: lid.Compare })
  editMap(db, { op: 'confirm', kp: 'GR.COMP', lessonId: lid.Hello })
  editMap(db, { op: 'add', outlineId: oid, kp: 'RD.DET', lessonId: lid.Hello })
  const d = courseDashboard(db, F, [oid])
  const by = Object.fromEntries(d.rows.map(r => [r.code, r]))
  assert.deepEqual(by['GR.COMP'].main.map(m => m.title), ['Hello'])
  assert.equal(by['GR.COMP'].main[0].state, 'confirmed')
  assert.deepEqual(d.gaps.rows, [])
  assert.deepEqual(by['RD.DET'].main.map(m => m.source), ['manual'])
}

// 样本太少不下结论；体系没匹配完 / 被停用 / 草稿时的表现
{
  const d1 = courseDashboard(db, { paperIds: [db.prepare('SELECT id FROM papers LIMIT 1').get().id] }, [oid])
  assert.equal(d1.papers, 1)
  assert.ok(GAP_MIN_PAPERS > 1)
  assert.equal(d1.gaps.smallSample, true)
  assert.deepEqual(d1.gaps.rows, [])
  setOutlineActive(db, oid, false)
  assert.equal(listOutlines(db)[0].active, false)
  setOutlineActive(db, oid, true)
  const draft = createOutline(db, { name: '草稿体系', scene: 'other', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'draft', levels: [{ name: 'x', lessons: [lesson(1, 'a', 'b')] }] })
  assert.equal(courseDashboard(db, F, [draft]).outlines.length, 0, '草稿不参与对照')
  assert.equal(confirmDraft(db, draft), true)
  assert.equal(courseDashboard(db, F, [draft]).outlines.length, 1)
  assert.equal(courseDashboard(db, F, [draft]).ready, false, '新体系还没匹配')
  assert.equal(courseDashboard(db, F, []).outlines.length, 0)
}

// 替换：改了的课清掉没锁定的建议、锁定的保留；被删的课连同对应删掉；rev + 1 → 需要重新匹配
{
  const before = listOutlines(db).find(o => o.id === oid)
  assert.equal(before.match.state, 'done')
  const levels = [
    { name: '基础级', lessons: [lesson(1, 'Hello', 'hello'), lesson(2, 'Past', 'played, watched, jumped'), /* 第 3 课删除 */] },
    { name: '进阶级', lessons: [lesson(1, 'Compare', 'taller'), lesson(2, '新加的一课', 'x')] }
  ]
  const d0 = diffOutline(db, oid, levels)
  assert.deepEqual({ added: d0.added, changed: d0.changed, removed: d0.removed }, { added: 1, changed: 1, removed: 1 })
  assert.ok(d0.affectedMaps >= 2, '改动的课上有没锁定的 AI 对应：' + d0.affectedMaps)
  const r = replaceOutline(db, oid, { sourceName: 'x', sourceHash: 'h2', mapping: null, warnings: [], aiModel: '', levels })
  assert.deepEqual({ added: r.added, changed: r.changed, removed: r.removed }, { added: 1, changed: 1, removed: 1 })
  const after = listOutlines(db).find(o => o.id === oid)
  assert.equal(after.rev, 2)
  assert.equal(after.match.state, 'stale', '大纲更新后匹配状态是“需要重新匹配”')
  assert.equal(after.lessons, 4, 'Hello、Past（改了）、Compare、新加的一课；Plural 被删')
  const maps = db.prepare('SELECT m.kp_code, l.title, m.state FROM course_kp_map m JOIN course_lessons l ON l.id = m.lesson_id ORDER BY 1, 2').all().map(x => `${x.kp_code}:${x.title}:${x.state}`)
  assert.ok(!maps.some(m => m.startsWith('GR.PAST.REG')), '改了内容的“Past”课上没锁定的 AI 建议被清掉')
  assert.ok(maps.includes('GR.COMP:Hello:confirmed') && maps.includes('RD.DET:Hello:confirmed'), '锁定的人工结果保留（课还在）')
  assert.ok(!maps.some(m => m.includes('Plural')), '被删的课连同对应一起删')
  // 内容完全没变的替换：rev 不变
  const same = replaceOutline(db, oid, { sourceName: 'x', sourceHash: 'h2', mapping: null, warnings: [], aiModel: '', levels })
  assert.deepEqual([same.added, same.changed, same.removed], [0, 0, 0])
  assert.equal(listOutlines(db).find(o => o.id === oid).rev, 2)
  // 搜索课次（人工“添加课次”用）
  assert.deepEqual(searchLessons(db, [oid], 'taller').map(l => l.title), ['Compare'])
  assert.equal(searchLessons(db, [oid], '').length, 4)
  assert.equal(getOutline(db, oid).levels.length, 2)
}

console.log('course-stats.test ✓')
