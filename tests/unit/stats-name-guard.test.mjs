// 主进程层面的代码过滤：知识点的名称就算被存成了内部代码（旧版本的 bug），总览、分布、热点、对比、矩阵、证据、
// 看板用到的所有统计返回值里也不会出现这个代码。验证方法：把名称改成代码，序列化每个接口的返回值，查有没有这段代码。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { collectEvidence } from '../../src/main/stats/evidence.ts'

const { db } = newDb()
useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.1.x', 'A.1', '甲一x', 3], ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2]])
addPaper(db, { title: 'P1', year: 2025, questions: [
  { qtype: 'MC', kp: 'A.1.x', sec: ['B.1'], score: 2, difficulty: 3, err: true, reason: '粗心' },
  { qtype: 'MC', kp: 'B.1', score: 3, difficulty: 2 }] })
addPaper(db, { title: 'P0', year: 2024, questions: [{ qtype: 'MC', kp: 'A.1.x', score: 2, difficulty: 3 }, { qtype: 'MC', kp: 'B.1', score: 2, difficulty: 2 }] })
// 旧 bug 的状态：名称被存成了内部代码
db.prepare("UPDATE kps SET name = 'RD.INFER.OPINION' WHERE code = 'A.1.x'").run()
db.prepare("UPDATE kps SET name = 'GR.TENSE.FUT' WHERE code = 'B.1'").run()
const BAD = /RD\.INFER\.OPINION|GR\.TENSE\.FUT/

const outs = {
  loadKps: S.loadKps(db),
  distribution: S.distribution(db, {}),
  overview: S.overview(db, {}),
  matrix: S.matrix(db, {}, 3),
  hot1: S.hot(db, {}, 2), hot2: S.hot(db, {}, 3),
  compare: S.compare(db, {}, 2025, { lt: 2025 }, 3),
  drawer: S.questionsOfKp(db, S.drawerScope(db, {}, { kind: 'all' }), 'A.1.x', 10),
  evidence: collectEvidence(db, S.drawerScope(db, {}, { kind: 'all' }))
}
for (const [k, v] of Object.entries(outs)) assert.ok(!BAD.test(JSON.stringify(v)), `${k} 的返回值里出现了内部代码`)
// 名称换成了统一的占位
assert.ok(JSON.stringify(outs.distribution).includes('待命名的考点'))
console.log('stats-name-guard.test ✓')
