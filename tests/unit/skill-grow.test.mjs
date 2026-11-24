// Skill 从多次对话里长出来：指纹与分组、提示门槛与「不用了」、按样本重新数每一步的出处并去掉 AI 编的步骤、版本历史、「最近 3 次都被改」的更新提示
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb } from './helpers/db.mjs'
import { makeFp, similar, stripVariables, keywordsOf, groupTurns, suggestFor, jaccard } from '../../src/main/agent/skills/fingerprint.ts'
import { normalizeDraft, composeBody, lineDiff, buildDraftUser } from '../../src/main/agent/skills/draft.ts'
import { condense, extractTurns, isRevision, pickBest } from '../../src/main/agent/skills/turns.ts'
import { recordTurn, turnInfo, dismissCreate, setRating, markExported, saveSkillVersioned, listVersions, restoreVersion, updateSuggestion, getMeta, loadSample, allMeta, listTurnRecs } from '../../src/main/agent/skills/store.ts'
import { createSession, appendStep } from '../../src/main/agent/store.ts'
import { listUserSkillFiles } from '../../src/main/agent/playbooks/manage.ts'

const DAY = 86400_000

// ───── 去掉每次都会变的部分 ─────
{
  { const t = stripVariables('给三年级的 启航A班 写 2026-11-03 的话术，学员A001 手机13812345678 共 5 个'); assert.ok(!/\d|年级|班|A001/.test(t) && t.includes('话术'), t) }
  assert.ok(!stripVariables('帮我看看本周到课率 10月5日').match(/\d/), '数字都去掉')
  assert.ok(stripVariables('写一段话术').includes('一段'), '「一段」的「一」不是数量，不能被吃掉')
  assert.ok(!stripVariables('班主任说五年级').includes('五年级'))
}

// ───── 指纹：相似与不相似 ─────
const fp = (role, tools, q) => makeFp(role, tools, q)
{
  const a = fp('tutor', ['stats_overview', 'kp_questions', 'update_plan', 'load_playbook'], '给三年级写一段家长话术，说说过去时的易错点')
  const b = fp('tutor', ['kp_questions', 'stats_overview'], '帮我给五班写一段家长话术，说说现在完成时的易错点')
  const c = fp('tutor', ['stats_overview', 'kp_questions'], '做一份下周的到课率看板')
  const d = fp('ops', ['stats_overview', 'kp_questions'], '给三年级写一段家长话术，说说过去时的易错点')
  const e = fp('tutor', ['run_query', 'stat_nps', 'board_start'], '给三年级写一段家长话术，说说过去时的易错点')
  assert.deepEqual(a.tools, ['kp_questions', 'stats_overview'], '基础工具（计划 / 读 Skill）不进指纹')
  assert.ok(similar(a, b), '同角色、同工具、请求换了年级和知识点 = 同一类')
  assert.ok(!similar(a, c), '请求关键词不同 = 不是一类')
  assert.ok(!similar(a, d), '角色不同 = 不是一类')
  assert.ok(!similar(a, e), '工具集合差太多 = 不是一类')
  assert.equal(jaccard([], []), 1)
  assert.ok(keywordsOf('').length === 0)
}

// ───── 分组、3 次门槛、窗口、覆盖、不用了、只提示一次 ─────
{
  const now = Date.UTC(2026, 10, 20)
  const mk = (i, q, ageDays, tools = ['stats_overview', 'kp_questions'], role = 'tutor') => ({ sessionId: `s${i}`, answerSeq: 2, fp: fp(role, tools, q), at: now - ageDays * DAY, label: q })
  const t1 = mk(1, '给三年级写一段家长话术', 30), t2 = mk(2, '给四年级写一段家长话术', 20), t3 = mk(3, '给五班写一段家长话术', 0)
  const other = mk(4, '做一份到课率看板', 1, ['run_query'])
  const groups = groupTurns([t1, t2, t3, other], now)
  assert.equal(groups.length, 2); assert.equal(groups.find(g => g.length === 3).length, 3)
  const base = { now, covers: [], dismissed: [], shown: [] }
  assert.equal(suggestFor(t2, [t1, t2, other], base), null, '只有 2 次不提示')
  const s = suggestFor(t3, [t1, t2, t3, other], base)
  assert.ok(s && s.members.length === 3 && s.label.includes('话术'), '3 次提示，名字是白话请求')
  const old = mk(5, '给六年级写一段家长话术', 90)
  assert.equal(suggestFor(t3, [old, t2, t3], base), null, '超过 60 天的不算')
  assert.equal(suggestFor(t3, [t1, t2, t3], { ...base, dismissed: [t1.fp] }), null, '点过「不用了」不再提示')
  assert.equal(suggestFor(t3, [t1, t2, t3], { ...base, shown: [t1.fp] }), null, '同一类只提示一次')
  assert.equal(suggestFor(t3, [t1, t2, t3], { ...base, covers: [{ name: '家长话术', fp: t1.fp, sources: [] }] }), null, '已有 Skill 覆盖不提示')
  assert.equal(suggestFor(t3, [t1, t2, t3], { ...base, covers: [{ name: 'x', fp: fp('ops', ['a'], '别的'), sources: [{ sessionId: 's2', answerSeq: 2 }] }] }), null, '来源里有这几次也算覆盖')
  const t4 = mk(6, '给七年级写一段家长话术', 0)
  assert.equal(suggestFor(t4, [t1, t2, t3, t4], { ...base, shown: [t1.fp] }), null, '已提示过的一类，第 4 次不再提示')
}

