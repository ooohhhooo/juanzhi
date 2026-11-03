/**
 * 通用统计函数（纯函数）。输入是「查询结果行数组」或「一列值数组」，不依赖数据库、不依赖 electron。
 *
 * 口径约定（所有函数一致）：
 *  - 空值、非数字的分数一律不进分母，并在 notes 里说明“有多少个被忽略”；
 *  - 比例类的值用百分数（62.5 表示 62.5%），差值用“个百分点”；NPS 用 -100~100 的分；均值用原单位；
 *  - 样本量小于 minN（默认 30）的组标“样本小”，只做提示，不做显著性结论；
 *  - 显著性 p 值是双侧的，α 默认 0.05；p<0.05 才叫“差异显著”，否则叫“差异不明显”；
 *  - 每个返回值都带 text（给人看的白话说明），Agent 可以直接引用。
 */
import { mean, tTwoSidedP, variance, wilson, zTwoSidedP } from './math.ts'

export type Row = Record<string, unknown>

export const DEFAULT_MIN_N = 30
export const DEFAULT_ALPHA = 0.05

// ───────────────────────── 基础工具 ─────────────────────────

/** 转数字：数字、数字样子的文字（可带千分位、百分号）；其它返回 null */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const s = v.trim().replace(/,/g, '').replace(/%$/, '')
    if (!s) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}
export const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
export const labelOf = (v: unknown): string => (isBlank(v) ? '(空)' : String(v).trim())
const r1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1)
const r2 = (x: number): number => Math.round(x * 100) / 100
const r1n = (x: number): number => Math.round(x * 10) / 10

export function pLabel(p: number | null): string {
  if (p === null || Number.isNaN(p)) return '样本太少，无法判断'
  if (p < 0.001) return 'p<0.001'
  if (p < 0.01) return 'p<0.01'
  if (p < 0.05) return 'p<0.05'
  return `p=${(Math.round(p * 100) / 100).toFixed(2)}`
}

// ───────────────────────── 指标定义 ─────────────────────────

export interface PositiveSpec { gte?: number; in?: Array<string | number | boolean> }
export type MetricSpec =
  | { kind: 'mean'; column: string; unit?: string }
  | { kind: 'rate'; column: string; positive?: PositiveSpec; unit?: string }
  | { kind: 'nps'; column: string; promoterMin?: number; passiveMin?: number }

const TRUTHY = new Set(['1', 'true', 'yes', 'y', '是', '有', '已续费', '已续报', '续费', '续报', '到课', '已到'])

/** 一个值算不算“发生了”。返回 null 表示这一行没有有效值（不进分母） */
export function isPositive(v: unknown, p?: PositiveSpec): boolean | null {
  if (isBlank(v)) return null
  if (p?.gte !== undefined) { const n = toNum(v); return n === null ? null : n >= p.gte }
  if (p?.in) { const s = String(v).trim().toLowerCase(); return p.in.some(x => String(x).trim().toLowerCase() === s) }
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : v > 0
  return TRUTHY.has(String(v).trim().toLowerCase())
}

const scaleOf = (m: MetricSpec): number => (m.kind === 'mean' ? 1 : 100)
export const unitOf = (m: MetricSpec): string => (m.kind === 'rate' ? '%' : m.kind === 'nps' ? '分' : (m.unit ?? ''))
const diffUnit = (m: MetricSpec): string => (m.kind === 'rate' ? '个百分点' : unitOf(m))
export const metricName = (m: MetricSpec): string => (m.kind === 'rate' ? `「${m.column}」占比` : m.kind === 'nps' ? `「${m.column}」NPS` : `「${m.column}」均值`)

/** 把行变成可统计的数值：mean=原值；rate=1/0；nps=+1/0/-1（推荐/中立/贬损） */
export function metricValues(rows: Row[], m: MetricSpec): number[] {
  const out: number[] = []
  for (const r of rows) {
    const v = r[m.column]
    if (m.kind === 'mean') { const n = toNum(v); if (n !== null) out.push(n) }
    else if (m.kind === 'rate') { const b = isPositive(v, m.positive); if (b !== null) out.push(b ? 1 : 0) }
    else {
      const n = toNum(v)
      if (n === null) continue
      out.push(n >= (m.promoterMin ?? 9) ? 1 : n < (m.passiveMin ?? 7) ? -1 : 0)
    }
  }
  return out
}

/** 汇总值（显示单位）：mean 原值；rate、nps 乘 100 */
export function valueOf(vals: number[], m: MetricSpec): number | null { return vals.length ? mean(vals) * scaleOf(m) : null }

// ───────────────────────── 显著性检验 ─────────────────────────

export interface TestResult { diff: number; stat: number | null; p: number | null; method: 'z' | 'welch'; df?: number }

/** 两比例 z 检验（合并方差，双侧）。x=发生数，n=样本数；diff 是 A−B（比例，0~1） */
export function twoPropZ(x1: number, n1: number, x2: number, n2: number): TestResult {
  const p1 = n1 > 0 ? x1 / n1 : 0, p2 = n2 > 0 ? x2 / n2 : 0
  const diff = p1 - p2
  if (n1 < 1 || n2 < 1) return { diff, stat: null, p: null, method: 'z' }
  const pool = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2))
  if (se === 0) return { diff, stat: diff === 0 ? 0 : null, p: diff === 0 ? 1 : null, method: 'z' }
  const z = diff / se
  return { diff, stat: z, p: zTwoSidedP(z), method: 'z' }
}

/** 均值差的 Welch t 检验（不假设两组方差相同；p 值用 t 分布，自由度按 Welch–Satterthwaite）。diff 是 A−B */
export function welchT(a: number[], b: number[]): TestResult {
  const diff = (a.length ? mean(a) : 0) - (b.length ? mean(b) : 0)
  if (a.length < 2 || b.length < 2) return { diff, stat: null, p: null, method: 'welch' }
  const va = variance(a) / a.length, vb = variance(b) / b.length
  const se2 = va + vb
  if (se2 === 0) return { diff, stat: diff === 0 ? 0 : null, p: diff === 0 ? 1 : null, method: 'welch' }
  const t = diff / Math.sqrt(se2)
  const df = (se2 * se2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1))
  return { diff, stat: t, p: tTwoSidedP(t, df), method: 'welch', df }
}

