// 助手的运行模式（直接回答 / 先出计划 / 自动完成）、自动整理（压缩）与 session_state、对话分支、自定义角色、思考强度映射、上下文上限。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AiError } from '../../src/main/ai/client.ts'
import { runAgent } from '../../src/main/agent/harness.ts'
import { ToolRegistry } from '../../src/main/agent/registry.ts'
import { BUILTIN_TOOLS } from '../../src/main/agent/tools/builtin.ts'
import { SUMMARY_MARK } from '../../src/main/agent/context.ts'
import { PLAN_APPROVE } from '../../src/main/agent/types.ts'
import { createSession, appendStep, getSession, pathTo, leafOf, branchesOf, deriveState, historyMessages, newBranchId } from '../../src/main/agent/store.ts'
import { CustomRoleSchema, toRoleDef, readCustomRoles, saveCustomRole, deleteCustomRole, parseRoleFile, exportRoleText, newRoleId } from '../../src/main/agent/custom-roles.ts'
import { effortBody, availableEfforts, canTurnOff, effortHint, judgeEffortProbe, probeEffort, effortProbeKey, ADAPTERS } from '../../src/main/agent/reasoning.ts'
import { contextLimitFor, clipOrgContext, ORG_CONTEXT_MAX, DEFAULT_CONTEXT_LIMIT } from '../../src/main/agent/limits.ts'
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts'
import { getRole, BASE_TOOLS } from '../../src/main/agent/roles.ts'
import { newDb } from './helpers/db.mjs'

