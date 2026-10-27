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
  /** 被截断（truncated）时已经收到的正文：失败后留作「未完成草稿」 */
  partial = ''
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
  /** 其中用于「思考」的输出 token（服务商给了才有；completionTokens 已包含它） */
  reasoningTokens?: number
}

/** 推理模型的思考进度：只统计字数和耗时，思考内容本身不保存、不展示 */
export interface ThinkingInfo { chars: number; ms: number }

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
  /** 推理模型在输出 reasoning_content 时回调（节流：约每秒一次，第一次立即）；不计入正文 */
  onThinking?: (info: ThinkingInfo) => void
  /**
   * 输出被长度上限截断（finish_reason=length）时：把 max_tokens 翻倍（不超过 ceiling）自动重试一次。
   * ceiling ≤ 当前 maxTokens 时不重试。重试前回调 onRetry，界面据此提示「输出内容较长，正在自动加长篇幅重试」。
   */
  escalateOnLength?: { ceiling: number }
  onRetry?: (info: { reason: 'length'; maxTokens: number; previousMaxTokens: number }) => void
  /**
   * 「自动」上限猜错了：服务商拒绝了第一次请求的 max_tokens（400，报错里提到 max_tokens / 超出范围）时，降到这个安全值重试一次。
   * 只给自动模式用——管理员手填的值被拒绝是他该知道的事，不替他改。
   */
  maxTokensFallback?: number
  /** 一次调用（含所有重试、加长重试）的总时限，毫秒；默认 20 分钟。超过就报超时，不再重试 */
  maxTotalMs?: number
}

export interface ChatResult {
  content: string
  finishReason: string
  usage: Usage
  model: string
  attempts: number
  /** 思考内容的字数（0 = 不是推理模型或服务商没返回） */
  reasoningChars: number
  /** 这次请求实际用的 max_tokens（可能是翻倍重试后的） */
  maxTokensUsed: number | null
  /** 是否因为被截断而自动加大了上限重试过 */
  escalated: boolean
  /** 服务商拒绝了第一次的 max_tokens，自动降到这个值重试成功的（没有发生就是 null） */
  fellBackTo: number | null
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
  const r = Number(u?.completion_tokens_details?.reasoning_tokens ?? 0) || 0
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(u?.completion_tokens ?? 0) || 0,
    // DeepSeek: prompt_cache_hit_tokens；OpenAI 兼容: prompt_tokens_details.cached_tokens
    cachedTokens: Number(u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0) || 0,
    ...(r > 0 ? { reasoningTokens: r } : {})
  }
}

type OnceResult = Omit<ChatResult, 'attempts' | 'maxTokensUsed' | 'escalated' | 'fellBackTo'>

