/**
 * P3（考情分析报告）的输入：把本地统计结果填成提示词里的占位符。模型不负责算数——所有数字都在这里算好。
 * 复用 M3 的统计（分布 / 重难点 / 同比，去重与学期口径都在那里），这里只把结果排成提示词约定的表格。
 * 纯函数模块（不依赖 electron / 数据库），单测直接跑。格式严格按 docs/prompts/v1-sonnet改写.md §二 P3 的列约定。
 *
 * SAMPLE_WARNING 由程序判定（提示词文档 §七.5）：卷子 < 5 份、混入不同年级 / 考试类型、分值缺失较多、年度变化的某一侧不足 5 份。
 */
import crypto from 'node:crypto'
import { TokenRegistry, describeFilter } from './p2.ts'
import type { CompareResult, Distribution, HotResult } from './core.ts'
import type { StatsFilter } from './filter.ts'
import { yearLabel } from './filter.ts'
import type { CitationRef } from '../../shared/citation.ts'

export const P3_PLACEHOLDERS = ['FILTER_DESC', 'PAPER_COUNT', 'QUESTION_COUNT', 'YEARS', 'SAMPLE_WARNING', 'KP_DIST', 'QTYPE_DIST', 'DIFF_DIST', 'ERROR_PRONE', 'YEAR_DIFF'] as const

