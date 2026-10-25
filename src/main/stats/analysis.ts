/**
 * P2 年度变化分析：本地统计 → 填占位符 → 流式调用模型 → 校验引用 → 存库缓存。
 * 模型不算数：所有数字、样本题、引用 token 都是程序先算好填进提示词的。
 *
 * 缓存：每个「同比范围」（筛选条件 + 目标 + 基线 + 层级）一行（ai_analyses），记录当时的提示词版本和数据指纹。
 * 数据或提示词变了 → 状态变成 stale（界面写「已过期，可重新生成」），绝不自动重算。
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
import { headingCodes } from '../../shared/markdown'
import { compare, hot, sideScopes } from './core'
import type { CompareResult } from './core'
import { paperScope } from './filter'
import type { StatsFilter } from './filter'
import { buildP2Input, cacheKeys, fillTemplate, normalizeFilter, reusableCheck, templateSig } from './p2'
import type { CheckRecord } from './p2'
import type { P2Input } from './p2'

export interface AnalysisScope {
  /** 注意：同比自己决定学年，这里的 filter 里不应有 school_year_start（ipc 层会剔除），否则范围键会无故变化 */
  filter: StatsFilter
  target: number
  base: { eq: number } | { lt: number }
  level: number
  /** 是否按学期对齐（基线只取目标学年出现过的学期），默认 true */
  align: boolean
}

/** 范围键只由「实际生效的筛选 + 目标 + 基线 + 层级 + 是否按学期对齐」决定，和数据、提示词无关 */
const scopeObject = (s: AnalysisScope) => ({ filter: normalizeFilter(s.filter), target: s.target, base: s.base, level: s.level, align: s.align })

export interface Prepared {
  cmp: CompareResult
  input: P2Input
  system: string
  user: string
  /** 提示词被改坏（有填不了的占位符）时的说明；此时不能生成，但统计与缓存状态照常显示 */
  promptError: string | null
  /** 展示用的提示词版本标签（内置版本号或「自定义·哈希」）；缓存是否有效不看它，看实际文本 */
  promptVersion: string
  templateSig: string
  scopeKey: string
  cacheKey: string
  /** 开始计算时的数据修订号（之后数据再变，下次读状态时会重新核对） */
  rev: number
}

const currentRev = (): number => (getDb().prepare('SELECT rev FROM data_rev WHERE id = 1').get() as any)?.rev ?? 0

/** 当前 P2 提示词模板（system + user，未填数据）的签名。提示词在设置里改了、或程序升级换了内置模板，它就变 */
const currentTemplateSig = () => templateSig(promptText('p2_yoy', 'system'), promptText('p2_yoy', 'user'))

export function prepare(scope: AnalysisScope): Prepared {
  const db = getDb()
  const rev = currentRev()
  const cmp = compare(db, scope.filter, scope.target, scope.base, scope.level, 3, scope.align)
  // 跨年高频考点：目标 + 基线合起来的试卷里统计（按学期对齐时同样只取目标学年出现过的学期）
  const both = paperScope(scope.filter, { in: [scope.target, ...cmp.base.years] }, undefined, cmp.align.on ? cmp.align.targetSemesters.map(x => x.key) : null)
  const hotRes = hot(db, scope.filter, scope.level, 15, both, false)   // P2 用不到「标在更高层级的题」，省一次查询
  const input = buildP2Input(cmp, hotRes, scope.filter)
  const system = promptText('p2_yoy', 'system')
  const userTpl = promptText('p2_yoy', 'user')
  let user = ''
  let promptError: string | null = null
  try { user = fillTemplate(userTpl, input.placeholders) } catch (e) { promptError = (e as Error).message }
  const keys = cacheKeys(scopeObject(scope), system, user)
  return { cmp, input, system, user, promptError, promptVersion: promptVersionFor('p2_yoy'), templateSig: templateSig(system, userTpl), rev, ...keys }
}

