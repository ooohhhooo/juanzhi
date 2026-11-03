// Word / PDF / 图片版课程表：Word 表格的确定性读取、AI 整理结果的核对（标题必须在原文里）、mock 的 p5_course_extract 应答。全部为虚构的通用课名。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { readDocxTables, tablesFromDocumentXml, numberLines, titleInSource, parseExtractResponse, lessonsToSheet, EXTRACT_MAPPING, richKindOf } from '../../src/main/course/doc-extract.ts'
import { buildOutline } from '../../src/main/course/map.ts'
import { fillTemplate } from '../../src/main/stats/p2.ts'

const require = createRequire(import.meta.url)
const course = require('../mock-ai/course.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prompt = (id, part) => fs.readFileSync(path.join(root, 'src/main/ai/prompts', `${id}.${part}.txt`), 'utf8').replace(/\s+$/, '')

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const p = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const tc = (t, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr>${t === '' ? '<w:p/>' : p(t)}</w:tc>`
const docx = async body => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// 扩展名
assert.equal(richKindOf('DOCX'), 'docx'); assert.equal(richKindOf('.pdf'), 'pdf'); assert.equal(richKindOf('heic'), 'image'); assert.equal(richKindOf('xlsx'), null)

// ── Word 表格 ──
const tbl = `<w:tbl><w:tblPr/><w:tr>${tc('课次')}${tc('课程标题')}${tc('词汇')}</w:tr>` +
  `<w:tr>${tc('1')}${tc('一般现在时')}${tc('apple')}</w:tr>` +
  `<w:tr>${tc('2')}${tc('一般过去时')}${tc('pear')}</w:tr>` +
  `<w:tr>${tc('3')}${tc('一般将来时')}${tc('plum')}</w:tr></w:tbl>`
const t1 = await readDocxTables(await docx(p('课程表') + tbl))
assert.equal(t1.sheets.length, 1)
assert.deepEqual(t1.sheets[0].rows, [['课次', '课程标题', '词汇'], ['1', '一般现在时', 'apple'], ['2', '一般过去时', 'pear'], ['3', '一般将来时', 'plum']])
// 一张小的 2x2 信息表 + 课在段落里 → 不当课程表，走文字整理
const info = `<w:tbl><w:tr>${tc('姓名')}${tc('小明')}</w:tr><w:tr>${tc('班级')}${tc('A1')}</w:tr></w:tbl>`
assert.equal(await readDocxTables(await docx(info + p('第1课 一般现在时') + p('第2课 一般过去时') + p('第3课 一般将来时'))), null)
// 信息表 + 大表：只取大表
const t3 = await readDocxTables(await docx(info + tbl))
assert.equal(t3.sheets.length, 1); assert.equal(t3.sheets[0].rows.length, 4)
// 没有表格 / 只有单格版式表 → null（改走文字整理）
assert.equal(await readDocxTables(await docx(p('第1课 一般现在时') + p('第2课 一般过去时'))), null)
assert.equal(await readDocxTables(await docx(`<w:tbl><w:tr>${tc('只有一格')}</w:tr></w:tbl>`)), null)
// 合并单元格：横向 gridSpan 向右、纵向 vMerge 向下填
const merged = `<w:tbl><w:tr>${tc('级别')}${tc('课次')}${tc('标题')}</w:tr>` +
  `<w:tr>${tc('基础级', '<w:vMerge w:val="restart"/>')}${tc('1')}${tc('一般现在时')}</w:tr>` +
  `<w:tr>${tc('', '<w:vMerge/>')}${tc('2')}${tc('一般过去时')}</w:tr>` +
  `<w:tr>${tc('备注', '<w:gridSpan w:val="3"/>')}</w:tr></w:tbl>`
const t2 = tablesFromDocumentXml(`<w:document xmlns:w="${W}"><w:body>${merged}</w:body></w:document>`)[0]
assert.deepEqual(t2.rows[2], ['基础级', '2', '一般过去时'])
assert.deepEqual(t2.rows[3], ['备注', '备注', '备注'])
assert.equal(t2.mergedFilled, true)
// 不是 Word / 不是 zip
await assert.rejects(readDocxTables(Buffer.from('not a zip')), /打不开/)
const notWord = new JSZip(); notWord.file('x.txt', 'hi')
await assert.rejects(readDocxTables(await notWord.generateAsync({ type: 'nodebuffer' })), /不像 Word/)

// ── 标题核对 ──
assert.equal(titleInSource('第1课 一般现在时', '第1课：一般现在时'), true)
assert.equal(titleInSource('Hello, World!', 'say hello world today'), true)
assert.equal(titleInSource('凭空多出来的一课', '第1课 一般现在时'), false)
assert.equal(titleInSource('', 'abc'), false)
assert.equal(titleInSource('a', 'a b c'), false, '太短的标题不算')
assert.equal(titleInSource('课', '第1课'), false)
assert.equal(titleInSource('一般', '第1课 一般现在时'), true)
assert.equal(titleInSource('现在时第2课', '第1课 一般现在时\n第2课 过去'), false, '不能跨行拼出来')
{
  const dup = parseExtractResponse(JSON.stringify({ lessons: [{ level: '基础级', seq: '1', title: '一般现在时' }, { level: '基础级', seq: '1', title: '一般现在时' }] }), ['第1课 一般现在时'])
  assert.equal(dup.lessons.length, 1, '完全相同的课去重')
}

const src = numberLines(['第1课 一般现在时', '词汇：apple；pear', '', '第2课 一般过去时', '页码 1'])
assert.equal(src.text, 'L1: 第1课 一般现在时\nL2: 词汇：apple；pear\nL3: 第2课 一般过去时\nL4: 页码 1')
const userText = fillTemplate(prompt('p5_course_extract', 'user'), { SOURCE_KIND: 'PDF', SOURCE_TEXT: src.text })
const ok = parseExtractResponse(course.build('extract', userText), src.lines)
assert.equal(ok.ok, true)
assert.deepEqual(ok.lessons.map(l => [l.seq, l.title, l.words]), [['第1课', '一般现在时', 'apple；pear'], ['第2课', '一般过去时', '']])
assert.equal(ok.dropped.length, 0)
// 编造的课被去掉并提示；坏回答 / 空回答
const bad = parseExtractResponse(course.build('extract', userText, { extractInvent: true }), src.lines)
assert.equal(bad.dropped.length, 1); assert.equal(bad.lessons.length, 2); assert.match(bad.problems[0], /原文里找不到/)
assert.equal(parseExtractResponse(course.build('extract', userText, { extractBad: true }), src.lines).ok, false)
assert.equal(parseExtractResponse('{"lessons":[]}', ['a']).lessons.length, 0)
// 词汇在原文里找不到只清空那一项
const half = parseExtractResponse(JSON.stringify({ lessons: [{ title: '一般现在时', words: 'banana' }] }), ['第1课 一般现在时'])
assert.deepEqual([half.lessons[0].title, half.lessons[0].words], ['一般现在时', ''])

// ── 整理结果 → 表 → 课程体系（固定映射）──
const sheet = lessonsToSheet('示例文件', ok.lessons)
assert.deepEqual(sheet.rows[0], ['课次', '级别', '课程标题', '主题', '词汇', '句型'])
const o = buildOutline([sheet], { [sheet.name]: EXTRACT_MAPPING })
assert.deepEqual(o.levels.map(l => [l.name, l.lessons.map(x => x.title)]), [['示例文件', ['一般现在时', '一般过去时']]])
assert.deepEqual(o.levels[0].lessons.map(x => x.seq), [1, 2])
assert.equal(course.kindOf(prompt('p5_course_extract', 'system')), 'extract')
console.log('course-doc-extract ok')
