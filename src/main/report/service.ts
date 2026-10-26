/**
 * P3 考情分析报告：按当前全局筛选取本地统计 → 填占位符 → 流式调用模型 → 校验引用 → 存库（reports 表，每次生成一条，保留历史）。
 * 模型不算数：所有数字、样本题、引用 token 都是程序先算好填进提示词的。
 *
 * 过期：每条报告记着生成时「实际发给模型的提示词文本」的缓存键、数据指纹、提示词模板签名，以及上次核对时的数据修订号。
 * 数据（试卷 / 题目 / 知识点树）或提示词变了 → 状态变成 stale，界面写「已过期」，**绝不自动重新生成**（要花钱）。
 * 失败、取消、空内容、断流的处理与 P2 一致（同一个 chat()：重试、超时、干净 EOF 判定都在那里）。
 */
import { net } from 'electron'
import crypto from 'node:crypto'
import { getDb } from '../db'
import { chat, AiError } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { promptText, promptVersionFor, PROMPT_DEFAULT_VERSION } from '../ai/prompts'
import { notifyDataChanged } from '../events'
import { stripUnknownCitations } from '../../shared/citation'
import type { CitationRef } from '../../shared/citation'
import { paperScope } from '../stats/filter'
import type { StatsFilter } from '../stats/filter'
import { cacheKeys, fillTemplate, normalizeFilter, reusableCheck, templateSig, describeFilter } from '../stats/p2'
import type { CheckRecord } from '../stats/p2'
import { buildP3Input, ensureSampleWarning, hasFinalSection } from '../stats/p3'
import { collectP3Source } from '../stats/p3-collect'
import type { P3Input } from '../stats/p3'
import type { ChunkEvent, GenerateResult } from '../stats/analysis'

const KIND = 'report'
const MAX_HISTORY = 100

export interface PreparedReport {
  input: P3Input
  system: string
  user: string
  promptError: string | null
  promptVersion: string
  templateSig: string
  cacheKey: string
  rev: number
  desc: string
}

const currentRev = (): number => (getDb().prepare('SELECT rev FROM data_rev WHERE id = 1').get() as any)?.rev ?? 0
const currentTemplateSig = () => templateSig(promptText('p3_report', 'system'), promptText('p3_report', 'user'))

/** 取统计、填占位符。复用 M3 的统计函数（去重、学期对齐、主次知识点的口径都在那里），这里不重新算任何东西 */
export function prepareReport(filter: StatsFilter): PreparedReport {
  const db = getDb()
  const rev = currentRev()
  const input = buildP3Input(collectP3Source(db, filter))
  const system = promptText('p3_report', 'system')
  const userTpl = promptText('p3_report', 'user')
  let user = ''
  let promptError: string | null = null
  try { user = fillTemplate(userTpl, input.placeholders) } catch (e) { promptError = (e as Error).message }
  const keys = cacheKeys({ kind: KIND, filter: normalizeFilter(filter) }, system, user)
  return { input, system, user, promptError, promptVersion: promptVersionFor('p3_report'), templateSig: templateSig(system, userTpl), cacheKey: keys.cacheKey, rev, desc: describeFilter(filter, 0) }
}

// ───────────────────────── 读：列表 / 单条 ─────────────────────────

export interface ReportItem {
  id: string
  title: string
  createdAt: string
  model: string | null
  filter: StatsFilter
  filterDesc: string
  status: 'fresh' | 'stale'
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  sampleWarning: string | null
  promptVersion: string | null
  chars: number
}

export interface ReportDetail extends ReportItem {
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
}

const parseJson = <T,>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb } catch { return fb } }
const parseFilter = (s: string | null): StatsFilter => parseJson<StatsFilter>(s, {})

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
  const sig = currentTemplateSig()
  const hit = reusableCheck(row, rev, sig)
  if (hit) return hit
  const key = row.filter_json ?? '{}'
  let p = memo.get(key)
  if (!p) { p = prepareReport(parseFilter(row.filter_json)); memo.set(key, p) }
  const reasons: Array<'data' | 'prompt'> = []
  if (row.template_sig !== p.templateSig) reasons.push('prompt')
  if (row.fingerprint !== p.input.fingerprint) reasons.push('data')
  const chk: CheckRecord = { fresh: row.cache_key === p.cacheKey, reasons, promptError: p.promptError, empty: p.input.empty }
  getDb().prepare('UPDATE reports SET checked_rev = ?, checked_sig = ?, checked_json = ? WHERE id = ?').run(p.rev, p.templateSig, JSON.stringify(chk), row.id)
  return chk
}

