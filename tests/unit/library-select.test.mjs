// 试卷库：搜索匹配、批量改信息的字段拼装、批量结果汇总、选中 → 统计范围。纯函数，期望值手写。
import assert from 'node:assert/strict'
import { paperMatches, filterPapers, titleList, isBusyStatus, buildBatchMeta, summarizeBatch, scopeFromSelection, sanitizePaperIds, normQuery, chunk, plainError, MAX_SCOPE_PAPERS } from '../../src/shared/library-select.ts'

const P = (title, school, extra = {}) => ({ id: title, title, file_name: `${title}.pdf`, school, status: 'done', ...extra })
const papers = [P('四年级期末 PEP Unit 3', '实验小学'), P('Grade 5 Final', 'Sunshine School'), P('', null, { file_name: 'scan-0042.pdf', id: 'x' }), P('三年级期中', null)]

// ── 搜索 ──
assert.equal(normQuery('  AbC '), 'abc')
assert.deepEqual(filterPapers(papers, '').length, 4, '空搜索词 = 全部')
assert.equal(filterPapers(papers, '   ').length, 4, '只有空格 = 全部')
assert.deepEqual(filterPapers(papers, '期末').map(p => p.title), ['四年级期末 PEP Unit 3'], '按标题（中文子串）')
assert.deepEqual(filterPapers(papers, '实验').map(p => p.title), ['四年级期末 PEP Unit 3'], '按学校')
assert.deepEqual(filterPapers(papers, 'pep').map(p => p.title), ['四年级期末 PEP Unit 3'], '不分大小写（标题）')
assert.deepEqual(filterPapers(papers, 'SUNSHINE').map(p => p.title), ['Grade 5 Final'], '不分大小写（学校）')
assert.deepEqual(filterPapers(papers, 'scan-0042').map(p => p.id), ['x'], '标题为空时用文件名（界面上显示的就是它）')
assert.deepEqual(filterPapers(papers, 'pdf').map(p => p.id), ['x'], '有标题的卷子不按文件名匹配（只有标题为空的那份命中）')
assert.equal(paperMatches({ title: 'a', file_name: 'a.pdf', school: null }, 'b'), false)
assert.equal(paperMatches({ title: '甲', file_name: 'f', school: '小学' }, ' 小学 '), true, '搜索词首尾空格忽略')
assert.equal(filterPapers(papers, '不存在的词').length, 0)
{
  // 500 份卷子过滤要很快
  const big = Array.from({ length: 500 }, (_, i) => P(`第${i}份 期末卷`, i % 3 ? '实验小学' : null, { id: String(i) }))
  const t = performance.now()
  for (let k = 0; k < 100; k++) filterPapers(big, '实验')
  assert.ok(performance.now() - t < 500, '500 份 × 100 次过滤应远小于 0.5 秒')
  assert.equal(filterPapers(big, '实验').length, 333)
}

// ── 确认框标题截断 / 忙碌状态 ──
assert.deepEqual(titleList(['a', 'b'], 8), { shown: ['a', 'b'], more: 0 })
assert.deepEqual(titleList(Array.from({ length: 12 }, (_, i) => String(i)), 8), { shown: ['0', '1', '2', '3', '4', '5', '6', '7'], more: 4 })
assert.ok(isBusyStatus('extracting') && isBusyStatus('parsing') && !isBusyStatus('done') && !isBusyStatus('failed') && !isBusyStatus('extracted'))

// ── 批量改信息：只带打了勾的字段 ──
assert.deepEqual(buildBatchMeta({}, { school: 'x' }), {}, '没勾 = 什么都不改')
assert.deepEqual(buildBatchMeta({ school: true }, { school: '  实验小学 ', grade: '4' }), { school: '实验小学' }, '只带勾了的；去首尾空格；没勾的年级不带')
assert.deepEqual(buildBatchMeta({ grade: true, school_year_start: true }, { grade: '4', school_year_start: 2025 }), { grade: '4', school_year_start: 2025 })
assert.deepEqual(buildBatchMeta({ textbook: true, region: true, semester: true }, { textbook: '', region: '   ' }), { textbook: null, region: null, semester: null }, '勾了但留空 = 清空（null）')
assert.deepEqual(Object.keys(buildBatchMeta({ title: true }, { title: 'x' })), [], '标题不在批量字段里')

// ── 批量结果汇总 ──
assert.deepEqual(summarizeBatch([{ id: 'a', ok: true }, { id: 'b', ok: false, reason: '正在处理中' }, { id: 'c', ok: false, reason: '正在处理中' }, { id: 'd', ok: false }]),
  { ok: 1, skipped: 3, reasons: [{ reason: '正在处理中', count: 2 }, { reason: '没有处理', count: 1 }] })
assert.deepEqual(summarizeBatch([]), { ok: 0, skipped: 0, reasons: [] })

// ── 选中 → 统计范围（示例卷不和真实卷混） ──
assert.deepEqual(scopeFromSelection([{ id: 'a' }, { id: 'b', is_sample: 0 }]), { paperIds: ['a', 'b'], sample: false, dropped: 0 })
assert.deepEqual(scopeFromSelection([{ id: 'a' }, { id: 's', is_sample: 1 }]), { paperIds: ['a'], sample: false, dropped: 1 }, '真实卷 + 示例卷：只留真实卷')
assert.deepEqual(scopeFromSelection([{ id: 's1', is_sample: 1 }, { id: 's2', is_sample: 1 }]), { paperIds: ['s1', 's2'], sample: true, dropped: 0 }, '全是示例卷：看示例数据')
assert.deepEqual(scopeFromSelection([]), { paperIds: [], sample: false, dropped: 0 })

// ── 读回来的 id 列表 ──
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
assert.deepEqual(sanitizePaperIds([U(1), U(1), 'not-uuid', 5, U(2)]), [U(1), U(2)], '去重、去掉不合法的')
assert.equal(sanitizePaperIds([]), undefined)
assert.equal(sanitizePaperIds('x'), undefined)
assert.equal(sanitizePaperIds(['bad']), undefined)
assert.equal(sanitizePaperIds(Array.from({ length: 1500 }, (_, i) => U(i + 1))).length, 1000, '最多 1000 个')

// ── 分批 / 错误文案 ──
assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
assert.deepEqual(chunk([], 3), [])
assert.equal(MAX_SCOPE_PAPERS, 1000)
assert.equal(plainError(new Error("Error invoking remote method 'papers:batchRemove': Error: 试卷正在处理中")), '试卷正在处理中')
assert.equal(plainError(new Error("Error invoking remote method 'x': ZodError: [ { \"code\": \"too_big\", \"maximum\": 1000 } ]")), '操作没有成功，请稍后再试', 'zod 的 JSON 不给用户看')
assert.equal(plainError(new Error('[{"code":"too_big"}]')), '操作没有成功，请稍后再试')
assert.equal(plainError(new Error('Array must contain at most 1000 element(s) and some more english text here ok')), '操作没有成功，请稍后再试', '长英文技术信息换成白话')
assert.equal(plainError(''), '操作没有成功，请稍后再试')
assert.equal(plainError(new Error('尚未配置 AI 服务')), '尚未配置 AI 服务')

console.log('library-select.test ✓')
