/** 企业微信群机器人：地址校验、Markdown 转换、分段、错误码白话。纯函数，不依赖 electron。 */

const PROD_HOST = 'qyapi.weixin.qq.com'
export const WECOM_MAX_FILE = 20 * 1024 * 1024
export const WECOM_MD_BYTES = 4096
export const WECOM_TEXT_BYTES = 2048

/** 仅测试时（EWB_TEST_HOOKS=1）允许指向本机假服务器 */
export function isTestLocalAllowed(env: NodeJS.ProcessEnv = process.env): boolean { return env.EWB_TEST_HOOKS === '1' }

/** 地址合法时返回 base 与 key；否则 null */
export function parseWebhook(raw: string, allowLocal = false): { base: string; key: string } | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  const key = u.searchParams.get('key') || ''
  if (u.pathname !== '/cgi-bin/webhook/send' || !/^[A-Za-z0-9-]{8,80}$/.test(key)) return null
  if (u.protocol === 'https:' && u.hostname === PROD_HOST && !u.port && !u.username && !u.password) return { base: `https://${PROD_HOST}`, key }
  if (allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1') return { base: `http://127.0.0.1:${u.port}`, key }
  return null
}

/** 界面 / 日志脱敏：任何 key=… 都抹掉 */
export const redactKey = (s: string): string => s.replace(/key=[A-Za-z0-9-]+/g, 'key=****')
export const maskWebhook = (raw: string): string => raw.replace(/key=([A-Za-z0-9-]{4})[A-Za-z0-9-]*/g, 'key=$1****')

const ERR: Record<number, string> = {
  93000: '机器人地址无效，可能已被删除，请到群里重新添加机器人并复制新地址',
  40001: '机器人密钥不对，请检查地址是不是完整复制',
  40058: '发送的内容不合法（可能为空或太长）',
  40008: '消息类型不被支持',
  40004: '文件类型不被支持',
  40007: '文件已过期或无效，请重新发送',
  41006: '没有拿到文件编号，请重试',
  44004: '内容是空的，没有可发送的文字',
  45001: '文件太大，企业微信限制 20MB',
  45009: '发得太快了，企业微信限制每个机器人每分钟 20 条，请稍后再试'
}
export function explainWecomError(errcode: number, errmsg = ''): string {
  if (ERR[errcode]) return ERR[errcode]
  return `企业微信返回错误 ${errcode}${errmsg ? `：${redactKey(errmsg)}` : ''}`
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

const isSepRow = (l: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(l)

/** 通用 Markdown → 企业微信 markdown 支持的子集（标题、加粗、链接、引用、行内代码、字体颜色） */
export function toWecomMarkdown(md: string): string {
  const out: string[] = []
  let inCode = false
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const inline = (s: string): string => s
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, a: string, u: string) => `[${a || '图片'}](${u})`)
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/__(.+?)__/g, '**$1**')
    .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)\*(?![*\w])/g, '$1')
    .replace(/(?<![_\w])_(?![\s_])([^_\n]+?)_(?![_\w])/g, '$1')
    .replace(/<(?!\/?font\b)[^>]+>/g, '')
  const indent = (s: string): string => '　'.repeat(Math.floor(s.replace(/\t/g, '  ').length / 2))
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l)) { inCode = !inCode; continue }
    if (inCode) { out.push(l.trim() ? `> ${l}` : '>'); continue }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (isSepRow(l)) continue
      const cells = l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const isHead = isSepRow(lines[i + 1] ?? '')
      out.push(inline(isHead ? cells.map(c => (c ? `**${c.replace(/\*\*/g, '')}**` : c)).join(' | ') : cells.join(' | ')))
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('——————'); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { out.push(`${'#'.repeat(Math.min(h[1].length, 3))} ${inline(h[2])}`); continue }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(l)
    if (li) { out.push(`${indent(li[1])}• ${inline(li[2])}`); continue }
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(l)
    if (ol) { out.push(`${indent(ol[1])}${ol[2]}. ${inline(ol[3])}`); continue }
    out.push(inline(l))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 按字节上限切段：按行累积，单行太长再按字符切 */
export function splitByBytes(text: string, limit: number): string[] {
  if (bytes(text) <= limit) return [text]
  const parts: string[] = []
  let cur = ''
  const push = (): void => { if (cur.trim()) parts.push(cur.replace(/\n+$/, '')); cur = '' }
  for (const line of text.split('\n')) {
    if (bytes(line) + 1 > limit) {
      push()
      let chunk = ''
      for (const ch of line) { if (bytes(chunk + ch) > limit) { parts.push(chunk); chunk = '' } chunk += ch }
      cur = chunk + '\n'
      continue
    }
    if (bytes(cur + line + '\n') > limit) push()
    cur += line + '\n'
  }
  push()
  return parts
}

const PREFIX_ROOM = 24

function numbered(segs: string[]): string[] {
  return segs.length <= 1 ? segs : segs.map((s, i) => `（${i + 1}/${segs.length}）\n${s}`)
}

/** 转换并分段；多段时每段前加（1/3）。每段不超过 4096 字节 */
export function markdownSegments(md: string, limit = WECOM_MD_BYTES): string[] {
  const conv = toWecomMarkdown(md)
  if (!conv) return []
  if (bytes(conv) <= limit) return [conv]
  return numbered(splitByBytes(conv, limit - PREFIX_ROOM))
}

export function textSegments(text: string, limit = WECOM_TEXT_BYTES): string[] {
  const t = text.trim()
  if (!t) return []
  if (bytes(t) <= limit) return [t]
  return numbered(splitByBytes(t, limit - PREFIX_ROOM))
}
