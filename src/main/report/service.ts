/**
 * P3 考情分析报告：按当前全局筛选取本地统计 → 填占位符 → 流式调用模型 → 校验引用 → 存库（reports 表，每次生成一条，保留历史）。
 * 模型不算数：所有数字、样本题、引用 token 都是程序先算好填进提示词的。
 *
 * M6：四个读者版本（老板版 / 家长版 / 老师版 / 完整数据版）共用同一份证据包，各有各的提示词（p3_boss / p3_parent / p3_teacher / p3_report）；
 * 输出后程序收尾：去内部代码、去引用外多余的反引号、写标题（年级 / 学期 / 学年 / 日期）、补样本提示、事实核对（规则句对证据，对不上标「未核实」）；
 * 家长版再删掉含统计词的句子，且必须由使用者点「我已核对」后才能导出 / 复制。
 *
 * 过期：每条报告记着生成时「实际发给模型的提示词文本」的缓存键、数据指纹、提示词模板签名，以及上次核对时的数据修订号。
 * 数据（试卷 / 题目 / 知识点树）或提示词变了 → 状态变成 stale，界面写「已过期」，**绝不自动重新生成**（要花钱）。
 * 失败、取消、空内容、断流的处理与 P2 一致（同一个 chat()：重试、超时、干净 EOF 判定都在那里）；失败时已写出的部分存成「未完成草稿」。
 */
import crypto from 'node:crypto'
import { getDb } from '../db'
import { AiError } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { createStream } from '../ai/stream'
import { friendlyAiError, limitFallbackNotice } from '../ai/friendly'
import { clearDraft, getDraft, saveDraft } from '../ai/drafts'
import type { Draft } from '../ai/drafts'
import { promptText, promptVersionFor, defaultVersionOf, PLACEHOLDERS } from '../ai/prompts'
import type { PromptId } from '../ai/types'
import { notifyDataChanged } from '../events'
import { asSubject } from '../../shared/subject.ts'
import { pruneReportHistory } from './history-prune'
import { stripUnknownCitations } from '../../shared/citation'
import type { CitationRef } from '../../shared/citation'
import { stripMarks } from '../../shared/factcheck'
import { confirmBlockReason, fixBackticks, markdownToWechat, setBossReviewLine, hasBossReviewLine, reportTitle, stripInternalCodes, unacknowledgedSentences, READER_LABEL } from '../../shared/report-post'
import { dropReportSentence, finishReport, refreshVerifyWarnings } from './finish'
import { ensureSampleWarning } from '../stats/p3'
import type { ReportReader } from '../../shared/report-post'
import { paperScope } from '../stats/filter'
import { selectedCount } from '../stats/core'
import type { StatsFilter } from '../stats/filter'
import { cacheKeys, fillTemplate, normalizeFilter, reusableCheck, templateSig, describeFilter } from '../stats/p2'
import type { CheckRecord } from '../stats/p2'
import { bossSampleLine, buildP3Input } from '../stats/p3'
import { collectP3Source } from '../stats/p3-collect'
import type { P3Input, P3Source } from '../stats/p3'
import type { ChunkEvent, GenerateResult } from '../stats/analysis'
import type { UnverifiedItem } from '../ai/chunk'
import { effectiveStatus, getPartDef, isGenerating, loadParts, metaOf, partsFor, reassemble, runParts, saveMainPart } from './parts-run'
import type { PartRowDb } from './parts-run'
import './course-parts'   // 登记课程对照三段（老师版 / 完整版 / 家长版一句话）
import { cacheOptionsOf, courseOutlineIds, extractCourseAdvice } from './course-part-logic'
import { courseSig } from '../course/report-sig'
import { removeSentence } from '../../shared/factcheck'
import type { ReportOptions } from '../../shared/report-options'
import { ruleTalk } from '../../shared/factcheck'
import type { SubjectId } from '../../shared/subject'

const KIND = 'report'
const MAX_HISTORY = 100

/** 读者 → 提示词 id（完整数据版沿用 p3_report） */
export const PROMPT_OF: Record<ReportReader, PromptId> = { boss: 'p3_boss', parent: 'p3_parent', teacher: 'p3_teacher', full: 'p3_report' }
export interface PreparedReport {
  /** 学科（取自筛选条件，缺省英语）：选提示词、核对办法、家长版问候都按它 */
  subject: SubjectId
  reader: ReportReader
  input: P3Input
  src: P3Source
  system: string
  user: string
  promptError: string | null
  promptVersion: string
  templateSig: string
  cacheKey: string
  rev: number
  desc: string
  title: string
}

/** 筛选的白话描述；选中了具体几份卷子时带上「选中几份、其中几份计入」（counted 不给就现查） */
function describeFilterDb(filter: StatsFilter, grades?: string[], counted?: number): string {
  if (!filter.paperIds) return describeFilter(filter, 0, undefined, grades)
  const db = getDb()
  const sc = paperScope(filter)
  const n = counted ?? (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params) as any).c as number
  return describeFilter(filter, 0, undefined, grades, { selected: selectedCount(db, filter) ?? filter.paperIds.length, counted: n })
}

