import { originOf } from './guard.ts'

/**
 * AI 账户余额查询（纯逻辑 + 一个注入 fetch 的查询函数，不依赖 electron，单测用伪造响应）。
 * 只用设置里的 base_url 识别服务商；密钥只放在请求头里，不进返回值、不进日志。
 */

export type ProviderId = 'deepseek' | 'moonshot' | 'siliconflow' | 'openrouter' | 'relay' | 'nobalance'

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** 控制台 / 充值页（固定值，不来自用户输入）；没有就是 null */
  consoleUrl: string | null
}

const KNOWN_NO_BALANCE: Array<[RegExp, string, string]> = [
  [/(^|\.)dashscope\.aliyuncs\.com$/, '通义千问（阿里云百炼）', 'https://bailian.console.aliyun.com/'],
  [/(^|\.)volces\.com$/, '豆包（火山方舟）', 'https://console.volcengine.com/ark'],
  [/(^|\.)bigmodel\.cn$/, '智谱 GLM', 'https://open.bigmodel.cn/']
]

export function detectProvider(baseUrl: string): ProviderInfo | null {
  const o = originOf(baseUrl)
  if (!o) return null
  const host = new URL(o).hostname.toLowerCase()
  if (/(^|\.)deepseek\.com$/.test(host)) return { id: 'deepseek', name: 'DeepSeek', consoleUrl: 'https://platform.deepseek.com/top_up' }
  if (/(^|\.)moonshot\.(cn|ai)$/.test(host)) return { id: 'moonshot', name: 'Kimi（月之暗面）', consoleUrl: host.endsWith('.ai') ? 'https://platform.moonshot.ai/' : 'https://platform.moonshot.cn/console/account' }
  if (/(^|\.)siliconflow\.cn$/.test(host)) return { id: 'siliconflow', name: '硅基流动', consoleUrl: 'https://cloud.siliconflow.cn/' }
  if (/(^|\.)openrouter\.ai$/.test(host)) return { id: 'openrouter', name: 'OpenRouter', consoleUrl: 'https://openrouter.ai/settings/credits' }
  for (const [re, name, url] of KNOWN_NO_BALANCE) if (re.test(host)) return { id: 'nobalance', name, consoleUrl: url }
  return { id: 'relay', name: '中转平台（OpenAI 兼容）', consoleUrl: null }
}

export type BalanceResult =
  | { status: 'ok'; provider: string; providerName: string; amount: number | null; currency: string; unlimited?: boolean; text: string; note?: string; available: boolean; consoleUrl: string | null }
  | { status: 'unsupported'; providerName: string; consoleUrl: string | null; message: string }
  | { status: 'error'; providerName: string; consoleUrl: string | null; message: string }
  | { status: 'nokey'; providerName: string; message: string }

export const UNSUPPORTED_TEXT = '这家服务商不支持在软件里查余额，请到服务商控制台查看'
export const RELAY_NOTE = '中转平台的额度单位以平台为准'

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

export const SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }
export function fmtAmount(amount: number, currency: string): string {
  const s = Math.abs(amount) >= 100 ? amount.toFixed(1) : amount.toFixed(2)
  return SYMBOL[currency] ? `${SYMBOL[currency]}${s}` : `${s} ${currency}`
}

export interface Parsed { amount: number | null; currency: string; unlimited?: boolean; available: boolean; note?: string }

/** DeepSeek：优先人民币，其次第一项 */
export function parseDeepSeek(j: unknown): Parsed | null {
  if (!isObj(j) || !Array.isArray(j.balance_infos)) return null
  const infos = j.balance_infos.filter(isObj)
  const pick = infos.find(i => i.currency === 'CNY') ?? infos[0]
  const available = j.is_available !== false
  if (!pick) return { amount: 0, currency: 'CNY', available: false }
  const amount = num(pick.total_balance)
  if (amount === null) return null
  return { amount, currency: String(pick.currency || 'CNY'), available }
}

export function parseMoonshot(j: unknown): Parsed | null {
  const d = isObj(j) ? j.data : null
  if (!isObj(d)) return null
  const amount = num(d.available_balance)
  return amount === null ? null : { amount, currency: 'CNY', available: amount > 0 }
}

export function parseSiliconFlow(j: unknown): Parsed | null {
  const d = isObj(j) ? j.data : null
  if (!isObj(d)) return null
  const total = num(d.totalBalance)
  const amount = total ?? ((num(d.balance) ?? NaN) + (num(d.chargeBalance) ?? 0))
  return Number.isFinite(amount) ? { amount, currency: 'CNY', available: amount > 0 } : null
}

export function parseOpenRouter(j: unknown): Parsed | null {
  const d = isObj(j) ? j.data : null
  if (!isObj(d)) return null
  const total = num(d.total_credits)
  const used = num(d.total_usage)
  if (total === null || used === null) return null
  const amount = total - used
  return { amount, currency: 'USD', available: amount > 0 }
}

