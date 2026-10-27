/**
 * 证据包（A3）：报告 / 同比解读里讲的英语规则、易错原因，只允许取自「老师审核过的题目的解释」。
 * 这里把范围内每个知识点的证据整理出来，两个用途：
 *  - 填进提示词的 {{EVIDENCE}}（每行：知识点 | 白话 | 例句 | 易错说明），要求 AI 只能引用它；
 *  - 输出后程序侧核对用的证据句子（shared/factcheck.ts）：易错说明 + 知识点的白话释义 / 例句 / 说明。
 * 纯函数模块（数据库由调用方传入），单测直接加载。
 */
import { CLOSURE_CTE } from './filter.ts'
import { dedupeClauses } from '../../shared/report-post.ts'
import type { PaperScope } from './filter.ts'
import { safeKpName } from '../../shared/code-guard.ts'

type Db = any

export interface EvidenceKp {
  code: string
  name: string
  plain: string
  example_en: string
  example_zh: string
  note: string
  /** 例词（用 / 分隔），校对例句时用 */
  hint_words: string
  /** 范围内、老师审核过的题目里的易错说明（去重，按出现次数从多到少） */
  reasons: string[]
}

export interface Evidence {
  kps: EvidenceKp[]
  /** {{EVIDENCE}} 的内容；没有任何证据时是「（无）」 */
  text: string
  /** 核对用的证据句子 */
  statements: string[]
}

/** 几条易错说明里，被别的说明包含的整条去掉（「time to + 动词」被「time to + 动词原形」包含） */
function dedupeList(list: string[]): string[] {
  const joined = dedupeClauses(list)
  return joined ? joined.split('；') : []
}

const oneLine = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').replace(/\|/g, '／').trim()
export const MAX_EVIDENCE_KPS = 30
/** 证据里一定要有的「分值最高的知识点」个数 */
export const TOP_SCORE_KPS = 6
const MAX_REASONS = 3
const REASON_MAX_CHARS = 80

/**
 * @param codes 只要这些知识点（P2：输入里出现的那些）；不传 = 范围内二级知识点里出现份数最多的前 MAX_EVIDENCE_KPS 个
 * @param level 取哪一层的节点（默认 2；codes 里的节点不受层级限制）
 */
