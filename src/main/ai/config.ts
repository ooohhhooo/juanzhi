import { net } from 'electron'
import { getDb } from '../db'
import { AiConfigSchema, DEFAULT_AI_CONFIG, parseModelOf } from './types'
import type { AiConfig, AiConfigView } from './types'
import { getApiKey, getVisionOwnKey, hasStoredKey, hasVisionStoredKey, keyStorage, saveApiKey, saveVisionKey } from './secret'
import { chat, AiError } from './client'
import { explainTestError, judgeVisionAnswer } from './test-rules'
import type { ChatMessage, Usage } from './client'
import { isHttpUrl, sameServer } from './guard'
import { makeTextPng } from './png'

const CONFIG_KEY = 'ai_config'

export function loadConfig(): AiConfig {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(CONFIG_KEY) as { value_json: string } | undefined
  if (!row) return { ...DEFAULT_AI_CONFIG }
  try {
    const parsed = AiConfigSchema.safeParse({ ...DEFAULT_AI_CONFIG, ...JSON.parse(row.value_json) })
    return parsed.success ? parsed.data : { ...DEFAULT_AI_CONFIG }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export function configView(): AiConfigView {
  const storage = keyStorage()
  return { ...loadConfig(), hasKey: storage !== 'none', keyStorage: storage, hasVisionKey: hasVisionStoredKey() }
}

/** 视觉模型实际访问的服务地址：填了自己的就用自己的，否则和文本模型相同 */
export function visionBaseUrl(cfg: Pick<AiConfig, 'base_url' | 'vision_base_url'>): string {
  return cfg.vision_base_url.trim() || cfg.base_url
}

/**
 * 视觉模型这次请求用的地址和密钥。自己的密钥优先；没有自己的密钥时，只有「视觉地址和文本地址是同一个服务」才沿用文本模型的密钥——
 * 绝不把文本模型的密钥发到另一个主机去（同 saveConfig 的守卫）。
 */
export function visionCreds(cfg: AiConfig, override?: { visionKey?: string; textKey?: string }): { baseUrl: string; key: string | null } {
  const baseUrl = visionBaseUrl(cfg)
  const own = override?.visionKey?.trim() || getVisionOwnKey()
  if (own) return { baseUrl, key: own }
  const text = override?.textKey?.trim() || getApiKey()
  return { baseUrl, key: text && sameServer(cfg.base_url, baseUrl) ? text : null }
}

/**
 * apiKey: undefined = 不改；null 或空串 = 清除；其余 = 替换。visionKey 同理（视觉模型自己的密钥）。
 *
 * 已保存的密钥只会发往它当初配套的服务：地址的来源（协议+主机+端口）变了、或者已存地址是空/非法的，
 * 都必须同时重新输入密钥——否则页面脚本即使被攻破，也没法把已存的密钥重定向到别的主机去。
 */
export function saveConfig(cfg: AiConfig, apiKey?: string | null, visionKey?: string | null): AiConfigView {
  const parsed = AiConfigSchema.parse(cfg)
  const url = parsed.base_url.trim()
  const vurl = parsed.vision_base_url.trim()
  if (url && !isHttpUrl(url)) throw new Error('Base URL 必须是以 http:// 或 https:// 开头的有效地址')
  if (vurl && !isHttpUrl(vurl)) throw new Error('视觉模型的服务地址必须是以 http:// 或 https:// 开头的有效地址')
  const settingKey = typeof apiKey === 'string' && apiKey.trim() !== ''
  if (settingKey && !url) throw new Error('请先填写 Base URL，再保存 API Key')
  if (typeof visionKey === 'string' && visionKey.trim() !== '' && !(vurl || url)) throw new Error('请先填写视觉模型的服务地址，再保存它的 API Key')
  const old = loadConfig()
  if (apiKey === undefined && hasStoredKey() && !sameServer(old.base_url, url)) {
    throw new Error('更换服务地址（或地址为空）后需要重新输入 API Key（已保存的密钥不会被发往新的地址）')
  }
  if (visionKey === undefined && hasVisionStoredKey() && !sameServer(visionBaseUrl(old), vurl || url)) {
    throw new Error('更换视觉模型的服务地址后需要重新输入它的 API Key（已保存的密钥不会被发往新的地址）')
  }
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(CONFIG_KEY, JSON.stringify({
    ...parsed, base_url: url, vision_base_url: vurl, model: parsed.model.trim(), parse_model: parsed.parse_model.trim(), vision_model: parsed.vision_model.trim()
  }))
  if (apiKey !== undefined) saveApiKey(apiKey)
  if (visionKey !== undefined) saveVisionKey(visionKey)
  return configView()
}

/** 文本解析是否已具备条件：有地址、拆题模型和密钥 */
export function isAiReady(): boolean {
  const c = loadConfig()
  return !!(c.base_url && parseModelOf(c) && getApiKey())
}

/** 把一次调用的用量记到 ai_usage（paper_id 故意不设外键：删除试卷后费用统计仍要保留） */
export function recordUsage(row: { paperId: string | null; kind: string; model: string; usage?: Usage; ok: boolean; ms?: number; errCode?: string; attempts?: number }): void {
  try {
    getDb().prepare(`INSERT INTO ai_usage (paper_id, kind, model, prompt_tokens, completion_tokens, cached_tokens, ok, ms, err_code, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.paperId, row.kind, row.model, row.usage?.promptTokens ?? 0, row.usage?.completionTokens ?? 0, row.usage?.cachedTokens ?? 0, row.ok ? 1 : 0, row.ms ?? null, row.errCode ?? null, row.attempts ?? null)
  } catch (e) {
    console.warn('[ai] 记录用量失败:', (e as Error).message)
  }
}

/** 一项测试：ok 通过；warn 能连通但有疑问；fail 失败；skip 没填 / 与别项相同，没有测 */
export type TestStatus = 'ok' | 'warn' | 'fail' | 'skip'
/** 拆题模型 / 写报告模型 / 视觉模型 */
export type TestKind = 'parse' | 'report' | 'vision'

export interface TestResult {
  ok: boolean
  message: string
  latencyMs: number
  model: string
  kind?: TestKind
  status?: TestStatus
  /** 失败时「怎么办」的几步（403 等） */
  steps?: string[]
  /** 服务商返回的原话（已隐藏密钥），收在「查看详情」里 */
  detail?: string
}

// 视觉模型测试用的图：白底黑字的「7K」，让模型读出来；读对 = 真的会看图（纯色图只能证明请求没被拒）
const TEST_PNG = makeTextPng('7K', 64, 5).toString('base64')

const KIND_LABEL: Record<TestKind, string> = { parse: '拆题用的模型', report: '写报告用的模型', vision: '视觉模型' }

export interface TestDraft {
  cfg?: Partial<AiConfig>
  apiKey?: string
  visionKey?: string
}

/** 单项测试。parse/report 发最小文本请求；vision 发带「7K」小图的请求，看模型能不能读出来 */
async function testOne(kind: TestKind, draft: TestDraft | undefined): Promise<TestResult> {
  const saved = loadConfig()
  const cfg = { ...saved, ...(draft?.cfg ?? {}) }
  const model = kind === 'vision' ? cfg.vision_model.trim() : kind === 'parse' ? parseModelOf(cfg) : cfg.model.trim()
  const t0 = Date.now()
  const done = (status: TestStatus, message: string, extra: Partial<TestResult> = {}): TestResult => ({ ok: status === 'ok' || status === 'warn', status, kind, message, latencyMs: Date.now() - t0, model, ...extra })
  const draftKey = draft?.apiKey?.trim()
  const draftVisionKey = draft?.visionKey?.trim()

  let baseUrl: string
  let key: string | null
  if (kind === 'vision') {
    const c = visionCreds(cfg, { visionKey: draftVisionKey, textKey: draftKey })
    baseUrl = c.baseUrl
    key = c.key
    // 已保存的密钥不用于测试别的服务地址（同 saveConfig 的理由）；要测新地址就得带上对应的密钥
    if (baseUrl && !isHttpUrl(baseUrl)) return done('fail', '服务地址必须是以 http:// 或 https:// 开头的有效地址')
    if (!draftVisionKey && !draftKey && baseUrl && !sameServer(visionBaseUrl(saved), baseUrl)) return done('fail', '要测试新的服务地址，请先在上面输入对应的 API Key')
    if (!model) return done('skip', '没有设置视觉模型：照片和扫描件在没装中文识别的电脑上可能识别不完整')
  } else {
    baseUrl = cfg.base_url
    key = draftKey || getApiKey()
    if (baseUrl && !isHttpUrl(baseUrl)) return done('fail', 'Base URL 必须是以 http:// 或 https:// 开头的有效地址')
    if (!draftKey && baseUrl && !sameServer(saved.base_url, baseUrl)) return done('fail', '要测试新的服务地址，请先在上面输入对应的 API Key')
    if (!model) return done('fail', kind === 'parse' ? '请先填写拆题用的模型名称' : '请先填写写报告用的模型名称')
  }
  if (!baseUrl) return done('fail', kind === 'vision' ? '请先填写 Base URL（或视觉模型自己的服务地址）' : '请先填写 Base URL')
  if (!key) return done('fail', kind === 'vision' && cfg.vision_base_url.trim() && !sameServer(cfg.base_url, baseUrl) ? '视觉模型用了不同的服务地址，请先填写它自己的 API Key' : '请先填写 API Key')

  const messages: ChatMessage[] = kind === 'vision'
    ? [{ role: 'user', content: [
        { type: 'text', text: '图上写的是哪两个字符？只回复 JSON：{"text":"图上的字符"}' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_PNG}` } }
      ] }]
    : [{ role: 'user', content: '请只回复 JSON：{"ok":true}' }]
  const usageKind = `test-${kind === 'vision' ? 'vision' : 'text'}`
  try {
    const r = await chat({
      baseUrl, apiKey: key, model, messages, temperature: 0, maxTokens: kind === 'vision' ? 256 : 128, jsonMode: true,
      timeoutMs: Math.min(cfg.timeout_sec, 30) * 1000, maxRetries: 1, backoffMs: 800, fetchImpl: net.fetch as unknown as typeof fetch
    })
    recordUsage({ paperId: null, kind: usageKind, model, usage: r.usage, ok: true, ms: Date.now() - t0, attempts: r.attempts })
    if (kind !== 'vision') return done('ok', `连接成功（${r.model}，${Date.now() - t0} 毫秒）`)
    const j = judgeVisionAnswer(r.content)
    return j.sees
      ? done('ok', `能看图（${r.model} 读出了测试图上的字，${Date.now() - t0} 毫秒）`)
      : done('warn', `能连通，但这个模型没有读对测试图上的字（读出的是「${j.text.slice(0, 20) || '空'}」），可能不会看图。请换一个带视觉能力的模型`)
  } catch (e) {
    // 测试用的是很小的输出上限；被截断说明模型有回应，连通性没问题
    if (e instanceof AiError && e.code === 'truncated') return done('ok', `连接成功（${model}，${Date.now() - t0} 毫秒）`)
    recordUsage({ paperId: null, kind: usageKind, model, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
    const x = explainTestError(e, model)
    return done('fail', x.message, { steps: x.steps, detail: x.detail })
  }
}

/** 旧接口：测文本模型（= 写报告用的模型）或视觉模型 */
export async function testConnection(kind: 'text' | 'vision', draft?: TestDraft): Promise<TestResult> {
  return testOne(kind === 'vision' ? 'vision' : 'report', draft)
}

export interface TestAllResult { items: Array<TestResult & { kind: TestKind; label: string }> }

/** 依次测拆题模型、写报告模型、视觉模型；拆题模型与写报告模型相同就不重复测 */
export async function testAll(draft?: TestDraft): Promise<TestAllResult> {
  const cfg = { ...loadConfig(), ...(draft?.cfg ?? {}) }
  const items: TestAllResult['items'] = []
  const push = (kind: TestKind, r: TestResult) => items.push({ ...r, kind, label: KIND_LABEL[kind] })
  const parseR = await testOne('parse', draft)
  push('parse', parseR)
  if (parseModelOf(cfg) === cfg.model.trim()) {
    push('report', { ok: parseR.ok, status: 'skip', kind: 'report', message: '与拆题用的模型相同，不重复测', latencyMs: 0, model: cfg.model.trim() })
  } else {
    push('report', await testOne('report', draft))
  }
  push('vision', await testOne('vision', draft))
  return { items }
}
