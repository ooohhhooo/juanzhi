// 助手的零件：zod→JSON Schema、工具注册表、客户端的工具调用（流式 / 非流式）、支持检测、角色、剧本、会话记录（v12）、只读数据工具。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { chat, parseToolCalls } from '../../src/main/ai/client.ts'
import { toJsonSchema } from '../../src/main/agent/schema.ts'
import { ToolRegistry } from '../../src/main/agent/registry.ts'
import { createRegistry } from '../../src/main/agent/tools/index.ts'
import { probeToolSupport, probeKey } from '../../src/main/agent/probe.ts'
import { ROLES, enabledRoles, getRole, roleName } from '../../src/main/agent/roles.ts'
import { parsePlaybook, readPlaybookDir, mergePlaybooks, playbooksForRole, playbookCatalog } from '../../src/main/agent/playbooks.ts'
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts'
import { createSession, appendStep, getSession, listSessions, historyMessages, eventToStep, updateStepPayload, updateSession, deleteSession, makeCiteChecker, currentDataRev } from '../../src/main/agent/store.ts'
import { estimateTokens } from '../../src/main/agent/context.ts'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { createOutline, applyMatchBatch, targetKps } from '../../src/main/course/store.ts'
import { kpQuestions, statsOverview, courseForKp, factCheck, resolveKp } from '../../src/main/agent/tools/data.ts'

// ───── zod → JSON Schema ─────
{
  const s = toJsonSchema(z.object({
    kp: z.string().min(1).max(80).describe('知识点'), limit: z.number().int().min(1).max(20).default(8), grade: z.enum(['1', '2']).optional(),
    items: z.array(z.object({ c: z.string(), st: z.enum(['a', 'b']) })).min(1).max(12), flag: z.boolean().default(true), n: z.number().nullable().optional()
  }))
  assert.equal(s.type, 'object'); assert.deepEqual(s.required, ['kp', 'items'], '有默认值 / 可选的不算必填')
  assert.deepEqual(s.properties.kp, { type: 'string', minLength: 1, maxLength: 80, description: '知识点' })
  assert.deepEqual(s.properties.limit, { type: 'integer', minimum: 1, maximum: 20, default: 8 })
  assert.deepEqual(s.properties.grade, { type: 'string', enum: ['1', '2'] })
  assert.equal(s.properties.items.minItems, 1); assert.equal(s.properties.items.maxItems, 12); assert.deepEqual(s.properties.items.items.required, ['c', 'st'])
  assert.deepEqual(s.properties.n.type, ['number', 'null']); assert.equal(s.additionalProperties, false)
}

// ───── 注册表 ─────
{
  const r = createRegistry()
  assert.deepEqual(r.names().sort(), ['ask_user', 'course_for_kp', 'fact_check', 'kp_questions', 'load_playbook', 'session_state', 'stats_overview', 'update_plan'])
  const specs = r.specs(['update_plan', 'nope'])
  assert.equal(specs.length, 1); assert.equal(specs[0].type, 'function'); assert.equal(specs[0].function.name, 'update_plan'); assert.equal(specs[0].function.parameters.type, 'object')
  assert.throws(() => r.register(r.get('update_plan')), /重名/)
  assert.throws(() => new ToolRegistry().register({ name: 'Bad Name', description: '', schema: z.object({}), level: 'read', run: () => '' }), /不合法/)
  assert.deepEqual(r.parseArgs('stats_overview', '').ok, true, '空参数 = 全默认')
  const bad = r.parseArgs('kp_questions', '{"limit":50}')
  assert.equal(bad.ok, false); assert.match(bad.error, /kp/)
  for (const t of ['update_plan', 'ask_user', 'load_playbook', 'session_state', 'stats_overview', 'kp_questions', 'course_for_kp', 'fact_check']) assert.equal(r.get(t).level, 'read')
  // 所有角色用到的工具都已注册
  for (const role of ROLES) for (const t of role.tools) assert.ok(r.get(t), `${role.id} 用了未注册的工具 ${t}`)
}