const currentRev = (): number => (getDb().prepare('SELECT rev FROM data_rev WHERE id = 1').get() as any)?.rev ?? 0
const currentTemplateSig = (reader: ReportReader, subject?: unknown) => templateSig(promptText(PROMPT_OF[reader], 'system', subject), promptText(PROMPT_OF[reader], 'user', subject))
const today = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

const allCodes = (): string[] => {
  const db = getDb()
  return [...(db.prepare('SELECT code FROM kps').all() as any[]), ...(db.prepare('SELECT code FROM qtypes').all() as any[])].map(r => String(r.code))
}

const hasOptions = (o: ReportOptions | undefined): boolean => !!o && Object.values(o).some(v => v !== undefined && v !== false && !(Array.isArray((v as any)?.outlineIds) && (v as any).outlineIds.length === 0))

/** 取统计、填占位符。复用 M3 的统计函数（去重、学期对齐、主次知识点的口径都在那里），这里不重新算任何东西 */
export function prepareReport(filter: StatsFilter, reader: ReportReader = 'full', options: ReportOptions = {}): PreparedReport {
  const db = getDb()
  const rev = currentRev()
  const src = collectP3Source(db, filter)
  const input = buildP3Input(src)
  const subject = asSubject(filter.subject)
  const id = PROMPT_OF[reader]
  const system = promptText(id, 'system', subject)
  const userTpl = promptText(id, 'user', subject)
  let user = ''
  let promptError: string | null = null
  try { user = fillTemplate(userTpl, input.placeholders) } catch (e) { promptError = (e as Error).message }
  // 生成选项（课程对照等）参与缓存键；没有选项时和 beta.3 之前的键完全一致，旧报告不会因此变成「已过期」
  // 勾了课程对照时，体系 rev 和知识点对应的指纹也进缓存键：课程变了报告就「已过期」
  const cacheOpts = hasOptions(options) ? cacheOptionsOf(options, courseSig(db, courseOutlineIds(options))) : null
  const keys = cacheKeys(cacheOpts ? { kind: KIND, reader, filter: normalizeFilter(filter), options: cacheOpts } : { kind: KIND, reader, filter: normalizeFilter(filter) }, system, user)
  const title = reportTitle({ filter: { ...filter, subject }, grades: src.grades ?? [], semesters: src.semesters ?? [], examTypes: src.examTypes ?? [], years: src.years, reader, date: today(), paperCount: Number(input.placeholders.PAPER_COUNT) })
  return { subject, reader, input, src, system, user, promptError, promptVersion: promptVersionFor(id, subject), templateSig: templateSig(system, userTpl), cacheKey: keys.cacheKey, rev, desc: describeFilterDb(filter, src.grades ?? [], Number(input.placeholders.PAPER_COUNT)), title }
}

// ───────────────────────── 读：列表 / 单条 ─────────────────────────

export interface ReportItem {
  id: string
  title: string
  createdAt: string
  model: string | null
  filter: StatsFilter
  filterDesc: string
  /** 读者版本：boss 老板版 / parent 家长版 / teacher 老师版 / full 完整数据版（M6 之前的报告都是 full） */
  reader: ReportReader
  readerLabel: string
  status: 'fresh' | 'stale'
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  sampleWarning: string | null
  promptVersion: string | null
  chars: number
  /** AI 生成的内容统一带「AI 草稿 · 请老师核对」：这里恒为 true；老师点「我已核对」后 confirmedAt 有值，标识换成「已由老师核对」 */
  aiDraft: true
  confirmedAt: string | null
  /** 家长版必须先核对才能导出 / 复制 */
  needsConfirm: boolean
  /** 生成时勾了「加入课程对照」 */
  hasCourse: boolean
  /** 事实核对里没对上证据的句子数（已在正文里标了「未核实」） */
  unverifiedCount: number
  /** 现在不能「我已核对」、复制、导出的原因（白话，如「这份家长版内容太少，建议重新生成」）；可以用时为 null。界面据此把按钮置灰并显示这句话 */
  blockReason: string | null
}

export interface ReportPartView {
  part: string
  label: string
  status: 'ok' | 'failed' | 'skipped' | 'running'
  message: string | null
  detail: string | null
  model: string | null
  canRetry: boolean
  retryBlock: string | null
}

export interface ReportVariantView {
  id: string
  seq: number
  qtype: 'choice' | 'blank'
  stem: string
  options: string[]
  answer: string
  explanation: string
  changed: string
  status: 'checked' | 'flagged' | 'dropped'
  teacherOk: boolean
  kpName: string
  notes: string[]
  secondAnswer: string | null
}

export interface ReportDetail extends ReportItem {
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
  unverified: UnverifiedItem[]
  /** 报告的分段（老师版等）；没有分段的旧报告 / 其他版本为空数组 */
  parts: ReportPartView[]
  /** 老师版的 AI 变形题（逐题勾「我核对过」后才进答题卡） */
  variants: ReportVariantView[]
  /** 老师版「可发给家长的话」（去掉未核实标记）；没有课程对照时为 null。「复制给家长」只在老师点了「我已核对」后可用 */
  courseAdvice: string | null
}

/**
 * 样本提示只在一个地方出现：正文开头的说明（它会跟着导出走）。正文里已经有了，界面上方就不再单独放一条黄条；
 * 正文里没有（家长版不带说明、旧数据）才把它交给界面单独显示。
 */
