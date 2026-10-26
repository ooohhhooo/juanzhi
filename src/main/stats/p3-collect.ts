/**
 * P3 报告的统计取数：把「按筛选取分布 / 重难点 / 同比 / 学年 / 年级与考试类型个数」收成一个纯函数（只依赖数据库连接，不依赖 electron），
 * report/service.ts 和单测共用同一个入口——重难点取全量（P3_HOT_LIMIT）这个易错的调用点因此有测试守着（M4 复审 P2-2）。
 */
import { compare, distribution, hot } from './core.ts'
import { paperScope } from './filter.ts'
import type { StatsFilter } from './filter.ts'
import { P3_HOT_LIMIT } from './p3.ts'
import type { P3Source } from './p3.ts'

export function collectP3Source(db: any, filter: StatsFilter): P3Source {
  const dist = distribution(db, filter)
  // 取全量：易错点表要的是「有易错题的」，不能被综合得分的前 30 名截掉（M4 审核 P1-4）
  const hotRes = hot(db, filter, 2, P3_HOT_LIMIT, undefined, false)
  const sc = paperScope(filter)
  const years = (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${sc.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...sc.params) as any[]).map(r => r.y as number)
  const distinct = (col: string) => (db.prepare(`SELECT COUNT(DISTINCT p.${col}) c FROM papers p WHERE ${sc.where} AND p.${col} IS NOT NULL AND p.${col} <> ''`).get(...sc.params) as any).c as number
  // 年度变化：范围里有两个以上学年时，最新学年 vs 之前（和同比页同一套口径：默认按学期对齐）；筛选里指定了学年就只有一个学年
  let cmp = null
  if (years.length >= 2) {
    const target = years[years.length - 1]
    const { school_year_start: _drop, ...rest } = filter
    cmp = compare(db, rest, target, { lt: target }, 2, 0, true)
  }
  return { filter, dist, hot: hotRes, cmp, years, distinctGrades: distinct('grade'), distinctExamTypes: distinct('exam_type') }
}
