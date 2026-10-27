// B6 / A5 / B8：术语白话表、数字翻成白话、角色引导、总览分组与同比样本不足的判定。
import assert from 'node:assert/strict'
import { GLOSSARY, lookupTerm, findTerms } from '../../src/shared/glossary.ts'
import { appearText, compareText, difficultyText, hotLabel } from '../../src/shared/plain-text.ts'
import { ROLE_GUIDES, HELP_MARKDOWN } from '../../src/shared/roles.ts'
import { insufficientSides, MIN_COMPARE } from '../../src/main/stats/compare-math.ts'
import * as S from '../../src/main/stats/core.ts'
import { newDb, addPaper, useTree } from './helpers/db.mjs'

// ── 术语表：体验报告「看不懂清单」里的词都要有白话释义，且每条都有一句话、没有再套专业词 ──
for (const t of ['出现率', '基线', '目标学年', '综合得分', '置信度', '双向细目表', '向上汇总', '主知识点', '次知识点', '仅次知识点', '按学期对齐', '引入年级', '口径', '个百分点', '样本有限', '样本不足', '新增', '消失', '上升', '下降',
  '易错率', '平均难度', '画线丢失', '位置不确定', 'OCR', 'Base URL', 'API Key', 'tokens', '提示词', '输出长度上限', '并发', 'AI 草稿', '未核实', '疑似重复', '待审核', '个例', '代码']) {
  const g = lookupTerm(t)
  assert.ok(g, `术语表里要有「${t}」`)
  assert.ok(g.plain.length >= 8 && g.plain.length <= 120, `「${t}」的释义长度合适：${g.plain}`)
}
assert.equal(lookupTerm('出现率').term, '考了几份卷子'); assert.equal(lookupTerm('  双向 细目表 ').term, '知识点 × 题型表'); assert.equal(lookupTerm('不存在的词'), undefined)
assert.equal(new Set(GLOSSARY.map(g => g.term)).size, GLOSSARY.length, '词条不重复')
assert.ok(findTerms('出现率和基线都很高').length >= 2)
for (const g of GLOSSARY) assert.ok(!/[|\n]/.test(g.plain + g.term), `${g.term} 不含竖线 / 换行`)

// ── 数字翻成白话（体验报告里点名的写法）──
assert.equal(appearText(2, 2), '两份卷子都考了'); assert.equal(appearText(3, 3), '三份卷子都考了'); assert.equal(appearText(1, 1), '这份卷子考了')
assert.equal(appearText(2, 5), '五份卷子里有两份考了'); assert.equal(appearText(0, 4), '四份卷子都没考'); assert.equal(appearText(0, 0), '没有卷子')
assert.equal(compareText(0, 1, 1, 1), '去年及以前没考，今年考了（今年 1/1 份卷子有）')
assert.equal(compareText(2, 2, 0, 1), '去年及以前考过（2/2 份卷子有），今年没考')
assert.match(compareText(1, 4, 3, 4), /去年及以前 1\/4 份卷子有，今年 3\/4 份有，比例变高了/)
assert.match(compareText(3, 4, 1, 4), /比例变低了/); assert.match(compareText(1, 2, 2, 4), /差不多/)
assert.equal(difficultyText(2.67), '中等偏易'); assert.equal(difficultyText(3), '中等'); assert.equal(difficultyText(null), '—'); assert.equal(difficultyText(4.6), '很难')
// 重难点标签：不再只给「综合得分 0.1007」
assert.equal(hotLabel({ papers: 1, rate: 0.5, share: 0.2, errorRate: 1, avgDifficulty: 4 }, 2, 0.1), '个例', '总份数 ≥ 2 而只在 1 份里出现：个例，不进难点')
assert.equal(hotLabel({ papers: 3, rate: 1, share: 0.2, errorRate: 0.1, avgDifficulty: 2 }, 3, 0.1), '重点')
assert.equal(hotLabel({ papers: 3, rate: 1, share: 0.05, errorRate: 0.8, avgDifficulty: 2 }, 3, 0.1), '难点')
assert.equal(hotLabel({ papers: 3, rate: 1, share: 0.2, errorRate: 0.8, avgDifficulty: 4 }, 3, 0.1), '又重又难')
assert.equal(hotLabel({ papers: 1, rate: 1, share: 0.2, errorRate: 0.8, avgDifficulty: 4 }, 1, 0.1), '又重又难', '只有 1 份卷子时不分个例（界面另有「样本不足」提示）')

