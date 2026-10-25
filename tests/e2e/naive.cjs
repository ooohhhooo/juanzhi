// 独立于应用 SQL 的「笨办法」统计：直接对夹具 SPEC 逐卷、逐题、逐节点循环计数。
// E2E 里拿它和界面/接口上的数字比对；写法故意和应用里的 SQL 聚合不同（没有 CTE、没有 GROUP BY）。
const { SPEC } = require('./fixtures-m3.cjs')

function makeTree(kpRows) {
  const parent = new Map(kpRows.map(k => [k.code, k.parent_code]))
  const level = new Map(kpRows.map(k => [k.code, k.level]))
  const name = new Map(kpRows.map(k => [k.code, k.name]))
  const chain = code => { const out = []; let c = code; while (c) { out.push(c); c = parent.get(c) } return out }
  return { parent, level, name, chain }
}

/**
 * 计入统计的卷子：状态（默认只 done；includeReviewing 加上 reviewing）+ 维度筛选 + extra 条件；
 * 同一个文件的多份（副本与原件 hash 相同；__missing__ 的副本自己独占）默认只留代表卷（可见的几份里已确认的优先，同状态取最早导入的），includeDuplicates 才全算。
 * SPEC 的先后顺序就是导入的先后顺序。
 */
function counted(filter = {}, extra = () => true) {
  const visible = SPEC.filter(p => {
    if (!(p.status === 'done' || (filter.includeReviewing && p.status === 'reviewing'))) return false
    if (filter.grade && p.grade !== filter.grade) return false
    if (filter.semester && p.semester !== filter.semester) return false
    if (filter.school_year_start && p.year !== filter.school_year_start) return false
    if (filter.exam_type && p.exam !== filter.exam_type) return false
    if (filter.textbook && p.textbook !== filter.textbook) return false
    if (filter.region && p.region !== filter.region) return false
    return extra(p)
  })
  if (filter.includeDuplicates) return visible
  const hashOf = p => (p.dupOf && p.dupOf !== '__missing__' ? p.dupOf : p.key)
  // 代表卷：已确认（done）的优先，同一状态里取最早导入的（SPEC 的先后顺序就是导入顺序）
  const rep = new Map()
  for (const p of visible) { const h = hashOf(p), cur = rep.get(h); if (!cur || (cur.status !== 'done' && p.status === 'done')) rep.set(h, p) }
  return visible.filter(p => rep.get(hashOf(p)) === p)
}

/** 每个节点：出现的卷子集合、题集合、主知识点分值 */
function nodeTable(tree, papers) {
  const t = new Map()
  const get = c => { if (!t.has(c)) t.set(c, { papers: new Set(), qs: new Set(), prim: 0, primScore: 0, scoredPrim: 0, err: 0, diffSum: 0, diffN: 0 }); return t.get(c) }
  for (const p of papers) {
    p.q.forEach((q, j) => {
      const qid = `${p.key}Q${j + 1}`
      const touched = new Set()
      for (const code of [q.kp, ...q.sec]) for (const a of tree.chain(code)) touched.add(a)
      for (const a of touched) {
        const e = get(a)
        e.papers.add(p.key); e.qs.add(qid)
        if (q.diff != null) { e.diffSum += q.diff; e.diffN++ }
        if (q.reason) e.err++
      }
      // 主知识点：分值只在主知识点的祖先链上计一次
      for (const a of new Set(tree.chain(q.kp))) {
        const e = get(a)
        e.prim++
        if (q.score != null) { e.primScore += q.score; e.scoredPrim++ }
      }
    })
  }
  return t
}

function totals(papers) {
  let questions = 0, scored = 0, totalScore = 0
  for (const p of papers) for (const q of p.q) { questions++; if (q.score != null) { scored++; totalScore += q.score } }
  return { papers: papers.length, questions, scored, totalScore }
}

function hot(tree, papers, level) {
  const tot = totals(papers)
  const t = nodeTable(tree, papers)
  const rows = []
  for (const [code, e] of t) {
    if (tree.level.get(code) !== level) continue
    const rate = e.papers.size / tot.papers
    const share = tot.scored > 0 ? e.primScore / tot.totalScore : e.prim / tot.questions
    const errRate = e.err / e.qs.size
    rows.push({ code, rate, share, errRate, priority: rate * share * (1 + 1.0 * errRate), papers: e.papers.size, questions: e.qs.size })
  }
  return rows.sort((a, b) => b.priority - a.priority || b.rate - a.rate || (a.code < b.code ? -1 : 1))
}

/** 同比：base = 'before' 或某一年；align = 基线只取目标学年里出现过的学期（默认） */
function compare(tree, filter, target, base, level, align = true) {
  const f = { ...filter, school_year_start: undefined }
  const T = counted(f, p => p.year === target)
  const sems = new Set(T.map(p => p.semester ?? ''))
  const B = counted(f, p => p.year != null && (base === 'before' ? p.year < target : p.year === base) && (!align || T.length === 0 || sems.has(p.semester ?? '')))
  const tt = nodeTable(tree, T), tb = nodeTable(tree, B)
  const out = { added: [], removed: [], up: [], down: [], nT: T.length, nB: B.length }
  const codes = new Set([...tt.keys(), ...tb.keys()])
  for (const code of codes) {
    if (tree.level.get(code) !== level) continue
    const aT = tt.get(code)?.papers.size ?? 0, aB = tb.get(code)?.papers.size ?? 0
    if (aT > 0 && aB === 0) out.added.push({ code, aT, aB })
    else if (aT === 0 && aB > 0) out.removed.push({ code, aT, aB })
    else if (aT > 0 && aB > 0) {
      // 用整数比较避免浮点：100×(aT×nB − aB×nT) ≥ 20×nT×nB
      const d = 100 * (aT * B.length - aB * T.length), bar = 20 * T.length * B.length
      const dpp = Math.round((aT / T.length - aB / B.length) * 1000) / 10
      if (d >= bar) out.up.push({ code, aT, aB, dpp })
      else if (-d >= bar) out.down.push({ code, aT, aB, dpp })
    }
  }
  return out
}

module.exports = { makeTree, counted, nodeTable, totals, hot, compare }
