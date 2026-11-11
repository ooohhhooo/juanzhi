// 知识点 ↔ 试卷：按知识点筛卷子（都考了 / 任一个）、并排对比、导出表格、助手工具。口径与 paperScope 一致。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { papersByKps, compareKps, overlapKind, compareToTable, OVERLAP_LABEL } from '../../src/main/stats/kp-compare.ts'
import { filterByHits, hitMap, hitText } from '../../src/shared/kp-filter.ts'
import { papersForKp } from '../../src/main/agent/tools/data.ts'
import { createSession } from '../../src/main/agent/store.ts'

const { db } = newDb()
useTree(db, [['A', null, '时态', 1], ['A.1', 'A', '一般现在时', 2], ['A.2', 'A', '过去式', 2], ['B', null, '词汇', 1], ['B.1', 'B', '名词', 2], ['B.2', 'B', '动词', 2]])
const q = (kp, extra = {}) => ({ qtype: 'MC', kp, score: 2, difficulty: 3, ...extra })
const p1 = addPaper(db, { title: '卷一', questions: [q('A.1'), q('A.1', { err: true }), q('B.1')] })
const p2 = addPaper(db, { title: '卷二', questions: [q('A.1'), q('A.2'), q('B.2', { sec: ['B.1'] })] })
const p3 = addPaper(db, { title: '卷三', questions: [q('B.1'), q('B.1', { score: null })] })
const p4 = addPaper(db, { title: '卷四待审核', status: 'reviewing', questions: [q('A.1')] })
const p5 = addPaper(db, { title: '卷五副本', hash: 'dup', questions: [q('A.2')] })
const p6 = addPaper(db, { title: '卷六原件', hash: 'dup', questions: [q('A.2')] })

const ids = hits => hits.map(h => h.paperId).sort()
// 单个知识点：任一个 = 都考了
assert.deepEqual(ids(papersByKps(db, {}, ['A.1'], 'any')), [p1, p2].sort(), '待审核的不算')
assert.deepEqual(ids(papersByKps(db, { includeReviewing: true }, ['A.1'], 'any')), [p1, p2, p4].sort(), '含待审核后算')
// 选父节点 = 包含子孙：时态 = A.1 + A.2；p5 / p6 同文件只算一份
assert.deepEqual(ids(papersByKps(db, {}, ['A'], 'any')).length, 3, 'p1 p2 + 副本代表一份')
// 多个知识点：任一个 / 都考了
assert.deepEqual(ids(papersByKps(db, {}, ['A.1', 'B.1'], 'any')), [p1, p2, p3].sort())
assert.deepEqual(ids(papersByKps(db, {}, ['A.1', 'B.1'], 'all')), [p1, p2].sort(), 'p2 的 B.1 是次知识点，也算考到')
assert.deepEqual(ids(papersByKps(db, {}, ['A.2', 'B.1'], 'all')), [p2], '只有 p2 两个都考了')
// 命中明细：知识点和题数
const h1 = papersByKps(db, {}, ['A.1', 'B.1'], 'any').find(h => h.paperId === p1).hits
assert.deepEqual(h1.map(x => [x.code, x.questions]), [['A.1', 2], ['B.1', 1]])
assert.equal(hitText(h1), '一般现在时 2 题、名词 1 题')
// 空选 / 重复 / 不存在的代码
assert.deepEqual(papersByKps(db, {}, [], 'any'), [])
assert.deepEqual(papersByKps(db, {}, ['NOPE'], 'any'), [])
assert.equal(papersByKps(db, {}, ['A.1', 'A.1'], 'all').length, 2, '重复代码不影响')
// SQL 注入式的代码只是查不到
assert.deepEqual(papersByKps(db, {}, ["A.1' OR '1'='1"], 'any'), [])

// 学科、示例数据与 paperScope 一致
db.prepare("UPDATE papers SET subject = 'math' WHERE id = ?").run(p3)
assert.ok(!ids(papersByKps(db, {}, ['B.1'], 'any')).includes(p3), '别的学科的卷子不混进来')
assert.deepEqual(ids(papersByKps(db, { subject: 'math' }, ['B.1'], 'any')), [p3])
db.prepare("UPDATE papers SET subject = 'english' WHERE id = ?").run(p3)
db.prepare('UPDATE papers SET is_sample = 1 WHERE id = ?').run(p3)
assert.ok(!ids(papersByKps(db, {}, ['B.1'], 'any')).includes(p3), '示例卷不混进真实数据')
assert.deepEqual(ids(papersByKps(db, { sample: true }, ['B.1'], 'any')), [p3])
db.prepare('UPDATE papers SET is_sample = 0 WHERE id = ?').run(p3)

