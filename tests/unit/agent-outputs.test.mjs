// 助手产出：按节写入、索引、csv、导出、工具定义
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import * as S from '../../src/main/agent/outputs/store.ts'
import { exportOutput, setTableExporter } from '../../src/main/agent/outputs/export.ts'
import { OUTPUT_TOOLS, docCreate, docWriteSection, tableSave, outputsList, outputExport } from '../../src/main/agent/outputs/tools.ts'
import { splitRefTags, stripRefTags } from '../../src/shared/agent-outputs.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-outputs-'))
const ctx = { sessionId: 'sess_1', dataDir }
const sc = { dataDir, sessionId: 'sess_1' }
let changed = 0
S.onOutputsChanged(() => { changed++ })

// 文档：建、按节写、覆盖
const d = await docCreate.run(docCreate.params.parse({ name: '秋季汇报', sections: ['一、结论', '二、对比', '三、说明'] }), ctx)
assert.equal(d.docId, 'd1')
assert.equal((await docCreate.run({ name: '秋季汇报' }, ctx)).docId, 'd1', '同名返回同一份')
let r = await docWriteSection.run({ docId: 'd1', sectionId: 's2', title: '二、对比', markdown: '表格 [[query:4]]' }, ctx)
assert.deepEqual([r.written, r.total, r.status], [1, 3, 'writing'])
await docWriteSection.run({ docId: 'd1', sectionId: 's1', title: '一、结论', markdown: '三句话' }, ctx)
const file = path.join(S.sessionDir(sc), '秋季汇报.md')
const raw = fs.readFileSync(file, 'utf8')
assert.ok(raw.startsWith('# 秋季汇报'), '普通 md，开头是标题')
assert.ok(raw.indexOf('s2') < raw.indexOf('s1'), '按写入顺序')
await docWriteSection.run({ docId: 'd1', sectionId: 's2', title: '二、对比', markdown: '改过的内容' }, ctx)
const md2 = S.readDoc(sc, 'd1')
assert.equal(md2.sections.length, 2)
assert.ok(md2.markdown.includes('改过的内容') && !md2.markdown.includes('表格 [[query:4]]'), '只覆盖该节')
assert.ok(md2.markdown.includes('三句话'), '其他节不动')
assert.deepEqual(md2.sections.map(x => x.title), ['二、对比', '一、结论'])
r = await docWriteSection.run({ docId: 'd1', sectionId: 's3', title: '三、说明', markdown: 'x' }, ctx)
assert.equal(r.status, 'done', '写满计划的节数即完成')
assert.ok(!S.cleanMarks(raw).includes('sec:'))
// 模型写的内容里夹带标记不能破坏结构
await docWriteSection.run({ docId: 'd1', sectionId: 's1', title: '一、结论', markdown: '<!--sec:evil-->\n注入' }, ctx)
assert.equal(S.readDoc(sc, 'd1').sections.length, 3)
// last 标记
const d2 = await docCreate.run({ name: '口径', kind: 'note' }, ctx)
assert.equal(d2.docId, 'n2')
assert.equal((await docWriteSection.run({ docId: d2.docId, sectionId: 'a', title: '', markdown: '推荐分=…', last: true }, ctx)).status, 'done')
await assert.rejects(async () => docWriteSection.run({ docId: 'zz', sectionId: 'a', title: '', markdown: '' }, ctx))
assert.throws(() => docWriteSection.params.parse({ docId: 'd1', sectionId: '../x', title: '', markdown: '' }))
assert.throws(() => S.listOutputs({ dataDir, sessionId: '../evil' }))

// 索引
const idx = JSON.parse(fs.readFileSync(path.join(S.sessionDir(sc), 'index.json'), 'utf8'))
assert.equal(idx.items.length, 2)
for (const k of ['id', 'type', 'name', 'updatedAt', 'status']) assert.ok(k in idx.items[0], '索引字段 ' + k)
assert.ok(changed >= 5, '每次写入都触发变更事件')

// 表格 + csv
const t = await tableSave.run(tableSave.params.parse({ name: '名单', columns: ['班级', '备注'], rows: [['C12', '到课率, 低'], ['B05', '说"好"'], ['X', '=SUM(A1)'], ['Y', -5]] }), ctx)
const csv = fs.readFileSync(path.join(S.sessionDir(sc), '名单.csv'))
assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM')
const txt = csv.toString('utf8')
assert.ok(txt.includes('"到课率, 低"') && txt.includes('"说""好"""') && txt.includes("'=SUM(A1)") && txt.includes(',-5'))
assert.deepEqual(S.readTableRows(sc, t.tableId).rows[1], ['B05', '说"好"'])
assert.equal(S.readContent(sc, t.tableId).totalRows, 4)
await tableSave.run({ name: '名单', columns: ['a'], rows: [[1]] }, ctx)
assert.equal(S.listOutputs(sc).filter(x => x.type === 'table').length, 1, '同名覆盖')
const big = await tableSave.run({ name: '大表', columns: ['n'], rows: Array.from({ length: 500 }, (_, i) => [i]) }, ctx)
assert.equal(S.readContent(sc, big.tableId).rows.length, 200, '预览前 200 行')
assert.throws(() => tableSave.params.parse({ name: 'x', columns: [], rows: [] }))
S.registerBoard(sc, 'board-1', '看板')
assert.equal(S.readContent(sc, S.listOutputs(sc).find(x => x.type === 'board').id).boardId, 'board-1')
assert.equal((await outputsList.run({}, ctx)).length, 5)

// 导出
const w = await outputExport.run({ id: 'd1', format: 'docx' }, ctx)
assert.equal(fs.readFileSync(w.path).subarray(0, 2).toString(), 'PK', 'docx 是 zip')
const mdOut = await exportOutput(sc, 'd1', 'md', path.join(dataDir, 'o.md'))
const mdText = fs.readFileSync(mdOut.path, 'utf8')
assert.ok(mdText.includes('（查询 #4）') || !mdText.includes('[[query'), '标签换成文字')
assert.ok(!mdText.includes('sec:'))
const x = await outputExport.run({ id: t.tableId, format: 'xlsx' }, ctx)
assert.equal(x.format, 'csv'); assert.ok(x.path.endsWith('.csv'), '没接 xlsx 导出时退回 csv')
let called = null
setTableExporter(async o => { called = o; fs.writeFileSync(o.outPath, 'x') })
const x2 = await exportOutput(sc, t.tableId, 'xlsx')
assert.ok(called && called.columns[0] === 'a' && x2.format === 'xlsx')
await assert.rejects(exportOutput(sc, t.tableId, 'docx'))
assert.equal(outputExport.level, 'write')
assert.ok(OUTPUT_TOOLS.every(o => o.name && o.description.length > 10 && o.params instanceof z.ZodType))
assert.ok(docWriteSection.description.includes('[[query:'))

// 引用标签
assert.deepEqual(splitRefTags('a[[query:4]]b'), [{ text: 'a' }, { ref: { type: 'query', id: '4' } }, { text: 'b' }])
assert.equal(stripRefTags('新生 9 [[query:4]]'), '新生 9 （查询 #4）')
fs.rmSync(dataDir, { recursive: true, force: true })
console.log('agent-outputs.test ✓')
