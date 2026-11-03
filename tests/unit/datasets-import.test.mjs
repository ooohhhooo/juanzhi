// 数据集导入：CSV 编码与分隔符、表头识别、类型推断（含多选）、多工作表 xlsx、行数 / 体积上限、派生列
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatasetStore, DatasetError, IMPORT_LIMITS } from '../../src/main/analysis/datasets/store.ts'
import { detectHeader, inferType, detectMulti, normalizeDate, sanitizeIdent } from '../../src/main/analysis/datasets/infer.ts'

const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-ds-import-'))
const store = new DatasetStore(tmp)
const buf = s => Buffer.from(s, 'utf8')
const q = async (d, sql) => { const r = await store.runQuery(sql, [d.id]); assert.ok(r.ok, sql + ' → ' + (r.message ?? '') + (r.rawError ?? '')); return r }
const col = (d, label, table) => d.tables.find(t => !table || t.name === table).columns.find(c => c.label === label)

// ── 纯函数：列名清洗、表头、日期 ──
assert.equal(sanitizeIdent('用户 ID (主键)'), '用户_id_主键')
assert.equal(detectHeader([['2026 年问卷'], [''], ['姓名', '年级', '分数'], ['甲', '三年级', '9']]), 2, '标题行 + 空行之后才是表头')
assert.equal(detectHeader([['1', '2', '3'], ['4', '5', '6']]), -1, '全是数字：没有表头')
assert.equal(detectHeader([['标题', '标题', '标题'], ['姓名', '年级', '分数'], ['甲', 'A', '9']]), 1, '合并后重复的标题行不是表头')
assert.deepEqual(normalizeDate('2026/3/5'), { text: '2026-03-05', hasTime: false })
assert.deepEqual(normalizeDate('2026年3月5日 8:05'), { text: '2026-03-05 08:05:00', hasTime: true })
assert.equal(normalizeDate('2026-13-40'), null)

// ── 类型推断 ──
assert.equal(inferType(['1', '2', '30']).type, 'integer')
assert.equal(inferType(['1.5', '2', '3']).type, 'real')
assert.equal(inferType(['是', '否', '是']).type, 'boolean')
assert.equal(inferType(['2026-01-02', '2026-01-03']).type, 'date')
assert.equal(inferType(['2026-01-02 10:00', '2026-01-03']).type, 'datetime')
assert.equal(inferType(['001', '002', '003']).type, 'text', '带前导 0 的编号不当数字')
assert.ok(!['integer', 'real'].includes(inferType(['110101199001011234', '110101199001011235']).type), '身份证号不能当数字（丢精度）')
const manyOptions = Array.from({ length: 60 }, (_, i) => ['A', 'B', 'C', 'D'][i % 4])
assert.equal(inferType(manyOptions).type, 'select')
const multiVals = Array.from({ length: 40 }, (_, i) => ['价格┋老师', '价格', '内容┋老师┋时间', '内容'][i % 4])
const mi = inferType(multiVals)
assert.equal(mi.type, 'multi'); assert.deepEqual(mi.multi.separators, ['┋']); assert.equal(mi.multi.optionCount, 4)
assert.ok(detectMulti(Array.from({ length: 40 }, (_, i) => `选项${i % 3}、选项${(i + 1) % 3}；选项${(i + 2) % 3}`)).separators.length >= 2, '多种分隔符混用')
const freeText = Array.from({ length: 80 }, (_, i) => `这是第${i}条很长的自由文本意见，里面有逗号，还有各种不同的内容${i * 7}`)
assert.notEqual(inferType(freeText).type, 'multi', '自由文本里的逗号不是多选')

// ── CSV：UTF-8 / BOM / GBK / 制表符 ──
{
  const csv = '姓名,年级,分数,日期\n甲,三年级,9,2026-01-02\n乙,四年级,8,2026-01-03\n'
  const d1 = await store.importBuffer(buf(csv), 'a.csv')
  assert.equal(d1.tables[0].rows, 2); assert.equal(col(d1, '分数').type, 'integer')
  const d2 = await store.importBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf(csv)]), 'b.csv')
  assert.equal(d2.tables[0].columns[0].label, '姓名', 'BOM 要去掉')
  // GBK：「姓名,分数\n张三,90\n李四,80」的 GBK 字节
  const gbkHex = Buffer.from([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb7, 0xd6, 0xca, 0xfd, 0x0a, 0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0x39, 0x30, 0x0a, 0xc0, 0xee, 0xcb, 0xc4, 0x2c, 0x38, 0x30, 0x0a])
  const d3 = await store.importBuffer(gbkHex, 'c.csv')
  assert.deepEqual(d3.tables[0].columns.map(c => c.label), ['姓名', '分数'], 'GBK 编码')
  const r = await q(d3, 'select "c01_姓名" from d1."c" order by _row')
  assert.ok(r.rows.length === 2)
  const d4 = await store.importBuffer(buf('姓名\t年级\t分数\n甲\t三年级\t9\n乙\t四年级\t8\n'), 'd.tsv')
  assert.equal(d4.tables[0].columns.length, 3, '制表符分隔'); assert.equal(col(d4, '分数').type, 'integer')
  const d5 = await store.importBuffer(buf('姓名;年级\n甲;三年级\n'), 'e.csv')
  assert.equal(d5.tables[0].columns.length, 2, '分号分隔')
}