function itemOf(row: any, memo: Map<string, PreparedReport>): ReportItem {
  const chk = checkRow(row, memo)
  const modelChanged = !!row.model && row.model !== loadConfig().model
  const filter = parseFilter(row.filter_json)
  const reasons: Array<'data' | 'prompt' | 'model'> = chk.fresh ? [] : [...chk.reasons]
  if (modelChanged) reasons.push('model')
  return {
    id: row.id, title: row.title || `${describeFilter(filter, 0)} · 考情分析报告`, createdAt: row.created_at, model: row.model, filter, filterDesc: describeFilter(filter, 0),
    status: chk.fresh ? 'fresh' : 'stale', staleReasons: reasons, warnings: parseJson<string[]>(row.warnings_json, []), sampleWarning: row.sample_warning || null,
    promptVersion: row.prompt_version, chars: (row.markdown ?? '').length
  }
}

export function listReports(): ReportItem[] {
  const memo = new Map<string, PreparedReport>()
  const rows = getDb().prepare(`SELECT * FROM reports WHERE kind = ? ORDER BY created_at DESC, rowid DESC`).all(KIND) as any[]
  return rows.map(r => itemOf(r, memo))
}

export function getReport(id: string): ReportDetail | null {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ? AND kind = ?').get(id, KIND) as any
  if (!row) return null
  return { ...itemOf(row, new Map()), markdown: row.markdown ?? '', refs: refreshRefs(parseJson<CitationRef[]>(row.refs_json, [])) }
}

export function deleteReport(id: string): boolean {
  const r = getDb().prepare('DELETE FROM reports WHERE id = ? AND kind = ?').run(id, KIND)
  if (r.changes > 0) notifyDataChanged('reports')
  return r.changes > 0
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
}

const aiConfigured = () => { const c = loadConfig(); return !!(c.base_url && c.model && getApiKey()) }
const GUIDE = '尚未配置 AI 服务（设置 → AI 服务）。统计和看板不受影响'

