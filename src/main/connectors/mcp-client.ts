/**
 * 最小 MCP 客户端：stdio（按行分隔的 JSON-RPC 2.0）和网址方式（Streamable HTTP，旧版 HTTP+SSE 自动回退）。
 * 只做 initialize、tools/list、tools/call。不依赖 electron。每次用到时连接，用完关闭；超时与退出时都会清理。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface McpServerSpec {
  command?: string; args?: string[]
  /** 含密钥的参数（如应用密钥），拼在 args 之后；报错信息里会被遮蔽 */
  secretArgs?: string[]
  env?: Record<string, string>; cwd?: string
  /** 填了 url 就走网址方式；headers 是附加请求头（如 Authorization） */
  url?: string; headers?: Record<string, string>
}
export interface McpTool { name: string; description: string; inputSchema: unknown; /** 服务器声明这是只读工具（annotations.readOnlyHint） */ readOnly?: boolean }
/** withMcp 里能用到的接口：stdio 与网址两种客户端都实现 */
export interface McpSession {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>
  listTools(timeoutMs?: number): Promise<McpTool[]>
  callTool(name: string, args: unknown, timeoutMs?: number): Promise<{ isError: boolean; text: string }>
  close(): void
}

const PROTOCOL = '2024-11-05'
const live = new Set<{ close(): void }>()

/** 应用退出时调用：关掉所有还在跑的子进程 */
export function closeAllMcp(): void { for (const c of [...live]) c.close() }

export function encodeMessage(msg: unknown): string { return JSON.stringify(msg) + '\n' }

/** 按行切 JSON-RPC 消息；返回解析出的消息和剩余的半行 */
export function decodeLines(buf: string): { messages: any[]; rest: string } {
  const parts = buf.split('\n')
  const rest = parts.pop() ?? ''
  const messages: any[] = []
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    try { messages.push(JSON.parse(t)) } catch { /* 非 JSON 的输出（日志）忽略 */ }
  }
  return { messages, rest }
}

/** 子进程环境：只带必要的系统变量 + 用户配的变量，不继承卷知自己的环境 */
export function buildEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'SHELL', 'COMSPEC', 'PATHEXT']
  const env: Record<string, string> = {}
  for (const k of keep) if (base[k]) env[k] = base[k] as string
  return { ...env, ...extra }
}

/** stdio 与网址客户端共用的 tools/list、tools/call */
abstract class McpBase {
  abstract request(method: string, params: unknown, timeoutMs?: number): Promise<any>
  abstract close(): void

  async listTools(timeoutMs = 20000): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)
      for (const t of r?.tools ?? []) tools.push({ name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object' }, ...(t.annotations?.readOnlyHint === true ? { readOnly: true } : {}) })
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: unknown, timeoutMs = 60000): Promise<{ isError: boolean; text: string }> {
    const r = await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
    const text = (r?.content ?? []).map((c: any) => (c?.type === 'text' ? String(c.text) : `[${c?.type ?? '内容'}]`)).join('\n')
    return { isError: !!r?.isError, text }
  }

}

export class McpClient extends McpBase {
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private stderrTail = ''
  private closed = false
  private secrets: string[]

  private spec: McpServerSpec

  constructor(spec: McpServerSpec) { super(); this.spec = spec; this.secrets = [...Object.values(spec.env ?? {}), ...(spec.secretArgs ?? [])].filter(v => v.length >= 4) }

  private redact(s: string): string { let o = s; for (const v of this.secrets) o = o.split(v).join('****'); return o }

