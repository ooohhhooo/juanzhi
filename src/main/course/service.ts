/**
 * 课程对照的服务层（需要 electron：数据库句柄、AI 网络请求、剪贴板在这里用）。纯函数都在同目录的其它文件里，单测直接加载。
 *
 *  · 读文件 → 内存里的「读取会话」（大表不来回传给界面）→ AI / 本地规则认列 → 预览 → 保存；
 *  · 知识点 → 课次 的 AI 匹配（逐批落库，可取消，已完成的批次保留）；
 *  · 家长沟通话术（流式，缓存键 = 范围 + 体系 rev + 对应结果 + 提示词；数据变了只标「已过期」，绝不自动重新生成）。
 * 日志只记计数和耗时，不记课程内容、试卷标题和文件名。
 */
import { net, clipboard } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { getDb } from '../db'
import { AiError, chat, HIDDEN_THINKING } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { createStream } from '../ai/stream'
import { effectiveMaxTokens } from '../ai/providers'
import { friendlyAiError, limitFallbackNotice } from '../ai/friendly'
import { parseModelOf } from '../ai/types'
import { clearDraft, getDraft, saveDraft } from '../ai/drafts'
import { promptText, promptVersionFor } from '../ai/prompts'
import { isPathAllowed } from '../allowedPaths'
import { log } from '../log'
import type { ChunkEvent, UnverifiedItem } from '../ai/chunk'
import { stripMarks } from '../../shared/factcheck'
import { fixBackticks, stripInternalCodes } from '../../shared/report-post'
import { stripCodes } from '../../shared/code-guard'
import { COURSE_FIELD_LABELS, SUBJECTS, asSubject } from '../../shared/subject'
import type { SubjectId } from '../../shared/subject'
import { collectEvidence } from '../stats/evidence'
import { paperScope } from '../stats/filter'
import type { StatsFilter } from '../stats/filter'
import { scopeCounts, selectedCount } from '../stats/core'
import { cacheKeys, describeFilter, fillTemplate, normalizeFilter } from '../stats/p2'
import { p3SampleWarning } from '../stats/p3'
import { createGate, mapLimit } from './map-limit'
import { CourseFileError, buildXlsx, readTable } from './table-read'
import { EXTRACT_MAPPING, KIND_LABEL, lessonsToSheet, parseExtractResponse, richKindOf } from './doc-extract'
import { tooBigForExt } from '../../shared/file-limits'
import { TEXTBOOK_MAPPING, estimateCalls, estimateOcrPages, kpCandidateLines, ocrMinutes, pageRangeText, parseUnitKpResponse, textbookToSheet, unitNeedsReview } from './textbook'
import type { UnitKp, UnitPlan, UnitSource } from './textbook'
import { findBuiltinCatalog, getCatalogProvider } from './textbook-edition'
import { listKps } from '../ai/taxonomy'
import type { ExtractParse } from './doc-extract'
import type { RichKind } from './doc-extract'
import { planTextbook, readRichFile, readTextbookUnits, textbookPagePreview } from './doc-read'
import type { ReadOpts, TextbookPlan } from './doc-read'
import type { TableRead } from './table-read'
import { applyMapping, buildOutline, guessMapping } from './map'
import type { MapWarning, ParsedLevel, ParsedOutline, SheetMapping } from './map'
import { MAX_LESSONS, MAX_LEVELS } from './store'
import { parseColsResponse, sheetPreview } from './cols-ai'
import { chunkLines, kpBatchBlock, lessonQuoteText, mergeCandidates, outlineLine, parseLessonResponse } from './match'
import { computeRulePass, applyRulePass } from './match-rules'
import { CATALOG } from './catalog'
import { applyLessonMatches, lessonRows, matchState, targetKps } from './store'
import { courseDashboard } from './stats'
import type { CourseDashboard } from './stats'
import { buildAdviceInputs, buildHintInputs, courseRowsOf } from './report-section'
import type { CourseScene } from './report-section'
import { finishAdvice, sanitizePartial } from './advice-post'
import { TEMPLATE_HEADERS, templateRows, sampleSheets } from './template'

type Db = any

// ───────────────────────── 读文件：会话 ─────────────────────────

/** Word / PDF / 图片没有现成表格时：读出的文字等 AI 整理成表（done 之后 read.sheets 里就有那张表）；extraWarnings = 整理时去掉了哪些找不到原文的课 */
interface ExtractState { kind: RichKind; numbered: string; lines: string[]; pages: number; done: boolean; extraWarnings: MapWarning[]; textbook?: TextbookState }
/** 教材 / 整本书：先找目录切单元、再一个单元一次 AI 小调用挑知识点（后台任务里做）；整理好的单元留在这里，失败的单元重试时只重做它们 */
interface TextbookState { plan: TextbookPlan; units: UnitPlan[] | null; via: UnitSource | null; results: Map<number, UnitKp[]>; errors: Map<number, string>; edition?: { label: string; catalog: { id: string; label: string } | null } | null; builtin?: boolean }
interface Session { /** 学科（向导里选的，缺省英语） */ subject?: string; name: string; hash: string; read: TableRead; at: number; ctl: AbortController | null; parsed: ParsedOutline | null; /** 后台整理任务还在用它：不能被挤掉 */ keep?: boolean; extract?: ExtractState; fromDoc?: RichKind }
const sessions = new Map<string, Session>()
const MAX_SESSIONS = 40

export interface SourceInfo {
  sessionId: string
  name: string
  hash: string
  sheets: Array<{ name: string; hidden: boolean; rows: number; cols: number; mergedFilled: boolean; /** 前 14 行，给「列识别条」显示 */ head: string[][] }>
  warnings: string[]
  /** 来自 Word / PDF / 图片（界面据此提示「请核对」）；aiOrganised = 表是 AI 从文字里整理出来的；pending = 还没整理（点“下一步”时才调用 AI） */
  fromDoc?: { label: string; aiOrganised: boolean; pending: boolean; pages: number; chars: number; /** 教材课本：总页数、选中的页数、是否扫描版、文字识别大约要几分钟、认出的版本（有内置目录时带 catalog） */ textbook?: { totalPages: number; selectedPages: number; scanned: boolean; ocrMinutes: number; edition: { label: string; catalog: { id: string; label: string } | null } | null } }
}

export function sourceInfo(sessionId: string, s: Session): SourceInfo {
  const read = s.read
  const e = s.extract
  return {
    sessionId, name: s.name, hash: s.hash, warnings: read.warnings,
    sheets: read.sheets.map(x => ({ name: x.name, hidden: x.hidden, rows: x.rows.length, cols: x.rows.reduce((m, r) => Math.max(m, r.length), 0), mergedFilled: x.mergedFilled, head: x.rows.slice(0, 14) })),
    ...(s.fromDoc ? { fromDoc: { label: KIND_LABEL[s.fromDoc], aiOrganised: !!e, pending: !!e && !e.done, pages: e?.pages ?? 1, chars: e?.numbered.length ?? 0, ...(e?.textbook ? { textbook: { totalPages: e.textbook.plan.totalPages, selectedPages: e.textbook.plan.pageList.length, scanned: e.textbook.plan.scanned, ocrMinutes: ocrMinutes(estimateOcrPages(e.textbook.plan.pageList.length)), edition: e.textbook.edition ?? null } } : {}) } } : {})
  }
}

function remember(name: string, hash: string, read: TableRead, rich?: { kind: RichKind; extract?: ExtractState }): SourceInfo {
  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, { name, hash, read, at: Date.now(), ctl: null, parsed: null, extract: rich?.extract, fromDoc: rich?.kind })
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].filter(([, v]) => !v.keep).sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    oldest[1].ctl?.abort()
    sessions.delete(oldest[0])
  }
  return sourceInfo(sessionId, sessions.get(sessionId)!)
}

