/**
 * 看板抽屉里的 AI 分析：只讲「这一个考点」（M6 验收返工 R5-1）。
 * 以前抽屉里的 AI 分析是整篇年度分析的一小节——老师点一个考点，等 111 秒，得到一句「完整分析里没有单独讨论这个考点」。
 * 现在提示词（p2_kp）和证据只放这一个考点：输入小、输出 ≤ 250 字，一次调用很快；结果按「筛选 + 考点（+ 今年 / 去年及以前）」缓存，数据或提示词变了标「已过期」，不自动重算。
 */
import crypto from 'node:crypto'
import { getDb } from '../db'
import { AiError } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { createStream } from '../ai/stream'
import { friendlyAiError, limitFallbackNotice } from '../ai/friendly'
import type { ChunkEvent, UnverifiedItem } from '../ai/chunk'
import { clearDraft, getDraft, saveDraft } from '../ai/drafts'
import type { Draft } from '../ai/drafts'
import { promptText, promptVersionFor } from '../ai/prompts'
import { notifyDataChanged } from '../events'
import { stripUnknownCitations } from '../../shared/citation'
import type { CitationRef } from '../../shared/citation'
import { checkRules, markFindings } from '../../shared/factcheck'
import { fixBackticks, stripInternalCodes } from '../../shared/report-post'
import { safeKpName, stripCodes } from '../../shared/code-guard'
import { nodeStats, questionsOfKp, scopeCounts, sideScopes } from './core'
import { paperScope, yearLabel } from './filter'
import type { StatsFilter } from './filter'
import { collectEvidence } from './evidence'
import { TokenRegistry, cacheKeys, describeFilter, fillTemplate, normalizeFilter, templateSig } from './p2'
import { p3SampleWarning } from './p3'

export interface KpScope {
  filter: StatsFilter
  code: string
  /** 从同比页打开时带上今年 / 去年及以前（数据里多写两侧各几份）；没有就只讲筛选范围内的情况 */
  target?: number | null
  base?: { eq: number } | { lt: number } | null
  align?: boolean
}

const scopeObject = (s: KpScope) => ({ kind: 'p2_kp', filter: normalizeFilter(s.filter), code: s.code, target: s.target ?? null, base: s.base ?? null, align: s.align ?? true })

export interface KpPrepared {
  system: string
  user: string
  refs: CitationRef[]
  evidenceStatements: string[]
  promptError: string | null
  promptVersion: string
  templateSig: string
  scopeKey: string
  cacheKey: string
  empty: boolean
  name: string
}

export function prepareKp(scope: KpScope): KpPrepared {
  const db = getDb()
  const sc = paperScope(scope.filter)
  const counts = scopeCounts(db, sc)
  const node = nodeStats(db, sc).find(n => n.code === scope.code)
  const name = safeKpName(node?.name ?? (db.prepare('SELECT name FROM kps WHERE code = ?').get(scope.code) as any)?.name)
  const lines: string[] = []
  if (node) {
    const share = counts.totalScore > 0 ? `${Math.round((node.score / counts.totalScore) * 1000) / 10}%` : '—'
    lines.push(`这几份卷子里：${node.papers}/${counts.papers} 份卷子考了，共 ${node.questions} 道题，占总分 ${share}；AI 估计容易错的题 ${node.errorCount} 道。`)
  } else lines.push(`这几份卷子里：0/${counts.papers} 份卷子考了。`)
  if (scope.target != null && scope.base) {
    const { sT, sB, baseYears } = sideScopes(db, scope.filter, scope.target, scope.base, scope.align ?? true)
    const cT = scopeCounts(db, sT), cB = scopeCounts(db, sB)
    const aT = nodeStats(db, sT).find(n => n.code === scope.code)?.papers ?? 0
    const aB = nodeStats(db, sB).find(n => n.code === scope.code)?.papers ?? 0
    lines.push(`今年（${yearLabel(scope.target)}）：${aT}/${cT.papers} 份卷子考了；去年及以前（${baseYears.map(yearLabel).join('、') || '无'}）：${aB}/${cB.papers} 份卷子考了。`)
  }
  const cards = questionsOfKp(db, sc, scope.code, 12)
  const pick = [...cards.filter(c => c.error_prone), ...cards.filter(c => !c.error_prone)].slice(0, 2)
  const reg = new TokenRegistry()
  const samples = pick.length ? reg.sampleCell(pick, 2).split('；').join('\n') : '（无）'
  const years = (db.prepare(`SELECT DISTINCT p.school_year_start y FROM papers p WHERE ${sc.where} AND p.school_year_start IS NOT NULL ORDER BY y`).all(...sc.params) as any[]).map(r => yearLabel(r.y)).join('、') || '（未填写学年）'
  const warning = p3SampleWarning({ dist: { papers: counts.papers, coverage: { questions: 0, scored: 0, tagged: 0 } } as any, cmp: null, distinctGrades: 1, distinctExamTypes: 1 })
  const evidence = collectEvidence(db, sc, { codes: [scope.code] })
  const system = promptText('p2_kp', 'system')
  const userTpl = promptText('p2_kp', 'user')
  let user = ''
  let promptError: string | null = null
  try {
    user = fillTemplate(userTpl, {
      FILTER_DESC: describeFilter(scope.filter, 0), PAPER_COUNT: String(counts.papers), YEARS: years, SAMPLE_WARNING: warning,
      KP_NAME: name, KP_DATA: lines.join('\n'), KP_SAMPLES: samples, EVIDENCE: evidence.text
    })
  } catch (e) { promptError = (e as Error).message }
  const keys = cacheKeys(scopeObject(scope), system, user)
  return { system, user, refs: [...reg.refs.values()], evidenceStatements: evidence.statements, promptError, promptVersion: promptVersionFor('p2_kp'), templateSig: templateSig(system, userTpl), empty: counts.papers === 0, name, ...keys }
}

