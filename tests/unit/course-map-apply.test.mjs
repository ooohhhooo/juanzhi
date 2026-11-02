// 列映射的确定性套用：同一套逻辑处理三种布局（单行表头 / 三行表头 + 合并单元格 + 标记行 + 价格列 / 列顺序打乱 + 级别列），
// 断言课次条数、字段原样复制（AI 不改写内容）、跳过的行和警告；再测按表头文字猜列、AI 回答的校验。全部内容虚构。
import assert from 'node:assert/strict'
import { makeXlsx } from './helpers/xlsx.mjs'
import { readXlsx } from '../../src/main/course/table-read.ts'
import { applyMapping, buildOutline, guessMapping, guessField, isPriceHeader, parseSeq, headerLabels, lessonName } from '../../src/main/course/map.ts'
import { parseColsResponse, sheetPreview } from '../../src/main/course/cols-ai.ts'

const col = (c, field) => ({ col: c, field })
const sheetOf = async (spec) => (await readXlsx(await makeXlsx([spec]))).sheets[0]

// ── 布局 1：单行表头 ──
const L1 = await sheetOf({ name: '基础级', rows: [
  ['课次', '主题', '课程标题', '词汇', '句型', '教材对标'],
  [1, '打招呼', '第 1 课 Hello', 'hello, bye', "I'm …", '示例教材 三上 Unit 1'],
  [2, '颜色', '第 2 课 Colors', 'red, blue', 'What colour is it?', '示例教材 三上 Unit 2'],
  [3, '数字', '第 3 课 Numbers', 'one, two', 'How many …?', '示例教材 三上 Unit 3']
] })
const M1 = { headerRows: 1, levelName: '', columns: [col(0, 'seq'), col(1, 'theme'), col(2, 'title'), col(3, 'word'), col(4, 'pattern'), col(5, 'textbook_ref')], skipMarkers: [], uncertain: [] }
{
  const o = buildOutline([L1], { 基础级: M1 })
  assert.equal(o.levels.length, 1)
  assert.equal(o.levels[0].name, '基础级', '级别名默认取 sheet 名')
  assert.equal(o.levels[0].lessons.length, 3)
  const l = o.levels[0].lessons[1]
  assert.equal(l.seq, 2)
  assert.equal(l.title, '第 2 课 Colors', '内容原样复制')
  assert.equal(l.theme, '颜色')
  assert.equal(l.textbookRef, '示例教材 三上 Unit 2')
  assert.deepEqual(l.points.map(p => [p.kind, p.label, p.text]), [['word', '词汇', 'red, blue'], ['pattern', '句型', 'What colour is it?']])
  assert.equal(l.raw['课程标题'], '第 2 课 Colors', '原行单元格保真')
  assert.equal(o.warnings.length, 0)
}