function visibleSampleWarning(markdown: string, warning: string | null): string | null {
  if (!warning || warning === '无') return null
  return ensureSampleWarning(markdown, warning).inserted ? warning : null
}

/** 分值最高的大类（一级知识点里占总分比例最高的那个）：老板版检查它有没有交代 */
function topScoreOf(src: { dist: { nodes: Array<{ level: number; name: string; scoreShare: number | null; papers: number }> } }): { name: string; share: number } | null {
  const l1 = src.dist.nodes.filter(n => n.level === 1 && n.papers > 0 && (n.scoreShare ?? 0) > 0)
  if (!l1.length) return null
  const t = l1.reduce((a, b) => ((b.scoreShare ?? 0) > (a.scoreShare ?? 0) ? b : a))
  return { name: t.name, share: t.scoreShare ?? 0 }
}

/** 家长版问候里的考试类型：筛选里指定了就用它，否则范围里只有一种考试类型就用它，混了几种就不写 */
function examLabelOf(p: { src: { filter: { exam_type?: string }; examTypes?: string[] } }): string | null {
  if (p.src.filter.exam_type) return p.src.filter.exam_type
  const set = [...new Set(p.src.examTypes ?? [])]
  return set.length === 1 ? set[0] : null
}

const parseJson = <T,>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb } catch { return fb } }
const parseFilter = (s: string | null): StatsFilter => parseJson<StatsFilter>(s, {})
const readerOf = (row: any): ReportReader => (['boss', 'parent', 'teacher', 'full'].includes(row.reader) ? row.reader : 'full')

function refreshRefs(refs: CitationRef[]): ReportDetail['refs'] {
  const db = getDb()
  const q = db.prepare(`SELECT q.page_idx, q.bbox_json, pg.image_rel, pg.width, pg.height FROM questions q
    LEFT JOIN pages pg ON pg.paper_id = q.paper_id AND pg.idx = q.page_idx WHERE q.id = ?`)
  return refs.map(r => {
    const row = q.get(r.questionId) as any
    if (!row) return { ...r, missing: true }
    return { ...r, page_idx: row.page_idx, pageRel: row.image_rel || null, pageW: row.width ?? 0, pageH: row.height ?? 0, bbox: parseJson<number[] | null>(row.bbox_json, null) }
  })
}

/** 核对一条报告是否过期：修订号和模板签名都没变就直接用上次的结论，否则重新构造 P3 输入对一次 */
function checkRow(row: any, memo: Map<string, PreparedReport>): CheckRecord {
  const rev = currentRev()
  const reader = readerOf(row)
  const sig = currentTemplateSig(reader, parseFilter(row.filter_json).subject)
  // 带课程对照的报告：课程体系 / 对应的改动不会让数据修订号变化，所以不走“修订号没变就沿用”的捷径，每次都现算
  // 先算便宜的课程指纹：修订号、模板签名、课程指纹都没变就沿用上次的结论，不用每次列表都跑完整的 prepareReport
  const courseIds = courseOutlineIds(parseJson<ReportOptions>(row.options_json, {}))
  const withCourse = courseIds.length > 0
  const cSig = withCourse ? courseSig(getDb(), courseIds) : ''
  const hit = reusableCheck(row, rev, sig)
  if (hit && (!withCourse || (hit as CheckRecord & { courseSig?: string }).courseSig === cSig)) return hit
  const key = `${reader}|${row.filter_json ?? '{}'}|${row.options_json ?? ''}`
  let p = memo.get(key)
  if (!p) { p = prepareReport(parseFilter(row.filter_json), reader, parseJson<ReportOptions>(row.options_json, {})); memo.set(key, p) }
  const reasons: Array<'data' | 'prompt'> = []
  if (row.template_sig !== p.templateSig) reasons.push('prompt')
  if (row.fingerprint !== p.input.fingerprint) reasons.push('data')
  const fresh = row.cache_key === p.cacheKey
  if (!fresh && reasons.length === 0) reasons.push('data')   // 只有课程体系 / 对应变了：也算“数据有变化”
  const chk: CheckRecord = { fresh, reasons, promptError: p.promptError, empty: p.input.empty }
  getDb().prepare('UPDATE reports SET checked_rev = ?, checked_sig = ?, checked_json = ? WHERE id = ?').run(p.rev, p.templateSig, JSON.stringify(withCourse ? { ...chk, courseSig: cSig } : chk), row.id)
  return chk
}

function itemOf(row: any, memo: Map<string, PreparedReport>): ReportItem {
  const chk = checkRow(row, memo)
  const modelChanged = !!row.model && row.model !== loadConfig().model
  const filter = parseFilter(row.filter_json)
  const reader = readerOf(row)
  const reasons: Array<'data' | 'prompt' | 'model'> = chk.fresh ? [] : [...chk.reasons]
  if (modelChanged) reasons.push('model')
  const verify = parseJson<UnverifiedItem[]>(row.verify_json, [])
  return {
    id: row.id, title: row.title || `${describeFilterDb(filter)} · 考情分析报告`, createdAt: row.created_at, model: row.model, filter, filterDesc: describeFilterDb(filter),
    reader, readerLabel: READER_LABEL[reader],
    status: chk.fresh ? 'fresh' : 'stale', staleReasons: reasons, warnings: parseJson<string[]>(row.warnings_json, []), sampleWarning: visibleSampleWarning(row.markdown ?? '', row.sample_warning),
    promptVersion: row.prompt_version,
    // 家长版的字数 = 复制到微信的字数（界面显示的、说明里写的 ≤ 300 都是这个口径）；其他版本是正文字数
    chars: reader === 'parent' ? markdownToWechat(row.markdown ?? '', { spaced: true }).length : (row.markdown ?? '').length,
    hasCourse: courseOutlineIds(parseJson<ReportOptions>(row.options_json, {})).length > 0,
    aiDraft: true, confirmedAt: row.confirmed_at ?? null, needsConfirm: reader === 'parent' && !row.confirmed_at, unverifiedCount: verify.length,
    blockReason: confirmBlockReason({ reader, markdown: row.markdown ?? '', unverified: verify })
  }
}

