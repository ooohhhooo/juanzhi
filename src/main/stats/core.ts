/**
 * 统计核心：全部在 SQL 里聚合，只把汇总结果交给调用方（不会把全量题目拉出来再算）。
 * 纯函数模块：数据库句柄由调用方传入，不依赖 electron，单测用 node:sqlite 的内存库直接跑。
 *
 * 口径（设计方案 §4，界面「口径说明」逐条对应）：
 *  - 出现率 = 含该知识点的试卷数 ÷ 筛选内试卷数；
 *  - 分值占比 = 该知识点题目分值 ÷ 总分；总分 = 筛选内所有「分值不为空」的题的分值之和；
 *  - 向上汇总：节点的统计包含整棵子树，一份卷子有任意一题落在子树内就算出现；
 *  - 主/次知识点：都计入出现率与题数；分值只按主知识点计（一道题只有一个主知识点，不会重复计分）；
 *  - 分值为空的题不进分值统计，同时给出「分值覆盖 x/y 题」；
 *  - 难度、易错是 AI/老师估计，界面一律标「估计」。
 */
import { CLOSURE_CTE, NO_SEMESTER, paperScope, yearLabel } from './filter.ts'
import type { PaperScope, StatsFilter, YearSpec } from './filter.ts'
import { classifyChange, deltaPoints, limitedSides } from './compare-math.ts'
import { emptyReason } from '../../shared/emptyReason.ts'
import type { ChangeKind } from './compare-math.ts'

type Db = any

/** 重难点综合排序的公式与权重（界面「口径说明」里原样展示） */
export const HOT_FORMULA = {
  /** 综合得分 = 出现率 × 分值占比 × (1 + ERROR_WEIGHT × 易错率) */
  errorWeight: 1,
  text: '综合得分 = 出现率 × 分值占比 × (1 + 1.0 × 易错率)'
}

/**
 * 性能注意：所有按「筛选范围」统计的查询都写成「papers → questions → question_kps → closure」的固定嵌套顺序
 * （SQLite 里 CROSS JOIN 就是按写出的顺序做嵌套循环），范围条件直接写在 papers 上。
 * 没有统计信息时 SQLite 自己选的顺序可能是「对每份卷子把标注表扫一遍」，500 份卷子时一个查询会慢到几十秒（实测）。
 */
const withCte = (extra = '') => `WITH RECURSIVE ${CLOSURE_CTE}${extra ? ', ' + extra : ''}`

// ───────────────────────── 基础：范围内的计数与知识点节点统计 ─────────────────────────

export interface ScopeCounts {
  papers: number
  questions: number
  /** 分值不为空的题数 */
  scored: number
  totalScore: number
  /** 有主知识点的题数 */
  tagged: number
}

