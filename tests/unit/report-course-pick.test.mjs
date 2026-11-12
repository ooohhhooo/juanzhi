// 报告页「加入课程对照」：默认选哪一份、最多 3 份、超过 5 份改成可搜索多选；课程大纲页的搜索和按学期分组。
import assert from 'node:assert/strict'
import { MAX_COURSE_PICK, defaultCoursePick, needsSearchSelect, nextPick, clampPick, searchOutlines, groupByTerm, isPickable } from '../../src/shared/report-course-pick.ts'

const o = (id, name, updatedAt, term = '', state = 'done') => ({ id, name, termNote: term, updatedAt, match: { state } })
const list = [o('a', '甲机构 三上', '2026-09-01'), o('b', '乙机构 四上', '2026-11-01', '2026 秋'), o('c', '丙机构 五上', '2026-10-01', '2026 秋'), o('d', '丁（没匹配）', '2026-12-01', '', 'none')]

// 默认：上次用的；没有就是最近更新的一份（不选没匹配的），不再全选
assert.deepEqual(defaultCoursePick(list, []), ['b'], '没有记录：最近更新的一份')
assert.deepEqual(defaultCoursePick(list, ['c']), ['c'], '上次用的那份')
assert.deepEqual(defaultCoursePick(list, ['zzz']), ['b'], '上次那份已经不在（删了 / 停用了）：回到最近更新的')
assert.deepEqual(defaultCoursePick(list, ['d']), ['b'], '上次那份没匹配好：不能选')
assert.deepEqual(defaultCoursePick(list, ['a', 'b', 'c', 'x']), ['a', 'b', 'c'])
assert.deepEqual(defaultCoursePick([], []), [])
assert.ok(defaultCoursePick(list, []).length === 1, '不默认全选')

// 最多 3 份
assert.equal(MAX_COURSE_PICK, 3)
assert.deepEqual(nextPick(['a', 'b'], 'c', true), { ids: ['a', 'b', 'c'] })
assert.deepEqual(nextPick(['a', 'b', 'c'], 'd', true), { ids: ['a', 'b', 'c'], notice: '最多选 3 份' })
assert.deepEqual(nextPick(['a', 'b', 'c'], 'b', false), { ids: ['a', 'c'] })
assert.deepEqual(nextPick(['a'], 'a', true), { ids: ['a'] })
assert.deepEqual(clampPick(['a', 'b', 'c', 'd']), { ids: ['a', 'b', 'c'], notice: '最多选 3 份' })
assert.deepEqual(clampPick(['a', 'a', 'b']), { ids: ['a', 'b'] })

// 5 份以内对勾，超过 5 份可搜索多选
assert.equal(needsSearchSelect(Array.from({ length: 5 }, (_, i) => o(String(i), 'x', ''))), false)
assert.equal(needsSearchSelect(Array.from({ length: 6 }, (_, i) => o(String(i), 'x', ''))), true)
assert.ok(isPickable(list[0]) && !isPickable(list[3]))

// 搜索（名字、学期）与分组
assert.deepEqual(searchOutlines(list, '四上').map(x => x.id), ['b'])
assert.deepEqual(searchOutlines(list, '2026秋').map(x => x.id), ['b', 'c'], '按学期搜，忽略空格')
assert.equal(searchOutlines(list, '').length, 4)
assert.deepEqual(groupByTerm(list).map(g => [g.term, g.items.map(x => x.id)]), [['2026 秋', ['b', 'c']], ['未标学期', ['a', 'd']]], '按学期分组，没写学期的在最后')

console.log('report-course-pick.test OK')