/** 保存时的类型：教材课本 / 课程表（给 course_outlines.kind 用；v15 之前的库没有这一列，store 里会忽略） */
export function sessionKind(id: string | undefined): 'course' | 'textbook' | undefined {
  const s = id ? sessions.get(id) : undefined
  return s ? (s.extract?.textbook ? 'textbook' : 'course') : undefined
}

/** 这次教材整理用的是内置目录时，返回目录里这一册的 id（如 'math-renjiao:1上'）；保存时写进 builtin_id，和「添加学校教材」的结果一致 */
export function sessionBuiltinId(id: string | undefined): string | undefined {
  const s = id ? sessions.get(id) : undefined
  const tb = s?.extract?.textbook
  return s && tb?.builtin ? (editionOf(s)?.catalog?.id ?? undefined) : undefined
}

/** 读文件（路径必须是对话框返回或拖入时登记过的）；文件名只用来判断格式和作为默认的体系名，不进日志。opts：课程表 / 教材课本、页码范围 */
export async function readSourceFile(filePath: string, opts: ReadOpts & { subject?: string } = {}): Promise<SourceInfo> {
  if (!isPathAllowed(filePath)) throw new CourseFileError('这个文件没有经过选择对话框或拖入，不能读取')
  let size: number
  try { size = fs.statSync(filePath).size } catch { throw new CourseFileError('读不了这个文件，可能被其他程序占用或没有权限') }
  const name = filePath.replace(/^.*[\\/]/, '')
  const kind = richKindOf(/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '')
  const tooBig = tooBigForExt(size, /\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '')
  if (tooBig) throw new CourseFileError(tooBig)
  const base = name.replace(/\.[^.]+$/, '')
  // PDF 不读进内存：哈希用流式，文字由渲染窗口按需分块读
  const hashOf = (): Promise<string> => new Promise((resolve, reject) => { const h = crypto.createHash('sha1'); const st = fs.createReadStream(filePath); st.on('data', c => h.update(c)); st.on('error', reject); st.on('end', () => resolve(h.digest('hex'))) })
  if (kind === 'pdf') {
    const hash = await hashOf().catch(() => { throw new CourseFileError('读不了这个文件，可能被其他程序占用或没有权限') })
    if (opts.kind === 'textbook') return rememberTextbook(base, hash, kind, await planTextbook(filePath, kind, opts, name), opts.subject)
    const r = await readRichFile(filePath, null, kind, opts)
    const t = r.text!
    return remember(base, hash, { sheets: [], warnings: [] }, { kind, extract: { kind, numbered: t.numbered, lines: t.lines, pages: t.pages, done: false, extraWarnings: [] } })
  }
  let buf: Buffer
  try { buf = fs.readFileSync(filePath) } catch { throw new CourseFileError('读不了这个文件，可能被其他程序占用或没有权限') }
  if (kind) {
    const hash = crypto.createHash('sha1').update(buf).digest('hex')
    if (opts.kind === 'textbook' && kind === 'docx') return rememberTextbook(base, hash, kind, await planTextbook(filePath, kind, opts, name), opts.subject)
    const r = await readRichFile(filePath, buf, kind, opts)
    if (r.table) return remember(base, hash, r.table, { kind })
    const t = r.text!
    return remember(base, hash, { sheets: [], warnings: [] }, { kind, extract: { kind, numbered: t.numbered, lines: t.lines, pages: t.pages, done: false, extraWarnings: [] } })
  }
  const read = await readTable(buf, name)
  log.info('course', '读取课程表', { sheets: read.sheets.length, rows: read.sheets.reduce((n, s) => n + s.rows.length, 0) })
  return remember(name.replace(/\.[^.]+$/, ''), crypto.createHash('sha1').update(buf).digest('hex'), read)
}

function rememberTextbook(base: string, hash: string, kind: RichKind, plan: TextbookPlan, subject?: string): SourceInfo {
  log.info('course', '读取教材', { kind, pages: plan.pageList.length, total: plan.totalPages, scanned: plan.scanned })
  const extract: ExtractState = { kind, numbered: '', lines: [], pages: plan.pageList.length || 1, done: false, extraWarnings: [], textbook: { plan, units: null, via: null, results: new Map(), errors: new Map(), edition: plan.edition ? { label: plan.edition.label, catalog: null } : null } }
  const info = remember(base, hash, { sheets: [], warnings: [] }, { kind, extract })
  if (!subject) return info
  setSessionSubject(info.sessionId, subject)   // 学科定了才能查内置目录
  return sourceInfo(info.sessionId, sessions.get(info.sessionId)!)
}

/** 认出版本后，学科确定了才能查内置目录（会话学科在向导里设置） */
function editionOf(s: Session): { label: string; catalog: { id: string; label: string } | null } | null {
  const plan = s.extract?.textbook?.plan
  if (!plan?.edition) return null
  return { label: plan.edition.label, catalog: findBuiltinCatalog(asSubject(s.subject), plan.edition) }
}

/** 粘贴的表格文字（从 Excel 复制出来是制表符分隔） */
export async function readSourceText(text: string): Promise<SourceInfo> {
  if (text.length > 5 * 1024 * 1024) throw new CourseFileError('粘贴的内容太多了')
  const read = await readTable(Buffer.from(text, 'utf8'), '粘贴的表格.csv')
  return remember('粘贴的课程表', crypto.createHash('sha1').update(text).digest('hex'), read)
}

/** 后台整理任务占用 / 释放读取会话 */
export function keepSession(id: string, keep: boolean): void { const s = sessions.get(id); if (s) s.keep = keep }
/** 记下这份文件属于哪个学科（认列的提示词、表头猜测都按它） */
export function setSessionSubject(id: string, subject: unknown): void { const s = sessions.get(id); if (s) { s.subject = asSubject(subject); if (s.extract?.textbook) s.extract.textbook.edition = editionOf(s) } }
export function dropSession(id: string): void { const s = sessions.get(id); if (!s) return; s.ctl?.abort(); sessions.delete(id) }

export function sessionOf(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new CourseFileError('这份文件的读取记录已经过期，请重新选择文件')
  s.at = Date.now()
  return s
}

// ───────────────────────── 认列 ─────────────────────────

export interface SuggestItem { mapping: SheetMapping | null; problems: string[]; source: 'ai' | 'guess' | 'manual'; error?: string }
export interface SuggestResult { items: Record<string, SuggestItem>; model: string; /** 文字版文件整理成表之后的读取结果（界面据此换上表格预览） */ source?: SourceInfo }

const emptyMapping = (): SheetMapping => ({ headerRows: 1, levelName: '', columns: [], skipMarkers: [], uncertain: [] })
const aiReady = () => { const c = loadConfig(); return !!(c.base_url && parseModelOf(c) && getApiKey()) }

export async function jsonCall(o: { kind: string; model: string; system: string; user: string; signal?: AbortSignal }): Promise<{ content: string; model: string }> {
  const cfg = loadConfig()
  const lim = effectiveMaxTokens(cfg, o.model)
  const t0 = Date.now()
  try {
    const r = await chat({
      baseUrl: cfg.base_url, apiKey: getApiKey()!, model: o.model, temperature: 0.1, maxTokens: lim.maxTokens, jsonMode: true, stream: true,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      timeoutMs: cfg.timeout_sec * 1000, signal: o.signal, fetchImpl: net.fetch as unknown as typeof fetch,
      escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback,
      onAttempt: a => recordUsage({ paperId: null, kind: o.kind, model: o.model, usage: a.usage, ok: a.ok, errCode: a.error?.code })
    })
    log.info('course', 'AI 调用完成', { kind: o.kind, ms: Date.now() - t0, attempts: r.attempts })
    return { content: r.content, model: r.model }
  } catch (e) {
    log.warn('course', 'AI 调用失败', { kind: o.kind, code: e instanceof AiError ? e.code : 'other', ms: Date.now() - t0 })
    throw e
  }
}

