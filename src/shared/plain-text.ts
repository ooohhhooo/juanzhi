/**
 * 把统计数字翻成白话的小函数（B6 / B8）。界面和报告共用，纯函数，单测直接加载。
 * 例：「出现率 2/2 份」→「两份卷子都考了」；「基线 0/1 → 目标 1/1」→「去年没考，今年考了」。
 */
const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']
const cn = (n: number) => (n >= 0 && n <= 10 ? CN[n] : String(n))

/** 在 total 份卷子里有 papers 份考了 */
export function appearText(papers: number, total: number): string {
  if (total <= 0) return '没有卷子'
  if (papers <= 0) return total === 1 ? '这份卷子没考' : `${cn(total)}份卷子都没考`
  if (papers === total) return total === 1 ? '这份卷子考了' : total === 2 ? '两份卷子都考了' : `${cn(total)}份卷子都考了`
  return `${cn(total)}份卷子里有${cn(papers)}份考了`
}

/** 「去年及以前」和「今年」的对比，一句话（样本不足时不要用它下结论） */
export function compareText(aB: number, nB: number, aT: number, nT: number): string {
  if (aB === 0 && aT > 0) return `去年及以前没考，今年考了（今年 ${aT}/${nT} 份卷子有）`
  if (aT === 0 && aB > 0) return `去年及以前考过（${aB}/${nB} 份卷子有），今年没考`
  if (aB === 0 && aT === 0) return '两边都没考'
  const up = aT * nB > aB * nT
  const same = aT * nB === aB * nT
  return `去年及以前 ${aB}/${nB} 份卷子有，今年 ${aT}/${nT} 份有${same ? '，差不多' : up ? '，比例变高了' : '，比例变低了'}`
}

/** 平均难度（1–5）翻成一个词 */
export function difficultyText(avg: number | null | undefined): string {
  if (avg === null || avg === undefined || Number.isNaN(avg)) return '—'
  if (avg < 2.2) return '较容易'
  if (avg < 2.8) return '中等偏易'
  if (avg < 3.2) return '中等'
  if (avg < 3.8) return '中等偏难'
  if (avg < 4.5) return '较难'
  return '很难'
}

export type HotLabel = '重点' | '难点' | '又重又难' | '个例' | '一般'

/**
 * 重难点页给每个知识点打一个标签，不再让人去猜「综合得分 0.1007」是高是低：
 *  - 总份数 ≥ 2 而只在 1 份卷子里出现 → 个例（不进重点 / 难点结论）；
 *  - 重点：出现率 ≥ 2/3 且占分不低于中位数；难点：易错率 ≥ 50% 或平均难度 ≥ 3.5。两者都满足 = 又重又难。
 * @param medianShare 当前表里占比（分值或题数）的中位数
 */
export function hotLabel(r: { papers: number; rate: number; share: number; errorRate: number; avgDifficulty: number | null }, totalPapers: number, medianShare: number): HotLabel {
  if (totalPapers >= 2 && r.papers === 1) return '个例'
  const heavy = r.rate >= 2 / 3 && r.share >= medianShare
  const hard = r.errorRate >= 0.5 || (r.avgDifficulty ?? 0) >= 3.5
  return heavy && hard ? '又重又难' : heavy ? '重点' : hard ? '难点' : '一般'
}
