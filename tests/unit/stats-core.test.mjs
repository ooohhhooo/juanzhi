// 统计口径的单测：用手算期望值的小数据集验证。期望值全部写死成手算结果，不拿被测代码再算一遍。
// 表结构来自真实迁移（helpers/db.mjs），统计函数就是应用里跑的那份（src/main/stats/core.ts）。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'

const close = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}：${a} ≠ ${b}`)
const byCode = (nodes, code) => nodes.find(n => n.code === code)

const TREE = [
  ['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.1.x', 'A.1', '甲一x', 3], ['A.1.y', 'A.1', '甲一y', 3], ['A.2', 'A', '甲二', 2],
  ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2],
  ['C', null, '丙', 1],
  ['D', null, '丁', 1], ['D.1', 'D', '丁一', 2],
  ['E', null, '戊', 1], ['E.1', 'E', '戊一', 2]
]

// ═════════ 数据集 S1：一个学年 4 份卷子，9 道题 ═════════
// P1: Q1 MC A.1.x(主) +B.1(次) 2分 难1 | Q2 FORM A.1.y 3分 难2 | Q3 MC B.1 分值空 难3
// P2: Q1 MC A.1.x 2分 难3 | Q2 FORM A.2 5分 难5
// P3: Q1 DIALOG C 10分 难4 | Q2 MC A.1.x(主) +A.1.y(次) 4分 难3
// P4: Q1 MC B.1 6分 难3 易错「R」 | Q2 DIALOG 没有知识点 1分 难空
function s1() {
  const { db } = newDb()
  useTree(db, TREE)
  const ids = {}
  ids.p1 = addPaper(db, { title: 'P1', questions: [
    { qtype: 'MC', kp: 'A.1.x', sec: ['B.1'], score: 2, difficulty: 1 },
    { qtype: 'FORM', kp: 'A.1.y', score: 3, difficulty: 2 },
    { qtype: 'MC', kp: 'B.1', score: null, difficulty: 3 }] })
  ids.p2 = addPaper(db, { title: 'P2', questions: [
    { qtype: 'MC', kp: 'A.1.x', score: 2, difficulty: 3 },
    { qtype: 'FORM', kp: 'A.2', score: 5, difficulty: 5 }] })
  ids.p3 = addPaper(db, { title: 'P3', questions: [
    { qtype: 'DIALOG', kp: 'C', score: 10, difficulty: 4 },
    { qtype: 'MC', kp: 'A.1.x', sec: ['A.1.y'], score: 4, difficulty: 3 }] })
  ids.p4 = addPaper(db, { title: 'P4', questions: [
    { qtype: 'MC', kp: 'B.1', score: 6, difficulty: 3, err: true, reason: 'R' },
    { qtype: 'DIALOG', kp: null, score: 1, difficulty: null }] })
  return { db, ids }
}

{
  const { db } = s1()
  const d = S.distribution(db, {})
  assert.equal(d.papers, 4)
  assert.equal(d.questions, 9)
  // 总分 = 2+3+2+5+10+4+6+1 = 33（分值为空的 P1Q3 不进总分）
  assert.equal(d.totalScore, 33)
  // 「分值覆盖 x/y 题」：8/9；有主知识点的题 8 道（P4Q2 没标）
  assert.deepEqual(d.coverage, { scored: 8, questions: 9, tagged: 8 })

  // 出现率 = 含该知识点的试卷数 ÷ 筛选内试卷数
  const x = byCode(d.nodes, 'A.1.x'), y = byCode(d.nodes, 'A.1.y')
  assert.equal(x.papers, 3); close(x.rate, 3 / 4, '甲一x 出现率')
  assert.equal(y.papers, 2); close(y.rate, 2 / 4, '甲一y 出现率（P3 里它是次知识点也算出现）')

  // 分值占比：只按主知识点。P3Q2 的主知识点是 A.1.x（4 分），次知识点 A.1.y 不再分到这 4 分
  assert.equal(x.score, 8); close(x.scoreShare, 8 / 33, '甲一x 分值占比')
  assert.equal(y.score, 3); close(y.scoreShare, 3 / 33, '甲一y 分值占比（次知识点不重复计分）')
  assert.equal(y.questions, 2, '甲一y 的题数：主 1 + 次 1')
  assert.equal(y.primQuestions, 1)

  // 向上汇总：甲一 = 甲一x ∪ 甲一y。P3Q2 同时在两个子节点，汇总时只算一道题、一份卷
  const a1 = byCode(d.nodes, 'A.1')
  assert.equal(a1.papers, 3, '甲一：P1/P2/P3 出现，P3 虽有两个子节点也只算一份')
  assert.equal(a1.questions, 4, '甲一的题数：P1Q1 P1Q2 P2Q1 P3Q2（P3Q2 不重复）')
  assert.equal(a1.score, 11); close(a1.scoreShare, 11 / 33, '甲一分值占比 = 2+3+2+4')
  assert.equal(a1.ownPrim, 0, '甲一本身没有被直接标为主知识点')
  const a = byCode(d.nodes, 'A')
  assert.equal(a.papers, 3); assert.equal(a.questions, 5); assert.equal(a.score, 16)
  // 甲二只在 P2；甲 = 甲一 ∪ 甲二，P2 只算一份卷
  assert.equal(byCode(d.nodes, 'A.2').papers, 1); close(byCode(d.nodes, 'A.2').rate, 0.25, '甲二出现率')

  // 分值为空：P1Q3 是乙一的主知识点，但没有分值——题数计入、分值不计
  const b1 = byCode(d.nodes, 'B.1')
  assert.equal(b1.papers, 2, '乙一：P1(Q1 次 + Q3 主) 与 P4')
  assert.equal(b1.questions, 3); assert.equal(b1.primQuestions, 2); assert.equal(b1.scoredPrim, 1)
  assert.equal(b1.score, 6); close(b1.scoreShare, 6 / 33, '乙一分值占比只含 P4Q1 的 6 分')
  assert.equal(b1.errorCount, 1)
  // 平均难度（估计）：P1Q1=1, P1Q3=3, P4Q1=3 → 7/3
  close(b1.avgDifficulty, 7 / 3, '乙一平均难度', 0.005)

  // 主知识点的分值合计 + 没标知识点的题 = 总分：16 + 6 + 10 + 1 = 33
  const l1 = d.nodes.filter(n => n.level === 1)
  assert.equal(l1.reduce((s, n) => s + n.score, 0), 32)
  // 沒有任何题的节点不返回
  assert.equal(byCode(d.nodes, 'D'), undefined)

  // 题型
  const mc = d.qtypes.find(q => q.code === 'MC'), form = d.qtypes.find(q => q.code === 'FORM'), dia = d.qtypes.find(q => q.code === 'DIALOG')
  assert.deepEqual([mc.questions, mc.score, mc.scored], [5, 14, 4])
  assert.deepEqual([form.questions, form.score], [2, 8])
  assert.deepEqual([dia.questions, dia.score], [2, 11])
  close(mc.scoreShare, 14 / 33, '单选分值占比')
  assert.equal(mc.papers, 4)
  // 难度分布（估计）：难1×1 难2×1 难3×4 难4×1 难5×1，未评 1 道（P4Q2）
  assert.deepEqual(d.difficulty.map(x => x.questions), [1, 1, 4, 1, 1])
  assert.equal(d.difficultyUnrated, 1)
  close(d.difficulty[2].share, 4 / 8, '难度 3 的占比（分母是已评难度的 8 道）')
}

// ═════════ 双向细目表：知识点 × 题型 ═════════
{
  const { db } = s1()
  const cell = (m, row, col) => m.cells.find(c => c.row === row && c.col === col)
  const m1 = S.matrix(db, {}, 1)
  assert.deepEqual(m1.rows.map(r => r.code), ['A', 'B', 'C'])
  // 甲×单选：P1Q1 P2Q1 P3Q2 = 3 题，主知识点分值 2+2+4 = 8（P3Q2 次知识点也在甲，同一行只算一次）
  assert.deepEqual([cell(m1, 'A', 'MC').questions, cell(m1, 'A', 'MC').score], [3, 8])
  assert.deepEqual([cell(m1, 'A', 'FORM').questions, cell(m1, 'A', 'FORM').score], [2, 8])
  // 乙×单选：P1Q1(次) P1Q3(主,无分值) P4Q1(主,6) = 3 题，分值只有 6
  assert.deepEqual([cell(m1, 'B', 'MC').questions, cell(m1, 'B', 'MC').score, cell(m1, 'B', 'MC').scored], [3, 6, 1])
  assert.deepEqual([cell(m1, 'C', 'DIALOG').questions, cell(m1, 'C', 'DIALOG').score], [1, 10])
  assert.equal(cell(m1, 'C', 'MC'), undefined, '没有题的单元格不返回')
  assert.deepEqual(m1.cols.map(c => c.code).sort(), ['DIALOG', 'FORM', 'MC'])
  // 一道题标了多个知识点会在多行各计一次题数：行合计 3+... 比总题数多，是预期（界面口径说明里写明）
  assert.equal(m1.rows.reduce((s, r) => s + r.questions, 0), 5 + 3 + 1)

  // 二级行：标在一级上的题（丙）单独成行，不会丢
  const m2 = S.matrix(db, {}, 2)
  assert.deepEqual(m2.rows.map(r => r.code), ['A.1', 'A.2', 'B.1', 'C'])
  assert.deepEqual([cell(m2, 'A.1', 'MC').questions, cell(m2, 'A.1', 'MC').score], [3, 8])
  assert.deepEqual([cell(m2, 'A.1', 'FORM').questions, cell(m2, 'A.1', 'FORM').score], [1, 3])
  assert.deepEqual([cell(m2, 'A.2', 'FORM').questions, cell(m2, 'A.2', 'FORM').score], [1, 5])
  assert.equal(cell(m2, 'C', 'DIALOG').score, 10)

  // 三级行：P3Q2 的次知识点甲一y 那行有题数、没有分值
  const m3 = S.matrix(db, {}, 3)
  assert.deepEqual(m3.rows.map(r => r.code), ['A.1.x', 'A.1.y', 'A.2', 'B.1', 'C'])
  assert.deepEqual([cell(m3, 'A.1.y', 'MC').questions, cell(m3, 'A.1.y', 'MC').score], [1, 0], '次知识点那一行：有题数，分值为 0（分值只按主知识点计）')
  assert.deepEqual([cell(m3, 'A.1.x', 'MC').questions, cell(m3, 'A.1.x', 'MC').score], [3, 8])
  assert.deepEqual([cell(m3, 'A.1.y', 'FORM').questions, cell(m3, 'A.1.y', 'FORM').score], [1, 3])
}

// ═════════ 重难点：出现率 × 分值占比 × (1 + 易错率) ═════════
{
  const { db } = s1()
  const h = S.hot(db, {}, 2)
  assert.equal(h.basis, 'score')
  assert.deepEqual(h.rows.map(r => r.code), ['A.1', 'B.1', 'A.2'])
  // 甲一：0.75 × 11/33 × (1+0) = 0.25
  close(h.rows[0].priority, 0.25, '甲一综合得分')
  // 乙一：0.5 × 6/33 × (1 + 1/3) = 4/33 ≈ 0.121212
  close(h.rows[1].priority, 4 / 33, '乙一综合得分')
  close(h.rows[1].errorRate, 1 / 3, '乙一易错率（估计）')
  // 甲二：0.25 × 5/33 = 5/132
  close(h.rows[2].priority, 5 / 132, '甲二综合得分')
  // 典型题：乙一的首选是被标为易错的 P4Q1；易错原因汇总
  assert.equal(h.rows[1].typical[0].error_prone, true)
  assert.equal(h.rows[1].typical[0].error_reason, 'R')
  assert.deepEqual(h.rows[1].reasons, [{ reason: 'R', count: 1 }])
  assert.equal(h.rows[0].typical.length, 3)
  assert.equal(S.hot(db, {}, 2, 2).rows.length, 2, 'limit')
}

// 全卷都没有分值：重难点退回主知识点题数占比，并标明口径
{
  const { db } = newDb()
  useTree(db, TREE)
  addPaper(db, { questions: [{ kp: 'A.1', score: null }, { kp: 'B.1', score: null }] })
  addPaper(db, { questions: [{ kp: 'A.1', score: null }, { kp: 'A.1', score: null }] })
  const h = S.hot(db, {}, 2)
  assert.equal(h.basis, 'count')
  assert.equal(h.rows[0].code, 'A.1')
  // 甲一：出现率 2/2=1，题数占比 3/4，无易错 → 0.75
  close(h.rows[0].priority, 0.75, '无分值时的综合得分')
  const d = S.distribution(db, {})
  assert.equal(d.totalScore, 0)
  assert.equal(d.nodes.find(n => n.code === 'A.1').scoreShare, null, '总分为 0 时分值占比为空，不是 0 或 NaN')
  assert.deepEqual(d.coverage, { scored: 0, questions: 4, tagged: 4 })
}

// ═════════ 哪些卷子计入统计 ═════════
{
  const { db, ids } = s1()
  addPaper(db, { title: '待审核卷', status: 'reviewing', questions: [{ kp: 'D.1', score: 7 }] })
  addPaper(db, { title: '失败卷', status: 'failed', questions: [{ kp: 'D.1', score: 7 }] })
  // 重复卷 = 把 P1 同一个文件又导入了一次（file_hash 相同，duplicate_of 指向 P1）
  addPaper(db, { title: '重复卷', dup: ids.p1, hash: `h-${ids.p1}`, questions: [{ kp: 'E.1', score: 3 }] })
  // 默认：只统计 done；同一个文件只算一份——P1 与重复卷都是 done，取最早导入的 P1，重复卷被合并掉
  let d = S.distribution(db, {})
  assert.equal(d.papers, 4, '4 份：重复卷与 P1 是同一个文件，只算一份')
  assert.equal(byCode(d.nodes, 'E.1'), undefined, '被合并的重复卷里的题不计入')
  assert.equal(byCode(d.nodes, 'D.1'), undefined, '待审核/失败的卷子默认不计入')
  assert.equal(d.pendingReviewing, 1)
  assert.equal(d.duplicates, 1, '被合并掉的份数')
  assert.equal(d.includeDuplicates, false)
  // 「含待审核」打开：reviewing 也算（failed 仍然不算）；总数 +1，分母也是 5
  d = S.distribution(db, { includeReviewing: true })
  assert.equal(d.papers, 5)
  assert.equal(byCode(d.nodes, 'D.1').papers, 1)
  close(byCode(d.nodes, 'D.1').rate, 1 / 5, '开关打开后的分母是 5')
  assert.equal(d.pendingReviewing, 0)
  // 「包含重复导入」打开：每一份都算（会重复计数）
  d = S.distribution(db, { includeDuplicates: true })
  assert.equal(d.papers, 5); assert.equal(byCode(d.nodes, 'E.1').papers, 1)
  assert.equal(d.duplicates, 1, '此时的含义是「被重复计数的份数」'); assert.equal(d.includeDuplicates, true)
  // 总览的「待审核」卡片不受开关影响
  assert.equal(S.overview(db, {}).cards.pending, 1)
  assert.equal(S.overview(db, { includeReviewing: true }).cards.pending, 1)
  assert.equal(S.overview(db, { includeReviewing: true }).includeReviewing, true)
  assert.deepEqual(S.scopeNotes(db, {}), { pendingReviewing: 1, reviewing: 1, reviewingCounted: 0, reviewingSuperseded: 0, duplicates: 1, includeDuplicates: false, noYear: 0 })
  assert.deepEqual(S.scopeNotes(db, { includeReviewing: true }), { pendingReviewing: 0, reviewing: 1, reviewingCounted: 1, reviewingSuperseded: 0, duplicates: 1, includeDuplicates: false, noYear: 0 }, '开关打开后「没计入」是 0，但待审核总数（提示条用）仍是 1')
}

// ═════════ 重复导入：副本能顶上，一份卷子不会因为「是副本」而消失（审核 P0-1） ═════════
{
  const { db } = newDb()
  useTree(db, TREE)
  const Q = () => [{ kp: 'A.1', score: 2 }]
  const mk = (over) => addPaper(db, { questions: Q(), ...over })
  const n = f => S.distribution(db, f).papers
  // ① 原件还在待审核、副本已确认：默认（只统计已确认）→ 副本顶上，算 1 份（修复前开关打开会得到 0）
  const o1 = mk({ title: 'o1', status: 'reviewing', hash: 'H1', created: '2026-01-01 10:00:00', grade: '1' })
  mk({ title: 'c1', status: 'done', hash: 'H1', dup: o1, created: '2026-01-02 10:00:00', grade: '1' })
  assert.equal(n({ grade: '1' }), 1, '原件待审核、副本已确认：副本算 1 份')
  assert.equal(n({ grade: '1', includeDuplicates: true }), 1, '包含重复导入也是 1 份（原件没计入）')
  // 打开「含待审核」：两份都可见，仍是 1 份（不是 2 份）
  assert.equal(n({ grade: '1', includeReviewing: true }), 1)
  assert.equal(n({ grade: '1', includeReviewing: true, includeDuplicates: true }), 2)
  // ② 原件已被删除（duplicate_of 指向不存在的 id，没有外键）：副本唯一，算 1 份
  mk({ title: 'c2', status: 'done', hash: 'H2', dup: '99999999-9999-4999-8999-999999999999', grade: '2' })
  assert.equal(n({ grade: '2' }), 1, '原件已删除：副本算 1 份')
  // ③ 三份同一个文件：原件待审核，副本 1、2 都已确认 → 只算最早导入的副本 1，副本 2 合并
  const o3 = mk({ title: 'o3', status: 'reviewing', hash: 'H3', created: '2026-01-01 10:00:00', grade: '3' })
  mk({ title: 'c3a', status: 'done', hash: 'H3', dup: o3, created: '2026-01-02 10:00:00', grade: '3' })
  mk({ title: 'c3b', status: 'done', hash: 'H3', dup: o3, created: '2026-01-03 10:00:00', grade: '3' })
  assert.equal(n({ grade: '3' }), 1)
  assert.equal(S.distribution(db, { grade: '3' }).duplicates, 1, '被合并掉 1 份（c3b）')
  assert.equal(n({ grade: '3', includeDuplicates: true }), 2)
  // ④ 「可见」是看当前筛选：原件是四年级、副本被改成五年级 → 按年级筛选时各算各的，不会因为另一份在别处而消失
  mk({ title: 'o4', hash: 'H4', created: '2026-01-01 10:00:00', grade: '4' })
  mk({ title: 'c4', hash: 'H4', created: '2026-01-02 10:00:00', grade: '5' })
  assert.equal(n({ grade: '4' }), 1); assert.equal(n({ grade: '5' }), 1)
  assert.equal(n({ grade: '4', includeDuplicates: true }), 1)
  // ⑤ 两份导入时间完全相同：按插入顺序（rowid）取先的，结果稳定、恰好 1 份
  mk({ title: 'o5', hash: 'H5', created: '2026-01-01 10:00:00', grade: '6' })
  mk({ title: 'c5', hash: 'H5', created: '2026-01-01 10:00:00', grade: '6' })
  assert.equal(n({ grade: '6' }), 1)
  // 没有重复的卷子永远不受影响
  // 不加筛选时 o4 与 c4（同一个文件）都可见 → 只算最早的 o4；所以是 c1、c2、c3a、o4、o5 共 5 份
  assert.equal(n({}), 5)
}

// 代表卷的规则：先选已确认（done）的，同一状态里再选最早导入的（复审后的决定）——
// 打开「含待审核」时，已确认的副本不会被未确认的原件顶掉
{
  const { db } = newDb()
  useTree(db, TREE)
  const o = addPaper(db, { title: '原件', status: 'reviewing', hash: 'HR', created: '2026-01-01 10:00:00', grade: '1', questions: [{ kp: 'B.1', score: 2 }] })
  addPaper(db, { title: '已确认的副本', status: 'done', hash: 'HR', dup: o, created: '2026-01-02 10:00:00', grade: '1', questions: [{ kp: 'A.1', score: 2 }] })
  const kps = f => S.distribution(db, f).nodes.filter(n => n.level === 2).map(n => n.code).sort()
  assert.deepEqual(kps({ grade: '1' }), ['A.1'], '默认：只有副本可见 → 副本')
  assert.deepEqual(kps({ grade: '1', includeReviewing: true }), ['A.1'], '含待审核：副本是 done，原件虽然更早也不顶掉它（B.1 不出现）')
  assert.deepEqual(kps({ grade: '1', includeReviewing: true, includeDuplicates: true }), ['A.1', 'B.1'], '包含重复导入：两份都算')
  // 两份都是 reviewing：按最早导入
  const o2 = addPaper(db, { title: '原件2', status: 'reviewing', hash: 'HR2', created: '2026-01-01 10:00:00', grade: '2', questions: [{ kp: 'B.1' }] })
  addPaper(db, { title: '副本2', status: 'reviewing', hash: 'HR2', dup: o2, created: '2026-01-02 10:00:00', grade: '2', questions: [{ kp: 'A.1' }] })
  assert.deepEqual(kps({ grade: '2', includeReviewing: true }), ['B.1'], '同一状态里取最早导入的')
  // 两份都是 done：同样按最早导入
  const o3 = addPaper(db, { title: '原件3', hash: 'HR3', created: '2026-01-01 10:00:00', grade: '3', questions: [{ kp: 'B.1' }] })
  addPaper(db, { title: '副本3', hash: 'HR3', dup: o3, created: '2026-01-02 10:00:00', grade: '3', questions: [{ kp: 'A.1' }] })
  assert.deepEqual(kps({ grade: '3' }), ['B.1'])
}

// ═════════ 同比两侧范围的共用函数 sideScopes：表格、P2、抽屉卡片是同一批卷子（复审 P1-B、P2-N2） ═════════
{
  const { db } = newDb()
  useTree(db, TREE)
  const P_ = (year, semester, kps, n = 1) => { for (let i = 0; i < n; i++) addPaper(db, { year, semester, questions: kps.map(k => ({ kp: k, score: 2 })) }) }
  // 目标 2025 只有上学期 5 份；基线：2023 只有下学期 2 份（含 B.1）、2024 上学期 5 份（其中 2 份含 B.1）+ 下学期 3 份（都含 B.1）
  P_(2025, '上', ['A.1'], 5)
  P_(2023, '下', ['B.1'], 2)
  P_(2024, '上', ['A.1', 'B.1'], 2); P_(2024, '上', ['A.1'], 3)
  P_(2024, '下', ['B.1'], 3)
  const on = S.sideScopes(db, {}, 2025, { lt: 2025 }, true)
  const off = S.sideScopes(db, {}, 2025, { lt: 2025 }, false)
  assert.equal(on.aligning, true); assert.deepEqual(on.targetKeys, ['上'])
  assert.equal(on.dropped, 5, '2023 的 2 份与 2024 下学期的 3 份被排除')
  assert.deepEqual(on.baseYears, [2024], 'BASE_YEARS 只列对齐后真正贡献了卷子的学年（2023 只有下学期，没有贡献）')
  assert.deepEqual(off.baseYears, [2023, 2024]); assert.equal(off.dropped, 0)
  const cmpOn = S.compare(db, {}, 2025, { lt: 2025 }, 2), cmpOff = S.compare(db, {}, 2025, { lt: 2025 }, 2, 0, false)
  assert.deepEqual(cmpOn.base.years, [2024]); assert.deepEqual(cmpOff.base.years, [2023, 2024])
  // 同比表格上的「基线 x/y 份」与抽屉里列出的基线题目卡片数（questionsOfKp 用同一个 sB）永远一致
  const aB = cmpOn.removed.concat(cmpOn.down, cmpOn.up, cmpOn.added).find(i => i.code === 'B.1')
  assert.equal(aB.aB, 2, '对齐后基线里含 B.1 的只有 2 份')
  assert.equal(S.questionsOfKp(db, on.sB, 'B.1', 100).length, 2, '抽屉基线卡片 = 2（修复前是 7：之前全部学年的全部学期）')
  const aOff = cmpOff.removed.concat(cmpOff.down, cmpOff.up, cmpOff.added).find(i => i.code === 'B.1')
  assert.equal(aOff.aB, 7); assert.equal(S.questionsOfKp(db, off.sB, 'B.1', 100).length, 7)
  // 目标侧同理
  assert.equal(S.questionsOfKp(db, on.sT, 'A.1', 100).length, 5)
}

// ═════════ 同比：按学期对齐（审核 P1-2） ═════════
{
  const { db } = newDb()
  useTree(db, TREE)
  const P_ = (year, semester, kp, n = 5) => { for (let i = 0; i < n; i++) addPaper(db, { year, semester, questions: [{ kp, score: 2 }] }) }
  // 基线 2024：上学期 5 份只考 A.1，下学期 5 份只考 B.1；目标 2025 只有上学期 5 份（还没考到下学期）只考 A.1
  P_(2024, '上', 'A.1'); P_(2024, '下', 'B.1'); P_(2025, '上', 'A.1')
  // 默认按学期对齐：基线只取「上」→ B.1 根本不在基线里，不会被报成「消失」；两侧各 5 份
  let c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.equal(c.base.papers, 5, '基线只取上学期的 5 份'); assert.equal(c.target.papers, 5)
  assert.deepEqual(c.removed.map(i => i.code), [], '下学期才考的 B.1 不再被报成消失')
  assert.equal(c.align.on, true); assert.equal(c.align.dropped, 5, '5 份下学期的基线卷子没参与比较')
  assert.deepEqual(c.align.targetSemesters.map(x => [x.name, x.papers]), [['上', 5]])
  assert.deepEqual(c.align.baseSemesters.map(x => [x.name, x.papers]), [['上', 5]])
  assert.deepEqual(c.mixed, [], '对齐后两侧学期一致，没有学期提示')
  // 不对齐：基线 10 份（上 5 + 下 5），B.1 被报成消失，并给出「学期构成不一致」提示、写明两侧各有哪些学期
  c = S.compare(db, {}, 2025, { lt: 2025 }, 2, 3, false)
  assert.equal(c.base.papers, 10); assert.equal(c.align.on, false); assert.equal(c.align.dropped, 0)
  assert.deepEqual(c.removed.map(i => i.code), ['B.1'])
  assert.equal(c.mixed.length, 1)
  assert.match(c.mixed[0], /学期构成不一致（目标学年有：上学期；基线有：上学期、下学期）/)
  assert.deepEqual(c.align.baseSemesters.map(x => [x.name, x.papers]), [['上', 5], ['下', 5]])
  // 目标学年上下两学期都有：对齐等于没限制（基线两个学期都取），dropped = 0
  P_(2025, '下', 'B.1', 5)
  c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.equal(c.base.papers, 10); assert.equal(c.align.dropped, 0); assert.deepEqual(c.mixed, [])
  // 学期没填的卷子：目标有「未填」时基线的「未填」才算；名字写「未填」
  const { db: db2 } = newDb(); useTree(db2, TREE)
  for (let i = 0; i < 5; i++) { addPaper(db2, { year: 2024, semester: null, questions: [{ kp: 'A.1' }] }); addPaper(db2, { year: 2024, semester: '上', questions: [{ kp: 'A.1' }] }); addPaper(db2, { year: 2025, semester: null, questions: [{ kp: 'A.1' }] }) }
  c = S.compare(db2, {}, 2025, { lt: 2025 }, 2)
  assert.equal(c.base.papers, 5, '目标只有「未填」学期 → 基线只取「未填」的 5 份'); assert.deepEqual(c.align.targetSemesters.map(x => x.name), ['未填'])
  assert.equal(c.align.dropped, 5)
  // 单一基线年份同样对齐；筛选里指定了学期则两侧都按它
  c = S.compare(db, {}, 2025, { eq: 2024 }, 2)
  assert.equal(c.base.papers, 10); // 此时目标上下都有
  const f = S.compare(db, { semester: '上' }, 2025, { lt: 2025 }, 2)
  assert.equal(f.target.papers, 5); assert.equal(f.base.papers, 5)
  // 总览的「本学年新增」也带上样本与口径提示
  const o = S.overview(db2, {})
  assert.deepEqual(o.newThisYear.limited, []); assert.equal(o.newThisYear.targetPapers, 5)
}

// ═════════ 合并节点、平均难度、更高层级的标注 ═════════
{
  const { db } = newDb()
  useTree(db, [...TREE, ['X', null, '已合并的旧节点', 1]])
  db.prepare("UPDATE kps SET merged_into = 'A.1.x' WHERE code = 'X'").run()
  addPaper(db, { questions: [{ kp: 'X', score: 4, difficulty: 2 }, { kp: 'A.1.y', score: 1, difficulty: null }, { kp: 'A.1.y', score: 1, difficulty: 4 }] })
  const d = S.distribution(db, {})
  // 标在已合并节点 X 上的题，汇总到它的合并目标 A.1.x 及其祖先；X 自己不出现
  assert.equal(byCode(d.nodes, 'X'), undefined)
  const x = byCode(d.nodes, 'A.1.x')
  assert.deepEqual([x.papers, x.questions, x.primQuestions, x.score], [1, 1, 1, 4])
  assert.deepEqual([byCode(d.nodes, 'A.1').questions, byCode(d.nodes, 'A').score], [3, 6])
  // 平均难度只算有难度的题：甲一y 两道题，一道难度空、一道 4 → 4，不是 2
  assert.equal(byCode(d.nodes, 'A.1.y').avgDifficulty, 4)
  // 主知识点标在更高层级的题：在二级视图里没有任何一行，重难点单独告知数量与分值（不静默丢掉）
  addPaper(db, { questions: [{ kp: 'A', score: 5 }, { kp: 'A.1', score: 3 }] })
  const h = S.hot(db, {}, 2)
  assert.deepEqual(h.higher, { questions: 1, score: 5 })
  assert.equal(h.total, 1, '二级只有甲一一个知识点出现'); assert.equal(h.rows.length, 1)
  assert.deepEqual(S.hot(db, {}, 1).higher, { questions: 0, score: 0 })
}

// 筛选候选值只来自会被计入的状态
{
  const { db } = newDb(); useTree(db, TREE)
  addPaper(db, { textbook: '人教PEP', region: '北京', year: 2024, questions: [{ kp: 'A.1' }] })
  addPaper(db, { status: 'reviewing', textbook: '只在待审核里的教材', region: '只在待审核里的地区', year: 2023, questions: [{ kp: 'A.1' }] })
  assert.deepEqual(S.filterOptions(db), { years: [2024], textbooks: ['人教PEP'], regions: ['北京'] })
  const o = S.filterOptions(db, { includeReviewing: true })
  assert.deepEqual(o.years, [2023, 2024]); assert.equal(o.textbooks.length, 2)
}

// ═════════ 筛选：年级 / 学期 / 学年 / 考试类型 / 教材 / 地区 ═════════
{
  const { db } = newDb()
  useTree(db, TREE)
  const mk = (over) => addPaper(db, { questions: [{ kp: 'A.1', score: 1 }], ...over })
  mk({ grade: '3', semester: '上', year: 2024, exam: '期中', textbook: '人教PEP', region: '北京' })
  mk({ grade: '4', semester: '上', year: 2025, exam: '期末', textbook: '人教PEP', region: '北京' })
  mk({ grade: '4', semester: '下', year: 2025, exam: '期末', textbook: '外研版', region: '上海' })
  mk({ grade: '4', semester: '下', year: 2025, exam: '单元测试', textbook: '外研版', region: '上海' })
  const n = f => S.distribution(db, f).papers
  assert.equal(n({}), 4)
  assert.equal(n({ grade: '4' }), 3)
  assert.equal(n({ grade: '4', semester: '下' }), 2)
  assert.equal(n({ school_year_start: 2024 }), 1)
  assert.equal(n({ exam_type: '期末' }), 2)
  assert.equal(n({ textbook: '外研版' }), 2)
  assert.equal(n({ region: '北京' }), 2)
  assert.equal(n({ grade: '4', semester: '下', exam_type: '期末', textbook: '外研版', region: '上海', school_year_start: 2025 }), 1, '全部条件叠加')
  assert.equal(n({ grade: '6' }), 0)
  const o = S.filterOptions(db)
  assert.deepEqual(o.years, [2024, 2025]); assert.deepEqual(o.textbooks, ['人教PEP', '外研版']); assert.deepEqual(o.regions, ['上海', '北京'].sort())
}

// ═════════ 同比 ═════════
function cmpDb() {
  const { db } = newDb()
  useTree(db, TREE)
  const P = (year, kps, extra = {}) => addPaper(db, { year, title: `${year}-${kps.join('')}`, questions: kps.map(k => ({ kp: k, score: 2 })), ...extra })
  // 基线：2023 年 2 份（y1 y2）+ 2024 年 3 份（y3 y4 y5），共 5 份
  P(2023, ['A.1', 'A.2', 'B.1'], { textbook: '人教PEP' })      // y1
  P(2023, ['A.1', 'B.1'], { textbook: '人教PEP' })             // y2
  P(2024, ['A.2', 'E.1'], { textbook: '人教PEP' })             // y3
  P(2024, ['E.1'], { textbook: '人教PEP' })                    // y4
  P(2024, ['E.1'], { textbook: '北师大版' })                   // y5
  // 目标 2025：5 份
  P(2025, ['A.1.x', 'A.2', 'B.1'])                             // t1  A.1 靠三级 A.1.x 汇总上来
  P(2025, ['A.1', 'B.1'])                                      // t2
  P(2025, ['A.1'])                                             // t3
  P(2025, ['D.1'], { textbook: '外研版' })                     // t4
  P(2025, ['C'], { textbook: '外研版' })                       // t5
  return db
}
{
  const db = cmpDb()
  const c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.equal(c.target.papers, 5); assert.equal(c.base.papers, 5)
  assert.deepEqual(c.base.years, [2023, 2024])
  assert.deepEqual(c.limited, [], '两侧都是 5 份，不算样本有限')
  const codes = k => c[k].map(i => i.code)
  // 甲一：目标 3/5=60%，基线 2/5=40%，恰好 +20 个百分点 → 上升（浮点相减会得到 0.19999999999999996 而漏掉）
  assert.deepEqual(codes('up'), ['A.1'])
  assert.equal(c.up[0].deltaPP, 20); assert.deepEqual([c.up[0].aT, c.up[0].nT, c.up[0].aB, c.up[0].nB], [3, 5, 2, 5])
  // 甲二：目标 1/5=20%，基线 2/5=40%，恰好 −20 → 下降
  assert.deepEqual(codes('down'), ['A.2'])
  assert.equal(c.down[0].deltaPP, -20)
  // 乙一：2/5 对 2/5，不变；丁一 只在目标 → 新增；戊一 只在基线 → 消失
  assert.deepEqual(codes('added'), ['D.1', 'C'].filter(x => x !== 'C'), '二级层只有丁一是新增（丙是一级节点）')
  assert.deepEqual(codes('removed'), ['E.1'])
  assert.equal(c.removed[0].aB, 3); assert.equal(c.added[0].aT, 1)
  assert.equal(c.up[0].questionsT, 3, '甲一目标侧题数（t1 的是三级 A.1.x 汇总上来的）')
  close(c.up[0].scoreShareT, 6 / 16, '甲一目标侧分值占比：t1/t2/t3 各 2 分共 6 分；目标侧总分 6+4+2+2+2 = 16')
  assert.ok(c.up[0].samples.length >= 1 && c.up[0].samples.length <= 3)
  assert.ok(c.removed[0].samples.every(s => s.paperTitle.startsWith('2024')), '消失的知识点，样本题取自基线侧')
  // 教材版本分布
  assert.deepEqual(c.target.textbooks, [{ name: '人教PEP', papers: 3 }, { name: '外研版', papers: 2 }])
  assert.deepEqual(c.base.textbooks, [{ name: '人教PEP', papers: 4 }, { name: '北师大版', papers: 1 }])
  assert.deepEqual(c.availableYears, [2023, 2024, 2025])

  // 一级视角：甲 = 甲一 ∪ 甲二：目标 t1 t2 t3 = 3，基线 y1 y2 y3 = 3 → 不变；丙只在目标 → 新增
  const c1 = S.compare(db, {}, 2025, { lt: 2025 }, 1)
  assert.deepEqual(c1.up.concat(c1.down).map(i => i.code), [])
  assert.deepEqual(c1.added.map(i => i.code).sort(), ['C', 'D'])
  assert.deepEqual(c1.removed.map(i => i.code), ['E'])

  // 基线只选 2024 一年（3 份，且 3<5 → 基线样本有限）
  const c2 = S.compare(db, {}, 2025, { eq: 2024 }, 2)
  assert.equal(c2.base.papers, 3); assert.deepEqual(c2.limited, ['base'])
  assert.deepEqual(c2.base.years, [2024])
  // 甲一 基线 0 → 新增；乙一 基线 0 → 新增；甲二 基线 1/3=33.3% 对 目标 20% → −13.3，不够 20 → 无变化
  assert.deepEqual(c2.added.map(i => i.code).sort(), ['A.1', 'B.1', 'D.1'])
  assert.deepEqual(c2.down.map(i => i.code), [])
  assert.deepEqual(c2.removed.map(i => i.code), ['E.1'])
  assert.equal(c2.base.label, '2024-2025学年')
}

// 样本量边界：目标 4 份 → 有限；再加 1 份到 5 份 → 不再有限
{
  const { db } = newDb()
  useTree(db, TREE)
  const add = (year) => addPaper(db, { year, questions: [{ kp: 'A.1', score: 1 }] })
  for (let i = 0; i < 5; i++) add(2024)
  for (let i = 0; i < 4; i++) add(2025)
  let c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.deepEqual(c.limited, ['target'], '目标 4 份：样本有限')
  add(2025)
  c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.deepEqual(c.limited, [], '目标 5 份：不再有限')
  // 基线 4 份
  const { db: db2 } = newDb(); useTree(db2, TREE)
  for (let i = 0; i < 4; i++) addPaper(db2, { year: 2024, questions: [{ kp: 'A.1' }] })
  for (let i = 0; i < 5; i++) addPaper(db2, { year: 2025, questions: [{ kp: 'A.1' }] })
  assert.deepEqual(S.compare(db2, {}, 2025, { lt: 2025 }, 2).limited, ['base'])
}

// 混入不同年级 / 考试类型 → 提示；某一侧没有卷子 → empty，四栏为空
{
  const { db } = newDb()
  useTree(db, TREE)
  addPaper(db, { year: 2024, grade: '4', exam: '期末', questions: [{ kp: 'A.1' }] })
  addPaper(db, { year: 2025, grade: '5', exam: '期中', questions: [{ kp: 'A.1' }] })
  const c = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  assert.deepEqual(c.mixed, ['混入了不同年级的试卷', '混入了不同考试类型的试卷'])
  const e = S.compare(db, {}, 2025, { eq: 2019 }, 2)
  assert.equal(e.empty, true); assert.equal(e.added.length + e.removed.length + e.up.length + e.down.length, 0)
  // 同比忽略筛选里的学年（由目标/基线决定），但其它条件照常生效
  const g = S.compare(db, { school_year_start: 2030, grade: '5' }, 2025, { lt: 2025 }, 2)
  assert.equal(g.target.papers, 1); assert.equal(g.base.papers, 0)
  // 没填学年的卷子不进同比
  addPaper(db, { year: null, questions: [{ kp: 'D.1' }] })
  assert.equal(S.compare(db, {}, 2025, { lt: 2025 }, 2).base.papers, 1)
  assert.equal(S.distribution(db, {}).noYear, 1)
}

// 总览：数字卡、Top 10（二级）、本学年新增、最近导入
{
  const db = cmpDb()
  addPaper(db, { title: '待审核', status: 'reviewing', year: 2025, questions: [{ kp: 'B.1' }] })
  const o = S.overview(db, {})
  assert.equal(o.cards.papers, 10); assert.equal(o.cards.questions, 17, '基线 3+2+2+1+1 + 目标 3+2+1+1+1')
  // 被直接标注过的知识点：A.1 A.1.x A.2 B.1 C D.1 E.1 = 7
  assert.equal(o.cards.kps, 7)
  assert.equal(o.cards.pending, 1)
  // 二级 Top：甲一 6 份（y1 y2 + t1 t2 t3 = 5？）—— 手算：A.1 出现在 y1 y2 t1 t2 t3 = 5 份；B.1：y1 y2 t1 t2 = 4；A.2：y1 y3 t1 = 3；E.1：y3 y4 y5 = 3；D.1：1
  assert.deepEqual(o.top.map(t => [t.code, t.papers]), [['A.1', 5], ['B.1', 4], ['A.2', 3], ['E.1', 3], ['D.1', 1]])
  close(o.top[0].rate, 0.5, 'Top1 出现率 5/10')
  // 本学年 = 范围内最新学年 2025；二级新增只有丁一
  assert.equal(o.newThisYear.year, 2025); assert.deepEqual(o.newThisYear.items.map(i => i.code), ['D.1'])
  assert.equal(o.recent.length, 8); assert.equal(o.recent[0].title, '待审核', '最近导入按创建时间倒序，包含待审核')
  // 只有一个学年：没有可比的基线
  const only = S.overview(db, { school_year_start: 2023 })
  assert.equal(only.newThisYear.reason, '没有更早学年的试卷可比')
}

// 迁移 v6：新增的索引与缓存表；v7：数据修订号与触发器；v8：触发器加 WHEN 条件
{
  const { db, version } = newDb()
  assert.equal(version, 9)
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
  for (const n of ['idx_question_kps_kp', 'idx_papers_stats', 'idx_questions_paper_qtype']) assert.ok(idx.includes(n), `缺索引 ${n}`)
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM question_kps WHERE kp_code = 'A'`).all().map(r => r.detail).join(' ')
  assert.match(plan, /idx_question_kps_kp/, '按知识点查题走索引')
  // v7：对 papers / questions / question_kps / kps / qtypes 的任何增、改、删都让数据修订号 +1；别的表（pages、ai_analyses、settings）不影响
  const rev = () => db.prepare('SELECT rev FROM data_rev WHERE id = 1').get().rev
  const bumps = (label, fn) => { const r0 = rev(); fn(); assert.ok(rev() > r0, `${label} 应让修订号增加`) }
  const calm = (label, fn) => { const r0 = rev(); fn(); assert.equal(rev(), r0, `${label} 不应改变修订号`) }
  useTree(db, [['A', null, '甲', 1]])
  const pid = addPaper(db, { questions: [{ kp: 'A', score: 1 }] })
  const qid = db.prepare('SELECT id FROM questions WHERE paper_id = ?').get(pid).id
  bumps('更新 papers', () => db.prepare("UPDATE papers SET status = 'reviewing' WHERE id = ?").run(pid))
  bumps('更新 questions', () => db.prepare('UPDATE questions SET score = 9 WHERE id = ?').run(qid))
  bumps('更新 question_kps', () => db.prepare("UPDATE question_kps SET is_primary = 1 WHERE question_id = ?").run(qid))
  bumps('更新 kps', () => db.prepare("UPDATE kps SET name = '甲改' WHERE code = 'A'").run())
  bumps('更新 qtypes', () => db.prepare("UPDATE qtypes SET name = name || ' ' WHERE code = 'MC'").run())
  bumps('插入 kps', () => db.prepare("INSERT INTO kps (code, parent_code, name, level) VALUES ('Z', NULL, 'z', 1)").run())
  bumps('删除 question_kps', () => db.prepare('DELETE FROM question_kps WHERE question_id = ?').run(qid))
  bumps('删除 papers（级联删题）', () => db.prepare('DELETE FROM papers WHERE id = ?').run(pid))
  calm('写 settings', () => db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('x', '1')").run())
  calm('写 ai_analyses', () => db.prepare("INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES ('k','c','v','f','{}','m')").run())
}