export function scopeCounts(db: Db, scope: PaperScope): ScopeCounts {
  const papers = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${scope.where}`).get(...scope.params) as any).c as number
  const r = db.prepare(`SELECT COUNT(*) questions, COALESCE(SUM(q.score IS NOT NULL), 0) scored, COALESCE(SUM(q.score), 0) total_score,
           COALESCE(SUM(EXISTS (SELECT 1 FROM question_kps k WHERE k.question_id = q.id AND k.is_primary = 1)), 0) tagged
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${scope.where}`).get(...scope.params) as any
  return { papers, questions: r.questions, scored: r.scored, totalScore: r.total_score, tagged: r.tagged }
}

export interface KpRow {
  code: string
  parent_code: string | null
  name: string
  level: number
  intro_grade: number | null
  sort: number
}

export interface NodeStat extends KpRow {
  /** 含该知识点（子树内任一题）的试卷数 */
  papers: number
  /** 子树内的题数（主/次知识点都算，一道题只算一次） */
  questions: number
  /** 子树内以主知识点计的题数 */
  primQuestions: number
  /** 子树内主知识点题目的分值合计（分值为空的题不计） */
  score: number
  /** 其中分值不为空的主知识点题数 */
  scoredPrim: number
  /** 主知识点正好是本节点（不含子孙）的题数与分值 */
  ownPrim: number
  ownScore: number
  avgDifficulty: number | null
  errorCount: number
}

export function loadKps(db: Db): KpRow[] {
  return db.prepare('SELECT code, parent_code, name, level, intro_grade, sort FROM kps ORDER BY sort, code').all() as KpRow[]
}

/** 范围内每个知识点节点（向上汇总后）的统计；只返回有题的节点。
 *  @param level 只要某一层级的节点时传入：汇总时直接跳过别的层级，行数少一半以上（同比、重难点、Top 10 都只看一个层级） */
export function nodeStats(db: Db, scope: PaperScope, level?: number): NodeStat[] {
  const rows = db.prepare(`${withCte(`qk AS (
      SELECT q.id AS qid, q.paper_id AS pid, c.anc AS node, MAX(k.is_primary) AS prim,
             MIN(CASE WHEN k.is_primary = 1 THEN c.depth END) AS pd,
             q.score AS score, q.difficulty AS diff, q.error_prone AS err
      FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
      CROSS JOIN question_kps k ON k.question_id = q.id
      CROSS JOIN closure c ON c.code = k.kp_code${level === undefined ? '' : '\n      CROSS JOIN kps ak ON ak.code = c.anc'}
      WHERE ${scope.where}${level === undefined ? '' : ' AND ak.level = ?'}
      GROUP BY q.id, c.anc)`)}
    SELECT node, COUNT(DISTINCT pid) AS papers, COUNT(*) AS questions,
           SUM(prim) AS prim_q,
           SUM(CASE WHEN prim = 1 THEN score END) AS score,
           SUM(CASE WHEN prim = 1 AND score IS NOT NULL THEN 1 ELSE 0 END) AS scored_prim,
           SUM(CASE WHEN prim = 1 AND pd = 0 THEN 1 ELSE 0 END) AS own_prim,
           SUM(CASE WHEN prim = 1 AND pd = 0 THEN score END) AS own_score,
           SUM(diff) AS diff_sum, SUM(diff IS NOT NULL) AS diff_n,
           COALESCE(SUM(err), 0) AS err_n
    FROM qk GROUP BY node`).all(...scope.params, ...(level === undefined ? [] : [level])) as any[]
  const kps = new Map(loadKps(db).map(k => [k.code, k]))
  const out: NodeStat[] = []
  for (const r of rows) {
    const k = kps.get(r.node)
    if (!k) continue
    out.push({
      ...k,
      papers: r.papers, questions: r.questions, primQuestions: r.prim_q ?? 0, score: r.score ?? 0, scoredPrim: r.scored_prim ?? 0,
      ownPrim: r.own_prim ?? 0, ownScore: r.own_score ?? 0,
      avgDifficulty: r.diff_n > 0 ? Math.round((r.diff_sum / r.diff_n) * 100) / 100 : null,
      errorCount: r.err_n
    })
  }
  return out.sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1))
}

const pct = (n: number, d: number): number | null => (d > 0 ? n / d : null)

function pathOf(kps: Map<string, KpRow>, code: string): string {
  const names: string[] = []
  let cur = kps.get(code)
  let guard = 0
  while (cur && guard++ < 8) { names.unshift(cur.name); cur = cur.parent_code ? kps.get(cur.parent_code) : undefined }
  return names.join(' / ')
}

// ───────────────────────── 分布 ─────────────────────────

export interface Coverage {
  /** 分值覆盖：有分值的题 / 全部题 */
  scored: number
  questions: number
  tagged: number
}

export interface DistNode extends NodeStat {
  rate: number
  scoreShare: number | null
  /** 面积/占比的另一种口径：主知识点题数 ÷ 全部题数 */
  questionShare: number | null
}

export interface Distribution {
  papers: number
  questions: number
  totalScore: number
  coverage: Coverage
  nodes: DistNode[]
  qtypes: Array<{ code: string; name: string; group: string; questions: number; scored: number; score: number; scoreShare: number | null; questionShare: number | null; papers: number; avgDifficulty: number | null }>
  difficulty: Array<{ level: number; questions: number; share: number | null }>
  difficultyUnrated: number
  textbooks: Array<{ name: string; papers: number }>
  /** 筛选范围内（学年等条件都满足）但没计入的试卷、重复导入的处理、没填学年的份数 */
  pendingReviewing: number
  duplicates: number
  includeDuplicates: boolean
  noYear: number
}

export function distribution(db: Db, f: StatsFilter): Distribution {
  const scope = paperScope(f)
  const c = scopeCounts(db, scope)
  const nodes = nodeStats(db, scope).map<DistNode>(n => ({
    ...n, rate: c.papers > 0 ? n.papers / c.papers : 0,
    scoreShare: pct(n.score, c.totalScore), questionShare: pct(n.primQuestions, c.questions)
  }))
  const qrows = db.prepare(`SELECT COALESCE(NULLIF(q.qtype, ''), 'OTHER') qtype, COUNT(*) n, SUM(q.score IS NOT NULL) scored, SUM(q.score) score,
           COUNT(DISTINCT q.paper_id) papers, AVG(q.difficulty) diff
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${scope.where} GROUP BY 1`).all(...scope.params) as any[]
  const qinfo = new Map((db.prepare('SELECT code, name, "group" AS grp, sort FROM qtypes').all() as any[]).map(q => [q.code, q]))
  const qtypes = qrows.map(r => {
    const info = qinfo.get(r.qtype)
    return {
      code: r.qtype as string, name: (info?.name ?? r.qtype) as string, group: (info?.grp ?? 'written') as string,
      questions: r.n as number, scored: (r.scored ?? 0) as number, score: (r.score ?? 0) as number,
      scoreShare: pct(r.score ?? 0, c.totalScore), questionShare: pct(r.n, c.questions), papers: r.papers as number,
      avgDifficulty: r.diff == null ? null : Math.round(r.diff * 100) / 100
    }
  }).sort((a, b) => b.questions - a.questions || (a.code < b.code ? -1 : 1))
  const drows = db.prepare(`SELECT q.difficulty d, COUNT(*) n FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${scope.where} GROUP BY q.difficulty`).all(...scope.params) as any[]
  const rated = drows.filter(r => r.d >= 1 && r.d <= 5).reduce((s, r) => s + r.n, 0)
  const difficulty = [1, 2, 3, 4, 5].map(l => {
    const n = drows.find(r => r.d === l)?.n ?? 0
    return { level: l, questions: n as number, share: pct(n, rated) }
  })
  return {
    papers: c.papers, questions: c.questions, totalScore: c.totalScore,
    coverage: { scored: c.scored, questions: c.questions, tagged: c.tagged },
    nodes, qtypes, difficulty, difficultyUnrated: c.questions - rated,
    textbooks: textbookDist(db, scope),
    ...scopeNotes(db, f)
  }
}

export function textbookDist(db: Db, scope: PaperScope): Array<{ name: string; papers: number }> {
  return (db.prepare(`SELECT COALESCE(NULLIF(p.textbook, ''), '未填写') name, COUNT(*) papers FROM papers p WHERE ${scope.where}
    GROUP BY 1 ORDER BY 2 DESC, 1`).all(...scope.params) as any[]).map(r => ({ name: r.name, papers: r.papers }))
}

export interface ScopeNotes {
  /** 满足筛选条件、但还在待审核而没计入的份数（「含待审核」打开时为 0） */
  pendingReviewing: number
  /** 满足筛选条件的待审核试卷总数（不管开关；提示条和开关旁边的数字用它） */
  reviewing: number
  /** 「含待审核」打开时，实际计入统计的待审核卷子份数（去重之后：同一文件的副本已确认时，待审核的原件让位，不算在内）；开关关闭时为 0 */
  reviewingCounted: number
  /** 「含待审核」打开时，待审核但因同一文件已有别的代表卷而没有重复计入的份数 */
  reviewingSuperseded: number
  /** 内容重复（同一文件导入了多份）的试卷：默认被合并掉的份数；打开「包含重复导入」后是「被重复计数的份数」 */
  duplicates: number
  /** 当前是否把重复导入也算进来 */
  includeDuplicates: boolean
  /** 计入统计但没有填学年的份数（不参与同比） */
  noYear: number
}

/** 轻量的「范围说明」：每个页面都显示，只做几次计数，不做任何知识点聚合 */
export function scopeNotes(db: Db, f: StatsFilter): ScopeNotes {
  const cnt = (s: PaperScope) => (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${s.where}`).get(...s.params) as any).c as number
  const reviewing = cnt(paperScope({ ...f, includeDuplicates: true }, undefined, ['reviewing']))
  const pending = f.includeReviewing ? 0 : reviewing
  const counted = paperScope(f)
  const all = paperScope({ ...f, includeDuplicates: true })
  const dedup = paperScope({ ...f, includeDuplicates: false })
  const duplicates = cnt(all) - cnt(dedup)
  const noYear = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${counted.where} AND p.school_year_start IS NULL`).get(...counted.params) as any).c as number
  const reviewingCounted = f.includeReviewing
    ? (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${counted.where} AND p.status = 'reviewing'`).get(...counted.params) as any).c as number
    : 0
  const reviewingSuperseded = f.includeReviewing ? reviewing - reviewingCounted : 0
  return { pendingReviewing: pending, reviewing, reviewingCounted, reviewingSuperseded, duplicates, includeDuplicates: !!f.includeDuplicates, noYear }
}

