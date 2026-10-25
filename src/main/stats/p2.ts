/**
 * P2（年度变化分析）的输入：把本地统计结果填成提示词里的占位符。模型不负责计数——所有数字都在这里算好。
 * 纯函数模块（不依赖 electron / 数据库），单测直接跑。格式严格按 docs/prompts/v1-sonnet改写.md §二 的列约定。
 */
import crypto from 'node:crypto'
import { makeToken } from '../../shared/citation.ts'
import type { CitationRef } from '../../shared/citation.ts'
import type { CompareItem, CompareResult, HotResult, QuestionCard } from './core.ts'
import type { StatsFilter } from './filter.ts'
import { yearLabel } from './filter.ts'

export const P2_PLACEHOLDERS = ['FILTER_DESC', 'TARGET_YEAR', 'TARGET_PAPERS', 'BASE_YEARS', 'BASE_PAPERS', 'TARGET_TEXTBOOKS', 'BASE_TEXTBOOKS', 'SAMPLE_WARNING', 'ADDED', 'REMOVED', 'CHANGED', 'HOT'] as const

const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '／').trim()
const pctText = (v: number | null) => (v === null ? '—' : `${(Math.round(v * 1000) / 10).toString()}%`)
const GRADE = ['', '一', '二', '三', '四', '五', '六']

/** 筛选条件的白话描述（{{FILTER_DESC}}） */
export function describeFilter(f: StatsFilter, level: number, cmp?: CompareResult): string {
  const parts: string[] = []
  parts.push(f.grade ? `${GRADE[Number(f.grade)]}年级` : '全部年级')
  if (f.semester) parts.push(`${f.semester}学期`)
  if (f.exam_type) parts.push(f.exam_type)
  if (f.textbook) parts.push(f.textbook)
  if (f.region) parts.push(f.region)
  parts.push(`按${['', '一', '二', '三'][level]}级知识点统计`)
  if (f.includeReviewing) parts.push('含未确认的 AI 结果')
  if (f.includeDuplicates) parts.push('重复导入的试卷重复计数')
  if (cmp) {
    const sem = (d: Array<{ name: string }>) => (d.length ? d.map(x => `${x.name}${x.name === '未填' ? '' : '学期'}`).join('、') : '无')
    parts.push(`学期范围：目标学年 ${sem(cmp.align.targetSemesters)}；基线${cmp.align.on ? '已按学期对齐，只取' : '未按学期对齐，含'} ${sem(cmp.align.baseSemesters)}${cmp.align.on && cmp.align.dropped > 0 ? `（另有 ${cmp.align.dropped} 份其他学期的基线卷子未参与比较）` : ''}`)
  }
  return parts.join(' · ')
}