/** 两组数值（按指标口径映射后）的比较：rate 用 z，mean / nps 用 Welch。diff 已换成显示单位（A−B） */
export function testVals(a: number[], b: number[], m: MetricSpec): TestResult {
  const t = m.kind === 'rate' ? twoPropZ(a.reduce((s, v) => s + v, 0), a.length, b.reduce((s, v) => s + v, 0), b.length) : welchT(a, b)
  return { ...t, diff: t.diff * scaleOf(m) }
}

/** 一组数值的汇总（n、和、平方和）。平方和按 shift 平移后算，减法求「其余各组」时不会因大数相消而失真 */
export interface Agg { n: number; sum: number; sq: number }
export function aggOf(vals: number[], shift: number): Agg {
  let sum = 0, sq = 0
  for (const v of vals) { const d = v - shift; sum += d; sq += d * d }
  return { n: vals.length, sum, sq }
}
export const aggMinus = (t: Agg, a: Agg): Agg => ({ n: t.n - a.n, sum: t.sum - a.sum, sq: t.sq - a.sq })

/** testVals 的汇总版：不用把「其余各组」的数值拼成大数组，用总和减去本组即可。结果与 testVals 一致（浮点误差以内） */
export function testAgg(a: Agg, b: Agg, shift: number, m: MetricSpec): TestResult {
  let t: TestResult
  if (m.kind === 'rate') t = twoPropZ(a.sum + a.n * shift, a.n, b.sum + b.n * shift, b.n)
  else {
    const ma = a.n ? a.sum / a.n : 0, mb = b.n ? b.sum / b.n : 0
    const diff = ma - mb
    if (a.n < 2 || b.n < 2) t = { diff, stat: null, p: null, method: 'welch' }
    else {
      const va = Math.max(0, (a.sq - (a.sum * a.sum) / a.n) / (a.n - 1)) / a.n, vb = Math.max(0, (b.sq - (b.sum * b.sum) / b.n) / (b.n - 1)) / b.n
      const se2 = va + vb
      if (se2 < 1e-18) t = { diff, stat: Math.abs(diff) < 1e-12 ? 0 : null, p: Math.abs(diff) < 1e-12 ? 1 : null, method: 'welch' }
      else {
        const tt = diff / Math.sqrt(se2)
        const df = (se2 * se2) / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1))
        t = { diff, stat: tt, p: tTwoSidedP(tt, df), method: 'welch', df }
      }
    }
  }
  return { ...t, diff: t.diff * scaleOf(m) }
}

/** 把“A 比 B 高 / 低多少、显著不显著”写成一句话 */
export function diffSentence(nameA: string, nameB: string, diff: number, p: number | null, unit: string, small = false): string {
  const u = unit ? ` ${unit}` : ''
  const abs = Math.abs(diff)
  let s: string
  if (r1n(abs) === 0) s = `${nameA}与${nameB}基本持平（差 0.0${u}）`
  else s = `${nameA}比${nameB}${diff > 0 ? '高' : '低'} ${r1(abs)}${u}`
  if (p === null) s += '，样本太少，无法判断差异是否显著'
  else if (p < 0.05) s += `，差异显著（${pLabel(p)}）`
  else s += `，差异不明显（${pLabel(p)}），可能只是随机波动`
  if (small) s += '（样本偏少，仅供参考）'
  return s
}

// ───────────────────────── NPS ─────────────────────────

export interface NpsOptions {
  /** 推荐者下限（含），默认 9 */ promoterMin?: number
  /** 中立者下限（含），默认 7；低于它的是贬损者 */ passiveMin?: number
  /** 自定义分段：[{label,min,max}]，闭区间，会额外返回每段人数和占比 */ segments?: Array<{ label: string; min: number; max: number }>
}
export interface NpsResult {
  n: number; invalid: number
  promoters: number; passives: number; detractors: number
  promoterPct: number; passivePct: number; detractorPct: number
  /** 推荐者% − 贬损者%，-100~100，保留 1 位小数 */ nps: number | null
  segments?: Array<{ label: string; min: number; max: number; count: number; pct: number }>
  smallSample: boolean
  text: string
}

export function nps(scores: unknown[], opts: NpsOptions = {}): NpsResult {
  const pMin = opts.promoterMin ?? 9, nMin = opts.passiveMin ?? 7
  const vals: number[] = []
  let invalid = 0
  for (const s of scores) { const n = toNum(s); if (n === null) { if (!isBlank(s)) invalid++ } else vals.push(n) }
  const n = vals.length
  const pro = vals.filter(v => v >= pMin).length
  const det = vals.filter(v => v < nMin).length
  const pas = n - pro - det
  const pct = (x: number) => (n ? r1n((x / n) * 100) : 0)
  const score = n ? r1n(((pro - det) / n) * 100) : null
  const segments = opts.segments?.map(s => { const c = vals.filter(v => v >= s.min && v <= s.max).length; return { ...s, count: c, pct: pct(c) } })
  const small = n < DEFAULT_MIN_N
  const text = n === 0
    ? '没有可用的分数，算不出 NPS'
    : `共 ${n} 人作答，NPS 为 ${r1(score!)}：推荐者（≥${pMin} 分）${pct(pro)}%，中立者（${nMin}–${pMin - 1} 分）${pct(pas)}%，贬损者（<${nMin} 分）${pct(det)}%` +
      (small ? `（样本只有 ${n} 人，偏少，仅供参考）` : '') + (invalid ? `；另有 ${invalid} 个不是数字的回答已忽略` : '')
  return { n, invalid, promoters: pro, passives: pas, detractors: det, promoterPct: pct(pro), passivePct: pct(pas), detractorPct: pct(det), nps: score, segments, smallSample: small, text }
}

// ───────────────────────── 分组对比 ─────────────────────────

export interface CompareOptions { minN?: number; alpha?: number }
export interface GroupStat {
  group: string; n: number; value: number | null
  /** 与总体的差（显示单位） */ diffFromOverall: number | null
  /** 与“其余各组合在一起”比较的 p 值 */ p: number | null
  significant: boolean; smallSample: boolean; text: string
}
export interface CompareResult {
  metric: string; unit: string; groupKey: string
  overall: { n: number; value: number | null }
  groups: GroupStat[]
  text: string; notes: string[]
}

function groupRows(rows: Row[], key: string): Map<string, Row[]> {
  const g = new Map<string, Row[]>()
  for (const r of rows) { const k = labelOf(r[key]); const a = g.get(k); if (a) a.push(r); else g.set(k, [r]) }
  return g
}

