/**
 * 给 Agent 内核用的统计工具定义。模型只传「数据集 id + SQL」和统计参数，
 * 数据由集成方提供的 ctx.runQuery 取回（只读查询），统计由本目录的纯函数算——模型不用也不该心算。
 */
import { z } from 'zod'
import * as S from './core.ts'
import type { Row } from './core.ts'

/** 集成方提供：在给定数据集上执行只读 SQL，返回行数组（可带 truncated 标记） */
export interface StatToolContext {
  runQuery(sql: string, datasets: string[]): Promise<Row[] | { rows: Row[]; truncated?: boolean }>
}

export interface StatTool<P extends z.ZodTypeAny = z.ZodTypeAny, C = StatToolContext> {
  name: string
  description: string
  params: P
  level: 'read'
  run(args: z.infer<P>, ctx: C): Promise<unknown>
}

const datasets = z.array(z.string()).min(1).describe('数据集 id 列表（SQL 里用到哪些数据集就写哪些）')
const sql = z.string().min(1).describe('只读 SQL（SELECT）。返回「一行一个人 / 一条记录」的明细，不要先汇总')
const metricParams = {
  metric: z.enum(['mean', 'rate', 'nps']).describe('mean=平均分；rate=占比（如续费率、到课率）；nps=推荐分的 NPS'),
  column: z.string().describe('指标所在的列名（SQL 结果里的列）'),
  unit: z.string().optional().describe('均值的单位，如「分」「分钟」，只用于说明文字'),
  positiveValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe('rate 用：哪些取值算“发生了”（如 ["已续费"]）；不写则把 1、是、true、yes 当作发生'),
  positiveMin: z.number().optional().describe('rate 用：数值列大于等于这个数算“发生了”（如到课率用 1）'),
  promoterMin: z.number().optional().describe('nps 用：推荐者下限，默认 9'),
  passiveMin: z.number().optional().describe('nps 用：中立者下限，默认 7（低于它是贬损者）')
}
type MetricArgs = { metric: 'mean' | 'rate' | 'nps'; column: string; unit?: string; positiveValues?: Array<string | number | boolean>; positiveMin?: number; promoterMin?: number; passiveMin?: number }
const toMetric = (a: MetricArgs): S.MetricSpec => a.metric === 'mean'
  ? { kind: 'mean', column: a.column, unit: a.unit }
  : a.metric === 'rate'
    ? { kind: 'rate', column: a.column, positive: a.positiveValues ? { in: a.positiveValues } : a.positiveMin !== undefined ? { gte: a.positiveMin } : undefined }
    : { kind: 'nps', column: a.column, promoterMin: a.promoterMin, passiveMin: a.passiveMin }

class InputError extends Error {}

async function load(ctx: StatToolContext, a: { datasets: string[]; sql: string }, need: string[]): Promise<{ rows: Row[]; notes: string[] }> {
  const res = await ctx.runQuery(a.sql, a.datasets)
  const rows = Array.isArray(res) ? res : res.rows
  const notes: string[] = []
  if (!Array.isArray(res) && res.truncated) notes.push('查询结果被截断，只用了返回的这些行，统计可能不完整；请在 SQL 里先筛选或换更小的范围')
  if (!rows.length) throw new InputError('查询没有返回任何行，请检查 SQL 的条件')
  const have = new Set(Object.keys(rows[0]))
  const missing = need.filter(c => c && !have.has(c))
  if (missing.length) throw new InputError(`查询结果里没有这些列：${missing.join('、')}。现有的列：${[...have].join('、')}`)
  return { rows, notes }
}
async function wrap(fn: () => Promise<Record<string, unknown>>): Promise<unknown> {
  try { return { ok: true, ...(await fn()) } } catch (e) {
    if (e instanceof InputError) return { ok: false, error: e.message }
    throw e
  }
}
const withNotes = <T extends { notes?: string[] }>(r: T, extra: string[]): T => (extra.length ? { ...r, notes: [...extra, ...(r.notes ?? [])] } : r)

/** 让 run 的 args 按各自的 zod 参数推断类型 */
const tool = <P extends z.ZodTypeAny>(t: StatTool<P>): StatTool => t as unknown as StatTool