/**
 * 给每张表（隐藏的跳过）建议一份列映射。mode：ai = 让 AI 认列（课程内容会发给用户配置的 AI 服务，向导里已明说）；
 * guess = 只按表头文字猜（不联网）；manual = 全部留空让用户自己选。AI 出错 / 回答不合格时退回本地猜测，并在 error 里说明。
 */
export function cancelSuggest(sessionId: string): boolean {
  const s = sessions.get(sessionId)
  if (!s?.ctl) return false
  s.ctl.abort()
  return true
}

export type SuggestProgress = (done: number, total: number, unit: string, note?: string) => void

export async function suggestMappings(sessionId: string, mode: 'ai' | 'guess' | 'manual', onProgress?: SuggestProgress): Promise<SuggestResult> {
  const s = sessionOf(sessionId)
  s.ctl?.abort()
  const ctl = new AbortController()
  s.ctl = ctl
  const signal = ctl.signal
  try { return await suggestInner(sessionId, s, mode, signal, onProgress) } finally { if (s.ctl === ctl) s.ctl = null }
}

/** 文字 → 表：调用一次 p5_course_extract；回答里标题在原文里找不到的课整条去掉，并记成警告 */
/** 子 AbortController：外部 signal 中止时跟着中止；首个非取消错误时 abort 其余在途调用（mapLimit 抛出时统一触发） */
function childAbort(parent: AbortSignal): { signal: AbortSignal; abort: () => void; dispose: () => void } {
  const c = new AbortController()
  const on = () => c.abort()
  if (parent.aborted) c.abort(); else parent.addEventListener('abort', on)
  return { signal: c.signal, abort: () => c.abort(), dispose: () => parent.removeEventListener('abort', on) }
}

async function organiseText(sessionId: string, s: Session, signal: AbortSignal, onProgress?: SuggestProgress): Promise<SuggestResult> {
  const e = s.extract!
  if (e.textbook) return organiseTextbook(sessionId, s, signal, onProgress)
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  if (!e.done) {
    if (!aiReady()) throw new CourseFileError(`${KIND_LABEL[e.kind]}要先交给 AI 整理成表格：请先在“AI 服务”里配置，或者改传 Excel`)
    const label = KIND_LABEL[e.kind]
    // 按行切成约 8k 字的块，依次交给 AI（每块的标题仍对着整份原文逐字核对）；中途取消就整个停下
    const chunks: string[] = []
    let cur: string[] = [], curLen = 0
    for (const ln of e.numbered.split('\n')) {
      if (curLen + ln.length + 1 > 8000 && cur.length) { chunks.push(cur.join('\n')); cur = []; curLen = 0 }
      cur.push(ln); curLen += ln.length + 1
    }
    if (cur.length) chunks.push(cur.join('\n'))
    const p: ExtractParse = { ok: true, lessons: [], dropped: [], problems: [] }
    const seen = new Set<string>()
    let finished = 0
    onProgress?.(0, chunks.length, '段')
    // 各段并发（上限 3），合并时仍按原文顺序，去重 / 原文比对逻辑不变；取消时所有在途调用一起中止
    const sub = childAbort(signal)
    const parts = await mapLimit(chunks, 3, async chunk => {
      if (sub.signal.aborted) throw new AiError('aborted', '已取消')
      // 这一段写不完（加大上限后仍被截断）：按行对半拆开分别整理再合并，直到拆不动为止
      // 遇到「思考吃光额度」的截断不拆（拆了也一样写不完），最多拆 3 层；每段最多 8 次调用的预算
      let chunkBudget = 8
      const runChunk = async (text: string, depth = 0): Promise<ExtractParse> => {
        const user = fillTemplate(promptText('p5_course_extract', 'user'), { SOURCE_KIND: label, SOURCE_TEXT: text })
        let r
        chunkBudget--
        try { r = await jsonCall({ kind: 'course-extract', model, system: promptText('p5_course_extract', 'system'), user, signal: sub.signal }) } catch (err) {
          if (err instanceof AiError && err.code === 'aborted') throw err
          const ls = text.split('\n')
          if (err instanceof AiError && err.code === 'truncated' && !err.detail.includes(HIDDEN_THINKING) && ls.length > 1 && depth < 3 && chunkBudget >= 2) {
            const mid = Math.ceil(ls.length / 2)
            const a = await runChunk(ls.slice(0, mid).join('\n'), depth + 1)
            const b = await runChunk(ls.slice(mid).join('\n'), depth + 1)
            return { ok: a.ok && b.ok, lessons: [...a.lessons, ...b.lessons], dropped: [...a.dropped, ...b.dropped], problems: [...a.problems, ...b.problems] }
          }
          throw new CourseFileError(`AI 整理没成功（${friendlyAiError(err).message}），可以稍后重试，或改传 Excel`)
        }
        return parseExtractResponse(r.content, e.lines)
      }
      const part = await runChunk(chunk)
      if (!part.ok) throw new CourseFileError('AI 的回答格式不对，没能整理出课程表，可以重试一次，或改传 Excel')
      onProgress?.(++finished, chunks.length, '段')
      return part
    }).catch(err => { sub.abort(); throw err }).finally(() => sub.dispose())
    for (const part of parts) {
      for (const l of part.lessons) {
        const k = [l.level, l.seq, l.title].join('|')
        if (seen.has(k)) continue
        seen.add(k); p.lessons.push(l)
      }
      p.dropped.push(...part.dropped)
    }
    if (p.dropped.length) p.problems.push(`有 ${p.dropped.length} 课在原文里找不到，已去掉：${p.dropped.slice(0, 3).map(d => `「${d}」`).join('')}${p.dropped.length > 3 ? '等' : ''}`)
    if (!p.lessons.length) throw new CourseFileError(`没有从${label}里整理出任何一课${p.dropped.length ? '（AI 给出的课在原文里都找不到）' : ''}。请确认文件里是课程表，或改传 Excel`)
    s.read = { sheets: [lessonsToSheet(s.name, p.lessons)], warnings: [] }
    e.extraWarnings = p.problems.map(text => ({ kind: 'unverified' as const, sheet: s.name, row: 0, text }))
    e.done = true
    log.info('course', '文字整理成表', { kept: p.lessons.length, dropped: p.dropped.length })
  }
  const sheet = s.read.sheets[0]
  return { items: { [sheet.name]: { mapping: EXTRACT_MAPPING, problems: [], source: 'ai' } }, model, source: sourceInfo(sessionId, s) }
}

/**
 * 教材 / 整本书：找目录切成单元（不用 AI）→ 每个单元取标题、小节标题和一小段开头，一次小调用让 AI 从当前学科的知识点树里挑 2–8 个代码 → 一个单元一行。
 * 各单元并发（上限 3）；整理好的单元留在会话里，有单元失败时整个任务按失败处理，点“重试”只重做失败的单元；取消时所有在途调用一起中止。
 */
