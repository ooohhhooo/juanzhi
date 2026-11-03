/**
 * 检测当前模型是否支持工具调用（function calling）：发一个极小的带工具请求，看返回里能不能解析出 tool_calls。
 * 结果按「服务地址 + 模型名」缓存在 settings（由 service 负责读写），不支持时助手页直接说明并建议换模型。
 */
import { AiError, chat } from '../ai/client.ts'
import type { ChatRequest, ToolSpec } from '../ai/client.ts'

export const probeKey = (baseUrl: string, model: string): string => `agent_tool_support:${baseUrl.trim().replace(/\/+$/, '')}|${model.trim()}`

const PING: ToolSpec = {
  type: 'function',
  function: { name: 'ping', description: '测试用：回显一个词', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }
}

export interface ProbeResult { supported: boolean; reason: 'ok' | 'no_tool_calls' | 'rejected'; detail?: string }

/**
 * 支持 → supported: true。服务商 400 拒绝 tools 字段 / 返回了文字但没有 tool_calls → supported: false。
 * 其它错误（密钥无效、没网、余额不足……）和工具调用无关，原样抛出，不缓存。
 */
export async function probeToolSupport(base: Omit<ChatRequest, 'messages' | 'tools' | 'toolChoice' | 'stream' | 'maxTokens'>, chatImpl: typeof chat = chat): Promise<ProbeResult> {
  try {
    const r = await chatImpl({
      ...base, temperature: 0, maxTokens: 200, maxRetries: base.maxRetries ?? 1,
      messages: [{ role: 'user', content: '请调用 ping 工具，参数 word 填 "ok"。只调用工具，不要回复别的话。' }],
      tools: [PING], toolChoice: 'auto'
    })
    const hit = r.toolCalls.find(t => t.function.name === 'ping')
    if (!hit) return { supported: false, reason: 'no_tool_calls', detail: r.content.slice(0, 100) }
    try { JSON.parse(hit.function.arguments || '{}') } catch { return { supported: false, reason: 'no_tool_calls', detail: '参数不是合法 JSON' } }
    return { supported: true, reason: 'ok' }
  } catch (e) {
    if (e instanceof AiError && e.code === 'bad_request') return { supported: false, reason: 'rejected', detail: e.detail.slice(0, 160) }
    throw e
  }
}