export interface AnalysisState {
  status: 'none' | 'fresh' | 'stale'
  markdown: string
  refs: Array<CitationRef & { missing?: boolean }>
  model: string | null
  createdAt: string | null
  /** stale 的原因：data = 统计数据或样本题变了；prompt = 提示词变了；model = 换了模型 */
  staleReasons: Array<'data' | 'prompt' | 'model'>
  warnings: string[]
  /** 现在能不能生成：没配 AI / 某侧没有试卷 / 提示词被改坏 时给出原因 */
  blocked: string | null
  aiReady: boolean
  promptVersion: string
}

const aiConfigured = () => { const c = loadConfig(); return !!(c.base_url && c.model && getApiKey()) }

/** 把存起来的引用对照当前库刷新（题目被删、页面框被改了都以现在的为准） */
function refreshRefs(refs: CitationRef[]): AnalysisState['refs'] {
  const db = getDb()
  const q = db.prepare(`SELECT q.page_idx, q.bbox_json, pg.image_rel, pg.width, pg.height FROM questions q
    LEFT JOIN pages pg ON pg.paper_id = q.paper_id AND pg.idx = q.page_idx WHERE q.id = ?`)
  return refs.map(r => {
    const row = q.get(r.questionId) as any
    if (!row) return { ...r, missing: true }
    let bbox: number[] | null = null
    try { bbox = row.bbox_json ? JSON.parse(row.bbox_json) : null } catch { /* 忽略 */ }
    return { ...r, page_idx: row.page_idx, pageRel: row.image_rel || null, pageW: row.width ?? 0, pageH: row.height ?? 0, bbox }
  })
}

const EMPTY_BLOCK = '目标学年或基线没有计入统计的试卷，无法做同比分析'
const GUIDE = '尚未配置 AI 服务（设置 → AI 服务）'
const promptBlock = (e: string) => `P2 提示词有问题：${e}（请到设置 → 提示词修正或恢复默认）`

/** 没有缓存时只需要知道两侧有没有试卷（用同比同一套「对齐后的两侧范围」），不必构造提示词输入 */
function sidesEmpty(scope: AnalysisScope): boolean {
  const db = getDb()
  const cnt = (sc: { where: string; params: Array<string | number> }) => (db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params) as any).c as number
  const { sT, sB } = sideScopes(db, scope.filter, scope.target, scope.base, scope.align)
  return cnt(sT) === 0 || cnt(sB) === 0
}

/**
 * 读缓存状态。判断「已缓存还是已过期」需要比对数据指纹，而指纹来自整份 P2 输入（要取样本题、算跨年高频表，约 200–300 ms）。
 * 所以不每次重算：行里记着上次核对时的「数据修订号 + 提示词模板签名」和当时的结论，两者都没变就直接用；
 * 变了（有任何试卷/题目/知识点被改过，或提示词被改过）才重新算一遍，并把结论和新的修订号写回去。
 */
