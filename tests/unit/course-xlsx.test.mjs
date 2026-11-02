// 课程表读取：xlsx（共享字符串、合并单元格、多行表头、隐藏 sheet、数字 / 日期单元格、重复的列名）、csv（UTF-8 / BOM / GBK / 引号换行 / 制表符粘贴）、
// 以及我们自己生成的模板能被读回来。全部内容虚构。
import assert from 'node:assert/strict'
import { makeXlsx } from './helpers/xlsx.mjs'
import { buildXlsx, readTable, readXlsx, parseCsv, decodeText, readCsvText, CourseFileError, LIMITS } from '../../src/main/course/table-read.ts'
import { sampleSheets, templateRows } from '../../src/main/course/template.ts'

// ── xlsx：共享字符串 + 富文本 + 注音、数字、日期、合并单元格、隐藏 sheet ──
{
  const buf = await makeXlsx([
    {
      name: '基础级', merges: ['A1:A2', 'B1:C1'], rows: [
        ['课次', '内容', null, '教材对标', '教材对标'],
        [null, '词汇', '句型', '示例教材 三上', '示例教材 附录'],
        [1, 'cat, dog', "It's a …", 'Unit 1', { date: 45000 }],
        [2.5, 'a & b', '<tag>', 'Unit 2', 'x'],
        ['  第3课\n', '', '', '', '']
      ]
    },
    { name: '隐藏的', hidden: true, rows: [['a', 'b'], ['1', '2']] }
  ])
  const r = await readXlsx(buf)
  assert.equal(r.sheets.length, 2)
  const s = r.sheets[0]
  assert.equal(s.name, '基础级')
  assert.equal(s.hidden, false)
  assert.equal(r.sheets[1].hidden, true, '隐藏 sheet 要标出来（由上层决定跳过并提示）')
  assert.equal(s.mergedFilled, true)
  assert.deepEqual(s.rows[0], ['课次', '内容', '内容', '教材对标', '教材对标'], '横向合并：B1:C1 向右填充')
  assert.equal(s.rows[1][0], '课次', '纵向合并：A1:A2 向下填充')
  assert.equal(s.rows[2][0], '1', '数字按文字')
  assert.equal(s.rows[3][0], '2.5')
  assert.equal(s.rows[2][4], '2023-03-15', '日期样式的数字单元格转成日期文字（45000 = 2023-03-15）')
  assert.equal(s.rows[3][1], 'a & b', '实体解码')
  assert.equal(s.rows[3][2], '<tag>')
  assert.equal(s.rows[4][0], '第3课', '首尾空白和换行被清理')
  assert.ok(s.rows.every(r => r.length === 5), '每行补齐到同样的列数')
  // 注音（rPh）里的 ZZ 不能混进文字
  assert.ok(!JSON.stringify(r.sheets).includes('ZZ'))
}

// ── 超出限制 ──
{
  const rows = Array.from({ length: LIMITS.rows + 5 }, (_, i) => [String(i + 1), 'x'])
  const r = await readXlsx(await makeXlsx([{ name: '大表', rows }]))
  assert.equal(r.sheets[0].rows.length, LIMITS.rows)
  assert.ok(r.warnings.some(w => w.includes('多出的部分已忽略')))
}

// ── 坏文件给白话错误 ──
await assert.rejects(readXlsx(Buffer.from('not a zip')), e => e instanceof CourseFileError && /打不开/.test(e.message))
await assert.rejects(readTable(Buffer.from('x'), '旧.xls'), e => e instanceof CourseFileError && /另存为/.test(e.message))
await assert.rejects(readTable(Buffer.from('x'), 'a.numbers'), e => /Numbers/.test(e.message))
await assert.rejects(readTable(Buffer.from('x'), 'a.pdf'), e => /粘贴表格/.test(e.message))
await assert.rejects(readTable(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'noext'), e => /旧版 Excel/.test(e.message))

// ── csv ──
{
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseCsv('a,"b,c","d ""q"""\r\n"x\ny",2,\r\n'), [['a', 'b,c', 'd "q"'], ['x\ny', '2', '']], '引号内的逗号、双引号转义、引号内换行；CRLF')
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']], '制表符分隔（从 Excel 复制粘贴）自动识别')
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']], '分号分隔')
  // UTF-8（带 BOM）
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('课次,标题\n1,你好\n', 'utf8')])
  assert.equal(decodeText(utf8), '课次,标题\n1,你好\n')
  // GBK：中文 Windows 的 Excel 另存 csv 常见。手工写出「课次,标题\n1,你好」的 GBK 字节
  const gbk = Buffer.from([0xbf, 0xce, 0xb4, 0xce, 0x2c, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, 0x31, 0x2c, 0xc4, 0xe3, 0xba, 0xc3, 0x0a])
  assert.equal(decodeText(gbk), '课次,标题\n1,你好\n', 'UTF-8 解不开就按 GBK')
  const r = await readTable(gbk, '随便.csv')
  assert.deepEqual(r.sheets[0].rows, [['课次', '标题'], ['1', '你好']])
  assert.equal(r.sheets[0].name, '随便', 'csv 的 sheet 名取文件名（不含扩展名）')
  assert.throws(() => readCsvText('', 'x'), e => e instanceof CourseFileError)
}

// ── 模板和示例：生成 → 读回 ──
{
  const blank = await readTable(await buildXlsx([{ name: '示例级别', rows: templateRows() }]), 'a.xlsx')
  assert.deepEqual(blank.sheets[0].rows[0].slice(0, 4), ['课次', '级别', '主题', '课程标题'])
  const sample = await readTable(await buildXlsx(sampleSheets()), 'b.xlsx')
  assert.equal(sample.sheets.length, 2)
  assert.deepEqual(sample.sheets.map(s => s.name), ['基础级', '进阶级'])
  assert.equal(sample.sheets[0].rows.length, 6)
  assert.equal(sample.sheets[0].rows[5][3], '第 5 课 Animals')
}

console.log('course-xlsx.test ✓')
