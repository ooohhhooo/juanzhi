/**
 * 运行日志的核心（不依赖 electron，单测直接加载）：脱敏 + 带大小上限的滚动文件。
 * 原则：日志只记「发生了什么、花了多久、状态码、token 数」，不记密钥、提示词、AI 返回的正文、学生或试卷内容。
 * 脱敏是兜底：调用方本来就不该把这些东西交给日志。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redact } from './ai/guard.ts'

/** 单条日志最长字数：再长的一律截断（防止把整段 AI 返回或题干误写进来） */
export const MAX_LINE_CHARS = 400

const EXT = '(?:pdf|jpe?g|png|heic|docx?|zip|txt|json|csv|md)'
/** 路径整段换成 <path>（保留扩展名）：盘符路径、UNC 路径、/ 开头的绝对路径；文件名里有空格也整段处理 */
function maskPaths(input: string): string {
  const keepExt = (m: string) => { const e = /\.([A-Za-z0-9]{1,5})$/.exec(m); return e ? `<path>.${e[1]}` : '<path>' }
  let out = input
  // 带已知扩展名的：允许中间有空格（文件名常有空格）
  out = out.replace(new RegExp(`[A-Za-z]:\\\\[^"'<>|*?\\n]*?\\.${EXT}\\b`, 'gi'), keepExt)
  out = out.replace(new RegExp(`\\\\\\\\[^"'<>|*?\\n\\\\]+\\\\[^"'<>|*?\\n]*?\\.${EXT}\\b`, 'gi'), keepExt)
  out = out.replace(new RegExp(`(?<![\\w:/.])/(?:[^"'<>|*?\\n/]+/)+[^"'<>|*?\\n]*?\\.${EXT}\\b`, 'gi'), keepExt)
  // 没有扩展名的（目录等）：到空白为止
  out = out.replace(/[A-Za-z]:\\[^\s"'<>|*?]*/g, '<path>')
  out = out.replace(/\\\\[^\s"'<>|*?\\]+\\[^\s"'<>|*?]*/g, '<path>')
  out = out.replace(/(?<![\w:/.])\/(?:[^\s"'<>|*?/]+\/)+[^\s"'<>|*?]*/g, '<path>')
  return out
}

/** 把一段文字变成可以安全落盘的样子：去密钥、路径整段隐藏、网址只留主机名、截断 */
export function sanitize(text: string, secrets: string[] = [], home = os.homedir()): string {
  let out = redact(String(text), secrets)
  // 网址只留主机名（路径、参数、带 / 的用户信息都去掉）；先于路径处理，免得 //host/ 被当成路径
  out = out.replace(/\bhttps?:\/\/(?:[^\s@'"]*@)?([^\s/'"）)?#]+)[^\s'"）)]*/gi, (_m, host: string) => `http://${host}`)
  out = maskPaths(out)
  if (home && home.length > 2) out = out.split(home).join('~')
  // 用户目录名（可含空格）
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/]+/g, '$1~').replace(/(\/Users\/|\/home\/)[^/]+/g, '$1~')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > MAX_LINE_CHARS ? `${out.slice(0, MAX_LINE_CHARS)}…(已截断)` : out
}

/**
 * console.* 的内容不能原样落盘：冒号（：或 ": "）或竖线之后往往是错误原文，里面可能有 AI 返回的题干、文件名、服务商响应。
 * 只保留第一个分隔符之前的「发生了什么」，再截到 60 字。
 */
export function reduceConsoleMessage(text: string): string {
  const cut = text.search(/：|:\s|\s\|\s|\n/)
  const head = cut >= 0 ? text.slice(0, cut) : text
  return head.length > 60 ? `${head.slice(0, 60)}…` : head
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogWriterOptions {
  dir: string
  /** 单个文件的上限，默认 2 MB */
  maxBytes?: number
  /** 保留的文件个数（含当前），默认 5 */
  maxFiles?: number
  /** 取当前要额外抹掉的密钥（每次写入时取，密钥可能刚被改过） */
  secrets?: () => string[]
  now?: () => Date
}

const pad = (n: number) => String(n).padStart(2, '0')
export const fmtTime = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/** 字段只允许数字 / 布尔 / 短字符串；其余类型丢弃。字符串也会经过 sanitize */
function fieldsText(fields: Record<string, unknown> | undefined, secrets: string[]): string {
  if (!fields) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
    else if (typeof v === 'string') parts.push(`${k}=${sanitize(v, secrets).slice(0, 120)}`)
  }
  return parts.length ? ` {${parts.join(' ')}}` : ''
}

/** 滚动日志：juanzhi.log 是当前文件，满了就依次改名成 juanzhi.1.log … juanzhi.<n-1>.log，最旧的丢弃。写不进去静默忽略 */
export function createLogWriter(opts: LogWriterOptions) {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  const maxFiles = Math.max(1, opts.maxFiles ?? 5)
  const now = opts.now ?? (() => new Date())
  const file = (i: number) => path.join(opts.dir, i === 0 ? 'juanzhi.log' : `juanzhi.${i}.log`)
  let size = -1

  function ensure(): void {
    if (size >= 0) return
    fs.mkdirSync(opts.dir, { recursive: true })
    try { size = fs.statSync(file(0)).size } catch { size = 0 }
  }
  function rotate(): void {
    try { fs.rmSync(file(maxFiles - 1), { force: true }) } catch { /* 忽略 */ }
    for (let i = maxFiles - 2; i >= 0; i--) {
      try { if (fs.existsSync(file(i))) fs.renameSync(file(i), file(i + 1)) } catch { /* 忽略 */ }
    }
    size = 0
  }

  function write(level: LogLevel, tag: string, message: string, fields?: Record<string, unknown>): void {
    try {
      ensure()
      const secrets = opts.secrets?.() ?? []
      const line = `${fmtTime(now())} ${level.toUpperCase().padEnd(5)} ${sanitize(tag, secrets).slice(0, 40)} ${sanitize(message, secrets)}${fieldsText(fields, secrets)}\n`
      const bytes = Buffer.byteLength(line)
      if (size > 0 && size + bytes > maxBytes) rotate()
      fs.appendFileSync(file(0), line)
      size += bytes
    } catch { /* 日志写不进去不能影响业务 */ }
  }
  /** 当前所有日志文件，新的在前 */
  function files(): string[] {
    const out: string[] = []
    for (let i = 0; i < maxFiles; i++) if (fs.existsSync(file(i))) out.push(file(i))
    return out
  }
  return { write, files, dir: opts.dir }
}
export type LogWriter = ReturnType<typeof createLogWriter>