export function analysisState(scope: AnalysisScope): AnalysisState {
  const db = getDb()
  const ready = aiConfigured()
  const label = promptVersionFor('p2_yoy')
  const { scopeKey } = cacheKeys(scopeObject(scope), '', '')
  const row = db.prepare('SELECT * FROM ai_analyses WHERE scope_key = ?').get(scopeKey) as any
  if (!row) {
    const blocked = sidesEmpty(scope) ? EMPTY_BLOCK : !ready ? GUIDE : null
    return { aiReady: ready, blocked, promptVersion: label, status: 'none', markdown: '', refs: [], model: null, createdAt: null, staleReasons: [], warnings: [] }
  }
  const rev = currentRev()
  const sig = currentTemplateSig()
  let chk: CheckRecord | null = reusableCheck(row, rev, sig)
  if (!chk) {
    const p = prepare(scope)
    const reasons: Array<'data' | 'prompt'> = []
    if (row.template_sig !== p.templateSig) reasons.push('prompt')
    if (row.fingerprint !== p.input.fingerprint) reasons.push('data')
    chk = { fresh: row.cache_key === p.cacheKey, reasons, promptError: p.promptError, empty: p.cmp.empty }
    // p.rev 是开始计算时的修订号：计算期间数据又变了的话，下次读会再核对
    db.prepare('UPDATE ai_analyses SET checked_rev = ?, checked_sig = ?, checked_json = ? WHERE scope_key = ?').run(p.rev, p.templateSig, JSON.stringify(chk), scopeKey)
  }
  const blocked = chk.empty ? EMPTY_BLOCK : chk.promptError ? promptBlock(chk.promptError) : !ready ? GUIDE : null
  const modelChanged = !!row.model && row.model !== loadConfig().model
  let refs: CitationRef[] = []
  let warnings: string[] = []
  try { refs = JSON.parse(row.refs_json) } catch { /* 忽略 */ }
  try { warnings = JSON.parse(row.warnings_json) } catch { /* 忽略 */ }
  const reasons: Array<'data' | 'prompt' | 'model'> = [...chk.reasons]
  if (modelChanged) reasons.push('model')
  // 换了模型不影响缓存键（输出是上次那个模型写的，界面写着模型名），但提示一下
  const fresh = chk.fresh
  return {
    aiReady: ready, blocked, promptVersion: label, status: fresh ? 'fresh' : 'stale', markdown: row.markdown, refs: refreshRefs(refs), model: row.model, createdAt: row.created_at,
    staleReasons: fresh ? (modelChanged ? ['model'] : []) : reasons, warnings
  }
}

// ───────────────────────── 生成（流式） ─────────────────────────

export type ChunkEvent =
  | { id: string; type: 'start'; scopeKey: string; refs: CitationRef[] }
  | { id: string; type: 'delta'; text: string }
  | { id: string; type: 'reset' }
  | { id: string; type: 'done'; markdown: string; refs: CitationRef[]; warnings: string[] }
  | { id: string; type: 'error'; code: string; message: string; partial: string }
  | { id: string; type: 'cancelled'; partial: string }

export interface GenerateResult {
  ok: boolean
  cancelled?: boolean
  code?: string
  message?: string
  partial?: string
  markdown?: string
  refs?: CitationRef[]
  warnings?: string[]
}

const inflight = new Map<string, AbortController>()      // requestId → 控制器
const busyScopes = new Set<string>()                     // 正在生成的范围，避免重复点击烧两份钱

export function cancelAnalysis(requestId: string): boolean {
  const c = inflight.get(requestId)
  if (!c) return false
  c.abort()
  return true
}

const FRIENDLY: Record<string, string> = {
  empty: '模型返回了空内容（已自动重试一次仍为空）。可以稍后重新生成，或换一个模型',
  truncated: '分析被输出长度上限截断，可以在设置 → AI 服务 → 高级里调大「输出上限」后重新生成'
}