// ───────────────────────── 双向细目表 ─────────────────────────

export interface MatrixResult {
  level: number
  papers: number
  rows: Array<{ code: string; name: string; level: number; parent_code: string | null; path: string; questions: number; score: number }>
  /** questions / score 是该题型在本表各行里的合计（一道题标了多个知识点会重复计）；allQuestions / allScore 是该题型在筛选范围内的全部题目与分值（含没标知识点的），用作表尾合计 */
  cols: Array<{ code: string; name: string; group: string; questions: number; score: number; allQuestions: number; allScore: number; allScored: number }>
  /** 稀疏：只含有题的单元格。questions = 该知识点行 × 该题型的题数（一道题标了多个知识点会在多行各计一次）；score = 其中主知识点的分值 */
  cells: Array<{ row: string; col: string; questions: number; score: number; scored: number; prim: number }>
  coverage: Coverage
  totalScore: number
}

/** @param level 行的层级：1 = 一级知识点，2 = 二级（标在一级上的题归到「一级本身」那一行），3 同理 */
export function matrix(db: Db, f: StatsFilter, level: number): MatrixResult {
  const scope = paperScope(f)
  const c = scopeCounts(db, scope)
  const rows = db.prepare(`${withCte(`mq AS (
      SELECT q.id AS qid, COALESCE(NULLIF(q.qtype, ''), 'OTHER') AS qtype, q.score AS score, c.anc AS node, MAX(k.is_primary) AS prim
      FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
      CROSS JOIN question_kps k ON k.question_id = q.id
      CROSS JOIN closure c ON c.code = k.kp_code
      CROSS JOIN kps ak ON ak.code = c.anc
      WHERE ${scope.where} AND ak.level = MIN(?, c.lvl0)
      GROUP BY q.id, c.anc)`)}
    SELECT node, qtype, COUNT(*) n, SUM(prim) prim_n, SUM(CASE WHEN prim = 1 THEN score END) score,
           SUM(CASE WHEN prim = 1 AND score IS NOT NULL THEN 1 ELSE 0 END) scored
    FROM mq GROUP BY node, qtype`).all(...scope.params, level) as any[]
  const kps = new Map(loadKps(db).map(k => [k.code, k]))
  const qinfo = new Map((db.prepare('SELECT code, name, "group" AS grp, sort FROM qtypes').all() as any[]).map(q => [q.code, q]))
  const rowAgg = new Map<string, { questions: number; score: number }>()
  const colAgg = new Map<string, { questions: number; score: number }>()
  const cells = rows.map(r => {
    const score = r.score ?? 0
    const ra = rowAgg.get(r.node) ?? { questions: 0, score: 0 }; ra.questions += r.n; ra.score += score; rowAgg.set(r.node, ra)
    const ca = colAgg.get(r.qtype) ?? { questions: 0, score: 0 }; ca.questions += r.n; ca.score += score; colAgg.set(r.qtype, ca)
    return { row: r.node as string, col: r.qtype as string, questions: r.n as number, score, scored: r.scored ?? 0, prim: r.prim_n ?? 0 }
  })
  const rowList = [...rowAgg.keys()].map(code => {
    const k = kps.get(code)!
    return { code, name: k.name, level: k.level, parent_code: k.parent_code, path: pathOf(kps, code), questions: rowAgg.get(code)!.questions, score: rowAgg.get(code)!.score, sort: k.sort }
  }).filter(r => kps.has(r.code)).sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1)).map(({ sort: _s, ...r }) => r)
  const allQ = new Map((db.prepare(`SELECT COALESCE(NULLIF(q.qtype, ''), 'OTHER') qtype, COUNT(*) n, COALESCE(SUM(q.score), 0) score, COALESCE(SUM(q.score IS NOT NULL), 0) scored
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${scope.where} GROUP BY 1`).all(...scope.params) as any[]).map(r => [r.qtype as string, r]))
  const colList = [...new Set([...colAgg.keys(), ...allQ.keys()])].map(code => {
    const q = qinfo.get(code)
    return { code, name: (q?.name ?? code) as string, group: (q?.grp ?? 'written') as string, questions: colAgg.get(code)?.questions ?? 0, score: colAgg.get(code)?.score ?? 0,
      allQuestions: allQ.get(code)?.n ?? 0, allScore: allQ.get(code)?.score ?? 0, allScored: allQ.get(code)?.scored ?? 0, sort: (q?.sort ?? 9999) as number }
  }).sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1)).map(({ sort: _s, ...r }) => r)
  return { level, papers: c.papers, rows: rowList, cols: colList, cells, coverage: { scored: c.scored, questions: c.questions, tagged: c.tagged }, totalScore: c.totalScore }
}