const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '／').trim()   // 表格按 | 分列：文字里的 | 和换行必须先去掉
const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${(Math.round(v * 1000) / 10).toString()}%`)
const num = (v: number | null) => (v === null || v === undefined ? '—' : String(v))
const LEVEL = ['', '一级', '二级', '三级']

/** 知识点分布表里最多列出的二级知识点个数（一级全列）；多出来的在表尾说明 */
export const KP_DIST_MAX_L2 = 30
/**
 * 给 hot() 的行数上限：必须大于任何一棵树里的二级知识点个数（内置 67 个 + 自建）。
 * hot() 先按「综合得分」排序再截断，如果在这里截到 30，出现得少但易错题多的知识点就会整个掉出易错点表（M4 审核 P1-4）。
 */
export const P3_HOT_LIMIT = 1000
export const ERROR_PRONE_MAX = 10
const DIFF_MAX = 8

export interface P3Source {
  filter: StatsFilter
  dist: Distribution
  /** 二级知识点的重难点结果（取易错原因与样本题） */
  hot: HotResult
  /** 年度变化：范围里有 ≥ 2 个学年时的同比结果（最新学年 vs 之前），否则 null */
  cmp: CompareResult | null
  /** 计入统计的试卷覆盖的学年 */
  years: number[]
  /** 计入统计的试卷里不同年级 / 考试类型的个数 */
  distinctGrades: number
  distinctExamTypes: number
}

export interface P3Input {
  placeholders: Record<(typeof P3_PLACEHOLDERS)[number], string>
  refs: CitationRef[]
  /** 数据指纹：所有占位符内容的哈希 */
  fingerprint: string
  empty: boolean
}

/** 样本提示（程序判定，不交给模型）。没有警示返回「无」 */
export function p3SampleWarning(src: Pick<P3Source, 'dist' | 'cmp' | 'distinctGrades' | 'distinctExamTypes'>): string {
  const out: string[] = []
  const n = src.dist.papers
  if (n < 5) out.push(`样本偏小：当前范围内只有 ${n} 份卷子（不足 5 份），出现率等比例可能只是一两份卷子的差别`)
  const mixed: string[] = []
  if (src.distinctGrades > 1) mixed.push('不同年级')
  if (src.distinctExamTypes > 1) mixed.push('不同考试类型')
  if (mixed.length) out.push(`范围内混入了${mixed.join('、')}的试卷，结论只能作粗略参考`)
  const cov = src.dist.coverage
  if (cov.questions > 0 && cov.scored / cov.questions < 0.9) out.push(`有 ${cov.questions - cov.scored} 道题没有填写分值（分值覆盖 ${cov.scored}/${cov.questions} 题），分值占比偏低、仅供参考`)
  if (src.cmp && !src.cmp.empty && src.cmp.limited.length) {
    const bits = src.cmp.limited.map(s => (s === 'target' ? `目标学年只有 ${src.cmp!.target.papers} 份` : `基线学年只有 ${src.cmp!.base.papers} 份`))
    out.push(`年度变化的样本偏小：${bits.join('，')}（不足 5 份）`)
  }
  return out.length ? out.join('；') + '。' : '无'
}

/** 年度变化摘要（程序写好的白话 + 数字；模型只转述）。只有一个学年、或某一侧没有卷子时返回「（无）」 */
export function yearDiffText(cmp: CompareResult | null): string {
  if (!cmp || cmp.empty) return '（无）'
  const sem = (d: Array<{ name: string }>) => (d.length ? d.map(x => `${x.name}${x.name === '未填' ? '' : '学期'}`).join('、') : '无')
  const lines: string[] = []
  lines.push(`对比口径：目标 ${cmp.target.label} ${cmp.target.papers} 份，基线 ${cmp.base.years.map(yearLabel).join('、') || cmp.base.label} ${cmp.base.papers} 份；学期范围：目标 ${sem(cmp.align.targetSemesters)}，基线${cmp.align.on ? '已按学期对齐，只取 ' : '未按学期对齐，含 '}${sem(cmp.align.baseSemesters)}`)
  const list = (title: string, items: string[], more: number) => {
    lines.push(items.length ? `${title}：${items.join('；')}${more > 0 ? `；另有 ${more} 项未列出` : ''}` : `${title}：无`)
  }
  const cut = <T,>(a: T[]) => ({ head: a.slice(0, DIFF_MAX), more: Math.max(0, a.length - DIFF_MAX) })
  const a = cut(cmp.added), r = cut(cmp.removed), u = cut(cmp.up), d = cut(cmp.down)
  list('新增（基线学年从未出现）', a.head.map(i => `${oneLine(i.name)}（目标 ${i.aT}/${i.nT} 份）`), a.more)
  list('消失（目标学年未出现）', r.head.map(i => `${oneLine(i.name)}（基线 ${i.aB}/${i.nB} 份）`), r.more)
  list('明显上升', u.head.map(i => `${oneLine(i.name)}（${i.aB}/${i.nB} → ${i.aT}/${i.nT} 份，+${i.deltaPP.toFixed(1)} 个百分点）`), u.more)
  list('明显下降', d.head.map(i => `${oneLine(i.name)}（${i.aB}/${i.nB} → ${i.aT}/${i.nT} 份，${i.deltaPP.toFixed(1)} 个百分点）`), d.more)
  return lines.join('\n')
}

export function buildP3Input(src: P3Source): P3Input {
  const { dist, hot } = src
  const reg = new TokenRegistry()
  const total = dist.papers

  // 知识点分布：一级全列；二级按出现份数从多到少，最多 KP_DIST_MAX_L2 个
  const l1 = dist.nodes.filter(n => n.level === 1 && n.papers > 0)
  const l2all = dist.nodes.filter(n => n.level === 2 && n.papers > 0)
    .sort((a, b) => b.papers - a.papers || b.questions - a.questions || (a.code < b.code ? -1 : 1))
  const l2 = l2all.slice(0, KP_DIST_MAX_L2)
  const row = (n: (typeof l1)[number]) => [LEVEL[n.level], n.code, oneLine(n.name), `${n.papers}/${total}`, n.questions, pct(n.scoreShare), num(n.avgDifficulty), n.errorCount].join(' | ')
  const kpRows = [...l1.map(row), ...l2.map(row)]
  if (l2all.length > l2.length) kpRows.push(`（二级知识点另有 ${l2all.length - l2.length} 个出现份数更少，已略）`)

  const qtRows = dist.qtypes.map(t => [oneLine(t.name), t.questions, t.score, pct(t.scoreShare), num(t.avgDifficulty)].join(' | '))
  const diffRows = dist.difficulty.map(d => [d.level, d.questions, pct(d.share)].join(' | '))
  if (dist.difficultyUnrated > 0) diffRows.push(`未评难度 | ${dist.difficultyUnrated} | —`)

  const errRows = hot.rows.filter(h => h.errorCount > 0)
    .sort((a, b) => b.errorCount - a.errorCount || b.priority - a.priority || (a.code < b.code ? -1 : 1)).slice(0, ERROR_PRONE_MAX)
    .map(h => {
      const err = h.typical.filter(q => q.error_prone)
      return [h.code, oneLine(h.name), h.reasons.length ? h.reasons.slice(0, 2).map(r => oneLine(r.reason)).join('；') : '无', reg.sampleCell(err.length ? err : h.typical, 2)].join(' | ')
    })

  const block = (rows: string[]) => (rows.length ? rows.join('\n') : '（无）')
  const yearsText = src.years.length ? src.years.map(yearLabel).join('、') : '（未填写学年）'
  const noYearNote = dist.noYear > 0 ? `（另有 ${dist.noYear} 份没有填写学年）` : ''
  const placeholders = {
    FILTER_DESC: describeFilter(src.filter, 0),
    PAPER_COUNT: String(total),
    QUESTION_COUNT: String(dist.questions),
    YEARS: yearsText + noYearNote,
    SAMPLE_WARNING: p3SampleWarning(src),
    KP_DIST: block(kpRows),
    QTYPE_DIST: block(qtRows),
    DIFF_DIST: block(diffRows),
    ERROR_PRONE: block(errRows),
    YEAR_DIFF: yearDiffText(src.cmp)
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(P3_PLACEHOLDERS.map(k => [k, placeholders[k]]))).digest('hex')
  return { placeholders, refs: [...reg.refs.values()], fingerprint, empty: total === 0 }
}

/**
 * 保证程序判定的样本提示一定出现在报告开头的说明里：模型没转述（头部说明里没有「样本」「混入」「仅供参考」之一）就由程序补一句。
 * 「样本提示」为「无」时不补，也不删模型自己写的（提示词要求模型此时不写）。
 */
export function ensureSampleWarning(markdown: string, warning: string): { text: string; inserted: boolean } {
  if (!warning || warning === '无') return { text: markdown, inserted: false }
  const firstSection = markdown.search(/^##\s/m)
  const head = firstSection >= 0 ? markdown.slice(0, firstSection) : markdown
  if (/样本|混入|仅供参考/.test(head)) return { text: markdown, inserted: false }
  const line = `> 样本提示（程序判定）：${warning}结论仅供参考。`
  const lines = markdown.split('\n')
  const h1 = lines.findIndex(l => /^#\s/.test(l))
  if (h1 < 0) return { text: `${line}\n\n${markdown}`, inserted: true }
  // 插在标题之后；如果标题后面紧跟着引用块（模型写的说明），接在它的后面
  let at = h1 + 1
  while (at < lines.length && lines[at].trim() === '') at++
  while (at < lines.length && /^>/.test(lines[at].trim())) at++
  lines.splice(at, 0, line)
  return { text: lines.join('\n'), inserted: true }
}

/** 默认提示词规定的最后一节「教学建议」缺了，很可能被截断 */
export const hasFinalSection = (md: string): boolean => /^#{1,3}\s*教学建议/m.test(md)
