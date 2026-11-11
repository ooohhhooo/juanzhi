// 教材 / 整本书：目录解析、按单元切块、单元摘要、AI 回答（只能挑知识点树里的代码）、页码范围、上限判断、版本识别。全部为虚构的通用教材。
import assert from 'node:assert/strict'
import {
  headingOf, toNum, tocEntryOf, parseToc, findPageOffset, unitPageRanges, outlineOf, buildUnit, splitByHeadings, fallbackRanges,
  parseUnitKpResponse, quoteInSource, unitNeedsReview, kpCandidateLines, textbookToSheet, TEXTBOOK_MAPPING, estimateCalls, estimateOcrPages, ocrMinutes, MAX_KPS_PER_UNIT
} from '../../src/main/course/textbook.ts'
import { detectEdition, setCatalogProvider, findBuiltinCatalog } from '../../src/main/course/textbook-edition.ts'
import { parsePageRange, tooBigMessage, tooManyPagesMessage, formatBytes, MAX_IMPORT_BYTES, COURSE_MAX_PAGES, TEXTBOOK_MAX_PAGES } from '../../src/shared/file-limits.ts'
import { parseRange, registerPdfSource, pdfSourcePath, releasePdfSource } from '../../src/main/pipeline/pdf-source.ts'

// ───── 数字 / 标题 ─────
assert.equal(toNum('三'), 3); assert.equal(toNum('十二'), 12); assert.equal(toNum('二十'), 20); assert.equal(toNum('１２'), 12); assert.equal(toNum('x'), null)
assert.deepEqual(headingOf('第三单元 山水之间'), { key: 'unit:3', title: '第三单元 山水之间', hasLeader: false })
assert.equal(headingOf('Unit 4 My family').key, 'unit:4')
assert.equal(headingOf('MODULE 2').key, 'module:2')
assert.equal(headingOf('第2章 分数的加减').key, 'chapter:2')
assert.equal(headingOf('第三单元的学习目标是掌握本单元的重点内容'), null, '句子不是标题')
assert.equal(headingOf('今天天气很好'), null)
assert.equal(headingOf('第一单元 山水之间 ........ 3').hasLeader, true)
assert.equal(headingOf('第5课 小蝌蚪', 1).key, 'lesson:5')

// ───── 目录条目 ─────
assert.deepEqual(tocEntryOf('第一单元 山水之间 ........ 3'), { title: '第一单元 山水之间', page: 3 })
assert.deepEqual(tocEntryOf('Unit 2 Colours 15'), { title: 'Unit 2 Colours', page: 15 })
assert.equal(tocEntryOf('这是一句普通的话 12'), null, '没有点线、也不是单元标题的不算')

// ───── 合成教材：封面 1、目录 2-3、正文从第 4 页起，印的页码比 PDF 页小 3 ─────
const toc = [
  { page: 1, lines: ['示例数学 五年级上册', '某某出版社'] },
  { page: 2, lines: ['目录', '第一单元 小数乘法 ........ 1', '第二单元 位置 ........ 9', '第三单元 小数除法 ........ 15'] },
  { page: 3, lines: ['第四单元 可能性 ........ 23', '第五单元 简易方程 ........ 31'] },
  { page: 4, lines: ['第一单元 小数乘法', '1.1 小数乘整数', '例题 1 小数乘整数的计算方法'] }
]
const t = parseToc(toc)
assert.deepEqual(t.tocPages, [2, 3], '目录跨两页')
assert.deepEqual(t.entries.map(e => [e.key, e.page]), [['unit:1', 1], ['unit:2', 9], ['unit:3', 15], ['unit:4', 23], ['unit:5', 31]])
assert.deepEqual(parseToc([{ page: 1, lines: ['前言', '本书共五章'] }, { page: 2, lines: ['第一章 讲述一件事'] }]).entries, [], '没有目录就没有条目')
// 页码递增：中间一条页码倒退的丢掉
assert.equal(parseToc([{ page: 1, lines: ['目录', '第一单元 甲 ...... 1', '第二单元 乙 ...... 20', '第三单元 丙 ...... 5', '第四单元 丁 ...... 30'] }]).entries.length, 3)

