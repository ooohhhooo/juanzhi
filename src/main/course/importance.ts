/**
 * 知识点在校内试卷里的「重要度」（占分）：当前试卷范围里，每份卷子平均占多少分、几份卷子考过、易错率。
 * 复用 stats/core 的 nodeStats（题目分值按「主知识点」算，一道题只算给它的主知识点；子树汇总），不重新统计。
 * 注意：软件里没有学生成绩，「易错」只是卷子上常见的易错点。纯函数（数据库由调用方传入）。
 */
import { nodeStats, scopeCounts } from '../stats/core.ts'
import { paperScope } from '../stats/filter.ts'
import type { StatsFilter } from '../stats/filter.ts'

type Db = any

export interface KpImportance {
  code: string
  /** 考过这个知识点（含子孙）的卷子数 / 范围内卷子总数 */
  papers: number
  paperTotal: number
  /** 每份卷子平均占几分（主知识点分值合计 ÷ 范围内卷子数）；范围内题目都没填分值时为 0 */
  avgScore: number
  /** 易错题数 / 题数 */
  errorRate: number
  errorCount: number
  questions: number
  /** 排序用的重要度：有分值用「平均占分」，没分值就用「考过的卷子占比 × 10」（同一范围内口径一致） */
  weight: number
}

export interface ImportanceMap { byCode: Map<string, KpImportance>; paperTotal: number; hasScores: boolean }

export function kpImportance(db: Db, filter: StatsFilter): ImportanceMap {
  const scope = paperScope(filter)
  const counts = scopeCounts(db, scope)
  const hasScores = counts.totalScore > 0
  const byCode = new Map<string, KpImportance>()
  if (counts.papers === 0) return { byCode, paperTotal: 0, hasScores }
  for (const n of nodeStats(db, scope)) {
    const avgScore = n.score / counts.papers
    byCode.set(n.code, {
      code: n.code, papers: n.papers, paperTotal: counts.papers, avgScore: Math.round(avgScore * 10) / 10,
      errorRate: n.questions > 0 ? n.errorCount / n.questions : 0, errorCount: n.errorCount, questions: n.questions,
      weight: hasScores ? avgScore : (n.papers / counts.papers) * 10
    })
  }
  return { byCode, paperTotal: counts.papers, hasScores }
}

const EMPTY = (code: string, paperTotal: number): KpImportance => ({ code, papers: 0, paperTotal, avgScore: 0, errorRate: 0, errorCount: 0, questions: 0, weight: 0 })
export const importanceOf = (m: ImportanceMap, code: string): KpImportance => m.byCode.get(code) ?? EMPTY(code, m.paperTotal)

/** 老师看得懂的说法：「校内约占 6 分 · 4/5 份卷子考过」；范围内没考到 =「范围内没考到」；没填分值就只说几份卷子 */
export function importanceText(i: KpImportance, hasScores: boolean): string {
  if (i.papers === 0) return '范围内没考到'
  const share = hasScores && i.avgScore > 0 ? `校内约占 ${i.avgScore % 1 === 0 ? i.avgScore : i.avgScore.toFixed(1)} 分` : '校内考到'
  return `${share} · ${i.papers}/${i.paperTotal} 份卷子考过${i.errorRate >= 0.3 ? ' · 易错' : ''}`
}