export function previewReport(filter: StatsFilter): ReportPreview {
  // 只数试卷和题目就够了，不必构造整套输入（那要几百毫秒）
  const db = getDb()
  const sc = paperScope(filter)
  const papers = (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const questions = (db.prepare(`SELECT COUNT(*) c FROM papers p CROSS JOIN questions q ON q.paper_id = p.id WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const ready = aiConfigured()
  let promptError: string | null = null
  try { fillTemplate(promptText('p3_report', 'user'), Object.fromEntries(['FILTER_DESC', 'PAPER_COUNT', 'QUESTION_COUNT', 'YEARS', 'SAMPLE_WARNING', 'KP_DIST', 'QTYPE_DIST', 'DIFF_DIST', 'ERROR_PRONE', 'YEAR_DIFF'].map(k => [k, '']))) } catch (e) { promptError = (e as Error).message }
  const blocked = papers === 0 ? '当前筛选下没有计入统计的试卷（只统计已确认的试卷；可以先在审核页确认，或在筛选栏打开「含待审核」）'
    : promptError ? `P3 提示词有问题：${promptError}（请到设置 → 提示词修正或恢复默认）`
    : !ready ? GUIDE : null
  return { filterDesc: describeFilter(filter, 0), papers, questions, blocked, aiReady: ready, busy: inflight.size > 0 }
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

const FRIENDLY: Record<string, string> = {
  empty: '模型返回了空内容（已自动重试一次仍为空）。可以稍后重新生成，或换一个模型',
  truncated: '报告被输出长度上限截断，可以在设置 → AI 服务 → 高级里调大「输出上限」后重新生成'
}

/** @param send 把事件发给发起请求的那个窗口（调用方传 event.sender.send），不广播 */
export async function generateReport(filter: StatsFilter, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void): Promise<GenerateResult & { reportId?: string }> {
  const p = prepareReport(filter)
  if (p.input.empty) return { ok: false, code: 'no_data', message: '当前筛选下没有计入统计的试卷，无法生成报告' }
  if (p.promptError) return { ok: false, code: 'bad_prompt', message: `P3 提示词有问题：${p.promptError}（请到设置 → 提示词修正或恢复默认）` }
  if (!aiConfigured()) return { ok: false, code: 'no_ai', message: '尚未配置 AI 服务（设置 → AI 服务），统计结果不受影响' }
  if (inflight.has(requestId)) return { ok: false, code: 'busy', message: '这个请求已经在生成' }
  if (inflight.size > 0) return { ok: false, code: 'busy', message: '已经有一份报告正在生成，请等它结束或先取消' }

  const cfg = loadConfig()
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  const offGone = senderGone(() => ctl.abort())

  let buf = ''
  let lastPartial = ''
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => { timer = null; if (pending) { send({ id: requestId, type: 'delta', text: pending }); pending = '' } }
  try {
    send({ id: requestId, type: 'start', scopeKey: 'report', refs: p.input.refs })
    const r = await chat({
      baseUrl: cfg.base_url, apiKey: getApiKey()!, model: cfg.model, stream: true, temperature: 0.3, maxTokens: cfg.max_tokens,
      messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
      timeoutMs: cfg.timeout_sec * 1000, maxRetries: 2, backoffMs: 1000, signal: ctl.signal, fetchImpl: net.fetch as unknown as typeof fetch,
      onDelta: (t) => { buf += t; pending += t; if (!timer) timer = setTimeout(flush, 40) },
      onAttempt: (a) => {
        if (a.ok) return
        if (timer) clearTimeout(timer)
        timer = null; pending = ''
        if (buf) lastPartial = buf
        buf = ''
        if (a.error?.code !== 'aborted') send({ id: requestId, type: 'reset' })
      }
    })
    if (timer) clearTimeout(timer)
    flush()
    recordUsage({ paperId: null, kind: 'p3_report', model: r.model, usage: r.usage, ok: true })

    // 校验：引用必须来自我们给的索引（不在索引里的整条删掉）；样本提示由程序判定，保证一定写在开头
    const known = new Set(p.input.refs.map(x => x.token))
    const stripped = stripUnknownCitations(r.content, known)
    const warnings: string[] = []
    if (stripped.removed.length) warnings.push(`已移除 ${stripped.removed.length} 处无法核对的引用（模型写出了输入里没有的试卷或题号）`)
    const warn = p.input.placeholders.SAMPLE_WARNING
    const ens = ensureSampleWarning(stripped.text, warn)
    if (ens.inserted) warnings.push('模型没有转述样本提示，已由程序补在报告开头')
    const text = ens.text
    if (promptVersionFor('p3_report') === PROMPT_DEFAULT_VERSION && !hasFinalSection(text)) warnings.push('输出里没有最后一节「教学建议」，内容可能不完整，建议重新生成')
    const used = p.input.refs.filter(x => text.includes(x.token))

    const db = getDb()
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown, model, title, refs_json, warnings_json, sample_warning, fingerprint, cache_key, template_sig, prompt_version, usage_json,
        checked_rev, checked_sig, checked_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, KIND, JSON.stringify(normalizeFilter(filter)), text, r.model, `${p.desc} · 考情分析报告`, JSON.stringify(used), JSON.stringify(warnings), warn === '无' ? null : warn, p.input.fingerprint, p.cacheKey, p.templateSig,
        p.promptVersion, JSON.stringify(r.usage), p.rev, p.templateSig, JSON.stringify({ fresh: true, reasons: [], promptError: null, empty: false }))
    // 历史最多留 MAX_HISTORY 条
    db.prepare(`DELETE FROM reports WHERE kind = ? AND id NOT IN (SELECT id FROM reports WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(KIND, KIND, MAX_HISTORY)
    notifyDataChanged('reports')
    send({ id: requestId, type: 'done', markdown: text, refs: used, warnings, reportId: id })
    return { ok: true, markdown: text, refs: used, warnings, reportId: id }
  } catch (e) {
    if (timer) clearTimeout(timer)
    const partial = buf || lastPartial
    if (e instanceof AiError && e.code === 'aborted') {
      send({ id: requestId, type: 'cancelled', partial })
      return { ok: false, cancelled: true, code: 'aborted', message: '已取消', partial }
    }
    const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
    recordUsage({ paperId: null, kind: 'p3_report', model: cfg.model, ok: false })
    const message = FRIENDLY[err.code] ?? err.message
    send({ id: requestId, type: 'error', code: err.code, message, partial })
    return { ok: false, code: err.code, message, partial }
  } finally {
    offGone()
    inflight.delete(requestId)
  }
}