function stemSummary(q: QuestionCard): string {
  let s = oneLine(q.stem)
  if (!s) s = oneLine(q.options.join(' '))
  if (!s) s = '题干为空'
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/** token 注册表：同名试卷、同号题自动加后缀，保证每个 token 对应唯一的一道题 */
export class TokenRegistry {
  refs = new Map<string, CitationRef>()
  private byQuestion = new Map<string, string>()
  private titles = new Map<string, string>()   // paperId → 去重后的标题

  tokenFor(q: QuestionCard): string {
    const had = this.byQuestion.get(q.id)
    if (had) return had
    let title = this.titles.get(q.paper_id)
    if (!title) {
      const base = makeToken(q.paperTitle, '#').slice(1).split(' · ')[0]
      title = base
      let n = 2
      const taken = new Set([...this.titles.values()])
      while (taken.has(title)) title = `${base}（${n++}）`
      this.titles.set(q.paper_id, title)
    }
    let no = makeToken('x', q.no).slice(1, -1).split(' · ')[1]
    let token = `[${title} · ${no}]`
    if (this.refs.has(token)) {
      // 同一份卷子里题号重复（听力一/笔试一各有第 1 题）：加大题序号，仍重复再加序
      no = `${q.section || '?'}${q.no}`
      token = `[${title} · ${no}]`
      if (this.refs.has(token)) token = `[${title} · ${no}#${q.ord}]`
    }
    this.refs.set(token, { token, questionId: q.id, paperId: q.paper_id, paperTitle: q.paperTitle, no: q.no, qtypeName: q.qtypeName, page_idx: q.page_idx, pageRel: q.pageRel, pageW: q.pageW, pageH: q.pageH, bbox: q.bbox })
    this.byQuestion.set(q.id, token)
    return token
  }

  sampleCell(qs: QuestionCard[], max = 3): string {
    if (qs.length === 0) return '无'
    return qs.slice(0, max).map(q => `${this.tokenFor(q)}（${q.qtypeName}：${stemSummary(q)}）`).join('；')
  }
}

const dist = (d: Array<{ name: string; papers: number }>) => (d.length ? d.map(x => `${x.name} ${x.papers} 份`).join('、') : '（无）')

export function sampleWarning(cmp: CompareResult): string {
  const bits: string[] = []
  if (cmp.limited.includes('target')) bits.push(`目标学年只有 ${cmp.target.papers} 份卷子`)
  if (cmp.limited.includes('base')) bits.push(`基线学年只有 ${cmp.base.papers} 份卷子`)
  const out: string[] = []
  if (bits.length) out.push(`样本偏小：${bits.join('，')}（不足 5 份），出现率的变化可能只是一两份卷子的差别`)
  if (cmp.mixed.length) out.push(`两侧${cmp.mixed.join('，')}，对比时请注意口径不一致`)
  if (!out.length) return '无'
  // 样本说明里也写清学期范围（协调方要求）：模型据此判断「消失」「新增」是不是只是学期没覆盖到
  const sem = (d: Array<{ name: string }>) => d.map(x => `${x.name}${x.name === '未填' ? '' : '学期'}`).join('、') || '无'
  out.push(`学期范围：目标学年 ${sem(cmp.align.targetSemesters)}；基线${cmp.align.on ? '已按学期对齐，只取' : '未按学期对齐，含'} ${sem(cmp.align.baseSemesters)}`)
  return out.join('；') + '。'
}

export interface P2Input {
  placeholders: Record<(typeof P2_PLACEHOLDERS)[number], string>
  refs: CitationRef[]
  /** 输入里出现的知识点代码，输出的 `### 代码｜名称` 应都在其中 */
  codes: string[]
  /** 数据指纹：所有占位符内容的哈希。数据变了（含样本题、题干被改）指纹就变，缓存据此判断过期 */
  fingerprint: string
}

export function buildP2Input(cmp: CompareResult, hotRes: HotResult, filter: StatsFilter): P2Input {
  const hot = hotRes.rows
  const reg = new TokenRegistry()
  const grade = (i: CompareItem) => (i.intro_grade ?? '-')
  const added = cmp.added.map(i => [i.code, i.name, grade(i), `${i.aT}/${i.nT}`, i.questionsT, pctText(i.scoreShareT), reg.sampleCell(i.samples)].join(' | '))
  const removed = cmp.removed.map(i => [i.code, i.name, grade(i), `${i.aB}/${i.nB}`, i.questionsB, reg.sampleCell(i.samples)].join(' | '))
  const changed = [...cmp.up, ...cmp.down].map(i =>
    [i.code, i.name, `${i.aB}/${i.nB}`, `${i.aT}/${i.nT}`, `${i.deltaPP > 0 ? '+' : ''}${i.deltaPP.toFixed(1)}`, i.kind === 'up' ? '上升' : '下降', reg.sampleCell(i.samples)].join(' | '))
  const hotRows = hot.slice(0, 15).map(h =>
    [h.code, h.name, `${h.papers}/${hotRes.papers}`, h.questions, h.errorCount, h.reasons.length ? h.reasons.slice(0, 2).map(r => oneLine(r.reason)).join('；') : '无', reg.sampleCell(h.typical)].join(' | '))
  const block = (rows: string[]) => (rows.length ? rows.join('\n') : '（无）')
  const placeholders = {
    FILTER_DESC: describeFilter(filter, cmp.level, cmp),
    TARGET_YEAR: yearLabel(cmp.target.years[0]),
    TARGET_PAPERS: String(cmp.target.papers),
    BASE_YEARS: cmp.base.years.length ? cmp.base.years.map(yearLabel).join('、') : '（无）',
    BASE_PAPERS: String(cmp.base.papers),
    TARGET_TEXTBOOKS: dist(cmp.target.textbooks),
    BASE_TEXTBOOKS: dist(cmp.base.textbooks),
    SAMPLE_WARNING: sampleWarning(cmp),
    ADDED: block(added), REMOVED: block(removed), CHANGED: block(changed), HOT: block(hotRows)
  }
  const codes = [...new Set([...cmp.added, ...cmp.removed, ...cmp.up, ...cmp.down].map(i => i.code).concat(hot.map(h => h.code)))]
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(P2_PLACEHOLDERS.map(k => [k, placeholders[k]]))).digest('hex')
  return { placeholders, refs: [...reg.refs.values()], codes, fingerprint }
}

