// 每个角色只看到自己的工具：名单计算（内置 / 自建 / 外部连接）、发给模型的清单按名单过滤、名单外的调用被拒绝、「其他身份能做什么」提示
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ROLES } from '../../src/main/agent/roles.ts'
import { toRoleDef } from '../../src/main/agent/custom-roles.ts'
import { roleToolNames, roleCapabilities, otherRolesHint } from '../../src/main/agent/role-tools.ts'
import { runAgent } from '../../src/main/agent/harness.ts'
import { ToolRegistry } from '../../src/main/agent/registry.ts'
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts'
import { composeTools } from '../../src/main/agent/all-tools-core.ts'
import { BUILTIN_TOOLS } from '../../src/main/agent/tools/builtin.ts'
import { RESEARCH_TOOLS as RESEARCH_DEFS } from '../../src/main/agent/tools/research.ts'
import { DATA_TOOLS as DATA_DEFS } from '../../src/main/agent/tools/data.ts'

const mcp = ['mcp_a_post', 'report_generate', 'paper_import']   // service 的动态名单里夹着这两个固定工具
const role = id => ROLES.find(r => r.id === id)
const names = (id, mcp = []) => new Set(roleToolNames(role(id), mcp))

// 所有名单里的工具名都真实存在（含 composeTools 的数据 / 产出 / 连接器 + 试卷 / 报告）
const known = new Set([...BUILTIN_TOOLS, ...DATA_DEFS, ...RESEARCH_DEFS].map(t => t.name))
const fakeConn = ['connectors_list', 'wecom_send'].map(name => ({ name, description: 'x', params: z.object({}), level: 'read', run: async () => ({ ok: true, message: '' }) }))
fakeConn[1].level = 'external'; fakeConn[1].preview = async () => ({ target: 't', content: 'c' })
for (const t of composeTools(fakeConn)) known.add(t.name)
known.add('paper_import'); known.add('report_generate')
for (const r of ROLES) for (const n of r.tools) assert.ok(known.has(n), `${r.id} 的工具「${n}」不存在`)

// 教研 / 主讲不碰企业微信、数据导入、看板、文字归类
for (const id of ['research', 'teacher']) {
  const s = names(id)
  for (const n of ['wecom_send', 'connectors_list', 'list_datasets', 'run_query', 'board_start', 'text_classify', 'report_generate']) assert.ok(!s.has(n), `${id} 不该有 ${n}`)
  for (const n of ['research_table', 'textbook_locate', 'lesson_kps', 'courseware_read', 'stats_overview']) assert.ok(s.has(n), `${id} 应有 ${n}`)
}
assert.ok(names('research').has('paper_import') && !names('teacher').has('paper_import'))
assert.ok(names('teacher').has('card_make') && !names('research').has('card_make'))
// 运营不要教研 / 备课的工具；辅导老师同样
for (const id of ['ops', 'tutor']) for (const n of ['research_table', 'textbook_locate', 'lesson_kps', 'courseware_read']) assert.ok(!names(id).has(n), `${id} 不该有 ${n}`)
assert.ok(!names('ops').has('fact_check') && names('tutor').has('fact_check'))
assert.ok(names('ops').has('wecom_send') && names('ops').has('report_generate') && names('ops').has('paper_import'))
assert.ok(names('tutor', mcp).has('report_generate') && !names('tutor', mcp).has('paper_import'), '辅导老师不因为动态名单而多出导入试卷')
assert.ok(!names('research', mcp).has('report_generate') && !names('teacher', mcp).has('paper_import'))
// 外部（MCP）工具只给运营 / 辅导老师
assert.ok(names('ops', mcp).has('mcp_a_post') && names('tutor', mcp).has('mcp_a_post'))
assert.ok(!names('research', mcp).has('mcp_a_post') && !names('teacher', mcp).has('mcp_a_post'))

// 自建角色：只有勾选的 + 基础工具；老角色文件（带 stats_overview）才补后来新增的查询
{
  const tiny = toRoleDef({ id: 'c-abc123', name: '小角色', description: '', tools: ['kp_questions'], suggestions: [], notes: '' })
  const s = new Set(roleToolNames(tiny, mcp))
  assert.ok(s.has('kp_questions') && s.has('update_plan') && s.has('history_search'))
  for (const n of ['wecom_send', 'card_make', 'paper_import', 'report_generate', 'mcp_a_post']) assert.ok(!s.has(n), `自建角色不该有 ${n}`)
  const legacy = toRoleDef({ id: 'c-old123', name: '老角色', description: '', tools: ['stats_overview'], suggestions: [], notes: '' })
  const l = new Set(roleToolNames(legacy))
  assert.ok(l.has('papers_list') && l.has('report_generate') && !l.has('wecom_send'))
}

// 循环：发给模型的清单 = 名单；名单外的调用被拒绝并提示换角色
{
  const registry = new ToolRegistry()
  for (const n of ['stats_overview', 'wecom_send', 'research_table']) registry.register({ name: n, description: n, level: 'read', schema: z.object({}), run: () => 'ok' })
  const sentTools = []
  const script = [
    { content: '', toolCalls: [{ id: 'x', type: 'function', function: { name: 'wecom_send', arguments: '{}' } }] },
    { content: '这个要切到「运营」身份来做。', toolCalls: [] }
  ].map(r => ({ ...r, usage: { promptTokens: 1, completionTokens: 1 } }))
  const events = []
  const r = await runAgent({
    callModel: async req => { sentTools.push(req.tools.map(t => t.function.name)); return script.shift() }, registry, toolNames: ['stats_overview', 'research_table'],
    ctx: { db: null, scene: 'org', roleId: 'research', sessionId: 's', playbook: () => null, playbookNames: () => [] }, approve: async () => true, askUser: async () => '', emit: e => events.push(e),
    signal: new AbortController().signal, cite: { q: () => false, lesson: () => false, stu: () => false }
  }, { system: 'S', history: [], user: 'Q' })
  assert.deepEqual(sentTools[0].sort(), ['research_table', 'stats_overview'])
  const tr = events.find(e => e.type === 'tool_result')
  assert.equal(tr.ok, false); assert.match(tr.text, /当前角色不能使用/)
  assert.equal(r.stop, 'answered')
}

// 提示：列出别的身份擅长什么，且写进 system
{
  const hint = otherRolesHint(role('research'), ROLES, 'org', mcp)
  assert.match(hint, /切到/); assert.match(hint, /运营：[^\n]*发到企业微信/); assert.ok(!/- 教研：/.test(hint))
  assert.match(hint, /主讲老师：做分享卡片/)
  assert.ok(roleCapabilities(role('ops'), mcp).includes('用已连接的外部工具'))
  const sys = buildSystemPrompt({ role: role('research'), scene: 'org', playbooks: [], today: 'x', otherRoles: hint })
  assert.ok(sys.includes('其他身份能做、你现在做不了的事'))
  assert.equal(otherRolesHint(role('ops'), [role('ops')], 'org'), '')
}
console.log('agent-role-tools OK')
