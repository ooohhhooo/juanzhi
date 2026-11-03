// 助手 × 数据分析：统一工具的适配规则（level / effect / planSafe / 预览 / 真名还原）、代号还原、会话树 → 画布节点
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { adaptAgentTool, toOutput, PLAN_SAFE_TOOLS } from '../../src/main/agent/tools/bridge.ts'
import { composeTools } from '../../src/main/agent/all-tools-core.ts'
import { createRegistry } from '../../src/main/agent/tools/index.ts'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { initNames, noteDatasets, noteArgs, restoreNames, restoreDeep, sessionDatasetIds } from '../../src/main/agent/names.ts'
import { sessionToNodes, sectionsOf, refsOfText } from '../../src/renderer/assistant/toNodes.ts'
import { validateCitations } from '../../src/main/agent/citations.ts'

const mk = (name, level, extra = {}) => ({ name, description: 'd', params: z.object({ text: z.string().optional() }), level, run: async a => ({ ok: true, message: 'x', data: a }), ...extra })
const ctx = { sessionId: 's1', dataDir: '', signal: new AbortController().signal, progress() {} }
const opts = { makeCtx: () => ({}), restore: (sid, v) => JSON.parse(JSON.stringify(v).replace(/人员A001/g, '王老师'))}

// level / effect / planSafe
assert.deepEqual(['read', 'draft'].map(l => adaptAgentTool(mk('a', l), opts).level), ['read', 'read'])
const w = adaptAgentTool(mk('b', 'write'), opts); assert.equal(w.level, 'write'); assert.equal(w.effect, 'export')
const e = adaptAgentTool(mk('c', 'external', { preview: a => ({ target: '企业微信群：甲', content: String(a.text), privacyWarning: /王老师/.test(a.text) ? '含个人信息' : undefined }) }), opts)
assert.equal(e.level, 'write'); assert.equal(e.effect, 'external')
// 外部发送：预览和执行前都先还原真名
const pv = await e.preview({ text: '人员A001 的情况' }, ctx)
assert.equal(pv.content, '王老师 的情况'); assert.equal(pv.privacyWarning, '含个人信息'); assert.equal(pv.target, '企业微信群：甲')
// 发给 AI 的（text_classify）保持代号
const cl = adaptAgentTool(mk('text_classify', 'external', { preview: a => String(a.text) }), opts)
assert.equal(await cl.preview({ text: '人员A001' }, ctx), '人员A001')
// 概况类才能在计划阶段用
for (const n of ['list_datasets', 'dataset_profile', 'column_values', 'connectors_list', 'outputs_list', 'board_preview', 'load_playbook', 'session_state', 'stats_overview']) assert.ok(PLAN_SAFE_TOOLS.has(n), n)
for (const n of ['run_query', 'stat_nps', 'stat_compare_groups', 'wecom_send', 'doc_write_section']) assert.ok(!PLAN_SAFE_TOOLS.has(n), n)
// 返回值转换
assert.throws(() => toOutput({ ok: false, error: '坏了' }), /坏了/)
assert.deepEqual(toOutput({ text: '概况' }), { text: '概况', count: 1 })
assert.match(toOutput({ ok: true, message: '好了', data: { a: 1 } }).text, /好了\n\{"a":1\}/)

// 注册表：全部真实工具适配后可注册，规则符合
const reg = createRegistry(composeTools(['connectors_list', 'wecom_send'].map(n => mk(n, 'external', { preview: () => ({ target: 't', content: 'c' }) }))).map(t => adaptAgentTool(t, { makeCtx: () => ({}) })))
assert.equal(reg.get('run_query').planSafe, undefined); assert.equal(reg.get('list_datasets').planSafe, true)
assert.equal(reg.get('wecom_send').effect, 'external'); assert.equal(reg.get('output_export').effect, 'export'); assert.equal(reg.get('text_classify').effect, 'external')
assert.equal(reg.get('doc_write_section').level, 'read', 'draft 不需要审批')

// 引用：query 要在查询记录里
const chk = { q: () => false, lesson: () => false, stu: () => false, query: id => id === '3' }
const v = validateCitations('a [[query:3]] b [[query:9]]', chk)
assert.equal(v.removed, 1); assert.ok(v.text.includes('[[query:3]]') && !v.text.includes('query:9'))

