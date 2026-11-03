// 课程表读取：xlsx（共享字符串、合并单元格、多行表头、隐藏 sheet、数字 / 日期单元格、重复的列名）、csv（UTF-8 / BOM / GBK / 引号换行 / 制表符粘贴）、
// 以及我们自己生成的模板能被读回来。全部内容虚构。
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { makeXlsx } from './helpers/xlsx.mjs'
import { buildXlsx, readTable, readXlsx, parseCsv, decodeText, decodeTextInfo, readCsvText, CourseFileError, LIMITS } from '../../src/main/course/table-read.ts'
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
await assert.rejects(readTable(Buffer.from('x'), 'a.pdf'), e => /选择文件/.test(e.message))
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

// ── 压缩炸弹：声明的 / 实际的解压大小太大 → 白话拒绝；条目太多也拒绝 ──
{
  const big = async (files) => { const z = new JSZip(); for (const [n, size] of files) z.file(n, Buffer.alloc(size)); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }
  const t0 = Date.now()
  await assert.rejects(readXlsx(await big([['xl/workbook.xml', 60 * 1024 * 1024]])), e => e instanceof CourseFileError && /解压后太大/.test(e.message), '单个条目超过 50 MB')
  await assert.rejects(readXlsx(await big([1, 2, 3, 4, 5].map(i => [`xl/x${i}.xml`, 45 * 1024 * 1024]))), e => e instanceof CourseFileError && /解压后太大/.test(e.message), '合计超过 200 MB')
  const many = new JSZip(); for (let i = 0; i < 1200; i++) many.file(`f${i}.txt`, 'x')
  await assert.rejects(readXlsx(await many.generateAsync({ type: 'nodebuffer' })), e => e instanceof CourseFileError && /解压后太大/.test(e.message), '条目超过 1000 个')
  assert.ok(Date.now() - t0 < 15000, '拒绝是在解压之前 / 一超限就停，不会把炸弹解压完')
}

// ── 重复的、没闭合的标签：线性扫描，很快结束（不能卡死主进程） ──
{
  const z = new JSZip()
  z.file('xl/workbook.xml', '<workbook><sheets><sheet name="甲" sheetId="1" r:id="rId1"/></sheets></workbook>')
  z.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
  z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + '<c r="A1" t="inlineStr"><is><t>x'.repeat(200000) + '</sheetData></worksheet>')
  z.file('xl/sharedStrings.xml', '<sst>' + '<si><rPh><t>'.repeat(100000) + '</sst>')
  z.file('xl/styles.xml', '<styleSheet><cellXfs>' + '<xf numFmtId="14"'.repeat(100000) + '</styleSheet>')
  const t0 = Date.now()
  await readXlsx(await z.generateAsync({ type: 'nodebuffer' })).catch(e => assert.ok(e instanceof CourseFileError))
  assert.ok(Date.now() - t0 < 3000, `大量没闭合的标签应当很快结束，用了 ${Date.now() - t0} ms`)
}

// ── 乱码提示 ──
{
  const gbk = Buffer.from([0xbf, 0xce, 0xb4, 0xce, 0x2c, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, 0x31, 0x2c, 0xc4, 0xe3, 0xba, 0xc3, 0x0a])
  const r = await readTable(gbk, 'g.csv')
  assert.ok(r.warnings.some(w => /GBK/.test(w)), 'GBK 读取要提示')
  assert.equal(decodeTextInfo(Buffer.from('课次,标题\n1,你好', 'utf8')).suspicious, false)
  const moji = Buffer.from('a,b\n' + 'ï»¿Ã©Ã¨,锟斤拷锟斤拷\n'.repeat(5), 'utf8')
  assert.equal(decodeTextInfo(moji).suspicious, true)
  assert.ok((await readTable(moji, 'm.csv')).warnings.some(w => /乱码/.test(w)))
}

// 合并单元格填充和总格数的上限（默认参数下的课程大纲行为不变，见上面的用例）
{
  // 巨大合并区：只填到上限，不会卡死 / 吃光内存
  const t0 = Date.now()
  const r = await readXlsx(await makeXlsx([{ name: '合并', rows: [['标题', '', ''], ['a', 'b', 'c']], merges: ['A1:C1', 'A1:Z100000'] }]), { rows: 500000, cols: 200, mergeCells: 1000 })
  assert.ok(Date.now() - t0 < 5000)
  const filled = r.sheets[0].rows.flat().filter(x => x === '标题').length
  assert.ok(filled <= 1000 + 3, '填充格数有上限：' + filled)
  // 默认参数：普通合并照旧
  const r2 = await readXlsx(await makeXlsx([{ name: '课', rows: [['年级', '', '科目'], ['一', '二', '三']], merges: ['A1:B1'] }]))
  assert.deepEqual(r2.sheets[0].rows[0], ['年级', '年级', '科目']); assert.equal(r2.sheets[0].mergedFilled, true)
  // 总格数上限：超出给白话提示
  const rows = Array.from({ length: 50 }, (_, i) => Array.from({ length: 20 }, (_, j) => `r${i}c${j}`))
  await assert.rejects(readXlsx(await makeXlsx([{ name: '大', rows }]), { totalCells: 500 }), e => e instanceof CourseFileError && /太大/.test(e.message) && /格子/.test(e.message))
  const okr = await readXlsx(await makeXlsx([{ name: '大', rows }]), { totalCells: 5000 })
  assert.equal(okr.sheets[0].rows.length, 50)
}

console.log('course-xlsx.test ✓')