async function once(req: ChatRequest, jsonMode: boolean, sendTemperature: boolean, maxTokens: number | undefined, deadline: number): Promise<OnceResult> {
  const f = req.fetchImpl ?? fetch
  const ctl = new AbortController()
  const idleMs = req.timeoutMs ?? 120_000
  let timedOut = false
  let totalExceeded = false
  let timer = setTimeout(() => { timedOut = true; ctl.abort() }, idleMs)
  // 总时限：模型一直断断续续地写（每次间隔都没超过空闲时限）也不能无限等下去
  const totalTimer = setTimeout(() => { timedOut = true; totalExceeded = true; ctl.abort() }, Math.max(1, deadline - Date.now()))
  const timeoutError = (what: string) => totalExceeded
    ? new AiError('timeout', `模型写了太久（一次调用总共超过 ${Math.round((req.maxTotalMs ?? DEFAULT_TOTAL_MS) / 60000)} 分钟），已停止`, null, 'total-timeout')
    : new AiError('timeout', `模型响应超时（超过 ${Math.round(idleMs / 1000)} 秒${what}）`)
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
    if (maxTokens) body.max_tokens = maxTokens
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
      if (timedOut) throw timeoutError('没有返回')
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
        if (timedOut) throw timeoutError('没有返回')
        throw new AiError('server', '服务商返回的不是合法的 JSON 响应', res.status, String(e))
      }
      const choice = json?.choices?.[0]
      const rc = choice?.message?.reasoning_content ?? choice?.message?.reasoning
      return {
        content: String(choice?.message?.content ?? ''),
        finishReason: String(choice?.finish_reason ?? ''),
        usage: parseUsage(json?.usage),
        model: String(json?.model ?? req.model),
        reasoningChars: typeof rc === 'string' ? rc.length : 0
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
    // 推理模型先输出 reasoning_content（思考），再输出 content（正文）：思考不计入正文，只数字数、给界面显示进度
    let reasoningChars = 0
    const t0 = Date.now()
    let lastThink = 0
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
      const rd = c?.delta?.reasoning_content ?? c?.delta?.reasoning
      if (typeof rd === 'string' && rd) {
        reasoningChars += rd.length
        const now = Date.now()
        if (req.onThinking && (lastThink === 0 || now - lastThink >= 1000)) { lastThink = now; req.onThinking({ chars: reasoningChars, ms: now - t0 }) }
      }
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
      reader.cancel().catch(() => { /* 连接已经断了 */ })   // 出错时把读取端释放掉（handleLine 里的回调抛错也走这里）
      if (req.signal?.aborted) throw new AiError('aborted', '已取消')
      if (timedOut) throw timeoutError('没有新数据')
      throw new AiError('network', `数据流中断：${(e as Error).message}`, null, String(e))
    }
    // 连接被对端「正常关闭」但既没有 finish_reason 也没有 [DONE]：网关/代理超时、服务商中途掐断时常见。
    // 此时内容是半截的，必须当作中断（可重试），不能当成完整结果交给调用方。
    if (!finish && !sawDone) {
      throw new AiError('network', `数据流意外结束（服务端提前关闭了连接，没有收到结束标记），已收到的 ${content.length} 字不完整`, null, 'eof-without-finish')
    }
    return { content, finishReason: finish, usage, model, reasoningChars }
  } finally {
    clearTimeout(timer)
    clearTimeout(totalTimer)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

const DEFAULT_TOTAL_MS = 20 * 60_000
/** 写在 truncated 错误的 detail 里的标记：没有加长重试是因为总时限不够（friendly.ts 据此换一句更准确的话） */
export const NO_TIME_TO_RETRY = 'no-time-to-retry'
const RETRYABLE = new Set<AiErrorCode>(['rate_limit', 'server', 'timeout', 'network'])

/** 发一次对话；网络/限流/5xx 指数退避重试，空 content 同参数重试，其余错误直接抛出 */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const maxRetries = req.maxRetries ?? 3
  const base = req.backoffMs ?? 1000
  let jsonMode = !!req.jsonMode
  let sendTemperature = true
  let attempt = 0
  let emptyRetried = false
  let maxTokens = req.maxTokens
  let escalated = false
  let fellBack: number | null = null
  let lastTruncated: AiError | null = null
  const deadline = Date.now() + (req.maxTotalMs ?? DEFAULT_TOTAL_MS)

  for (;;) {
    attempt++
    const startedAt = Date.now()
    try {
      const r = await once(req, jsonMode, sendTemperature, maxTokens, deadline)
      req.onAttempt?.({ attempt, ok: true, usage: r.usage })
      if (r.finishReason === 'length') {
        const why = `finish_reason=length；max_tokens=${maxTokens ?? '默认'}；正文 ${r.content.length} 字；思考 ${r.reasoningChars} 字${r.usage.reasoningTokens ? `（${r.usage.reasoningTokens} tokens）` : ''}${escalated ? '；已自动加大上限重试过' : ''}`
        const te = new AiError('truncated', '模型输出被长度上限截断（内容太多）', null, why)
        te.partial = r.content
        throw te
      }
      if (!r.content.trim()) {
        if (!emptyRetried) { emptyRetried = true; continue }
        throw new AiError('empty', '模型返回了空内容（重试后仍为空）', null, `reasoning ${r.reasoningChars} 字；finish_reason=${r.finishReason || '无'}`)
      }
      return { ...r, attempts: attempt, maxTokensUsed: maxTokens ?? null, escalated, fellBackTo: fellBack }
    } catch (e) {
      let err = e instanceof AiError ? e : new AiError('network', (e as Error).message)
      if (err.code === 'truncated') lastTruncated = err
      const lastMs = Date.now() - startedAt
      // 被长度上限截断：上限翻倍（不超过模型的天花板）再来一次；只试一次
      // 加长重试最多要写到上一次的两倍长：剩余总时限不够跑完它就不开始（开始了也必然死在总时限上，白白多花一次钱），直接按「没写完」报错，已写出的部分留作草稿
      const wouldEscalate = err.code === 'truncated' && !escalated && req.escalateOnLength && maxTokens && req.escalateOnLength.ceiling > maxTokens
      if (wouldEscalate && deadline - Date.now() < lastMs * 2) {
        err.detail += `；剩余总时限 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒，不够再加长重试一次（上一次用了 ${Math.round(lastMs / 1000)} 秒）[${NO_TIME_TO_RETRY}]`
        throw err
      }
      if (err.code === 'truncated' && !escalated && req.escalateOnLength && maxTokens && req.escalateOnLength.ceiling > maxTokens) {
        const next = Math.min(req.escalateOnLength.ceiling, maxTokens * 2)
        req.onRetry?.({ reason: 'length', maxTokens: next, previousMaxTokens: maxTokens })
        maxTokens = next
        escalated = true
        attempt--   // 不占网络重试的次数
        continue
      }
      // 「自动」上限猜错了：第一次请求就被服务商拒绝（max_tokens 超出它的范围）→ 降到安全值重试一次，不当成最终失败
      if (err.code === 'bad_request' && !escalated && fellBack === null && req.maxTokensFallback && maxTokens && req.maxTokensFallback < maxTokens
        && /max_tokens|max tokens|maximum|too large|out of range|exceed|上限|最大/i.test(err.detail + err.message)) {
        fellBack = req.maxTokensFallback
        maxTokens = fellBack
        attempt--
        continue
      }
      // 加大上限后服务商直接拒绝（它的上限比我们以为的小）：不要把这个 400 当成最终错误，回到「写不完」这个真正的原因
      if (escalated && err.code === 'bad_request' && /max_tokens|max tokens|maximum|too large|out of range|context/i.test(err.detail + err.message) && lastTruncated) {
        lastTruncated.detail += `；加大到 ${maxTokens} 后被服务商拒绝（${err.detail.slice(0, 120)}）`
        err = lastTruncated
      }
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
      if (err.code === 'timeout' && err.detail === 'total-timeout') throw err
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
