/**
 * 知识点 ↔ 试卷 的双向筛选与对比。纯函数模块（不依赖 electron），单测用内存库直接跑。
 * 口径与 filter.ts 的 paperScope 完全一致（学科 / 示例 / 已审核 / 去重 / 疑似重复都按它），
 * 向上汇总用 CLOSURE_CTE：选父节点 = 包含全部子孙知识点；题数 = 命中该节点的题（主、次知识点都算，一道题只算一次）；
 * 分值只按主知识点计（和分布、细目表一致）；易错是 AI 估计、老师审核过的。
 */
import { CLOSURE_CTE, paperScope } from './filter.ts'
import type { StatsFilter } from './filter.ts'
import { loadKps } from './core.ts'
import type { KpRow } from './core.ts'
import { MAX_KP_CODES, MAX_COMPARE_PAPERS } from '../../shared/kp-filter.ts'

type Db = any

export type HitMode = 'all' | 'any'
export { MAX_KP_CODES, MAX_COMPARE_PAPERS }

export interface PaperKpHit { code: string; name: string; questions: number }
export interface PaperHits { paperId: string; hits: PaperKpHit[] }

export interface CompareCell { paper: string; kp: string; questions: number; score: number; scored: number; errors: number }
export interface ComparePaper { id: string; title: string; grade: string | null; semester: string | null; school_year_start: number | null; exam_type: string | null; textbook: string | null; questions: number }
export interface CompareKp { code: string; name: string; level: number; group: string; groupCode: string; papers: number; questions: number }
export interface KpCompareResult {
  papers: ComparePaper[]
  kps: CompareKp[]
  cells: CompareCell[]
  /** 满足条件的卷子超过上限时，被略去的份数（只取前 MAX_COMPARE_PAPERS 份） */
  truncated: number
  mode: 'selected' | 'by-kps' | 'all-kps'
}

const cleanCodes = (codes: string[]): string[] => [...new Set(codes.map(c => c.trim()).filter(Boolean))].slice(0, MAX_KP_CODES)

interface RawCell { pid: string; node: string; n: number; score: number | null; scored: number; err: number }