  async start(timeoutMs = 20000): Promise<void> {
    const { command = '', args = [], secretArgs = [], env = {}, cwd } = this.spec
    this.proc = spawn(command, [...args, ...secretArgs], { stdio: ['pipe', 'pipe', 'pipe'], env: buildEnv(env), cwd, shell: process.platform === 'win32', windowsHide: true })
    live.add(this)
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (d: string) => {
      this.buf += d
      const { messages, rest } = decodeLines(this.buf)
      this.buf = rest
      for (const m of messages) this.onMessage(m)
    })
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000) })
    this.proc.stdin!.on('error', () => undefined)
    const failAll = (why: string): void => {
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id) }
    }
    this.proc.on('error', e => { failAll(`没能启动：${this.redact(e.message)}`); this.close() })
    this.proc.on('exit', code => { failAll(`服务器已退出（${code ?? '被终止'}）${this.stderrTail ? '：' + this.redact(this.stderrTail.trim().slice(-300)) : ''}`); this.closed = true; live.delete(this) })
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'juanzhi', version: '1' } }, timeoutMs)
    this.notify('notifications/initialized')
  }

  private onMessage(m: any): void {
    if (m && m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer); this.pending.delete(m.id)
      if (m.error) p.reject(new Error(this.redact(String(m.error.message ?? '服务器返回错误'))))
      else p.resolve(m.result)
    } else if (m && m.id != null && m.method) {
      // 服务器发来的请求：卷知什么都不提供
      this.send({ jsonrpc: '2.0', id: m.id, ...(m.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) })
    }
  }

  private send(msg: unknown): void { if (this.proc?.stdin?.writable) this.proc.stdin.write(encodeMessage(msg)) }
  private notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) }

  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed || !this.proc) return Promise.reject(new Error('连接已关闭'))
    const id = this.nextId++
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`等待 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  close(): void {
    if (this.closed && !this.proc) return
    this.closed = true
    live.delete(this)
    const p = this.proc
    this.proc = null
    for (const [id, x] of this.pending) { clearTimeout(x.timer); x.reject(new Error('连接已关闭')); this.pending.delete(id) }
    if (!p) return
    try { p.stdin?.end() } catch { /* 忽略 */ }
    try { p.kill('SIGTERM') } catch { /* 忽略 */ }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* 忽略 */ } }, 2000)
    t.unref()
    p.once('exit', () => clearTimeout(t))
  }
}

// ───────────────────────── 网址方式（Streamable HTTP + 旧版 SSE 回退） ─────────────────────────

export interface SseEvent { event: string; data: string }

/** 解析 SSE 文本流：返回完整事件和剩余的半个事件 */
export function parseSseEvents(buf: string): { events: SseEvent[]; rest: string } {
  const text = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = text.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: SseEvent[] = []
  for (const block of parts) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

class HttpStatusError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const HTTP_PROTOCOL = '2025-06-18'

export class McpHttpClient extends McpBase {
  private spec: McpServerSpec
  private url: string
  private postUrl: string
  private mode: 'streamable' | 'sse' = 'streamable'
  private sessionId = ''
  private protocol = HTTP_PROTOCOL
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private ac = new AbortController()
  private closed = false
  private secrets: string[]
  private fetchImpl: typeof fetch
  private onEndpoint: ((u: string) => void) | null = null

  constructor(spec: McpServerSpec, fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)) {
    super()
    this.spec = spec
    this.url = spec.url ?? ''
    this.postUrl = this.url
    this.fetchImpl = fetchImpl
    const s = new Set<string>([this.url])
    try { for (const v of new URL(this.url).searchParams.values()) s.add(v) } catch { /* 网址无效时在连接时报错 */ }
    for (const v of Object.values(spec.headers ?? {})) { s.add(v); for (const w of v.split(/\s+/)) s.add(w) }
    this.secrets = [...s].filter(v => v.length >= 4)
  }

  private redact(t: string): string { let o = t; for (const v of this.secrets) o = o.split(v).join('****'); return o }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...(this.spec.headers ?? {}), ...extra }
    if (this.sessionId) { h['Mcp-Session-Id'] = this.sessionId; h['MCP-Protocol-Version'] = this.protocol }
    return h
  }

  private failAll(why: string): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id) }
  }

  private netError(e: unknown): Error {
    if (e instanceof HttpStatusError) return new Error(this.redact(e.message))
    const err = e as Error & { cause?: { code?: string; message?: string } }
    if (err?.name === 'AbortError') return new Error('连接已关闭')
    if (err && !('cause' in err) && /超时|没有|断开|关闭|域名/.test(err.message)) return new Error(this.redact(err.message))
    const why = err?.cause?.code || err?.cause?.message || err?.message || '未知原因'
    let host = ''
    try { host = new URL(this.url).host } catch { /* 无效网址 */ }
    return new Error(this.redact(`连不上${host ? ' ' + host : '服务器'}：${why}`))
  }

  async start(timeoutMs = 20000): Promise<void> {
    live.add(this)
    if (!/^https?:\/\//i.test(this.url)) throw new Error('网址要以 http:// 或 https:// 开头')
    const init = { protocolVersion: HTTP_PROTOCOL, capabilities: {}, clientInfo: { name: 'juanzhi', version: '1' } }
    try {
      try {
        await this.request('initialize', init, timeoutMs)
      } catch (e) {
        // 旧版服务器不认 POST 到该地址：改用 HTTP+SSE（先 GET 开流，服务器告知 POST 地址）
        if (!(e instanceof HttpStatusError) || ![400, 404, 405].includes(e.status) || this.sessionId) throw e
        await this.startLegacySse(timeoutMs)
        await this.request('initialize', init, timeoutMs)
      }
    } catch (e) { throw this.netError(e) }
    this.notify('notifications/initialized')
  }

  private async startLegacySse(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const ready = new Promise<string>((resolve, reject) => {
      this.onEndpoint = resolve
      timer = setTimeout(() => reject(new Error('旧版服务器没有返回消息地址（等待超时）')), timeoutMs)
    })
    const res = await this.fetchImpl(this.url, { method: 'GET', headers: this.headers({ Accept: 'text/event-stream' }), signal: this.ac.signal })
    if (!res.ok || !res.body) throw new HttpStatusError(res.status, `服务器返回 ${res.status}`)
    this.mode = 'sse'
    const gone = (): void => { if (!this.closed) this.failAll('服务器断开了连接') }
    void this.consume(res.body, null).then(gone, gone)
    try { this.postUrl = await ready } finally { clearTimeout(timer) }
  }

  /** 读 SSE 流，每个 JSON 事件交给 onMessage；legacy 流里的 endpoint 事件给出 POST 地址 */
  private async consume(body: ReadableStream<Uint8Array>, requestId: number | null): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const { events, rest } = parseSseEvents(buf)
        buf = rest
        for (const ev of events) this.onSseEvent(ev)
      }
      if (buf.trim()) for (const ev of parseSseEvents(buf + '\n\n').events) this.onSseEvent(ev)
    } finally { try { reader.releaseLock() } catch { /* 忽略 */ } }
    if (requestId != null) this.rejectIfPending(requestId, '服务器在返回结果前断开了连接')
  }

  private rejectIfPending(id: number, why: string): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer); this.pending.delete(id)
    p.reject(new Error(why))
  }

  private onSseEvent(ev: SseEvent): void {
    if (ev.event === 'endpoint' && this.onEndpoint) {
      try {
        const u = new URL(ev.data, this.url)
        if (u.origin !== new URL(this.url).origin) throw new Error('消息地址和服务器不在同一个域名')
        this.onEndpoint(u.href)
      } catch { /* 无效地址：等待超时报错 */ }
      this.onEndpoint = null
      return
    }
    try { this.onMessage(JSON.parse(ev.data)) } catch { /* 非 JSON 事件忽略 */ }
  }

  private onMessage(m: any): void {
    if (Array.isArray(m)) { for (const x of m) this.onMessage(x); return }
    if (m && m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer); this.pending.delete(m.id)
      if (m.error) p.reject(new Error(this.redact(String(m.error.message ?? '服务器返回错误'))))
      else p.resolve(m.result)
    } else if (m && m.id != null && m.method) {
      // 服务器发来的请求：卷知什么都不提供
      void this.post({ jsonrpc: '2.0', id: m.id, ...(m.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) }, null).catch(() => undefined)
    }
  }

  /** POST 一条消息；响应是 JSON 或 SSE 时就地分发（请求的结果通过 pending 回来） */
  private async post(msg: unknown, requestId: number | null): Promise<void> {
    const res = await this.fetchImpl(this.postUrl, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(msg),
      signal: this.ac.signal
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid && this.mode === 'streamable') this.sessionId = sid
    if (!res.ok) {
      let snippet = ''
      try { snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 160) } catch { /* 忽略 */ }
      const hint = res.status === 401 || res.status === 403 ? '（认证没通过，检查令牌或请求头）' : ''
      throw new HttpStatusError(res.status, `服务器返回 ${res.status}${hint}${snippet ? '：' + snippet : ''}`)
    }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream') && res.body) {
      void this.consume(res.body, requestId).catch(() => undefined)
    } else if (ct.includes('json')) {
      const j = await res.json().catch(() => null)
      if (j) this.onMessage(j)
      if (requestId != null) this.rejectIfPending(requestId, '服务器的回复里没有结果')
    } else { try { await res.body?.cancel() } catch { /* 忽略 */ } }
  }

  private notify(method: string): void {
    void this.post({ jsonrpc: '2.0', method }, null).catch(() => undefined)
  }

  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('连接已关闭'))
    const id = this.nextId++
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`等待 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ jsonrpc: '2.0', id, method, params }, id).catch(e => {
        const p = this.pending.get(id)
        if (!p) return
        clearTimeout(p.timer); this.pending.delete(id)
        // 状态码错误原样抛出，start() 要据此决定是否回退旧版
        p.reject(e instanceof HttpStatusError ? e : this.netError(e))
      })
    }).then(r => {
      if (method === 'initialize' && r?.protocolVersion) this.protocol = String(r.protocolVersion)
      return r
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    live.delete(this)
    this.failAll('连接已关闭')
    if (this.sessionId && this.mode === 'streamable') {
      const headers = this.headers()
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 2000).unref()
      void this.fetchImpl(this.url, { method: 'DELETE', headers, signal: ctl.signal }).catch(() => undefined)
    }
    this.ac.abort()
  }
}

/** 启动 → 执行 → 一定关闭。spec.url 有值走网址方式，否则走 stdio */
export async function withMcp<T>(spec: McpServerSpec, fn: (c: McpSession) => Promise<T>, startTimeoutMs = 20000): Promise<T> {
  const c: McpSession & { start(t?: number): Promise<void> } = spec.url ? new McpHttpClient(spec) : new McpClient(spec)
  try { await c.start(startTimeoutMs); return await fn(c) } finally { c.close() }
}

/** 名字转成工具名里能用的片段 */
export function toolSlug(s: string, fallback: string): string {
  const v = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  return v || fallback
}
export const mcpToolName = (server: string, tool: string, fallback: string): string => `mcp_${toolSlug(server, fallback)}_${toolSlug(tool, 'tool')}`

/** slug 之后可能重名（「a-b」和「a_b」都变成 a_b）：先加连接 id 前几位，还重就加序号。登记进 used */
export function uniqueToolName(base: string, id: string, used: Set<string>): string {
  let n = base
  if (used.has(n)) n = `${base}_${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toLowerCase()}`
  for (let i = 2; used.has(n); i++) n = `${base}_${i}`
  used.add(n)
  return n
}
