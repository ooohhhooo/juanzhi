import { redact } from './guard.ts'

/**
 * OpenAI 兼容 chat/completions 客户端：流式与非流式、超时、对 429/5xx/网络错误做指数退避重试、
 * 空 content 重试、记录 token 用量。不依赖 electron（fetch 由调用方注入，应用里用 net.fetch 以走系统代理）。
 */

export type AiErrorCode =
  | 'auth' | 'rate_limit' | 'server' | 'timeout' | 'network' | 'bad_request' | 'empty' | 'truncated' | 'aborted' | 'not_found'

/** 带给用户看的中文原因；detail 是原始信息，只进日志不直接展示 */
export class AiError extends Error {
  code: AiErrorCode
  status: number | null
  detail: string
  constructor(code: AiErrorCode, message: string, status: number | null = null, detail = '') {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export interface ImagePart { type: 'image_url'; image_url: { url: string } }
export interface TextPart { type: 'text'; text: string }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<TextPart | ImagePart>
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** response_format: json_object；服务商不支持时自动去掉重试一次 */
  jsonMode?: boolean
  stream?: boolean
  onDelta?: (text: string) => void
  /** 单次请求的超时（毫秒）；流式时指「两次数据之间」的最长空闲 */
  timeoutMs?: number
  /** 最多重试几次（不含首次），默认 3 */
  maxRetries?: number
  /** 退避起点（毫秒），默认 1000，指数增长并加抖动 */
  backoffMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** 每次实际发出请求后回调（含重试），用于记录用量/日志 */
  onAttempt?: (info: { attempt: number; ok: boolean; error?: AiError; usage?: Usage }) => void
}

export interface ChatResult {
  content: string
  finishReason: string
  usage: Usage
  model: string
  attempts: number
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AiError('aborted', '已取消')) }, { once: true })
})