// ═════════ v8：修订号只在「会影响统计」的写入时推高（复审 P1-A） ═════════
{
  const { db } = newDb()
  useTree(db, [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2]])
  const rev = () => db.prepare('SELECT rev FROM data_rev WHERE id = 1').get().rev
  const bumps = (label, fn) => { const r0 = rev(); fn(); assert.ok(rev() > r0, `${label}：修订号应增加`) }
  const calm = (label, fn) => { const r0 = rev(); fn(); assert.equal(rev(), r0, `${label}：修订号不应变化`) }
  // ① 别的卷子在导入：状态 imported → extracting → extracted → parsing，期间写页面、写题、写标注、改进度——都不应让同比页反复重算
  let pid
  calm('新建一份「刚导入」的卷子', () => { pid = addPaper(db, { status: 'imported', questions: [] }) })
  for (const st of ['extracting', 'extracted', 'parsing']) calm(`状态 → ${st}`, () => db.prepare('UPDATE papers SET status = ? WHERE id = ?').run(st, pid))
  calm('写进度、错误、解析阶段、AI 模型等字段', () => db.prepare("UPDATE papers SET parse_stage = 'ai', error = NULL, warning = 'w', page_count = 3, ai_model = 'm', extracted_at = 'x' WHERE id = ?").run(pid))
  const ik = db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, 1)')
  const qid = '00000000-0000-4000-8000-0000000000aa'
  calm('解析阶段给这份卷子写题', () => db.prepare("INSERT INTO questions (id, paper_id, ord, qtype, score) VALUES (?, ?, 1, 'MC', 2)").run(qid, pid))
  calm('解析阶段给题写知识点标注', () => ik.run(qid, 'A.1'))
  calm('解析阶段改题', () => db.prepare('UPDATE questions SET stem = ? WHERE id = ?').run('x', qid))
  calm('提取失败 parsing → failed', () => db.prepare("UPDATE papers SET status = 'failed' WHERE id = ?").run(pid))
  calm('failed → imported（重试）', () => db.prepare("UPDATE papers SET status = 'imported' WHERE id = ?").run(pid))
  // ② 状态在「计入」与「不计入」之间切换：必须推高（不管哪个方向）
  db.prepare("UPDATE papers SET status = 'parsing' WHERE id = ?").run(pid)
  bumps('parsing → reviewing（开始计入）', () => db.prepare("UPDATE papers SET status = 'reviewing' WHERE id = ?").run(pid))
  bumps('reviewing → done', () => db.prepare("UPDATE papers SET status = 'done' WHERE id = ?").run(pid))
  bumps('done → reviewing（审核里改了内容）', () => db.prepare("UPDATE papers SET status = 'reviewing' WHERE id = ?").run(pid))
  bumps('reviewing → parsing（重新解析，离开统计）', () => db.prepare("UPDATE papers SET status = 'parsing' WHERE id = ?").run(pid))
  db.prepare("UPDATE papers SET status = 'done' WHERE id = ?").run(pid)
  // ③ 已计入的卷子：统计会用到的列、题、标注的任何变动都推高
  for (const [col, v] of [['grade', '5'], ['semester', '下'], ['school_year_start', 2030], ['exam_type', '期中'], ['textbook', '别的教材'], ['region', '别处'], ['file_hash', 'new-hash'], ['title', '新标题']])
    bumps(`改已计入卷子的 ${col}`, () => db.prepare(`UPDATE papers SET ${col} = ? WHERE id = ?`).run(v, pid))
  bumps('改已计入卷子的题', () => db.prepare('UPDATE questions SET score = 5 WHERE id = ?').run(qid))
  bumps('改已计入卷子的标注', () => db.prepare('UPDATE question_kps SET is_primary = 0 WHERE question_id = ?').run(qid))
  bumps('给已计入卷子加题', () => db.prepare("INSERT INTO questions (id, paper_id, ord, qtype) VALUES ('00000000-0000-4000-8000-0000000000ab', ?, 2, 'MC')").run(pid))
  bumps('给已计入卷子的题加标注', () => ik.run('00000000-0000-4000-8000-0000000000ab', 'A.1'))
  bumps('删已计入卷子的标注', () => db.prepare("DELETE FROM question_kps WHERE question_id = '00000000-0000-4000-8000-0000000000ab'").run())
  bumps('删已计入卷子的题', () => db.prepare("DELETE FROM questions WHERE id = '00000000-0000-4000-8000-0000000000ab'").run())
  // ④ 不计入的卷子：题、标注、统计列的变动都不推高；删它也不推高
  const other = addPaper(db, { status: 'extracted', questions: [{ kp: 'A.1', score: 1 }] })
  const oq = db.prepare('SELECT id FROM questions WHERE paper_id = ?').get(other).id
  calm('改不计入卷子的题', () => db.prepare('UPDATE questions SET score = 9 WHERE id = ?').run(oq))
  calm('改不计入卷子的标注', () => db.prepare('UPDATE question_kps SET is_primary = 0 WHERE question_id = ?').run(oq))
  calm('改不计入卷子的年级、学期、哈希', () => db.prepare("UPDATE papers SET grade = '2', semester = '上', file_hash = 'zz' WHERE id = ?").run(other))
  calm('删不计入的卷子（连带删题与标注）', () => db.prepare('DELETE FROM papers WHERE id = ?').run(other))
  // ⑤ 新增已确认的卷子、删除已计入的卷子：推高；知识点树、题型表：照旧推高
  bumps('新增一份已确认的卷子', () => addPaper(db, { status: 'done', questions: [{ kp: 'A.1' }] }))
  bumps('删除已计入的卷子', () => db.prepare('DELETE FROM papers WHERE id = ?').run(pid))
  bumps('改知识点树', () => db.prepare("UPDATE kps SET name = '甲改' WHERE code = 'A'").run())
  bumps('改题型表', () => db.prepare("UPDATE qtypes SET name = name || '.' WHERE code = 'MC'").run())
}