/** 范围内每份卷子 × 每个目标节点的题数（稀疏）。codes 给定 = 只看这些节点（含子树）；level 给定 = 看这个层级的全部节点 */
function rawCells(db: Db, f: StatsFilter, target: { codes: string[] } | { level: number }): RawCell[] {
  const scope = paperScope(f)
  const byCodes = 'codes' in target
  const filterSql = byCodes ? 'AND c.anc IN (SELECT value FROM json_each(?))' : 'AND ak.level = MIN(?, c.lvl0)'
  const param = byCodes ? JSON.stringify(target.codes) : target.level
  return db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}, qk AS (
      SELECT p.id AS pid, q.id AS qid, c.anc AS node, MAX(k.is_primary) AS prim, q.score AS score, q.error_prone AS err
      FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
      CROSS JOIN question_kps k ON k.question_id = q.id
      CROSS JOIN closure c ON c.code = k.kp_code
      CROSS JOIN kps ak ON ak.code = c.anc
      WHERE ${scope.where} ${filterSql}
      GROUP BY q.id, c.anc)
    SELECT pid, node, COUNT(*) AS n, SUM(CASE WHEN prim = 1 THEN score END) AS score,
           SUM(CASE WHEN prim = 1 AND score IS NOT NULL THEN 1 ELSE 0 END) AS scored, COALESCE(SUM(err), 0) AS err
    FROM qk GROUP BY pid, node`).all(...scope.params, param) as RawCell[]
}

/** 试卷库「按知识点筛选」：哪些卷子考了这些知识点（all = 每个都考了；any = 至少考了其中一个），以及每份卷子命中的知识点和题数 */
export function papersByKps(db: Db, f: StatsFilter, rawCodes: string[], mode: HitMode): PaperHits[] {
  const codes = cleanCodes(rawCodes)
  if (codes.length === 0) return []
  const names = new Map(loadKps(db).map(k => [k.code, k.name]))
  const by = new Map<string, PaperKpHit[]>()
  for (const r of rawCells(db, f, { codes })) {
    const l = by.get(r.pid) ?? []
    l.push({ code: r.node, name: names.get(r.node) ?? r.node, questions: r.n })
    by.set(r.pid, l)
  }
  const out: PaperHits[] = []
  for (const [paperId, hits] of by) {
    const have = new Set(hits.map(h => h.code))
    if (mode === 'all' && !codes.every(c => have.has(c))) continue
    hits.sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code))
    out.push({ paperId, hits })
  }
  return out
}

const PAPER_COLS = 'p.id, p.title, p.grade, p.semester, p.school_year_start, p.exam_type, p.textbook, p.created_at'

/**
 * 并排对比：卷子 × 知识点。
 *  - f.paperIds 给了：卷子 = 选中的（按选的顺序），知识点 = 选定的 codes；没选 codes 就取这些卷子考过的全部二级知识点（按一级大类分组）；
 *  - 没给 paperIds 但给了 codes：卷子 = 范围里考了这些知识点的（mode 决定都考了 / 任一个）；
 *  - 两样都没给：空结果。
 */
export function compareKps(db: Db, f: StatsFilter, rawCodes: string[], mode: HitMode, level = 2): KpCompareResult {
  const codes = cleanCodes(rawCodes)
  let paperIds: string[]
  let kind: KpCompareResult['mode']
  if (f.paperIds) {
    kind = codes.length ? 'selected' : 'all-kps'
    paperIds = f.paperIds
  } else if (codes.length) {
    kind = 'by-kps'
    paperIds = papersByKps(db, f, codes, mode).map(h => h.paperId)
  } else return { papers: [], kps: [], cells: [], truncated: 0, mode: 'by-kps' }
  const scope = paperScope({ ...f, paperIds: paperIds.length ? paperIds : undefined })
  let rows = paperIds.length === 0 ? [] : db.prepare(`SELECT ${PAPER_COLS} FROM papers p WHERE ${scope.where}`).all(...scope.params) as any[]
  // 选了卷子就按选的顺序；否则新学年优先、再按导入先后
  const order = f.paperIds ? new Map(f.paperIds.map((id, i) => [id, i])) : null
  rows = rows.sort((a, b) => order ? (order.get(a.id)! - order.get(b.id)!) : ((b.school_year_start ?? 0) - (a.school_year_start ?? 0) || (a.created_at < b.created_at ? -1 : 1)))
  const truncated = Math.max(0, rows.length - MAX_COMPARE_PAPERS)
  rows = rows.slice(0, MAX_COMPARE_PAPERS)
  if (rows.length === 0) return { papers: [], kps: [], cells: [], truncated: 0, mode: kind }
  const shown = { ...f, paperIds: rows.map(r => r.id) }
  const raw = rawCells(db, shown, codes.length ? { codes } : { level })
  const kpMap = new Map<string, KpRow>(loadKps(db).map(k => [k.code, k]))
  const qn = new Map<string, number>((db.prepare('SELECT q.paper_id AS pid, COUNT(*) AS n FROM questions q WHERE q.paper_id IN (SELECT value FROM json_each(?)) GROUP BY q.paper_id').all(JSON.stringify(rows.map(r => r.id))) as any[]).map(r => [r.pid, r.n]))
  const cells: CompareCell[] = raw.map(r => ({ paper: r.pid, kp: r.node, questions: r.n, score: r.score ?? 0, scored: r.scored, errors: r.err }))
  const nodeCodes = codes.length ? codes.filter(c => kpMap.has(c)) : [...new Set(raw.map(r => r.node))].filter(c => kpMap.has(c))
  const top = (code: string): KpRow => { let cur = kpMap.get(code)!; let g = 0; while (cur.parent_code && kpMap.has(cur.parent_code) && g++ < 8) cur = kpMap.get(cur.parent_code)!; return cur }
  const kps: CompareKp[] = nodeCodes.map(code => {
    const k = kpMap.get(code)!
    const mine = cells.filter(c => c.kp === code)
    const g = top(code)
    return { code, name: k.name, level: k.level, group: g.name, groupCode: g.code, papers: new Set(mine.map(c => c.paper)).size, questions: mine.reduce((s, c) => s + c.questions, 0) }
  })
  if (codes.length) kps.sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code))
  else kps.sort((a, b) => (kpMap.get(a.code)!.sort - kpMap.get(b.code)!.sort) || (a.code < b.code ? -1 : 1))
  const papers: ComparePaper[] = rows.map(r => ({ id: r.id, title: r.title, grade: r.grade, semester: r.semester, school_year_start: r.school_year_start, exam_type: r.exam_type, textbook: r.textbook, questions: qn.get(r.id) ?? 0 }))
  return { papers, kps, cells, truncated, mode: kind }
}

export { overlapKind, OVERLAP_LABEL, compareToTable } from '../../shared/kp-compare-table.ts'
