/**
 * 费用估算（纯逻辑）：历史平均 token × 调用次数 × 用户填的价格。
 * 不内置任何价格；没填价格时只给 token。
 */

export interface Prices { inPer1M: number | null; outPer1M: number | null }
export const NO_PRICES: Prices = { inPer1M: null, outPer1M: null }
export const hasPrices = (p: Prices) => p.inPer1M !== null && p.outPer1M !== null

export function parsePrices(v: unknown): Prices {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const f = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100000 ? x : null)
  return { inPer1M: f(o.inPer1M), outPer1M: f(o.outPer1M) }
}

/** token → 元；价格没填全返回 null */
export function tokensToMoney(tokIn: number, tokOut: number, p: Prices): number | null {
  if (p.inPer1M === null || p.outPer1M === null) return null
  return (tokIn * p.inPer1M + tokOut * p.outPer1M) / 1_000_000
}

export interface KindAvg { calls: number; avgIn: number; avgOut: number }

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
 */
export function estimateCost(calls: number, hist: KindAvg | null, fallbackTokens: number, prices: Prices): CostEstimate {
  const n = Math.max(0, Math.round(calls))
  const fromHistory = !!hist && hist.calls > 0
  const tokensIn = fromHistory ? Math.round(n * hist!.avgIn) : Math.round(fallbackTokens * 0.7)
  const tokensOut = fromHistory ? Math.round(n * hist!.avgOut) : Math.round(fallbackTokens * 0.3)
  const [lo, hi] = fromHistory ? [0.8, 1.3] : [0.6, 2.5]
  const mid = tokensToMoney(tokensIn, tokensOut, prices)
  return { calls: n, fromHistory, tokensIn, tokensOut, tokens: tokensIn + tokensOut, low: mid === null ? null : mid * lo, high: mid === null ? null : mid * hi }
}

/** 余额是否可能不够（只比较同为人民币的情况；价格单位是元） */
export function mayBeShort(est: Pick<CostEstimate, 'high'>, balance: number | null, currency: string | null): boolean {
  return est.high !== null && balance !== null && currency === 'CNY' && est.high > balance
}

export const KIND_LABELS: Record<string, string> = {
  'course-match': '课程匹配', 'course-cols': '课程整理（认列）', 'course-extract': '课程整理（文档提取）', 'course-advice': '课程话术',
  p3_report: '报告（完整数据版）', p3_boss: '报告（运营版）', p3_parent: '报告（家长版）', p3_teacher: '报告（老师版）',
  p3_tricks: '报告口诀', p4_variant_gen: '报告变形题', p4_variant_check: '变形题核对', p5_course_advice: '报告课程对照', p5_course_hint: '报告课程一句话',
  p2_yoy: '同比分析', p2_kp: '考点分析', 'parse-text': '试卷解析（文字）', 'parse-vision': '试卷解析（读图）', 'test-text': '连接测试', 'test-vision': '连接测试'
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
