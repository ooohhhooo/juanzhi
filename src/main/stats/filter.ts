/**
 * 统计的筛选条件与「哪些卷子计入统计」。纯函数模块（不依赖 electron），单测直接加载。
 *
 * 计入规则（设计方案 §4 + M3 审核后的决定）：
 *  - 默认只统计状态为 done（老师已确认）的卷子；includeReviewing=true 时把 reviewing（AI 结果未确认）也算进来；
 *  - 同一个文件导入多份（file_hash 相同）默认**只算一份**：在「当前状态与筛选条件下可见」的那几份里，
 *    **先选已确认（done）的，同一状态里再选最早导入的**作代表（所以打开「含待审核」时，已确认的副本不会被未确认的原件顶掉）。
 *    所以原件待审核、副本已确认时，副本顶上；原件被删了，副本也顶上——一份卷子不会因为「是副本」而整份消失。
 *    includeDuplicates=true 时才把每一份都算（会重复计数）。
 */
import { z } from 'zod'

export const StatsFilterSchema = z.object({
  grade: z.enum(['1', '2', '3', '4', '5', '6']).optional(),
  semester: z.enum(['上', '下']).optional(),
  school_year_start: z.number().int().min(2000).max(2100).optional(),
  exam_type: z.enum(['单元测试', '期中', '期末', '月考', '其他']).optional(),
  textbook: z.string().min(1).max(100).optional(),
  region: z.string().min(1).max(100).optional(),
  includeReviewing: z.boolean().optional(),
  includeDuplicates: z.boolean().optional(),
  /** true = 只看示例数据；不写 = 只看真实数据（示例数据永远不混进真实数据的统计） */
  sample: z.boolean().optional()
}).strict()
export type StatsFilter = z.infer<typeof StatsFilterSchema>

/** 同比的一侧：某一学年，或「早于某学年的全部学年」 */
const yearNum = z.number().int().min(2000).max(2100)
export const YearSpecSchema = z.union([
  z.object({ eq: yearNum }).strict(),
  z.object({ lt: yearNum }).strict(),
  z.object({ in: z.array(yearNum).min(1).max(40) }).strict()
])
export type YearSpec = z.infer<typeof YearSpecSchema>

export const LevelSchema = z.number().int().min(1).max(3)

export interface PaperScope {
  /** 以 papers p 为别名的 WHERE 条件（不含 WHERE 关键字） */
  where: string
  params: Array<string | number>
}

/** 学期为空的卷子在学期集合里记成这个名字 */
export const NO_SEMESTER = ''

/**
 * @param year 同比用：覆盖筛选条件里的学年（同比自己决定看哪几个学年）
 * @param statuses 覆盖「计入的状态」（比如只数待审核的）
 * @param semesters 只取这些学期的卷子（同比的「按学期对齐」）；NO_SEMESTER 表示学期为空的
 */
export function paperScope(f: StatsFilter, year?: YearSpec | 'ignore', statuses?: string[], semesters?: string[] | null): PaperScope {
  const build = (a: string): PaperScope => {
    const parts: string[] = []
    const params: Array<string | number> = []
    // 示例数据与真实数据分开统计：默认只看真实数据，f.sample 时只看示例（0/1 是固定常量，直接写进 SQL）
    parts.push(`${a}.is_sample = ${f.sample ? 1 : 0}`)
    if (statuses) {
      // 内部固定的状态名（不来自用户输入），直接拼进 SQL
      parts.push(`${a}.status IN (${statuses.map(s => `'${s.replace(/'/g, '')}'`).join(',')})`)
    } else {
      parts.push(f.includeReviewing ? `${a}.status IN ('done','reviewing')` : `${a}.status = 'done'`)
    }
    if (f.grade) { parts.push(`${a}.grade = ?`); params.push(f.grade) }
    if (f.semester) { parts.push(`${a}.semester = ?`); params.push(f.semester) }
    if (f.exam_type) { parts.push(`${a}.exam_type = ?`); params.push(f.exam_type) }
    if (f.textbook) { parts.push(`${a}.textbook = ?`); params.push(f.textbook) }
    if (f.region) { parts.push(`${a}.region = ?`); params.push(f.region) }
    if (year === undefined) {
      if (f.school_year_start !== undefined) { parts.push(`${a}.school_year_start = ?`); params.push(f.school_year_start) }
    } else if (year !== 'ignore') {
      if ('eq' in year) { parts.push(`${a}.school_year_start = ?`); params.push(year.eq) }
      else if ('lt' in year) { parts.push(`${a}.school_year_start IS NOT NULL AND ${a}.school_year_start < ?`); params.push(year.lt) }
      else { parts.push(`${a}.school_year_start IN (${year.in.map(() => '?').join(',')})`); params.push(...year.in) }
    }
    if (semesters) {
      const named = semesters.filter(x => x !== NO_SEMESTER)
      const conds: string[] = []
      if (named.length) { conds.push(`${a}.semester IN (${named.map(() => '?').join(',')})`); params.push(...named) }
      if (semesters.includes(NO_SEMESTER)) conds.push(`(${a}.semester IS NULL OR ${a}.semester = '')`)
      parts.push(conds.length ? `(${conds.join(' OR ')})` : '0')
    }
    return { where: parts.join(' AND '), params }
  }
  const main = build('p')
  if (f.includeDuplicates) return main
  // 同一个文件的多份：只留代表卷：同样条件下可见的几份里，已确认（done）的优先，同一状态里取最早导入的。
  // 用一个不相关的 IN 子查询（SQLite 只算一次、物化成临时索引）+ 窗口函数取每组第一份；
  // 不能写成「对每一行再 NOT EXISTS 一次」的相关子查询——它会按连接后的每一行（题 × 标注）各算一次，500 份卷子时慢 5–10 倍（实测）。
  const inner = build('o')
  return {
    where: `${main.where} AND p.id IN (SELECT rep.id FROM (SELECT o.id AS id, ROW_NUMBER() OVER (PARTITION BY o.file_hash ORDER BY CASE WHEN o.status = 'done' THEN 0 ELSE 1 END, o.created_at, o.rowid) AS rn
      FROM papers o WHERE ${inner.where}) rep WHERE rep.rn = 1)`,
    params: [...main.params, ...inner.params]
  }
}

/** 知识点向上汇总用的闭包：每个节点对应它自己和所有祖先（被合并的节点先落到 merged_into 的目标）。
 *  depth=0 是节点本身；lvl0 是节点本身的层级。UNION ALL + 深度上限，树里万一有环也能停。 */
export const CLOSURE_CTE = `closure(code, anc, depth, lvl0) AS (
  SELECT k.code, e.code, 0, e.level FROM kps k JOIN kps e ON e.code = COALESCE(NULLIF(k.merged_into, ''), k.code)
  UNION ALL
  SELECT c.code, pk.parent_code, c.depth + 1, c.lvl0 FROM closure c JOIN kps pk ON pk.code = c.anc
  WHERE pk.parent_code IS NOT NULL AND pk.parent_code <> '' AND c.depth < 8
)`

/** 把一个 YearSpec 或筛选里的学年写成人看的文字，如 2025-2026学年 */
export const yearLabel = (y: number) => `${y}-${y + 1}学年`