// ───────────────────────── 样本题与题目卡片 ─────────────────────────

export interface QuestionCard {
  id: string
  paper_id: string
  paperTitle: string
  school_year_start: number | null
  grade: string | null
  textbook: string | null
  no: string
  section: string
  ord: number
  qtype: string
  qtypeName: string
  stem: string
  options: string[]
  score: number | null
  difficulty: number | null
  error_prone: boolean
  error_reason: string
  page_idx: number | null
  /** 页面图文件名（ewb://page/<paperId>/<pageRel>），没有这一页的图时为 null */
  pageRel: string | null
  pageW: number
  pageH: number
  bbox: number[] | null
  isPrimary: boolean
}

const parseJson = <T,>(s: string | null, fb: T): T => { try { return s ? JSON.parse(s) : fb } catch { return fb } }

const CARD_COLS = `q.id, q.paper_id, p.title, p.school_year_start, p.grade, p.textbook, q.no_label, q.no, q.section, q.ord, q.qtype, q.stem, q.options,
           q.score, q.difficulty, q.error_prone, q.error_reason, q.page_idx, q.bbox_json`
/** 题目卡片的排序：易错优先 → 有题干 → 难度高 → 新学年优先 → 导入先后 → 题序 */
const CARD_ORDER = `q.error_prone DESC, (q.stem IS NOT NULL AND q.stem <> '') DESC, q.difficulty DESC, p.school_year_start DESC, p.created_at, p.rowid, q.ord`

function toCard(r: any, qinfo: Map<string, string>): QuestionCard {
  return {
    id: r.id, paper_id: r.paper_id, paperTitle: r.title, school_year_start: r.school_year_start, grade: r.grade, textbook: r.textbook,
    no: r.no_label ?? String(r.no ?? ''), section: r.section ?? '', ord: r.ord, qtype: r.qtype ?? 'OTHER', qtypeName: qinfo.get(r.qtype ?? 'OTHER') ?? (r.qtype ?? '其他'),
    stem: r.stem ?? '', options: parseJson<string[]>(r.options, []), score: r.score, difficulty: r.difficulty, error_prone: !!r.error_prone,
    error_reason: r.error_reason ?? '', page_idx: r.page_idx, pageRel: r.page_rel || null, pageW: r.page_w ?? 0, pageH: r.page_h ?? 0,
    bbox: parseJson<number[] | null>(r.bbox_json, null), isPrimary: r.prim === 1
  }
}
const qtypeNames = (db: Db) => new Map((db.prepare('SELECT code, name FROM qtypes').all() as any[]).map(q => [q.code, q.name]))

/**
 * 某个知识点（含子树）下的题目，按 CARD_ORDER 排序。
 * 连接顺序写死（CROSS JOIN 在 SQLite 里就是「按这个顺序嵌套循环」）：先从闭包里取出该节点子树的知识点，
 * 再按 kp_code 索引找标注、按主键找题、按主键找卷子，最后才用筛选条件过滤卷子。
 * 不写死的话，没有统计信息的 SQLite 会选「先扫所有卷子、再对每份卷子扫一遍标注」，500 份卷子时慢到数十秒（实测）。
 */