export function listReports(subject?: unknown): ReportItem[] {
  const memo = new Map<string, PreparedReport>()
  const rows = getDb().prepare(`SELECT * FROM reports WHERE kind = ? AND subject = ? ORDER BY created_at DESC, rowid DESC`).all(KIND, asSubject(subject)) as any[]
  return rows.map(r => itemOf(r, memo))
}

/** 分段的界面视图：状态、白话原因，以及这一段现在能不能单独重试（程序拼的和 AI 写的都可以，已核对 / 数据变了 / 正在生成时不行） */
function partViews(row: any, item: ReportItem): ReportPartView[] {
  const rows = loadParts(row.id).filter(r => r.part !== 'main' && getPartDef(r.part))
  const sorted = rows.sort((a, b) => (getPartDef(a.part)!.order - getPartDef(b.part)!.order))
  const block = item.confirmedAt ? '这份报告已经核对过了，不能再改；需要重试请重新生成一份'
    : item.status === 'stale' ? '统计数据或写作要求有变化，请重新生成整份报告（单独重试会和主文对不上）'
    : isGenerating(row.id) ? '正在生成，请等它结束' : null
  return sorted.map((r: PartRowDb) => {
    const def = getPartDef(r.part)!
    return { part: r.part, label: def.label, status: effectiveStatus(row.id, r.status), message: r.message, detail: r.detail, model: r.model, canRetry: !block, retryBlock: block }
  })
}

function variantViews(reportId: string): ReportVariantView[] {
  const db = getDb()
  const names = new Map((db.prepare('SELECT code, name FROM kps').all() as any[]).map(r => [String(r.code), String(r.name)]))
  return (db.prepare('SELECT * FROM report_variants WHERE report_id = ? ORDER BY seq').all(reportId) as any[]).map(r => {
    const chk = parseJson<{ problems?: string[]; hints?: string[]; second?: string | null }>(r.check_json, {})
    return {
      id: r.id, seq: r.seq, qtype: r.qtype === 'blank' ? 'blank' : 'choice', stem: r.stem ?? '', options: parseJson<string[]>(r.options_json, []), answer: r.answer ?? '', explanation: r.explanation ?? '', changed: r.changed ?? '',
      status: r.status, teacherOk: !!r.teacher_ok, kpName: r.kp_code ? names.get(r.kp_code) ?? '' : '', notes: [...(chk.problems ?? []), ...(chk.hints ?? [])], secondAnswer: chk.second ?? null
    }
  })
}

const courseAdviceOf = (md: string): string | null => { const a = extractCourseAdvice(md); return a ? stripMarks(a).trim() : null }

export function getReport(id: string): ReportDetail | null {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  if (!row) return null
  const item = itemOf(row, new Map())
  // 旧报告里 AI 套在引用外面的反引号（`[卷名 · 题号]`）读出来时去掉
  return { ...item, markdown: fixBackticks(row.markdown ?? ''), refs: refreshRefs(parseJson<CitationRef[]>(row.refs_json, [])), unverified: parseJson<UnverifiedItem[]>(row.verify_json, []), parts: partViews(row, item), variants: variantViews(id), courseAdvice: courseAdviceOf(row.markdown ?? '') }
}

/** 这份报告还在生成附加段：核对、勾选、删句、删除、导出 / 复制都先拒绝（内容还没定，别让半成品出去，也别让生成中的行被删掉） */
export const GENERATING_MSG = '这份报告的附加部分还在生成，请等它结束（或先取消）再操作'
function assertIdle(id: string): void { if (isGenerating(id)) throw new Error(GENERATING_MSG) }