/** 按某一列分组，比较每组的均值 / 占比 / NPS。groups 按 value 从低到高排；p 是“这一组 vs 其余各组”。 */
export function compareGroups(rows: Row[], groupKey: string, metric: MetricSpec, opts: CompareOptions = {}): CompareResult {
  const minN = opts.minN ?? DEFAULT_MIN_N, alpha = opts.alpha ?? DEFAULT_ALPHA
  const allVals = metricValues(rows, metric)
  const overallValue = valueOf(allVals, metric)
  const notes: string[] = []
  const ignored = rows.length - allVals.length
  if (ignored > 0) notes.push(`有 ${ignored} 行的「${metric.column}」为空或不是有效值，没有计入`)
  const groups: GroupStat[] = []
  // 先一次性分好组、算好每组的汇总和总汇总；「其余各组」用总汇总减去本组得到（不再对每组重扫全表、拼大数组）
  const shift = allVals.length && metric.kind !== 'rate' ? mean(allVals) : 0
  const pre = [...groupRows(rows, groupKey)].map(([name, rs]) => { const vals = metricValues(rs, metric); return { name, vals, agg: aggOf(vals, shift) } })
  const total = aggOf(allVals, shift)
  for (const { name, vals, agg } of pre) {
    if (!vals.length) continue
    const rest = aggMinus(total, agg)
    const value = valueOf(vals, metric)!
    const diff = overallValue === null ? null : value - overallValue
    const small = vals.length < minN
    const t = rest.n ? testAgg(agg, rest, shift, metric) : null
    const p = t?.p ?? null
    const significant = !small && p !== null && p < alpha
    const u = unitOf(metric)
    let text = `「${name}」${vals.length} 人，${metric.kind === 'rate' ? '占比' : metric.kind === 'nps' ? 'NPS' : '均值'} ${r1(value)}${u === '%' ? '%' : u ? ' ' + u : ''}`
    if (diff !== null) text += `，${diff < 0 ? '比总体低' : '比总体高'} ${r1(Math.abs(diff))} ${diffUnit(metric)}`
    text += small ? '（样本小，只供参考）' : significant ? `，差异显著（${pLabel(p)}）` : p !== null ? '，差异不明显' : ''
    groups.push({ group: name, n: vals.length, value: r1n(value), diffFromOverall: diff === null ? null : r1n(diff), p: p === null ? null : r2(p) === 0 && p > 0 ? p : r2(p), significant, smallSample: small, text })
  }
  groups.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity))
  const sig = groups.filter(g => g.significant)
  const lowSig = sig.filter(g => (g.diffFromOverall ?? 0) < 0).map(g => g.group)
  const highSig = sig.filter(g => (g.diffFromOverall ?? 0) > 0).map(g => g.group)
  const smallCount = groups.filter(g => g.smallSample).length
  if (smallCount) notes.push(`有 ${smallCount} 个组样本不足 ${minN}，已标“样本小”，不下显著性结论`)
  if (groups.length > 8) notes.push(`一共比较了 ${groups.length} 个组，组越多越容易碰巧出现“显著”，看到个别组显著时请结合常识再下结论`)
  const text = overallValue === null ? '没有可用数据' :
    `总体${metricName(metric)}为 ${r1(overallValue)}${unitOf(metric) === '%' ? '%' : unitOf(metric) ? ' ' + unitOf(metric) : ''}（${allVals.length} 人），按「${groupKey}」分成 ${groups.length} 组。` +
    (lowSig.length ? `明显偏低的有：${lowSig.map(x => `「${x}」`).join('、')}。` : '没有发现样本足够且明显偏低的组。') +
    (highSig.length ? `明显偏高的有：${highSig.map(x => `「${x}」`).join('、')}。` : '')
  return { metric: metricName(metric), unit: unitOf(metric), groupKey, overall: { n: allVals.length, value: overallValue === null ? null : r1n(overallValue) }, groups, text, notes }
}

// ───────────────────────── 明显偏低的小组 ─────────────────────────

export interface LowGroupOptions {
  /** 从粗到细的维度列，如 ['年级','班级','老师']；每一层的组与它的上级组比较，第一层与总体比较 */ dimensions: string[]
  minN?: number
  /** z（或 t）值阈值，默认 1.96，越大越严格 */ zThreshold?: number
  /** 至少要差多少才算（显示单位），默认 0 */ minDiff?: number
  /** low=只找偏低（默认），high=只找偏高，both=都找 */ direction?: 'low' | 'high' | 'both'
  /** 只继续拆被标出来的组（默认拆所有样本够的组） */ drillOnlyFlagged?: boolean
  maxGroups?: number
}
export interface LowGroup {
  path: Array<{ key: string; value: string }>; label: string; level: number; parentLabel: string
  n: number; value: number; parentValue: number; diff: number; z: number; p: number | null; reason: string
}
export interface LowGroupsResult {
  metric: string; flagged: LowGroup[]
  smallButDeviating: Array<{ label: string; n: number; value: number; diff: number }>
  checked: number; text: string; notes: string[]
}