// ───── 客户端：工具调用（请求体 / 非流式 / 流式拼接 / 空内容但有工具调用不算 empty） ─────
{
  const calls = []
  const mk = script => async (url, init) => {
    calls.push(JSON.parse(init.body))
    const step = script.shift()
    if (step.sse) {
      const enc = new TextEncoder()
      return new Response(new ReadableStream({ start(c) { for (const x of step.sse) c.enqueue(enc.encode(x)); c.close() } }), { status: 200 })
    }
    return new Response(JSON.stringify(step.json), { status: 200 })
  }
  const tools = [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }]
  const base = { baseUrl: 'https://x/v1', apiKey: 'sk-t', model: 'm', backoffMs: 1, timeoutMs: 2000 }
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '结果' }]
  const f1 = mk([{ json: { model: 'm', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2 } } }])
  const r1 = await chat({ ...base, fetchImpl: f1, messages: msgs, tools, toolChoice: 'auto' })
  assert.equal(r1.content, ''); assert.equal(r1.toolCalls.length, 1); assert.equal(r1.toolCalls[0].function.arguments, '{"a":1}'); assert.equal(r1.finishReason, 'tool_calls')
  assert.deepEqual(calls[0].tools, tools); assert.equal(calls[0].tool_choice, 'auto'); assert.equal(calls[0].messages[1].tool_calls[0].id, 'c1'); assert.equal(calls[0].messages[2].tool_call_id, 'c1')
  // 不给 tools 时请求体里没有 tools / tool_choice
  const f2 = mk([{ json: { model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }])
  await chat({ ...base, fetchImpl: f2, messages: [{ role: 'user', content: 'x' }] })
  assert.ok(!('tools' in calls[1]) && !('tool_choice' in calls[1]))
  // 流式：arguments 分多块，id/name 只在第一块；两个并行调用按 index 拼
  const sse = [
    { choices: [{ delta: { content: '先' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a1', type: 'function', function: { name: 'f', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'a2', function: { name: 'g', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }
  ].map(o => `data: ${JSON.stringify(o)}\n\n`).concat(['data: [DONE]\n\n'])
  const deltas = []
  const r3 = await chat({ ...base, fetchImpl: mk([{ sse }]), messages: msgs, tools, stream: true, onDelta: t => deltas.push(t) })
  assert.deepEqual(r3.toolCalls.map(t => [t.id, t.function.name, t.function.arguments]), [['a1', 'f', '{"x":1}'], ['a2', 'g', '{}']])
  assert.equal(r3.content, '先'); assert.deepEqual(deltas, ['先']); assert.equal(r3.usage.promptTokens, 9)
  assert.deepEqual(parseToolCalls([{ function: { name: '' } }, { function: { name: 'z', arguments: { a: 1 } } }]).map(t => t.function.arguments), ['{"a":1}'])
  assert.deepEqual(parseToolCalls('x'), [])
}

// ───── 工具支持检测 ─────
{
  const ok = { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'ping', arguments: '{"word":"ok"}' } }], usage: {} }
  const base = { baseUrl: 'https://x', apiKey: 'k', model: 'm' }
  assert.deepEqual(await probeToolSupport(base, async req => { assert.equal(req.tools[0].function.name, 'ping'); return ok }), { supported: true, reason: 'ok' })
  assert.equal((await probeToolSupport(base, async () => ({ content: '好的，ok', toolCalls: [], usage: {} }))).reason, 'no_tool_calls')
  const { AiError } = await import('../../src/main/ai/client.ts')
  assert.equal((await probeToolSupport(base, async () => { throw new AiError('bad_request', 'x', 400, 'tools is not supported') })).reason, 'rejected')
  await assert.rejects(probeToolSupport(base, async () => { throw new AiError('auth', '密钥无效', 401) }), /密钥无效/, '和工具无关的错误原样抛出，不当成不支持')
  assert.equal(probeKey('https://a.com/v1/', ' m '), 'agent_tool_support:https://a.com/v1|m')
}

// ───── 角色 ─────
{
  assert.deepEqual(enabledRoles().map(r => r.id), ['ops', 'tutor'])
  const ops = getRole('ops'), tutor = getRole('tutor')
  assert.deepEqual([roleName(ops, 'org'), roleName(ops, 'school'), roleName(tutor, 'org'), roleName(tutor, 'school')], ['运营', '教务/年级主任', '辅导老师', '班主任'])
  assert.deepEqual([roleName(getRole('research'), 'org'), roleName(getRole('research'), 'school'), roleName(getRole('teacher'), 'org'), roleName(getRole('teacher'), 'school')], ['教研', '教研组长', '授课老师', '任课老师'])
  for (const r of enabledRoles()) { assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 5); assert.ok(r.persona.length > 10) }
  assert.ok(getRole('research').enabled === false && getRole('teacher').enabled === false)
}