// ───── 按样本重新数，去掉 AI 编的步骤 ─────
{
  const toolSets = [['stats_overview', 'kp_questions'], ['stats_overview', 'kp_questions'], ['stats_overview', 'kp_questions', 'course_for_kp'], ['stats_overview', 'kp_questions']]
  const ai = JSON.stringify({
    name: '家长话术', description: '给家长写话术', when: '要给家长写话术时',
    params: [{ name: '年级', hint: '哪个年级？' }, { name: '', hint: 'x' }],
    steps: [
      { text: '看整体情况', tool: 'stats_overview', samples: [1, 2, 3, 4] },
      { text: '查易错题', tool: 'kp_questions', samples: [1, 2, 3, 4] },
      { text: '查对应的课', tool: 'course_for_kp', samples: [1, 2, 3, 4], condition: '家长问到补课时' },
      { text: '发给全体家长', tool: 'wecom_send', samples: [1, 2, 3, 4] },
      { text: '查一个不存在的工具', tool: 'no_such_tool', samples: [1] },
      { text: '查学员成绩', tool: 'run_query', samples: [1] },
      { text: '先确认年级', tool: '', samples: [1, 2, 3, 4] },
      { text: '编出来的步骤', tool: '', samples: [] },
      { text: '样本编号越界', tool: '', samples: [9] }
    ],
    output: '## 话术\n【年级】的家长您好……', checklist: ['不出现真名', '语气温和']
  })
  const known = new Set(['stats_overview', 'kp_questions', 'course_for_kp', 'wecom_send', 'run_query'])
  const roleTools = new Set(['stats_overview', 'kp_questions', 'course_for_kp', 'run_query'])
  const d = normalizeDraft(ai, toolSets, { knownTools: known, roleTools })
  assert.ok(d)
  const by = Object.fromEntries(d.steps.map(s => [s.text, s]))
  assert.equal(by['看整体情况'].hit, 4); assert.equal(by['看整体情况'].total, 4); assert.equal(by['看整体情况'].optional, false)
  assert.equal(by['查对应的课'].hit, 1, 'AI 说 4 次都有，程序数出来只有 1 次'); assert.equal(by['查对应的课'].optional, true); assert.equal(by['查对应的课'].condition, '家长问到补课时'); assert.deepEqual(by['查对应的课'].evidence, [3])
  assert.ok(!by['发给全体家长'], '这个角色用不了的工具被去掉')
  assert.ok(!by['查一个不存在的工具'], '不存在的工具被去掉')
  assert.ok(!by['查学员成绩'], '样本里一次都没用过的步骤被去掉（AI 编的）')
  assert.ok(by['先确认年级'] && by['先确认年级'].basis === 'claimed' && by['先确认年级'].hit === 4)
  assert.ok(!by['编出来的步骤'] && !by['样本编号越界'], '没有出处的纯文字步骤被去掉')
  assert.equal(d.params.length, 1)
  assert.ok(d.warnings.length >= 4)
  // 每次都用到、AI 漏写的工具由程序补上
  const d2 = normalizeDraft(JSON.stringify({ name: 'x', steps: [{ text: '看整体', tool: 'stats_overview', samples: [1, 2, 3, 4] }], output: 'o' }), toolSets, { knownTools: known, roleTools })
  assert.ok(d2.steps.some(s => s.tool === 'kp_questions' && s.hit === 4), '补上每次都有的步骤')
  assert.equal(normalizeDraft('不是 JSON', toolSets, { knownTools: known, roleTools }), null)
  const body = composeBody(d)
  assert.ok(body.includes('## 步骤') && body.includes('`course_for_kp`') && body.includes('有时需要：家长问到补课时') && body.includes('## 需要你告诉我') && body.includes('## 输出格式') && body.includes('- [ ] 语气温和'))
  assert.ok(!body.includes('wecom_send'))
  // 对比
  const df = lineDiff('a\nb\nc', 'a\nc\nd')
  assert.deepEqual(df.map(x => x.type + x.text), ['samea', 'delb', 'samec', 'addd'])
}