// 偏移：第一单元标题出现在 PDF 第 4 页 → 偏移 = 3（印的页码 1 + 3 = 4）
const body = new Map([[4, ['第一单元 小数乘法', '1.1 小数乘整数']]])
const off = await findPageOffset(t.entries, [1, 2, 3, 4, 5, 6], new Set(t.tocPages), async p => body.get(p) ?? [])
assert.equal(off, 3)
assert.equal(await findPageOffset(t.entries, [1, 2, 3, 4], new Set(t.tocPages), async () => ['别的内容']), null, '找不到标题就不猜偏移')
// 目录页本身不算（目录里也有这个标题）
assert.equal(await findPageOffset(t.entries, [2, 3, 4], new Set([2, 3]), async p => (p === 2 ? ['第一单元 小数乘法 ........ 1'] : [])), null)

// 页码范围：每个单元的起止；落在所选页码范围之外的单元丢掉
const sel = Array.from({ length: 40 }, (_, i) => i + 1)
const rg = unitPageRanges(t.entries, 3, sel)
assert.deepEqual(rg.map(r => [r.start, r.end]), [[4, 11], [12, 17], [18, 25], [26, 33], [34, 40]])
assert.deepEqual(unitPageRanges(t.entries, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).map(r => [r.start, r.end]), [[4, 11], [12, 13]], '只选前 13 页：后面的单元不要')

// ───── 单元摘要：标题 / 小节标题 / 开头 ─────
const items = [
  { page: 4, text: '第一单元 小数乘法', h: 0.05 },
  { page: 4, text: '1.1 小数乘整数', h: 0.03 },
  { page: 4, text: '小数乘整数的意义和整数乘法是相同的', h: 0.02 },
  { page: 4, text: '我们先来看一个购物的例子', h: 0.02 },
  { page: 4, text: '生活中的小数', h: 0.035 },
  { page: 5, text: '1.2 小数乘小数', h: 0.03 },
  { page: 5, text: '这一段是很长的正文不应该出现在小节标题里', h: 0.02 },
  { page: 5, text: '12', h: 0.02 },
  ...Array.from({ length: 8 }, (_, i) => ({ page: 5, text: `这是第 ${i + 1} 行普通的教材正文内容`, h: 0.02 }))
]
const o = outlineOf('第一单元 小数乘法', items)
assert.ok(o.headings.includes('1.1 小数乘整数') && o.headings.includes('1.2 小数乘小数') && o.headings.includes('生活中的小数'), '规则匹配 + 字号大的行')
assert.ok(!o.headings.includes('第一单元 小数乘法'), '单元标题本身不重复')
assert.ok(!o.headings.some(h => h.includes('很长的正文')))
assert.ok(o.opening.length >= 2 && o.opening.join('').length <= 500)
const u = buildUnit(1, 'unit:1', '第一单元 小数乘法', 4, 11, items)
assert.equal(u.sourceLines[0], '第一单元 小数乘法'); assert.ok(u.sourceLines.length >= 4)

// ───── 没有目录：按正文标题切 ─────
const all = []
for (let p = 1; p <= 12; p++) {
  if (p === 1) all.push({ page: p, text: 'Unit 1 Hello' })
  else if (p === 5) all.push({ page: p, text: 'Unit 2 Colours' })
  else if (p === 9) all.push({ page: p, text: 'Unit 3 Numbers' })
  else all.push({ page: p, text: 'Unit 1 Hello' }.page === 99 ? { page: p, text: 'x' } : { page: p, text: `正文第 ${p} 页` })
  if (p > 1) all.push({ page: p, text: p < 5 ? 'Unit 1 Hello' : p < 9 ? 'Unit 2 Colours' : 'Unit 3 Numbers' })   // 页眉每页重复
}
const sp = splitByHeadings(all)
assert.equal(sp.length, 3, '页眉里重复的标题只取第一次')
assert.deepEqual(sp.map(x => [x.title, x.pageStart, x.pageEnd]), [['Unit 1 Hello', 1, 4], ['Unit 2 Colours', 5, 8], ['Unit 3 Numbers', 9, 12]])
// 目录页（一页有 3 个以上标题）上的条目不算标题
const withToc = [{ page: 1, text: 'Unit 1 Hello' }, { page: 1, text: 'Unit 2 Colours' }, { page: 1, text: 'Unit 3 Numbers' }, ...all.map(l => ({ ...l, page: l.page + 1 }))]
assert.equal(splitByHeadings(withToc).length, 3)
assert.equal(splitByHeadings([{ page: 1, text: '只有一个 Unit 1 Hello' }, { page: 2, text: '正文' }]), null, '不足 2 个标题不算有单元')