/** @param send 把事件发给发起请求的那个窗口（调用方传 event.sender.send），不广播 */
export async function generateAnalysis(scope: AnalysisScope, requestId: string, send: (e: ChunkEvent) => void, senderGone: (cb: () => void) => () => void): Promise<GenerateResult> {
  const p = prepare(scope)
  if (p.cmp.empty) return { ok: false, code: 'no_data', message: '目标学年或基线没有计入统计的试卷，无法做同比分析' }
  if (p.promptError) return { ok: false, code: 'bad_prompt', message: `P2 提示词有问题：${p.promptError}（请到设置 → 提示词修正或恢复默认）` }
  if (!aiConfigured()) return { ok: false, code: 'no_ai', message: '尚未配置 AI 服务（设置 → AI 服务），统计结果不受影响' }
  if (inflight.has(requestId)) return { ok: false, code: 'busy', message: '这个请求已经在生成' }
  if (busyScopes.has(p.scopeKey)) return { ok: false, code: 'busy', message: '这个范围的分析正在生成，请等它结束或先取消' }

  const cfg = loadConfig()
  const ctl = new AbortController()
  inflight.set(requestId, ctl)
  busyScopes.add(p.scopeKey)
  const offGone = senderGone(() => ctl.abort())

  let buf = ''
  let lastPartial = ''   // 失败重试前被清掉的那次尝试里已收到的内容：最终失败/取消时界面要能看到
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => { timer = null; if (pending) { send({ id: requestId, type: 'delta', text: pending }); pending = '' } }
  try {
    send({ id: requestId, type: 'start', scopeKey: p.scopeKey, refs: p.input.refs })
    const r = await chat({
      baseUrl: cfg.base_url, apiKey: getApiKey()!, model: cfg.model, stream: true, temperature: 0.3, maxTokens: cfg.max_tokens,
      messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
      timeoutMs: cfg.timeout_sec * 1000, maxRetries: 2, backoffMs: 1000, signal: ctl.signal, fetchImpl: net.fetch as unknown as typeof fetch,
      onDelta: (t) => { buf += t; pending += t; if (!timer) timer = setTimeout(flush, 40) },
      // 失败后要重试：已经推给界面的半截内容作废，从头来
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
    recordUsage({ paperId: null, kind: 'p2_yoy', model: r.model, usage: r.usage, ok: true })

    // 校验：引用必须来自我们给的索引；标题里的知识点代码应在输入里
    const known = new Set(p.input.refs.map(x => x.token))
    const { text, removed } = stripUnknownCitations(r.content, known)
    const warnings: string[] = []
    if (removed.length) warnings.push(`已移除 ${removed.length} 处无法核对的引用（模型写出了输入里没有的试卷或题号）`)
    const codes = new Set(p.input.codes)
    const stray = headingCodes(text).filter(c => !codes.has(c))
    if (stray.length) warnings.push(`有 ${stray.length} 个小标题的知识点代码不在输入数据里（${stray.slice(0, 3).join('、')}），请核对`)
    // 完整性兜底：默认提示词规定了「五、…」这个最后一节；缺了很可能是被截断（自定义提示词不检查）
    if (promptVersionFor('p2_yoy') === PROMPT_DEFAULT_VERSION && !/^#{1,3}\s*五、/m.test(text)) warnings.push('输出里没有最后一节「五、下学期教学与复习建议」，内容可能不完整，建议重新生成')
    const used = p.input.refs.filter(x => text.includes(x.token))

    // 修订号用「开始生成时」的：生成期间数据又变了，下次读状态会重新核对，不会把过期结果误报成新鲜
    getDb().prepare(`INSERT OR REPLACE INTO ai_analyses (scope_key, kind, cache_key, prompt_version, fingerprint, scope_json, markdown, refs_json, warnings_json, model, usage_json,
        template_sig, checked_rev, checked_sig, checked_json)
      VALUES (?, 'p2_yoy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.scopeKey, p.cacheKey, p.promptVersion, p.input.fingerprint, JSON.stringify(scopeObject(scope)),
      text, JSON.stringify(used), JSON.stringify(warnings), r.model, JSON.stringify(r.usage),
      p.templateSig, p.rev, p.templateSig, JSON.stringify({ fresh: true, reasons: [], promptError: null, empty: false }))
    notifyDataChanged('analysis')   // 另一个页面（比如生成中被刷新过的）也能看到新结果
    send({ id: requestId, type: 'done', markdown: text, refs: used, warnings })
    return { ok: true, markdown: text, refs: used, warnings }
  } catch (e) {
    if (timer) clearTimeout(timer)
    const partial = buf || lastPartial
    if (e instanceof AiError && e.code === 'aborted') {
      send({ id: requestId, type: 'cancelled', partial })
      return { ok: false, cancelled: true, code: 'aborted', message: '已取消', partial }
    }
    const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
    recordUsage({ paperId: null, kind: 'p2_yoy', model: cfg.model, ok: false })
    const message = FRIENDLY[err.code] ?? err.message
    send({ id: requestId, type: 'error', code: err.code, message, partial })
    return { ok: false, code: err.code, message, partial }
  } finally {
    offGone()
    inflight.delete(requestId)
    busyScopes.delete(p.scopeKey)
  }
}

export const newRequestId = () => crypto.randomUUID()