export function questionsOfKp(db: Db, scope: PaperScope, code: string, limit: number): QuestionCard[] {
  if (limit <= 0) return []
  const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT ${CARD_COLS}, MAX(k.is_primary) AS prim, pg.image_rel AS page_rel, pg.width AS page_w, pg.height AS page_h
    FROM closure c
    CROSS JOIN question_kps k ON k.kp_code = c.code
    CROSS JOIN questions q ON q.id = k.question_id
    CROSS JOIN papers p ON p.id = q.paper_id
    LEFT JOIN pages pg ON pg.paper_id = q.paper_id AND pg.idx = q.page_idx
    WHERE c.anc = ? AND ${scope.where}
    GROUP BY q.id
    ORDER BY ${CARD_ORDER}
    LIMIT ?`).all(code, ...scope.params, limit) as any[]
  const qinfo = qtypeNames(db)
  return rows.map(r => toCard(r, qinfo))
}

// ───────────────────────── 重难点 ─────────────────────────

export interface HotRow {
  rank: number
  code: string
  name: string
  path: string
  level: number
  papers: number
  rate: number
  questions: number
  score: number
  scoreShare: number | null
  /** 实际用于排序的占比：有分值数据时是分值占比，否则是主知识点题数占比 */
  share: number
  errorCount: number
  /** 易错率 = AI 估计易错题数 ÷ 题数（估计值） */
  errorRate: number
  avgDifficulty: number | null
  priority: number
  reasons: Array<{ reason: string; count: number }>
  typical: QuestionCard[]
}

export interface HotResult {
  level: number
  papers: number
  basis: 'score' | 'count'
  formula: typeof HOT_FORMULA
  coverage: Coverage
  /** 这个层级共有多少个知识点出现；rows 只列前 limit 个 */
  total: number
  /** 主知识点标在更高层级节点上、因而不在本视图任何一行里的题数与分值 */
  higher: { questions: number; score: number }
  rows: HotRow[]
}

export function hot(db: Db, f: StatsFilter, level: number, limit = 20, scopeOverride?: PaperScope, withHigher = true): HotResult {
  const scope = scopeOverride ?? paperScope(f)
  const c = scopeCounts(db, scope)
  const kps = new Map(loadKps(db).map(k => [k.code, k]))
  const basis: 'score' | 'count' = c.scored > 0 ? 'score' : 'count'
  const ranked = nodeStats(db, scope, level).filter(n => n.level === level && n.papers > 0).map(n => {
    const rate = c.papers > 0 ? n.papers / c.papers : 0
    const scoreShare = pct(n.score, c.totalScore)
    const share = basis === 'score' ? (scoreShare ?? 0) : (c.questions > 0 ? n.primQuestions / c.questions : 0)
    const errorRate = n.questions > 0 ? n.errorCount / n.questions : 0
    return { n, rate, scoreShare, share, errorRate, priority: rate * share * (1 + HOT_FORMULA.errorWeight * errorRate) }
  }).sort((a, b) => b.priority - a.priority || b.rate - a.rate || (a.n.code < b.n.code ? -1 : 1))
  const rows = ranked.slice(0, limit)
  const higherRow = !withHigher ? { n: 0, s: 0 } : db.prepare(`${withCte()}
    SELECT COUNT(*) n, COALESCE(SUM(q.score), 0) s FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
    CROSS JOIN question_kps k ON k.question_id = q.id AND k.is_primary = 1
    CROSS JOIN closure c ON c.code = k.kp_code AND c.depth = 0 AND c.lvl0 < ? WHERE ${scope.where}`).get(level, ...scope.params) as any
  // 易错原因：一次查询取出这个层级所有「易错题」的原因（只占题目的一小部分），再按节点挑前 3；比逐个节点各查一次快得多
  const reasonsBy = new Map<string, Map<string, number>>()
  if (rows.length) {
    const rr = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
      SELECT c.anc AS node, q.error_reason AS reason, COUNT(DISTINCT q.id) AS cnt
      FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
      CROSS JOIN question_kps k ON k.question_id = q.id
      CROSS JOIN closure c ON c.code = k.kp_code
      CROSS JOIN kps ak ON ak.code = c.anc
      WHERE ${scope.where} AND q.error_prone = 1 AND q.error_reason IS NOT NULL AND q.error_reason <> '' AND ak.level = ?
      GROUP BY c.anc, q.error_reason`).all(...scope.params, level) as any[]
    for (const x of rr) {
      if (!reasonsBy.has(x.node)) reasonsBy.set(x.node, new Map())
      reasonsBy.get(x.node)!.set(x.reason, x.cnt)
    }
  }
  const out: HotRow[] = rows.map((r, i) => {
    const reasons = [...(reasonsBy.get(r.n.code) ?? new Map<string, number>())].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)).slice(0, 3)
    return {
      rank: i + 1, code: r.n.code, name: r.n.name, path: pathOf(kps, r.n.code), level: r.n.level,
      papers: r.n.papers, rate: r.rate, questions: r.n.questions, score: r.n.score, scoreShare: r.scoreShare, share: r.share,
      errorCount: r.n.errorCount, errorRate: r.errorRate, avgDifficulty: r.n.avgDifficulty, priority: r.priority, reasons,
      typical: questionsOfKp(db, scope, r.n.code, 3)
    }
  })
  return { level, papers: c.papers, basis, formula: HOT_FORMULA, coverage: { scored: c.scored, questions: c.questions, tagged: c.tagged }, total: ranked.length, higher: { questions: higherRow.n, score: higherRow.s }, rows: out }
}

