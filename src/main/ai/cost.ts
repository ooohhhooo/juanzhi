/**
 * 费用估算（纯逻辑）：历史平均 token × 调用次数 × 用户填的价格。
 * 不内置任何价格；没填价格时只给 token。
 */

/** 一个模型的价格（元 / 百万 token）。cachedInPer1M：缓存命中的输入价，没填按输入价算 */
export interface Prices { inPer1M: number | null; outPer1M: number | null; cachedInPer1M?: number | null }
export const NO_PRICES: Prices = { inPer1M: null, outPer1M: null, cachedInPer1M: null }
export const hasPrices = (p: Prices | null | undefined): p is Prices => !!p && p.inPer1M !== null && p.outPer1M !== null
/** 按模型名分别存的价格 */
export type PriceMap = Record<string, Prices>

const priceNum = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100000 ? x : null)

export function parsePrices(v: unknown): Prices {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  return { inPer1M: priceNum(o.inPer1M), outPer1M: priceNum(o.outPer1M), cachedInPer1M: priceNum(o.cachedInPer1M) }
}

/** 读取按模型存的价格表；不是对象 / 全部无效返回 null */
export function parsePriceMap(v: unknown): PriceMap | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: PriceMap = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const name = k.trim()
    if (name && name.length <= 120) out[name] = parsePrices(val)
  }
  return out
}

export interface ModelCfg { model: string; parse_model: string; vision_model: string }

/** 某类调用（ai_usage.kind）会用的模型：拆题→拆题模型（没设就用主模型），读图→视觉模型，其余→主模型 */
export function modelForKind(cfg: ModelCfg, kind: string): string {
  const main = cfg.model.trim()
  if (kind.includes('vision')) return cfg.vision_model.trim() || main
  if (kind === 'parse' || kind.startsWith('parse')) return cfg.parse_model.trim() || main
  return main
}

/** 当前配置里用到的模型（去重、非空）及用途 */
export function configModels(cfg: ModelCfg): Array<{ model: string; roles: string[] }> {
  const out: Array<{ model: string; roles: string[] }> = []
  const add = (m: string, role: string) => {
    const name = m.trim()
    if (!name) return
    const hit = out.find(x => x.model === name)
    if (hit) { if (!hit.roles.includes(role)) hit.roles.push(role) } else out.push({ model: name, roles: [role] })
  }
  add(cfg.model, '写报告')
  add(modelForKind(cfg, 'parse'), '拆题')
  if (cfg.vision_model.trim()) add(cfg.vision_model, '读图')
  return out
}

/** 旧版只有一组价格：已有新价格表就不动；否则旧价格作为当前主模型的价格（拆题模型与主模型相同时自然同一条）。返回 null = 无需迁移 */
export function migrateLegacyPrices(legacy: unknown, existing: PriceMap | null, cfg: ModelCfg): PriceMap | null {
  if (existing) return null
  const p = parsePrices(legacy)
  if (p.inPer1M === null && p.outPer1M === null) return null
  const main = cfg.model.trim()
  if (!main) return null
  return { [main]: { inPer1M: p.inPer1M, outPer1M: p.outPer1M, cachedInPer1M: null } }
}

/** token → 元；价格没填全返回 null。cached = 输入里缓存命中的部分（含在 tokIn 内），按缓存价算，没填缓存价按输入价 */
export function tokensToMoney(tokIn: number, tokOut: number, p: Prices | null | undefined, cached = 0): number | null {
  if (!p || p.inPer1M === null || p.outPer1M === null) return null
  const c = Math.min(Math.max(0, cached), tokIn)
  const cp = p.cachedInPer1M ?? p.inPer1M
  return ((tokIn - c) * p.inPer1M + c * cp + tokOut * p.outPer1M) / 1_000_000
}

export interface KindAvg { calls: number; avgIn: number; avgOut: number; avgCached?: number }

export interface CostEstimate {
  calls: number
  fromHistory: boolean
  tokensIn: number
  tokensOut: number
  tokens: number
  /** 元，价格没填为 null */
  low: number | null
  high: number | null
}