// ───── 均分 ─────
const fr = fallbackRanges(Array.from({ length: 95 }, (_, i) => i + 1))
assert.equal(fr.length, 10); assert.deepEqual(fr[0], { start: 1, end: 10 }); assert.deepEqual(fr[9], { start: 91, end: 95 })
assert.ok(fallbackRanges(Array.from({ length: 300 }, (_, i) => i + 1)).length <= 40, '块数有上限')
assert.deepEqual(fallbackRanges([5, 6, 7]), [{ start: 5, end: 7 }], '页码不连续也按所选页算')

// ───── AI 回答：只能挑知识点树里的代码 ─────
const valid = new Set(['K.A', 'K.B', 'K.C'])
const src = ['第一单元 小数乘法', '1.1 小数乘整数', '1.2 小数乘小数']
const r1 = parseUnitKpResponse('{"kps":[{"code":"K.A","confidence":"high","quote":"小数乘整数"},{"code":"K.B","confidence":"high","quote":"这句话原文里没有"},{"code":"K.ZZ","confidence":"high","quote":"小数乘法"},{"code":"K.A","confidence":"low","quote":""}]}', valid, src)
assert.equal(r1.ok, true)
assert.deepEqual(r1.kps.map(k => [k.code, k.confidence]), [['K.A', 'high'], ['K.B', 'low']], '不在树里的丢弃、重复的只留一次、找不到原文的降为低')
assert.deepEqual(r1.invalid, ['K.ZZ'])
assert.equal(r1.kps[1].quote, ''); assert.match(r1.kps[1].reason, /推测/)
assert.equal(parseUnitKpResponse('```json\n{"kps":[]}\n```', valid, src).ok, true)
assert.equal(parseUnitKpResponse('好的，我来看看', valid, src).ok, false)
const many = JSON.stringify({ kps: Array.from({ length: 12 }, (_, i) => ({ code: `C${i}`, confidence: 'medium', quote: '小数乘法' })) })
assert.equal(parseUnitKpResponse(many, new Set(Array.from({ length: 12 }, (_, i) => `C${i}`)), src).kps.length, MAX_KPS_PER_UNIT, '最多 8 个')
assert.equal(quoteInSource('小数  乘整数', src), true); assert.equal(quoteInSource('x', src), false)
assert.equal(unitNeedsReview([]), true); assert.equal(unitNeedsReview([{ confidence: 'low' }]), true); assert.equal(unitNeedsReview([{ confidence: 'low' }, { confidence: 'medium' }]), false)

// 候选知识点：只给第 2 级及以下，带路径
const cand = kpCandidateLines([
  { code: 'A', parent_code: null, name: '数与代数', level: 1 },
  { code: 'A.1', parent_code: 'A', name: '小数', level: 2 },
  { code: 'A.1.1', parent_code: 'A.1', name: '小数乘法', level: 3 }
])
assert.deepEqual([...cand.codes], ['A.1', 'A.1.1']); assert.equal(cand.text, 'A.1 | 数与代数 / 小数\nA.1.1 | 数与代数 / 小数 / 小数乘法')

// ───── 成表：一个单元一行 ─────
const units = [u, buildUnit(2, 'unit:2', '第二单元 位置', 12, 17, [])]
const sheet = textbookToSheet('示例数学 五年级上册', units)
assert.equal(sheet.rows.length, 3); assert.deepEqual(sheet.rows[1], ['1', '示例数学 五年级上册', '第一单元 小数乘法', '第 4–11 页']); assert.equal(sheet.rows[0].length, 4)
assert.deepEqual(TEXTBOOK_MAPPING.columns.map(c => c.field), ['seq', 'level', 'title', 'note'])
assert.equal(estimateCalls(units), 2)
assert.equal(estimateOcrPages(300), 15 + 20 * 2); assert.equal(estimateOcrPages(10), 10); assert.equal(ocrMinutes(55), 3)

