/**
 * 给隐藏渲染窗口「按需读文件」用的登记表：把本地文件路径换成一次性令牌，窗口里的 pdf.js 经 ewb://pdfsrc/<令牌> 用 Range 请求分块读取，
 * 内存里不会出现整本文件（旧做法是整本 base64 塞进脚本字符串，V8 字符串有上限、还要多占几倍内存）。
 * 纯函数（不依赖 electron），单测直接加载。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

/** 令牌 10 分钟没有被访问就失效（正常的读取一直在访问它；窗口崩了、任务异常退出时不会留下永久可读的令牌） */
export const PDF_SOURCE_TTL_MS = 10 * 60 * 1000
const sources = new Map<string, { path: string; last: number }>()

function sweep(now: number): void {
  for (const [t, v] of sources) if (now - v.last > PDF_SOURCE_TTL_MS) sources.delete(t)
}

/** 登记一个文件，返回令牌；用完要 releasePdfSource。登记时顺手清掉过期的 */
export function registerPdfSource(filePath: string, now = Date.now()): string {
  sweep(now)
  const token = crypto.randomUUID()
  sources.set(token, { path: filePath, last: now })
  return token
}
export function releasePdfSource(token: string): void { sources.delete(token) }
/** 取令牌对应的文件；过期返回 null（并删掉）；每次取都算一次访问，延长有效期 */
export function pdfSourcePath(token: string, now = Date.now()): string | null {
  const v = sources.get(token)
  if (!v) return null
  if (now - v.last > PDF_SOURCE_TTL_MS) { sources.delete(token); return null }
  v.last = now
  return v.path
}
/** 现在登记着几个令牌（测试用） */
export const pdfSourceCount = (): number => sources.size

/** 解析 Range 请求头（只支持单个区间）。返回 null = 没有 / 不支持；'bad' = 区间不合法（应回 416） */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number, end: number
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'bad'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  if (!(start <= end) || start >= size) return 'bad'
  return { start, end }
}

/** 文件大小；读不到（被移走 / 占用）给白话原因 */
export function pdfFileSize(filePath: string): number {
  try { return fs.statSync(filePath).size } catch { throw new Error('读取 PDF 文件失败：文件找不到或被占用，请重试') }
}

/** 把 pdf.js / 读取失败的英文原因翻成给用户看的话 */
export function translatePdfError(raw: string): string {
  if (/password/i.test(raw)) return 'PDF 已加密，无法读取（请先去除密码保护）'
  if (/HTTP \d+/.test(raw)) return '读取 PDF 文件失败：文件可能被移动或占用，请重试'
  if (/invalid pdf|missing pdf|unexpected server response|formaterror/i.test(raw)) {
    return '不是有效的 PDF 文件，或文件已损坏'
  }
  return `PDF 渲染失败：${raw}`
}