async function organiseTextbook(sessionId: string, s: Session, signal: AbortSignal, onProgress?: SuggestProgress): Promise<SuggestResult> {
  const e = s.extract!
  const tb = e.textbook!
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  if (!e.done) {
    if (!aiReady()) throw new CourseFileError('教材要先交给 AI 挑知识点：请先在“AI 服务”里配置，或者改传 Excel')
    const subj = asSubject(s.subject)
    const cands = kpCandidateLines(listKps(false, subj))
    if (!cands.codes.size) throw new CourseFileError('这个学科的知识点树里还没有可选的知识点，请先在“设置 → 知识点”里添加，或导入试卷')
    if (!tb.units) {
      const r = await readTextbookUnits(tb.plan, (d, t, u) => onProgress?.(d, t, u), signal)
      if (!r.units.length) throw new CourseFileError('没有从这本教材里读到文字。如果是扫描版，请确认电脑上的文字识别可用；也可以换一个文件')
      tb.units = r.units; tb.via = r.via
      log.info('course', '教材切单元', { units: r.units.length, via: r.via })
    }
    const units = tb.units
    const todo = units.filter(u => !tb.results.has(u.id))
    const note = `共 ${units.length} 个单元，约 ${estimateCalls(todo)} 次 AI 调用`
    let finished = units.length - todo.length
    onProgress?.(finished, units.length, '个单元', note)
    const sub = childAbort(signal)
    await mapLimit(todo, 3, async (u): Promise<void> => {
      if (sub.signal.aborted) throw new AiError('aborted', '已取消')
      try {
        const user = fillTemplate(promptText('p5_course_textbook', 'user'), {
          SUBJECT_NAME: SUBJECTS[subj].name, UNIT_TITLE: u.title, UNIT_NO: String(u.id), UNIT_TOTAL: String(units.length), PAGE_RANGE: pageRangeText(u).replace(/^第 | 页$/g, ''),
          UNIT_HEADINGS: u.headings.length ? u.headings.join('\n') : '（没有读到小节标题）', UNIT_OPENING: u.opening.length ? u.opening.join('\n') : '（没有读到正文）', KP_CANDIDATES: cands.text
        })
        const r = await jsonCall({ kind: 'course-textbook', model, system: promptText('p5_course_textbook', 'system'), user, signal: sub.signal })
        const parsed = parseUnitKpResponse(r.content, cands.codes, u.sourceLines)
        if (!parsed.ok) throw new CourseFileError('AI 的回答格式不对')
        tb.results.set(u.id, parsed.kps)
        tb.errors.delete(u.id)
      } catch (err) {
        if (err instanceof AiError && err.code === 'aborted') throw err
        tb.errors.set(u.id, err instanceof CourseFileError ? err.message : friendlyAiError(err).message)
      } finally {
        onProgress?.(++finished, units.length, '个单元', note)
      }
    }).catch(err => { sub.abort(); throw err }).finally(() => sub.dispose())
    const failed = units.filter(u => !tb.results.has(u.id))
    if (failed.length) {
      const ids = failed.slice(0, 5).map(u => u.id).join('、') + (failed.length > 5 ? ' 等' : '')
      throw new CourseFileError(`第 ${ids} 个单元没整理成功（${tb.errors.get(failed[0].id) ?? '未知原因'}）。已整理好的 ${units.length - failed.length} 个单元已保留，点“重试”只重做失败的`)
    }
    finishTextbook(s, units)
    log.info('course', '教材整理成表', { units: units.length, review: units.filter(u => unitNeedsReview(tb.results.get(u.id) ?? [])).length })
  }
  const sheet = s.read.sheets[0]
  return { items: { [sheet.name]: { mapping: TEXTBOOK_MAPPING, problems: [], source: 'ai' } }, model, source: sourceInfo(sessionId, s) }
}

/** 单元整理完（AI 或内置目录）：成一张表，提示放进警告 */
function finishTextbook(s: Session, units: UnitPlan[]): void {
  const e = s.extract!
  const tb = e.textbook!
  const sheet = textbookToSheet(s.name, units)
  const warn: string[] = []
  if (tb.builtin) warn.push('这是软件内置的这一册教材目录，请对照手上的书核对单元和知识点')
  else if (tb.via === 'blocks') warn.push('没有找到目录，也没有认出单元标题，已按每几页一块整理，单元名是页码范围，请核对')
  else if (tb.via === 'heading') warn.push('没有找到目录页，单元是按正文里的单元标题切的，请核对有没有漏单元')
  const review = units.filter(u => unitNeedsReview(tb.results.get(u.id) ?? [])).length
  if (review) warn.push(`有 ${review} 个单元把握不高（没挑出知识点或都是推测），已标出，请重点核对`)
  s.read = { sheets: [sheet], warnings: [] }
  e.extraWarnings = warn.map(text => ({ kind: 'unverified' as const, sheet: sheet.name, row: 0, text }))
  e.done = true
}

export interface TextbookUnitView {
  id: number; title: string; pageStart: number; pageEnd: number; headings: string[]
  kps: Array<{ code: string; confidence: string; quote: string; reason: string }>
  needsReview: boolean
}
/** 核对界面用：每个单元的页码、小节标题和挑出的知识点 */
export function textbookUnitsOf(sessionId: string): { units: TextbookUnitView[]; via: UnitSource | null; builtin: boolean } {
  const tb = sessionOf(sessionId).extract?.textbook
  if (!tb?.units) throw new CourseFileError('这份教材还没有整理好')
  return { via: tb.via, builtin: !!tb.builtin, units: tb.units.map(u => { const kps = tb.results.get(u.id) ?? []; return { id: u.id, title: u.title, pageStart: u.pageStart, pageEnd: u.pageEnd, headings: u.headings, kps, needsReview: unitNeedsReview(kps) } }) }
}
/** 核对界面看原书：某一页的文字和缩略图 */
export async function textbookPageOf(sessionId: string, page: number): Promise<{ text: string; image: string | null }> {
  const tb = sessionOf(sessionId).extract?.textbook
  if (!tb) throw new CourseFileError('这不是教材')
  return textbookPagePreview(tb.plan, page)
}
/** 认出版本且软件里有这一册的目录：直接用内置的（单元和知识点来自内置目录，不再调用 AI） */
export function useBuiltinCatalog(sessionId: string): SuggestResult {
  const s = sessionOf(sessionId)
  const e = s.extract
  const tb = e?.textbook
  const prov = getCatalogProvider()
  const hit = tb ? editionOf(s)?.catalog : null
  if (!e || !tb || !prov || !hit) throw new CourseFileError('软件里没有这一册教材的内置目录')
  const valid = new Set(listKps(false, asSubject(s.subject)).map(k => k.code))
  const src = prov.units(hit.id)
  tb.units = src.map((u, i) => ({ id: i + 1, key: `catalog:${i + 1}`, title: u.title, pageStart: u.pageStart ?? 0, pageEnd: u.pageEnd ?? u.pageStart ?? 0, headings: [], opening: [], sourceLines: [u.title] }))
  tb.results = new Map(src.map((u, i): [number, UnitKp[]] => [i + 1, u.kps.filter(c => valid.has(c)).slice(0, 8).map(code => ({ code, confidence: 'high' as const, quote: '', reason: '软件内置的教材目录' }))]))
  tb.errors.clear(); tb.via = 'toc'; tb.builtin = true
  finishTextbook(s, tb.units)
  const sheet = s.read.sheets[0]
  return { items: { [sheet.name]: { mapping: TEXTBOOK_MAPPING, problems: [], source: 'ai' } }, model: '', source: sourceInfo(sessionId, s) }
}

