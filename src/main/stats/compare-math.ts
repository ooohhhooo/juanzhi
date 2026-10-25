/**
 * 同比的分类规则（设计方案 §4）。全部用整数运算，避免 0.2 这类浮点比较在「恰好 20 个百分点」时出错。
 *
 *  新增 = 目标学年出现、基线从未出现；消失 = 基线出现、目标学年没出现；
 *  上升/下降 = 两边都出现，且出现率变化 ≥ 20 个百分点（含恰好 20）。
 */
export const CHANGE_THRESHOLD_PP = 20
export const MIN_SAMPLE = 5

export type ChangeKind = 'added' | 'removed' | 'up' | 'down'

/** @param aT 目标学年含该知识点的试卷数  @param nT 目标学年试卷数  @param aB/nB 基线同理。任一侧试卷数为 0 时无法比较，返回 null */
export function classifyChange(aT: number, nT: number, aB: number, nB: number): ChangeKind | null {
  if (nT <= 0 || nB <= 0) return null
  if (aT > 0 && aB === 0) return 'added'
  if (aT === 0 && aB > 0) return 'removed'
  if (aT === 0 && aB === 0) return null
  // (aT/nT − aB/nB) × 100 ≥ 20  ⇔  100 × (aT×nB − aB×nT) ≥ 20 × nT × nB
  const diff100 = 100 * (aT * nB - aB * nT)
  const bar = CHANGE_THRESHOLD_PP * nT * nB
  if (diff100 >= bar) return 'up'
  if (-diff100 >= bar) return 'down'
  return null
}

/** 出现率变化（百分点），保留 1 位小数；只用于展示与排序 */
export function deltaPoints(aT: number, nT: number, aB: number, nB: number): number {
  if (nT <= 0 || nB <= 0) return 0
  return Math.round((aT / nT - aB / nB) * 1000) / 10
}

/** 任一侧试卷数不足 5 份即为样本有限 */
export function limitedSides(nT: number, nB: number): Array<'target' | 'base'> {
  const out: Array<'target' | 'base'> = []
  if (nT < MIN_SAMPLE) out.push('target')
  if (nB < MIN_SAMPLE) out.push('base')
  return out
}