export const statTools: StatTool[] = [
  tool({
    name: 'stat_nps', level: 'read',
    description: '算 NPS（净推荐值）：推荐者（默认 9–10 分）占比减贬损者（0–6 分）占比。传入数据集 id 和 SQL（返回含推荐分的明细行），指定分数列；可选 groupKey 按某个维度分组各算一个 NPS。返回：样本量、三类人占比、NPS、一句白话说明 text（可直接引用）；分组时返回每组的 NPS、样本量、与总体差值、是否样本小。分数列里的空值和非数字会被忽略并说明。',
    params: z.object({ datasets, sql, scoreColumn: z.string().describe('推荐分所在的列'), groupKey: z.string().optional().describe('可选：按这一列分组'), promoterMin: z.number().optional(), passiveMin: z.number().optional(), minN: z.number().optional().describe('样本小的阈值，默认 30') }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.scoreColumn, a.groupKey ?? ''])
        const overall = S.nps(rows.map(r => r[a.scoreColumn]), { promoterMin: a.promoterMin, passiveMin: a.passiveMin })
        const groups = a.groupKey ? S.compareGroups(rows, a.groupKey, { kind: 'nps', column: a.scoreColumn, promoterMin: a.promoterMin, passiveMin: a.passiveMin }, { minN: a.minN }) : undefined
        return { overall, groups, notes }
      })
    }
  }),
  tool({
    name: 'stat_compare_groups', level: 'read',
    description: '按某一列分组，比较每组的均值 / 占比 / NPS。传入数据集 id、SQL（明细行）、分组列 groupKey，以及指标（metric=mean / rate / nps 和 column）。返回：总体值，每组的样本量、值、与总体的差、与其余各组比较的 p 值、是否显著、是否样本小（默认 <30 不下显著性结论），按值从低到高排；text 给出一句总结。组很多时会提醒“碰巧显著”的风险。',
    params: z.object({ datasets, sql, groupKey: z.string().describe('分组的列，如班级、老师、期次、新老生'), ...metricParams, minN: z.number().optional().describe('样本小的阈值，默认 30') }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column, a.groupKey])
        return withNotes({ ...S.compareGroups(rows, a.groupKey, toMetric(a), { minN: a.minN }) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_find_low_groups', level: 'read',
    description: '逐层找“明显偏低的小组”（direction=high 找偏高）。传入数据集 id、SQL（明细行）、从粗到细的维度列 dimensions（如 ["年级","班级","老师"]，只能用数据里有的列）、指标。每一层的组与它的上级组比较（第一层与总体比），样本够（默认≥30）且 z 值达到阈值（默认 1.96）、差值够大才标出。返回：flagged 列表（路径、样本量、值、上级值、差、z、p、理由 reason）、样本太小但有偏离的组（只提示）、检验了多少个组、text 总结和多重检验提醒。结果是“哪里偏低”，不是“为什么偏低”。',
    params: z.object({ datasets, sql, dimensions: z.array(z.string()).min(1).max(6), ...metricParams, minN: z.number().optional(), zThreshold: z.number().optional().describe('默认 1.96，越大越严格'), minDiff: z.number().optional().describe('至少差多少才算（均值用原单位，占比 / NPS 用百分点 / 分），默认 0'), direction: z.enum(['low', 'high', 'both']).optional(), drillOnlyFlagged: z.boolean().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column, ...a.dimensions])
        return withNotes({ ...S.findLowGroups(rows, toMetric(a), a) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_period_compare', level: 'read',
    description: '本期 vs 上期（环比、同比都用它）。传入数据集 id、SQL（明细行，需有一列标明属于哪一期）、期次列 periodKey、本期取值 cur、上期取值 prev、指标。可选 segmentKey（如新生 / 老生、校区）：两期都有分层时，会额外返回“按本期结构加权”的对比，把变化拆成“各层自己的真变化”和“人群结构变化带来的假变化”。返回：两期值、差、变化率、p 值、加权对比、text。',
    params: z.object({ datasets, sql, periodKey: z.string(), cur: z.string().describe('本期在期次列里的取值'), prev: z.string().describe('对比期在期次列里的取值'), segmentKey: z.string().optional(), ...metricParams }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column, a.periodKey, a.segmentKey ?? ''])
        return withNotes({ ...S.periodCompareFromRows(rows, { periodKey: a.periodKey, cur: a.cur, prev: a.prev, metric: toMetric(a), segmentKey: a.segmentKey }) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_crosstab', level: 'read',
    description: '交叉表：行维度 × 列维度。传入数据集 id、SQL（明细行）、rowKey、colKey，agg 选 count（记录数）/ sum / mean（需 valueColumn）/ rate（需 valueColumn，可加 positiveValues）。返回：行列标签、每格的值和记录数、行合计列合计、每行内各列占比、text。行列取值太多时只留记录最多的前几个并说明。',
    params: z.object({ datasets, sql, rowKey: z.string(), colKey: z.string(), agg: z.enum(['count', 'sum', 'mean', 'rate']).default('count'), valueColumn: z.string().optional(), positiveValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(), maxRows: z.number().optional(), maxCols: z.number().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.rowKey, a.colKey, a.valueColumn ?? ''])
        if (a.agg !== 'count' && !a.valueColumn) throw new InputError('agg 不是 count 时必须给 valueColumn')
        return withNotes({ ...S.crosstab(rows, a.rowKey, a.colKey, { agg: a.agg, column: a.valueColumn, positive: a.positiveValues ? { in: a.positiveValues } : undefined }, a) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_multi_choice', level: 'read',
    description: '多选题拆分统计。传入数据集 id、SQL（明细行）、多选题所在的列（一个格子里多个选项，用逗号、顿号、分号、换行或 JSON 数组分隔）。返回：作答人数（分母，空白不算）、每个选项的人数、占作答人数的比例和 95% 置信区间、text。占比之和可能超过 100%。',
    params: z.object({ datasets, sql, column: z.string() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column])
        return withNotes({ ...S.multiChoice(rows, a.column) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_option_impact', level: 'read',
    description: '选项与分数的关联：选了某个选项的人，平均分 / NPS / 占比是多少，比总体、比没选的人差多少，显著不显著。传入数据集 id、SQL（明细行，既有选项列又有分数列）、optionColumn、指标，multi=true 表示选项列是多选（会拆开）。返回按差值从低到高排列的选项列表和 text。只能说明相关，不能说明因果，回答时要这样说。',
    params: z.object({ datasets, sql, optionColumn: z.string(), multi: z.boolean().optional(), ...metricParams, minN: z.number().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column, a.optionColumn])
        return withNotes({ ...S.optionImpact(rows, a.optionColumn, toMetric(a), { multi: a.multi, minN: a.minN }) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_distribution', level: 'read',
    description: '一列数值的分布：分位数（最低、10%、25%、中位数、75%、90%、最高）、均值、标准差，以及分段人数（edges 给分段边界，如 [0,60,80,90,100]，区间左闭右开、最后一段右闭；不给就等宽分 bins 段）。传入数据集 id、SQL（明细行）、数值列。',
    params: z.object({ datasets, sql, column: z.string(), edges: z.array(z.number()).optional(), bins: z.number().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.column])
        const vals = rows.map(r => r[a.column])
        return { quantiles: S.quantiles(vals), histogram: S.histogram(vals, { edges: a.edges, bins: a.bins }), notes }
      })
    }
  }),
  tool({
    name: 'stat_ratio', level: 'read',
    description: '续费率、留存率、到课率这类“分子 / 分母”的比率，带 95% 置信区间。传入数据集 id、SQL（明细行）、分母条件 denominator（先圈出该算的人，如“到期学员”）、分子条件 numerator（其中算数的人，如“已续费”）。条件形如 {column, op, value}，op 可选 eq/ne/in/gte/gt/lte/lt/notEmpty/empty。可选 groupKey 分组，各组与总体比较。分母很小（<30）会提示。',
    params: z.object({ datasets, sql, name: z.string().optional().describe('比率名称，如「续费率」'), numerator: z.array(z.object({ column: z.string(), op: z.enum(['eq', 'ne', 'in', 'gte', 'gt', 'lte', 'lt', 'notEmpty', 'empty']), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional() })).min(1), denominator: z.array(z.object({ column: z.string(), op: z.enum(['eq', 'ne', 'in', 'gte', 'gt', 'lte', 'lt', 'notEmpty', 'empty']), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional() })).optional(), groupKey: z.string().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [...a.numerator.map(c => c.column), ...(a.denominator ?? []).map(c => c.column), a.groupKey ?? ''])
        return withNotes({ ...S.ratioFromRows(rows, a) }, notes)
      })
    }
  }),
  tool({
    name: 'stat_middle_segment', level: 'read',
    description: '关键人群：中间分段（如满意度刚好 3 分、推荐分 7–8 分）占多少，和其他人比哪些特征更集中。传入数据集 id、SQL（明细行）、分数列 scoreColumn、分段范围 min / max（闭区间）、用来描述人群的维度列 featureKeys（如年级、新老生、老师）。返回占比及置信区间、特征对比列表（占比、与其他人差多少个百分点、p 值）、text。',
    params: z.object({ datasets, sql, scoreColumn: z.string(), min: z.number(), max: z.number(), featureKeys: z.array(z.string()).min(1).max(8), minN: z.number().optional() }),
    async run(a, ctx) {
      return wrap(async () => {
        const { rows, notes } = await load(ctx, a, [a.scoreColumn, ...a.featureKeys])
        return withNotes({ ...S.middleSegment(rows, a) }, notes)
      })
    }
  })
]