async function suggestInner(sessionId: string, s: Session, mode: 'ai' | 'guess' | 'manual', signal: AbortSignal, onProgress?: SuggestProgress): Promise<SuggestResult> {
  if (s.extract) return organiseText(sessionId, s, signal, onProgress)
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  const items: Record<string, SuggestItem> = {}
  const todo = s.read.sheets.filter(sh => !sh.hidden)
  let finished = 0
  const aiOn = mode === 'ai' && aiReady()
  if (aiOn) onProgress?.(0, todo.length, '张表')
  // 各工作表并发认列（上限 4）；结果按表顺序写入，单张失败回退“按表头猜”，取消时所有在途调用一起中止
  const sub = childAbort(signal)
  const results = await mapLimit(todo, 4, async (sheet): Promise<SuggestItem> => {
    if (mode === 'manual') return { mapping: emptyMapping(), problems: [], source: 'manual' }
    if (mode === 'guess') {
      const g = guessMapping(sheet, s.subject)
      return { mapping: g ?? emptyMapping(), problems: g ? [] : ['按表头文字没能猜出课次或标题列，请手动选择'], source: 'guess' }
    }
    if (!aiReady()) return { mapping: guessMapping(sheet, s.subject) ?? emptyMapping(), problems: [], source: 'guess', error: '还没有配置 AI 服务，已按表头文字猜了一遍，请核对' }
    try {
      if (sub.signal.aborted) throw new AiError('aborted', '已取消')
      const user = fillTemplate(promptText('p5_course_cols', 'user', s.subject), { SHEET_NAME: sheet.name, SHEET_PREVIEW: sheetPreview(sheet) })
      const r = await jsonCall({ kind: 'course-cols', model, system: promptText('p5_course_cols', 'system', s.subject), user, signal: sub.signal })
      const p = parseColsResponse(r.content, sheet)
      if (p.ok && p.mapping) return { mapping: p.mapping, problems: p.problems, source: 'ai' }
      return { mapping: guessMapping(sheet, s.subject) ?? emptyMapping(), problems: p.problems, source: 'guess', error: 'AI 没能认出这张表的列，已按表头文字猜了一遍，请核对' }
    } catch (e) {
      if (e instanceof AiError && e.code === 'aborted') throw e
      const fr = friendlyAiError(e)
      return { mapping: guessMapping(sheet, s.subject) ?? emptyMapping(), problems: [], source: 'guess', error: `AI 整理没成功（${fr.message}），已按表头文字猜了一遍，请核对` }
    } finally {
      if (aiOn) onProgress?.(++finished, todo.length, '张表')
    }
  }).catch(err => { sub.abort(); throw err }).finally(() => sub.dispose())
  todo.forEach((sh, i) => { items[sh.name] = results[i] })
  return { items, model }
}

function checkLimits(levels: ParsedLevel[]): void {
  const total = levels.reduce((n, l) => n + l.lessons.length, 0)
  if (levels.length > MAX_LEVELS) throw new CourseFileError(`识别出的级别太多（${levels.length} 个，最多 ${MAX_LEVELS} 个）：请检查“级别”那一列是不是选错了`)
  if (total > MAX_LESSONS) throw new CourseFileError(`识别出的课太多（${total} 课，最多 ${MAX_LESSONS} 课）：请检查表头行数和列类型`)
}

/** 套用列映射并把整理结果留在主进程的读取会话里：之后的比对 / 保存只需要 sessionId + 映射，不用把整张课程表来回传 */
export function previewOutline(sessionId: string, mappings: Record<string, SheetMapping | null | undefined>) {
  const s = sessionOf(sessionId)
  const o = buildOutline(s.read.sheets, mappings)
  checkLimits(o.levels)
  if (s.extract?.extraWarnings.length) o.warnings.unshift(...s.extract.extraWarnings)
  s.parsed = o
  return o
}

/** 保存 / 比对用的课：界面改过格子就带着改过的 levels；没改过就用会话里的（按映射重新套用一遍，结果和预览一致） */
export function resolveLevels(sessionId: string | undefined, mappings: Record<string, SheetMapping | null | undefined>, edited?: ParsedLevel[]): { levels: ParsedLevel[]; warnings: ParsedOutline['warnings'] } {
  if (edited) { checkLimits(edited); return { levels: edited, warnings: sessionId && sessions.get(sessionId)?.parsed?.warnings || [] } }
  if (!sessionId) throw new CourseFileError('缺少课程表的读取记录，请重新选择文件')
  const o = buildOutline(sessionOf(sessionId).read.sheets, mappings)
  checkLimits(o.levels)
  const sess = sessionOf(sessionId)
  return { levels: o.levels.filter(l => l.lessons.length), warnings: [...(sess.extract?.extraWarnings ?? []), ...o.warnings] }
}

/** 向导第 2 步的列识别条：每个 sheet 的某一行套用后能识别多少课（预览用的快速校验） */
export function quickCount(sessionId: string, sheetName: string, m: SheetMapping): number {
  const s = sessionOf(sessionId)
  const sheet = s.read.sheets.find(x => x.name === sheetName)
  if (!sheet) return 0
  let n = 0
  for (const l of applyMapping(sheet, m).levels.values()) n += l.length
  return n
}

// ───────────────────────── 模板 / 示例 ─────────────────────────

export async function makeTemplate(kind: 'blank' | 'sample', subject?: unknown): Promise<Buffer> {
  if (kind === 'blank') return buildXlsx([{ name: '示例级别', rows: templateRows(subject) }])
  return buildXlsx(sampleSheets(subject))
}
export { TEMPLATE_HEADERS }

// ───────────────────────── 匹配 ─────────────────────────

export interface MatchProgress { outlineId: string; done: number; total: number; phase: 'running' | 'done' | 'cancelled' | 'error'; message?: string }
const matchJobs = new Map<string, { ctl: AbortController; progress: MatchProgress }>()
export const matchBusy = (outlineId?: string): boolean => (outlineId ? matchJobs.has(outlineId) : matchJobs.size > 0)
/** 后台整理队列（建在 ipc/course.ts）的钩子：让 busy.ts / 窗口关闭不必依赖 ipc 模块 */
let jobHooks = { busy: () => false, clear: () => { /* 未注册 */ } }
export const setJobHooks = (h: typeof jobHooks): void => { jobHooks = h }
export const courseJobsBusy = (): boolean => jobHooks.busy()
export const cancelCourseJobs = (): void => jobHooks.clear()
export const matchProgressOf = (outlineId: string): MatchProgress | null => matchJobs.get(outlineId)?.progress ?? null
export function cancelMatch(outlineId: string): boolean { const j = matchJobs.get(outlineId); if (!j) return false; j.ctl.abort(); return true }

/** 预计用量超过这个数（token）就必须先明确确认：界面弹确认，命令行要加 --yes */
export const MATCH_CONFIRM_TOKENS = 200_000

/** 预估规模（点「开始匹配」之前给用户看）：课数、知识点数、AI 请求数、预计 token。规则先认，只有认得不够的课才交给 AI */
export function estimateMatch(db: Db, outlineId: string, onlyNew: boolean) {
  const subject = outlineSubject(db, outlineId)
  const kps = pendingKps(db, outlineId, onlyNew)
  const pass = computeRulePass(db, outlineId, subject, kps, CATALOG)
  const need = new Set(pass.needAi)
  const lines = pass.lessons.filter(l => need.has(l.id)).map(l => outlineLine(l, subject))
  const chunks = aiAvailable() ? chunkLines(lines, AI_CHUNK_CHARS).filter(c => c.length) : []
  const kpChars = kpBatchBlock(kps).text.length
  const outlineChars = lines.reduce((n, l) => n + l.length + 1, 0)
  const promptTokens = Math.ceil((chunks.length * (kpChars + 1400) + outlineChars) / 1.6)
  const outTokens = need.size * 120
  const tokens = chunks.length ? promptTokens + outTokens : 0
  return { lessons: pass.lessons.length, kps: kps.length, batches: chunks.length, tokens, needsConfirm: tokens > MATCH_CONFIRM_TOKENS, ruleLessons: pass.lessons.length - need.size, aiLessons: need.size, aiAvailable: aiAvailable() }
}