/** 在各层维度里找“相对上级组明显偏低（或偏高）”的小组。检验方式：这个组 vs 上级组里除它以外的人，z / Welch t 达到阈值才标出。 */
export function findLowGroups(rows: Row[], metric: MetricSpec, opts: LowGroupOptions): LowGroupsResult {
  const minN = opts.minN ?? DEFAULT_MIN_N, zT = opts.zThreshold ?? 1.96, minDiff = opts.minDiff ?? 0
  const dir = opts.direction ?? 'low', maxGroups = opts.maxGroups ?? 2000
  const flagged: LowGroup[] = []
  const small: Array<{ label: string; n: number; value: number; diff: number }> = []
  let checked = 0
  const notes: string[] = []
  const u = unitOf(metric)
  const unitTxt = u === '%' ? '%' : u ? ' ' + u : ''

  const walk = (sub: Row[], level: number, path: Array<{ key: string; value: string }>, parentLabel: string): void => {
    if (level >= opts.dimensions.length || checked >= maxGroups) return
    const key = opts.dimensions[level]
    const parentVals = metricValues(sub, metric)
    const parentValue = valueOf(parentVals, metric)
    if (parentValue === null) return
    const gs = groupRows(sub, key)
    const shift = metric.kind === 'rate' ? 0 : mean(parentVals)
    const pre = new Map<string, { vals: number[]; agg: Agg }>()
    for (const [n2, rs2] of gs) { const v2 = metricValues(rs2, metric); pre.set(n2, { vals: v2, agg: aggOf(v2, shift) }) }
    const total = aggOf(parentVals, shift)
    for (const [name, rs] of gs) {
      const { vals, agg } = pre.get(name)!
      if (!vals.length) continue
      const myPath = [...path, { key, value: name }]
      const label = myPath.map(x => `${x.key}=${x.value}`).join(' > ')
      const value = valueOf(vals, metric)!
      const diff = value - parentValue
      let hit = false
      if (gs.size > 1) {
        const rest = aggMinus(total, agg)
        if (vals.length < minN) {
          if (((dir !== 'high' && diff < 0) || (dir !== 'low' && diff > 0)) && Math.abs(diff) >= Math.max(minDiff, 1e-9) && small.length < 50) small.push({ label, n: vals.length, value: r1n(value), diff: r1n(diff) })
        } else if (rest.n) {
          checked++
          const t = testAgg(agg, rest, shift, metric)
          const z = t.stat ?? 0
          const wantLow = dir !== 'high' && diff < 0 && z <= -zT
          const wantHigh = dir !== 'low' && diff > 0 && z >= zT
          if ((wantLow || wantHigh) && Math.abs(diff) >= minDiff) {
            hit = true
            const parentName = parentLabel
            flagged.push({
              path: myPath, label, level, parentLabel: parentName, n: vals.length, value: r1n(value), parentValue: r1n(parentValue), diff: r1n(diff), z: r2(z), p: t.p === null ? null : Math.round(t.p * 10000) / 10000,
              reason: `「${label}」有 ${vals.length} 人，${metricName(metric)}为 ${r1(value)}${unitTxt}，比上级「${parentName}」（${r1(parentValue)}${unitTxt}）${diff < 0 ? '低' : '高'} ${r1(Math.abs(diff))} ${diffUnit(metric)}（z=${r1(z)}，${pLabel(t.p)}），差异显著`
            })
          }
        }
      }
      if (vals.length >= minN && (!opts.drillOnlyFlagged || hit)) walk(rs, level + 1, myPath, label)
    }
  }
  walk(rows, 0, [], '全体')
  flagged.sort((a, b) => a.z - b.z)
  if (checked > 1) notes.push(`一共检验了 ${checked} 个小组；检验得越多，越容易有个别组碰巧“显著”（按 5% 算，每 20 个就可能有 1 个是误报），建议结合业务常识和样本量再确认`)
  if (small.length) notes.push(`另有 ${small.length} 个样本不足 ${minN} 的小组数值有偏离，但人太少，不下结论，只在 smallButDeviating 里列出`)
  const word = dir === 'high' ? '偏高' : dir === 'both' ? '偏离' : '偏低'
  const text = flagged.length
    ? `在 ${checked} 个样本足够的小组里，找到 ${flagged.length} 个明显${word}的：` + flagged.slice(0, 5).map(f => f.reason).join('；') + (flagged.length > 5 ? `……（其余见列表）` : '')
    : `在 ${checked} 个样本足够的小组里，没有发现明显${word}的组（阈值 z=${zT}）。这不等于没有问题，可能是分得太细、人数不够。`
  return { metric: metricName(metric), flagged, smallButDeviating: small, checked, text, notes }
}

// ───────────────────────── 环比 / 同比 ─────────────────────────

export interface PeriodSegment { segment: string; n: number; value: number }
export interface PeriodSide { label?: string; value: number; n?: number; segments?: PeriodSegment[] }
export interface PeriodOptions {
  /** rate：value 是百分数，有 n 时做 z 检验；mean / count：只算差值和变化率 */ kind?: 'rate' | 'mean' | 'count'
  unit?: string; curLabel?: string; prevLabel?: string; metricName?: string
  /** 已算好的检验结果（比如按分数明细算的 Welch t），优先于自动检验 */ test?: TestResult | null
}
export interface PeriodResult {
  cur: number; prev: number; diff: number; changeRate: number | null; p: number | null; significant: boolean
  weighted?: {
    prevAdjusted: number; likeForLikeDiff: number; structureEffect: number; commonDiff: number
    onlyCur: string[]; onlyPrev: string[]
    segments: Array<{ segment: string; curN: number; prevN: number; curShare: number; prevShare: number; curValue: number; prevValue: number; diff: number; contribution: number }>
  }
  text: string; notes: string[]
}