// ───────────────────────── 同比 ─────────────────────────

export interface CompareItem {
  code: string
  name: string
  path: string
  level: number
  intro_grade: number | null
  kind: ChangeKind
  /** 目标 / 基线：含该知识点的试卷数、试卷总数 */
  aT: number
  nT: number
  aB: number
  nB: number
  rateT: number
  rateB: number
  /** 出现率变化，单位百分点，1 位小数 */
  deltaPP: number
  /** 目标侧题数 / 基线侧题数（主次知识点都算） */
  questionsT: number
  questionsB: number
  /** 目标侧分值占比（主知识点） */
  scoreShareT: number | null
  samples: QuestionCard[]
}

export interface CompareSide {
  label: string
  years: number[]
  papers: number
  textbooks: Array<{ name: string; papers: number }>
}

export interface CompareResult {
  level: number
  target: CompareSide
  base: CompareSide
  /** 样本有限的一侧（试卷数 < 5） */
  limited: Array<'target' | 'base'>
  /** 两侧合起来混入了多个年级 / 考试类型，或学期构成不一致（每条接在「两侧」后面读） */
  mixed: string[]
  /** 学期对齐：on = 基线只取目标学年里出现过的学期；dropped = 因此没参与比较的基线卷子数；两侧各学期的份数 */
  align: { on: boolean; requested: boolean; targetSemesters: Array<{ name: string; key: string; papers: number }>; baseSemesters: Array<{ name: string; key: string; papers: number }>; dropped: number }
  added: CompareItem[]
  removed: CompareItem[]
  up: CompareItem[]
  down: CompareItem[]
  /** 数据库里（满足其它筛选条件时）有卷子的全部学年，供界面选择 */
  availableYears: number[]
  coverageT: Coverage
  /** 目标侧或基线侧没有试卷时为 true，此时四栏为空 */
  empty: boolean
  /** 本次同比用的两侧范围，P2 与题目抽屉复用 */
  targetSpec: YearSpec
  baseSpec: YearSpec
}

export function availableYears(db: Db, f: StatsFilter): number[] {
  const s = paperScope(f, 'ignore')
  return (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${s.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...s.params) as any[]).map(r => r.y as number)
}

export interface SemesterCount { name: string; key: string; papers: number }
export interface SideScopes {
  /** 目标侧 / 基线侧（已按学期对齐）的卷子范围；sBAll = 对齐前的基线范围 */
  sT: PaperScope
  sB: PaperScope
  sBAll: PaperScope
  semT: SemesterCount[]
  semB: SemesterCount[]
  semBAll: SemesterCount[]
  /** 目标学年出现过的学期（对齐用） */
  targetKeys: string[]
  /** 学期对齐是否真的生效（开关打开且目标侧有卷子） */
  aligning: boolean
  /** 因学期不一致没参与比较的基线卷子数 */
  dropped: number
  /** 对齐后基线里真正有卷子的学年 */
  baseYears: number[]
}

/**
 * 同比两侧的卷子范围——**唯一的来源**：同比四栏、P2、读缓存状态、知识点抽屉里的题目卡片都用它，
 * 所以表格上写的「基线 x/y 份」和抽屉里列出的基线卷子永远是同一批。
 *
 * 学期对齐：一个学年有上、下两学期，当前学年往往只过了一半。基线只取目标学年里出现过的学期，
 * 否则「下学期才教的知识点」会被报成「消失」。
 */
export function sideScopes(db: Db, f: StatsFilter, target: number, base: { eq: number } | { lt: number }, alignSemester = true): SideScopes {
  const sT = paperScope(f, { eq: target })
  const semOf = (s: PaperScope): SemesterCount[] => (db.prepare(`SELECT COALESCE(p.semester, '') sem, COUNT(*) c FROM papers p WHERE ${s.where} GROUP BY 1 ORDER BY 1`).all(...s.params) as any[]).map(r => ({ name: r.sem === NO_SEMESTER ? '未填' : (r.sem as string), key: r.sem as string, papers: r.c as number }))
  const semT = semOf(sT)
  const sBAll = paperScope(f, base)
  const semBAll = semOf(sBAll)
  const targetKeys = semT.map(x => x.key)
  const aligning = alignSemester && targetKeys.length > 0
  const sB = aligning ? paperScope(f, base, undefined, targetKeys) : sBAll
  const semB = aligning ? semOf(sB) : semBAll
  const dropped = aligning ? semBAll.reduce((n, x) => n + x.papers, 0) - semB.reduce((n, x) => n + x.papers, 0) : 0
  const baseYears = (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${sB.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...sB.params) as any[]).map(r => r.y as number)
  return { sT, sB, sBAll, semT, semB, semBAll, targetKeys, aligning, dropped, baseYears }
}

/** 抽屉里「基线」的两种写法：'before' = 目标之前的全部学年，数字 = 只看那一年 */
export type BaseArg = 'before' | number
export const baseSpecOf = (target: number, base: BaseArg): { eq: number } | { lt: number } => (base === 'before' ? { lt: target } : { eq: base })

/** 知识点抽屉的 side 参数 */
export type DrawerSide =
  | { kind: 'year'; year: number }
  | { kind: 'base'; target: number; base: BaseArg; align: boolean }
  | { kind: 'filter' }