export function chatUrl(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`
}

function statusError(status: number, body: string, secret = ''): AiError {
  // 响应片段会展示给用户并写进 papers.error，先脱敏
  // 先对整段响应脱敏、再截断：密钥正好跨在截断点上时，不会只剩一段认不出来的前缀漏出去
  const snippet = redact(body.replace(/\s+/g, ' '), [secret]).slice(0, 300)
  if (status === 401 || status === 403) return new AiError('auth', `API Key 无效或没有权限（HTTP ${status}），请检查密钥与所选服务商是否匹配`, status, snippet)
  if (status === 404) return new AiError('not_found', `接口或模型不存在（HTTP 404），请检查 Base URL 与模型名称`, status, snippet)
  if (status === 408) return new AiError('timeout', '服务端返回请求超时（HTTP 408）', status, snippet)
  if (status === 429) return new AiError('rate_limit', '请求太频繁或额度不足（HTTP 429），稍后重试，或检查账户余额', status, snippet)
  if (status >= 500) return new AiError('server', `服务商暂时不可用（HTTP ${status}）`, status, snippet)
  return new AiError('bad_request', `请求被拒绝（HTTP ${status}）：${snippet.slice(0, 160) || '无详情'}`, status, snippet)
}

function parseUsage(u: any): Usage {
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(u?.completion_tokens ?? 0) || 0,
    // DeepSeek: prompt_cache_hit_tokens；OpenAI 兼容: prompt_tokens_details.cached_tokens
    cachedTokens: Number(u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0) || 0
  }
}

async function once(req: ChatRequest, jsonMode: boolean, sendTemperature: boolean): Promise<Omit<ChatResult, 'attempts'>> {
  const f = req.fetchImpl ?? fetch
  const ctl = new AbortController()
  const idleMs = req.timeoutMs ?? 120_000
  let timedOut = false
  let timer = setTimeout(() => { timedOut = true; ctl.abort() }, idleMs)
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort() }, idleMs) }
  const onAbort = () => ctl.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: !!req.stream
    }
    if (sendTemperature && req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (jsonMode) body.response_format = { type: 'json_object' }
    if (req.stream) body.stream_options = { include_usage: true }

    let res: Response
    try {
      res = await f(chatUrl(req.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
        // 不跟随重定向：不依赖运行时在跨源跳转时剥掉 Authorization，直接杜绝密钥被重定向走
        redirect: 'error'
      })
    } catch (e) {
      if (req.signal?.aborted) throw new AiError('aborted', '已取消')
      if (timedOut) throw new AiError('timeout', `模型响应超时（超过 ${Math.round(idleMs / 1000)} 秒没有返回）`)
      throw new AiError('network', `无法连接到服务：${(e as Error).message}。请检查网络、代理和 Base URL`, null, String(e))
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = statusError(res.status, text, req.apiKey)
      // 429 与 5xx（常见 503）都可能带 Retry-After（秒数）
      const ra = Number(res.headers.get('retry-after'))
      if ((res.status === 429 || res.status >= 500) && ra > 0) (err as AiError & { retryAfterMs?: number }).retryAfterMs = Math.min(ra * 1000, 30_000)
      throw err
    }

    if (!req.stream) {
      let json: any
      try {
        json = JSON.parse(await res.text())
      } catch (e) {
        if (timedOut) throw new AiError('timeout', `模型响应超时（超过 ${Math.round(idleMs / 1000)} 秒没有返回）`)
        throw new AiError('server', '服务商返回的不是合法的 JSON 响应', res.status, String(e))
      }
      const choice = json?.choices?.[0]
      return {
        content: String(choice?.message?.content ?? ''),
        finishReason: String(choice?.finish_reason ?? ''),
        usage: parseUsage(json?.usage),
        model: String(json?.model ?? req.model)
      }
    }

    // 流式：解析 SSE，每个 data: 行是一个 JSON 增量
    const reader = res.body?.getReader()
    if (!reader) throw new AiError('server', '服务商没有返回数据流')
    const dec = new TextDecoder()
    let buf = ''
    let content = ''
    let finish = ''
    let usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
    let model = req.model
    let sawDone = false
    // 一行 SSE：只认 data: 行；[DONE] 记下来；其余按 JSON 增量处理
    const handleLine = (raw: string) => {
      const line = raw.trim()
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') { sawDone = true; return }
      if (!data) return
      let j: any
      try { j = JSON.parse(data) } catch { return }
      if (j.model) model = String(j.model)
      if (j.usage) usage = parseUsage(j.usage)
      const c = j.choices?.[0]
      const delta = c?.delta?.content
      if (typeof delta === 'string' && delta) {
        content += delta
        req.onDelta?.(delta)
      }
      if (c?.finish_reason) finish = String(c.finish_reason)
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bump()
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          handleLine(line)
        }
      }
      // 最后一行没有结尾换行（网关/代理偶有这样的）：残留在缓冲里的也要当一行处理，否则正常结束会被误判成中断
      buf += dec.decode()
      if (buf.trim()) handleLine(buf)
    } catch (e) {
      if (req.signal?.aborted) throw new AiError('aborted', '已取消')
      if (timedOut) throw new AiError('timeout', `模型响应超时（超过 ${Math.round(idleMs / 1000)} 秒没有新数据）`)
      throw new AiError('network', `数据流中断：${(e as Error).message}`, null, String(e))
    }
    // 连接被对端「正常关闭」但既没有 finish_reason 也没有 [DONE]：网关/代理超时、服务商中途掐断时常见。
    // 此时内容是半截的，必须当作中断（可重试），不能当成完整结果交给调用方。
    if (!finish && !sawDone) {
      throw new AiError('network', `数据流意外结束（服务端提前关闭了连接，没有收到结束标记），已收到的 ${content.length} 字不完整`, null, 'eof-without-finish')
    }
    return { content, finishReason: finish, usage, model }
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

const RETRYABLE = new Set<AiErrorCode>(['rate_limit', 'server', 'timeout', 'network'])

/** 发一次对话；网络/限流/5xx 指数退避重试，空 content 同参数重试，其余错误直接抛出 */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const maxRetries = req.maxRetries ?? 3
  const base = req.backoffMs ?? 1000
  let jsonMode = !!req.jsonMode
  let sendTemperature = true
  let attempt = 0
  let emptyRetried = false

  for (;;) {
    attempt++
    try {
      const r = await once(req, jsonMode, sendTemperature)
      req.onAttempt?.({ attempt, ok: true, usage: r.usage })
      if (r.finishReason === 'length') {
        throw new AiError('truncated', '模型输出被长度上限截断（内容太多），需要把这一批拆小', null, `${r.content.length} 字`)
      }
      if (!r.content.trim()) {
        if (!emptyRetried) { emptyRetried = true; continue }
        throw new AiError('empty', '模型返回了空内容（重试后仍为空）')
      }
      return { ...r, attempts: attempt }
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
      if (err.code !== 'truncated' && err.code !== 'empty') req.onAttempt?.({ attempt, ok: false, error: err })
      // 服务商不认 response_format：去掉后重试（不计入重试次数）
      if (err.code === 'bad_request' && jsonMode && /response_format|json_object|json_schema/i.test(err.detail)) {
        jsonMode = false
        attempt--
        continue
      }
      // 部分思考模型只接受默认 temperature，会 400：去掉后重试（不占重试次数）
      if (err.code === 'bad_request' && sendTemperature && req.temperature !== undefined && /temperature/i.test(err.detail)) {
        sendTemperature = false
        attempt--
        continue
      }
      if (err.code === 'aborted' || req.signal?.aborted) throw err
      if (RETRYABLE.has(err.code) && attempt <= maxRetries) {
        const hinted = (err as AiError & { retryAfterMs?: number }).retryAfterMs
        const wait = hinted ?? base * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4)
        await sleep(wait, req.signal)
        continue
      }
      throw err
    }
  }
}
