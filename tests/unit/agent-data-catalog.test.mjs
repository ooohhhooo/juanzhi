// 助手的数据目录工具：试卷清单、课程覆盖、报告列表 / 读报告、翻以前的对话（内存库，结构和应用一致）
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { papersList, courseCoverage, reportsList, reportRead } from '../../src/main/agent/tools/data.ts'
import { historySearch, historyRead } from '../../src/main/agent/tools/builtin.ts'
import { createOutline, applyMatchBatch, targetKps } from '../../src/main/course/store.ts'

const { db } = newDb()
useTree(db, [['GR', null, '语法', 1], ['GR.PAST', 'GR', '一般过去时', 2], ['GR.COMP', 'GR', '比较级', 2], ['GR.PLU', 'GR', '名词复数', 2], ['RD', null, '阅读', 1], ['RD.DET', 'RD', '细节理解', 2]])
const ctx = { db, sessionId: 'now' }

// ── 试卷清单 ──
assert.equal(papersList.run({}, ctx).count, 0)
const P = (title, qs, extra = {}) => addPaper(db, { title, year: 2025, grade: '4', questions: qs, ...extra })
P('四年级期末卷一', [{ kp: 'GR.PAST', err: true, score: 2 }, { kp: 'GR.COMP', score: 2 }, { kp: 'RD.DET', score: 3 }])
P('四年级期末卷二', [{ kp: 'GR.PAST', score: 2 }, { kp: 'GR.COMP', err: true, score: 2 }])
P('四年级期末卷三', [{ kp: 'GR.PAST', score: 2 }, { kp: 'GR.COMP', score: 2 }, { kp: 'GR.PLU', score: 2 }])
P('五年级卷', [{ kp: 'GR.PLU', score: 2 }], { grade: '5', status: 'reviewing' })
const all = papersList.run({}, ctx)
assert.equal(all.count, 4); assert.match(all.text, /已审核 3/); assert.match(all.text, /待审核 1/); assert.match(all.text, /四年级期末卷一/)
assert.equal(papersList.run({ grade: '5' }, ctx).count, 1)
assert.match(papersList.run({ limit: 2 }, ctx).text, /只列最新 2 份/)

// ── 课程覆盖 ──
assert.match(courseCoverage.run({}, ctx).text, /还没有导入/)
const lesson = (seq, title) => ({ seq, noLabel: `第${seq}课`, title, theme: '', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: title }], raw: {} })
const oid = createOutline(db, { name: '示例体系', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '基础级', lessons: [lesson(1, 'Past'), lesson(2, 'Plural')] }] })
const lid = Object.fromEntries(db.prepare('SELECT id, title FROM course_lessons').all().map(r => [r.title, r.id]))
const sigs = new Map(targetKps(db).map(k => [k.code, k.sig]))
const E = (code, title) => ({ code, none: !title, maps: title ? [{ lessonId: lid[title], confidence: 'high', quote: 'q', reason: 'r', quoteOk: true }] : [] })
applyMatchBatch(db, oid, [E('GR.PAST', 'Past'), E('GR.COMP'), E('GR.PLU', 'Plural'), E('RD.DET')], { rev: 1, model: 'm', promptVersion: 'v', sigs })
const cov = courseCoverage.run({}, ctx).text
assert.match(cov, /《示例体系》/); assert.match(cov, /一般过去时/, '有对应课的常考点')
assert.match(cov, /课程缺口[\s\S]*比较级/, '比较级出现在 3 份卷子里但没有对应课')
assert.doesNotMatch(cov.split('课程缺口')[1] ?? '', /一般过去时/)

// ── 报告 ──
assert.match(reportsList.run({}, ctx).text, /还没有生成过报告/)
db.prepare("INSERT INTO reports (id, kind, reader, filter_json, markdown, created_at) VALUES ('r1', 'report', 'parent', ?, ?, '2026-11-01 10:00:00')").run(JSON.stringify({ grade: '4' }), '## 家长版\n孩子要多练过去式。' + '练'.repeat(9000))
const rl = reportsList.run({}, ctx)
assert.equal(rl.count, 1); assert.match(rl.text, /编号 r1｜家长版｜4 年级/); assert.match(rl.text, /AI 草稿/)
const r1 = reportRead.run({ reportId: 'r1', from: 0 }, ctx)
assert.match(r1.text, /孩子要多练过去式/); assert.match(r1.text, /nextFrom=8000/)
assert.match(reportRead.run({ reportId: 'r1', from: 8000 }, ctx).text, /第 8000–/)
assert.match(reportRead.run({ reportId: 'nope', from: 0 }, ctx).text, /找不到/)

// ── 翻以前的对话 ──
const sess = (id, title, turns, at) => {
  db.prepare("INSERT INTO agent_sessions (id, role, scene, title, status, created_at, updated_at) VALUES (?, 'ops', 'org', ?, 'idle', ?, ?)").run(id, title, at, at)
  let seq = 0
  for (const [q, a] of turns) {
    db.prepare("INSERT INTO agent_steps (session_id, seq, kind, payload_json) VALUES (?, ?, 'user', ?)").run(id, ++seq, JSON.stringify({ text: q }))
    if (a) db.prepare("INSERT INTO agent_steps (session_id, seq, kind, payload_json) VALUES (?, ?, 'answer', ?)").run(id, ++seq, JSON.stringify({ text: a }))
  }
}
sess('s-old', '写续费话术', [['帮我写一段续费话术', '话术示例：坚持练习，下学期继续。']], '2026-11-03 09:00:00')
sess('s-other', '退费原因', [['退费原因有哪些', '主要是时间冲突。']], '2026-11-03 10:00:00')
sess('now', '这一次', [['上次的话术呢', null]], '2026-11-04 10:00:00')
const recent = historySearch.run({ query: '' }, ctx)
assert.equal(recent.count, 2, '不列出当前这次对话'); assert.ok(recent.text.indexOf('退费原因') < recent.text.indexOf('写续费话术'), '最近的在前')
const hit = historySearch.run({ query: '话术' }, ctx)
assert.equal(hit.count, 1); assert.match(hit.text, /s-old/); assert.match(hit.text, /坚持练习/)
assert.equal(historySearch.run({ query: '不存在的词' }, ctx).count, 0)
const full = historyRead.run({ sessionId: 's-old' }, ctx)
assert.match(full.text, /用户：帮我写一段续费话术/); assert.match(full.text, /你的回答：话术示例：坚持练习/)
assert.match(historyRead.run({ sessionId: 'nope' }, ctx).text, /找不到/)
console.log('agent-data-catalog.test ✓')
