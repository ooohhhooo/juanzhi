/**
 * 给隐藏渲染窗口「按需读文件」用的登记表：把本地文件路径换成一次性令牌，窗口里的 pdf.js 经 ewb://pdfsrc/<令牌> 用 Range 请求分块读取，
 * 内存里不会出现整本文件（旧做法是整本 base64 塞进脚本字符串，V8 字符串有上限、还要多占几倍内存）。
 * 纯函数（不依赖 electron），单测直接加载。
 */
import crypto from 'node:crypto'

const sources = new Map<string, string>()

/** 登记一个文件，返回令牌；用完要 releasePdfSource */
export function registerPdfSource(filePath: string): string {
  const token = crypto.randomUUID()
  sources.set(token, filePath)
  return token
}
export function releasePdfSource(token: string): void { sources.delete(token) }
export function pdfSourcePath(token: string): string | null { return sources.get(token) ?? null }

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
