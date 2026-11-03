// 分析模块端到端（不依赖 Agent 内核）：虚构数据导入 → 经 analysisTools() 依次调用数据集 / 统计 / 文字归类 / 看板工具 → 导出 xlsx 读回。
// 同时确认：任何工具返回里都没有敏感原值（老师 / 辅导老师姓名、手机号）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import JSZip from 'jszip'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { analysisTools, createAnalysisContext } from '../../src/main/analysis/tools-adapter.ts'
import { exportBoardXlsx } from '../../src/main/analysis/report/export-xlsx.ts'
import { clearBoards, getBoard } from '../../src/main/analysis/report/tools.ts'

const require = createRequire(import.meta.url)
const { generate, TEACHERS, COACHES } = require('../fixtures/gen-ops-data.cjs')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const read = f => fs.readFileSync(path.join(root, 'src/main/ai/prompts', f), 'utf8').replace(/\s+$/, '')
const prompts = { proposeSystem: read('p6_classify_propose.system.txt'), proposeUser: read('p6_classify_propose.user.txt'), assignSystem: read('p6_classify_assign.system.txt'), assignUser: read('p6_classify_assign.user.txt') }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-analysis-int-'))
const store = new DatasetStore(path.join(tmp, 'data'))
await generate(path.join(tmp, 'ops'))
const ds = await store.importFile(path.join(tmp, 'ops', 'survey.xlsx'))
const table = ds.tables.find(t => t.sheet === '问卷')
const col = label => table.columns.find(c => c.label === label).name
const Q = n => `"${n}"`

// 假 AI：按关键词归类
const KEYS = { 价格: ['价格', '优惠'], 作业: ['作业'], 时间: ['时间'], 教学: ['讲得', '课程'] }
const fakeAi = async o => {
  if (o.system === prompts.proposeSystem) return { content: JSON.stringify({ categories: Object.keys(KEYS).map(name => ({ name, definition: name, examples: [] })) }) }
  const lines = o.user.split('【要归类的文字】\n')[1].split('\n').filter(l => /^\d+\. /.test(l))
  const items = lines.map(l => {
    const [, id, text] = /^(\d+)\. (.*)$/.exec(l)
    const cs = Object.entries(KEYS).filter(([, ks]) => ks.some(k => text.includes(k))).map(([n]) => n)
    return { id: Number(id), categories: cs.length ? cs : ['其他'] }
  })
  return { content: JSON.stringify({ items }) }
}

const exported = []
const ctx = createAnalysisContext({
  sessionId: 'int-1', dataDir: path.join(tmp, 'data'), store, classifyAi: fakeAi, classifyPrompts: prompts,
  exportBoard: async (spec, format) => {
    assert.equal(format, 'xlsx')
    const file = path.join(tmp, 'out.xlsx')
    fs.writeFileSync(file, await exportBoardXlsx(spec))
    exported.push(file)
    return { saved: true, path: file }
  }
})

const tools = analysisTools()
const byName = Object.fromEntries(tools.map(t => [t.name, t]))
const seen = []
const call = async (name, args) => {
  const t = byName[name]
  assert.ok(t, '缺少工具 ' + name)
  const parsed = t.params.parse(args)
  const out = await t.run(parsed, ctx)
  seen.push(JSON.stringify(out))
  return out
}

// ── 工具清单 ──
const names = tools.map(t => t.name)
assert.equal(new Set(names).size, names.length, '工具名不能重复')
assert.deepEqual(names.filter(n => !n.startsWith('stat_')), ['list_datasets', 'dataset_profile', 'run_query', 'column_values', 'text_classify', 'board_start', 'board_add_finding', 'board_add_section', 'board_add_block', 'board_set_caliber', 'board_preview', 'board_export'])
assert.equal(names.filter(n => n.startsWith('stat_')).length, 10)
const level = n => byName[n].level
assert.equal(level('run_query'), 'read'); assert.equal(level('stat_nps'), 'read'); assert.equal(level('text_classify'), 'external')
assert.equal(level('board_add_block'), 'draft'); assert.equal(level('board_export'), 'write')
for (const n of ['text_classify', 'board_export']) assert.equal(typeof byName[n].preview, 'function', n + ' 要有 preview')

// ── 数据集工具 ──
const list = await call('list_datasets', {})
assert.equal(list.datasets.length, 1)
const id = list.datasets[0].id
const prof = await call('dataset_profile', { datasetId: id })
assert.match(prof.text, /推荐分/)
const cv = await call('column_values', { datasetId: id, table: table.name, column: col('班级') })
assert.ok(cv)

const T = `d1.${Q(table.name)}`
const q = await call('run_query', { sql: `SELECT ${Q(col('授课老师'))} AS 老师, count(*) AS 人数 FROM ${T} GROUP BY 1`, datasets: [id] })
assert.ok(q.ok); assert.equal(q.rows.length, 5)
assert.ok(q.rows.every(r => /^人员[A-Z]\d{3}$/.test(r[0])), '老师是代号')

