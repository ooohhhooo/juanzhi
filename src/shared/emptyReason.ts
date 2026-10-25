/** 同比「没法比」时的说明。纯函数（主进程的总览和渲染端的同比页共用，单测直接跑）。
 *  关键：基线为空是因为「按学期对齐」把别的学期的卷子排除了时，要告诉老师去关掉对齐，而不是说「没有试卷」。 */
export interface EmptyCtx {
  targetLabel: string
  baseLabel: string
  targetPapers: number
  basePapers: number
  alignOn: boolean
  /** 因学期不一致被排除的基线卷子数 */
  dropped: number
  /** 目标学年的学期，如「上学期」 */
  targetSemesters: string
  /** 在哪一页读：总览里没有开关，只能指路 */
  where: 'compare' | 'overview'
}

export function emptyReason(c: EmptyCtx): string | null {
  if (c.targetPapers === 0) return `${c.targetLabel}没有计入统计的试卷`
  if (c.basePapers > 0) return null
  if (c.alignOn && c.dropped > 0) {
    return `${c.baseLabel}有 ${c.dropped} 份卷子，但它们的学期与目标学年（只有${c.targetSemesters}的卷子）不一致，按学期对齐时被排除了，所以没有可比的基线。` +
      (c.where === 'compare' ? '可以关掉上面的「按学期对齐」再比较（只在缺少的那个学期里才考的知识点会被显示成「新增」或「消失」）。' : '可以到「分析看板 → 同比」页关掉「按学期对齐」再比较。')
  }
  return c.where === 'compare' ? `基线（${c.baseLabel}）没有计入统计的试卷` : '没有更早学年的试卷可比'
}
