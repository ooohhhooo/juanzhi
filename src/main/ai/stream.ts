/**
 * P2 / P3 共用的流式生成：流式增量 → 界面事件（delta / thinking / retry / reset），记住已收到的部分（失败后留作草稿）。
 * 需要 electron（net.fetch 走系统代理），所以不放进纯函数模块。
 */
import { net } from 'electron'
import { chat, AiError } from './client'
import type { ChatResult } from './client'
import { effectiveMaxTokens } from './providers'
import { getApiKey } from './secret'
import type { AiConfig } from './types'
import type { ChunkEvent } from './chunk'

export interface StreamRun {
  run(): Promise<ChatResult>
  /** 到目前为止收到的正文（失败 / 取消时用）；被截断时优先用最后一次尝试的完整内容 */
  partial(error?: unknown): string
  dispose(): void
}

export function createStream(o: { cfg: AiConfig; system: string; user: string; requestId: string; send: (e: ChunkEvent) => void; signal: AbortSignal }): StreamRun {
  const { cfg, requestId, send } = o
  let buf = ''
  let lastPartial = ''   // 失败重试前被清掉的那次尝试里已收到的内容：最终失败 / 取消时界面要能看到
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => { timer = null; if (pending) { send({ id: requestId, type: 'delta', text: pending }); pending = '' } }
  const drop = () => { if (timer) clearTimeout(timer); timer = null; pending = ''; if (buf) lastPartial = buf; buf = '' }
  const lim = effectiveMaxTokens(cfg, cfg.model)
  return {
    run: async () => {
      const r = await chat({
        baseUrl: cfg.base_url, apiKey: getApiKey()!, model: cfg.model, stream: true, temperature: 0.3, maxTokens: lim.maxTokens,
        messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
        timeoutMs: cfg.timeout_sec * 1000, maxRetries: 2, backoffMs: 1000, signal: o.signal, fetchImpl: net.fetch as unknown as typeof fetch,
        escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback,
        onDelta: (t) => { buf += t; pending += t; if (!timer) timer = setTimeout(flush, 40) },
        onThinking: (i) => send({ id: requestId, type: 'thinking', seconds: Math.round(i.ms / 1000), chars: i.chars }),
        onRetry: () => { drop(); send({ id: requestId, type: 'reset' }); send({ id: requestId, type: 'retry', reason: 'length' }) },
        // 失败后要重试：已经推给界面的半截内容作废，从头来
        onAttempt: (a) => {
          if (a.ok) return
          drop()
          if (a.error?.code !== 'aborted') send({ id: requestId, type: 'reset' })
        }
      })
      if (timer) clearTimeout(timer)
      flush()
      return r
    },
    partial: (e) => (e instanceof AiError && e.partial) || buf || lastPartial,
    dispose: () => { if (timer) clearTimeout(timer); timer = null }
  }
}
