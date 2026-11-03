// 通用统计函数与工具定义的单测。期望值全部是手算（或教科书已知值）的，不拿被测代码再算一遍。测试数据全部虚构。
import assert from 'node:assert/strict'
import * as S from '../../src/main/analysis/stats/core.ts'
import { normCdf, normQuantile, tTwoSidedP, wilson } from '../../src/main/analysis/stats/math.ts'
import { statTools } from '../../src/main/analysis/stats/tools.ts'

const close = (a, b, msg, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${msg}：${a} ≠ ${b}`)
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i))

// ───── 数学 ─────
close(normCdf(0), 0.5, 'Φ(0)')
close(normCdf(1.96), 0.975, 'Φ(1.96)', 1e-4)
close(normQuantile(0.975), 1.95996, 'z0.975', 1e-4)
close(tTwoSidedP(2, 8), 0.0805, 't=2,df=8 双侧 p', 5e-4)
close(tTwoSidedP(0, 10), 1, 't=0')
const w = wilson(50, 100)
close(w.low, 0.4038, 'Wilson 下限'); close(w.high, 0.5962, 'Wilson 上限')

// ───── NPS ─────
{
  const r = S.nps([10, 9, 9, 8, 7, 6, 3, 10, 9, 5, '', null, 'abc'])
  assert.equal(r.n, 10); assert.equal(r.invalid, 1)
  assert.equal(r.promoters, 5); assert.equal(r.passives, 2); assert.equal(r.detractors, 3)
  assert.equal(r.nps, 20); assert.equal(r.promoterPct, 50); assert.equal(r.smallSample, true)
  assert.match(r.text, /NPS 为 20\.0/); assert.match(r.text, /样本/)
  // 自定义分段：5 分制，≥5 推荐，≥4 中立
  const c = S.nps([5, 5, 4, 3, 1], { promoterMin: 5, passiveMin: 4, segments: [{ label: '低', min: 1, max: 2 }, { label: '高', min: 4, max: 5 }] })
  assert.equal(c.nps, 0) // 2 推荐 − 2 贬损（3、1）
  assert.deepEqual(c.segments.map(s => s.count), [1, 3])
  assert.equal(S.nps([]).nps, null)
}

// ───── 检验 ─────
{
  const z = S.twoPropZ(60, 100, 40, 100)
  close(z.stat, 2.828, 'z'); close(z.p, 0.00468, 'p', 2e-4); close(z.diff, 0.2, 'diff')
  const t = S.welchT([1, 2, 3, 4, 5], [3, 4, 5, 6, 7])
  close(t.stat, -2, 't'); close(t.df, 8, 'df'); close(t.p, 0.0805, 'p', 5e-4); close(t.diff, -2, 'diff')
  assert.equal(S.welchT([1], [2, 3]).p, null)
  assert.match(S.diffSentence('新生', '老生', -10.24, 0.004, '分'), /^新生比老生低 10\.2 分，差异显著（p<0\.01）$/)
  assert.match(S.diffSentence('A', 'B', 1, 0.3, ''), /差异不明显（p=0\.30）/)
  assert.match(S.diffSentence('A', 'B', 1, null, ''), /样本太少/)
  assert.match(S.diffSentence('A', 'B', 0.01, 0.9, '分'), /基本持平/)
}

// ───── 分组对比 ─────
const mkScores = (cls, hi, lo, n) => rep(n, i => ({ class: cls, score: i % 2 === 0 ? hi : lo }))
{
  const rows = [...mkScores('A', 9, 7, 40), ...mkScores('B', 7, 5, 40), ...mkScores('C', 3, 3, 5), { class: 'A', score: '' }]
  const r = S.compareGroups(rows, 'class', { kind: 'mean', column: 'score', unit: '分' })
  assert.equal(r.overall.n, 85); close(r.overall.value, 6.8, '总体均值', 0.05) // (320+240+15)/85 = 6.76
  const g = Object.fromEntries(r.groups.map(x => [x.group, x]))
  assert.equal(g.A.value, 8); assert.equal(g.B.value, 6); assert.equal(g.C.value, 3)
  assert.equal(g.A.significant, true); assert.equal(g.B.significant, true); assert.ok(g.B.diffFromOverall < 0 && g.A.diffFromOverall > 0)
  assert.equal(g.C.smallSample, true); assert.equal(g.C.significant, false); assert.match(g.C.text, /样本小/)
  assert.equal(r.groups[0].group, 'C') // 从低到高
  assert.ok(r.notes.some(n => n.includes('1 行')))
  assert.match(r.text, /明显偏低的有：「B」/)
  // 占比
  const rr = S.compareGroups([...rep(50, i => ({ g: 'x', r: i < 40 ? '是' : '否' })), ...rep(50, i => ({ g: 'y', r: i < 20 ? '是' : '否' }))], 'g', { kind: 'rate', column: 'r' })
  assert.equal(rr.overall.value, 60); const x = rr.groups.find(q => q.group === 'x'); assert.equal(x.value, 80); assert.equal(x.diffFromOverall, 20); assert.equal(x.significant, true)
  // rate 的 gte 口径
  const rg = S.compareGroups(rep(40, i => ({ g: 'a', n: i < 10 ? 1 : 0 })), 'g', { kind: 'rate', column: 'n', positive: { gte: 1 } })
  assert.equal(rg.overall.value, 25)
}

// ───── 明显偏低的小组 ─────
{
  const rows = [
    ...rep(40, i => ({ grade: 'G1', class: 'c1', s: i % 2 ? 7 : 9 })),
    ...rep(40, i => ({ grade: 'G1', class: 'c2', s: i % 2 ? 5 : 7 })),
    ...rep(40, i => ({ grade: 'G2', class: 'c3', s: i % 2 ? 7 : 9 })),
    ...rep(40, i => ({ grade: 'G2', class: 'c4', s: i % 2 ? 7 : 9 })),
    ...rep(6, () => ({ grade: 'G2', class: 'c5', s: 1 }))
  ]
  const r = S.findLowGroups(rows, { kind: 'mean', column: 's' }, { dimensions: ['grade', 'class'] })
  const labels = r.flagged.map(f => f.label)
  assert.ok(labels.includes('grade=G1 > class=c2'), labels.join('|'))
  assert.ok(!labels.some(l => l.includes('c1') || l.includes('c3') || l.includes('c4')))
  const c2 = r.flagged.find(f => f.label === 'grade=G1 > class=c2')
  assert.equal(c2.value, 6); assert.equal(c2.parentValue, 7); assert.equal(c2.diff, -1); assert.ok(c2.z < -1.96); assert.match(c2.reason, /低 1\.0/)
  // c5 只有 6 人：不下结论，但在提示里
  assert.ok(r.smallButDeviating.some(x => x.label.includes('c5')))
  assert.ok(!labels.some(l => l.includes('c5')))
  assert.ok(r.checked >= 6); assert.ok(r.notes.some(n => n.includes('检验')))
  // 阈值调高就没有了；minDiff 过大也没有
  assert.equal(S.findLowGroups(rows, { kind: 'mean', column: 's' }, { dimensions: ['grade', 'class'], zThreshold: 50 }).flagged.length, 0)
  assert.equal(S.findLowGroups(rows, { kind: 'mean', column: 's' }, { dimensions: ['grade', 'class'], minDiff: 5 }).flagged.length, 0)
  // 偏高方向
  assert.ok(S.findLowGroups(rows.filter(r => r.class !== 'c5'), { kind: 'mean', column: 's' }, { dimensions: ['grade'], direction: 'high' }).flagged.some(f => f.label === 'grade=G2'))
  assert.match(S.findLowGroups(rows, { kind: 'mean', column: 's' }, { dimensions: ['grade', 'class'], zThreshold: 50 }).text, /没有发现/)
}

// ───── 环比 / 同比 ─────
{
  const r = S.periodCompare(110, 100, { kind: 'mean', unit: '分', metricName: '均分' })
  assert.equal(r.diff, 10); assert.equal(r.changeRate, 0.1); assert.match(r.text, /变化 10\.0%/)
  assert.equal(S.periodCompare(5, 0).changeRate, null)
  // 结构加权：本期 新生 80 人 60%、老生 20 人 80%；上期 新生 20 人 50%、老生 80 人 70%
  const cur = { value: 64, n: 100, segments: [{ segment: '新生', n: 80, value: 60 }, { segment: '老生', n: 20, value: 80 }] }
  const prev = { value: 66, n: 100, segments: [{ segment: '新生', n: 20, value: 50 }, { segment: '老生', n: 80, value: 70 }] }
  const p = S.periodCompare(cur, prev, { kind: 'rate', metricName: '续费率' })
  assert.equal(p.diff, -2)
  assert.equal(p.weighted.prevAdjusted, 54); assert.equal(p.weighted.likeForLikeDiff, 10); assert.equal(p.weighted.structureEffect, -12); assert.equal(p.weighted.commonDiff, -2)
  assert.match(p.text, /重新加权/)
  assert.deepEqual(p.weighted.segments.map(s => s.curShare), [80, 20])
  // 只在一期出现的层不进加权
  const q = S.periodCompare({ value: 1, segments: [{ segment: 'a', n: 1, value: 1 }, { segment: 'x', n: 1, value: 1 }] }, { value: 1, segments: [{ segment: 'a', n: 1, value: 1 }] })
  assert.deepEqual(q.weighted.onlyCur, ['x'])
  // 从明细算
  const rows = [...rep(100, i => ({ term: '本期', c: i < 60 ? '是' : '否' })), ...rep(100, i => ({ term: '上期', c: i < 40 ? '是' : '否' }))]
  const f = S.periodCompareFromRows(rows, { periodKey: 'term', cur: '本期', prev: '上期', metric: { kind: 'rate', column: 'c' } })
  assert.equal(f.cur, 60); assert.equal(f.prev, 40); assert.equal(f.diff, 20); assert.equal(f.significant, true)
  assert.match(S.periodCompareFromRows(rows, { periodKey: 'term', cur: '没有', prev: '上期', metric: { kind: 'rate', column: 'c' } }).text, /找不到/)
}

// ───── 交叉表 ─────
{
  const rows = [{ a: '甲', b: 'x', v: 10 }, { a: '甲', b: 'x', v: 20 }, { a: '甲', b: 'y', v: 30 }, { a: '乙', b: 'y', v: 5 }, { a: null, b: 'y', v: 1 }]
  const c = S.crosstab(rows, 'a', 'b')
  const ia = c.rows.indexOf('甲'), ix = c.cols.indexOf('x'), iy = c.cols.indexOf('y')
  assert.equal(c.counts[ia][ix], 2); assert.equal(c.counts[ia][iy], 1); assert.equal(c.total, 5)
  assert.equal(c.rowTotals[ia], 3); assert.equal(c.colTotals[iy], 3)
  assert.equal(c.rowShare[ia][ix], 66.7)
  assert.equal(S.crosstab(rows, 'a', 'b', { agg: 'sum', column: 'v' }).matrix[ia][ix], 30)
  assert.equal(S.crosstab(rows, 'a', 'b', { agg: 'mean', column: 'v' }).matrix[ia][ix], 15)
  assert.equal(c.matrix[c.rows.indexOf('乙')][ix], null)
  assert.match(c.text, /「甲」×「x」/)
  assert.equal(S.crosstab(rows, 'a', 'b', { agg: 'count' }, { maxRows: 1 }).rows.length, 1)
}

// ───── 多选题 ─────
{
  const rows = [{ q: 'A,B' }, { q: 'A' }, { q: '' }, { q: 'B、C' }, { q: null }, { q: '["A","C"]' }, { q: 'A；A' }]
  const r = S.multiChoice(rows, 'q')
  assert.equal(r.respondents, 5); assert.equal(r.blank, 2)
  const o = Object.fromEntries(r.options.map(x => [x.option, x]))
  assert.equal(o.A.count, 4); assert.equal(o.A.rate, 80); assert.equal(o.B.count, 2); assert.equal(o.C.count, 2); assert.equal(o.B.rate, 40)
  assert.ok(o.A.ciLow < 80 && o.A.ciHigh > 80)
  assert.equal(r.options[0].option, 'A'); assert.match(r.text, /5 人作答/)
  assert.equal(S.multiChoice([{ q: '' }], 'q').respondents, 0)
}

// ───── 选项与分数 ─────
{
  const rows = [
    ...rep(40, i => ({ why: '太难,太快', s: i % 2 ? 3 : 5 })),
    ...rep(40, i => ({ why: '太快', s: i % 2 ? 7 : 9 })),
    ...rep(40, i => ({ why: '没有', s: i % 2 ? 7 : 9 })),
    { why: '太难', s: 1 }, { why: '太难', s: '' }
  ]
  const r = S.optionImpact(rows, 'why', { kind: 'mean', column: 's' }, { multi: true })
  const o = Object.fromEntries(r.options.map(x => [x.option, x]))
  assert.equal(r.overall.n, 121)
  assert.equal(o['太难'].n, 41); assert.equal(o['太快'].n, 80); assert.equal(o['没有'].n, 40)
  assert.equal(o['没有'].value, 8); assert.ok(o['太难'].diffFromOverall < 0 && o['太难'].significant)
  assert.equal(r.options[0].option, '太难') // 差得最多排最前
  assert.ok(r.notes[0].includes('相关')); assert.match(r.text, /更低/)
  // 单选 + NPS
  const n = S.optionImpact(rep(60, i => ({ k: i < 30 ? 'x' : 'y', s: i < 30 ? 10 : 3 })), 'k', { kind: 'nps', column: 's' })
  assert.equal(n.options.find(x => x.option === 'x').value, 100); assert.equal(n.options.find(x => x.option === 'y').value, -100)
}

// ───── 分布 ─────
{
  const q = S.quantiles([4, 1, 3, 2, 'x', null])
  assert.equal(q.n, 4); assert.equal(q.quantiles.find(x => x.p === 0.5).value, 2.5); assert.equal(q.min, 1); assert.equal(q.max, 4)
  const h = S.histogram([50, 60, 79, 80, 100, 120], { edges: [0, 60, 80, 100] })
  assert.deepEqual(h.bins.map(b => b.count), [1, 2, 2]); assert.equal(h.outOfRange, 1); assert.equal(h.bins[1].share, 40)
  const eq = S.histogram([0, 5, 10], { bins: 2 })
  assert.deepEqual(eq.bins.map(b => b.count), [1, 2]) // 最后一段右闭
  assert.equal(S.histogram([]).n, 0)
}

// ───── 比率 ─────
{
  const r = S.ratio(50, 100, { name: '续费率' })
  assert.equal(r.rate, 50); assert.equal(r.ciLow, 40.4); assert.equal(r.ciHigh, 59.6); assert.match(r.text, /续费率 50%/)
  assert.equal(S.ratio(1, 0).rate, null); assert.match(S.ratio(3, 10).text, /不足 30/)
  const rows = [
    ...rep(50, i => ({ st: '到期', g: 'x', paid: i < 40 ? '是' : '否' })),
    ...rep(50, i => ({ st: '到期', g: 'y', paid: i < 20 ? '是' : '否' })),
    ...rep(20, () => ({ st: '未到期', g: 'x', paid: '否' }))
  ]
  const g = S.ratioFromRows(rows, { numerator: [{ column: 'paid', op: 'eq', value: '是' }], denominator: [{ column: 'st', op: 'eq', value: '到期' }], groupKey: 'g' })
  assert.equal(g.overall.n, 100); assert.equal(g.overall.rate, 60)
  assert.equal(g.groups[0].group, 'y'); assert.equal(g.groups[0].significant, true); assert.equal(g.groups[0].diffFromOverall, -20)
  assert.match(g.text, /明显偏低的有 「y」40%/)
  assert.equal(S.matchCond({ a: 5 }, { column: 'a', op: 'gte', value: 5 }), true)
  assert.equal(S.matchCond({ a: 5 }, { column: 'a', op: 'in', value: ['4', 5] }), true)
}

// ───── 中间分段 ─────
{
  const rows = [
    ...rep(40, () => ({ s: 7, grade: 'G1' })), ...rep(10, () => ({ s: 8, grade: 'G2' })),
    ...rep(20, () => ({ s: 10, grade: 'G2' })), ...rep(30, () => ({ s: 10, grade: 'G1' })), { s: '', grade: 'G1' }
  ]
  const r = S.middleSegment(rows, { scoreColumn: 's', min: 7, max: 8, featureKeys: ['grade'] })
  assert.equal(r.n, 100); assert.equal(r.segmentN, 50); assert.equal(r.share, 50); assert.equal(r.segmentLabel, '7–8 分')
  const g1 = r.features.find(f => f.value === 'G1')
  assert.equal(g1.shareInSegment, 80); assert.equal(g1.shareInOthers, 60); assert.equal(g1.diff, 20); assert.equal(g1.significant, true)
  assert.match(r.text, /占 50\.0%/)
}

// ───── 工具定义 ─────
{
  const names = statTools.map(t => t.name)
  for (const n of ['stat_nps', 'stat_compare_groups', 'stat_find_low_groups', 'stat_period_compare', 'stat_crosstab', 'stat_multi_choice', 'stat_option_impact']) assert.ok(names.includes(n), n)
  assert.equal(new Set(names).size, names.length)
  for (const t of statTools) { assert.equal(t.level, 'read'); assert.ok(t.description.length > 40 && /[一-龥]/.test(t.description)); assert.equal(typeof t.params.parse, 'function') }
  const calls = []
  const rows = [...mkScores('A', 10, 8, 40), ...mkScores('B', 6, 4, 40)].map(r => ({ ...r, term: r.class === 'A' ? '本期' : '上期' }))
  const ctx = { runQuery: async (sql, ds) => { calls.push([sql, ds]); return rows } }
  const tool = n => statTools.find(t => t.name === n)
  const run = (n, a) => tool(n).run(tool(n).params.parse(a), ctx)
  const base = { datasets: ['d1'], sql: 'SELECT * FROM t' }
  const nps = await run('stat_nps', { ...base, scoreColumn: 'score', groupKey: 'class' })
  assert.equal(nps.ok, true); assert.equal(nps.overall.n, 80); assert.equal(nps.groups.groups.length, 2)
  assert.deepEqual(calls[0], ['SELECT * FROM t', ['d1']])
  const cg = await run('stat_compare_groups', { ...base, groupKey: 'class', metric: 'mean', column: 'score', unit: '分' })
  assert.equal(cg.groups[0].group, 'B'); assert.ok(cg.text.includes('明显偏低'))
  const bad = await run('stat_compare_groups', { ...base, groupKey: 'class', metric: 'mean', column: '不存在' })
  assert.equal(bad.ok, false); assert.match(bad.error, /没有这些列：不存在/)
  const low = await run('stat_find_low_groups', { ...base, dimensions: ['class'], metric: 'mean', column: 'score' })
  assert.equal(low.flagged[0].label, 'class=B')
  const pc = await run('stat_period_compare', { ...base, periodKey: 'term', cur: '本期', prev: '上期', metric: 'mean', column: 'score' })
  assert.equal(pc.diff, 4)
  const ct = await run('stat_crosstab', { ...base, rowKey: 'class', colKey: 'term' })
  assert.equal(ct.total, 80)
  assert.equal(tool('stat_crosstab').params.parse({ ...base, rowKey: 'a', colKey: 'b' }).agg, 'count')
  assert.equal((await run('stat_multi_choice', { ...base, column: 'class' })).respondents, 80)
  assert.equal((await run('stat_option_impact', { ...base, optionColumn: 'class', metric: 'mean', column: 'score' })).options.length, 2)
  assert.equal((await run('stat_distribution', { ...base, column: 'score', edges: [0, 5, 10] })).histogram.n, 80)
  assert.equal((await run('stat_ratio', { ...base, numerator: [{ column: 'class', op: 'eq', value: 'A' }] })).overall.rate, 50)
  assert.equal((await run('stat_middle_segment', { ...base, scoreColumn: 'score', min: 8, max: 8, featureKeys: ['class'] })).segmentN, 20)
  // 空结果、被截断
  const empty = await statTools[0].run(statTools[0].params.parse({ ...base, scoreColumn: 'score' }), { runQuery: async () => [] })
  assert.equal(empty.ok, false)
  const trunc = await statTools[0].run(statTools[0].params.parse({ ...base, scoreColumn: 'score' }), { runQuery: async () => ({ rows, truncated: true }) })
  assert.ok(trunc.notes.some(n => n.includes('截断')))
  // 参数缺失被 schema 拒绝
  assert.throws(() => tool('stat_nps').params.parse({ datasets: [], sql: 'x', scoreColumn: 'a' }))
}

console.log('analysis-stats.test ✓')
