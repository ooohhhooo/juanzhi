/**
 * 最小 MCP 客户端：只支持 stdio（按行分隔的 JSON-RPC 2.0）。initialize、tools/list、tools/call。
 * 不依赖 electron。每次用到时启动子进程，用完关闭；超时与退出时都会杀进程。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface McpServerSpec { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
export interface McpTool { name: string; description: string; inputSchema: unknown }

const PROTOCOL = '2024-11-05'
const live = new Set<McpClient>()

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

export class McpClient {
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private stderrTail = ''
  private closed = false
  private secrets: string[]

  private spec: McpServerSpec

  constructor(spec: McpServerSpec) { this.spec = spec; this.secrets = Object.values(spec.env ?? {}).filter(v => v.length >= 4) }

  private redact(s: string): string { let o = s; for (const v of this.secrets) o = o.split(v).join('****'); return o }

  async start(timeoutMs = 20000): Promise<void> {
    const { command, args = [], env = {}, cwd } = this.spec
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildEnv(env), cwd, shell: process.platform === 'win32', windowsHide: true })
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`等待 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async listTools(timeoutMs = 20000): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)
      for (const t of r?.tools ?? []) tools.push({ name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object' } })
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

/** 启动 → 执行 → 一定关闭 */
export async function withMcp<T>(spec: McpServerSpec, fn: (c: McpClient) => Promise<T>, startTimeoutMs = 20000): Promise<T> {
  const c = new McpClient(spec)
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