/** 无限额度的判定：one-api / new-api 用很大的 hard_limit_usd 表示不限额 */
export const UNLIMITED_USD = 1e8

/** one-api 风格：订阅接口 hard_limit_usd（总额度，美元）+ 用量接口 total_usage（美分） */
export function parseRelay(subscription: unknown, usage: unknown): Parsed | null {
  if (!isObj(subscription) || !isObj(usage)) return null
  const limit = num(subscription.hard_limit_usd)
  const used = num(usage.total_usage)
  if (limit === null || used === null) return null
  if (limit >= UNLIMITED_USD) return { amount: null, currency: 'USD', unlimited: true, available: true, note: RELAY_NOTE }
  const amount = limit - used / 100
  return { amount, currency: 'USD', available: amount > 0, note: RELAY_NOTE }
}

/** LiteLLM 网关：GET /key/info → info.spend / info.max_budget（max_budget 为空 = 不限额度） */
export function parseLiteLlm(j: unknown): Parsed | null {
  const info = isObj(j) ? j.info : null
  if (!isObj(info)) return null
  const spend = num(info.spend) ?? 0
  if (info.max_budget === null || info.max_budget === undefined) {
    return 'spend' in info || 'max_budget' in info ? { amount: null, currency: 'USD', unlimited: true, available: true, note: RELAY_NOTE } : null
  }
  const max = num(info.max_budget)
  if (max === null) return null
  const amount = max - spend
  return { amount, currency: 'USD', available: amount > 0, note: RELAY_NOTE }
}

/** 管理员自定义的余额查询：地址 + 字段路径（如 data.balance），只取指定的数字字段 */
export interface CustomBalance { url: string; balancePath: string; totalPath: string; unit: string }

export function pickPath(j: unknown, path: string): number | null {
  let cur: unknown = j
  for (const seg of path.split('.').map(s => s.trim()).filter(Boolean)) {
    if (Array.isArray(cur)) cur = cur[Number(seg)]
    else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg]
    else return null
  }
  return num(cur)
}

export function parseCustom(j: unknown, c: CustomBalance): (Parsed & { total?: number }) | null {
  const amount = pickPath(j, c.balancePath)
  if (amount === null) return null
  const total = c.totalPath.trim() ? pickPath(j, c.totalPath) : null
  return { amount, currency: c.unit.trim() || '额度', available: amount > 0, ...(total !== null ? { total } : {}) }
}

const BALANCE_PATH: Partial<Record<ProviderId, string>> = {
  deepseek: '/user/balance', moonshot: '/v1/users/me/balance', siliconflow: '/v1/user/info', openrouter: '/api/v1/credits'
}
const PARSER: Partial<Record<ProviderId, (j: unknown) => Parsed | null>> = {
  deepseek: parseDeepSeek, moonshot: parseMoonshot, siliconflow: parseSiliconFlow, openrouter: parseOpenRouter
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 中转站的 base 常带 /v1：去掉末尾 /v1 再拼 /v1/dashboard/... */
export function relayRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

export function balanceUrls(p: ProviderInfo, baseUrl: string, now = new Date()): string[] {
  const o = originOf(baseUrl)
  if (!o) return []
  if (p.id === 'relay') {
    const root = relayRoot(baseUrl)
    const start = new Date(now.getTime() - 99 * 86400_000)
    const end = new Date(now.getTime() + 86400_000)
    return [`${root}/v1/dashboard/billing/subscription`, `${root}/v1/dashboard/billing/usage?start_date=${ymd(start)}&end_date=${ymd(end)}`]
  }
  const path = BALANCE_PATH[p.id]
  return path ? [`${o}${path}`] : []
}

async function getJson(url: string, key: string, f: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  const onAbort = () => ctl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const r = await f(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctl.signal })
    if (!r.ok) throw Object.assign(new Error('http'), { status: r.status })
    const text = await r.text()
    try { return JSON.parse(text) } catch { throw Object.assign(new Error('notjson'), { status: 0 }) }
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort) }
}

export function finishCustom(c: CustomBalance, parsed: Parsed & { total?: number }): BalanceResult {
  const u = c.unit.trim()
  const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2))
  const text = `${fmt(parsed.amount ?? 0)}${parsed.total !== undefined ? ` / ${fmt(parsed.total)}` : ''}${u ? ' ' + u : ''}`
  return { status: 'ok', provider: 'custom', providerName: '自定义查询', amount: parsed.amount, currency: parsed.currency, text, available: parsed.available, consoleUrl: null }
}

