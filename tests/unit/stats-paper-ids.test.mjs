// 「只统计这几份试卷」：StatsFilter.paperIds 与其它计入规则（已确认 / 去重 / 疑似重复 / 示例）一起用的口径；报告标题与范围描述。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { StatsFilterSchema, paperScope } from '../../src/main/stats/filter.ts'
import { describeFilter, normalizeFilter } from '../../src/main/stats/p2.ts'
import { reportTitle } from '../../src/shared/report-post.ts'

const { db } = newDb()
useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2]])
const q = kp => ({ qtype: 'MC', kp, score: 2, difficulty: 3 })
const p1 = addPaper(db, { title: 'P1', grade: '4', questions: [q('A.1'), q('A.1')] })
const p2 = addPaper(db, { title: 'P2', grade: '5', questions: [q('B.1')] })
const p3 = addPaper(db, { title: 'P3', grade: '4', questions: [q('A.1'), q('B.1'), q('B.1')] })
const p4 = addPaper(db, { title: 'P4 待审核', grade: '4', status: 'reviewing', questions: [q('B.1')] })
const p5 = addPaper(db, { title: 'P5 副本', grade: '4', hash: 'same', questions: [q('A.1')] })
const p6 = addPaper(db, { title: 'P6 原件', grade: '4', hash: 'same', questions: [q('A.1')] })
const gone = '99999999-9999-4999-8999-999999999999'

const count = f => S.overview(db, f).cards
// 基线：全部已确认的 = p1 p2 p3 + (p5/p6 同文件只算一份) = 4
assert.equal(count({}).papers, 4)
// 只选 p1、p3：2 份、题数 2+3 = 5
assert.deepEqual([count({ paperIds: [p1, p3] }).papers, count({ paperIds: [p1, p3] }).questions], [2, 5])
// 只选 p2：1 份 1 题
assert.deepEqual([count({ paperIds: [p2] }).papers, count({ paperIds: [p2] }).questions], [1, 1])
// 待审核的不计入，除非打开含待审核
assert.equal(count({ paperIds: [p1, p4] }).papers, 1, '选了待审核的卷子：默认不计入')
assert.equal(count({ paperIds: [p1, p4], includeReviewing: true }).papers, 2, '含待审核后计入')
// 重复导入：同一个文件两份都选中，默认只算一份；打开包含重复才算两份
assert.equal(count({ paperIds: [p5, p6] }).papers, 1, '同文件两份只算一份')
assert.equal(count({ paperIds: [p5, p6], includeDuplicates: true }).papers, 2)
// 已删除的 id 不会出错，只是查不到
assert.equal(count({ paperIds: [p1, gone] }).papers, 1)
assert.equal(count({ paperIds: [gone] }).papers, 0, '全是已删除的：空范围，不报错')
// 与维度筛选一起用仍是交集
assert.equal(count({ paperIds: [p1, p2], grade: '4' }).papers, 1)
// 示例数据：真实范围里选了示例卷不会被算进来
db.prepare('UPDATE papers SET is_sample = 1 WHERE id = ?').run(p2)
assert.equal(count({ paperIds: [p1, p2] }).papers, 1, '示例卷不混进真实数据统计')
assert.equal(count({ paperIds: [p1, p2], sample: true }).papers, 1, '看示例数据时只算示例卷')
db.prepare('UPDATE papers SET is_sample = 0 WHERE id = ?').run(p2)

// 其它统计函数用同一个范围：分布 / 重难点 / 范围说明
{
  const d = S.distribution(db, { paperIds: [p1, p3] })
  assert.equal(d.papers, 2)
  assert.equal(d.questions, 5)
  const n = S.scopeNotes(db, { paperIds: [p1, p4] })
  assert.equal(n.pendingReviewing, 1, '选中的里有 1 份待审核没计入')
  const m = S.matrix(db, { paperIds: [p2] }, 1)
  assert.equal(m.papers, 1)
}
// 500 份卷子时一个参数装下整组 id
{
  const many = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(900000 + i).padStart(12, '0')}`)
  const sc = paperScope({ paperIds: many })
  assert.equal(sc.params.filter(x => typeof x === 'string' && x.startsWith('[')).length >= 1, true)
  assert.ok(sc.params.length < 10, 'id 用一个 JSON 参数传，不按个数占位')
  assert.equal(count({ paperIds: [...many, p1] }).papers, 1)
}

// ── 校验 ──
assert.ok(StatsFilterSchema.safeParse({ paperIds: [p1] }).success)
assert.ok(!StatsFilterSchema.safeParse({ paperIds: [] }).success, '空列表不合法')
assert.ok(!StatsFilterSchema.safeParse({ paperIds: ['abc'] }).success, '必须是 uuid')
assert.ok(!StatsFilterSchema.safeParse({ paperIds: Array.from({ length: 1001 }, () => p1) }).success, '最多 1000 个')

// ── 范围描述 / 缓存键 / 标题 ──
assert.match(describeFilter({ paperIds: [p1, p3] }, 0, undefined, ['4']), /选中的 2 份试卷 · 四年级/)
assert.ok(!/全部年级/.test(describeFilter({ paperIds: [p1] }, 0, undefined, [])), '指定了具体几份卷子时不写「全部年级」')
assert.match(describeFilter({ paperIds: [p1, p3, p4, gone] }, 0, undefined, ['4'], { selected: 3, counted: 2 }), /选中的 3 份试卷（其中 2 份计入统计）/, '选中几份写还在库里的，计入份数单独写')
assert.ok(!/其中/.test(describeFilter({ paperIds: [p1, p3] }, 0, undefined, ['4'], { selected: 2, counted: 2 })), '全部计入时不加括号')
assert.equal(S.selectedCount(db, { paperIds: [p1, p3, p4, gone] }), 3, '已删除的 id 不算选中')
assert.equal(S.selectedCount(db, {}), null)
assert.deepEqual(normalizeFilter({ paperIds: [p3, p1] }), normalizeFilter({ paperIds: [p1, p3] }), '缓存键与点选先后无关')
const base = { filter: { paperIds: [p1, p3] }, grades: ['4'], semesters: ['上'], examTypes: ['期末'], years: [2025], reader: 'teacher', date: '2026-11-02' }
assert.equal(reportTitle({ ...base, paperCount: 2 }), '选中的 2 份试卷 四年级 上学期 2025-2026学年 期末 考情分析报告（老师版）· 2026-11-02')
assert.equal(reportTitle({ ...base }), '选中的 2 份试卷 四年级 上学期 2025-2026学年 期末 考情分析报告（老师版）· 2026-11-02', '没给计入份数时用选中的份数')
assert.equal(reportTitle({ ...base, filter: {}, paperCount: 5 }), '四年级 上学期 2025-2026学年 期末 考情分析报告（老师版）· 2026-11-02', '没选卷子时标题不变')

console.log('stats-paper-ids.test ✓')