/**
 * 估算：有历史就用「调用次数 × 历史平均」，范围 ×0.8 ~ ×1.3；
 * 没有历史就用现有估算（只有总数，按 7:3 拆成输入/输出），范围放宽到 ×0.6 ~ ×2.5（推理模型的输出常常远超估算）。
 * prices 是该任务会用的那个模型的价格。
 */
export function estimateCost(calls: number, hist: KindAvg | null, fallbackTokens: number, prices: Prices | null): CostEstimate {
  const n = Math.max(0, Math.round(calls))
  const fromHistory = !!hist && hist.calls > 0
  const tokensIn = fromHistory ? Math.round(n * hist!.avgIn) : Math.round(fallbackTokens * 0.7)
  const tokensOut = fromHistory ? Math.round(n * hist!.avgOut) : Math.round(fallbackTokens * 0.3)
  const cached = fromHistory ? Math.round(n * (hist!.avgCached ?? 0)) : 0
  const [lo, hi] = fromHistory ? [0.8, 1.3] : [0.6, 2.5]
  const mid = tokensToMoney(tokensIn, tokensOut, prices, cached)
  return { calls: n, fromHistory, tokensIn, tokensOut, tokens: tokensIn + tokensOut, low: mid === null ? null : mid * lo, high: mid === null ? null : mid * hi }
}

export interface UsageRow { kind: string; model: string; calls: number; prompt: number; completion: number; cached: number }

/** 本月用量：每行按其模型的价格换算；合计只含填了价格的模型，unpriced = 有模型没填价格 */
export function summarizeUsage(rows: UsageRow[], prices: PriceMap): { rows: Array<UsageRow & { label: string; money: number | null }>; total: number; unpriced: boolean } {
  let total = 0
  let unpriced = false
  const out = rows.map(r => {
    const money = tokensToMoney(r.prompt, r.completion, prices[r.model], r.cached)
    if (money === null) unpriced = true; else total += money
    return { ...r, label: kindLabel(r.kind), money }
  })
  return { rows: out, total, unpriced }
}

/** 余额是否可能不够（只比较同为人民币的情况；价格单位是元） */
export function mayBeShort(est: Pick<CostEstimate, 'high'>, balance: number | null, currency: string | null): boolean {
  return est.high !== null && balance !== null && currency === 'CNY' && est.high > balance
}

export const KIND_LABELS: Record<string, string> = {
  'course-match': '课程匹配', 'course-cols': '课程整理（认列）', 'course-extract': '课程整理（文档提取）', 'course-advice': '课程话术',
  p3_report: '报告（完整数据版）', p3_boss: '报告（运营版）', p3_parent: '报告（家长版）', p3_teacher: '报告（老师版）',
  p3_tricks: '报告口诀', p4_variant_gen: '报告变形题', p4_variant_check: '变形题核对', p5_course_advice: '报告课程对照', p5_course_hint: '报告课程一句话',
  p2_yoy: '同比分析', p2_kp: '考点分析', 'parse-text': '试卷解析（文字）', 'parse-vision': '试卷解析（读图）', 'test-text': '连接测试', 'test-vision': '连接测试', agent: '助手'
}
export const kindLabel = (k: string) => KIND_LABELS[k] ?? k

/** 跟踪同时进行的任务：并发的任务花费混在一起算不准，标记为重叠后不记录 */
export function createSpendTracker() {
  const active = new Set<{ overlapped: boolean }>()
  return {
    begin() {
      const t = { overlapped: active.size > 0 }
      for (const a of active) a.overlapped = true
      active.add(t)
      return t
    },
    end(t: { overlapped: boolean }) { active.delete(t); return !t.overlapped }
  }
}

/** 前后余额 → 实际花费；币种不同、变多了（充值）或缺数据返回 null */
export function spendFrom(before: { amount: number | null; currency: string } | null, after: { amount: number | null; currency: string } | null): { amount: number; currency: string } | null {
  if (!before || !after || before.amount === null || after.amount === null || before.currency !== after.currency) return null
  const d = before.amount - after.amount
  return d >= 0 ? { amount: Math.round(d * 10000) / 10000, currency: before.currency } : null
}