/**
 * 抽屉里题目卡片取题的试卷范围。基线侧与同比表格用同一个 `sideScopes` 的对齐后范围，
 * 所以抽屉里的卡片数 = 表格上的「基线 x/y 份」（复审 P1-B）。抽成纯函数是为了单测能直接覆盖三种 side。
 */
export function drawerScope(db: Db, f: StatsFilter, side: DrawerSide): PaperScope {
  if (side.kind === 'year') return paperScope(f, { eq: side.year })
  if (side.kind === 'base') return sideScopes(db, f, side.target, baseSpecOf(side.target, side.base), side.align).sB
  return paperScope(f)
}

/** @param target 目标学年  @param base 基线：{lt: 目标} = 之前全部学年；{eq: Y} = 只看某一学年 */
export function compare(db: Db, f: StatsFilter, target: number, base: { eq: number } | { lt: number }, level: number, sampleLimit = 3, alignSemester = true): CompareResult {
  const targetSpec: YearSpec = { eq: target }
  const { sT, sB, semT, semB, targetKeys, aligning, dropped: droppedBase, baseYears } = sideScopes(db, f, target, base, alignSemester)
  const years = availableYears(db, f)
  const cT = scopeCounts(db, sT)
  const cB = scopeCounts(db, sB)
  const kps = new Map(loadKps(db).map(k => [k.code, k]))
  const nsT = new Map(nodeStats(db, sT, level).filter(n => n.level === level).map(n => [n.code, n]))
  const nsB = new Map(nodeStats(db, sB, level).filter(n => n.level === level).map(n => [n.code, n]))

  // 两侧合起来是否混入多个年级/考试类型；两侧的学期构成是否一致
  const both = paperScope(f, { in: [target, ...baseYears] }, undefined, aligning ? targetKeys : null)
  const mixed: string[] = []
  const distinct = (col: string) => (db.prepare(`SELECT COUNT(DISTINCT p.${col}) c FROM papers p WHERE ${both.where} AND p.${col} IS NOT NULL`).get(...both.params) as any).c as number
  if (distinct('grade') > 1) mixed.push('混入了不同年级的试卷')
  if (distinct('exam_type') > 1) mixed.push('混入了不同考试类型的试卷')
  const semText = (d: Array<{ name: string }>) => (d.length ? d.map(x => `${x.name}${x.name === '未填' ? '' : '学期'}`).join('、') : '无')
  const sameSem = JSON.stringify(semT.map(x => x.key)) === JSON.stringify(semB.map(x => x.key))
  if (cT.papers > 0 && cB.papers > 0 && !sameSem) {
    mixed.push(`学期构成不一致（目标学年有：${semText(semT)}；基线有：${semText(semB)}）——只在缺少的那个学期里才考的知识点会被显示成「新增」或「消失」`)
  }

  const items: CompareItem[] = []
  const empty = cT.papers === 0 || cB.papers === 0
  if (!empty) {
    for (const code of new Set([...nsT.keys(), ...nsB.keys()])) {
      const t = nsT.get(code), b = nsB.get(code)
      const aT = t?.papers ?? 0, aB = b?.papers ?? 0
      const kind = classifyChange(aT, cT.papers, aB, cB.papers)
      if (!kind) continue
      const k = kps.get(code)!
      items.push({
        code, name: k.name, path: pathOf(kps, code), level: k.level, intro_grade: k.intro_grade, kind,
        aT, nT: cT.papers, aB, nB: cB.papers, rateT: aT / cT.papers, rateB: aB / cB.papers, deltaPP: deltaPoints(aT, cT.papers, aB, cB.papers),
        questionsT: t?.questions ?? 0, questionsB: b?.questions ?? 0, scoreShareT: t ? pct(t.score, cT.totalScore) : null,
        samples: []
      })
    }
    // 样本题：新增/上升/下降取目标侧，消失取基线侧
    for (const it of items) it.samples = questionsOfKp(db, it.kind === 'removed' ? sB : sT, it.code, sampleLimit)
  }
  const order = (a: CompareItem, b: CompareItem, key: 'aT' | 'aB' | 'delta') => {
    const va = key === 'aT' ? a.aT : key === 'aB' ? a.aB : Math.abs(a.deltaPP)
    const vb = key === 'aT' ? b.aT : key === 'aB' ? b.aB : Math.abs(b.deltaPP)
    return vb - va || (a.code < b.code ? -1 : 1)
  }
  const pick = (k: ChangeKind, key: 'aT' | 'aB' | 'delta') => items.filter(i => i.kind === k).sort((a, b) => order(a, b, key))
  return {
    level,
    target: { label: yearLabel(target), years: [target], papers: cT.papers, textbooks: textbookDist(db, sT) },
    base: { label: 'eq' in base ? yearLabel(base.eq) : `${yearLabel(target)}之前的全部学年`, years: baseYears, papers: cB.papers, textbooks: textbookDist(db, sB) },
    align: { on: aligning, targetSemesters: semT, baseSemesters: semB, dropped: droppedBase, requested: alignSemester },
    limited: limitedSides(cT.papers, cB.papers),
    mixed,
    added: pick('added', 'aT'), removed: pick('removed', 'aB'), up: pick('up', 'delta'), down: pick('down', 'delta'),
    availableYears: years,
    coverageT: { scored: cT.scored, questions: cT.questions, tagged: cT.tagged },
    empty, targetSpec, baseSpec: base
  }
}

// ───────────────────────── 总览 ─────────────────────────

