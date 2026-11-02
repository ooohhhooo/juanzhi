// 筛选栏「试卷」下拉的选项规则：状态、重复、示例、维度缩小、搜索
import assert from 'node:assert/strict'
import { pickerOptions, pickerMatches } from '../../src/shared/paper-picker.ts'

const P = (id, o = {}) => ({ id, title: `卷${id}`, file_name: `${id}.pdf`, school: null, status: 'done', grade: '4', semester: '上', school_year_start: 2025, exam_type: '期末', textbook: null, region: null, file_hash: `h${id}`, created_at: `2025-01-01`, is_sample: 0, similar_state: null, ...o })
const papers = [
  P('1'), P('2', { status: 'reviewing' }), P('3', { status: 'failed' }), P('4', { similar_state: 'suspect' }),
  P('5', { is_sample: 1 }), P('6', { grade: '5', school_year_start: 2024, school: '实验小学' }),
  P('7', { file_hash: 'h1', created_at: '2024-01-01' }),  // 与 1 同一个文件：只留一份（更早的 7）
  P('8', { grade: '3', school_year_start: 2026 })
]
const ids = o => o.map(x => x.value)
assert.deepEqual(ids(pickerOptions(papers, {}, true)).sort(), ['6', '7', '8'])
assert.ok(ids(pickerOptions(papers, { includeReviewing: true }, true)).includes('2'))
assert.deepEqual(ids(pickerOptions(papers, { sample: true }, true)), ['5'])
assert.deepEqual(ids(pickerOptions(papers, { includeDuplicates: true }, true)).sort(), ['1', '4', '6', '7', '8'])
assert.deepEqual(ids(pickerOptions(papers, { grade: '5' }, true)), ['6'])
assert.deepEqual(ids(pickerOptions(papers, { school_year_start: 2026 }, true)), ['8'])
assert.equal(pickerOptions(papers, { grade: '5' }, false).length, 3, '已经选了卷子时维度不再缩小')
assert.deepEqual(ids(pickerOptions(papers, {}, true)), ['8', '7', '6'], '学年从新到旧')
// 已确认的副本优先于待审核的原件
{
  const two = [P('a', { status: 'reviewing', file_hash: 'hh', created_at: '2024-01-01' }), P('b', { file_hash: 'hh', created_at: '2025-01-01' })]
  assert.deepEqual(ids(pickerOptions(two, { includeReviewing: true }, true)), ['b'])
}
const o = pickerOptions(papers, { includeReviewing: true }, true)
assert.equal(o.find(x => x.value === '2').status, '待审核')
assert.equal(o.find(x => x.value === '1' || x.value === '7').status, '已确认')
assert.ok(o.find(x => x.value === '6').label.includes('五年级上') && o.find(x => x.value === '6').label.includes('2024-2025'))
const all = pickerOptions(papers, {}, true)
assert.ok(pickerMatches(all.find(x => x.value === '6'), '实验'), '按学校搜')
assert.ok(pickerMatches(all.find(x => x.value === '6'), '卷6'), '按标题搜')
assert.ok(!pickerMatches(all.find(x => x.value === '6'), '不存在'))
assert.ok(pickerMatches(all[0], ''))
console.log('paper-picker.test ✓')
