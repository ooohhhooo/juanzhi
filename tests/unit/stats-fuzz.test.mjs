// 随机对拍：随机造库（重复文件、各种状态、上/下/空学期、多个学年与年级、次知识点），
// 用「逐卷逐题逐节点循环、不共用任何 SQL」的朴素实现算出期望，与 core.ts 逐项比对：
// 计入的卷数、每个二级知识点的出现份数、同比两侧份数 / 被学期对齐排除的份数 / 四栏的集合。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'

const TREE = [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.1.x', 'A.1', 'x', 3], ['A.1.y', 'A.1', 'y', 3], ['A.2', 'A', '甲二', 2], ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2], ['C', null, '丙', 1]]
const PARENT = Object.fromEntries(TREE.map(t => [t[0], t[1]]))
const LEVEL = Object.fromEntries(TREE.map(t => [t[0], t[3]]))
const LEAVES = ['A.1.x', 'A.1.y', 'A.2', 'B.1', 'C']
const chain = c => { const o = []; for (let x = c; x; x = PARENT[x]) o.push(x); return o }

let seed = 20261026
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = a => a[Math.floor(rnd() * a.length)]

// 朴素的「计入的卷子」：状态 + 维度筛选；同一 hash 的多份只留（done 优先 → 最早导入 → 先插入）的那份
function counted(papers, f, extra = () => true) {
  const vis = papers.filter(p => (p.status === 'done' || (f.includeReviewing && p.status === 'reviewing')) && (!f.grade || p.grade === f.grade) && (!f.semester || p.semester === f.semester) && extra(p))
  if (f.includeDuplicates) return vis
  const best = new Map()
  for (const p of vis) {
    const cur = best.get(p.hash)
    const rank = q => [q.status === 'done' ? 0 : 1, q.idx]
    if (!cur || rank(p)[0] < rank(cur)[0] || (rank(p)[0] === rank(cur)[0] && p.idx < cur.idx)) best.set(p.hash, p)
  }
  return vis.filter(p => best.get(p.hash) === p)
}
const appear = (ps, level) => {
  const m = new Map()
  for (const p of ps) {
    const seen = new Set()
    for (const q of p.qs) for (const k of [q.kp, ...q.sec]) for (const a of chain(k)) if (LEVEL[a] === level) seen.add(a)
    for (const a of seen) m.set(a, (m.get(a) ?? 0) + 1)
  }
  return m
}
function classify(aT, nT, aB, nB) {
  if (nT <= 0 || nB <= 0) return null
  if (aT > 0 && aB === 0) return 'added'
  if (aT === 0 && aB > 0) return 'removed'
  if (aT === 0) return null
  const d = 100 * (aT * nB - aB * nT), bar = 20 * nT * nB
  return d >= bar ? 'up' : -d >= bar ? 'down' : null
}

let checks = 0
for (let iter = 0; iter < 120; iter++) {
  const { db } = newDb()
  useTree(db, TREE)
  const papers = []
  const n = 8 + Math.floor(rnd() * 18)
  const hashes = Array.from({ length: Math.max(3, Math.floor(n * 0.6)) }, (_, i) => `H${i}`)
  for (let i = 0; i < n; i++) {
    const p = { idx: i, status: pick(['done', 'done', 'done', 'reviewing', 'failed', 'imported']), grade: pick(['4', '5']), semester: pick(['上', '下', null]), year: pick([2023, 2024, 2025, 2025]), hash: pick(hashes), qs: [] }
    const nq = 1 + Math.floor(rnd() * 3)
    for (let j = 0; j < nq; j++) p.qs.push({ kp: pick(LEAVES), sec: rnd() < 0.3 ? [pick(LEAVES)] : [], score: rnd() < 0.2 ? null : 1 + Math.floor(rnd() * 4) })
    p.qs.forEach(q => { q.sec = q.sec.filter(s => s !== q.kp) })
    papers.push(p)
    addPaper(db, { status: p.status, grade: p.grade, semester: p.semester, year: p.year, hash: p.hash, created: `2026-01-01 10:${String(i).padStart(2, '0')}:00`, questions: p.qs.map(q => ({ kp: q.kp, sec: q.sec, score: q.score })) })
  }
  for (const f of [{}, { includeReviewing: true }, { includeDuplicates: true }, { includeReviewing: true, includeDuplicates: true }, { grade: '4' }, { semester: '上', includeReviewing: true }]) {
    const want = counted(papers, f)
    const d = S.distribution(db, f)
    assert.equal(d.papers, want.length, `迭代 ${iter} 筛选 ${JSON.stringify(f)}：计入卷数`)
    const wa = appear(want, 2)
    for (const code of ['A.1', 'A.2', 'B.1']) assert.equal(d.nodes.find(x => x.code === code)?.papers ?? 0, wa.get(code) ?? 0, `迭代 ${iter} ${JSON.stringify(f)} 节点 ${code} 出现份数`)
    checks += 4

    for (const align of [true, false]) {
      const T = counted(papers, f, p => p.year === 2025)
      const sems = new Set(T.map(p => p.semester ?? ''))
      const Ball = counted(papers, f, p => p.year != null && p.year < 2025)
      // 「可见」包含学期对齐这一条件：去重是在对齐后的范围里选代表（与应用一致，也是复审手算 D4 的口径）
      const B = align && T.length ? counted(papers, f, p => p.year != null && p.year < 2025 && sems.has(p.semester ?? '')) : Ball
      const c = S.compare(db, f, 2025, { lt: 2025 }, 2, 0, align)
      assert.equal(c.target.papers, T.length, `迭代 ${iter} 对齐=${align} 目标份数`)
      assert.equal(c.base.papers, B.length, `迭代 ${iter} 对齐=${align} 基线份数`)
      assert.equal(c.align.dropped, align && T.length ? Ball.length - B.length : 0, `迭代 ${iter} 对齐=${align} 被排除的基线份数`)
      assert.deepEqual(c.base.years, [...new Set(B.map(p => p.year))].sort(), `迭代 ${iter} 基线学年只列有卷子的`)
      const aT = appear(T, 2), aB = appear(B, 2)
      const wantSets = { added: [], removed: [], up: [], down: [] }
      for (const code of new Set([...aT.keys(), ...aB.keys()])) { const k = classify(aT.get(code) ?? 0, T.length, aB.get(code) ?? 0, B.length); if (k) wantSets[k].push(code) }
      for (const k of ['added', 'removed', 'up', 'down']) assert.deepEqual(c[k].map(i => i.code).sort(), wantSets[k].sort(), `迭代 ${iter} ${JSON.stringify(f)} 对齐=${align} ${k}`)
      // 抽屉卡片与表格同源：基线侧每个知识点的卡片数（每份卷子最多取其全部题）≥ 份数，且来自 B 里的卷子（用共用函数的范围）
      const sc = S.sideScopes(db, f, 2025, { lt: 2025 }, align)
      for (const code of ['A.1', 'B.1']) {
        const cards = S.questionsOfKp(db, sc.sB, code, 1000)
        const ids = new Set(cards.map(q => q.paper_id))
        assert.equal(ids.size, aB.get(code) ?? 0, `迭代 ${iter} 对齐=${align} 抽屉里 ${code} 的基线卷子数 = 表格上的份数`)
        checks++
      }
      checks += 6
    }
  }
}
console.log(`stats-fuzz.test ✓ 120 个随机库、${checks} 项对拍`)
