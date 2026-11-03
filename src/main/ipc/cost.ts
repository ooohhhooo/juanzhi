import { ipcMain, net, shell } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { loadConfig, visionBaseUrl, visionCreds } from '../ai/config'
import { getApiKey, hasVisionStoredKey } from '../ai/secret'
import { sameServer } from '../ai/guard'
import { detectProvider, fetchBalance, fetchCustomBalance } from '../ai/balance'
import type { BalanceResult, CustomBalance } from '../ai/balance'
import { diagnose } from '../ai/diagnose'
import { lastAiFailure } from '../ai/client'
import { modelProfile } from '../ai/providers'
import { originOf } from '../ai/guard'
import { NO_PRICES, createSpendTracker, estimateCost, kindLabel, parsePrices, spendFrom, tokensToMoney } from '../ai/cost'
import type { KindAvg, Prices } from '../ai/cost'

/**
 * 余额、价格、费用估算、用量汇总。价格和「上次实际花费」存在 settings 表（不在 settings:set 白名单里，只能经本文件的接口读写）。
 * 密钥只在主进程内用于请求头，不返回渲染端。
 */

const PRICES_KEY = 'ai_prices'
const SPEND_KEY = 'ai_last_spend'
const CUSTOM_KEY = 'ai_balance_custom'
const CACHE_MS = 30_000

const EMPTY_CUSTOM: CustomBalance = { url: '', balancePath: '', totalPath: '', unit: '' }
export function getCustom(): CustomBalance {
  const v = (readSetting(CUSTOM_KEY) ?? {}) as Record<string, unknown>
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.trim().slice(0, n) : '')
  return { url: s(v.url, 500), balancePath: s(v.balancePath, 100), totalPath: s(v.totalPath, 100), unit: s(v.unit, 10) }
}

const readSetting = (key: string): unknown => {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
  try { return row ? JSON.parse(row.value_json) : null } catch { return null }
}
const writeSetting = (key: string, v: unknown) => { getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(v)) }

export const getPrices = (): Prices => parsePrices(readSetting(PRICES_KEY))

interface BalanceView { text: BalanceResult; vision: BalanceResult | null }
let cache: { at: number; sig: string; v: BalanceView } | null = null

const fetchImpl = net.fetch as unknown as typeof fetch

async function queryBalance(force: boolean, timeoutMs?: number): Promise<BalanceView> {
  const cfg = loadConfig()
  const custom = getCustom()
  const useCustom = !!(custom.url && custom.balancePath)
  const sig = `${JSON.stringify(custom)}|${cfg.base_url}|${cfg.vision_base_url}|${cfg.vision_model}|${!!getApiKey()}|${hasVisionStoredKey()}`
  if (!force && cache && cache.sig === sig && Date.now() - cache.at < CACHE_MS) return cache.v
  const text = useCustom
    ? await fetchCustomBalance(custom, getApiKey(), cfg.base_url, fetchImpl, timeoutMs)
    : await fetchBalance({ baseUrl: cfg.base_url, apiKey: getApiKey(), fetchImpl, timeoutMs })
  let vision: BalanceResult | null = null
  // 视觉模型用了另一个服务商 / 另一把密钥时，单独查
  if (cfg.vision_model.trim() && (!sameServer(cfg.base_url, visionBaseUrl(cfg)) || hasVisionStoredKey())) {
    const c = visionCreds(cfg)
    vision = await fetchBalance({ baseUrl: c.baseUrl, apiKey: c.key, fetchImpl, timeoutMs })
  }
  const v = { text, vision }
  cache = { at: Date.now(), sig, v }
  return v
}

// ───── 任务前后各查一次余额，记录实际花费 ─────
export type SpendTask = 'course-match' | 'course-organize' | 'report'
const SPEND_LABEL: Record<SpendTask, string> = { 'course-match': '课程匹配', 'course-organize': '课程整理', report: '报告生成' }
const tracker = createSpendTracker()

/** 包住一个会花较多用量的任务。查不到余额 / 币种不同 / 与别的任务同时进行时不记录，也绝不影响任务本身 */
export async function withSpend<T>(task: SpendTask, run: () => Promise<T>): Promise<T> {
  const t = tracker.begin()
  const snap = async () => {
    try {
      const r = (await queryBalance(true, 3000)).text
      return r.status === 'ok' && r.amount !== null ? { amount: r.amount, currency: r.currency } : null
    } catch { return null }
  }
  const before = await snap()
  try {
    return await run()
  } finally {
    const clean = tracker.end(t)
    if (before && clean) {
      void snap().then(after => {
        const s = spendFrom(before, after)
        if (!s) return
        const all = (readSetting(SPEND_KEY) ?? {}) as Record<string, unknown>
        writeSetting(SPEND_KEY, { ...all, [task]: { ...s, at: new Date().toISOString() } })
      }).catch(() => undefined)
    }
  }
}

/** 某类任务最近 50 次成功调用的平均输入 / 输出 token */
function avgOf(kinds: string[]): KindAvg | null {
  const rows = getDb().prepare(`SELECT prompt_tokens p, completion_tokens c FROM ai_usage WHERE ok = 1 AND completion_tokens > 0 AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 50`).all(...kinds) as Array<{ p: number; c: number }>
  if (!rows.length) return null
  return { calls: rows.length, avgIn: rows.reduce((s, r) => s + r.p, 0) / rows.length, avgOut: rows.reduce((s, r) => s + r.c, 0) / rows.length }
}