// ───── 页码范围 ─────
assert.equal(parsePageRange('', 100), null); assert.equal(parsePageRange('  ', 100), null)
assert.deepEqual(parsePageRange('1-3', 100), [1, 2, 3])
assert.deepEqual(parsePageRange('5, 1-3，3-4；9', 100), [1, 2, 3, 4, 5, 9], '排序去重，中文标点也认')
assert.deepEqual(parsePageRange('1至3', 100), [1, 2, 3])
assert.throws(() => parsePageRange('3-1', 100), /不对/)
assert.throws(() => parsePageRange('0-3', 100), /不对/)
assert.throws(() => parsePageRange('abc', 100), /看不懂/)
assert.throws(() => parsePageRange('90-120', 100), /一共 100 页.*第 120 页/)

// ───── 上限 / 提示 ─────
assert.equal(MAX_IMPORT_BYTES, 500 * 1024 * 1024); assert.equal(COURSE_MAX_PAGES, 20); assert.equal(TEXTBOOK_MAX_PAGES, 300)
assert.equal(tooBigMessage(MAX_IMPORT_BYTES), null)
assert.match(tooBigMessage(MAX_IMPORT_BYTES + 1), /500 MB/)
assert.match(tooBigMessage(612 * 1024 * 1024), /612 MB.*500 MB/, '带实际大小和上限')
assert.equal(formatBytes(1536), '2 KB'); assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB')
const m = tooManyPagesMessage(104, 20); assert.match(m, /104 页.*20 页.*页码范围/)
assert.match(tooManyPagesMessage(350, 300, 400), /400 页.*选中 350 页.*300 页/)

// ───── 版本识别 ─────
assert.deepEqual(detectEdition('义务教育教科书 数学 五年级 上册 人民教育出版社'), { edition: '人教版', grade: 5, semester: 1, label: '人教版 五年级上册' })
assert.equal(detectEdition('PEP Primary English Grade 3 Book 2').label, '人教版 三年级下册')
assert.equal(detectEdition('统编版 语文 二年级 下册').label, '统编版 二年级下册')
assert.equal(detectEdition('外研版 英语 七年级上册').label, '外研版 七年级上册')
assert.equal(detectEdition('人民教育出版社 数学'), null, '没有年级不算认出')
assert.equal(detectEdition('五年级上册 数学'), null, '没有出版社不算认出')
assert.equal(detectEdition('译林出版社 六年级').semester, null)

// 内置目录：没登记提供者就没有提示；登记后按版本 + 年级 + 学期查
assert.equal(findBuiltinCatalog('math', detectEdition('人民教育出版社 五年级上册')), null)
setCatalogProvider({ find: q => (q.edition === '人教版' && q.grade === 5 && q.semester === 1 ? { id: 'x', label: '人教版 五年级上册' } : null), units: () => [] })
assert.deepEqual(findBuiltinCatalog('math', detectEdition('人民教育出版社 五年级上册')), { id: 'x', label: '人教版 五年级上册' })
assert.equal(findBuiltinCatalog('math', detectEdition('人民教育出版社 五年级下册')), null)
assert.equal(findBuiltinCatalog('math', detectEdition('译林出版社 五年级')), null, '学期认不出就不查')
setCatalogProvider(null)

// ───── Range 请求头 ─────
assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 })
assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 }, '超出文件尾就截到文件尾')
assert.equal(parseRange('bytes=1000-', 1000), 'bad'); assert.equal(parseRange('bytes=50-10', 1000), 'bad')
assert.equal(parseRange(null, 1000), null); assert.equal(parseRange('items=1-2', 1000), null)
const tok = registerPdfSource('/tmp/x.pdf'); assert.equal(pdfSourcePath(tok), '/tmp/x.pdf'); releasePdfSource(tok); assert.equal(pdfSourcePath(tok), null)

console.log('course-textbook.test ✓（目录 / 单元切分 / 摘要 / 只挑树里的代码 / 页码范围 / 上限 / 版本识别 / Range）')
