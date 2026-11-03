/** 企业微信群机器人连接器。动作：send_text / send_markdown / send_file。 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ActionCtx, ActionResult, Connector } from './types'
import { checkSendAllowed } from './send-guard.ts'
import { WECOM_MAX_FILE, explainWecomError, isTestLocalAllowed, markdownSegments, parseWebhook, redactKey, textSegments } from './wecom-core'

export const WecomConfigSchema = z.object({
  webhook: z.string().trim().max(400).refine(v => !!parseWebhook(v, isTestLocalAllowed()), '地址格式不对，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…')
})
type Cfg = z.infer<typeof WecomConfigSchema>

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function postJson(cfg: Cfg, body: unknown): Promise<ActionResult> {
  const w = parseWebhook(cfg.webhook, isTestLocalAllowed())
  if (!w) return { ok: false, message: '机器人地址格式不对' }
  try {
    const res = await fetch(`${w.base}/cgi-bin/webhook/send?key=${encodeURIComponent(w.key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    })
    const j = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null
    if (!j) return { ok: false, message: `企业微信没有正常回应（HTTP ${res.status}）` }
    if (j.errcode === 0) return { ok: true, message: '已发送' }
    return { ok: false, message: explainWecomError(j.errcode ?? -1, j.errmsg) }
  } catch (e) {
    return { ok: false, message: `连不上企业微信：${redactKey((e as Error).message)}` }
  }
}

async function sendSegments(cfg: Cfg, segs: string[], make: (s: string) => unknown): Promise<ActionResult> {
  if (!segs.length) return { ok: false, message: '内容是空的' }
  for (let i = 0; i < segs.length; i++) {
    const r = await postJson(cfg, make(segs[i]))
    if (!r.ok) return { ok: false, message: segs.length > 1 ? `第 ${i + 1}/${segs.length} 段没发出去：${r.message}` : r.message }
    if (i < segs.length - 1) await sleep(400)
  }
  return { ok: true, message: segs.length > 1 ? `已发送（分 ${segs.length} 段）` : '已发送' }
}

const BLOCKED_FILE = /(^|[\\/])(db\.sqlite[^\\/]*|\.ssh|\.env[^\\/]*|id_rsa[^\\/]*|ewb-config\.json)([\\/]|$)/i

/** 发文件前的检查，返回错误文字或 null；size 一并返回 */
export function checkSendableFile(p: string, scope: ActionCtx = {}, opts: { consume?: boolean; strict?: boolean } = {}): { error: string | null; size: number; name: string } {
  const name = path.basename(p)
  try {
    if (!path.isAbsolute(p)) return { error: '请提供完整的文件路径', size: 0, name }
    if (BLOCKED_FILE.test(p)) return { error: '这个文件不能发送', size: 0, name }
    const denied = checkSendAllowed(p, scope, opts)
    if (denied) return { error: denied, size: 0, name }
    const st = fs.statSync(p)
    if (!st.isFile()) return { error: '不是文件', size: 0, name }
    if (st.size > WECOM_MAX_FILE) return { error: `文件 ${(st.size / 1048576).toFixed(1)}MB，超过企业微信 20MB 的上限`, size: st.size, name }
    if (st.size <= 5) return { error: '文件太小（企业微信要求大于 5 字节）', size: st.size, name }
    return { error: null, size: st.size, name }
  } catch { return { error: '找不到这个文件', size: 0, name } }
}

async function sendFile(cfg: Cfg, filePath: string, ctx: ActionCtx): Promise<ActionResult> {
  const chk = checkSendableFile(filePath, ctx, { consume: true })
  if (chk.error) return { ok: false, message: chk.error }
  const w = parseWebhook(cfg.webhook, isTestLocalAllowed())!
  try {
    const fd = new FormData()
    fd.append('media', new Blob([fs.readFileSync(filePath)]), chk.name)
    const res = await fetch(`${w.base}/cgi-bin/webhook/upload_media?key=${encodeURIComponent(w.key)}&type=file`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })
    const j = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string; media_id?: string } | null
    if (!j) return { ok: false, message: `上传时企业微信没有正常回应（HTTP ${res.status}）` }
    if (j.errcode !== 0 || !j.media_id) return { ok: false, message: explainWecomError(j.errcode ?? -1, j.errmsg) }
    const r = await postJson(cfg, { msgtype: 'file', file: { media_id: j.media_id } })
    return r.ok ? { ok: true, message: `文件已发送：${chk.name}` } : r
  } catch (e) {
    return { ok: false, message: `连不上企业微信：${redactKey((e as Error).message)}` }
  }
}

export const wecom: Connector = {
  id: 'wecom',
  name: '企业微信群机器人',
  description: '把文字、报告、文件发到企业微信群。在群里添加「群机器人」，复制它的 Webhook 地址即可。',
  configSchema: WecomConfigSchema,
  secretFields: ['webhook'],
  mask: c => String(c.webhook ?? '').replace(/key=([A-Za-z0-9-]{4})[A-Za-z0-9-]*/, 'key=$1****'),
  test: cfg => sendSegments(cfg, ['卷知连接测试'], s => ({ msgtype: 'text', text: { content: s } })),
  actions: [
    {
      name: 'send_text', description: '发送文字消息',
      params: z.object({ content: z.string().min(1), mentionAll: z.boolean().optional() }),
      run: (a: { content: string; mentionAll?: boolean }, cfg: Cfg) =>
        sendSegments(cfg, textSegments(a.content), s => ({ msgtype: 'text', text: { content: s, ...(a.mentionAll ? { mentioned_list: ['@all'] } : {}) } }))
    },
    {
      name: 'send_markdown', description: '发送 Markdown（自动转成企业微信支持的写法，太长会分段）',
      params: z.object({ content: z.string().min(1) }),
      run: (a: { content: string }, cfg: Cfg) => sendSegments(cfg, markdownSegments(a.content), s => ({ msgtype: 'markdown', markdown: { content: s } }))
    },
    {
      name: 'send_file', description: '发送文件（不超过 20MB）',
      params: z.object({ path: z.string().min(1) }),
      run: (a: { path: string }, cfg: Cfg, ctx: ActionCtx) => sendFile(cfg, a.path, ctx ?? {})
    }
  ]
}