export function deleteReport(id: string): boolean {
  assertIdle(id)
  const row = getDb().prepare('SELECT filter_json, reader FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  const r = getDb().prepare('DELETE FROM reports WHERE id = ? AND kind = ?').run(id, KIND)
  // 同一个筛选、同一个版本的「未完成草稿」跟着清（报告都删了，没写完的那份也没有留着的意义）
  if (r.changes > 0 && row) clearDraft(draftKey(parseFilter(row.filter_json), readerOf(row)))
  if (r.changes > 0) notifyDataChanged('reports')
  return r.changes > 0
}

/**
 * 老师点「我已核对」：家长版据此才能导出 / 复制（其他版本也可以点，标识从「AI 草稿」换成「已由老师核对」）。
 * 家长版内容太少 / 还有矛盾句时拒绝；家长版里每一句标着「未核实」的话，要么已经被删掉，要么出现在 acknowledged（老师勾了「已确认无误」的句子）里，否则拒绝。
 * 勾过的句子在 verify_json 里记 acknowledged: true（留痕）。拒绝时抛出白话错误。
 */
export function confirmReport(id: string, acknowledged: string[] = []): boolean {
  assertIdle(id)
  const rep = getReport(id)
  if (!rep) return false
  const why = confirmBlockReason(rep)
  if (why) throw new Error(why)
  const pending = unacknowledgedSentences(rep, acknowledged)
  if (pending.length) {
    const shown = pending.slice(0, 2).map(x => `「${x.length > 30 ? x.slice(0, 30) + '…' : x}」`).join('、')
    throw new Error(`还有 ${pending.length} 句${ruleTalk(rep.filter?.subject)}的话标着「未核实」，既没有确认无误、也没有删掉（如 ${shown}）。请逐句确认或删掉，再点「我已核对」`)
  }
  const ok = new Set(acknowledged)
  const marked = rep.unverified.map(u => (u.kind === 'unverified' && ok.has(u.sentence) ? { ...u, acknowledged: true } : u))
  // 老板版确认之后，「有 N 处说法还没经老师核对」那一行就去掉
  const md = rep.reader === 'boss' && hasBossReviewLine(rep.markdown) ? setBossReviewLine(rep.markdown, 0) : rep.markdown
  const r = getDb().prepare("UPDATE reports SET confirmed_at = datetime('now','localtime'), verify_json = ?, markdown = ? WHERE id = ? AND kind = ? AND confirmed_at IS NULL").run(JSON.stringify(marked), md, id, KIND)
  if (r.changes > 0) notifyDataChanged('reports')
  return true
}

/**
 * 核对时从报告里删掉一句「未核实 / 矛盾」的话（老师不想让它留在报告里）：只能删清单里的句子，已经「我已核对」的报告不能再改。
 * 正文里连同它后面的标记、紧跟的引用和句号一起删；warnings 里「有 N 句未核实」同步重算。
 * 返回更新后的报告；删不掉（句子不在清单里、正文里找不到、报告已核对）时抛出白话错误。
 */
export function removeReportSentence(id: string, sentence: string): ReportDetail {
  assertIdle(id)
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  if (!row) throw new Error('这份报告已经不存在了')
  if (row.confirmed_at) throw new Error('这份报告已经核对过了，不能再删句子；需要改请重新生成')
  // 分段的报告：句子属于哪一段就改哪一段，再重新拼装（直接改拼好的整篇会在下次拼装时丢掉）
  if (loadParts(id).some(r => r.part === 'main')) {
    if (!removeFromParts(id, sentence)) throw new Error('没能在报告里找到这一句（可能已经删过了）')
    const r2 = getDb().prepare('SELECT warnings_json, verify_json FROM reports WHERE id = ?').get(id) as any
    getDb().prepare('UPDATE reports SET warnings_json = ? WHERE id = ?').run(JSON.stringify(refreshVerifyWarnings(parseJson<string[]>(r2.warnings_json, []), parseJson<UnverifiedItem[]>(r2.verify_json, []), parseFilter(row.filter_json).subject)), id)
    notifyDataChanged('reports')
    return getReport(id)!
  }
  const out = dropReportSentence(row.markdown ?? '', parseJson<UnverifiedItem[]>(row.verify_json, []), sentence)
  if (!out) throw new Error('没能在报告里找到这一句（可能已经删过了）')
  const warnings = refreshVerifyWarnings(parseJson<string[]>(row.warnings_json, []), out.unverified, parseFilter(row.filter_json).subject)
  getDb().prepare('UPDATE reports SET markdown = ?, verify_json = ?, warnings_json = ? WHERE id = ?').run(out.markdown, JSON.stringify(out.unverified), JSON.stringify(warnings), id)
  notifyDataChanged('reports')
  return getReport(id)!
}

/** 从分段报告里删一句「未核实 / 矛盾」的话：找到登记了这句的那一段，改那一段的正文（变形题的讲解在题目行里），然后重新拼装 */
function removeFromParts(id: string, sentence: string): boolean {
  const db = getDb()
  for (const r of loadParts(id)) {
    if (r.status !== 'ok') continue
    const meta = metaOf(r)
    if (!(meta.unverified ?? []).some(u => u.sentence === sentence)) continue
    const left = (meta.unverified ?? []).filter(u => u.sentence !== sentence)
    if (r.part === 'variants') {
      let hit = false
      for (const v of db.prepare('SELECT id, explanation FROM report_variants WHERE report_id = ?').all(id) as any[]) {
        const next = removeSentence(v.explanation ?? '', sentence)
        if (next !== v.explanation) { db.prepare('UPDATE report_variants SET explanation = ? WHERE id = ?').run(next, v.id); hit = true }
      }
      if (!hit) continue
      db.prepare('UPDATE report_parts SET usage_json = ? WHERE report_id = ? AND part = ?').run(JSON.stringify({ ...meta, unverified: left }), id, r.part)
    } else {
      const out = dropReportSentence(r.markdown ?? '', meta.unverified ?? [], sentence)
      if (!out) continue
      db.prepare('UPDATE report_parts SET markdown = ?, usage_json = ? WHERE report_id = ? AND part = ?').run(out.markdown, JSON.stringify({ ...meta, unverified: out.unverified }), id, r.part)
    }
    reassemble(id)
    return true
  }
  return false
}

// ───────────────────────── 单段重试 / 变形题勾选 ─────────────────────────

/**
 * 只重新生成报告里的一个附加段：其余段和主文不动。已核对的报告、数据或提示词已经变了的报告不能单独重试（会和主文对不上）。
 * 进度走 part 事件，返回时这一段已经写好（或失败，原因写在这一段的 message 里）。
 */
export async function retryReportPart(id: string, part: string, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void): Promise<{ ok: boolean; message?: string }> {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  if (!row) return { ok: false, message: '这份报告已经不存在了' }
  const def = getPartDef(part)
  const reader = readerOf(row)
  if (!def || part === 'main' || !def.readers.includes(reader) || !loadParts(id).some(r => r.part === part)) return { ok: false, message: '这份报告里没有这一部分' }
  if (row.confirmed_at) return { ok: false, message: '这份报告已经核对过了，不能再改；需要重试请重新生成一份' }
  if (!aiConfigured() && def.ai) return { ok: false, message: '尚未配置 AI 服务（请联系管理员：设置 → 管理员设置 → AI 服务）' }
  if (isGenerating(id)) return { ok: false, message: '这份报告正在生成，请等它结束或先取消' }
  const options = parseJson<ReportOptions>(row.options_json, {})
  const memo = new Map<string, PreparedReport>()
  const item = itemOf(row, memo)
  if (item.status === 'stale') return { ok: false, message: '统计数据或写作要求有变化，请重新生成整份报告（单独重试会和主文对不上）' }
  const p = memo.get(`${reader}|${row.filter_json ?? '{}'}|${row.options_json ?? ''}`) ?? prepareReport(parseFilter(row.filter_json), reader, options)
  const main = loadParts(id).find(r => r.part === 'main')
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  const offGone = senderGone(() => ctl.abort())
  try {
    send({ id: requestId, type: 'start', scopeKey: 'report', refs: [] })
    let failMsg = ''
    const res = await runParts({
      reportId: id, defs: [def], ctx: { reader, options, prepared: p, mainMarkdown: main?.markdown ?? '' }, signal: ctl.signal,
      onEvent: e => { if (e.state === 'failed' && e.message) failMsg = e.message; send({ id: requestId, type: 'part', ...e }) }, onChange: () => notifyDataChanged('reports')
    })
    if (res.cancelled) { send({ id: requestId, type: 'cancelled', partial: '', reportId: id }); return { ok: false, message: '已取消' } }
    send({ id: requestId, type: 'done', markdown: '', refs: [], warnings: [], reportId: id })
    return res.failed.length ? { ok: false, message: failMsg || loadParts(id).find(r => r.part === part)?.message || '这一部分没有生成成功' } : { ok: true }
  } finally {
    offGone()
    inflight.delete(requestId)
  }
}

/** 老师逐题勾「我核对过」：勾了的变形题才会放进答题卡（被程序剔除的题不能勾）；返回更新后的报告 */
export function tickVariant(id: string, variantId: string, ok: boolean): ReportDetail {
  assertIdle(id)
  const db = getDb()
  const conf = db.prepare('SELECT confirmed_at c FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  if (!conf) throw new Error('这份报告已经不存在了')
  // 已「我已核对」的报告内容已经定稿：不能再改勾选（要改请重新生成一份）
  if (conf.c) throw new Error('这份报告已经核对过了，不能再改变形题的勾选；需要改请重新生成一份')
  const v = db.prepare('SELECT id, status FROM report_variants WHERE id = ? AND report_id = ?').get(variantId, id) as any
  if (!v) throw new Error('没有找到这道变形题')
  if (v.status === 'dropped') throw new Error('这道题没有通过程序校验，不能放进答题卡')
  db.prepare('UPDATE report_variants SET teacher_ok = ? WHERE id = ?').run(ok ? 1 : 0, variantId)
  reassemble(id)
  notifyDataChanged('reports')
  return getReport(id)!
}

/** 导出 / 复制前的把关：家长版没核对、或内容太少 / 还有矛盾句，都不许出去 */
export function assertExportable(report: Pick<ReportDetail, 'reader' | 'confirmedAt' | 'markdown' | 'unverified'> & { id?: string }): void {
  if (report.id) assertIdle(report.id)
  const why = confirmBlockReason(report)
  if (why) throw new Error(why)
  if (report.reader === 'parent' && !report.confirmedAt) throw new Error('家长版要先由老师核对：请先点「我已核对」，再导出或复制')
}

/**
 * 导出用的正文：家长版经老师核对后，「未核实」标记去掉（老师确认过了，不该让家长看到）；老师版 / 老板版 / 完整数据版保留标记（读者是内部人，要看到哪句没核实）。
 * 复制到微信和导出 Word / PDF / Markdown 都用它，两个出口口径一致。
 */
export function exportableMarkdown(report: Pick<ReportDetail, 'reader' | 'markdown'>): string {
  return report.reader === 'parent' ? stripMarks(report.markdown) : report.markdown
}

/** 复制到微信的纯文本：带换行和序号，没有任何 Markdown 符号；标记的取舍同 exportableMarkdown */
export function wechatText(report: ReportDetail): string {
  return markdownToWechat(report.markdown, { keepMarks: report.reader !== 'parent', spaced: report.reader === 'parent' })
}

// ───────────────────────── 生成前的预览（不花钱） ─────────────────────────

export interface ReportPreview {
  filterDesc: string
  papers: number
  questions: number
  /** 现在不能生成的原因（没配 AI / 范围内没有试卷 / 提示词被改坏）；可以生成时为 null */
  blocked: string | null
  aiReady: boolean
  busy: boolean
  reader: ReportReader
  /** 上次生成失败时留下的「未完成草稿」（这个筛选、这个版本）；不是有效结果 */
  draft: Pick<Draft, 'markdown' | 'refs' | 'message' | 'detail' | 'createdAt'> | null
}

const aiConfigured = () => { const c = loadConfig(); return !!(c.base_url && c.model && getApiKey()) }
const GUIDE = '尚未配置 AI 服务（请联系管理员：设置 → 管理员设置 → AI 服务）。统计和看板不受影响'

const draftKey = (filter: StatsFilter, reader: ReportReader) => `report:${reader}:${cacheKeys({ kind: KIND, reader, filter: normalizeFilter(filter) }, '', '').scopeKey}`

export function previewReport(filter: StatsFilter, reader: ReportReader = 'full'): ReportPreview {
  // 只数试卷和题目就够了，不必构造整套输入（那要几百毫秒）
  const db = getDb()
  const sc = paperScope(filter)
  const papers = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const questions = (db.prepare(`SELECT COUNT(*) c FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const ready = aiConfigured()
  let promptError: string | null = null
  const id = PROMPT_OF[reader]
  try { fillTemplate(promptText(id, 'user', filter.subject), Object.fromEntries(PLACEHOLDERS[id].map(k => [k, '']))) } catch (e) { promptError = (e as Error).message }
  const blocked = papers === 0 ? '当前筛选下没有计入统计的试卷（只统计已确认的试卷；可以先在审核页确认，或在筛选栏打开「含待审核」）'
    : promptError ? `报告提示词有问题：${promptError}（请联系管理员：设置 → 管理员设置 → 提示词，修正或恢复默认）`
    : !ready ? GUIDE : null
  const d = getDraft(draftKey(filter, reader))
  return {
    filterDesc: describeFilterDb(filter, undefined, papers), papers, questions, blocked, aiReady: ready, busy: inflight.size > 0, reader,
    draft: d ? { markdown: d.markdown, refs: refreshRefs(d.refs), message: d.message, detail: d.detail, createdAt: d.createdAt } : null
  }
}

// ───────────────────────── 生成（流式） ─────────────────────────

const inflight = new Map<string, AbortController>()

export const reportBusy = (): boolean => inflight.size > 0

export function cancelReport(requestId: string): boolean {
  const c = inflight.get(requestId)
  if (!c) return false
  c.abort()
  return true
}

/** @param send 把事件发给发起请求的那个窗口（调用方传 event.sender.send），不广播 */
export async function generateReport(filter: StatsFilter, reader: ReportReader, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void, options: ReportOptions = {}): Promise<GenerateResult & { reportId?: string }> {
  const p = prepareReport(filter, reader, options)
  if (p.input.empty) return { ok: false, code: 'no_data', message: '当前筛选下没有计入统计的试卷，无法生成报告' }
  if (p.promptError) return { ok: false, code: 'bad_prompt', message: `报告提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词，修正或恢复默认）` }
  if (!aiConfigured()) return { ok: false, code: 'no_ai', message: '尚未配置 AI 服务（请联系管理员：设置 → 管理员设置 → AI 服务），统计结果不受影响' }
  if (inflight.has(requestId)) return { ok: false, code: 'busy', message: '这个请求已经在生成' }

  const cfg = loadConfig()
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  const offGone = senderGone(() => ctl.abort())
  const dkey = draftKey(filter, reader)
  const stream = createStream({ cfg, system: p.system, user: p.user, requestId, send, signal: ctl.signal })
  const kind = reader === 'full' ? 'p3_report' : PROMPT_OF[reader]
  try {
    send({ id: requestId, type: 'start', scopeKey: 'report', refs: p.input.refs })
    const r = await stream.run()
    recordUsage({ paperId: null, kind, model: r.model, usage: r.usage, ok: true })

    const warn = p.input.placeholders.SAMPLE_WARNING
    const fin = finishReport({
      raw: r.content, reader, title: p.title, knownRefs: new Set(p.input.refs.map(x => x.token)), knownCodes: allCodes(), sampleWarning: warn,
      evidence: p.src.evidence?.statements ?? [], usedDefaultPrompt: promptVersionFor(PROMPT_OF[reader], p.subject) === defaultVersionOf(PROMPT_OF[reader], p.subject),
      subject: p.subject,
      evidenceKps: (p.src.evidence?.kps ?? []).map(k => ({ code: k.code, name: k.name, plain: k.plain, example_en: k.example_en, example_zh: k.example_zh, hint_words: k.hint_words })),
      papers: Number(p.input.placeholders.PAPER_COUNT) || 0,
      topScore: topScoreOf(p.src),
      examLabel: examLabelOf(p),
      bossLine: bossSampleLine(Number(p.input.placeholders.PAPER_COUNT) || 0, p.input.placeholders.YEARS, warn)
    })
    if (r.fellBackTo) fin.warnings.push(limitFallbackNotice(r.fellBackTo))
    const id = crypto.randomUUID()
    // 有附加段的读者（老师版……）：主文先存成「主文」一段，再依次生成各附加段；没有附加段的读者走原来的路径，一行都不变
    const defs = partsFor(reader, options, { reportId: id, prepared: p })
    // 程序拼的「易错题集」里要引用的样本题也算用到的引用
    const errTokens = defs.some(d => d.id === 'errors') ? new Set(p.input.errorItems.flatMap(i => i.questions.map(q => q.token))) : new Set<string>()
    const used = p.input.refs.filter(x => fin.text.includes(x.token) || errTokens.has(x.token))

    const db = getDb()
    db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown, model, title, refs_json, warnings_json, sample_warning, fingerprint, cache_key, template_sig, prompt_version, usage_json,
        checked_rev, checked_sig, checked_json, reader, verify_json, options_json, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, KIND, JSON.stringify(normalizeFilter(filter)), fin.text, r.model, p.title, JSON.stringify(used), JSON.stringify(fin.warnings), warn === '无' ? null : warn, p.input.fingerprint, p.cacheKey, p.templateSig,
        p.promptVersion, JSON.stringify(r.usage), p.rev, p.templateSig, JSON.stringify({ fresh: true, reasons: [], promptError: null, empty: false }), reader, JSON.stringify(fin.unverified), hasOptions(options) ? JSON.stringify(options) : null, filter.subject ?? 'english')
    // 历史每个学科各最多留 MAX_HISTORY 条
    pruneReportHistory(db, KIND, filter.subject ?? 'english', MAX_HISTORY)
    clearDraft(dkey)
    notifyDataChanged('reports')
    if (defs.length === 0) {
      send({ id: requestId, type: 'done', markdown: fin.text, refs: used, warnings: fin.warnings, reportId: id, unverified: fin.unverified })
      return { ok: true, markdown: fin.text, refs: used, warnings: fin.warnings, reportId: id, unverified: fin.unverified }
    }
    saveMainPart(id, { markdown: fin.text, model: r.model, promptVersion: p.promptVersion, usage: r.usage, unverified: fin.unverified, warnings: fin.warnings })
    const run = await runParts({
      reportId: id, defs, ctx: { reader, options, prepared: p, mainMarkdown: fin.text }, signal: ctl.signal,
      onEvent: e => send({ id: requestId, type: 'part', ...e }), onChange: () => notifyDataChanged('reports')
    })
    const done = getReport(id)!
    if (run.cancelled) {
      // 主文和已完成的段已经存下了，但这次生成是被取消的：对界面报告「已取消」（并带上报告 id，界面据此选中这份已保存的报告）
      const msg = '已取消。主文和已完成的部分已经保存，没生成的部分可以在报告里单独重试'
      send({ id: requestId, type: 'cancelled', partial: '', reportId: id })
      return { ok: false, cancelled: true, code: 'aborted', message: msg, partial: '', reportId: id }
    }
    const warnings = run.failed.length ? [...done.warnings, `有 ${run.failed.length} 个部分没有生成成功（${run.failed.map(x => getPartDef(x)?.label ?? x).join('、')}），可以在报告里单独重试`] : done.warnings
    send({ id: requestId, type: 'done', markdown: done.markdown, refs: used, warnings, reportId: id, unverified: done.unverified })
    return { ok: true, markdown: done.markdown, refs: used, warnings, reportId: id, unverified: done.unverified }
  } catch (e) {
    const partial = stream.partial(e)
    stream.dispose()
    if (e instanceof AiError && e.code === 'aborted') {
      send({ id: requestId, type: 'cancelled', partial })
      return { ok: false, cancelled: true, code: 'aborted', message: '已取消', partial }
    }
    const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
    recordUsage({ paperId: null, kind, model: cfg.model, ok: false })
    const fr = friendlyAiError(err)
    // 已经写出来的部分留作「未完成草稿」：可以看，但不当作有效结果（不进历史、不能导出）
    const known = new Set(p.input.refs.map(x => x.token))
    saveDraft({ key: dkey, kind: 'report', markdown: stripUnknownCitations(stripInternalCodes(fixBackticks(partial), allCodes()), known).text, refs: p.input.refs, message: fr.message, detail: fr.detail, model: cfg.model })
    send({ id: requestId, type: 'error', code: err.code, message: fr.message, detail: fr.detail, partial })
    return { ok: false, code: err.code, message: fr.message, detail: fr.detail, partial }
  } finally {
    stream.dispose()
    offGone()
    inflight.delete(requestId)
  }
}

/**
 * 导出页脚用的「数据口径」：这份报告的筛选范围里现在有几份卷子、哪几个学年。
 * 例：数据来源：2 份校考卷（2024-2025、2025-2026 学年）
 */
export function dataScopeNote(report: Pick<ReportDetail, 'filter'>): string {
  const db = getDb()
  const sc = paperScope(report.filter)
  const n = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const years = (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${sc.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...sc.params) as any[]).map(r => `${r.y}-${r.y + 1}`)
  return `数据来源：${n} 份校考卷${years.length ? `（${years.join('、')} 学年）` : ''}`
}