/** 本期 vs 上期（环比、同比用法相同）。两边都给了 segments（分层，如新生/老生）时，额外算“按本期结构加权”的对比：把上期各层的值按本期的人数结构重新加权，拆出“真变化”和“结构变化造成的假变化”。 */
export function periodCompare(curIn: PeriodSide | number, prevIn: PeriodSide | number, opts: PeriodOptions = {}): PeriodResult {
  const cur: PeriodSide = typeof curIn === 'number' ? { value: curIn } : curIn
  const prev: PeriodSide = typeof prevIn === 'number' ? { value: prevIn } : prevIn
  const kind = opts.kind ?? 'mean'
  const unit = kind === 'rate' ? '个百分点' : (opts.unit ?? '')
  const cl = opts.curLabel ?? cur.label ?? '本期', pl = opts.prevLabel ?? prev.label ?? '上期'
  const name = opts.metricName ?? '指标'
  const diff = cur.value - prev.value
  const changeRate = prev.value === 0 ? null : diff / Math.abs(prev.value)
  const notes: string[] = []
  let test: TestResult | null = opts.test ?? null
  if (!test && kind === 'rate' && cur.n && prev.n) {
    test = twoPropZ((cur.value / 100) * cur.n, cur.n, (prev.value / 100) * prev.n, prev.n)
    test = { ...test, diff: test.diff * 100 }
  }
  const p = test?.p ?? null
  const significant = p !== null && p < DEFAULT_ALPHA
  let text = `${name}${diffSentence(cl, pl, diff, p, unit).replace(/^/, '：')}`
  if (test === null) text = `${name}：${cl}比${pl}${diff >= 0 ? '高' : '低'} ${r1(Math.abs(diff))}${unit ? ' ' + unit : ''}` + (changeRate === null ? '' : `（变化 ${r1(changeRate * 100)}%）`) + '；没有给样本量，无法判断是否显著'
  else if (changeRate !== null && kind !== 'rate') text += `（变化 ${r1(changeRate * 100)}%）`
  if ((cur.n !== undefined && cur.n < DEFAULT_MIN_N) || (prev.n !== undefined && prev.n < DEFAULT_MIN_N)) { notes.push('有一期样本不足 30，波动可能很大，仅供参考'); }

  let weighted: PeriodResult['weighted']
  if (cur.segments?.length && prev.segments?.length) {
    const pm = new Map(prev.segments.map(s => [s.segment, s]))
    const cm = new Map(cur.segments.map(s => [s.segment, s]))
    const common = cur.segments.filter(s => pm.has(s.segment) && s.n > 0 && pm.get(s.segment)!.n > 0)
    const onlyCur = cur.segments.filter(s => !pm.has(s.segment)).map(s => s.segment)
    const onlyPrev = prev.segments.filter(s => !cm.has(s.segment)).map(s => s.segment)
    if (common.length) {
      const curTot = common.reduce((s, x) => s + x.n, 0)
      const prevTot = common.reduce((s, x) => s + pm.get(x.segment)!.n, 0)
      let prevAdj = 0, curCommon = 0, prevCommon = 0
      const segs = common.map(s => {
        const ps = pm.get(s.segment)!
        const cw = s.n / curTot, pw = ps.n / prevTot
        prevAdj += cw * ps.value; curCommon += cw * s.value; prevCommon += pw * ps.value
        return { segment: s.segment, curN: s.n, prevN: ps.n, curShare: r1n(cw * 100), prevShare: r1n(pw * 100), curValue: r1n(s.value), prevValue: r1n(ps.value), diff: r1n(s.value - ps.value), contribution: r2(cw * (s.value - ps.value)) }
      })
      const like = curCommon - prevAdj, struct = prevAdj - prevCommon
      weighted = { prevAdjusted: r1n(prevAdj), likeForLikeDiff: r2(like), structureEffect: r2(struct), commonDiff: r2(curCommon - prevCommon), onlyCur, onlyPrev, segments: segs }
      const fx = (x: number) => `${x >= 0 ? '高' : '低'} ${r1(Math.abs(x))}`
      text += `。按${cl}的人群结构重新加权后（只比两期都有的层），${cl}比${pl}${fx(like)}${unit ? ' ' + unit : ''}，另有 ${r1(Math.abs(struct))}${unit ? ' ' + unit : ''}是人群结构变化带来的（${struct >= 0 ? '拉高' : '拉低'}），不是各层自己的变化`
      if (onlyCur.length || onlyPrev.length) notes.push(`${onlyCur.length ? `只在${cl}出现的层：${onlyCur.join('、')}；` : ''}${onlyPrev.length ? `只在${pl}出现的层：${onlyPrev.join('、')}；` : ''}这些层没有计入加权对比`)
    } else notes.push('两期没有共同的分层，无法做按结构加权的对比')
  }
  return { cur: r1n(cur.value), prev: r1n(prev.value), diff: r2(diff), changeRate: changeRate === null ? null : Math.round(changeRate * 10000) / 10000, p: p === null ? null : Math.round(p * 10000) / 10000, significant, weighted, text, notes }
}

/** 从明细行算两期对比：periodKey 列里取 cur / prev 两个取值；可选 segmentKey 做分层加权对比 */
export function periodCompareFromRows(rows: Row[], o: { periodKey: string; cur: string; prev: string; metric: MetricSpec; segmentKey?: string }): PeriodResult {
  const inP = (v: string) => rows.filter(r => labelOf(r[o.periodKey]) === v)
  const cr = inP(o.cur), pr = inP(o.prev)
  const cv = metricValues(cr, o.metric), pv = metricValues(pr, o.metric)
  const notes: string[] = []
  if (!cv.length || !pv.length) {
    return { cur: 0, prev: 0, diff: 0, changeRate: null, p: null, significant: false, text: `「${o.periodKey}」里${!cv.length ? `找不到“${o.cur}”` : `找不到“${o.prev}”`}的有效数据，没法对比`, notes }
  }
  const segs = (rs: Row[]): PeriodSegment[] | undefined => {
    if (!o.segmentKey) return undefined
    const out: PeriodSegment[] = []
    for (const [k, g] of groupRows(rs, o.segmentKey)) { const v = metricValues(g, o.metric); if (v.length) out.push({ segment: k, n: v.length, value: valueOf(v, o.metric)! }) }
    return out
  }
  const test = testVals(cv, pv, o.metric)
  const res = periodCompare(
    { label: o.cur, value: valueOf(cv, o.metric)!, n: cv.length, segments: segs(cr) },
    { label: o.prev, value: valueOf(pv, o.metric)!, n: pv.length, segments: segs(pr) },
    { kind: o.metric.kind === 'rate' ? 'rate' : 'mean', unit: unitOf(o.metric), metricName: metricName(o.metric), test }
  )
  res.notes.push(...notes)
  return res
}

// ───────────────────────── 交叉表 ─────────────────────────

export interface CrosstabAgg { agg: 'count' | 'sum' | 'mean' | 'rate'; column?: string; positive?: PositiveSpec }
export interface CrosstabResult {
  rowKey: string; colKey: string; rows: string[]; cols: string[]
  /** 每格的值（count=行数；sum / mean=数值；rate=百分数）；没有数据的格是 null */ matrix: Array<Array<number | null>>
  counts: number[][]; rowTotals: number[]; colTotals: number[]; total: number
  /** 每行内各列的占比（%），按行数算 */ rowShare: number[][]
  text: string; notes: string[]
}