/** 把占位符填进提示词；填完不得残留 {{ }}，也不得有没填的占位符（改坏了提示词要报错，而不是把 {{X}} 原样发给模型） */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const missing: string[] = []
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => {
    if (Object.prototype.hasOwnProperty.call(values, k)) return values[k]
    missing.push(k)
    return m
  })
  if (missing.length) throw new Error(`提示词里有无法填充的占位符：${[...new Set(missing)].map(m => `{{${m}}}`).join('、')}`)
  return out
}

/**
 * 缓存键：范围（筛选 + 目标 + 基线 + 层级 + 是否按学期对齐）和**实际发给模型的提示词文本**（system + 填好数据的 user）。
 * 不再依赖人工维护的提示词版本号：提示词模板改了、数据变了、样本题的题干变了，实际发出去的文本就变了，键自然不同。
 * scopeKey 只由范围决定（用来找到「这个范围上次生成的那份」）。
 */
export function cacheKeys(scope: unknown, system: string, user: string): { scopeKey: string; cacheKey: string } {
  const h = (x: unknown) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex')
  const scopeKey = h(scope)
  return { scopeKey, cacheKey: h([scopeKey, h(system), h(user)]) }
}

export interface CheckRecord { fresh: boolean; reasons: Array<'data' | 'prompt'>; promptError: string | null; empty: boolean }

/**
 * 缓存行里记着的「上次核对结论」能不能直接用：数据修订号和提示词模板签名都没变才能（纯函数，单测直接跑）。
 * 能用就不必重新构造整套 P2 输入（那要 300 ms 量级）。
 */
export function reusableCheck(row: { checked_rev?: number | null; checked_sig?: string | null; checked_json?: string | null }, rev: number, sig: string): CheckRecord | null {
  if (row.checked_rev !== rev || row.checked_sig !== sig || !row.checked_json) return null
  try { return JSON.parse(row.checked_json) as CheckRecord } catch { return null }
}

/** 提示词模板（未填数据）的签名：用来区分「是提示词变了」还是「数据变了」 */
export const templateSig = (system: string, userTemplate: string): string =>
  crypto.createHash('sha256').update(JSON.stringify([system, userTemplate])).digest('hex')

/** 规范化筛选条件做缓存键：去掉值为 false/undefined 的开关，键排序，避免同一筛选因写法不同命中不了缓存 */
export function normalizeFilter(f: StatsFilter): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, unknown>)[k]
    if (v === undefined || v === false) continue
    o[k] = v
  }
  return o
}