// ───── 剧本 ─────
{
  const text = '---\nname: 测试剧本\ndescription: 一句话说明\nroles: [ops, tutor]\nwhen: 要做测试时\n---\n# 正文\n步骤'
  const p = parsePlaybook(text, 'user')
  assert.deepEqual([p.name, p.description, p.roles, p.when, p.body, p.source], ['测试剧本', '一句话说明', ['ops', 'tutor'], '要做测试时', '# 正文\n步骤', 'user'])
  assert.equal(parsePlaybook('没有 frontmatter', 'user'), null); assert.equal(parsePlaybook('---\nname: a\n---\nx', 'user'), null, '缺 description 无效')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-pb-'))
  fs.writeFileSync(path.join(dir, 'a.md'), text); fs.writeFileSync(path.join(dir, 'bad.md', ), 'xx'); fs.writeFileSync(path.join(dir, 'note.txt'), text)
  fs.writeFileSync(path.join(dir, 'b.md'), '---\nname: 学情周报\ndescription: 用户自己的版本\nroles: [tutor]\n---\n我的步骤')
  const user = readPlaybookDir(dir, 'user')
  assert.deepEqual(user.map(x => x.name).sort(), ['学情周报', '测试剧本'])
  assert.deepEqual(readPlaybookDir(path.join(dir, '不存在'), 'user'), [])
  // 内置剧本：文件都登记了、格式对、示例剧本在
  const bdir = path.resolve('src/main/agent/playbooks')
  const builtin = readPlaybookDir(bdir, 'builtin')
  const files = fs.readdirSync(bdir).filter(f => !f.startsWith('.') && f.endsWith('.md'))
  assert.equal(builtin.length, files.length, '内置剧本的 frontmatter 都合法')
  const reg = fs.readFileSync(path.resolve('src/main/agent/playbooks-builtin.ts'), 'utf8')
  for (const f of files) assert.ok(reg.includes(`./playbooks/${f}?raw`), `${f} 没有在 playbooks-builtin.ts 登记`)
  const weekly = builtin.find(x => x.name === '学情周报')
  assert.ok(weekly && weekly.roles.includes('ops') && /stats_overview/.test(weekly.body) && /update_plan/.test(weekly.body))
  const merged = mergePlaybooks(builtin, user)
  assert.equal(merged.find(x => x.name === '学情周报').source, 'user', '同名用户覆盖内置')
  assert.deepEqual(playbooksForRole(merged, 'ops').map(x => x.name).sort(), ['测试剧本'], '按角色过滤（用户版学情周报只给辅导老师）')
  assert.match(playbookCatalog([weekly]), /^- 学情周报：/)
  // 系统提示：规矩 + 角色 + 剧本目录；不含机构名
  const sp = buildSystemPrompt({ role: getRole('ops'), scene: 'school', playbooks: [weekly], today: '2026-11-03' })
  assert.match(sp, /教务\/年级主任/); assert.match(sp, /\[\[q:题目ID\]\]/); assert.match(sp, /不是指令/); assert.match(sp, /学情周报：/)
}