/** 课程体系的学科：从体系自己的行读（不信传入值） */
function outlineSubject(db: Db, outlineId: string): SubjectId {
  return asSubject((db.prepare('SELECT subject FROM course_outlines WHERE id = ?').get(outlineId) as any)?.subject)
}

function pendingKps(db: Db, outlineId: string, onlyNew: boolean) {
  const all = targetKps(db, outlineSubject(db, outlineId))
  if (!onlyNew) return all
  const o = db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(outlineId) as any
  const done = new Map((db.prepare('SELECT kp_code, outline_rev, kp_sig FROM course_kp_check WHERE outline_id = ?').all(outlineId) as any[]).map(r => [r.kp_code, r]))
  return all.filter(k => { const d = done.get(k.code); return !d || d.outline_rev !== o?.rev || (d.kp_sig && d.kp_sig !== k.sig) })
}

export interface MatchResult { ok: boolean; cancelled?: boolean; code?: string; message?: string; detail?: string; done: number; total: number; matched: number; none: number; dropped: number; /** 程序直接认出（规则 / 教材桥）的匹配条数 */ byRule?: number; /** 交给 AI 补充的课数 */ aiLessons?: number; /** 没配 AI，只用了规则 */ aiSkipped?: boolean }

/** 每次问 AI 的课次行不超过这么多字 */
const AI_CHUNK_CHARS = 14000
const aiAvailable = (): boolean => aiReady()

/**
 * 运行匹配（以课找知识点）。onlyNew = 只补没检查过的知识点；否则整体重跑（锁定 / 确认 / 否决过的永远保留）。
 *  1. 程序先认：标志词规则 + 教材桥（不调用 AI，没配 AI 也能用），先落库；
 *  2. 规则认不出来、或认得不够（过线的不到 2 个）的课，才以课为单位问 AI 补充（每课最多 3 个主知识点），逐批落库，可取消，已完成的批次保留。
 */
export async function runMatch(db: Db, outlineId: string, opts: { onlyNew: boolean; onProgress?: (p: MatchProgress) => void }): Promise<MatchResult> {
  const fail = (code: string, message: string): MatchResult => ({ ok: false, code, message, done: 0, total: 0, matched: 0, none: 0, dropped: 0 })
  const o = db.prepare('SELECT id, rev, status FROM course_outlines WHERE id = ?').get(outlineId) as any
  if (!o) return fail('not_found', '找不到这个课程体系')
  if (matchJobs.has(outlineId)) return fail('busy', '这个课程体系正在匹配')
  const lessonsAll = lessonRows(db, [outlineId])
  if (!lessonsAll.length) return fail('empty', '这个课程体系里没有课')
  const kps = pendingKps(db, outlineId, opts.onlyNew)
  if (!kps.length) return fail('no_kps', opts.onlyNew ? '没有需要补匹配的知识点' : '库里还没有标过知识点的题目，没有可匹配的内容')
  const cfg = loadConfig()
  const model = cfg.model
  const subject = outlineSubject(db, outlineId)
  const version = promptVersionFor('p5_course_match', subject)
  const withAi = aiReady()
  const ctl = new AbortController()
  const progress: MatchProgress = { outlineId, done: 0, total: 1, phase: 'running' }
  matchJobs.set(outlineId, { ctl, progress })
  const emit = (p: Partial<MatchProgress>) => { Object.assign(progress, p); opts.onProgress?.({ ...progress }) }
  emit({})
  let matched = 0, none = 0, dropped = 0
  const t0 = Date.now()
  try {
    // ── 第 1 步：程序先认（规则 + 教材桥）──
    const pass = computeRulePass(db, outlineId, subject, kps, CATALOG)
    const w0 = applyRulePass(db, outlineId, pass, kps, { rev: o.rev, model: withAi ? model : 'rules', promptVersion: version })
    matched = w0.matched; none = w0.none
    const byRule = pass.candidates.length
    const need = new Set(pass.needAi)
    const needLines = pass.lessons.filter(l => need.has(l.id))
    const chunks = withAi ? chunkLines(needLines.map(l => outlineLine(l, subject)), AI_CHUNK_CHARS).filter(c => c.length) : []
    emit({ done: 1, total: 1 + chunks.length })
    if (chunks.length) {
      // ── 第 2 步：规则没认出来 / 认得不够的课，问 AI ──
      const system = promptText('p5_course_match', 'system', subject)
      const userTpl = promptText('p5_course_match', 'user', subject)
      const blk = kpBatchBlock(kps)
      const tokenOf = new Map([...blk.tokens].map(([t, c]) => [c, t]))
      const kpInfo = new Map(kps.map(k => [k.code, k]))
      const lessonText = new Map(needLines.map(l => [l.id, { searchText: l.searchText, quoteText: lessonQuoteText(l) }]))
      const ruleBy = new Map<number, typeof pass.candidates>()
      for (const c of pass.candidates) { if (!ruleBy.has(c.lessonId)) ruleBy.set(c.lessonId, []); ruleBy.get(c.lessonId)!.push(c) }
      // 每段的课次 id（chunkLines 按顺序切）
      let at = 0
      const chunkIds = chunks.map(c => { const ids = needLines.slice(at, at + c.length).map(l => l.id); at += c.length; return ids })
      const gate = createGate(4)
      let firstErr: unknown
      const ask = async (ids: number[], depth = 0): Promise<void> => {
        if (ctl.signal.aborted) throw new AiError('aborted', '已取消')
        const rows = needLines.filter(l => ids.includes(l.id))
        const lines = rows.map(l => {
          const known = (ruleBy.get(l.id) ?? []).map(c => tokenOf.get(c.code)).filter(Boolean)
          return outlineLine(l, subject) + (known.length ? ` | 已认出:${known.join(' ')}` : '')
        })
        const user = fillTemplate(userTpl, { OUTLINE_LINES: lines.join('\n'), KP_BATCH: blk.text })
        const sub = new Map([...lessonText].filter(([id]) => ids.includes(id)))
        let p = parseLessonResponse('', { tokens: blk.tokens, lessons: sub, kps: kpInfo, subject })
        for (let attempt = 1; attempt <= 2; attempt++) {
          let r
          try { r = await gate(() => jsonCall({ kind: 'course-match', model, system, user, signal: ctl.signal })) } catch (err) {
            if (err instanceof AiError && err.code === 'truncated' && !err.detail.includes(HIDDEN_THINKING) && ids.length > 1 && depth < 3) {
              const mid = Math.ceil(ids.length / 2)
              await ask(ids.slice(0, mid), depth + 1); await ask(ids.slice(mid), depth + 1)
              return
            }
            throw err
          }
          p = parseLessonResponse(r.content, { tokens: blk.tokens, lessons: sub, kps: kpInfo, subject })
          if (p.entries.length || !p.problems.length) break
          log.warn('course', '匹配回答解析失败', { attempt, problems: p.problems.slice(0, 3), chars: r.content.length })
        }
        if (!p.entries.length && p.problems.length) throw new AiError('bad_output', 'AI 的回答解析失败', null, `解析问题：${p.problems.slice(0, 3).join('；')}`)
        dropped += p.dropped
        // 规则 / 教材桥的候选和 AI 的合并后一起落库（只动这批课）
        const aiCands = p.entries.flatMap(e => e.maps)
        const merged = mergeCandidates([...pass.candidates.filter(c => ids.includes(c.lessonId)), ...aiCands])
        const w = applyLessonMatches(db, outlineId, ids, merged, { rev: o.rev, model, promptVersion: version, scopeKps: new Set(kps.map(k => k.code)), sigs: new Map(kps.map(k => [k.code, k.sig])) })
        matched = w.matched; none = w.none
      }
      try {
        await mapLimit(chunkIds, 3, async ids => {
          try { await ask(ids); emit({ done: progress.done + 1 }) } catch (err) { if (firstErr === undefined && !ctl.signal.aborted) firstErr = err; ctl.abort(); throw err }
        })
      } catch (err) { throw firstErr ?? err }
    }
    emit({ phase: 'done' })
    log.info('course', '匹配完成', { lessons: pass.lessons.length, kps: kps.length, byRule, aiLessons: need.size, aiCalls: chunks.length, matched, none, dropped, ms: Date.now() - t0 })
    return { ok: true, done: progress.done, total: progress.total, matched, none, dropped, byRule, aiLessons: withAi ? need.size : 0, aiSkipped: !withAi && need.size > 0 }
  } catch (e) {
    if (e instanceof AiError && e.code === 'aborted') { emit({ phase: 'cancelled' }); return { ok: false, cancelled: true, code: 'aborted', message: '已取消，已完成的部分已保留', done: progress.done, total: progress.total, matched, none, dropped } }
    const fr = friendlyAiError(e)
    emit({ phase: 'error', message: fr.message })
    return { ok: false, code: e instanceof AiError ? e.code : 'error', detail: fr.detail, message: `${fr.message}（程序认出的部分已保留；可以再点“继续匹配”）`, done: progress.done, total: progress.total, matched, none, dropped }
  } finally {
    setTimeout(() => matchJobs.delete(outlineId), 0)
  }
}

