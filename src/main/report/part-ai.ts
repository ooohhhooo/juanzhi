/**
 * 报告附加段（口诀 / 变形题 / 以后的课程对照……）调用 AI 的统一入口：非流式、要求 JSON、记用量。
 * 失败抛 AiError，由调用方（parts-run）转成「这一段失败」的白话说明；日志只记错误码，不记提示词和返回内容。
 * 密钥只走 getApiKey()（safeStorage 解密），这里不读取、不打印。
 */
import { net } from 'electron'
import { AiError, chat } from '../ai/client'
import type { Usage } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { effectiveMaxTokens } from '../ai/providers'

export interface PartChatResult { content: string; model: string; usage: Usage }

/**
 * @param kind 记在 ai_usage 里的用途名（如 p3_tricks）
 * @param model 不传就用「写报告用的模型」（设置里的 model）
 */
export async function partChat(o: { system: string; user: string; kind: string; signal?: AbortSignal; model?: string }): Promise<PartChatResult> {
  const cfg = loadConfig()
  const key = getApiKey()
  if (!cfg.base_url || !cfg.model || !key) throw new AiError('auth', '尚未配置 AI 服务')
  const model = o.model || cfg.model
  const lim = effectiveMaxTokens(cfg, model)
  const t0 = Date.now()
  try {
    const r = await chat({
      baseUrl: cfg.base_url, apiKey: key, model, stream: false, jsonMode: true, temperature: 0.4, maxTokens: lim.maxTokens,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      timeoutMs: cfg.timeout_sec * 1000, maxRetries: 2, backoffMs: 1000, signal: o.signal, fetchImpl: net.fetch as unknown as typeof fetch,
      escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback
    })
    recordUsage({ paperId: null, kind: o.kind, model: r.model, usage: r.usage, ok: true, ms: Date.now() - t0, attempts: r.attempts })
    return { content: r.content, model: r.model, usage: r.usage }
  } catch (e) {
    if (!(e instanceof AiError && e.code === 'aborted')) recordUsage({ paperId: null, kind: o.kind, model, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
    throw e
  }
}