// ── 布局 2：三行表头（含合并）+ 赛季标记行 + 两个「教材对标」列 + 价格列 + 重复课次 ──
const L2 = await sheetOf({ name: '进阶级', merges: ['A1:A3', 'B1:C1', 'D1:E1'], rows: [
  ['课次', '课堂内容', null, '教材对标', null, '价格'],
  [null, '课程标题', '主题', '版本一', '版本二', '元/节'],
  [null, null, null, null, null, null],
  ['暑', null, null, null, null, null],
  [1, '第 1 课 My day', '日常', '示例教材 四下 Unit 1', '示例教材 附录 A', 99],
  [2, '第 2 课 Weather', '天气', '示例教材 四下 Unit 2', '', 99],
  ['秋', null, null, null, null, null],
  [2, '第 2 课 重复的一行', '天气', '', '', 99],
  [null, '没有课次但有标题', '补充', '', '', ''],
  [null, null, '只有主题和引用', '引用', null, 5],
  [null, null, null, null, null, 7]
] })
const M2 = { headerRows: 3, levelName: '', columns: [col(0, 'seq'), col(1, 'title'), col(2, 'theme'), col(3, 'textbook_ref'), col(4, 'textbook_ref'), col(5, 'word')], skipMarkers: ['暑', '秋'], uncertain: [] }
{
  const labels = headerLabels(L2, 3)
  assert.equal(labels[0], '课次', '纵向合并的表头不重复拼')
  assert.equal(labels[1], '课堂内容·课程标题', '多行表头按行拼起来')
  const o = buildOutline([L2], { 进阶级: M2 })
  const ls = o.levels[0].lessons
  assert.deepEqual(ls.map(l => l.seq), [1, 2, 2, 3], '标记行（暑 / 秋）和空行跳过；没有课次但有标题的按顺序编号（3）；没有课次也没有标题的行跳过')
  assert.equal(ls[0].textbookRef, '示例教材 四下 Unit 1 / 示例教材 附录 A', '两个教材对标列合并')
  assert.equal(ls[1].textbookRef, '示例教材 四下 Unit 2', '空的那一列不拼')
  assert.ok(ls.every(l => !l.points.some(p => p.text.includes('99'))), '价格列即使被标成词汇也忽略')
  assert.ok(!JSON.stringify(ls.map(l => l.raw)).includes('99'), '价格列不进原行保真数据')
  const kinds = o.warnings.map(w => w.kind).sort()
  assert.deepEqual(kinds, ['auto_seq', 'dup_seq', 'marker_skip', 'merged_filled', 'price_ignored', 'skip_no_seq'].sort())
  assert.match(o.warnings.find(w => w.kind === 'price_ignored').text, /价格/)
  assert.match(o.warnings.find(w => w.kind === 'dup_seq').text, /第 2 课出现了不止一次/)
  // 很多重复（不同学期各自从 1 编号）：合成一条警告，并保持表里的顺序，不按课次穿插
  const seasons = await sheetOf({ name: '两季', rows: [['课次', '标题'], [1, 'a1'], [2, 'a2'], [3, 'a3'], [1, 'b1'], [2, 'b2'], [3, 'b3']] })
  const so = buildOutline([seasons], { 两季: { headerRows: 1, levelName: '', columns: [col(0, 'seq'), col(1, 'title')], skipMarkers: [], uncertain: [] } })
  assert.deepEqual(so.levels[0].lessons.map(l => l.title), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'], '有重复课次：保持表里的顺序')
  assert.equal(so.warnings.filter(w => w.kind === 'dup_seq').length, 1)
  assert.match(so.warnings[0].text, /有 3 课的课次编号和前面重复/)
  assert.match(o.warnings.find(w => w.kind === 'marker_skip').text, /2 个标记行/)
}

// ── 布局 3：列顺序打乱 + 「级别」列分级别（一个 sheet 里有两个级别）+ 「第 N 课」写法 ──
const L3 = await sheetOf({ name: '汇总', rows: [
  ['词汇', '级别', '备注', '课次', '标题'],
  ['a, b', '甲级', '重点', '第3课', 'Third'],
  ['c, d', '甲级', '', '第1课', 'First'],
  ['e, f', '乙级', '', 'L1', 'Other']
] })
const M3 = { headerRows: 1, levelName: '', columns: [col(0, 'word'), col(1, 'level'), col(2, 'note'), col(3, 'seq'), col(4, 'title')], skipMarkers: [], uncertain: [] }
{
  const o = buildOutline([L3], { 汇总: M3 })
  assert.deepEqual(o.levels.map(l => l.name), ['甲级', '乙级'])
  assert.deepEqual(o.levels[0].lessons.map(l => l.seq), [1, 3], '同一级别内按课次排序')
  assert.equal(o.levels[0].lessons[1].noLabel, '第3课')
  assert.equal(o.levels[0].lessons[1].points.find(p => p.kind === 'other').text, '重点')
  assert.equal(lessonName(o.levels[0].lessons[1]), '第3课《Third》')
  assert.equal(lessonName({ seq: 5, noLabel: '5', title: 'Animals' }), '第 5 课《Animals》')
  assert.equal(lessonName({ seq: 3, noLabel: '3', title: '第 3 课 Last weekend' }), '第 3 课《Last weekend》', '标题里已经写着“第 3 课”：去掉重复的开头')
  assert.equal(lessonName({ seq: 3, noLabel: '第3课', title: '第 3 课：Last weekend' }), '第3课《Last weekend》')
  assert.equal(lessonName({ seq: 3, noLabel: '3', title: '第 3 课' }), '第 3 课', '标题只有“第 3 课”：不重复')
}

// ── 隐藏 sheet 跳过并提示；一个级别都没识别出来要提示 ──
{
  const hid = { ...L1, name: '隐藏', hidden: true }
  const o = buildOutline([L1, hid, { ...L1, name: '空的', rows: [['课次', '标题']] }], { 基础级: M1, 隐藏: M1, 空的: { ...M1, columns: [col(0, 'seq'), col(1, 'title')] } })
  assert.deepEqual(o.warnings.map(w => w.kind).sort(), ['empty_level', 'hidden_sheet'])
  assert.equal(o.levels.length, 1)
  assert.equal(buildOutline([L1], {}).warnings[0].kind, 'no_lessons')
}

// ── 一行都没识别出来时不造出空级别（界面据此说“还没有识别出任何一课”） ──
{
  const o = buildOutline([L1], { 基础级: { headerRows: 1, levelName: '', columns: [], skipMarkers: [], uncertain: [] } })
  assert.deepEqual(o.levels, [])
  assert.ok(o.warnings.some(w => w.kind === 'no_lessons'))
}

// ── 本地猜列 ──
{
  assert.equal(guessField('课程标题'), 'title')
  assert.equal(guessField('字母与语音'), 'phonics')
  assert.equal(guessField('元音'), null, '“元音”不是价格列')
  assert.equal(guessField('学费（元）'), 'ignore')
  assert.equal(isPriceHeader('优惠价'), true)
  assert.equal(isPriceHeader('元音字母'), false)
  assert.equal(guessField('教材对标'), 'textbook_ref')
  const g = guessMapping(L1)
  assert.equal(g.headerRows, 1)
  assert.deepEqual(g.columns.map(c => c.field), ['seq', 'theme', 'title', 'word', 'pattern', 'textbook_ref'])
  assert.equal(guessMapping(await sheetOf({ name: 'x', rows: [['甲', '乙'], ['丙', '丁']] })), null, '猜不出课次 / 标题列就返回 null')
  assert.equal(parseSeq('第 12 课'), 12)
  assert.equal(parseSeq('Unit 3'), 3)
  assert.equal(parseSeq('暑'), null)
}

// ── AI 回答的校验 ──
{
  const good = '```json\n{"header_rows":1,"level_name":"","columns":[{"col":1,"field":"seq"},{"col":3,"field":"title"},{"col":99,"field":"word"},{"col":2,"field":"乱写的"},{"col":1,"field":"theme"}],"skip_markers":["暑",5,"这个标记太长太长太长太长太长太长太长太长太长太长太长"],"uncertain":["第 6 列不确定"]}\n```'
  const r = parseColsResponse(good, L1)
  assert.equal(r.ok, true)
  assert.deepEqual(r.mapping.columns, [{ col: 0, field: 'seq' }, { col: 2, field: 'title' }], '列号从 1 起转成 0 起；越界、类型不认识、重复列的丢掉')
  assert.deepEqual(r.mapping.skipMarkers, ['暑'])
  assert.equal(r.problems.length, 2)
  assert.equal(parseColsResponse('{"header_rows":1,"columns":[{"col":2,"field":"theme"}]}', L1).ok, false, '没有课次或标题列算失败')
  assert.equal(parseColsResponse('我不会', L1).ok, false)
  assert.equal(parseColsResponse('前言 {"header_rows":99,"columns":[{"col":1,"field":"seq"}]} 结尾', L1).mapping.headerRows, 1, '表头行数不合理时改为 1；JSON 前后有废话也能取出来')
  // 预览：只列有内容的格子，长文本截断，中间抽样
  const big = { name: 'b', hidden: false, mergedFilled: false, rows: Array.from({ length: 40 }, (_, i) => [String(i + 1), 'x'.repeat(100)]) }
  const pv = sheetPreview(big)
  assert.match(pv, /共 40 行、2 列/)
  assert.match(pv, /行1: 1=1 \| 2=x{60}$/m, '每个格子截到 60 字')
  assert.match(pv, /省略/)
  assert.match(pv, /行40:/)
  assert.ok(pv.split('\n').length < 25, '预览只有开头 12 行 + 抽样 3 行 + 末 3 行')
}

console.log('course-map-apply.test ✓')
