// 工具总入口（纯逻辑部分）：三组工具合并、level 统一、external 必须有 preview、board_start 登记产出、表格 xlsx 导出接上看板模块
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { z } from 'zod'
import { composeTools } from '../../src/main/agent/all-tools-core.ts'
import { listOutputs } from '../../src/main/agent/outputs/store.ts'
import { exportOutput } from '../../src/main/agent/outputs/export.ts'
import { clearBoards } from '../../src/main/analysis/report/tools.ts'

const fakeConnectors = [
  { name: 'connectors_list', description: 'x', params: z.object({}), level: 'external', preview: async () => ({ target: '', content: '' }), run: async () => ({ ok: true, message: '无' }) },
  { name: 'wecom_send', description: 'x', params: z.object({ text: z.string() }), level: 'external', preview: async a => ({ target: '某群', content: a.text }), run: async () => ({ ok: true, message: '已发送' }) }
]
const tools = composeTools(fakeConnectors)
const by = Object.fromEntries(tools.map(t => [t.name, t]))
const LEVELS = new Set(['read', 'draft', 'write', 'external'])
assert.ok(tools.every(t => LEVELS.has(t.level)), '只有四种 level')
assert.equal(by.connectors_list.level, 'read'); assert.equal(by.wecom_send.level, 'external')
assert.equal(by.doc_create.level, 'draft'); assert.equal(by.table_save.level, 'draft'); assert.equal(by.output_export.level, 'write')
assert.ok(tools.filter(t => t.level === 'external').every(t => typeof t.preview === 'function'))
assert.deepEqual(await by.wecom_send.preview({ text: '你好' }), { target: '某群', content: '你好' })
assert.ok(by.run_query && by.stat_nps && by.text_classify && by.board_export && by.doc_write_section)

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-alltools-'))
const ctx = { sessionId: 's1', dataDir }
// board_start → 产出列表里有看板
const r = await by.board_start.run(by.board_start.params.parse({ title: '测试看板' }), ctx)
assert.ok(r.ok)
const boards = listOutputs(ctx).filter(e => e.type === 'board')
assert.equal(boards.length, 1); assert.equal(boards[0].name, '测试看板')
await by.board_start.run(by.board_start.params.parse({ title: '改名看板' }), ctx)
assert.equal(listOutputs(ctx).filter(e => e.type === 'board').length, 1, '重复 board_start 不重复登记')
// 表格 → xlsx
const t = await by.table_save.run(by.table_save.params.parse({ name: '跟进名单', columns: ['姓名', '分数'], rows: [['人员A001', 3], ['人员A002', 5]] }), ctx)
const ex = await by.output_export.run(by.output_export.params.parse({ id: t.tableId, format: 'xlsx' }), ctx)
assert.equal(ex.note, undefined, '没有退回 csv')
assert.ok(ex.path.endsWith('.xlsx'))
const zip = await JSZip.loadAsync(fs.readFileSync(ex.path))
assert.ok((await zip.file('xl/sharedStrings.xml').async('string')).includes('人员A002'))
// 重名工具报错
assert.throws(() => composeTools([...fakeConnectors, fakeConnectors[1]]), /重复/)
assert.throws(() => composeTools([{ ...fakeConnectors[1], name: 'x_send', preview: undefined }]), /preview/)
clearBoards()
console.log(`agent-all-tools.test ✓（${tools.length} 个工具）`)
