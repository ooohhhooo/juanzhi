/** 试卷库「按知识点筛选」的纯函数：把主进程算出的命中表套到试卷列表上（不依赖 electron / React，单测直接跑） */
/** 一次最多选几个知识点 / 并排对比最多几份卷子 */
export const MAX_KP_CODES = 30
export const MAX_COMPARE_PAPERS = 40

export interface KpHit { code: string; name: string; questions: number }
export interface KpHitRow { paperId: string; hits: KpHit[] }

/** 合并多路查询（真实数据、示例数据各查一次）的命中表 */
export function hitMap(...lists: KpHitRow[][]): Map<string, KpHit[]> {
  const m = new Map<string, KpHit[]>()
  for (const l of lists) for (const r of l) m.set(r.paperId, r.hits)
  return m
}

/** 只留命中的卷子；没选知识点（hits 为 null）= 不筛 */
export function filterByHits<T extends { id: string }>(papers: T[], hits: Map<string, KpHit[]> | null): T[] {
  return hits ? papers.filter(p => hits.has(p.id)) : papers
}

/** 一行命中文字：「时态 3 题、从句 1 题」 */
export const hitText = (hits: KpHit[] | undefined): string => (hits ?? []).map(h => `${h.name} ${h.questions} 题`).join('、')