// ── 表头识别 + 空列 + 重名列 ──
{
  const csv = '2026 秋季问卷,,,\n,,,\n年级,分数,,年级\n三年级,9,,A\n四年级,8,,B\n'
  const d = await store.importBuffer(buf(csv), 'h.csv')
  const t = d.tables[0]
  assert.equal(t.headerRow, 3); assert.equal(t.rows, 2)
  assert.deepEqual(t.columns.map(c => c.label), ['年级', '分数', '年级_2'], '全空列忽略，重名列加序号')
  assert.ok(t.notes.some(n => /前 2 行/.test(n)))
  assert.match(t.columns[0].name, /^c01_/)
}

// ── 类型 + 多选 + 长表视图 ──
{
  const rows = ['学员,推荐分,是否续费,日期,原因,备注']
  for (let i = 0; i < 40; i++) rows.push(`学员${i},${i % 11},${i % 2 ? '是' : '否'},2026-0${1 + (i % 9)}-1${i % 9},${['价格┋老师', '价格', '内容┋老师┋时间', '内容'][i % 4]},第${i}条意见说的是不一样的话${i * 13}`)
  const d = await store.importBuffer(buf(rows.join('\n')), 'types.csv')
  const t = d.tables[0]
  assert.deepEqual(t.columns.map(c => c.type), ['text', 'integer', 'boolean', 'date', 'multi', 'text'])
  assert.equal(t.views.length, 1)
  const r = await q(d, `select "选项", count(*) n from d1."${t.views[0].view}" group by 1 order by 1`)
  const m = Object.fromEntries(r.rows)
  assert.equal(m['价格'], 20); assert.equal(m['老师'], 20); assert.equal(m['时间'], 10); assert.equal(m['内容'], 20)
  assert.ok(col(d, '推荐分').profile.hints.some(h => /0–10/.test(h)), '像评分')
  assert.ok(col(d, '日期').profile.hints.some(h => /日期/.test(h)))
  assert.equal(col(d, '推荐分').profile.p50, 4.5)
  const txt = store.profileText(d.id)
  assert.ok(txt.split('\n').length >= 7 && /推荐分/.test(txt), '每列一行的短文本')
}

// ── 多工作表 xlsx（虚构运营数据） + 进度事件 ──
{
  const { generate } = require('../fixtures/gen-ops-data.cjs')
  const dir = path.join(tmp, 'ops')
  await generate(dir)
  const events = []
  const d = await store.importFile(path.join(dir, 'survey.xlsx'), { onProgress: p => events.push(p) })
  assert.equal(d.tables.length, 2, '每张工作表一个数据表')
  const survey = d.tables.find(t => t.sheet === '问卷')
  assert.equal(survey.rows, 300); assert.ok(survey.notes.some(n => /前 2 行/.test(n)), '标题行 + 合并单元格 + 空行被跳过')
  assert.equal(col(d, '渠道', survey.name).type, 'select')
  assert.equal(col(d, '推荐原因（多选）', survey.name).type, 'multi')
  assert.equal(col(d, '推荐分', survey.name).type, 'integer')
  assert.equal(col(d, '提交时间', survey.name).type, 'datetime')
  assert.ok(events.some(e => e.phase === 'read') && events.some(e => e.phase === 'write') && events.at(-1).phase === 'done', '读 / 写 / 完成三种进度')
  const w = events.filter(e => e.phase === 'write'); assert.equal(Math.max(...w.filter(e => e.sheet === '问卷').map(e => e.done)), 300)
  const c = await store.importFile(path.join(dir, 'classes.csv'))
  assert.equal(c.tables[0].rows, 120); assert.equal(col(c, '课时数').type, 'real')
  const tsv = await store.importFile(path.join(dir, 'renewal.tsv'))
  assert.equal(tsv.tables[0].rows, 200)
  // 目录文件与删除
  const catalog = JSON.parse(fs.readFileSync(path.join(tmp, 'datasets', 'catalog.json'), 'utf8'))
  assert.ok(catalog.datasets.some(x => x.id === d.id && x.sourceFile === 'survey.xlsx'))
  assert.ok(fs.existsSync(path.join(tmp, 'datasets', `${d.id}.sqlite`)))
  assert.equal(store.remove(d.id), true)
  assert.ok(!fs.existsSync(path.join(tmp, 'datasets', `${d.id}.sqlite`)), '删除数据集即删文件')
  assert.ok(!store.find(d.id))
  assert.equal(fs.readdirSync(path.join(tmp, 'datasets')).filter(f => f.endsWith('.part')).length, 0)
}

