// mock 的 P2 应答自检：能识别真实的 P2 提示词，输出的结构、数字、引用 token 都来自输入（模型不自己算数）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import * as P from '../../src/main/stats/p2.ts'
import { paperScope } from '../../src/main/stats/filter.ts'
import { CITATION_RE, stripUnknownCitations } from '../../src/shared/citation.ts'
import { headingCodes } from '../../src/shared/markdown.ts'
const require = createRequire(import.meta.url)
const p2 = require('../mock-ai/p2.cjs')

const sys = fs.readFileSync('src/main/ai/prompts/p2_yoy.system.txt', 'utf8')
const userTpl = fs.readFileSync('src/main/ai/prompts/p2_yoy.user.txt', 'utf8')
const p1sys = fs.readFileSync('src/main/ai/prompts/p1_text.system.txt', 'utf8')

const { db } = newDb()
useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.2', 'A', '甲二', 2], ['D', null, '丁', 1], ['D.1', 'D', '丁一', 2], ['E', null, '戊', 1], ['E.1', 'E', '戊一', 2]])
const mk = (year, kps) => addPaper(db, { year, title: `${year}卷${kps.join('')}`, questions: kps.map(k => ({ kp: k, score: 2 })) })
for (const k of [['A.1', 'A.2'], ['A.1', 'E.1'], ['A.2'], ['E.1'], ['A.2', 'E.1']]) mk(2024, k)
for (const k of [['A.1'], ['A.1'], ['A.1', 'D.1'], ['A.1'], ['A.1', 'A.2']]) mk(2025, k)
const cmp = S.compare(db, {}, 2025, { lt: 2025 }, 2)
const inp = P.buildP2Input(cmp, S.hot(db, {}, 2, 15, paperScope({}, { in: [2025, 2024] })), {})
const user = P.fillTemplate(userTpl.replace(/\s+$/, ''), inp.placeholders)

assert.ok(p2.isP2(sys, user), '识别真实的 P2 提示词')
assert.ok(!p2.isP2(p1sys, '【KNOWLEDGE_TREE】 知识点树'), '不会把 P1 当成 P2')
assert.ok(!user.includes('{{'))

const md = p2.build(user, {})
// 结构：五个固定章节，新增知识点用「### 代码｜名称」
for (const h of ['## 一、总体变化', '## 二、新增知识点', '## 三、消失与下降的知识点', '## 四、高频考点与易错预警', '## 五、下学期教学与复习建议']) assert.ok(md.includes(h), h)
assert.deepEqual(headingCodes(md), cmp.added.map(i => i.code))
// 新增知识点的数字就是本地统计：丁一 目标 1/5 份
assert.match(md, /### D\.1｜丁一\n- \*\*数据\*\*：1\/5 份卷子出现/)
// 引用 token 全部来自输入索引，原样复制
const known = new Set(inp.refs.map(r => r.token))
const used = [...md.matchAll(CITATION_RE)].map(m => m[0])
assert.ok(used.length > 0)
assert.deepEqual(stripUnknownCitations(md, known).removed, [], '正常应答里没有自造引用')
// quirks
const bad = p2.build(user, { badCite: true, badHeading: true })
assert.deepEqual(stripUnknownCitations(bad, known).removed, ['[不存在的卷 · 99]'])
assert.deepEqual(headingCodes(bad).filter(c => !inp.codes.includes(c)), ['ZZ.NOT.IN.INPUT'])
// 样本提示非「无」时，开头有引用块
const small = P.fillTemplate(userTpl.replace(/\s+$/, ''), { ...inp.placeholders, SAMPLE_WARNING: '样本偏小：目标学年只有 4 份卷子' })
assert.ok(p2.build(small, {}).startsWith('> 样本偏小：目标学年只有 4 份卷子 结论仅供参考。'))
assert.ok(!md.startsWith('>'), '样本提示为「无」时不写提示')
console.log('mock-p2.test ✓')