// 代号还原
const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-names-'))
const store = new DatasetStore(dd)
const meta = await store.importBuffer(Buffer.from('姓名,家长手机,分数\n王小明,13912345678,9\n李小红,13987654321,8\n', 'utf8'), 'a.csv')
initNames(() => dd, () => store)
const q = await store.runQuery(`SELECT "c01_姓名" AS n, "c02_家长手机" AS p FROM d1."a" `, [meta.id])
const [code, pcode] = q.rows[0]
assert.ok(/^[^\d]+\d+$/.test(String(code)) || code !== '王小明', '查询结果已代号化')
noteDatasets('s1', [meta.id])
assert.equal(restoreNames('s1', `名单：${code}（${pcode}）`), '名单：王小明（13912345678）')
assert.deepEqual(restoreDeep('s1', { a: [`${code}`], b: 1 }), { a: ['王小明'], b: 1 })
noteArgs('s2', { datasets: [meta.id] }); assert.deepEqual(sessionDatasetIds('s2'), [meta.id])
assert.deepEqual(sessionDatasetIds('s-unknown'), [meta.id], '没有记录时退回全部数据集')
assert.ok(fs.existsSync(path.join(dd, 'agent-session-datasets', 's1.json')))

// 会话树 → 画布节点
const st = (seq, parentId, kind, payload, branchId = 'main') => ({ seq, parentId, branchId, kind, payload })
const steps = [
  st(1, null, 'user', { text: '分析满意度' }), st(2, 1, 'tool_call', { id: 'c0', name: 'update_plan', args: {} }), st(3, 2, 'plan', { items: [{ content: 'a', status: 'done' }] }), st(4, 3, 'tool_result', { id: 'c0', name: 'update_plan', ok: true }),
  st(5, 4, 'ask', { id: 'p', question: '按这个做吗', planReview: true, answer: '按这个做' }),
  st(6, 5, 'tool_call', { id: 'c1', n: 1, name: 'list_datasets', args: {} }), st(7, 6, 'tool_result', { id: 'c1', n: 1, name: 'list_datasets', ok: true, summary: '1 条' }),
  st(8, 7, 'tool_call', { id: 'c2', n: 2, name: 'run_query', args: {} }), st(9, 8, 'tool_result', { id: 'c2', n: 2, name: 'run_query', ok: true, summary: '300 条' }),
  st(10, 9, 'answer', { text: '## 结论\n偏低 [[query:2]]\n\n## 依据\n见查询 [[query:1]]' }),
  st(11, 10, 'user', { text: '为什么' }, 'b1'), st(12, 11, 'answer', { text: '因为……' }, 'b1')
]
const r = sessionToNodes(steps, { outputs: [{ id: 'd1', type: 'md', name: '汇报', updatedAt: 5 }], boardFindings: ['发现一'] })
const kinds = r.nodes.map(n => n.kind)
for (const k of ['question', 'plan', 'ask', 'step-group', 'answer', 'finding', 'followup', 'output']) assert.ok(kinds.includes(k), k)
assert.equal(r.nodes.filter(n => n.kind === 'step-group').length, 1, '连续的查询合成一组')
const ans = r.nodes.find(n => n.id === 'a10'); assert.equal(ans.parentId, 'k5', '回答接在提问下，不挂在查询组下面')
assert.equal(r.nodes.find(n => n.id === 'u11').parentId, 'a10'); assert.equal(r.nodes.find(n => n.id === 'u11').kind, 'followup')
assert.equal(r.seqOf['u11'], 11); assert.equal(r.seqOf['f10-0'], 10, '发现节点追问时挂在回答的步骤上')
assert.deepEqual(ans.refs.map(x => `${x.type}:${x.id}`), ['query:2', 'query:1'])
assert.equal(sectionsOf('只有一段').length, 0); assert.equal(sectionsOf('## a\nx\n## b\ny').length, 2)
assert.equal(refsOfText('[[query:3]] [[query:3]] [[q:abc]]').length, 2)
const ids = new Set(r.nodes.map(n => n.id)); for (const n of r.nodes) assert.ok(n.parentId === null || ids.has(n.parentId), `${n.id} 的父节点存在`)

console.log('agent-bridge.test ✓')