export interface OverviewResult {
  cards: { papers: number; questions: number; kps: number; pending: number }
  coverage: Coverage
  top: Array<{ code: string; name: string; path: string; papers: number; rate: number; questions: number }>
  newThisYear: { year: number | null; items: Array<{ code: string; name: string; aT: number; nT: number }>; basePapers: number; targetPapers: number; limited: Array<'target' | 'base'>; mixed: string[]; reason: string | null }
  recent: Array<{ id: string; title: string; status: string; grade: string | null; school_year_start: number | null; created_at: string; questions: number }>
  pendingReviewing: number
  duplicates: number
  includeDuplicates: boolean
  noYear: number
  includeReviewing: boolean
}

export function overview(db: Db, f: StatsFilter): OverviewResult {
  const scope = paperScope(f)
  const c = scopeCounts(db, scope)
  const kps = new Map(loadKps(db).map(k => [k.code, k]))
  const nodes = nodeStats(db, scope, 2)
  const top = nodes.filter(n => n.level === 2)
    .sort((a, b) => b.papers - a.papers || b.questions - a.questions || (a.code < b.code ? -1 : 1)).slice(0, 10)
    .map(n => ({ code: n.code, name: n.name, path: pathOf(kps, n.code), papers: n.papers, rate: c.papers > 0 ? n.papers / c.papers : 0, questions: n.questions }))
  // 具体被直接标注过的知识点数（按有效节点去重）
  const kpCount = (db.prepare(`${withCte()}
    SELECT COUNT(DISTINCT c.anc) n FROM papers p CROSS JOIN questions q ON q.paper_id = p.id CROSS JOIN question_kps k ON k.question_id = q.id
    CROSS JOIN closure c ON c.code = k.kp_code AND c.depth = 0 WHERE ${scope.where}`).get(...scope.params) as any).n as number
  const dims = paperScope({ ...f, includeDuplicates: true }, undefined, ['reviewing'])
  const pending = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${dims.where}`).get(...dims.params) as any).c as number

  // 本学年新增：筛选里选了学年就用它，否则用范围内最新的学年；基线 = 之前全部学年（同其它筛选条件）
  const years = availableYears(db, f)
  const yearsInScope = (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${scope.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...scope.params) as any[]).map(r => r.y as number)
  const targetYear = f.school_year_start ?? (yearsInScope.length ? yearsInScope[yearsInScope.length - 1] : null)
  let newThisYear: OverviewResult['newThisYear'] = { year: targetYear, items: [], basePapers: 0, targetPapers: 0, limited: [], mixed: [], reason: null }
  if (targetYear === null) newThisYear.reason = '范围内的试卷都没有填写学年'
  else {
    const cmp = compare(db, f, targetYear, { lt: targetYear }, 2, 0)
    newThisYear = {
      year: targetYear, basePapers: cmp.base.papers, targetPapers: cmp.target.papers, limited: cmp.limited, mixed: cmp.mixed,
      items: cmp.added.map(i => ({ code: i.code, name: i.name, aT: i.aT, nT: i.nT })),
      reason: emptyReason({ targetLabel: '该学年', baseLabel: '更早的学年', targetPapers: cmp.target.papers, basePapers: cmp.base.papers, alignOn: cmp.align.on, dropped: cmp.align.dropped, targetSemesters: cmp.align.targetSemesters.map(x => x.name + (x.name === '未填' ? '' : '学期')).join('、'), where: 'overview' })
    }
  }
  void years
  const dimsAll = paperScope({ ...f, includeDuplicates: true }, undefined, ['imported', 'extracting', 'extracted', 'parsing', 'reviewing', 'done', 'failed'])
  const recent = (db.prepare(`SELECT p.id, p.title, p.status, p.grade, p.school_year_start, p.created_at,
      (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS questions
    FROM papers p WHERE ${dimsAll.where} ORDER BY p.created_at DESC, p.rowid DESC LIMIT 8`).all(...dimsAll.params) as any[])
    .map(r => ({ id: r.id, title: r.title, status: r.status, grade: r.grade, school_year_start: r.school_year_start, created_at: r.created_at, questions: r.questions }))
  return {
    cards: { papers: c.papers, questions: c.questions, kps: kpCount, pending },
    coverage: { scored: c.scored, questions: c.questions, tagged: c.tagged },
    top, newThisYear, recent, includeReviewing: !!f.includeReviewing, ...scopeNotes(db, f)
  }
}

// ───────────────────────── 筛选栏的候选值 ─────────────────────────

/** @param f 给了筛选条件时，学年只列满足其它条件、且会被计入统计的试卷所在的学年（同比选学年用）；不给就列库里所有 */
export function filterOptions(db: Db, f?: StatsFilter): { years: number[]; textbooks: string[]; regions: string[] } {
  // 候选值只来自「会被计入统计」的状态：没打开「含待审核」时，只在待审核卷子里才有的教材/地区/学年不出现，免得选了就是空结果
  const st = f?.includeReviewing ? "('done','reviewing')" : "('done')"
  const col = (c: string) => (db.prepare(`SELECT DISTINCT ${c} v FROM papers WHERE status IN ${st} AND ${c} IS NOT NULL AND ${c} <> '' ORDER BY ${c}`).all() as any[]).map(r => r.v)
  return { years: f ? availableYears(db, f) : col('school_year_start') as number[], textbooks: col('textbook') as string[], regions: col('region') as string[] }
}