// ───────────────────────── 家长沟通话术（看板块 4） ─────────────────────────

export interface AdviceScope { filter: StatsFilter; outlineIds: string[] }
const scopeObject = (s: AdviceScope) => ({ kind: 'course_advice', filter: normalizeFilter(s.filter), outlines: [...s.outlineIds].sort() })

const aiConfigured = () => { const c = loadConfig(); return !!(c.base_url && c.model && getApiKey()) }
const GUIDE = '尚未配置 AI 服务（请联系管理员：设置 → 管理员设置 → AI 服务）'

export interface AdvicePrepared {
  /** 学科（取自筛选条件，缺省英语） */
  subject: SubjectId
  dash: CourseDashboard
  scene: CourseScene
  system: string
  user: string
  promptError: string | null
  promptVersion: string
  scopeKey: string
  cacheKey: string
  labels: Map<number, string>
  evidenceStatements: string[]
  eligible: number
}

/** kind = 'hint'：家长版结尾一句话（p5_course_hint，只放 1 个考点）；默认是老师版的话术（p5_course_advice） */
export function prepareAdvice(db: Db, scope: AdviceScope, kind: 'advice' | 'hint' = 'advice'): AdvicePrepared {
  const pid = kind === 'hint' ? 'p5_course_hint' : 'p5_course_advice'
  const subject = asSubject(scope.filter.subject)
  const dash = courseDashboard(db, scope.filter, scope.outlineIds)
  const sc = paperScope(scope.filter)
  const counts = scopeCounts(db, sc)
  const rows = courseRowsOf(dash)
  const infoRows = db.prepare(`SELECT code, plain, example_en, example_zh FROM kps WHERE code IN (${rows.length ? rows.map(() => '?').join(',') : "''"})`).all(...rows.map(r => r.code)) as any[]
  const info = new Map(infoRows.map(r => [r.code, { plain: r.plain ?? '', exampleEn: (subject === 'english' ? r.example_en : r.example_en || r.example_zh) ?? '', exampleZh: r.example_zh ?? '' }]))
  const withInfo = rows.map(r => ({ ...r, ...(info.get(r.code) ?? {}) }))
  const outline = dash.outlines[0]
  const scene = ((outline?.scene as CourseScene) ?? 'other')
  const sel = scope.filter.paperIds ? { selected: selectedCount(db, scope.filter) ?? scope.filter.paperIds.length, counted: counts.papers } : undefined
  const filterDesc = describeFilter(scope.filter, 0, undefined, undefined, sel)
  const warning = p3SampleWarning({ dist: { papers: counts.papers, coverage: { questions: 0, scored: 0, tagged: 0 } } as any, cmp: null, distinctGrades: 1, distinctExamTypes: 1 })
  const picked = [...withInfo].sort((a, b) => b.errorCount - a.errorCount || b.papers - a.papers).slice(0, 5)
  const evidence = collectEvidence(db, sc, { codes: picked.map(r => r.code) })
  const inp = (kind === 'hint' ? buildHintInputs : buildAdviceInputs)(withInfo, { scene, filterDesc, sampleWarning: warning, evidenceText: evidence.text })
  const system = promptText(pid, 'system', subject)
  const userTpl = promptText(pid, 'user', subject)
  let user = ''
  let promptError: string | null = null
  try { user = fillTemplate(userTpl, inp.placeholders) } catch (e) { promptError = (e as Error).message }
  // 体系内容改了（rev）、对应结果改了（用户文本里的课令牌和课名变了）、提示词变了、范围变了 → 缓存键变 → 已过期
  const revs = dash.outlines.map(o => `${o.id}:${(db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(o.id) as any)?.rev ?? 0}`).sort().join(',')
  const keys = cacheKeys(kind === 'hint' ? { ...scopeObject(scope), kind: 'course_hint' } : scopeObject(scope), system, `${user}\u0000${revs}`)
  return { subject, dash, scene, system, user, promptError, promptVersion: promptVersionFor(pid, subject), labels: inp.labels, evidenceStatements: evidence.statements, eligible: inp.used.length, ...keys }
}

export interface AdviceState {
  status: 'none' | 'fresh' | 'stale'
  scopeKey: string
  markdown: string
  warnings: string[]
  unverified: UnverifiedItem[]
  model: string | null
  createdAt: string | null
  confirmedAt: string | null
  staleReasons: Array<'data' | 'prompt' | 'model'>
  draft: { markdown: string; message: string; detail: string; createdAt: string } | null
  aiDraft: true
  blocked: string | null
  aiReady: boolean
  eligible: number
}

const parseJson = <T,>(s: string | null | undefined, f: T): T => { try { return s ? JSON.parse(s) : f } catch { return f } }

export function adviceState(db: Db, scope: AdviceScope): AdviceState {
  const p = prepareAdvice(db, scope)
  const ready = aiConfigured()
  const blocked = !p.dash.outlines.length ? '请先选择至少一个课程体系'
    : !p.dash.ready ? '课程体系还没有匹配完（先点上面的“开始匹配”）'
    : p.eligible === 0 ? '当前范围内没有“易错点 + 有对应课”的考点，写不出建议'
    : p.promptError ? `提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）`
    : !ready ? GUIDE : null
  const d = getDraft(p.scopeKey)
  const draft = d ? { markdown: d.markdown, message: d.message, detail: d.detail, createdAt: d.createdAt } : null
  const base = { scopeKey: p.scopeKey, aiDraft: true as const, blocked, aiReady: ready, draft, eligible: p.eligible }
  const row = db.prepare('SELECT * FROM course_advice WHERE scope_key = ?').get(p.scopeKey) as any
  if (!row) return { ...base, status: 'none', markdown: '', warnings: [], unverified: [], model: null, createdAt: null, confirmedAt: null, staleReasons: [] }
  const fresh = row.cache_key === p.cacheKey
  const reasons: Array<'data' | 'prompt' | 'model'> = []
  if (!fresh) reasons.push(row.prompt_version !== p.promptVersion ? 'prompt' : 'data')
  if (row.model && row.model !== loadConfig().model) reasons.push('model')
  return {
    ...base, status: fresh ? 'fresh' : 'stale', markdown: row.markdown ?? '', warnings: parseJson<string[]>(row.warnings_json, []), unverified: parseJson<UnverifiedItem[]>(row.verify_json, []),
    model: row.model, createdAt: row.created_at, confirmedAt: row.confirmed_at ?? null, staleReasons: reasons
  }
}