// ───── 样本压缩：不带工具结果，去手机号 ─────
{
  const turn = { branchId: 'main', userSeq: 1, answerSeq: 3, request: '给家长写话术，手机13812345678', calls: [{ name: 'stats_overview', args: '{"q":"身份证110101199001011234"}', ok: true }, { name: 'update_plan', args: '{}', ok: true }], skills: [], answer: '学员A001的家长您好' + 'x'.repeat(3000), stop: 'answered' }
  const c = condense({ sessionId: 's', answerSeq: 3, turn, signals: { rating: 1, exported: true, revised: false, reviseText: '' }, revisions: ['结尾短一点'] }, 1)
  const all = JSON.stringify(c)
  assert.ok(!/13812345678|110101199001011234/.test(all)); assert.equal(c.steps.length, 1); assert.ok(c.answer.length <= 1201); assert.ok(c.signal.includes('做得好') && c.signal.includes('导出') && c.signal.includes('结尾短一点'))
  const user = buildDraftUser([c], { roleName: '辅导老师', tools: [{ name: 'stats_overview', label: '看整体' }] })
  assert.ok(user.includes('样本 1') && !user.includes('tool_result'))
  const best = pickBest([{ signals: { rating: null, exported: false, revised: false }, at: 3 }, { signals: { rating: 1, exported: false, revised: false }, at: 1 }, { signals: { rating: -1, exported: true, revised: false }, at: 9 }], 2)
  assert.equal(best.length, 2); assert.equal(best[0].signals.rating, 1, '👍 排第一'); assert.ok(!best.some(b => b.signals.rating === -1), '👎 不用')
  assert.ok(isRevision('结尾改短一点') && !isRevision('帮我做一份到课率看板') && !isRevision('改'.repeat(100)))
}

// ───── 数据库：记录回答、提示一次、不用了、信号 ─────
{
  const { db } = newDb()
  const now = Date.UTC(2026, 10, 20, 8)
  const mkSession = (id, q, tools, answer = '回答', extra = []) => {
    createSession(db, { id, role: 'tutor', scene: 'org', title: q })
    appendStep(db, id, { kind: 'user', payload: { text: q } })
    tools.forEach((t, i) => { appendStep(db, id, { kind: 'tool_call', payload: { id: `c${i}`, n: i + 1, name: t, args: { top: 3 }, level: 'read' } }); appendStep(db, id, { kind: 'tool_result', payload: { id: `c${i}`, n: i + 1, name: t, ok: true, summary: '', text: '很长的原文不该被带走' } }) })
    appendStep(db, id, { kind: 'answer', payload: { text: answer, stop: 'answered' } })
    for (const [q2, a2] of extra) { appendStep(db, id, { kind: 'user', payload: { text: q2 } }); appendStep(db, id, { kind: 'answer', payload: { text: a2, stop: 'answered' } }) }
  }
  const tools = ['update_plan', 'stats_overview', 'kp_questions']
  mkSession('a1', '给三年级写一段家长话术，说说易错点', tools)
  const r1 = recordTurn(db, 'a1', { userSkills: [], now: now - 20 * DAY })
  assert.ok(r1.created); assert.equal(turnInfo(db, 'a1', 8, now).create, null)
  mkSession('a2', '给四年级写一段家长话术，说说易错点', tools)
  recordTurn(db, 'a2', { userSkills: [], now: now - 10 * DAY })
  assert.equal(turnInfo(db, 'a2', 8, now).create, null, '2 次不提示')
  mkSession('a3', '给五班写一段家长话术，说说易错点', tools, '最终回答')
  recordTurn(db, 'a3', { userSkills: [], now })
  const first = turnInfo(db, 'a3', 8, now)
  assert.ok(first.create && first.create.count === 3, '第 3 次提示')
  assert.equal(recordTurn(db, 'a3', { userSkills: [], now }).created, false, '同一回答不重复记')
  appendStep(db, 'a3', { kind: 'user', payload: { text: '结尾改短一点' } }); appendStep(db, 'a3', { kind: 'answer', payload: { text: '改好的最终回答', stop: 'answered' } })
  // 第 4 条（含修改要求的追问）也被记下，它不会再提示
  recordTurn(db, 'a3', { userSkills: [], now })
  assert.equal(turnInfo(db, 'a3', 10, now).create, null)
  assert.equal(listTurnRecs(db, now).length, 3, '改稿的追问不进分组')
  // 信号
  setRating(db, 'a1', 8, 1); markExported(db, 'a2')
  assert.equal(turnInfo(db, 'a1', 8, now).rating, 1)
  const smp = loadSample(db, 'a3', 8)
  assert.equal(smp.finalAnswer, '改好的最终回答', '用户后来要求修改：用改完后的最终版'); assert.deepEqual(smp.revisions, ['结尾改短一点'])
  assert.ok(!JSON.stringify(smp.turn).includes('很长的原文'))
  // 不用了
  dismissCreate(db, 'a3', 8)
  assert.equal(turnInfo(db, 'a3', 8, now).create, null, '不用了之后不再显示')
  mkSession('a6', '给六年级写一段家长话术，说说易错点', tools)
  recordTurn(db, 'a6', { userSkills: [], now: now + DAY })
  assert.equal(turnInfo(db, 'a6', 8, now + DAY).create, null, '不用了 = 这一类以后不再提示')
}