// ═════════ 「含待审核」横幅的份数：按去重后实际计入的待审核卷来数（三审 P2-1） ═════════
// K1 待审核原件 + K1d 已确认副本（同一个文件）+ R1 待审核（独立的文件）：
// 打开「含待审核」后实际计入 {K1d, R1}，其中待审核只有 R1 一份；K1 让位给已确认的副本，不能算成「2 份待审核已计入」
{
  const { db } = newDb()
  useTree(db, TREE)
  const k1 = addPaper(db, { title: 'K1', status: 'reviewing', hash: 'HK', created: '2026-01-01 10:00:00', grade: '2', questions: [{ kp: 'A.1', score: 2 }] })
  addPaper(db, { title: 'K1d', status: 'done', hash: 'HK', dup: k1, created: '2026-01-02 10:00:00', grade: '2', questions: [{ kp: 'A.1', score: 2 }] })
  addPaper(db, { title: 'R1', status: 'reviewing', hash: 'HR1', created: '2026-01-03 10:00:00', grade: '2', questions: [{ kp: 'B.1', score: 2 }] })
  const off = S.scopeNotes(db, { grade: '2' })
  assert.equal(off.reviewing, 2, '待审核总数（开关旁的数字）= 2'); assert.equal(off.reviewingCounted, 0); assert.equal(off.reviewingSuperseded, 0)
  assert.equal(off.pendingReviewing, 2, '关着开关时「没计入」的待审核是 2 份')
  const on = S.scopeNotes(db, { grade: '2', includeReviewing: true })
  assert.equal(on.reviewing, 2)
  assert.equal(on.reviewingCounted, 1, '实际计入的待审核只有 R1')
  assert.equal(on.reviewingSuperseded, 1, 'K1 因已确认的副本 K1d 作代表而没有重复计入')
  assert.equal(S.distribution(db, { grade: '2', includeReviewing: true }).papers, 2, '统计里确实是 K1d + R1 两份')
  // 打开「包含重复导入」后 K1 也计入：待审核计入 2 份、没有被让位的
  const dup = S.scopeNotes(db, { grade: '2', includeReviewing: true, includeDuplicates: true })
  assert.equal(dup.reviewingCounted, 2); assert.equal(dup.reviewingSuperseded, 0)
  // 两份待审核互为副本：只计一份，另一份算让位
  const r2 = addPaper(db, { title: 'R2', status: 'reviewing', hash: 'HR2', created: '2026-01-01 10:00:00', grade: '3', questions: [{ kp: 'A.1' }] })
  addPaper(db, { title: 'R2d', status: 'reviewing', hash: 'HR2', dup: r2, created: '2026-01-02 10:00:00', grade: '3', questions: [{ kp: 'A.1' }] })
  const two = S.scopeNotes(db, { grade: '3', includeReviewing: true })
  assert.equal(two.reviewing, 2); assert.equal(two.reviewingCounted, 1); assert.equal(two.reviewingSuperseded, 1)
}