const TASK_KINDS: Record<string, string[]> = {
  'course-match': ['course-match'],
  'course-organize': ['course-cols', 'course-extract'],
  report: ['p3_report', 'p3_boss', 'p3_parent', 'p3_teacher']
}

export function registerCostIpc(): void {
  ipcMain.handle('ai:balance', async (_e, force: unknown) => {
    const v = await queryBalance(force === true)
    const p = detectProvider(loadConfig().base_url)
    return { ...v, providerName: p?.name ?? '' }
  })

  ipcMain.handle('ai:openConsole', async (_e, which: unknown) => {
    const cfg = loadConfig()
    const p = detectProvider(which === 'vision' ? visionBaseUrl(cfg) : cfg.base_url)
    if (!p?.consoleUrl) return false
    await shell.openExternal(p.consoleUrl)
    return true
  })

  ipcMain.handle('ai:getCustomBalance', async () => getCustom())
  ipcMain.handle('ai:setCustomBalance', async (_e, raw: unknown) => {
    const c = z.object({ url: z.string().max(500), balancePath: z.string().max(100), totalPath: z.string().max(100), unit: z.string().max(10) }).parse(raw)
    const v = { url: c.url.trim(), balancePath: c.balancePath.trim(), totalPath: c.totalPath.trim(), unit: c.unit.trim() }
    if (v.url && !originOf(v.url)) throw new Error('查询地址必须是以 http:// 或 https:// 开头的有效地址')
    if (v.url && !v.balancePath) throw new Error('请填写余额字段路径，例如 data.balance')
    writeSetting(CUSTOM_KEY, v.url ? v : EMPTY_CUSTOM)
    cache = null
    return getCustom()
  })

  /** 出错原因诊断：优先用最近（2 分钟内）失败的那次调用；和余额有关就自动查一次余额写进诊断 */
  ipcMain.handle('ai:diagnose', async (_e, raw: unknown) => {
    const a = z.object({ message: z.string().max(2000).default(''), task: z.string().max(60).optional() }).parse(raw ?? {})
    const recent = lastAiFailure.err && Date.now() - lastAiFailure.at < 120_000 ? lastAiFailure : null
    const err = recent ? { code: recent.err!.code, status: recent.err!.status, detail: recent.err!.detail, message: recent.err!.message } : { message: a.message, detail: a.message }
    const model = recent?.model ?? ''
    const base = diagnose(err, { model, task: a.task, reasoning: model ? modelProfile(model).reasoning : false })
    if (!base.balanceRelated) return base
    let balance: { amount: number | null; currency: string; text: string } | null = null
    try {
      const r = (await queryBalance(true, 4000)).text
      if (r.status === 'ok') balance = { amount: r.unlimited ? null : r.amount, currency: r.currency, text: r.text }
    } catch { /* 查不到就不写 */ }
    return diagnose(err, { model, task: a.task, balance, reasoning: model ? modelProfile(model).reasoning : false })
  })

  ipcMain.handle('ai:getPrices', async () => getPrices())
  ipcMain.handle('ai:setPrices', async (_e, raw: unknown) => {
    const p = z.object({ inPer1M: z.number().min(0).max(100000).nullable(), outPer1M: z.number().min(0).max(100000).nullable() }).parse(raw)
    writeSetting(PRICES_KEY, p)
    return p
  })

  /** 估算一次任务：task = course-match / course-organize / report；calls 次数；fallbackTokens 为现有估算 */
  ipcMain.handle('ai:costEstimate', async (_e, raw: unknown) => {
    const a = z.object({ task: z.enum(['course-match', 'course-organize', 'report']), calls: z.number().min(0).max(100000), fallbackTokens: z.number().min(0).max(1e10).default(0) }).parse(raw)
    const est = estimateCost(a.calls, avgOf(TASK_KINDS[a.task]), a.fallbackTokens, getPrices())
    const last = ((readSetting(SPEND_KEY) ?? {}) as Record<string, { amount: number; currency: string; at: string }>)[a.task] ?? null
    return { ...est, label: SPEND_LABEL[a.task], last }
  })

  /** 设置页：上次实际花费（各任务） */
  ipcMain.handle('ai:lastSpend', async () => {
    const all = (readSetting(SPEND_KEY) ?? {}) as Record<string, { amount: number; currency: string; at: string }>
    return Object.entries(all).filter(([k]) => k in SPEND_LABEL).map(([k, v]) => ({ task: k, label: SPEND_LABEL[k as SpendTask], ...v }))
  })

  /** 本月按任务类型的调用次数 / token（和金额，价格填了才有） */
  ipcMain.handle('ai:usageByKind', async () => {
    const prices = getPrices() ?? NO_PRICES
    const rows = getDb().prepare(`SELECT kind, COUNT(*) calls, SUM(prompt_tokens) prompt, SUM(completion_tokens) completion
      FROM ai_usage WHERE created_at >= strftime('%Y-%m-01 00:00:00','now','localtime') GROUP BY kind ORDER BY calls DESC`).all() as Array<{ kind: string; calls: number; prompt: number; completion: number }>
    return rows.map(r => ({ kind: r.kind, label: kindLabel(r.kind), calls: r.calls, prompt: r.prompt, completion: r.completion, money: tokensToMoney(r.prompt, r.completion, prices) }))
  })
}