const call = (name, args, id) => ({ id: id ?? `c_${name}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (content, toolCalls = [], usage = { promptTokens: 100, completionTokens: 20 }) => ({ content, toolCalls, usage })
const plan = items => ({ items: items.map(([content, status]) => ({ content, status })) })

function build(script, o = {}) {
  const registry = new ToolRegistry()
  for (const t of BUILTIN_TOOLS) registry.register(t)
  registry.register({ name: 'overview', label: '概况', level: 'read', planSafe: true, description: '概况', schema: z.object({}), run: () => ({ text: '概况：3 份卷子', count: 3 }) })
  registry.register({ name: 'detail', label: '明细', level: 'read', description: '明细', schema: z.object({ k: z.string().default('x') }), run: a => ({ text: '明细 ' + a.k + '长'.repeat(o.detailChars ?? 10), count: 5 }) })
  const seen = []
  const events = []
  const ctl = new AbortController()
  const asks = []
  const deps = {
    callModel: async req => { seen.push({ messages: req.messages.map(m => ({ ...m })), tools: req.tools.map(t => t.function.name) }); const s = script.shift(); if (!s) throw new Error('剧本用完了'); return typeof s === 'function' ? s(req) : s },
    registry, toolNames: registry.names(), mode: o.mode,
    ctx: { db: null, scene: 'org', roleId: 'ops', sessionId: 's', playbook: () => null, playbookNames: () => [] },
    approve: async () => true,
    askUser: o.askUser ?? (async r => { asks.push(r); return PLAN_APPROVE }),
    emit: e => events.push(e), signal: ctl.signal, cite: { q: () => true, lesson: () => true, stu: () => false },
    budget: o.budget, compact: o.compact, initialState: o.initialState
  }
  return { run: (text = '问') => runAgent(deps, { system: 'SYS', history: o.history ?? [], user: text }), seen, events, asks, ctl, registry }
}
const evs = (events, t) => events.filter(e => e.type === t)
const results = events => evs(events, 'tool_result')

// ───────── 先出计划（默认）：确认前除概况类工具外，程序层面禁用 ─────────
{
  const s = build([
    reply('', [call('detail', {}, 'd0')]),                                                     // 计划阶段想直接查明细：被程序拒绝
    reply('', [call('overview', {}, 'o1'), call('update_plan', plan([['看概况', 'done'], ['查明细', 'todo']]), 'p1')]),
    reply('', [call('detail', {}, 'd1')]),                                                      // 用户确认之后：可以了
    reply('完成')
  ], { mode: 'plan' })
  const r = await s.run()
  assert.equal(r.stop, 'answered')
  assert.deepEqual(s.seen[0].tools.sort(), ['ask_user', 'load_playbook', 'overview', 'session_state', 'update_plan'], '计划阶段发给模型的工具清单里没有 detail')
  const res = results(s.events)
  assert.equal(res[0].name, 'detail'); assert.equal(res[0].ok, false); assert.match(res[0].text, /先出计划/, '就算模型硬调，程序也拒绝执行')
  assert.equal(res[1].ok, true)   // overview 可用
  const ask = evs(s.events, 'ask').find(a => a.planReview)
  assert.ok(ask, '计划写好后暂停，向用户确认'); assert.deepEqual(ask.options, [PLAN_APPROVE])
  assert.ok(s.seen[2].tools.includes('detail'), '确认后工具放开')
  assert.equal(res.find(x => x.name === 'detail' && x.ok)?.ok, true)
  assert.ok(s.seen[2].messages.some(m => m.role === 'user' && /用户确认了计划/.test(m.content)))
  // 暂停期间 detail 真的没被执行过（第一次被拒，ok:false）
  assert.equal(res.filter(x => x.name === 'detail').length, 2)
}
// 修改计划：给了意见 → 仍在计划阶段，工具仍被禁用，直到确认
{
  let n = 0
  const s = build([
    reply('', [call('update_plan', plan([['甲', 'todo']]), 'p1')]),
    reply('', [call('update_plan', plan([['乙', 'todo']]), 'p2')]),
    reply('', [call('detail', {}, 'd')]),
    reply('好')
  ], { mode: 'plan', askUser: async r => (++n === 1 ? '第一步改成乙' : PLAN_APPROVE) })
  const r = await s.run()
  assert.equal(r.stop, 'answered'); assert.equal(n, 2)
  assert.ok(s.seen[1].messages.some(m => m.role === 'user' && /用户想修改计划：第一步改成乙/.test(m.content)))
  assert.ok(!s.seen[1].tools.includes('detail') && s.seen[2].tools.includes('detail'))
  assert.deepEqual(r.plan.map(p => p.content), ['乙'])
}
// 直接问 / 没写计划就答：不暂停
{
  const s = build([reply('一句话就能答')], { mode: 'plan' })
  const r = await s.run(); assert.equal(r.stop, 'answered'); assert.equal(s.asks.length, 0)
  // 计划阶段停止（等确认时点停止）
  const s2 = build([reply('', [call('update_plan', plan([['甲', 'todo']]))])], { mode: 'plan', askUser: () => new Promise(() => {}) })
  setTimeout(() => s2.ctl.abort(), 20)
  assert.equal((await s2.run()).stop, 'stopped')
}

// ───────── 直接回答：最多 5 轮、不写计划 ─────────
{
  const script = Array.from({ length: 9 }, (_, i) => reply('', [call('detail', { k: 'k' + i })]))
  const s = build(script, { mode: 'direct' })
  const r = await s.run()
  assert.equal(r.stop, 'rounds'); assert.equal(r.rounds, 5); assert.ok(!s.seen[0].tools.includes('update_plan'), '直接回答模式不提供 update_plan')
  const s2 = build([reply('', [call('update_plan', plan([['甲', 'todo']]), 'x')]), reply('好')], { mode: 'direct' })
  await s2.run()
  assert.match(results(s2.events)[0].text, /直接回答/); assert.equal(evs(s2.events, 'plan').length, 0, '程序层面不会生效')
  assert.equal(s2.asks.length, 0)
}

// ───────── 自动完成：不暂停，计划照常，详细工具一开始就能用 ─────────
{
  const s = build([reply('', [call('update_plan', plan([['甲', 'doing']]), 'a'), call('detail', {}, 'b')]), reply('完')], { mode: 'auto' })
  const r = await s.run()
  assert.equal(r.stop, 'answered'); assert.equal(s.asks.length, 0); assert.ok(s.seen[0].tools.includes('detail'))
  assert.equal(results(s.events).every(x => x.ok), true)
}
// 没写 mode 的老调用 = 自动完成
{
  const s = build([reply('', [call('detail', {}, 'b')]), reply('完')])
  assert.equal((await s.run()).stop, 'answered'); assert.equal(s.asks.length, 0)
}

// ───────── 系统提示：模式、机构说明、默认剧本 ─────────
{
  const role = { ...getRole('ops'), defaultPlaybook: '学情周报' }
  const sp = buildSystemPrompt({ role, scene: 'org', playbooks: [{ name: '学情周报', description: 'd', roles: [], when: '', body: 'b', source: 'builtin' }], today: 'x', mode: 'plan', orgContext: '我们把一级叫“启蒙”' })
  assert.match(sp, /先出计划/); assert.match(sp, /机构说明/); assert.match(sp, /启蒙/); assert.match(sp, /默认做法.*学情周报/)
  assert.match(buildSystemPrompt({ role: getRole('ops'), scene: 'org', playbooks: [], today: 'x', mode: 'direct' }), /直接回答/)
  assert.ok(!/机构说明/.test(buildSystemPrompt({ role: getRole('ops'), scene: 'org', playbooks: [], today: 'x' })))
}

// ───────── 自动整理：到上限约 70% 触发；计划和查询编号压缩后仍可取回；AI 摘要失败兜底 ─────────
{
  const mk = n => Array.from({ length: n }, (_, i) => reply('', [call('detail', { k: 'q' + i }, 'q' + i)]))
  // 触发：limit 取小，让对话估算很快超过 70%
  const s = build([reply('', [call('update_plan', plan([['查很多', 'doing']]), 'pl')]), ...mk(6), reply('', [call('session_state', { query: 2 }, 'ss')]), reply('总结')],
    { mode: 'auto', detailChars: 1500, compact: { limitTokens: 4000, summarize: async text => { assert.match(text, /调用 /); return '摘要：已查 #1 #2 #3，结论是甲。' } } })
  const r = await s.run('开始')
  assert.equal(r.stop, 'answered')
  const compacted = evs(s.events, 'compacted')
  assert.ok(compacted.length >= 1 && compacted[0].by === 'ai', '到阈值触发了整理（AI 摘要）')
  assert.match(compacted[0].summary, /摘要：已查 #1/); assert.match(compacted[0].summary, /查询 #\d+ detail/, 'AI 摘要后面附上程序生成的查询索引，编号不丢')
  const afterMsgs = s.seen.at(-1).messages
  assert.ok(afterMsgs.some(m => typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARK)), '较早的内容换成了摘要')
  assert.equal(afterMsgs[0].role, 'system'); assert.equal(afterMsgs[1].content, '开始', '系统提示和当前提问保留')
  const keptRounds = afterMsgs.filter(m => m.role === 'assistant' && m.tool_calls).length
  assert.ok(keptRounds <= 5 && keptRounds >= 3, `最近几轮完整保留：${keptRounds}`)
  // 压缩后用 session_state 取回：计划、编号、某次查询的原文
  const st = results(s.events).at(-1)
  assert.equal(st.name, 'session_state'); assert.ok(st.ok); assert.match(st.text, /明细 q1/, '按编号取回早已被整理掉的那次查询的完整结果')
  // 不带参数：计划 + 全部编号
  const s2 = build([reply('', [call('update_plan', plan([['步骤甲', 'doing']]), 'a')]), reply('', [call('detail', { k: 'z' }, 'b')]), reply('', [call('ask_user', { question: '看哪个级别', options: ['一', '二'] }, 'c')]), reply('', [call('session_state', {}, 'd')]), reply('完')], { mode: 'auto', askUser: async () => '二' })
  await s2.run()
  const txt = results(s2.events).at(-1).text
  assert.match(txt, /步骤甲/); assert.match(txt, /查询 #1 detail/); assert.match(txt, /看哪个级别 → 二/)
  assert.ok(!/查询 #\d+ (update_plan|ask_user|session_state)/.test(txt), '计划 / 提问 / 取回本身不占查询编号')
}
// AI 摘要失败 → 程序生成的摘要
{
  const script = [reply('先看', [call('detail', { k: '0' }, 'a0')]), ...Array.from({ length: 6 }, (_, i) => reply('', [call('detail', { k: String(i + 1) }, 'a' + (i + 1))])), reply('总结')]
  const s = build(script, { mode: 'auto', detailChars: 1500, compact: { limitTokens: 4000, summarize: async () => { throw new AiError('timeout', '超时') } } })
  const r = await s.run('开始')
  assert.equal(r.stop, 'answered')
  const c = evs(s.events, 'compacted')[0]
  assert.equal(c.by, 'program'); assert.match(c.summary, /查询 #1 detail/); assert.match(c.summary, /助手之前说过：先看/)
  // 没提供 summarize 也一样；没配置 compact 时完全不整理（旧行为）
  const s2 = build([...Array.from({ length: 6 }, (_, i) => reply('', [call('detail', { k: String(i) })])), reply('完')], { mode: 'auto', detailChars: 1500, compact: { limitTokens: 4000 } })
  await s2.run(); assert.equal(evs(s2.events, 'compacted')[0].by, 'program')
  const s3 = build([...Array.from({ length: 6 }, (_, i) => reply('', [call('detail', { k: String(i) })])), reply('完')], { mode: 'auto', detailChars: 1500 })
  await s3.run(); assert.equal(evs(s3.events, 'compacted').length, 0)
  // 没有可整理的（不到 4 轮）：不动
  const s4 = build([reply('', [call('detail', {})]), reply('', [call('detail', { k: 'y' })]), reply('完')], { mode: 'auto', detailChars: 3000, compact: { limitTokens: 1000 } })
  await s4.run(); assert.equal(evs(s4.events, 'compacted').length, 0)
  // 接着追问：initialState 里的查询编号接着往下排，session_state 能取回以前的
  const s5 = build([reply('', [call('detail', { k: 'new' }, 'n1')]), reply('', [call('session_state', { query: 7 }, 'n2')]), reply('完')], {
    mode: 'auto', initialState: { plan: [], choices: [], queries: [{ n: 7, id: 'old', name: 'detail', args: '{}', ok: true, note: '5 条', text: '以前的结果原文' }] }
  })
  await s5.run()
  assert.equal(evs(s5.events, 'tool_call')[0].n, 8); assert.match(results(s5.events)[1].text, /以前的结果原文/)
}

// ───────── 对话分支：上下文只含路径节点；共享状态在分支间可见 ─────────
{
  const { db } = newDb()
  createSession(db, { id: 's', role: 'ops', scene: 'org', title: 't' })
  const A = (kind, payload, extra = {}) => appendStep(db, 's', { kind, payload, ...extra })
  const u1 = A('user', { text: '问题1' }); A('tool_call', { id: 't1', n: 1, name: 'detail', args: { k: 1 } }); A('tool_result', { id: 't1', n: 1, ok: true, summary: '5 条', text: '结果一' })
  A('ask', { id: 'a1', question: '看哪级', options: ['一', '二'], answer: '二' }); A('plan', { items: [{ content: '主线计划', status: 'doing' }] })
  const ans1 = A('answer', { text: '回答1' })
  const u2 = A('user', { text: '问题2（主线）' }); const ans2 = A('answer', { text: '回答2' })
  // 从「回答1」分支追问
  const b = newBranchId()
  const bu = A('user', { text: '分支问题' }, { branchId: b, parentId: ans1 })
  A('tool_call', { id: 't2', n: 2, name: 'detail', args: { k: 2 } }, { branchId: b }); A('tool_result', { id: 't2', n: 2, ok: true, summary: '3 条', text: '结果二' }, { branchId: b })
  A('plan', { items: [{ content: '分支计划', status: 'todo' }] }, { branchId: b })
  const bans = A('answer', { text: '分支回答' }, { branchId: b })
  const g = getSession(db, 's')
  const steps = g.steps
  assert.equal(steps.find(s => s.seq === bu).parentId, ans1); assert.equal(steps.find(s => s.seq === bu).branchId, b)
  assert.equal(steps.find(s => s.seq === u2).parentId, ans1, '主线下一个问题挂在上一条回答下面'); assert.equal(steps.find(s => s.seq === u2).branchId, 'main')
  // 分支路径：根 → 回答1 → 分支问题 → ... ；没有主线的问题2/回答2
  const path = pathTo(steps, leafOf(steps, b).seq)
  assert.deepEqual(path.map(s => s.seq).slice(0, 7), [u1, 2, 3, 4, 5, ans1, bu].slice(0, 7))
  assert.ok(!path.some(s => s.seq === u2 || s.seq === ans2), '兄弟分支（主线后面的内容）不在路径里')
  const hist = historyMessages(pathTo(steps, ans1))
  assert.deepEqual(hist.map(m => m.content), ['问题1', '回答1'], '从回答1 分支追问时，上下文只有路径上的问答')
  assert.deepEqual(historyMessages(pathTo(steps, leafOf(steps, b).seq)).map(m => m.content), ['问题1', '回答1', '分支问题', '分支回答'])
  assert.deepEqual(historyMessages(pathTo(steps, ans2)).map(m => m.content), ['问题1', '回答1', '问题2（主线）', '回答2'], '主线不含分支内容')
  // 共享状态：查询记录（含分支里的 #2）、提问选择在两条线上都可见；计划按路径
  const stMain = deriveState(steps, pathTo(steps, ans2)), stBranch = deriveState(steps, pathTo(steps, bans))
  assert.deepEqual(stMain.queries.map(q => q.n), [1, 2]); assert.deepEqual(stBranch.queries.map(q => q.n), [1, 2])
  assert.equal(stMain.queries[1].text, '结果二'); assert.deepEqual(stBranch.choices, [{ question: '看哪级', answer: '二' }]); assert.deepEqual(stMain.choices, stBranch.choices)
  assert.equal(stMain.plan[0].content, '主线计划'); assert.equal(stBranch.plan[0].content, '分支计划', '计划跟着路径走')
  // 接着分支追问：初始状态带着所有分支的查询编号（下一次编号是 3）
  const st = deriveState(steps, pathTo(steps, bans))
  const s = build([reply('', [call('detail', { k: 'n' }, 'n')]), reply('完')], { mode: 'auto', initialState: st, history: hist })
  await s.run('继续分支'); assert.equal(evs(s.events, 'tool_call')[0].n, 3)
  assert.deepEqual(branchesOf(steps).map(x => [x.id === 'main' ? 'main' : 'b', x.fromSeq]), [['main', null], ['b', ans1]])
  // 删除会话级联；分支列在 migration 里
  const cols = db.prepare('PRAGMA table_info(agent_steps)').all().map(c => c.name)
  assert.ok(cols.includes('parent_id') && cols.includes('branch_id'))
}

// ───────── 自定义角色：存取、导入导出、工具过滤 ─────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-roles-'))
  const taken = new Set()
  const id = newRoleId(taken)
  const role = CustomRoleSchema.parse({ id, name: '班主任助理', description: '关心出勤', tools: ['stats_overview'], suggestions: ['问题一', '问题二'], defaultPlaybook: '学情周报', notes: '级别叫启蒙' })
  saveCustomRole(dir, role)
  assert.deepEqual(readCustomRoles(dir).map(r => r.name), ['班主任助理'])
  const def = toRoleDef(role)
  assert.equal(def.custom, true); assert.deepEqual(def.names, { org: '班主任助理', school: '班主任助理' })
  for (const t of BASE_TOOLS) assert.ok(def.tools.includes(t), '基础工具总是有'); assert.ok(def.tools.includes('stats_overview') && !def.tools.includes('kp_questions'))
  assert.deepEqual(def.rules, ['级别叫启蒙']); assert.equal(def.defaultPlaybook, '学情周报')
  // 导出再导入：id 重新生成，未知工具去掉
  const text = exportRoleText(role).replace('"stats_overview"', '"stats_overview", "not_a_tool", "kp_questions"')
  const known = new Set(['stats_overview', 'kp_questions', 'course_for_kp'])
  const imp = parseRoleFile(text, known, new Set([id]))
  assert.ok(imp.ok); assert.notEqual(imp.role.id, id); assert.deepEqual(imp.role.tools, ['stats_overview', 'kp_questions']); assert.equal(imp.droppedTools, 1); assert.equal(imp.role.name, '班主任助理')
  saveCustomRole(dir, imp.role); assert.equal(readCustomRoles(dir).length, 2)
  assert.equal(parseRoleFile('不是json', known, new Set()).ok, false)
  assert.equal(parseRoleFile('{"role":{"name":""}}', known, new Set()).ok, false)
  assert.equal(parseRoleFile('{"name":"x","tools":["update_plan"]}', known, new Set()).role.tools.length, 0, '基础工具不重复算')
  assert.throws(() => CustomRoleSchema.parse({ ...role, id: '../evil' }), '角色 id 不能带路径')
  assert.equal(deleteCustomRole(dir, '../x'), false)
  assert.equal(deleteCustomRole(dir, id), true); assert.equal(readCustomRoles(dir).length, 1)
  // 坏文件、点开头的文件跳过
  fs.writeFileSync(path.join(dir, 'bad.json'), 'xx'); fs.writeFileSync(path.join(dir, '._x.json'), 'xx')
  assert.equal(readCustomRoles(dir).length, 1)
  assert.equal(CustomRoleSchema.safeParse({ ...role, suggestions: ['1', '2', '3', '4', '5'] }).success, false, '推荐问题最多 4 个')
}

// ───────── 思考强度：参数映射、「关」的提示、不支持就隐藏 ─────────
{
  const url = 'https://api.example.com/v1'
  assert.deepEqual(effortBody('low', url, 'm'), { reasoning_effort: 'low' }); assert.deepEqual(effortBody('high', url, 'm'), { reasoning_effort: 'high' })
  assert.deepEqual(effortBody('medium', url, 'm'), { reasoning_effort: 'medium' })
  assert.deepEqual(effortBody('auto', url, 'm'), {}); assert.deepEqual(effortBody('off', url, 'm'), {}, '自动和关都不发推理参数')
  assert.deepEqual(ADAPTERS, [], '没有已确认的特殊服务商，不硬编码猜测')
  // 适配表：命中的服务商用自己的参数
  assert.deepEqual(effortBody('low', 'https://x.test', 'special-1', [{ id: 't', match: (h, m) => h === 'x.test' && m.startsWith('special'), params: e => ({ thinking: { effort: e } }) }]), { thinking: { effort: 'low' } })
  assert.deepEqual(effortBody('low', 'https://y.test', 'special-1', [{ id: 't', match: h => h === 'x.test', params: () => ({}) }]), { reasoning_effort: 'low' })
  assert.deepEqual(availableEfforts(false), ['auto', 'off']); assert.deepEqual(availableEfforts(true), ['auto', 'off', 'low', 'medium', 'high']); assert.deepEqual(availableEfforts(null), ['auto', 'off', 'low', 'medium', 'high'])
  assert.equal(canTurnOff('gpt-4o-mini'), true); assert.equal(canTurnOff('deepseek-v4-pro'), false, '默认就思考的模型关不掉')
  assert.match(effortHint('off', 'deepseek-v4-pro'), /无法真正关闭/); assert.match(effortHint('off', 'gpt-4o-mini'), /不使用思考/); assert.match(effortHint('high', 'm'), /越慢、用量越大/)
  assert.equal(judgeEffortProbe(null), 'supported'); assert.equal(judgeEffortProbe({ code: 'bad_request', status: 400 }), 'unsupported'); assert.equal(judgeEffortProbe({ code: 'auth', status: 401 }), 'unknown'); assert.equal(judgeEffortProbe({ code: 'network' }), 'unknown')
  const base = { baseUrl: url, apiKey: 'k', model: 'm' }
  let sent
  assert.equal(await probeEffort(base, async r => { sent = r; return {} }), 'supported'); assert.deepEqual(sent.extraBody, { reasoning_effort: 'low' })
  assert.equal(await probeEffort(base, async () => { throw new AiError('bad_request', 'x', 400, "unknown parameter: 'reasoning_effort'") }), 'unsupported')
  assert.equal(await probeEffort(base, async () => { throw new AiError('auth', 'x', 401) }), 'unknown', '密钥无效不下结论')
  assert.equal(await probeEffort(base, async () => { throw new AiError('truncated', 'x') }), 'supported')
  assert.equal(effortProbeKey('https://a.com/', ' m '), 'agent_effort_support:https://a.com|m')
}

// ───────── 上下文上限与机构说明 ─────────
{
  assert.equal(contextLimitFor('some-unknown-model'), DEFAULT_CONTEXT_LIMIT); assert.equal(DEFAULT_CONTEXT_LIMIT, 64000)
  assert.equal(contextLimitFor('deepseek-v4-pro'), 64000); assert.equal(contextLimitFor('gpt-4o-mini'), 128000); assert.equal(contextLimitFor('claude-x'), 200000)
  assert.equal(contextLimitFor('deepseek-v4-pro', 32000), 32000, '设置里改过的优先'); assert.equal(contextLimitFor('m', 10), 8000, '太小的值拉回下限')
  const c = clipOrgContext('甲'.repeat(ORG_CONTEXT_MAX + 50)); assert.equal(c.text.length, ORG_CONTEXT_MAX); assert.equal(c.clipped, true)
  assert.equal(clipOrgContext('  短说明  ').text, '短说明'); assert.equal(clipOrgContext('x').clipped, false)
}

// ───────── 审批模式：只有「导出到本机」可以免问，对外发送 / 没标明的写操作永远要同意 ─────────
{
  const runWith = async (approvalMode, effect) => {
    const ran = [], asked = []
    const registry = new ToolRegistry()
    registry.register({ name: 'doit', label: '写', level: 'write', ...(effect ? { effect } : {}), description: 'd', schema: z.object({}), describe: () => '做一件事', run: () => { ran.push(1); return '好' } })
    const script = [reply('', [call('doit', {}, 'w')]), reply('完')]
    const deps = {
      callModel: async () => script.shift(), registry, toolNames: ['doit'], approvalMode,
      ctx: { db: null, scene: 'org', roleId: 'ops', sessionId: 's', playbook: () => null, playbookNames: () => [], state: () => ({}) },
      approve: async r => { asked.push(r.name); return true }, askUser: async () => '', emit: () => {}, signal: new AbortController().signal, cite: { q: () => true, lesson: () => true, stu: () => false }
    }
    await runAgent(deps, { system: 's', history: [], user: 'u' })
    return { ran: ran.length, asked: asked.length }
  }
  assert.deepEqual(await runWith('ask-all', 'export'), { ran: 1, asked: 1 }, '每次询问：导出也要问')
  assert.deepEqual(await runWith('ask-external', 'export'), { ran: 1, asked: 0 }, '只问对外发送：导出到本机不再问')
  assert.deepEqual(await runWith('ask-external', 'external'), { ran: 1, asked: 1 }, '对外发送永远问')
  assert.deepEqual(await runWith('ask-external', undefined), { ran: 1, asked: 1 }, '没标明性质的写操作按对外发送处理')
  assert.deepEqual(await runWith('never', 'external'), { ran: 1, asked: 1 }, '没有「完全不问」：不认识的审批模式一律照问')
  assert.deepEqual(await runWith(undefined, 'export'), { ran: 1, asked: 1 }, '默认每次询问')
}

console.log('agent-modes.test ✓')
