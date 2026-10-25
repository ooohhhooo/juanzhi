// 内置知识点树与题型表的结构校验
import assert from 'node:assert/strict'
import { KP_SEEDS_V1, QTYPE_SEEDS_V1, buildKpRows } from '../../src/main/seed/taxonomy.ts'

const rows = buildKpRows()
assert.equal(rows.length, KP_SEEDS_V1.length)
assert.ok(rows.length >= 80 && rows.length <= 150, `节点数 ${rows.length} 应在 80–150`)

const codes = new Set(rows.map(r => r.code))
assert.equal(codes.size, rows.length, '代码必须唯一')
for (const r of rows) {
  assert.match(r.code, /^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/, `代码格式：${r.code}`)
  assert.ok(r.name.trim().length > 0, `缺名称：${r.code}`)
  assert.ok(r.level >= 1 && r.level <= 3, `${r.code} 层级 ${r.level} 超出 1–3`)
  assert.ok(r.intro_grade >= 3 && r.intro_grade <= 6, `${r.code} 引入年级 ${r.intro_grade}`)
  if (r.parent_code) {
    assert.ok(codes.has(r.parent_code), `${r.code} 的父节点 ${r.parent_code} 不存在`)
    assert.ok(r.code.startsWith(r.parent_code + '.'), `${r.code} 不在 ${r.parent_code} 之下`)
    assert.equal(r.level, rows.find(p => p.code === r.parent_code).level + 1)
  } else {
    assert.equal(r.level, 1)
  }
}

// 设计方案 §7 表格里的一级大类都在
for (const c of ['PH', 'VO', 'GR.NOUN', 'GR.PRON', 'GR.NUM', 'GR.PREP', 'GR.VERB', 'GR.TENSE', 'GR.ADJ', 'GR.SENT', 'FN', 'RD', 'WR']) {
  assert.ok(codes.has(c), `缺一级节点 ${c}`)
  assert.equal(rows.find(r => r.code === c).level, 1, `${c} 应为一级`)
}
// 设计方案与任务书点名的代码
for (const c of ['PH.LETTER', 'PH.PHONICS', 'PH.STRESS', 'VO.TOPIC', 'VO.FORM', 'VO.PHRASE', 'GR.TENSE.PAST.IRREG', 'GR.TENSE.PRES_CONT']) {
  assert.ok(codes.has(c), `缺节点 ${c}`)
}
// 每个一级节点至少有 2 个二级子节点（树不是空壳）
for (const l1 of rows.filter(r => r.level === 1)) {
  assert.ok(rows.filter(r => r.parent_code === l1.code).length >= 2, `${l1.code} 子节点太少`)
}
// 名称在同一父节点下不重复
const seen = new Set()
for (const r of rows) {
  const k = `${r.parent_code}|${r.name}`
  assert.ok(!seen.has(k), `同级重名：${k}`)
  seen.add(k)
}

// 题型
const qcodes = QTYPE_SEEDS_V1.map(q => q[0])
assert.equal(new Set(qcodes).size, qcodes.length, '题型代码唯一')
assert.ok(qcodes.includes('OTHER'), '必须有 OTHER 兜底项')
assert.equal(QTYPE_SEEDS_V1.filter(q => q[2] === 'listening').length, 6, '听力题型 6 种（设计方案 §7）')
for (const c of ['PH_DIFF', 'VO_CLASS', 'MC', 'FORM', 'DIALOG', 'CLOZE', 'RD_TF', 'RD_MC', 'ORDER', 'WRITE']) assert.ok(qcodes.includes(c), `缺题型 ${c}`)

// v5 迁移写入的种子是冻结的：谁改了这份数据，新装用户与从 v4 升级的用户就会得到不同的树（审核 P2-17）。
// 要更新知识点请新增 KP_SEEDS_V2 + v6 迁移，并同步更新这里的校验值之外的新测试，不要改 V1。
import crypto from 'node:crypto'
const digest = crypto.createHash('sha256').update(JSON.stringify([KP_SEEDS_V1, QTYPE_SEEDS_V1])).digest('hex')
assert.equal(digest, '96cf4a36f7cb5f4ed4fca98d18859c8a919a63a7539efd437150869bc1dcc5de', 'KP_SEEDS_V1 / QTYPE_SEEDS_V1 是 v5 迁移的冻结数据，不能修改；要更新请走 v6 迁移')

console.log(`taxonomy.test ✓ 知识点 ${rows.length} 个（一级 ${rows.filter(r => r.level === 1).length} / 二级 ${rows.filter(r => r.level === 2).length} / 三级 ${rows.filter(r => r.level === 3).length}），题型 ${qcodes.length} 个`)
