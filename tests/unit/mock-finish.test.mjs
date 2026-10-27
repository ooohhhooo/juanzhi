// mock P3（E2E 用的假 AI）的输出 → finishReport：确认程序侧收尾在「四个版本 × 常见毛病」下的结果，和 E2E 里的断言一致
// （E2E 里 AI 是 mock；这里不起浏览器，直接把 mock 的文字送进 finishReport，快、能在改核对规则时立刻发现回归）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { newDb, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import * as P2 from '../../src/main/stats/p2.ts'
import * as P3 from '../../src/main/stats/p3.ts'
import { paperScope } from '../../src/main/stats/filter.ts'
import { collectEvidence } from '../../src/main/stats/evidence.ts'
import { finishReport } from '../../src/main/report/finish.ts'
import { confirmBlockReason } from '../../src/shared/report-post.ts'
const require = createRequire(import.meta.url)
const mock = require('../mock-ai/p3.cjs')

const { db } = newDb()
const mk = (year, qs) => addPaper(db, { year, grade: '4', title: `${year}学年期末卷${qs.length}`, questions: qs, status: 'done' })
mk(2024, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', stem: "It's time ____ breakfast.", score: 2, difficulty: 3 }, { no: 2, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: 'sheep 单复数同形，易误加 -s', score: 2, difficulty: 3 }, { no: 3, kp: 'GR.NOUN.PLURAL', err: false, score: 2, difficulty: 2 }])
mk(2025, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', score: 2, difficulty: 3 }, { no: 2, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: 'sheep 单复数同形，易误加 -s', score: 2, difficulty: 4 }, { no: 3, kp: 'FN.SHOP', err: false, score: 3, difficulty: 2 }])
mk(2025, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', score: 2, difficulty: 3 }, { no: 2, kp: 'GR.TENSE.PAST', err: false, score: 2, difficulty: 3 }, { no: 3, kp: 'FN.SHOP', err: false, score: 3, difficulty: 2 }])
const f = {}
const ev = collectEvidence(db, paperScope(f), {})
const base = { filter: f, dist: S.distribution(db, f), hot: S.hot(db, f, 2, 30, undefined, false), cmp: S.compare(db, f, 2025, { lt: 2025 }, 2, 0, true), years: [2024, 2025], distinctGrades: 1, distinctExamTypes: 1, evidence: ev }
const inp = P3.buildP3Input(base)
const userOf = id => P2.fillTemplate(fs.readFileSync(`src/main/ai/prompts/${id}.user.txt`, 'utf8').replace(/\s+$/, ''), inp.placeholders)
const sysOf = id => fs.readFileSync(`src/main/ai/prompts/${id}.system.txt`, 'utf8')
const run = (id, reader, quirks) => {
  const raw = mock.build(userOf(id), quirks, sysOf(id))
  return { raw, fin: finishReport({ raw, reader, title: '标题', knownRefs: new Set(inp.refs.map(r => r.token)), knownCodes: ['GR', 'FN', 'PH', 'GR.PREP.COLLOC', 'GR.NOUN.PLURAL', 'PH_DIFF'], sampleWarning: inp.placeholders.SAMPLE_WARNING, evidence: ev.statements, usedDefaultPrompt: true }) }
}

// 完整数据版：mock 写反 time for / time to + 编一条证据里没有的规则 → 恰好 1 句矛盾 + 1 句未核实（E2E 断言「有 2 句」）；其余句子不被误标
{
  const { fin } = run('p3_report', 'full', { echoCodes: true, backtick: true, wrongRule: true, inventRule: true })
  assert.deepEqual(fin.unverified.map(u => u.kind).sort(), ['conflict', 'unverified'], JSON.stringify(fin.unverified))
  assert.ok(fin.unverified.some(u => u.kind === 'conflict' && /time for/.test(u.sentence)) && fin.unverified.some(u => u.kind === 'unverified' && /be good at/.test(u.sentence)))
}
// 没毛病的完整版 / 老师版 / 老板版：不应该有任何「未核实」（mock 的文字都取自输入）
for (const [id, reader] of [['p3_report', 'full'], ['p3_teacher', 'teacher'], ['p3_boss', 'boss']]) {
  const { fin } = run(id, reader, {})
  assert.deepEqual(fin.unverified, [], `${reader}：没毛病的输出不该被标：${JSON.stringify(fin.unverified)}`)
}
// 家长版：统计词 + 写反的规则 → 删干净、可以核对；正文够长
{
  const { fin } = run('p3_parent', 'parent', { parentStats: true, wrongRule: true })
  assert.ok(!/%|出现率|占比/.test(fin.text) && !/It's time for 后接动词/.test(fin.text))
  assert.ok(fin.warnings.some(w => /已从家长版里删掉/.test(w)) && fin.warnings.some(w => /统计词或百分比/.test(w)))
  assert.equal(confirmBlockReason({ reader: 'parent', markdown: fin.text, unverified: fin.unverified }), null, '删完仍可核对')
  assert.deepEqual(fin.unverified, [], 'mock 的家长版里没有「未核实」句子：E2E 里点「我已核对」不需要逐句确认')
}
console.log('mock-finish.test ✓')
