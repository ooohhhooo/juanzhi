/** MCP 连接配置的结构与展示摘要（纯函数，不依赖 electron / 子进程，单元测试可直接引用）。 */
import { z } from 'zod'

export const McpConfigSchema = z.object({
  transport: z.enum(['stdio', 'http']).default('stdio'),
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(2000)).max(50).default([]),
  /** 含密钥的参数，拼在 args 之后 */
  secretArgs: z.array(z.string().max(2000)).max(20).default([]),
  env: z.record(z.string().max(5000)).default({}),
  url: z.string().trim().max(2000).optional(),
  headers: z.record(z.string().max(5000)).default({}),
  /** 来自哪个预设（只用于显示） */
  preset: z.string().max(40).optional()
}).superRefine((c, ctx) => {
  if (c.transport === 'stdio') {
    if (!c.command) ctx.addIssue({ code: 'custom', path: ['command'], message: '请填写命令' })
  } else {
    let ok = false
    try { const u = new URL(c.url ?? ''); ok = u.protocol === 'http:' || u.protocol === 'https:' } catch { /* 无效网址 */ }
    if (!ok) ctx.addIssue({ code: 'custom', path: ['url'], message: '网址要以 http:// 或 https:// 开头' })
    for (const [k, v] of Object.entries(c.headers)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) ctx.addIssue({ code: 'custom', path: ['headers'], message: `请求头名称不合法：${k}` })
      if (/[\r\n]/.test(v)) ctx.addIssue({ code: 'custom', path: ['headers'], message: '请求头的值不能换行' })
    }
  }
})
export type McpConfig = z.infer<typeof McpConfigSchema>

/** 界面上的一句话：本地命令显示命令 + 非密钥参数；网址只显示域名（路径和参数里常有密钥） */
export function mcpSummary(c: Partial<McpConfig>): string {
  if (c.transport === 'http' || (c.url && !c.command)) {
    try { return `${new URL(c.url ?? '').origin}/…` } catch { return '' }
  }
  const hidden = (c.secretArgs ?? []).length
  return `${c.command ?? ''} ${(c.args ?? []).join(' ')}${hidden ? `（另有 ${hidden} 个参数已隐藏）` : ''}`.trim()
}
