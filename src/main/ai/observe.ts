/**
 * 把「AI 调用结果」接到运行日志和自适应降速上（chat() 里每次实际发出的请求都会通知）。
 * 日志只写：服务商主机名、模型名、状态码、耗时、token 数——没有密钥、提示词、返回正文。
 */
import { onAiCall } from './client'
import { aiThrottle } from './throttle'
import { log } from '../log'
import { notifyDataChanged } from '../events'
import { pumpParseQueue } from '../parse/queue'

let installed = false
export function installAiObservers(): void {
  if (installed) return
  installed = true
  onAiCall(e => {
    if (e.ok) {
      log.info('ai', '调用成功', { host: e.host, model: e.model, ms: e.latencyMs, promptTokens: e.promptTokens, completionTokens: e.completionTokens })
      if (aiThrottle.onSuccess()) { log.info('ai', '限速恢复一路'); notifyDataChanged('queue'); pumpParseQueue() }
      return
    }
    log.warn('ai', '调用失败', { host: e.host, model: e.model, ms: e.latencyMs, status: e.status ?? undefined, code: e.code ?? undefined })
    if (e.code === 'rate_limit') {
      if (aiThrottle.onRateLimit(e.retryAfterMs)) log.warn('ai', '服务商限速，已自动放慢')
      notifyDataChanged('queue')
    }
  })
}
