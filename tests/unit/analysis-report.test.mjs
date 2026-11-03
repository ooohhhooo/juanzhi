// 分析看板与导出：规格校验、SVG 生成、xlsx 结构读回、html 无外部引用、名单导出、docx、工具定义。数据全部虚构。
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { BoardSpecSchema, ChartSchema, checkBlock, checkChart, formatValue, chartToTable } from '../../src/main/analysis/report/spec.ts'
import { renderChartSvg, niceScale } from '../../src/main/analysis/report/chart-svg.ts'
import { exportBoardXlsx, exportTableXlsx, sheetName, colName } from '../../src/main/analysis/report/export-xlsx.ts'
import { buildBoardHtml } from '../../src/main/analysis/report/export-html.ts'
import { exportBoardDocx } from '../../src/main/analysis/report/export-docx.ts'
import { boardTools, clearBoards } from '../../src/main/analysis/report/tools.ts'
import { demoSpec } from '../../src/main/analysis/report/demo-spec.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const spec = demoSpec()

// ── 规格校验 ──
{
  assert.equal(spec.sections.length, 4)
  assert.ok(BoardSpecSchema.safeParse(spec).success)
  assert.ok(!BoardSpecSchema.safeParse({ ...spec, extra: 1 }).success, '多余字段拒绝')
  assert.ok(!ChartSchema.safeParse({ kind: 'radar', title: 't', categories: [], series: [{ name: 'a', values: [] }], valueFormat: 'number' }).success, '未知图表种类')
  const bad = ChartSchema.parse({ kind: 'bar', title: 't', categories: ['a', 'b'], series: [{ name: 's', values: [1] }], valueFormat: 'number' })
  assert.match(checkChart(bad)[0], /要一样多/)
  assert.match(checkChart({ ...bad, kind: 'scatter' })[0], /两个系列/)
  assert.equal(checkBlock({ type: 'table', columns: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }], rows: [] })[0], '表格列的 key 有重复')
  assert.equal(formatValue(0.2534, 'percent'), '25.3%')
  assert.equal(formatValue(0.5, 'percent'), '50%')
  assert.equal(formatValue(12345, 'number'), '1.2万')
  assert.equal(formatValue(1234.5, 'number'), '1,234.5')
  assert.equal(formatValue(null, 'score'), '—')
  assert.equal(formatValue(78.64, 'score'), '78.6')
  const s = niceScale(0, 87)
  assert.ok(s.max >= 87 && s.min === 0)
}