// 试卷库筛选的纯函数
{
  const m = hitMap(papersByKps(db, {}, ['A.2'], 'any'))
  const list = [{ id: p1 }, { id: p2 }, { id: p6 }]
  assert.deepEqual(filterByHits(list, m).map(x => x.id), [p2, p6].filter(id => m.has(id)))
  assert.equal(filterByHits(list, null).length, 3, '没选知识点 = 不筛')
}

// 并排对比：选了卷子 + 选了知识点
{
  const r = compareKps(db, { paperIds: [p3, p1, p2] }, ['A.1', 'B.1', 'A.2'], 'any')
  assert.deepEqual(r.papers.map(p => p.id), [p3, p1, p2], '按选的顺序')
  assert.deepEqual(r.kps.map(k => [k.code, k.papers]), [['A.1', 2], ['B.1', 3], ['A.2', 1]])
  const c = r.cells.find(x => x.paper === p1 && x.kp === 'A.1')
  assert.deepEqual([c.questions, c.score, c.errors], [2, 4, 1], '题数 / 分值 / 易错')
  const nos = r.cells.find(x => x.paper === p3 && x.kp === 'B.1')
  assert.deepEqual([nos.questions, nos.score, nos.scored], [2, 2, 1], '分值为空的题不进分值')
  assert.equal(r.cells.find(x => x.paper === p2 && x.kp === 'B.1').score, 0, '次知识点不计分')
  assert.equal(overlapKind(3, 3), 'all'); assert.equal(overlapKind(1, 3), 'one'); assert.equal(overlapKind(2, 3), 'some'); assert.equal(overlapKind(0, 3), 'none'); assert.equal(overlapKind(1, 1), 'some')
  const t = compareToTable(r)
  assert.equal(t.columns.length, 4 + 3)
  assert.deepEqual(t.rows[1], { group: '词汇', kp: '名词', hit: 3, kind: OVERLAP_LABEL.all, p0: '2 题 / 2 分', p1: '1 题 / 2 分', p2: '1 题' })
  assert.equal(t.rows[0].p1, '2 题 / 4 分 / 易错')
  assert.equal(t.rows[2].kind, '只有一份考')
}
// 不选知识点：这几份卷子考过的全部二级知识点，按大类分组
{
  const r = compareKps(db, { paperIds: [p1, p2] }, [], 'any', 2)
  assert.equal(r.mode, 'all-kps')
  assert.deepEqual(r.kps.map(k => [k.code, k.group]), [['A.1', '时态'], ['A.2', '时态'], ['B.1', '词汇'], ['B.2', '词汇']])
  assert.deepEqual(compareKps(db, { paperIds: [p1, p2] }, [], 'any', 1).kps.map(k => k.code), ['A', 'B'], '一级')
}
// 从知识点出发：不给卷子
{
  const r = compareKps(db, {}, ['A.2', 'B.1'], 'all')
  assert.equal(r.mode, 'by-kps'); assert.deepEqual(r.papers.map(p => p.id), [p2])
  const any = compareKps(db, {}, ['A.2', 'B.1'], 'any')
  assert.equal(any.papers.length, 4)
  assert.deepEqual(compareKps(db, {}, [], 'any').papers, [], '两样都没给：空')
  assert.equal(compareKps(db, { paperIds: [p4] }, ['A.1'], 'any').papers.length, 0, '待审核的卷子选中也不计入')
}
// 超过 40 份只取前 40
{
  for (let i = 0; i < 45; i++) addPaper(db, { title: `批量${i}`, questions: [q('B.2')] })
  const r = compareKps(db, {}, ['B.2'], 'any')
  assert.equal(r.papers.length, 40); assert.ok(r.truncated >= 5)
}

// 助手工具
{
  const { db: db2 } = newDb()
  useTree(db2, [['A', null, '时态', 1], ['A.1', 'A', '一般现在时', 2], ['B', null, '词汇', 1], ['B.1', 'B', '名词', 2]])
  addPaper(db2, { title: '期末甲', questions: [q('A.1'), q('B.1')] })
  addPaper(db2, { title: '期末乙', questions: [q('A.1')] })
  const sid = createSession(db2, { id: 's1', role: 'exam', scene: 'exam', title: 't' }) // 会话学科默认英语
  const ctx = { db: db2, sessionId: sid }
  const out = papersForKp.run({ kps: ['一般现在时'], mode: 'any', limit: 15 }, ctx)
  assert.equal(out.count, 2); assert.match(out.text, /期末甲/); assert.match(out.text, /期末乙/)
  const both = papersForKp.run({ kps: ['一般现在时', '名词'], mode: 'all', compare: true, limit: 15 }, ctx)
  assert.equal(both.count, 1); assert.match(both.text, /并排对比/); assert.match(both.text, /名词：1\/1/)
  assert.match(papersForKp.run({ kps: ['不存在的点'], mode: 'any' }, ctx).text, /没有找到/)
}
console.log('kp-compare.test ✓')
