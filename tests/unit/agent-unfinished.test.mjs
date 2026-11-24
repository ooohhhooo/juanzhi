// 「说了要做、却没做」：检测器的正反例 + 在循环里的行为（只提醒一次、取消 / 提问 / 已调用工具时不提醒）
import assert from 'node:assert/strict'
import { z } from 'zod'
import { runAgent } from '../../src/main/agent/harness.ts'
import { ToolRegistry } from '../../src/main/agent/registry.ts'
import { detectUnfinishedPromise, findUnfinishedPromise } from '../../src/main/agent/unfinished.ts'

const yes = [
  '好的，我来帮你生成这份看板。', '现在开始生成报告。', '接下来我会查一下四年级的数据。', '明白了，我这就去查询退费原因。',
  '我先看一下数据概况，然后整理成表格。', '让我查一下这个知识点考了哪些卷子。', '稍等，我马上导出文件。',
  '以上是思路。\n\n现在我来帮你把名单整理出来。', '收到，我将为你制作一张知识卡。', 'Let me run the query for grade 4.', "I'll generate the report now.", 'Now I will export the file.'
]
const no = [
  '你想看哪个年级？', '要我现在生成吗？', '请选择：1. 四年级 2. 五年级', '我可以帮你生成一份看板，需要吗？', '如果需要，我会再帮你导出。',
  '四年级共有 14 份卷子，一般过去时考得最多。', '已经帮你整理好了，结果在上面的表格里。', '', '   ', '抱歉，软件里没有这方面的数据。',
  '我已经查完了：共 3 个班。', '这个要切到「运营」身份来做。', 'Would you like me to generate the report?', 'I can help you export it if you want.',
  '你是想按年级还是按班级看？我先给你个思路', '有两种做法：\n- 按年级\n- 按班级\n你选哪一种，告诉我'
]
for (const t of yes) assert.ok(detectUnfinishedPromise(t), `应命中：${t}`)
for (const t of no) assert.ok(!detectUnfinishedPromise(t), `不应命中：${t}`)
assert.match(findUnfinishedPromise('先说结论。\n好的，我来帮你生成这份看板。'), /我来帮你生成/)

const mk = (script, o = {}) => {
  const registry = new ToolRegistry()
  registry.register({ name: 'lookup', description: 'd', level: 'read', schema: z.object({}), run: () => ({ text: 'ok', count: 1 }) })
  registry.register({ name: 'update_plan', description: 'd', level: 'read', schema: z.object({}), run: () => 'ok' })
  registry.register({ name: 'ask_user', description: 'd', level: 'read', schema: z.object({}), run: () => 'ok' })
  const events = [], seen = []
  const ctl = new AbortController()
  const deps = {
    callModel: async req => { seen.push(req.messages.map(m => ({ ...m }))); const s = script.shift(); if (!s) throw new Error('剧本用完'); return typeof s === 'function' ? s(ctl) : s },
    registry, toolNames: o.toolNames ?? ['lookup'], ctx: { db: null, scene: 'org', roleId: 'ops', sessionId: 's', playbook: () => null, playbookNames: () => [] },
    approve: async () => true, askUser: async () => '', emit: e => events.push(e), signal: ctl.signal, cite: { q: () => false, lesson: () => false, stu: () => false }
  }
  return { run: () => runAgent(deps, { system: 'S', history: [], user: 'Q' }), events, seen, ctl }
}
const rep = (content, toolCalls = []) => ({ content, toolCalls, usage: { promptTokens: 1, completionTokens: 1 } })
const tc = { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }

// 说了要做 → 自动提醒一次 → 模型动手 → 正常结束，没有「没做完」标记
{
  const m = mk([rep('好的，我来帮你查一下。'), rep('', [tc]), rep('查到了。')])
  const r = await m.run()
  assert.equal(r.stop, 'answered'); assert.equal(r.answer, '查到了。'); assert.ok(!r.unfinished)
  assert.equal(m.events.filter(e => e.type === 'nudge').length, 1)
  assert.equal(m.seen[1].at(-1).role, 'user'); assert.match(m.seen[1].at(-1).content, /没有调用任何工具/)
  assert.ok(m.events.some(e => e.type === 'thought'))   // 第一段话保留在对话里
}
// 提醒后还是不做：只提醒一次，答案带「没做完」标记
{
  const m = mk([rep('我来帮你生成看板。'), rep('好的，现在开始生成。')])
  const r = await m.run()
  assert.equal(m.events.filter(e => e.type === 'nudge').length, 1)
  assert.equal(r.stop, 'answered'); assert.equal(r.unfinished, true)
  assert.equal(m.events.find(e => e.type === 'answer').unfinished, true)
}
// 在问用户 / 本轮已经调用过工具 / 角色没有可用工具 / 取消：都不提醒
{
  const q = mk([rep('你想看哪个年级？')]); await q.run(); assert.equal(q.events.filter(e => e.type === 'nudge').length, 0)
  const a = mk([rep('', [tc]), rep('接下来我会再整理一下。')]); const ra = await a.run(); assert.equal(a.events.filter(e => e.type === 'nudge').length, 0); assert.ok(!ra.unfinished)
  const n = mk([rep('我来帮你生成。')], { toolNames: ['update_plan', 'ask_user'] }); const rn = await n.run(); assert.equal(n.events.filter(e => e.type === 'nudge').length, 0); assert.ok(!rn.unfinished)
  const c = mk([ctl => { ctl.abort(); return rep('我来帮你生成。') }]); const rc = await c.run(); assert.equal(c.events.filter(e => e.type === 'nudge').length, 0); assert.ok(!rc.unfinished)
}
console.log('agent-unfinished OK')