export function collectEvidence(db: Db, scope: PaperScope, opts: { codes?: string[]; level?: number } = {}): Evidence {
  const level = opts.level ?? 2
  // 每个节点（向上汇总）的易错说明与出现份数：一次查询
  const rows = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT c.anc AS node, q.error_reason AS reason, COUNT(DISTINCT q.id) AS cnt, COUNT(DISTINCT q.paper_id) AS papers
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
    CROSS JOIN question_kps k ON k.question_id = q.id
    CROSS JOIN closure c ON c.code = k.kp_code
    -- 只取老师确认过的卷子（status = 'done'）里的易错说明：就算统计范围打开了「含待审核」，AI 自己写的未审核说明也不能当证据（那就成了自己核对自己）
    WHERE ${scope.where} AND p.status = 'done' AND q.error_prone = 1 AND q.error_reason IS NOT NULL AND q.error_reason <> ''
    GROUP BY c.anc, q.error_reason`).all(...scope.params) as Array<{ node: string; reason: string; cnt: number; papers: number }>
  const reasonsBy = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!reasonsBy.has(r.node)) reasonsBy.set(r.node, new Map())
    reasonsBy.get(r.node)!.set(oneLine(r.reason).slice(0, REASON_MAX_CHARS), r.cnt)
  }
  // 范围内每个节点出现的份数（排序用）
  const present = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT c.anc AS node, COUNT(DISTINCT q.paper_id) AS papers
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
    CROSS JOIN question_kps k ON k.question_id = q.id
    CROSS JOIN closure c ON c.code = k.kp_code
    WHERE ${scope.where} GROUP BY c.anc`).all(...scope.params) as Array<{ node: string; papers: number }>
  const papersOf = new Map(present.map(r => [r.node, r.papers]))
  // 分值占比最高的知识点（连词成句、书面表达这类题型对应的）要有证据：老师版 / 老板版据此才写得出「这块分最多，怎么练」。
  // 不看有没有易错说明——分值高、没有易错题的知识点正是以前被漏掉的
  const byScore = db.prepare(`WITH RECURSIVE ${CLOSURE_CTE}
    SELECT c.anc AS node, SUM(COALESCE(q.score, 0)) AS score
    FROM papers p CROSS JOIN questions q ON q.paper_id = p.id
    CROSS JOIN question_kps k ON k.question_id = q.id AND k.is_primary = 1
    CROSS JOIN closure c ON c.code = k.kp_code
    WHERE ${scope.where} GROUP BY c.anc`).all(...scope.params) as Array<{ node: string; score: number }>
  const topScore = byScore.filter(r => r.score > 0).sort((a, b) => b.score - a.score || (a.node < b.node ? -1 : 1)).map(r => r.node)
  const info = new Map((db.prepare('SELECT code, name, level, plain, example_en, example_zh, note, hint_words FROM kps').all() as any[]).map(k => [k.code, k]))

  let codes: string[]
  if (opts.codes) codes = [...new Set(opts.codes)].filter(c => info.has(c))
  else {
    codes = present.map(r => r.node).filter(c => info.get(c)?.level === level)
      .sort((a, b) => (papersOf.get(b)! - papersOf.get(a)!) || ((reasonsBy.get(b)?.size ?? 0) - (reasonsBy.get(a)?.size ?? 0)) || (a < b ? -1 : 1))
    // 有易错说明的优先留下（它们是最需要证据的）
    codes = [...codes.filter(c => reasonsBy.has(c)), ...codes.filter(c => !reasonsBy.has(c))]
    // 同层级、分值最高的前 TOP_SCORE_KPS 个排到最前面（它们的证据一定放得进去）
    const topCodes = topScore.filter(c => info.get(c)?.level === level).slice(0, TOP_SCORE_KPS)
    codes = [...new Set([...topCodes, ...codes])].slice(0, MAX_EVIDENCE_KPS)
  }

  const kps: EvidenceKp[] = []
  for (const code of codes) {
    const k = info.get(code)
    if (!k) continue
    const reasons = dedupeList([...(reasonsBy.get(code) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_REASONS).map(x => x[0]))
    kps.push({
      code, name: oneLine(safeKpName(k.name)), plain: oneLine(k.plain ?? ''), example_en: oneLine(k.example_en ?? ''), example_zh: oneLine(k.example_zh ?? ''),
      note: oneLine(k.note ?? ''), hint_words: oneLine(k.hint_words ?? ''), reasons
    })
  }
  const useful = kps.filter(k => k.plain || k.example_en || k.reasons.length)
  const text = useful.length
    ? useful.slice(0, opts.codes ? 80 : MAX_EVIDENCE_KPS).map(k => [k.name, k.plain || '—', k.example_en ? `${k.example_en} ${k.example_zh}`.trim() : '—', k.reasons.length ? k.reasons.join('；') : '—'].join(' | ')).join('\n')
    : '（无）'
  const statements: string[] = []
  for (const k of kps) {
    if (k.plain) statements.push(`${k.name}：${k.plain}`)
    if (k.example_en) statements.push(`${k.example_en} ${k.example_zh}`.trim())
    if (k.note) statements.push(k.note)
    for (const r of k.reasons) statements.push(r)
  }
  // 核对用的证据还要带上范围内**全部**易错说明（提示词里每个知识点只放前 3 条，AI 引用别的审核过的说明也是允许的）
  for (const m of reasonsBy.values()) for (const r of m.keys()) statements.push(r)
  return { kps, text, statements: [...new Set(statements)] }
}