// ═════════ 触发器的列清单要跟得上 papers 表（三审 P2-4） ═════════
// 将来往 papers 加了列：要么它会影响统计（必须加进 v8 触发器的 UPDATE OF 列清单），要么明确登记到下面的「不影响统计」名单里。
// 新增列没登记 → 这里报错，提醒去看一眼触发器，免得修订号静默漏推高。
{
  const { db } = newDb()
  const cols = db.prepare('PRAGMA table_info(papers)').all().map(c => c.name)
  const trg = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_rev_papers_u'").get().sql
  const m = /AFTER UPDATE OF ([^\n]+?) ON papers/.exec(trg)
  assert.ok(m, '找得到 papers 更新触发器的列清单')
  const watched = m[1].split(',').map(x => x.trim())
  const NOT_STATS = ['id', 'school', 'total_score', 'file_name', 'error', 'page_count', 'ai_model', 'extracted_at', 'warning', 'duplicate_of', 'prompt_version', 'ai_meta_json', 'parse_stage', 'error_stage', 'parsed_at']
  const unlisted = cols.filter(c => !watched.includes(c) && !NOT_STATS.includes(c))
  assert.deepEqual(unlisted, [], `papers 新增了列 ${unlisted.join('、')}：它影响统计吗？影响 → 加进 v8 触发器 trg_rev_papers_u 的 UPDATE OF 列清单（新迁移里重建）；不影响 → 登记到本测试的 NOT_STATS`)
  const ghost = watched.filter(c => !cols.includes(c))
  assert.deepEqual(ghost, [], '触发器列清单里的列都真实存在')
  assert.deepEqual(NOT_STATS.filter(c => !cols.includes(c)), [], '「不影响统计」名单里的列都真实存在（列被删了要同步删名单）')
  assert.deepEqual(watched.filter(c => NOT_STATS.includes(c)), [], '同一列不能既被监听又登记为不影响统计')
  // 反过来：统计代码里用到的 papers 列（筛选与排序）都必须被监听
  for (const c of ['status', 'grade', 'semester', 'school_year_start', 'exam_type', 'textbook', 'region', 'file_hash', 'created_at', 'title']) assert.ok(watched.includes(c), `统计用到的列 ${c} 被监听`)
}