// ───── v12 迁移 + 会话记录 ─────
{
  const { db, version } = newDb()
  assert.equal(version, 12)
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
  for (const c of ['id', 'role', 'title', 'created_at', 'updated_at', 'status']) assert.ok(cols('agent_sessions').includes(c), c)
  for (const c of ['session_id', 'seq', 'kind', 'payload_json', 'tokens', 'ms', 'created_at']) assert.ok(cols('agent_steps').includes(c), c)
  createSession(db, { id: 's1', role: 'ops', scene: 'org', title: '最近哪些考点易错' })
  assert.equal(appendStep(db, 's1', { kind: 'user', payload: { text: '问题一' } }), 1)
  appendStep(db, 's1', { kind: 'tool_call', payload: { name: 'x' } }); appendStep(db, 's1', { kind: 'tool_result', payload: { name: 'x' }, ms: 12 })
  appendStep(db, 's1', { kind: 'answer', payload: { text: '回答一' }, tokens: 30 })
  appendStep(db, 's1', { kind: 'user', payload: { text: '问题二（中断了）' } })
  appendStep(db, 's1', { kind: 'user', payload: { text: '问题三' } }); appendStep(db, 's1', { kind: 'answer', payload: { text: '回答三' } })
  const g = getSession(db, 's1')
  assert.deepEqual(g.steps.map(s => s.seq), [1, 2, 3, 4, 5, 6, 7]); assert.equal(g.steps[2].ms, 12); assert.equal(g.session.stale, false)
  assert.deepEqual(historyMessages(g.steps), [{ role: 'user', content: '问题一' }, { role: 'assistant', content: '回答一' }, { role: 'user', content: '问题三' }, { role: 'assistant', content: '回答三' }], '没有回答的轮次不进历史，相邻 user 不会出现')
  assert.equal(historyMessages(g.steps, 1).length, 2)
  // 数据变了：data_rev 与当前不同 → stale
  updateSession(db, 's1', { dataRev: currentDataRev(db), addIn: 10, addOut: 5, status: 'idle' })
  assert.equal(listSessions(db)[0].stale, false)
  addPaper(db, { title: '新卷', questions: [{ kp: 'X' }] })
  assert.equal(getSession(db, 's1').session.stale, true); assert.equal(listSessions(db)[0].stale, true)
  assert.equal(getSession(db, 's1').session.tokensIn, 10)
  // 更新某一步（ask 被回答）
  appendStep(db, 's1', { kind: 'ask', payload: { id: 'a', question: 'q', answer: null } }); updateStepPayload(db, 's1', 8, { answer: '四年级' })
  assert.equal(getSession(db, 's1').steps.at(-1).payload.answer, '四年级')
  // 事件 → 步骤
  assert.deepEqual(eventToStep({ type: 'plan', items: [] }), { kind: 'plan', payload: { items: [] } }); assert.equal(eventToStep({ type: 'delta', text: 'x' }), null); assert.equal(eventToStep({ type: 'progress', rounds: 1, tokensIn: 1, tokensOut: 1 }), null)
  assert.equal(eventToStep({ type: 'error', code: 'balance', message: 'm' }).kind, 'error')
  // 删除会话级联删步骤
  assert.equal(deleteSession(db, 's1'), true); assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_steps').get().c, 0); assert.equal(getSession(db, 's1'), null)
}

