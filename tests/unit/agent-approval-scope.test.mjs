// 「本次对话都允许」：范围 = 同一对话 + 同一工具 + 同一去向；含个人信息 / 没标性质 / 删除类不开放；选过之后同范围不再弹窗，换范围仍要问
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgent } from '../../src/main/agent/harness.ts'
import { ToolRegistry } from '../../src/main/agent/registry.ts'
import { SessionGrants, sessionScopeKey } from '../../src/main/agent/approval-scope.ts'

const ext = { level: 'write', effect: 'external' }
assert.equal(sessionScopeKey(ext, 'wecom_send', { kind: 'text' }, { target: '企业微信群：A', content: 'x' }), 'wecom_send|企业微信群：A|')
assert.notEqual(sessionScopeKey(ext, 'wecom_send', { kind: 'text' }, { target: '企业微信群：A', content: 'x' }), sessionScopeKey(ext, 'wecom_send', { kind: 'text' }, { target: '企业微信群：B', content: 'x' }))
assert.notEqual(sessionScopeKey(ext, 'wecom_send', { kind: 'file' }, { target: '企业微信群：A', content: 'x' }), sessionScopeKey(ext, 'wecom_send', { kind: 'text' }, { target: '企业微信群：A', content: 'x' }))
assert.equal(sessionScopeKey(ext, 'wecom_send', {}, { target: 'A', content: 'x', privacyWarning: '含手机号' }), null)   // 含个人信息：每次问
assert.equal(sessionScopeKey({ level: 'write' }, 'paper_import', {}, undefined), null)                                  // 没标性质（花 AI 额度）：每次问
assert.equal(sessionScopeKey({ level: 'read', effect: 'external' }, 'x', {}), null)
assert.equal(sessionScopeKey(ext, 'mcp_delete_all', {}, { target: 'A', content: '' }), null)                              // 删除类：每次问
assert.equal(sessionScopeKey({ level: 'write', effect: 'export' }, 'output_export', {}, undefined), 'output_export||')
const g = new SessionGrants(); g.of('s1').add('k')
assert.ok(g.of('s1').has('k')); assert.ok(!g.of('s2').has('k')); g.clear('s1'); assert.ok(!g.of('s1').has('k'))

// 循环里：A（选「都允许」）→ A（不再问）→ B（换了去向，要问）→ A 但含个人信息（要问，且不给第三个选项）
const mk = (approveSeq, grants) => {
  const registry = new ToolRegistry()
  const sent = []
  registry.register({ name: 'send', description: 'd', level: 'write', effect: 'external', schema: z.object({ to: z.string(), pii: z.boolean().default(false) }),
    preview: a => ({ target: `群：${a.to}`, content: 'hi', ...(a.pii ? { privacyWarning: '含手机号' } : {}) }), run: a => { sent.push(a.to); return 'sent' } })
  const mkc = (id, to, pii) => ({ id, type: 'function', function: { name: 'send', arguments: JSON.stringify({ to, pii }) } })
  const script = [
    { content: '', toolCalls: [mkc('1', 'A')] }, { content: '', toolCalls: [mkc('2', 'A')] }, { content: '', toolCalls: [mkc('3', 'B')] }, { content: '', toolCalls: [mkc('4', 'A', true)] }, { content: '完成', toolCalls: [] }
  ].map(r => ({ ...r, usage: { promptTokens: 1, completionTokens: 1 } }))
  const events = [], asked = []
  const deps = {
    callModel: async () => script.shift(), registry, toolNames: ['send'], ctx: { db: null, scene: 'org', roleId: 'ops', sessionId: 's', playbook: () => null, playbookNames: () => [] },
    approve: async req => { asked.push(req); return approveSeq.shift() }, sessionGrants: grants, askUser: async () => '', emit: e => events.push(e), signal: new AbortController().signal,
    cite: { q: () => false, lesson: () => false, stu: () => false }, budget: { stuckRepeat: 9 }
  }
  return { run: () => runAgent(deps, { system: 'S', history: [], user: 'Q' }), sent, events, asked }
}
{
  const m = mk(['session', true, true], new Set())
  await m.run()
  assert.deepEqual(m.sent, ['A', 'A', 'B', 'A'])
  assert.equal(m.asked.length, 3, '第 2 次发到 A 不再问；发到 B、含个人信息的发到 A 仍要问')
  assert.deepEqual(m.asked.map(a => !!a.canSession), [true, true, false])
  assert.deepEqual(m.events.filter(e => e.type === 'approved').map(e => e.scope), ['session', 'auto', 'once', 'once'])
  assert.equal(m.events.filter(e => e.type === 'approval').length, 3, '自动放行时不弹窗')
}
{ // 不允许；没给名单时不提供「都允许」，误传 session 也不放行
  const m = mk([false, 'session', true, true], undefined)
  await m.run()
  assert.deepEqual(m.sent, ['B', 'A'])
  assert.ok(m.asked.every(a => !a.canSession))
  assert.equal(m.asked.length, 4)
  assert.equal(m.events.find(e => e.type === 'approved').ok, false)
}
{ // 另一个对话的名单互不影响
  const g1 = new Set(), g2 = new Set()
  const m1 = mk(['session', true, true], g1); await m1.run()
  const m2 = mk([true, true, true, true], g2); await m2.run()
  assert.equal(m2.asked.length, 4)
}
console.log('agent-approval-scope OK')