export function crosstab(rows: Row[], rowKey: string, colKey: string, valueAgg: CrosstabAgg = { agg: 'count' }, opts: { maxRows?: number; maxCols?: number } = {}): CrosstabResult {
  const cellRows = new Map<string, Map<string, Row[]>>()
  const rowN = new Map<string, number>(), colN = new Map<string, number>()
  for (const r of rows) {
    const a = labelOf(r[rowKey]), b = labelOf(r[colKey])
    rowN.set(a, (rowN.get(a) ?? 0) + 1); colN.set(b, (colN.get(b) ?? 0) + 1)
    let m = cellRows.get(a); if (!m) cellRows.set(a, (m = new Map()))
    const c = m.get(b); if (c) c.push(r); else m.set(b, [r])
  }
  const top = (m: Map<string, number>, max: number) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, max).map(x => x[0])
  const notes: string[] = []
  const rl = top(rowN, opts.maxRows ?? 30), cl = top(colN, opts.maxCols ?? 20)
  if (rowN.size > rl.length) notes.push(`行方向有 ${rowN.size} 种取值，只显示人数最多的 ${rl.length} 种`)
  if (colN.size > cl.length) notes.push(`列方向有 ${colN.size} 种取值，只显示人数最多的 ${cl.length} 种`)
  const matrix: Array<Array<number | null>> = [], counts: number[][] = []
  for (const a of rl) {
    const mr: Array<number | null> = [], cr: number[] = []
    for (const b of cl) {
      const rs = cellRows.get(a)?.get(b) ?? []
      cr.push(rs.length)
      if (!rs.length) { mr.push(null); continue }
      if (valueAgg.agg === 'count') mr.push(rs.length)
      else if (valueAgg.agg === 'rate') { const v = metricValues(rs, { kind: 'rate', column: valueAgg.column ?? '', positive: valueAgg.positive }); mr.push(v.length ? r1n(mean(v) * 100) : null) }
      else {
        const v = rs.map(r => toNum(r[valueAgg.column ?? ''])).filter((x): x is number => x !== null)
        mr.push(v.length ? r2(valueAgg.agg === 'sum' ? v.reduce((s, x) => s + x, 0) : mean(v)) : null)
      }
    }
    matrix.push(mr); counts.push(cr)
  }
  const rowTotals = counts.map(r => r.reduce((s, x) => s + x, 0))
  const colTotals = cl.map((_, j) => counts.reduce((s, r) => s + r[j], 0))
  const total = rowTotals.reduce((s, x) => s + x, 0)
  const rowShare = counts.map((r, i) => r.map(x => (rowTotals[i] ? r1n((x / rowTotals[i]) * 100) : 0)))
  if (valueAgg.agg !== 'count' && !valueAgg.column) notes.push('sum / mean / rate 需要指定 column')
  let text = `「${rowKey}」×「${colKey}」交叉表：${rl.length} 行 ${cl.length} 列，共 ${total} 条记录`
  if (total) {
    let bi = 0, bj = 0
    counts.forEach((r, i) => r.forEach((x, j) => { if (x > counts[bi][bj]) { bi = i; bj = j } }))
    text += `。记录最多的组合是「${rl[bi]}」×「${cl[bj]}」，${counts[bi][bj]} 条（占 ${r1((counts[bi][bj] / total) * 100)}%）`
    const smallCells = counts.flat().filter(x => x > 0 && x < 5).length
    if (smallCells) notes.push(`有 ${smallCells} 个格子不足 5 条，比例只能参考`)
  }
  return { rowKey, colKey, rows: rl, cols: cl, matrix, counts, rowTotals, colTotals, total, rowShare, text, notes }
}

// ───────────────────────── 多选题 ─────────────────────────

const DEFAULT_SEP = /[,，;；、|\n\r]+/
/** 把一个单元格拆成多个选项（支持分隔符和 JSON 数组），去空格、去重 */
export function splitOptions(v: unknown, sep: RegExp | string = DEFAULT_SEP): string[] {
  if (isBlank(v)) return []
  if (Array.isArray(v)) return [...new Set(v.map(x => String(x).trim()).filter(Boolean))]
  const s = String(v).trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return [...new Set(a.map(x => String(x).trim()).filter(Boolean))] } catch { /* 当普通文字拆 */ }
  }
  return [...new Set(s.split(sep).map(x => x.trim()).filter(Boolean))]
}

export interface MultiChoiceResult {
  column: string; respondents: number; blank: number
  options: Array<{ option: string; count: number; rate: number; ciLow: number; ciHigh: number }>
  text: string; notes: string[]
}
/** 多选题拆分统计：分母 = 作答人数（该列非空的行数）；占比之和可以大于 100% */
export function multiChoice(rows: Row[], column: string, opts: { separator?: RegExp | string; confidence?: number } = {}): MultiChoiceResult {
  const cnt = new Map<string, number>()
  let resp = 0, blank = 0
  for (const r of rows) {
    const o = splitOptions(r[column], opts.separator)
    if (!o.length) { blank++; continue }
    resp++
    for (const x of o) cnt.set(x, (cnt.get(x) ?? 0) + 1)
  }
  const options = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([option, count]) => {
    const w = wilson(count, resp, opts.confidence ?? 0.95)
    return { option, count, rate: r1n((count / resp) * 100), ciLow: r1n(w.low * 100), ciHigh: r1n(w.high * 100) }
  })
  const notes: string[] = []
  if (blank) notes.push(`有 ${blank} 行没有作答，不计入分母`)
  if (resp > 0 && resp < DEFAULT_MIN_N) notes.push(`作答人数只有 ${resp}，占比波动大，仅供参考`)
  notes.push('多选题每人可以选多项，各项占比加起来可能超过 100%')
  const text = resp === 0 ? '没有人作答这道题' :
    `共 ${resp} 人作答（分母为作答人数）。` + options.slice(0, 5).map(o => `「${o.option}」${o.count} 人（${o.rate}%）`).join('，') + (options.length > 5 ? `，……共 ${options.length} 个选项` : '')
  return { column, respondents: resp, blank, options, text, notes }
}

// ───────────────────────── 选项与分数的关联 ─────────────────────────

export interface OptionImpactResult {
  optionColumn: string; metric: string; overall: { n: number; value: number | null }
  options: Array<{ option: string; n: number; value: number; diffFromOverall: number; diffVsOthers: number | null; p: number | null; significant: boolean; smallSample: boolean; text: string }>
  text: string; notes: string[]
}
/** 每个选项（单选或多选）对应的人，分数 / NPS / 占比 是多少，和总体差多少。只说明“相关”，不说明“因为”。 */
export function optionImpact(rows: Row[], optionColumn: string, metric: MetricSpec, opts: { multi?: boolean; separator?: RegExp | string; minN?: number } = {}): OptionImpactResult {
  const minN = opts.minN ?? DEFAULT_MIN_N
  const valid = rows.filter(r => metricValues([r], metric).length === 1)
  const allVals = metricValues(valid, metric)
  const overall = valueOf(allVals, metric)
  const per = new Map<string, Row[]>()
  const keyOf = (r: Row): string[] => (opts.multi ? splitOptions(r[optionColumn], opts.separator) : isBlank(r[optionColumn]) ? [] : [labelOf(r[optionColumn])])
  for (const r of valid) for (const o of keyOf(r)) { const a = per.get(o); if (a) a.push(r); else per.set(o, [r]) }
  const u = unitOf(metric), ut = u === '%' ? '%' : u ? ' ' + u : ''
  const options: OptionImpactResult['options'] = []
  for (const [option, rs] of per) {
    const set = new Set(rs)
    const vals = metricValues(rs, metric)
    const others = metricValues(valid.filter(r => !set.has(r)), metric)
    const value = valueOf(vals, metric)!
    const diff = overall === null ? 0 : value - overall
    const t = others.length ? testVals(vals, others, metric) : null
    const small = vals.length < minN
    const sig = !small && t?.p != null && t.p < DEFAULT_ALPHA
    options.push({
      option, n: vals.length, value: r1n(value), diffFromOverall: r1n(diff), diffVsOthers: t ? r1n(t.diff) : null, p: t?.p == null ? null : Math.round(t.p * 10000) / 10000, significant: sig, smallSample: small,
      text: `选「${option}」的 ${vals.length} 人，${metricName(metric)}为 ${r1(value)}${ut}，${diff < 0 ? '比总体低' : '比总体高'} ${r1(Math.abs(diff))} ${diffUnit(metric)}` + (small ? '（样本小，只供参考）' : sig ? `，差异显著（${pLabel(t!.p)}）` : '，差异不明显')
    })
  }
  options.sort((a, b) => a.diffFromOverall - b.diffFromOverall)
  const notes = ['这里看到的是“选了这个选项的人分数更低 / 更高”，只是相关，不能直接说是这个选项造成的']
  const miss = rows.length - valid.length
  if (miss) notes.push(`有 ${miss} 行没有有效的「${metric.column}」，没有计入`)
  const lows = options.filter(o => o.significant && o.diffFromOverall < 0)
  const text = overall === null ? '没有有效分数' :
    `总体${metricName(metric)}为 ${r1(overall)}${ut}（${allVals.length} 人）。` +
    (lows.length ? `选了这些选项的人明显更低：${lows.map(o => `「${o.option}」（${o.n} 人，低 ${r1(Math.abs(o.diffFromOverall))}）`).join('、')}。` : '没有发现样本足够且明显偏低的选项。') + '注意只是相关，不一定是原因。'
  return { optionColumn, metric: metricName(metric), overall: { n: allVals.length, value: overall === null ? null : r1n(overall) }, options, text, notes }
}

