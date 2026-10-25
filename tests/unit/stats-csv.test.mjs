// 双向细目表 CSV：内容、转义、防公式注入。数据集同 stats-core.test 的 S1，期望值手算。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { csvCell, matrixToCsv } from '../../src/main/stats/csv.ts'

assert.equal(csvCell('a,b'), '"a,b"')
assert.equal(csvCell('say "hi"'), '"say ""hi"""')
assert.equal(csvCell('l1\nl2'), '"l1\nl2"')
assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)", '以 = 开头的文本加单引号，Excel 不会当公式')
assert.equal(csvCell('+1'), "'+1"); assert.equal(csvCell('-1x'), "'-1x"); assert.equal(csvCell('@cmd'), "'@cmd")
assert.equal(csvCell(-3), '-3', '数字不受影响')
assert.equal(csvCell(null), ''); assert.equal(csvCell(0), '0')

const { db } = newDb()
useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['B', null, '=乙', 1], ['B.1', 'B', '乙,一', 2]])
addPaper(db, { questions: [
  { qtype: 'MC', kp: 'A.1', score: 2 }, { qtype: 'MC', kp: 'B.1', score: null }, { qtype: 'FORM', kp: 'A.1', sec: ['B.1'], score: 3 }, { qtype: 'MC', kp: null, score: 5 }] })
const csv = matrixToCsv(S.matrix(db, {}, 1), '全部年级 · 按一级知识点统计')
assert.ok(csv.startsWith('\uFEFF'), '带 BOM（用转义写，免得不可见字符被编辑器吃掉）')
const lines = csv.slice(1).split('\r\n')
assert.equal(lines.pop(), '', '以换行结尾')
// 列顺序按题型表的 sort：MC 在 FORM 前；每个题型三列：题数、分值、分值覆盖（有分值的主知识点题 / 主知识点题）
assert.equal(lines[0], '知识点代码,知识点,单项选择 题数,单项选择 分值,单项选择 分值覆盖,用所给词的适当形式填空 题数,用所给词的适当形式填空 分值,用所给词的适当形式填空 分值覆盖,合计题数,合计分值')
// 甲：MC 1 题 2 分（1/1 有分值）；FORM 1 题 3 分（1/1）；合计 2 题 5 分
assert.equal(lines[1], 'A,甲,1,2,1/1,1,3,1/1,2,5')
// 乙：MC 1 题（主知识点但无分值 → 分值留空，覆盖 0/1）；FORM 1 题（只是次知识点 → 分值 0，覆盖写「仅次知识点」）；合计 2 题 0 分
assert.equal(lines[2], "B,'=乙,1,,0/1,1,0,仅次知识点,2,0")
// 表尾：全部题目含未标知识点的题：MC 3 题 7 分（3 题里 2 题有分值）；FORM 1 题 3 分
assert.equal(lines[3], ',全部题目合计（含未标知识点的题）,3,7,2/3,1,3,1/1,4,10')
// 表后附口径说明：筛选范围、试卷数、分值覆盖——文件被转发时数字不会脱离口径
assert.equal(lines[4], '')
assert.equal(lines[5], '说明,筛选范围：全部年级 · 按一级知识点统计')
assert.equal(lines[6], ',计入试卷 1 份；分值覆盖 3/4 题（分值为空的题不进分值统计）')
assert.match(lines[7], /一道题标了多个知识点会在多行各计一次题数/)
assert.equal(lines.length, 8)

// 部分题有分值：分值是那一部分的和，靠「分值覆盖」列看出来（1/2 题有分值），不会被误读成整格的分值
{
  const { db: d2 } = newDb()
  useTree(d2, [['A', null, '甲', 1]])
  addPaper(d2, { questions: [{ qtype: 'MC', kp: 'A', score: 2 }, { qtype: 'MC', kp: 'A', score: null }] })
  const l = matrixToCsv(S.matrix(d2, {}, 1)).slice(1).split('\r\n')
  assert.equal(l[1], 'A,甲,2,2,1/2,2,2')
}

// 二级行里带逗号的名字被加引号
const csv2 = matrixToCsv(S.matrix(db, {}, 2)).slice(1).split('\r\n')
assert.equal(csv2[2], `B.1,"'=乙 / 乙,一",1,,0/1,1,0,仅次知识点,2,0`, '路径名以 = 开头也要防注入、带逗号加引号（A.1 那行在前）')
console.log('stats-csv.test ✓')