// ── SVG：每种图表都有关键元素 ──
{
  const charts = spec.sections.flatMap(s => s.blocks).filter(b => b.type === 'chart').map(b => b.chart)
  assert.deepEqual([...new Set(charts.map(c => c.kind))].sort(), ['bar', 'barH', 'groupedBar', 'heatRow', 'line', 'pie', 'scatter', 'stackedBar'])
  for (const c of charts) {
    const svg = renderChartSvg(c, { width: 640 })
    assert.match(svg, /^<svg class="rb-chart" viewBox="0 0 640 /, c.kind)
    assert.ok(svg.includes('<title>'), `${c.kind} 有悬停提示`)
    assert.ok(!/http/.test(svg), `${c.kind} 不含外部地址`)
    assert.ok(!/#[0-9a-fA-F]{6}/.test(svg), `${c.kind} 不写死颜色（全走变量）`)
    const narrow = renderChartSvg(c, { width: 320 })
    assert.match(narrow, /viewBox="0 0 320 /, '窄宽度按给定宽度画')
  }
  const bar = renderChartSvg(charts.find(c => c.kind === 'bar'), { width: 640 })
  assert.equal((bar.match(/<rect class="rb-f0"/g) || []).length, 6, '6 个柱')
  assert.ok(bar.includes('82.4') && bar.includes('甲班'), '数值标签和分类标签')
  const stacked = renderChartSvg(charts.find(c => c.kind === 'stackedBar'), { width: 640 })
  assert.ok(stacked.includes('rb-f3') && stacked.includes('不及格'), '堆叠有 4 个系列和图例')
  const pie = renderChartSvg(charts.find(c => c.kind === 'pie'))
  assert.equal((pie.match(/<path class="rb-f/g) || []).length, 4)
  assert.ok(pie.includes('31.7%'), '饼图占比 76/240')
  assert.ok(renderChartSvg(charts.find(c => c.kind === 'line')).includes('<path class="rb-k0"'))
  assert.ok(renderChartSvg(charts.find(c => c.kind === 'heatRow')).includes('color-mix'))
  // 转义与空数据
  const evil = renderChartSvg({ kind: 'bar', title: '<b>x</b>', categories: ['<script>'], series: [{ name: 's', values: [1] }], valueFormat: 'number' })
  assert.ok(!evil.includes('<script>') && evil.includes('&lt;script&gt;'))
  assert.ok(renderChartSvg({ kind: 'line', title: 'e', categories: ['a'], series: [{ name: 's', values: [null] }], valueFormat: 'number' }).includes('没有数据'))
  // 单个饼块 100%
  assert.ok(renderChartSvg({ kind: 'pie', title: 'p', categories: ['a', 'b'], series: [{ name: 's', values: [5, 0] }], valueFormat: 'number' }).includes('<circle class="rb-f0"'))
}

// ── xlsx：用 jszip 读回 ──
async function readBack(buf) {
  const zip = await JSZip.loadAsync(buf)
  const wb = await zip.file('xl/workbook.xml').async('string')
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
  const sst = [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  const styles = await zip.file('xl/styles.xml').async('string')
  const fmts = Object.fromEntries([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map(m => [m[1], m[2]]))
  const xfs = [...styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/)[0].matchAll(/<xf numFmtId="(\d+)" fontId="(\d+)" fillId="(\d+)"/g)].map(m => ({ fmt: fmts[m[1]] ?? null, font: +m[2], fill: +m[3] }))
  const sheets = []
  for (let i = 0; i < names.length; i++) {
    const xml = await zip.file(`xl/worksheets/sheet${i + 1}.xml`).async('string')
    const cells = {}
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)" s="(\d+)"(?: t="(s)")?(?:\/>|><v>([^<]*)<\/v><\/c>)/g)) {
      cells[m[1]] = { v: m[3] ? sst[+m[4]] : m[4] === undefined ? null : +m[4], ...xfs[+m[2]] }
    }
    sheets.push({ xml, cells })
  }
  return { names, sheets, zip }
}

{
  const { names, sheets, zip } = await readBack(await exportBoardXlsx(spec))
  assert.deepEqual(names, ['核心发现', '整体表现', '成绩分布', '趋势与关联', '重点跟进名单', '口径说明'])
  assert.ok(zip.file('[Content_Types].xml') && zip.file('_rels/.rels'))
  const f = sheets[0].cells
  assert.equal(f.A1.v, '示例学期学情分析')
  assert.ok(Object.values(f).some(c => c.v === '阅读理解失分最集中'), '核心发现标题')
  assert.ok(Object.values(f).some(c => typeof c.v === 'string' && c.v.includes('61.2%')), '结论文字')
  // 整体表现：KPI + 柱图数据表 + 横条图数据表（百分比）
  const o = sheets[1].cells
  const vals = Object.entries(o)
  const jia = vals.find(([, c]) => c.v === 82.4)
  assert.ok(jia, '柱图的数据表里有 82.4')
  assert.equal(jia[1].fmt, '0.0', '得分用一位小数格式')
  const pct = vals.find(([, c]) => c.v === 0.812)
  assert.ok(pct, '百分比存小数')
  assert.equal(pct[1].fmt, '0.0%', '百分比单元格格式')
  const head = vals.find(([, c]) => c.v === '平均分（分）' && c.fill > 0)
  assert.ok(head, '表头有底色')
  // 跟进名单：表格原样，高亮行有底色
  const t = sheets[4].cells
  const rate = Object.entries(t).filter(([, c]) => c.fmt === '0.0%')
  assert.equal(rate.length, 5)
  const hiCell = Object.values(t).find(c => c.v === 0.41), loCell = Object.values(t).find(c => c.v === 0.6)
  assert.ok(hiCell.fill > loCell.fill || (hiCell.fill > 0 && loCell.fill === 0) || hiCell.fill !== loCell.fill, '低于 50% 的行高亮')
  assert.equal(Object.values(t).find(c => c.v === '学生甲').v, '学生甲')
  assert.ok(sheets[4].xml.includes('<cols>') && sheets[4].xml.includes('customWidth'), '列宽')
  // 口径
  assert.ok(Object.values(sheets[5].cells).some(c => c.v === '得分率 = 实际得分 / 满分，缺考不计入。'))
}

// ── 工作表名合法化 ──
{
  const used = new Set()
  assert.equal(sheetName('a/b:c*d?[e]\\f', used), 'a b c d  e  f'.replace(/\s+/g, ' '))
  assert.equal(sheetName('', used), '工作表')
  const long = '一二三四五六七八九十'.repeat(5)
  const n = sheetName(long, used)
  assert.equal([...n].length, 31)
  const n2 = sheetName(long, used)
  assert.equal([...n2].length, 31); assert.notEqual(n2, n); assert.ok(n2.endsWith('(2)'))
  assert.notEqual(sheetName('ABC', used), sheetName('abc', used), '大小写不同也算重名')
  assert.equal(colName(0), 'A'); assert.equal(colName(26), 'AA'); assert.equal(colName(701), 'ZZ')
}

// ── 名单导出 ──
{
  const cols = [{ key: 'name', label: '姓名' }, { key: 'rate', label: '得分率', format: 'percent' }, { key: 'n', label: '次数' }, { key: 'note', label: '备注' }]
  const rows = [{ name: '学生甲', rate: 0.456, n: 3, note: 'a & <b>' }, { name: '学生乙', rate: null, n: 12, note: null }]
  const { names, sheets } = await readBack(await exportTableXlsx(cols, rows, '跟进名单'))
  assert.deepEqual(names, ['跟进名单'])
  const c = sheets[0].cells
  assert.equal(c.A1.v, '姓名'); assert.ok(c.A1.fill > 0)
  assert.equal(c.B2.v, 0.456); assert.equal(c.B2.fmt, '0.0%')
  assert.equal(c.C3.v, 12); assert.equal(c.C3.fmt, '#,##0')
  assert.equal(c.D2.v, 'a & <b>', '特殊字符往返')
  assert.equal(sheets[0].cells.B3?.v ?? null, null, '空值是空格')
}

// ── 网页：单文件、无外部引用 ──
{
  const html = buildBoardHtml(spec)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!/<link\b/i.test(html) && !/<script[^>]*\ssrc=/i.test(html) && !/<img\b/i.test(html) && !/<iframe/i.test(html), '没有外部资源标签')
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')), '没有外部地址')
  assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(html) && !/url\(\s*["']?https?:/i.test(html) && !/@import/.test(html))
  assert.ok(html.includes('prefers-color-scheme:dark'))
  assert.equal((html.match(/<svg class="rb-chart"/g) || []).length, 8, '8 张图都内联')
  for (const k of ['核心发现', '阅读理解失分最集中', '口径说明', '整体表现', '出处 q-002']) assert.ok(html.includes(k), k)
  // 注入防护
  const evil = buildBoardHtml(BoardSpecSchema.parse({ title: '<img src=x onerror=alert(1)>', findings: [{ title: '<script>1</script>', body: 'b' }], sections: [{ id: 's1', title: 't', intro: '', blocks: [{ type: 'text', markdown: '<script>alert(1)</script>' }, { type: 'table', columns: [{ key: 'a', label: '<i>' }], rows: [{ a: '<script>' }] }] }] }))
  assert.ok(!/<script>(1|alert)/.test(evil) && !/<img src=x/.test(evil), '用户内容被转义')
}

// ── Word：读回文字 ──
{
  const buf = await exportBoardDocx(spec)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-docx-'))
  const f = path.join(dir, 'a.docx'); fs.writeFileSync(f, buf)
  const text = (await mammoth.extractRawText({ path: f })).value
  for (const k of ['示例学期学情分析', '核心发现', '阅读理解失分最集中', '整体表现', '各班平均分', '82.4', '61.2%', '学生甲', '口径说明']) assert.ok(text.includes(k), 'docx 含 ' + k)
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(chartToTable(spec.sections[0].blocks[1].chart).rows.length, 6)
}

// ── 工具定义 ──
{
  clearBoards()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-tools-'))
  const ctx = { sessionId: 's/1', dataDir: dir }
  const T = boardTools
  assert.equal(T.board_export.level, 'write')
  for (const t of Object.values(T)) { assert.ok(t.name && t.description.length > 20 && t.params && t.run, t.name) }
  assert.equal((await T.board_add_finding.run({ title: 'x', body: 'y' }, ctx)).ok, false, '没 start 先拒绝')
  assert.equal((await T.board_start.run({ title: '测试看板', subtitle: '', dataNote: '虚构' }, ctx)).ok, true)
  await T.board_add_finding.run(T.board_add_finding.params.parse({ title: '发现一', body: '数字 1' }), ctx)
  const sec = await T.board_add_section.run(T.board_add_section.params.parse({ title: '第一章', intro: '解读' }), ctx)
  assert.equal(sec.data.sectionId, 's1')
  assert.equal((await T.board_add_section.run({ id: 's1', title: '重复', intro: '' }, ctx)).ok, false)
  const badBlock = T.board_add_block.params.parse({ sectionId: 's1', block: { type: 'chart', chart: { kind: 'bar', title: 't', categories: ['a', 'b'], series: [{ name: 's', values: [1] }], valueFormat: 'number' } } })
  const r1 = await T.board_add_block.run(badBlock, ctx)
  assert.equal(r1.ok, false); assert.match(r1.message, /要一样多/)
  assert.equal((await T.board_add_block.run({ sectionId: 'nope', block: { type: 'text', markdown: 'x' } }, ctx)).ok, false)
  assert.equal((await T.board_add_block.run(T.board_add_block.params.parse({ sectionId: 's1', block: { type: 'text', markdown: '补充' } }), ctx)).ok, true)
  assert.ok(!T.board_add_block.params.safeParse({ sectionId: 's1', block: { type: 'chart', chart: { kind: 'x' } } }).success)
  await T.board_set_caliber.run({ items: ['口径一'] }, ctx)
  const pv = await T.board_preview.run({}, ctx)
  assert.ok(pv.message.includes('测试看板') && pv.message.includes('[s1] 第一章：文字') && !pv.message.includes('待补'))
  // 落盘与读回（清内存后能从文件恢复）
  const file = path.join(dir, 'analysis-boards', 's_1.json')
  assert.ok(fs.existsSync(file))
  clearBoards()
  assert.ok((await T.board_preview.run({}, ctx)).message.includes('测试看板'), '从磁盘恢复')
  // 导出：未注入导出实现 / 注入后透传
  assert.equal((await T.board_export.run({ format: 'xlsx' }, ctx)).ok, false)
  let got
  const r2 = await T.board_export.run({ format: 'html' }, { ...ctx, exportBoard: async (s, f) => { got = [s.title, f]; return { saved: true, path: '/x/y.html' } } })
  assert.deepEqual(got, ['测试看板', 'html']); assert.ok(r2.message.includes('/x/y.html'))
  assert.ok(!T.board_export.params.safeParse({ format: 'pdf' }).success)
  // 会话隔离
  assert.equal((await T.board_preview.run({}, { sessionId: 'other' })).ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('analysis-report.test ✓')