// ───────────────────────── 分布 / 分位数 ─────────────────────────

export interface QuantileResult { n: number; mean: number | null; sd: number | null; min: number | null; max: number | null; quantiles: Array<{ p: number; value: number }>; text: string }
/** 分位数（线性插值法）。ps 是 0~1 的比例 */
export function quantiles(values: unknown[], ps: number[] = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]): QuantileResult {
  const xs = values.map(toNum).filter((x): x is number => x !== null).sort((a, b) => a - b)
  if (!xs.length) return { n: 0, mean: null, sd: null, min: null, max: null, quantiles: [], text: '没有可用的数值' }
  const q = (p: number) => { const pos = (xs.length - 1) * Math.min(1, Math.max(0, p)); const lo = Math.floor(pos), hi = Math.ceil(pos); return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo) }
  const qs = ps.map(p => ({ p, value: r2(q(p)) }))
  const m = mean(xs), sd = Math.sqrt(variance(xs))
  const med = qs.find(x => x.p === 0.5)?.value ?? r2(q(0.5))
  return { n: xs.length, mean: r2(m), sd: r2(sd), min: xs[0], max: xs[xs.length - 1], quantiles: qs, text: `共 ${xs.length} 个数，平均 ${r1(m)}，中位数 ${r1(med)}，最低 ${xs[0]}，最高 ${xs[xs.length - 1]}。` + (xs.length < DEFAULT_MIN_N ? '样本偏少，仅供参考。' : '') }
}

export interface HistogramResult { n: number; outOfRange: number; bins: Array<{ label: string; from: number; to: number; count: number; share: number }>; text: string }
/** 分布 / 分段：edges 给分段边界（如 [0,60,80,90,100]，区间左闭右开，最后一段右闭）；不给就按 bins 等宽分 */
export function histogram(values: unknown[], opts: { bins?: number; edges?: number[]; labels?: string[] } = {}): HistogramResult {
  const xs = values.map(toNum).filter((x): x is number => x !== null)
  if (!xs.length) return { n: 0, outOfRange: 0, bins: [], text: '没有可用的数值' }
  let edges = opts.edges ? [...opts.edges].sort((a, b) => a - b) : []
  if (edges.length < 2) {
    const lo = Math.min(...xs), hi = Math.max(...xs), k = Math.max(1, Math.min(50, Math.floor(opts.bins ?? 10)))
    const w = hi === lo ? 1 : (hi - lo) / k
    edges = Array.from({ length: k + 1 }, (_, i) => r2(lo + w * i)); edges[k] = hi === lo ? lo + 1 : hi
  }
  const k = edges.length - 1
  const counts = new Array<number>(k).fill(0)
  let out = 0
  for (const x of xs) {
    let placed = false
    for (let i = 0; i < k; i++) { if (x >= edges[i] && (x < edges[i + 1] || (i === k - 1 && x <= edges[i + 1]))) { counts[i]++; placed = true; break } }
    if (!placed) out++
  }
  const inN = xs.length - out
  const bins = counts.map((c, i) => ({ label: opts.labels?.[i] ?? `${edges[i]}–${edges[i + 1]}`, from: edges[i], to: edges[i + 1], count: c, share: inN ? r1n((c / inN) * 100) : 0 }))
  const top = [...bins].sort((a, b) => b.count - a.count)[0]
  return { n: xs.length, outOfRange: out, bins, text: `共 ${xs.length} 个数${out ? `（${out} 个落在分段范围外）` : ''}，最集中的是 ${top.label} 段，${top.count} 个（${top.share}%）` }
}

// ───────────────────────── 比率（续费率、留存率等） ─────────────────────────