export interface KpAnalysisState {
  status: 'none' | 'fresh' | 'stale'
  /** 这个考点的白话名称（不带代码），抽屉标题用 */
  name: string
  markdown: string
  refs: CitationRef[]
  model: string | null
  createdAt: string | null
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  unverified: UnverifiedItem[]
  draft: Pick<Draft, 'markdown' | 'refs' | 'message' | 'detail' | 'createdAt'> | null
  aiDraft: true
  blocked: string | null
  aiReady: boolean
}

const aiConfigured = () => { const c = loadConfig(); return !!(c.base_url && c.model && getApiKey()) }
const GUIDE = '尚未配置 AI 服务（请联系管理员：设置 → 管理员设置 → AI 服务）'

export function kpAnalysisState(scope: KpScope): KpAnalysisState {
  const db = getDb()
  const p = prepareKp(scope)
  const ready = aiConfigured()
  const blocked = p.empty ? '当前筛选下没有计入统计的试卷' : p.promptError ? `提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）` : !ready ? GUIDE : null
  const d = getDraft(p.scopeKey)
  const draft = d ? { markdown: d.markdown, refs: d.refs, message: d.message, detail: d.detail, createdAt: d.createdAt } : null
  const row = db.prepare('SELECT * FROM ai_analyses WHERE scope_key = ?').get(p.scopeKey) as any
  const base = { name: p.name, aiDraft: true as const, blocked, aiReady: ready, draft }
  if (!row) return { ...base, status: 'none', markdown: '', refs: [], model: null, createdAt: null, staleReasons: [], warnings: [], unverified: [] }
  const reasons: Array<'data' | 'prompt' | 'model'> = []
  const fresh = row.cache_key === p.cacheKey
  if (!fresh) { if (row.template_sig !== p.templateSig) reasons.push('prompt'); else reasons.push('data') }
  if (row.model && row.model !== loadConfig().model) reasons.push('model')
  const parse = <T,>(s: string | null, f: T): T => { try { return s ? JSON.parse(s) : f } catch { return f } }
  return { ...base, status: fresh ? 'fresh' : 'stale', markdown: fixBackticks(row.markdown), refs: parse<CitationRef[]>(row.refs_json, []), model: row.model, createdAt: row.created_at, staleReasons: reasons, warnings: parse<string[]>(row.warnings_json, []), unverified: parse<UnverifiedItem[]>(row.verify_json, []) }
}

const inflight = new Map<string, AbortController>()
const busy = new Set<string>()
export const kpAnalysisBusy = (): boolean => inflight.size > 0
export function cancelKpAnalysis(requestId: string): boolean { const c = inflight.get(requestId); if (!c) return false; c.abort(); return true }

