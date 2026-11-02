// 老师版 v3 整条链路（不起 Electron）：真实的统计 → ERROR_ITEMS → mock AI 的主文 / 口诀 / 变形题 / 独立解答 → 程序收尾与拼装。
// 和 E2E 里的断言口径一致，但快，改核对规则时立刻能发现回归。
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
import { CORE_PART_METAS, assembleReport } from '../../src/main/report/parts.ts'
import { buildErrorsSection, buildTricksSection, buildVariantsSection } from '../../src/main/report/teacher-sections.ts'
import { parseCheckAnswers, sameAnswer, validateVariants } from '../../src/main/report/variants-check.ts'
import { checkRules } from '../../src/shared/factcheck.ts'
import { parseBlocks } from '../../src/shared/markdown.ts'
const require = createRequire(import.meta.url)
const mock3 = require('../mock-ai/p3.cjs')
const mock4 = require('../mock-ai/p4.cjs')

const { db } = newDb()
const mk = (year, qs) => addPaper(db, { year, grade: '4', title: `${year}学年期末卷${qs.length}`, questions: qs, status: 'done' })
mk(2024, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', stem: "It's time ____ breakfast.", score: 2, difficulty: 3 }, { no: 2, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: 'sheep 单复数同形，易误加 -s', score: 2, difficulty: 3 }])
mk(2025, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', score: 2, difficulty: 3 }, { no: 2, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: 'sheep 单复数同形，易误加 -s', score: 2, difficulty: 4 }])
mk(2025, [{ no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', score: 2, difficulty: 3 }, { no: 2, kp: 'FN.SHOP', err: false, score: 3, difficulty: 2 }])
const f = {}
const ev = collectEvidence(db, paperScope(f), {})
const base = { filter: f, dist: S.distribution(db, f), hot: S.hot(db, f, 2, 30, undefined, false), cmp: S.compare(db, f, 2025, { lt: 2025 }, 2, 0, true), years: [2024, 2025], distinctGrades: 1, distinctExamTypes: 1, evidence: ev }
const inp = P3.buildP3Input(base)
const fill = (id, extra = {}) => P2.fillTemplate(fs.readFileSync(`src/main/ai/prompts/${id}.user.txt`, 'utf8').replace(/\s+$/, ''), { ...inp.placeholders, ...extra })
const sys = id => fs.readFileSync(`src/main/ai/prompts/${id}.system.txt`, 'utf8')
const kps = ev.kps.map(k => ({ code: k.code, name: k.name, plain: k.plain, example_en: k.example_en, example_zh: k.example_zh, hint_words: k.hint_words }))
const finish = (raw) => finishReport({ raw, reader: 'teacher', title: '标题', knownRefs: new Set(inp.refs.map(r => r.token)), knownCodes: ['GR', 'FN', 'PH', 'GR.PREP.COLLOC', 'GR.NOUN.PLURAL'], sampleWarning: inp.placeholders.SAMPLE_WARNING, evidence: ev.statements, usedDefaultPrompt: true, evidenceKps: kps })

// ── 易错点结构化：与 ERROR_ITEMS 同一批；样本题 token 都在引用索引里 ──
assert.ok(inp.errorItems.length >= 2)
assert.equal(inp.placeholders.ERROR_ITEMS.split('\n').length, inp.errorItems.length)
for (const it of inp.errorItems) for (const q of it.questions) assert.ok(inp.refs.some(r => r.token === q.token), `${q.token} 在引用索引里`)
assert.ok(inp.errorItems.every(i => i.questions.length <= 2), '每个易错点最多 2 道样本题')

// ── 主文（老师版 v3）：只有做题方法 + 学习进步建议，没有任何“未核实”，最后一节齐全 ──
const mainRaw = mock3.build(fill('p3_teacher'), {}, sys('p3_teacher'))
const main = finish(mainRaw)
assert.ok(/^## 做题方法$/m.test(main.text) && /^## 学习进步建议$/m.test(main.text) && !/易错点（按重要程度排序）/.test(main.text))
assert.deepEqual(main.unverified, [])
assert.ok(!main.warnings.some(w => /最后一节/.test(w)), main.warnings.join('|'))
assert.equal((main.text.match(/^### \d+\. /gm) ?? []).length, inp.errorItems.length, '做题方法逐个易错点写')
// 缺了最后一节 → 提示内容可能不完整（旧版“备课建议”也算最后一节）
assert.ok(finish(mock3.build(fill('p3_teacher'), { noAdvice: true }, sys('p3_teacher'))).warnings.some(w => /学习进步建议/.test(w)))
assert.ok(!finishReport({ raw: '## 备课建议\n1. 练。', reader: 'teacher', title: 't', knownRefs: new Set(), knownCodes: [], sampleWarning: '无', evidence: [], usedDefaultPrompt: true }).warnings.some(w => /最后一节/.test(w)), '自定义的旧版结构仍认')
// 价格 / 夸大的说法整句去掉
const over = finish(mock3.build(fill('p3_teacher'), { overclaim: true }, sys('p3_teacher')))
assert.ok(!/报名|保证/.test(over.text) && over.warnings.some(w => /价格 \/ 夸大.*已删掉：「.*报名/.test(w)), over.text + over.warnings.join('|'))
// 模型自己写的引用：不在索引里的被移除
assert.ok(!finish(mock3.build(fill('p3_teacher'), { badCite: true }, sys('p3_teacher'))).text.includes('不存在的卷'))

// ── 口诀：mock 写口诀 → 程序拼卡片；例句取自证据 ──
const trickRaw = mock4.buildTricks(fill('p3_tricks'))
const tricks = buildTricksSection(trickRaw, inp.errorItems, kps)
assert.equal(tricks.cards, inp.errorItems.length)
assert.deepEqual(checkRules(tricks.markdown, ev.statements), [], '口诀卡没有未核实的规则句')
assert.ok(buildTricksSection(mock4.buildTricks(fill('p3_tricks'), { trickPrice: true }), inp.errorItems, kps).cards === inp.errorItems.length - 1, '价格口诀被去掉一条')
assert.equal(buildTricksSection(mock4.buildTricks(fill('p3_tricks'), { trickNone: true }), inp.errorItems, kps).cards, 0, '全部不合格 → 0 张（这一段会失败）')

// ── 变形题：出题（不含原题原文）→ 程序校验 → 独立解答 ──
const kpRows = inp.errorItems.slice(0, 3).map((it, i) => [i + 1, it.name, '白话', '词', '例句', it.qtypes.join('、')].join(' | '))
const genUser = fill('p4_variant_gen', { VARIANT_KPS: kpRows.join('\n') })
for (const stem of ["It's time ____ breakfast."]) assert.ok(!genUser.includes(stem), '出题的输入里没有原卷题干')
const genRaw = mock4.buildVariants(genUser)
const originals = ["It's time ____ breakfast. for to at on"]
const v = validateVariants(genRaw, { kpCodes: inp.errorItems.slice(0, 3).map(i => i.code), originals, vocab: new Set(), max: 3 })
assert.equal(v.error, null); assert.equal(v.variants.filter(x => x.problems.length === 0).length, 3)
const qText = v.variants.map((x, i) => `${i + 1}. ${x.stem}` + (x.qtype === 'choice' ? '\n' + x.options.map((o, k) => `${'ABCD'[k]}. ${o}`).join('\n') : '')).join('\n\n')
const second = parseCheckAnswers(mock4.buildCheck(P2.fillTemplate(fs.readFileSync('src/main/ai/prompts/p4_variant_check.user.txt', 'utf8').replace(/\s+$/, ''), { QUESTIONS: qText })))
assert.deepEqual(v.variants.map((x, i) => sameAnswer(x, second.get(i + 1))), [true, true, true], '程序调整过选项顺序后，独立解答仍然能对上')
const dis = parseCheckAnswers(mock4.buildCheck(`【题目】\n${qText}\n`, { variantDisagree: 2 }))
assert.deepEqual(v.variants.map((x, i) => sameAnswer(x, dis.get(i + 1))), [true, false, true], '第 2 题的第二次解答不一致 → 答案有争议')
assert.equal(validateVariants(mock4.buildVariants(genUser, { variantDup: true }), { kpCodes: ['a'], originals: [], vocab: new Set(), max: 3 }).variants.filter(x => x.problems.length === 0).length, 2)
assert.ok(validateVariants(mock4.buildVariants(genUser, { variantPrice: true }), { kpCodes: ['a'], originals: [], vocab: new Set(), max: 3 }).variants[0].problems.length > 0)
assert.ok(validateVariants(mock4.buildVariants(genUser, { variantBadJson: true }), { kpCodes: ['a'], originals: [], vocab: new Set(), max: 3 }).error)
// 讲解里不属于证据的规则句 → 未核实
assert.ok(checkRules(JSON.parse(mock4.buildVariants(genUser, { variantRule: true })).questions[0].explanation, ev.statements).length > 0)
assert.deepEqual(checkRules(JSON.parse(genRaw).questions.map(q => q.explanation).join('。'), ev.statements), [], '默认讲解没有规则句')

// ── 整份拼装：易错题集用到的引用都在 refs 里；答题卡只含勾了的题 ──
const errors = buildErrorsSection(inp.errorItems, kps)
const rows = v.variants.map(x => ({ id: 'v' + x.seq, seq: x.seq, kp_code: x.kp_code, qtype: x.qtype, stem: x.stem, options: x.options, answer: x.answer, explanation: x.explanation, changed: '', status: 'checked', teacher_ok: x.seq !== 2 }))
const md = assembleReport(main.text, [{ id: 'errors', status: 'ok', markdown: errors }, { id: 'tricks', status: 'ok', markdown: tricks.markdown }, { id: 'variants', status: 'ok', markdown: buildVariantsSection(rows, () => '考点') }], CORE_PART_METAS)
assert.deepEqual(md.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3)), ['易错题集（AI 估计）', '易错知识点', '做题方法', '3 道同类变形题', '学习进步建议'])
const blocks = parseBlocks(md)
assert.equal(blocks.filter(b => b.type === 'card' && b.kind === 'trick').length, inp.errorItems.length)
assert.equal(blocks.find(b => b.type === 'card' && b.kind === 'answercard').items.length, 2, '没勾的第 2 题不进答题卡')
for (const it of inp.errorItems) for (const q of it.questions) assert.ok(md.includes(q.token), '易错题集里引用了样本题')
assert.deepEqual(checkRules(md.replace(/::: [^\n]*\n/g, ''), ev.statements).filter(x => x.kind === 'conflict'), [], '整份报告没有和证据矛盾的句子')

console.log('teacher-parts.test ✓')