export interface Cond { column: string; op: 'eq' | 'ne' | 'in' | 'gte' | 'gt' | 'lte' | 'lt' | 'notEmpty' | 'empty'; value?: string | number | Array<string | number> }
export function matchCond(row: Row, c: Cond): boolean {
  const v = row[c.column]
  switch (c.op) {
    case 'notEmpty': return !isBlank(v)
    case 'empty': return isBlank(v)
    case 'eq': return !isBlank(v) && String(v).trim() === String(c.value).trim()
    case 'ne': return isBlank(v) || String(v).trim() !== String(c.value).trim()
    case 'in': return !isBlank(v) && (Array.isArray(c.value) ? c.value : [c.value]).some(x => String(x).trim() === String(v).trim())
    default: {
      const n = toNum(v), t = toNum(c.value)
      if (n === null || t === null) return false
      return c.op === 'gte' ? n >= t : c.op === 'gt' ? n > t : c.op === 'lte' ? n <= t : n < t
    }
  }
}
export interface RatioResult { x: number; n: number; rate: number | null; ciLow: number | null; ciHigh: number | null; confidence: number; text: string }
/** 一个比率（x/n）和它的 Wilson 置信区间（百分数） */
export function ratio(x: number, n: number, opts: { confidence?: number; name?: string } = {}): RatioResult {
  const conf = opts.confidence ?? 0.95, name = opts.name ?? '比率'
  if (n <= 0) return { x, n, rate: null, ciLow: null, ciHigh: null, confidence: conf, text: `${name}：分母为 0，算不出` }
  const w = wilson(x, n, conf)
  const rate = r1n((x / n) * 100), lo = r1n(w.low * 100), hi = r1n(w.high * 100)
  return { x, n, rate, ciLow: lo, ciHigh: hi, confidence: conf, text: `${name} ${rate}%（${x}/${n}），${Math.round(conf * 100)}% 的把握认为真实值在 ${lo}%–${hi}% 之间` + (n < DEFAULT_MIN_N ? '；分母不足 30，区间很宽，仅供参考' : '') }
}
export interface RatioGroupsResult { overall: RatioResult; groups: Array<RatioResult & { group: string; diffFromOverall: number | null; p: number | null; significant: boolean; smallSample: boolean }>; text: string; notes: string[] }
/** 按条件配置分子分母：分母 = 满足 denominator 条件的行；分子 = 其中再满足 numerator 条件的行。可按 groupKey 分组，组间与总体比较 */
export function ratioFromRows(rows: Row[], o: { numerator: Cond[]; denominator?: Cond[]; groupKey?: string; confidence?: number; minN?: number; name?: string }): RatioGroupsResult {
  const minN = o.minN ?? DEFAULT_MIN_N
  const den = rows.filter(r => (o.denominator ?? []).every(c => matchCond(r, c)))
  const hit = (r: Row) => o.numerator.every(c => matchCond(r, c))
  const overall = ratio(den.filter(hit).length, den.length, { confidence: o.confidence, name: o.name })
  const groups: RatioGroupsResult['groups'] = []
  if (o.groupKey) {
    for (const [g, rs] of groupRows(den, o.groupKey)) {
      const x = rs.filter(hit).length
      const base = ratio(x, rs.length, { confidence: o.confidence, name: `「${g}」${o.name ?? '比率'}` })
      const restN = den.length - rs.length, restX = overall.x - x
      const t = restN > 0 ? twoPropZ(x, rs.length, restX, restN) : null
      const small = rs.length < minN
      groups.push({ ...base, group: g, diffFromOverall: overall.rate === null || base.rate === null ? null : r1n(base.rate - overall.rate), p: t?.p == null ? null : Math.round(t.p * 10000) / 10000, significant: !small && t?.p != null && t.p < DEFAULT_ALPHA, smallSample: small })
    }
    groups.sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
  }
  const notes: string[] = []
  const lows = groups.filter(g => g.significant && (g.diffFromOverall ?? 0) < 0)
  const text = overall.text + (groups.length ? `。分 ${groups.length} 组看：` + (lows.length ? `明显偏低的有 ${lows.map(g => `「${g.group}」${g.rate}%`).join('、')}` : '没有样本足够且明显偏低的组') : '')
  if (groups.some(g => g.smallSample)) notes.push(`有的组分母不足 ${minN}，已标“样本小”`)
  return { overall, groups, text, notes }
}

// ───────────────────────── 关键人群：中间分段 ─────────────────────────

export interface MiddleSegmentResult {
  column: string; segmentLabel: string; n: number; segmentN: number; share: number; ciLow: number; ciHigh: number
  features: Array<{ feature: string; value: string; shareInSegment: number; shareInOthers: number; diff: number; p: number | null; significant: boolean; segN: number }>
  text: string; notes: string[]
}
/** 找“中间分段”人群（如满意度刚好 3 分、推荐分 7–8 分）：占比多少，和其他人比哪些特征更集中。featureKeys 是用来描述人群的维度列。 */
export function middleSegment(rows: Row[], o: { scoreColumn: string; min: number; max: number; featureKeys: string[]; minN?: number }): MiddleSegmentResult {
  const minN = o.minN ?? DEFAULT_MIN_N
  const valid = rows.filter(r => toNum(r[o.scoreColumn]) !== null)
  const inSeg = (r: Row) => { const v = toNum(r[o.scoreColumn])!; return v >= o.min && v <= o.max }
  const seg = valid.filter(inSeg), others = valid.filter(r => !inSeg(r))
  const w = wilson(seg.length, valid.length)
  const label = o.min === o.max ? `${o.min} 分` : `${o.min}–${o.max} 分`
  const features: MiddleSegmentResult['features'] = []
  for (const key of o.featureKeys) {
    const sg = groupRows(seg, key), og = groupRows(others, key)
    for (const v of new Set([...sg.keys(), ...og.keys()])) {
      const a = sg.get(v)?.length ?? 0, b = og.get(v)?.length ?? 0
      if (a < 5 || !seg.length || !others.length) continue
      const t = twoPropZ(a, seg.length, b, others.length)
      features.push({ feature: key, value: v, shareInSegment: r1n((a / seg.length) * 100), shareInOthers: r1n((b / others.length) * 100), diff: r1n(t.diff * 100), p: t.p === null ? null : Math.round(t.p * 10000) / 10000, significant: seg.length >= minN && t.p !== null && t.p < DEFAULT_ALPHA, segN: a })
    }
  }
  features.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
  const notes: string[] = []
  if (seg.length < minN) notes.push(`中间分段只有 ${seg.length} 人，特征对比只能参考`)
  if (features.length > 10) notes.push('比较的特征很多，个别“显著”可能是碰巧，要结合常识判断')
  const sig = features.filter(f => f.significant).slice(0, 3)
  const text = valid.length === 0 ? '没有有效分数' :
    `${label}的有 ${seg.length} 人，占 ${r1((seg.length / valid.length) * 100)}%（${valid.length} 人里；95% 区间 ${r1(w.low * 100)}%–${r1(w.high * 100)}%）。` +
    (sig.length ? '和其他人相比更集中的特征：' + sig.map(f => `「${f.feature}=${f.value}」占 ${f.shareInSegment}%，其他人 ${f.shareInOthers}%（${f.diff > 0 ? '高' : '低'} ${r1(Math.abs(f.diff))} 个百分点，${pLabel(f.p)}）`).join('；') : '没有发现明显更集中的特征。')
  return { column: o.scoreColumn, segmentLabel: label, n: valid.length, segmentN: seg.length, share: valid.length ? r1n((seg.length / valid.length) * 100) : 0, ciLow: r1n(w.low * 100), ciHigh: r1n(w.high * 100), features, text, notes }
}
