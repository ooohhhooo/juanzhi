// R4 内部代码不能漏到界面：真实输出里漏出来的写法（审核页第 30 题的主知识点 RD.INFER.OPINION、提示里的 GR.PRON.DEMO）做夹具。
import assert from 'node:assert/strict'
import { looksLikeCode, hasCode, stripCodes, safeKpName, safeSuggestion, safeText, labelsOf, UNNAMED_KP } from '../../src/shared/code-guard.ts'
import { kpNameProblem, cleanSuggestedName } from '../../src/main/pack/kp-rules.ts'
import { repairKpNames } from '../../src/main/db-repair.ts'
import { newDb, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'

assert.equal(looksLikeCode('RD.INFER.OPINION'), true); assert.equal(looksLikeCode('GR.PRON.DEMO'), true); assert.equal(looksLikeCode('PH_DIFF'), true)
assert.equal(looksLikeCode('推理判断'), false); assert.equal(looksLikeCode('MATCH'), false, '单个大写单词不是代码'); assert.equal(looksLikeCode('How much'), false)
assert.equal(hasCode('改了主要考的知识点后，原来的 GR.PRON.DEMO 和新的重复'), true); assert.equal(hasCode('名词复数'), false)
assert.equal(stripCodes('原来的 GR.PRON.DEMO（GR.PRON.DEMO）已经被去掉'), '原来的 已经被去掉'.replace('的 已', '的 已'))

// 名称：本身是代码 → 「待命名的考点」；夹着代码 → 去掉
assert.equal(safeKpName('RD.INFER.OPINION'), UNNAMED_KP); assert.equal(safeKpName(''), UNNAMED_KP); assert.equal(safeKpName('看法与态度'), '看法与态度')
assert.equal(safeKpName('看法与态度 RD.INFER.OPINION'), '看法与态度')
// AI 的建议文字
assert.equal(safeSuggestion('待归类：RD.INFER.OPINION'), '待归类（AI 给的分类不在知识点树里，请手动选一个）')
assert.equal(safeSuggestion('购物：尺码询问'), '购物：尺码询问'); assert.equal(safeSuggestion(null), '')
assert.ok(!hasCode(safeSuggestion('新增 GR.PRON.DEMO 的用法')))
assert.equal(safeText('没有代码'), '没有代码'); assert.ok(!hasCode(safeText('带 PH_DIFF 的话')))
// 提示里的名字
assert.deepEqual(labelsOf(['GR.PRON.DEMO', 'X.Y'], c => (c === 'GR.PRON.DEMO' ? '指示代词' : null)), ['指示代词', UNNAMED_KP])

// 老师采纳建议时：名称不能是代码（旧版本就是这样把 RD.INFER.OPINION 变成了节点名）
assert.match(kpNameProblem('RD.INFER.OPINION'), /不能是英文代码/); assert.equal(kpNameProblem('看法与态度'), null)
assert.throws(() => cleanSuggestedName('RD.INFER.OPINION'), /不能是英文代码/); assert.equal(cleanSuggestedName(' 看法与态度 '), '看法与态度')

// 启动修补：已经存在的、名称是代码的节点改成「待命名的考点」，其余不动；幂等；统计里读到的名称也是干净的
{
  const { db } = newDb()
  db.prepare("INSERT INTO kps (code, parent_code, name, level, intro_grade, sort, builtin) VALUES ('RD.INFER.U1', 'RD.INFER', 'RD.INFER.OPINION', 3, 4, 999, 0)").run()
  addPaper(db, { questions: [{ kp: 'RD.INFER.U1', score: 2 }] })
  assert.ok(!S.loadKps(db).some(k => hasCode(k.name)), '读出来的名称就已经是干净的（即使库里还没修补）')
  assert.equal(repairKpNames(db), 1)
  assert.equal(db.prepare("SELECT name FROM kps WHERE code = 'RD.INFER.U1'").get().name, UNNAMED_KP)
  assert.equal(repairKpNames(db), 0, '幂等')
  assert.deepEqual(JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = 'kp_names_orig_v1'").get().value_json), { 'RD.INFER.U1': 'RD.INFER.OPINION' }, '改名前原名记下来了，可以还原')
  // 一次性：标记写下之后，再出现的代码名称不会被启动修补改动（读取层仍会过滤）
  db.prepare("UPDATE kps SET name = 'GR.TENSE.FUT' WHERE code = 'RD.INFER.U1'").run()
  assert.equal(repairKpNames(db), 0)
  assert.equal(db.prepare("SELECT name FROM kps WHERE code = 'RD.INFER.U1'").get().name, 'GR.TENSE.FUT')
  assert.equal(db.prepare("SELECT name FROM kps WHERE code = 'RD.INFER'").get().name, '推理判断', '正常的名称不动')
  // 界面里统计出来的每个名称都不含代码
  const dist = S.distribution(db, {})
  assert.ok(dist.nodes.every(n => !hasCode(n.name)), '统计里的知识点名都不是代码')
}
// 正常缩写不是代码：A.M / P.M / P.E / T.V / U.S，也不会被启动修补改名
for (const ok of ['A.M', 'P.M', 'P.E', 'T.V', 'U.S', 'A.M / P.M']) { assert.equal(looksLikeCode(ok), false, ok); assert.equal(safeKpName(ok), ok) }
{
  const { db } = newDb()
  db.prepare("INSERT INTO kps (code, parent_code, name, level, intro_grade, sort, builtin) VALUES ('PH.LETTER.U1', 'PH.LETTER', 'T.V', 3, 4, 999, 0)").run()
  assert.equal(repairKpNames(db), 0)
  assert.equal(db.prepare("SELECT name FROM kps WHERE code = 'PH.LETTER.U1'").get().name, 'T.V')
}
console.log('code-guard.test ✓')