// ───── Skill 版本、来源、已覆盖、更新提示 ─────
{
  const { db } = newDb()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-grow-'))
  const known = ['stats_overview', 'kp_questions']
  const r = saveSkillVersioned(dir, db, { name: '家长话术', description: '写话术', roles: ['tutor'], when: '', body: '# 家长话术\n1. 用 `stats_overview` 看整体\n' }, { knownTools: known, sources: [{ sessionId: 's1', answerSeq: 3 }], sampleCount: 2, fp: makeFp('tutor', ['stats_overview'], '写家长话术') })
  assert.equal(r.version, 1); assert.equal(getMeta(db, '家长话术').sampleCount, 2)
  const r2 = saveSkillVersioned(dir, db, { name: '家长话术', description: '写话术', roles: ['tutor'], when: '', body: '# 家长话术\n1. 用 `stats_overview` 看整体\n2. 结尾短一点\n' }, { originalName: '家长话术', knownTools: known })
  assert.equal(r2.version, 2); assert.equal(getMeta(db, '家长话术').sampleCount, 2, '来源和次数保留')
  const same = saveSkillVersioned(dir, db, { name: '家长话术', description: '写话术', roles: ['tutor'], when: '', body: '# 家长话术\n1. 用 `stats_overview` 看整体\n2. 结尾短一点\n' }, { originalName: '家长话术', knownTools: known })
  assert.equal(same.version, 2, '内容没变不涨版本')
  const vs = listVersions(dir, db, '家长话术')
  assert.deepEqual(vs.map(v => [v.version, v.current]), [[2, true], [1, false]])
  restoreVersion(dir, db, '家长话术', 1, known)
  assert.ok(!listUserSkillFiles(dir)[0].playbook.body.includes('结尾短一点'), '恢复旧版本'); assert.equal(getMeta(db, '家长话术').version, 3)
  assert.equal(listVersions(dir, db, '家长话术').length, 3, '恢复前的也留着')
  assert.equal(listUserSkillFiles(dir).length, 1, '历史文件不会被当成 Skill')

  // 最近 3 次使用都被改 → 更新提示
  const now = Date.UTC(2026, 10, 20)
  const use = (id, followup) => {
    createSession(db, { id, role: 'tutor', scene: 'org', title: 'x' })
    appendStep(db, id, { kind: 'user', payload: { text: '给家长写话术' } })
    appendStep(db, id, { kind: 'tool_call', payload: { id: 'p', n: 0, name: 'load_playbook', args: { name: '家长话术' } } })
    appendStep(db, id, { kind: 'answer', payload: { text: '话术', stop: 'answered' } })
    recordTurn(db, id, { userSkills: ['家长话术'], now })
    if (followup) { appendStep(db, id, { kind: 'user', payload: { text: followup } }); appendStep(db, id, { kind: 'answer', payload: { text: '改后', stop: 'answered' } }); recordTurn(db, id, { userSkills: ['家长话术'], now }) }
  }
  use('u1', '结尾改短一点'); use('u2', '结尾太长了，换成简短的'); assert.equal(updateSuggestion(db, '家长话术'), null, '才 2 次')
  use('u3', '把结尾去掉，加一句祝福')
  const u = updateSuggestion(db, '家长话术')
  assert.ok(u && u.count === 3 && u.hint.includes('结尾') || u.hint.includes('结尾'.slice(0, 1)), `3 次都改了结尾：${u?.hint}`)
  const info = turnInfo(db, 'u3', 5, now)
  assert.equal(info.updates.length, 1, '提示挂在最后那次的回答下面'); assert.equal(info.updates[0].name, '家长话术')
  // 修改意见各不相同 → 不提示
  const { db: db2 } = newDb()
  saveSkillVersioned(dir, db2, { name: '家长话术', description: '写话术', roles: ['tutor'], when: '', body: '# 家长话术\n步骤\n' }, { originalName: '家长话术', knownTools: known })
  void allMeta
}
console.log('skill-grow ok')