// ───── 只读数据工具（内存库 + 虚构夹具） ─────
{
  const { db } = newDb()
  useTree(db, [['GR', null, '语法', 1], ['GR.PAST', 'GR', '一般过去时', 2], ['GR.PAST.REG', 'GR.PAST', '规则变化', 3], ['GR.PLU', 'GR', '名词复数', 2], ['RD', null, '阅读', 1], ['RD.DET', 'RD', '细节理解', 2]])
  db.prepare("UPDATE kps SET plain = ? WHERE code = 'GR.PAST'").run('说过去发生的事')
  const P = (title, grade, qs) => addPaper(db, { title, year: 2025, grade, questions: qs })
  P('四年级期末卷', '4', [{ id: 'qa', kp: 'GR.PAST.REG', err: true, reason: '忘了加 ed', stem: 'Yesterday I ___ football.', no: 3 }, { id: 'qb', kp: 'GR.PLU', stem: '名词复数题' }, { kp: 'RD.DET' }])
  P('四年级期中卷', '4', [{ id: 'qc', kp: 'GR.PAST', err: true, reason: '不规则动词记混', stem: '过去式题' }, { kp: 'GR.PLU' }, { kp: 'RD.DET' }])
  P('五年级卷', '5', [{ id: 'qd', kp: 'RD.DET', stem: '五年级的阅读题' }])
  addPaper(db, { title: '没审核的卷', status: 'reviewing', grade: '4', questions: [{ id: 'qe', kp: 'GR.PAST', stem: '待审核的题' }] })
  const ctx = { db, scene: 'org', roleId: 'ops', sessionId: 's', signal: new AbortController().signal, setPlan() {}, ask: async () => '', playbook: () => null, playbookNames: () => [] }
  const run = async (tool, args) => { const p = tool.schema.parse(args); const o = await tool.run(p, ctx); return typeof o === 'string' ? { text: o } : o }

  assert.deepEqual(resolveKp(db, 'GR.PAST').map(k => k.code), ['GR.PAST']); assert.deepEqual(resolveKp(db, '一般过去时').map(k => k.code), ['GR.PAST']); assert.equal(resolveKp(db, '不存在的东西').length, 0)

  const o = await run(statsOverview, {})
  assert.match(o.text, /卷子 3 份，题目 7 道/, '只算已审核的'); assert.match(o.text, /最常考的知识点/); assert.match(o.text, /细节理解（代码 RD\.DET）：出现在 3\/3 份/)
  assert.match(o.text, /一般过去时（代码 GR\.PAST）：2\/2 道题易错/); assert.match(o.text, /忘了加 ed/)
  assert.match((await run(statsOverview, { grade: '5' })).text, /卷子 1 份/)
  assert.match((await run(statsOverview, { grade: '3' })).text, /还没有可以统计的试卷/)
  assert.match((await run(statsOverview, { include_reviewing: true })).text, /卷子 4 份/)
  assert.throws(() => statsOverview.schema.parse({ grade: '9' }))

  const k = await run(kpQuestions, { kp: '一般过去时' })
  assert.match(k.text, /\[\[q:qa\]\]/); assert.match(k.text, /\[\[q:qc\]\]/); assert.ok(!k.text.includes('qe'), '待审核的卷不在内'); assert.match(k.text, /第 3 题/); assert.match(k.text, /易错：忘了加 ed/); assert.equal(k.count, 2)
  assert.match((await run(kpQuestions, { kp: 'GR.PAST', limit: 1 })).text, /还有更多题没有列出/)
  assert.match((await run(kpQuestions, { kp: '没有这个点' })).text, /没有找到叫「没有这个点」的知识点/)
  assert.match((await run(kpQuestions, { kp: '细节理解', grade: '5' })).text, /\[\[q:qd\]\]/)
  assert.match((await run(kpQuestions, { kp: '名词复数', grade: '5' })).text, /没有考「名词复数」的题/)

  // 课程：没有大纲 → 说明；有匹配 → 列课；低把握 / 未匹配 → 不列
  assert.match((await run(courseForKp, { kp: '一般过去时' })).text, /还没有导入/)
  const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
  const oid = createOutline(db, { name: '示例体系', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '基础级', lessons: [lesson(1, '过去时入门'), lesson(2, '复数')] }] })
  const lid = Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons').all().map(r => [r.title, r.id]))
  const sigs = new Map(targetKps(db).map(x => [x.code, x.sig]))
  applyMatchBatch(db, oid, [{ code: 'GR.PAST', none: false, maps: [{ lessonId: lid['过去时入门'], confidence: 'high', quote: 'q', reason: '讲规则变化', quoteOk: true }] }, { code: 'GR.PLU', none: false, maps: [{ lessonId: lid['复数'], confidence: 'low', quote: 'q', reason: 'r', quoteOk: true }] }], { rev: 1, model: 'm', promptVersion: 'v', sigs })
  const c1 = await run(courseForKp, { kp: '一般过去时' })
  assert.match(c1.text, new RegExp(`\\[\\[lesson:${lid['过去时入门']}\\]\\]`)); assert.match(c1.text, /示例体系 \/ 基础级/); assert.equal(c1.count, 1)
  assert.match((await run(courseForKp, { kp: '名词复数' })).text, /没有找到对应的课|暂时没有对应的课/, '低把握不算')

  // 引用校验器：真实 ID
  const chk = makeCiteChecker(db)
  assert.ok(chk.q('qa') && !chk.q('不存在') && chk.lesson(String(lid['复数'])) && !chk.lesson('99999') && !chk.lesson('abc') && !chk.stu('A1'))
  assert.ok(makeCiteChecker(db, { stu: id => id === 'A1' }).stu('A1'), '后续接入学员数据时可注入')

  // fact_check：无依据 / 不含规则句 都不报错
  const fc = await run(factCheck, { text: '今天天气不错。' })
  assert.match(fc.text, /没有发现/)
  const fc2 = await run(factCheck, { text: 'It\'s time for 后接动词。' })
  assert.ok(typeof fc2.text === 'string' && fc2.text.length > 0)
}

assert.ok(estimateTokens('你好世界') < estimateTokens('你好世界'.repeat(10)))
console.log('agent-parts.test ✓')