// ── 统计工具（明细 > 500 行也要能用：问卷只有 300 行，这里另测行数上限） ──
const detail = `SELECT ${Q(col('班级'))} AS 班级, ${Q(col('授课老师'))} AS 授课老师, ${Q(col('新老生'))} AS 新老生, ${Q(col('推荐分'))} AS 推荐分, ${Q(col('满意度'))} AS 满意度, ${Q(col('文字意见'))} AS 意见 FROM ${T}`
const nps = await call('stat_nps', { datasets: [id], sql: detail, scoreColumn: '推荐分', groupKey: '授课老师' })
assert.ok(nps.ok, JSON.stringify(nps)); assert.equal(nps.overall.n, 300)
assert.ok(nps.groups.groups.every(g => /^人员[A-Z]\d{3}$/.test(g.name ?? g.group ?? g.key ?? '人员A000')) || JSON.stringify(nps.groups).includes('人员'), '分组名是代号')
const cmp = await call('stat_compare_groups', { datasets: [id], sql: detail, groupKey: '授课老师', metric: 'mean', column: '满意度', unit: '分' })
assert.ok(cmp.ok, JSON.stringify(cmp))
const low = await call('stat_find_low_groups', { datasets: [id], sql: detail, dimensions: ['班级', '授课老师'], metric: 'mean', column: '满意度' })
assert.ok(low.ok, JSON.stringify(low))
// 查询失败要给白话错误而不是抛异常
const badStat = await call('stat_nps', { datasets: [id], sql: 'SELECT 1 FROM nowhere', scoreColumn: 'x' })
assert.equal(badStat.ok, false); assert.ok(badStat.error)

// ── 超过 500 行的明细：统计用的 runQuery 不被 500 行截断 ──
const big = await ctx.runQuery(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1500) SELECT i FROM n`, [id])
assert.equal(big.rows.length, 1500); assert.equal(big.truncated, false); assert.equal(typeof big.rows[0].i, 'number')

// ── 文字归类（假 AI）→ 写回派生列 → 能查到 ──
const cls = await call('text_classify', { datasetId: id, table: table.name, column: col('文字意见'), newColumn: '意见归类' })
assert.ok(cls.ok, JSON.stringify(cls))
assert.ok(cls.categories.length >= 4)
const derived = await call('run_query', { sql: `SELECT ${Q(cls.newColumn)} AS 类别, count(*) AS 人数 FROM d1.${Q(table.name + '__all')} GROUP BY 1 ORDER BY 2 DESC`, datasets: [id] })
assert.ok(derived.ok, JSON.stringify(derived))
assert.ok(derived.rows.some(r => String(r[0]).includes('价格')), '派生列里有「价格」类')
assert.equal(derived.rows.reduce((s, r) => s + r[1], 0), 300)

// ── 看板 ──
await call('board_start', { title: '秋季满意度', subtitle: '虚构数据', dataNote: '300 份问卷' })
await call('board_add_finding', { title: '整体 NPS 见下', body: nps.overall.text ?? `NPS ${nps.overall.nps}` })
const sec = await call('board_add_section', { id: 'overall', title: '总体', intro: '推荐分概况' })
assert.ok(sec.ok)
const blk = await call('board_add_block', { sectionId: 'overall', block: { type: 'chart', chart: { kind: 'bar', title: '意见类别', categories: derived.rows.map(r => String(r[0])), series: [{ name: '人数', values: derived.rows.map(r => r[1]) }], valueFormat: 'number' } } })
assert.ok(blk.ok, JSON.stringify(blk))
await call('board_set_caliber', { items: ['推荐分 0–10', '意见为空的不计入归类'] })
const prev = await call('board_preview', {})
assert.ok(prev.ok); assert.match(prev.message, /总体/)
assert.ok(getBoard({ sessionId: 'int-1', dataDir: ctx.dataDir }), '草稿在内存里')
assert.ok(fs.existsSync(path.join(ctx.dataDir, 'analysis-boards', 'int-1.json')), '草稿落盘')
const ex = await call('board_export', { format: 'xlsx' })
assert.ok(ex.ok && ex.data.saved, JSON.stringify(ex))
const zip = await JSZip.loadAsync(fs.readFileSync(exported[0]))
const shared = await zip.file('xl/sharedStrings.xml').async('string')
const wb = await zip.file('xl/workbook.xml').async('string')
assert.ok(shared.includes('秋季满意度') && shared.includes('价格'), '导出的 xlsx 里读得回标题和类别')
assert.ok(wb.includes('核心发现') && wb.includes('总体') && wb.includes('口径说明'))
// 没有 exportBoard 的环境
const noExport = await byName.board_export.run({ format: 'xlsx' }, { ...ctx, exportBoard: undefined })
assert.equal(noExport.ok, false)

// ── 敏感值：所有工具返回里没有原值 ──
const all = seen.join('\n')
for (const n of [...TEACHERS, ...COACHES]) assert.ok(!all.includes(n), '泄露了原值 ' + n)
assert.ok(!/139\d{8}/.test(all), '泄露了手机号')
assert.ok(/人员[A-Z]\d{3}/.test(all), '返回里应有代号')
// 教师名册表（另一张表）的概况也是代号
assert.ok(!(await call('dataset_profile', { datasetId: id, table: ds.tables.find(t => t.sheet === '教师名册').name })).text.includes('老师0'))
// 兜底代号化：统计返回里带了原值时也会被换掉
const { scrub } = await import('../../src/main/analysis/tools-adapter.ts')
const out = scrub(store, [id], { groups: [{ name: TEACHERS[0] }], note: `${TEACHERS[1]}偏低` })
assert.ok(!JSON.stringify(out).includes('老师'), JSON.stringify(out))

clearBoards()
console.log(`analysis-integration.test ✓（${tools.length} 个工具）`)