/** 管理员自定义查询（优先于自动识别）。地址必须和 AI 服务地址是同一个主机，密钥不会发往别处 */
export async function fetchCustomBalance(c: CustomBalance, apiKey: string | null, serviceUrl: string, f: typeof fetch, timeoutMs = 8000, signal?: AbortSignal): Promise<BalanceResult> {
  const name = '自定义查询'
  const o = originOf(c.url)
  if (!o) return { status: 'error', providerName: name, consoleUrl: null, message: '自定义查询地址必须是 http:// 或 https:// 开头的有效地址' }
  if (o !== originOf(serviceUrl)) return { status: 'error', providerName: name, consoleUrl: null, message: '自定义查询地址必须和 AI 服务地址是同一个主机（密钥不会发往别的地址）' }
  if (!apiKey) return { status: 'nokey', providerName: name, message: '还没有保存 API Key' }
  try {
    const j = await getJson(c.url.trim(), apiKey, f, timeoutMs, signal)
    const parsed = parseCustom(j, c)
    return parsed ? finishCustom(c, parsed) : { status: 'error', providerName: name, consoleUrl: null, message: `返回内容里找不到字段「${c.balancePath}」，请检查字段路径` }
  } catch (e) {
    const status = (e as { status?: number }).status
    const message = (e as Error).name === 'AbortError' ? '查询余额超时，请稍后刷新' : status === 401 || status === 403 ? 'API Key 无效或没有查询权限' : status ? `查询地址返回了错误（${status}）` : '连不上查询地址，或返回的不是 JSON'
    return { status: 'error', providerName: name, consoleUrl: null, message }
  }
}

export function finish(p: ProviderInfo, parsed: Parsed): BalanceResult {
  const text = parsed.unlimited ? '不限额度' : p.id === 'relay' ? `额度 ${fmtAmount(parsed.amount ?? 0, 'USD')}` : fmtAmount(parsed.amount ?? 0, parsed.currency)
  return { status: 'ok', provider: p.id, providerName: p.name, amount: parsed.amount, currency: parsed.currency, unlimited: parsed.unlimited, text, note: parsed.note, available: parsed.available, consoleUrl: p.consoleUrl }
}

/** 查询余额。失败都转成白话；超时默认 8 秒。 */
export async function fetchBalance(opts: { baseUrl: string; apiKey: string | null; fetchImpl: typeof fetch; timeoutMs?: number; signal?: AbortSignal; now?: Date }): Promise<BalanceResult> {
  const p = detectProvider(opts.baseUrl)
  if (!p) return { status: 'unsupported', providerName: '', consoleUrl: null, message: '服务地址不正确，无法查询余额' }
  const unsupported = (): BalanceResult => ({ status: 'unsupported', providerName: p.name, consoleUrl: p.consoleUrl, message: UNSUPPORTED_TEXT })
  if (p.id === 'nobalance') return unsupported()
  if (!opts.apiKey) return { status: 'nokey', providerName: p.name, message: '还没有保存 API Key' }
  const urls = balanceUrls(p, opts.baseUrl, opts.now)
  if (!urls.length) return unsupported()
  const timeout = opts.timeoutMs ?? 8000
  try {
    if (p.id === 'relay') {
      // 同一把密钥：OpenAI 旧版账单接口（one-api / new-api）与 LiteLLM 的 /key/info 并行试，谁先认得就用谁
      const key = opts.apiKey as string
      const [bill, lite] = await Promise.allSettled([
        Promise.all(urls.map(u => getJson(u, key, opts.fetchImpl, timeout, opts.signal))),
        getJson(`${relayRoot(opts.baseUrl)}/key/info`, key, opts.fetchImpl, timeout, opts.signal)
      ])
      const fromBill = bill.status === 'fulfilled' ? parseRelay(bill.value[0], bill.value[1]) : null
      const fromLite = lite.status === 'fulfilled' ? parseLiteLlm(lite.value) : null
      const got = fromBill ?? fromLite
      return got ? finish(p, got) : unsupported()
    }
    const results = await Promise.all(urls.map(u => getJson(u, opts.apiKey as string, opts.fetchImpl, timeout, opts.signal)))
    const parsed = PARSER[p.id]!(results[0])
    if (!parsed) return { status: 'error', providerName: p.name, consoleUrl: p.consoleUrl, message: '服务商返回的内容看不懂，暂时查不到余额' }
    return finish(p, parsed)
  } catch (e) {
    if (p.id === 'relay') return unsupported()
    const status = (e as { status?: number }).status
    const aborted = (e as Error).name === 'AbortError'
    const message = aborted ? '查询余额超时，请稍后刷新' : status === 401 || status === 403 ? 'API Key 无效或没有查询权限' : status ? `服务商暂时无法返回余额（${status}）` : '连不上服务商，暂时查不到余额'
    return { status: 'error', providerName: p.name, consoleUrl: p.consoleUrl, message }
  }
}