// ── 上限与白话提示 ──
{
  const saved = { ...IMPORT_LIMITS }
  IMPORT_LIMITS.rows = 5
  await assert.rejects(store.importBuffer(buf('a,b\n' + Array.from({ length: 8 }, (_, i) => `${i},x${i}`).join('\n')), 'big.csv'), e => e instanceof DatasetError && /50 万行/.test(e.message))
  IMPORT_LIMITS.rows = saved.rows
  IMPORT_LIMITS.bytes = 10
  await assert.rejects(store.importBuffer(buf('a,b\n1,2\n3,4\n5,6\n7,8\n'), 'big.csv'), e => e instanceof DatasetError && /200 MB/.test(e.message))
  IMPORT_LIMITS.bytes = saved.bytes
  await assert.rejects(store.importBuffer(buf('x'), 'a.xls'), e => /xlsx/.test(e.message))
  await assert.rejects(store.importBuffer(buf('x'), 'a.pdf'), e => /Excel/.test(e.message))
  await assert.rejects(store.importBuffer(buf('a,b\n'), 'empty.csv'), e => e instanceof DatasetError)
  assert.equal(fs.readdirSync(path.join(tmp, 'datasets')).filter(f => f.endsWith('.part')).length, 0, '失败不留半截文件')
}

// ── 大文件：10 万行导入（给出进度） ──
{
  const lines = ['编号,年级,分数,渠道']
  for (let i = 0; i < 100000; i++) lines.push(`${i + 1},${['一', '二', '三'][i % 3]}年级,${i % 101},渠道${i % 7}`)
  let last = 0, n = 0
  const t0 = Date.now()
  const d = await store.importBuffer(buf(lines.join('\n')), 'large.csv', { onProgress: p => { if (p.phase === 'write') { n++; last = p.done } } })
  assert.equal(d.tables[0].rows, 100000); assert.equal(last, 100000); assert.ok(n >= 10, '分批写入并多次报告进度')
  const r = await q(d, 'select count(*), avg("c03_分数") from d1."large"')
  assert.equal(r.rows[0][0], 100000)
  console.log(`  10 万行导入 ${Date.now() - t0} ms`)
}

// ── 派生列 ──
{
  const d = await store.importBuffer(buf('意见\n太贵了\n老师好\n太贵了\n'), 'opinion.csv')
  const t = d.tables[0]
  assert.throws(() => store.addDerivedColumn(d.id, t.name, '归类', ['a']), e => /需要 3 个值/.test(e.message))
  const name = store.addDerivedColumn(d.id, t.name, '意见归类', ['价格', '老师', '价格'])
  assert.match(name, /^d01_/)
  const r = await q(d, `select "${name}", count(*) from d1."${t.name}__all" group by 1 order by 2 desc`)
  assert.deepEqual(r.rows[0], ['价格', 2])
  const r2 = await q(d, `select a."c01_意见", b."${name}" from d1."${t.name}" a join d1."${t.name}__derived" b on a._row = b._row where a._row = 2`)
  assert.deepEqual(r2.rows[0], ['老师好', '老师'], '按行号关联')
  store.addDerivedColumn(d.id, t.name, '意见归类', ['x', 'y', 'z'])   // 同名覆盖
  assert.equal(store.get(d.id).tables[0].columns.filter(c => c.derived).length, 1)
  const r3 = await q(d, `select "${name}" from d1."${t.name}__all" order by _row`)
  assert.deepEqual(r3.rows.map(x => x[0]), ['x', 'y', 'z'])
  store.addDerivedColumn(d.id, t.name, '分数', [1, 2.5, null])
  assert.equal(store.get(d.id).tables[0].columns.find(c => c.label === '分数').type, 'real')
  // 统计模块的接口：按 rowid 取数、按 rowid 写回
  const rr = await q(d, `select rowid as __rowid, "c01_意见" as __text from d1."${t.name}" order by rowid`)
  assert.deepEqual(rr.rows[1], [2, '老师好'], 'rowid 可查询')
  const added = store.addDerivedRows({ datasetId: d.id, table: t.name, columnName: '情感', rows: [{ rowid: 1, value: '负面' }, { rowid: 3, value: '负面' }] })
  const rj = await q(d, `select "${added.columnName}", count(*) from d1."${t.name}__all" group by 1 order by 1`)
  assert.deepEqual(rj.rows, [[null, 1], ['负面', 2]])
  assert.throws(() => store.addDerivedRows({ datasetId: d.id, table: t.name, columnName: 'x', rows: [{ rowid: 9, value: 'a' }] }), /超出范围/)
  assert.equal(rj.total, 2)
  const reloaded = new DatasetStore(tmp)
  assert.equal(reloaded.get(d.id).tables[0].columns.filter(c => c.derived).length, 3, '目录里持久化')
  assert.equal(store.preview(d.id, t.name).columns.length, 4, '预览包含派生列')
}

console.log('datasets-import.test ✓')