const inflight = new Map<string, AbortController>()
const busyScopes = new Set<string>()
export const adviceBusy = (): boolean => inflight.size > 0
/** 这个体系现在有没有匹配 / 话术任务在跑（替换、删除、导入数据包之前要确认没有） */
const adviceOutlines = new Map<string, string[]>()   // 请求号 → 它用到的体系
export const outlineBusy = (outlineId: string): boolean => matchJobs.has(outlineId) || [...adviceOutlines.values()].some(ids => ids.includes(outlineId))
export function cancelAdvice(requestId: string): boolean { const c = inflight.get(requestId); if (!c) return false; c.abort(); return true }

export interface AdviceResult { ok: boolean; cancelled?: boolean; code?: string; message?: string; detail?: string; partial?: string; markdown?: string; warnings?: string[]; unverified?: UnverifiedItem[] }

export async function generateAdvice(db: Db, scope: AdviceScope, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void): Promise<AdviceResult> {
  const p = prepareAdvice(db, scope)
  if (!p.dash.outlines.length) return { ok: false, code: 'no_outline', message: '请先选择至少一个课程体系' }
  if (!p.dash.ready) return { ok: false, code: 'not_matched', message: '课程体系还没有匹配完，先开始匹配' }
  if (p.eligible === 0) return { ok: false, code: 'no_data', message: '当前范围内没有“易错点 + 有对应课”的考点，写不出建议' }
  if (p.promptError) return { ok: false, code: 'bad_prompt', message: `提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）` }
  if (!aiConfigured()) return { ok: false, code: 'no_ai', message: `${GUIDE}，统计结果不受影响` }
  if (inflight.has(requestId)) return { ok: false, code: 'busy', message: '这个请求已经在生成' }
  if (busyScopes.has(p.scopeKey)) return { ok: false, code: 'busy', message: '这个范围的建议正在生成，请等它结束或先取消' }
  const cfg = loadConfig()
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  adviceOutlines.set(requestId, scope.outlineIds)
  busyScopes.add(p.scopeKey)
  const offGone = senderGone(() => ctl.abort())
  // 给家长的话没过滤之前不给用户看：流式的正文增量不转发，界面只显示“AI 正在写”，写完过滤后一次性显示
  const sendStream = (ev: ChunkEvent) => { if (ev.type !== 'delta') send(ev) }
  const stream = createStream({ cfg, system: p.system, user: p.user, requestId, send: sendStream, signal: ctl.signal })
  try {
    send({ id: requestId, type: 'start', scopeKey: p.scopeKey, refs: [] })
    const r = await stream.run()
    recordUsage({ paperId: null, kind: 'course-advice', model: r.model, usage: r.usage, ok: true })
    const cleaned = stripCodes(stripInternalCodes(fixBackticks(r.content), []))
    const fin = finishAdvice(cleaned, p.labels, { statements: p.evidenceStatements, subject: p.subject })
    const warnings = [...fin.warnings]
    if (r.fellBackTo) warnings.push(limitFallbackNotice(r.fellBackTo))
    if (!fin.ok) {
      const msg = fin.failReason ?? '内容不合格'
      saveDraft({ key: p.scopeKey, kind: 'course_advice', markdown: fin.text, refs: [], message: msg, detail: '', model: r.model })
      send({ id: requestId, type: 'error', code: 'too_short', message: msg, detail: '', partial: fin.text })
      return { ok: false, code: 'too_short', message: msg, partial: fin.text }
    }
    const unverified: UnverifiedItem[] = fin.findings.map(f => ({ sentence: f.sentence, kind: f.kind, reason: f.reason }))
    db.prepare(`INSERT OR REPLACE INTO course_advice (scope_key, cache_key, fingerprint, outline_ids_json, filter_json, markdown, warnings_json, verify_json, model, prompt_version, confirmed_at, subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(p.scopeKey, p.cacheKey, crypto.createHash('sha256').update(p.user).digest('hex'), JSON.stringify([...scope.outlineIds].sort()), JSON.stringify(normalizeFilter(scope.filter)),
      fin.text, JSON.stringify(warnings), JSON.stringify(unverified), r.model, p.promptVersion, p.subject)
    clearDraft(p.scopeKey)
    send({ id: requestId, type: 'done', markdown: fin.text, refs: [], warnings, unverified })
    return { ok: true, markdown: fin.text, warnings, unverified }
  } catch (e) {
    const partial = sanitizePartial(stream.partial(e), p.labels)   // 半截文字也要先过滤，不能把没过滤的原文给用户看
    stream.dispose()
    if (e instanceof AiError && e.code === 'aborted') { send({ id: requestId, type: 'cancelled', partial }); return { ok: false, cancelled: true, code: 'aborted', message: '已取消', partial } }
    const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
    recordUsage({ paperId: null, kind: 'course-advice', model: cfg.model, ok: false })
    const fr = friendlyAiError(err)
    saveDraft({ key: p.scopeKey, kind: 'course_advice', markdown: partial, refs: [], message: fr.message, detail: fr.detail, model: cfg.model })
    send({ id: requestId, type: 'error', code: err.code, message: fr.message, detail: fr.detail, partial })
    return { ok: false, code: err.code, message: fr.message, detail: fr.detail, partial }
  } finally {
    stream.dispose(); offGone(); inflight.delete(requestId); adviceOutlines.delete(requestId); busyScopes.delete(p.scopeKey)
  }
}

/** 「我已核对」：矛盾的句子必须重新生成；「未核实」的句子要逐句确认（acknowledged）才能放行。复制 / 家长相关用途都以此为门槛 */
export function confirmAdvice(db: Db, scopeKey: string, acknowledged: string[]): { ok: boolean; message?: string } {
  const row = db.prepare('SELECT * FROM course_advice WHERE scope_key = ?').get(scopeKey) as any
  if (!row) return { ok: false, message: '还没有生成过建议' }
  const items = parseJson<UnverifiedItem[]>(row.verify_json, [])
  if (items.some(i => i.kind === 'conflict')) return { ok: false, message: '有一句话和老师审核过的题目解释矛盾，不能核对通过，请重新生成' }
  const ack = new Set(acknowledged)
  const left = items.filter(i => !ack.has(i.sentence))
  if (left.length) return { ok: false, message: `还有 ${left.length} 句“未核实”的话没有确认，请逐句确认无误后再点“我已核对”` }
  const marked = items.map(i => ({ ...i, acknowledged: true }))
  db.prepare("UPDATE course_advice SET confirmed_at = datetime('now','localtime'), verify_json = ? WHERE scope_key = ?").run(JSON.stringify(marked), scopeKey)
  return { ok: true }
}

/** 复制到剪贴板：没点“我已核对”不给复制；过期的结果也不给（和现在的数据对不上了） */
export function copyAdvice(db: Db, scope: AdviceScope): { text: string; chars: number } {
  const st = adviceState(db, scope)
  if (st.status === 'none') throw new Error('还没有生成过建议')
  if (st.status === 'stale') throw new Error('这份建议已经过期（数据或课程有变化），请重新生成并核对后再复制')
  if (!st.confirmedAt) throw new Error('请先点“我已核对”，确认这段话没问题再复制')
  const text = stripMarks(st.markdown).trim()
  clipboard.writeText(text)
  return { text, chars: text.length }
}
