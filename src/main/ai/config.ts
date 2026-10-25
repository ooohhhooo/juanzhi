import { net } from 'electron'
import { getDb } from '../db'
import { AiConfigSchema, DEFAULT_AI_CONFIG } from './types'
import type { AiConfig, AiConfigView } from './types'
import { getApiKey, hasStoredKey, keyStorage, saveApiKey } from './secret'
import { chat, AiError } from './client'
import type { ChatMessage, Usage } from './client'
import { isHttpUrl, sameServer } from './guard'
import { makeSolidPng } from './png'

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
  return { ...loadConfig(), hasKey: storage !== 'none', keyStorage: storage }
}

/**
 * apiKey: undefined = 不改；null 或空串 = 清除；其余 = 替换。
 *
 * 已保存的密钥只会发往它当初配套的服务：地址的来源（协议+主机+端口）变了、或者已存地址是空/非法的，
 * 都必须同时重新输入密钥——否则页面脚本即使被攻破，也没法把已存的密钥重定向到别的主机去。
 */
export function saveConfig(cfg: AiConfig, apiKey?: string | null): AiConfigView {
  const parsed = AiConfigSchema.parse(cfg)
  const url = parsed.base_url.trim()
  if (url && !isHttpUrl(url)) throw new Error('Base URL 必须是以 http:// 或 https:// 开头的有效地址')
  const settingKey = typeof apiKey === 'string' && apiKey.trim() !== ''
  if (settingKey && !url) throw new Error('请先填写 Base URL，再保存 API Key')
  if (apiKey === undefined && hasStoredKey() && !sameServer(loadConfig().base_url, url)) {
    throw new Error('更换服务地址（或地址为空）后需要重新输入 API Key（已保存的密钥不会被发往新的地址）')
  }
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(CONFIG_KEY, JSON.stringify({
    ...parsed, base_url: url, model: parsed.model.trim(), vision_model: parsed.vision_model.trim()
  }))
  if (apiKey !== undefined) saveApiKey(apiKey)
  return configView()
}

/** 文本解析是否已具备条件：有地址、模型和密钥 */
export function isAiReady(): boolean {
  const c = loadConfig()
  return !!(c.base_url && c.model && getApiKey())
}

/** 把一次调用的用量记到 ai_usage（paper_id 故意不设外键：删除试卷后费用统计仍要保留） */
export function recordUsage(row: { paperId: string | null; kind: string; model: string; usage?: Usage; ok: boolean }): void {
  try {
    getDb().prepare(`INSERT INTO ai_usage (paper_id, kind, model, prompt_tokens, completion_tokens, cached_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.paperId, row.kind, row.model, row.usage?.promptTokens ?? 0, row.usage?.completionTokens ?? 0, row.usage?.cachedTokens ?? 0, row.ok ? 1 : 0)
  } catch (e) {
    console.warn('[ai] 记录用量失败:', (e as Error).message)
  }
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs: number
  model: string
}

// 视觉模型连通性测试用的图：128×128 纯色（1×1 之类的小图会被部分服务商直接拒收，让用户误以为配置有错）
const TEST_PNG = makeSolidPng(128, 128).toString('base64')

/** 连接测试：用已保存的配置（draft 可临时覆盖地址/模型/密钥，用于「保存前先测」）发一个最小请求 */
export async function testConnection(kind: 'text' | 'vision', draft?: { cfg?: Partial<AiConfig>; apiKey?: string }): Promise<TestResult> {
  const cfg = { ...loadConfig(), ...(draft?.cfg ?? {}) }
  const key = draft?.apiKey?.trim() || getApiKey()
  const model = kind === 'vision' ? cfg.vision_model : cfg.model
  const t0 = Date.now()
  // 已保存的密钥不用于测试别的服务地址（同 saveConfig 的理由）；要测新地址就得带上对应的密钥
  if (cfg.base_url && !isHttpUrl(cfg.base_url)) return { ok: false, message: 'Base URL 必须是以 http:// 或 https:// 开头的有效地址', latencyMs: 0, model }
  if (!draft?.apiKey?.trim() && cfg.base_url && !sameServer(loadConfig().base_url, cfg.base_url)) {
    return { ok: false, message: '要测试新的服务地址，请先在上面输入对应的 API Key', latencyMs: 0, model }
  }
  const fail = (message: string): TestResult => ({ ok: false, message, latencyMs: Date.now() - t0, model })
  if (!cfg.base_url) return fail('请先填写 Base URL')
  if (!model) return fail(kind === 'vision' ? '请先填写视觉模型名称' : '请先填写模型名称')
  if (!key) return fail('请先填写 API Key')

  const messages: ChatMessage[] = kind === 'vision'
    ? [{ role: 'user', content: [
        { type: 'text', text: '这是一张测试图片。请只回复 JSON：{"ok":true}' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_PNG}` } }
      ] }]
    : [{ role: 'user', content: '请只回复 JSON：{"ok":true}' }]
  try {
    const r = await chat({
      baseUrl: cfg.base_url, apiKey: key, model, messages, temperature: 0, maxTokens: 128, jsonMode: true,
      timeoutMs: Math.min(cfg.timeout_sec, 30) * 1000, maxRetries: 1, backoffMs: 800, fetchImpl: net.fetch as unknown as typeof fetch
    })
    recordUsage({ paperId: null, kind: `test-${kind}`, model, usage: r.usage, ok: true })
    return { ok: true, message: `连接成功（${r.model}，${Date.now() - t0} 毫秒）`, latencyMs: Date.now() - t0, model: r.model }
  } catch (e) {
    // 测试用的是 128 token 的小请求；被截断说明模型有回应，连通性没问题
    if (e instanceof AiError && e.code === 'truncated') return { ok: true, message: `连接成功（${model}，${Date.now() - t0} 毫秒）`, latencyMs: Date.now() - t0, model }
    recordUsage({ paperId: null, kind: `test-${kind}`, model, ok: false })
    return fail(e instanceof AiError ? e.message : (e as Error).message)
  }
}