// ═════════ 抽屉取题的范围 drawerScope：三种 side（三审 P2-5） ═════════
{
  const { db } = newDb()
  useTree(db, TREE)
  const P_ = (year, semester, kps, n = 1, extra = {}) => { for (let i = 0; i < n; i++) addPaper(db, { year, semester, ...extra, questions: kps.map(k => ({ kp: k, score: 2 })) }) }
  P_(2025, '上', ['A.1'], 3)
  P_(2024, '上', ['A.1', 'B.1'], 2); P_(2024, '下', ['B.1'], 3)
  P_(2023, '下', ['B.1'], 1)
  const cards = (side, code, f = {}) => S.questionsOfKp(db, S.drawerScope(db, f, side), code, 100).length
  // year：只看那一学年
  assert.equal(cards({ kind: 'year', year: 2025 }, 'A.1'), 3)
  assert.equal(cards({ kind: 'year', year: 2024 }, 'B.1'), 5)
  // base：与 sideScopes 的 sB 完全一致；对齐只取上学期（2024 上 2 份含 B.1），不对齐取全部（2+3+1）
  assert.equal(cards({ kind: 'base', target: 2025, base: 'before', align: true }, 'B.1'), 2)
  assert.equal(cards({ kind: 'base', target: 2025, base: 'before', align: false }, 'B.1'), 6)
  assert.equal(cards({ kind: 'base', target: 2025, base: 2024, align: true }, 'B.1'), 2)
  assert.equal(cards({ kind: 'base', target: 2025, base: 2024, align: false }, 'B.1'), 5)
  for (const align of [true, false]) {
    const sb = S.sideScopes(db, {}, 2025, { lt: 2025 }, align).sB
    assert.deepEqual(S.drawerScope(db, {}, { kind: 'base', target: 2025, base: 'before', align }), sb, `drawerScope 的基线范围 = sideScopes.sB（align=${align}）`)
  }
  // filter：当前筛选范围；筛选里的维度照常生效
  assert.equal(cards({ kind: 'filter' }, 'B.1'), 6)
  assert.equal(cards({ kind: 'filter' }, 'B.1', { semester: '下' }), 4)
}

console.log('stats-core.test ✓')