export interface KpGenerateResult { ok: boolean; cancelled?: boolean; code?: string; message?: string; detail?: string; partial?: string; markdown?: string; refs?: CitationRef[]; warnings?: string[]; unverified?: UnverifiedItem[] }

export async function generateKpAnalysis(scope: KpScope, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void): Promise<KpGenerateResult> {
  const p = prepareKp(scope)
  if (p.empty) return { ok: false, code: 'no_data', message: '当前筛选下没有计入统计的试卷，无法分析' }
  if (p.promptError) return { ok: false, code: 'bad_prompt', message: `提示词有问题：${p.promptError}（请联系管理员：设置 → 管理员设置 → 提示词）` }
  if (!aiConfigured()) return { ok: false, code: 'no_ai', message: `${GUIDE}，统计结果不受影响` }
  if (inflight.has(requestId)) return { ok: false, code: 'busy', message: '这个请求已经在生成' }
  if (busy.has(p.scopeKey)) return { ok: false, code: 'busy', message: '这个考点的分析正在生成，请等它结束或先取消' }
  const cfg = loadConfig()
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  busy.add(p.scopeKey)
  const offGone = senderGone(() => ctl.abort())
  const stream = createStream({ cfg, system: p.system, user: p.user, requestId, send, signal: ctl.signal })
  try {
    send({ id: requestId, type: 'start', scopeKey: p.scopeKey, refs: p.refs })
    const r = await stream.run()
    recordUsage({ paperId: null, kind: 'p2_kp', model: r.model, usage: r.usage, ok: true })
    const known = new Set(p.refs.map(x => x.token))
    const { text: cited, removed } = stripUnknownCitations(stripInternalCodes(fixBackticks(r.content), []), known)
    const warnings: string[] = []
    if (r.fellBackTo) warnings.push(limitFallbackNotice(r.fellBackTo))
    if (removed.length) warnings.push(`已移除 ${removed.length} 处无法核对的引用`)
    // 四行都写成列表项（模型有时漏写「- 」，Markdown 里四行就并成一段了）
    const clean = stripCodes(cited).split('\n').map(l => (/^\*\*[^*]+\*\*/.test(l.trim()) ? `- ${l.trim()}` : l)).join('\n')
    const findings = checkRules(clean, p.evidenceStatements)
    const text = markFindings(clean, findings).text
    const unverified: UnverifiedItem[] = findings.map(f => ({ sentence: f.sentence, kind: f.kind, reason: f.reason }))
    const used = p.refs.filter(x => text.includes(x.token))
    getDb().prepare(`INSERT OR REPLACE INTO ai_analyses (scope_key, kind, cache_key, prompt_version, fingerprint, scope_json, markdown, refs_json, warnings_json, model, usage_json,
        template_sig, checked_rev, checked_sig, checked_json, verify_json) VALUES (?, 'p2_kp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
      .run(p.scopeKey, p.cacheKey, p.promptVersion, crypto.createHash('sha256').update(p.user).digest('hex'), JSON.stringify(scopeObject(scope)), text, JSON.stringify(used), JSON.stringify(warnings), r.model, JSON.stringify(r.usage), p.templateSig, JSON.stringify(unverified))
    clearDraft(p.scopeKey)
    notifyDataChanged('analysis')
    send({ id: requestId, type: 'done', markdown: text, refs: used, warnings, unverified })
    return { ok: true, markdown: text, refs: used, warnings, unverified }
  } catch (e) {
    const partial = stream.partial(e)
    stream.dispose()
    if (e instanceof AiError && e.code === 'aborted') { send({ id: requestId, type: 'cancelled', partial }); return { ok: false, cancelled: true, code: 'aborted', message: '已取消', partial } }
    const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
    recordUsage({ paperId: null, kind: 'p2_kp', model: cfg.model, ok: false })
    const fr = friendlyAiError(err)
    saveDraft({ key: p.scopeKey, kind: 'p2_kp', markdown: stripUnknownCitations(fixBackticks(partial), new Set(p.refs.map(x => x.token))).text, refs: p.refs, message: fr.message, detail: fr.detail, model: cfg.model })
    notifyDataChanged('analysis')
    send({ id: requestId, type: 'error', code: err.code, message: fr.message, detail: fr.detail, partial })
    return { ok: false, code: err.code, message: fr.message, detail: fr.detail, partial }
  } finally {
    stream.dispose(); offGone(); inflight.delete(requestId); busy.delete(p.scopeKey)
  }
}