// ── 角色引导：两条三步路线，每步有白话 + 跳转路径 ──
assert.deepEqual(ROLE_GUIDES.map(g => g.label), ['我是运营', '我是辅导老师'])
const routes = new Set(['/', '/queue', '/review', '/dashboard', '/report', '/overview', '/settings', '/help'])
for (const g of ROLE_GUIDES) { assert.equal(g.steps.length, 3); for (const s of g.steps) { assert.ok(routes.has(s.path), s.path); assert.ok(s.text.length >= 15 && s.text.length <= 90 && s.cta && s.title) } }
assert.ok(/## 我是运营/.test(HELP_MARKDOWN) && /## 我是辅导老师/.test(HELP_MARKDOWN) && /我已核对/.test(HELP_MARKDOWN) && !/\bM[1-6]\b|里程碑/.test(HELP_MARKDOWN))

// ── B8：样本少不下结论 ──
assert.equal(MIN_COMPARE, 3); assert.deepEqual(insufficientSides(2, 5), ['target']); assert.deepEqual(insufficientSides(3, 2), ['base']); assert.deepEqual(insufficientSides(2, 1), ['target', 'base']); assert.deepEqual(insufficientSides(3, 3), [])
{
  const { db } = newDb()
  useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.2', 'A', '甲二', 2]])
  // 总览：只有 2 份卷子 → Top 10 分成「每份都考 / 只考了一份」
  addPaper(db, { year: 2025, questions: [{ kp: 'A.1' }, { kp: 'A.2' }] })
  addPaper(db, { year: 2025, questions: [{ kp: 'A.1' }] })
  let o = S.overview(db, {})
  assert.ok(o.topGroups, '1–2 份卷子时有分组'); assert.deepEqual(o.topGroups.everyPaper.map(t => t.code), ['A.1']); assert.deepEqual(o.topGroups.somePapers.map(t => t.code), ['A.2'])
  assert.equal(o.top.length, 2, '原来的 Top 10 数据照旧（界面决定怎么显示）')
  for (let i = 0; i < 2; i++) addPaper(db, { year: 2025, questions: [{ kp: 'A.1' }] })
  o = S.overview(db, {}); assert.equal(o.topGroups, null, '≥ 3 份卷子：恢复 Top 10')
  // 同比：两侧各 2 份 → insufficient；3 份 → 不是
  const { db: d2 } = newDb()
  useTree(d2, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.2', 'A', '甲二', 2]])
  for (let i = 0; i < 2; i++) addPaper(d2, { year: 2025, questions: [{ kp: 'A.1' }] })
  for (let i = 0; i < 2; i++) addPaper(d2, { year: 2024, questions: [{ kp: 'A.2' }] })
  let c = S.compare(d2, {}, 2025, { lt: 2025 }, 2)
  assert.deepEqual(c.insufficient, ['target', 'base']); assert.equal(c.added.length, 1, '数据照算，界面和 AI 提示词决定不展开')
  addPaper(d2, { year: 2025, questions: [{ kp: 'A.1' }] }); addPaper(d2, { year: 2024, questions: [{ kp: 'A.2' }] })
  c = S.compare(d2, {}, 2025, { lt: 2025 }, 2); assert.deepEqual(c.insufficient, [])
  assert.deepEqual(S.compare(d2, {}, 2030, { lt: 2030 }, 2).insufficient, [], '一侧没有卷子（empty）时不重复报样本不足')
}
console.log('m6-text.test ✓')
