/** 通用 MCP 连接器（stdio）。配置 = 命令 + 参数 + 环境变量；动作是服务器自己的工具，所以这里 actions 为空。 */
import { z } from 'zod'
import type { Connector } from './types'
import { withMcp } from './mcp-client'

export const McpConfigSchema = z.object({
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2000)).max(50).default([]),
  env: z.record(z.string().max(5000)).default({})
})
export type McpConfig = z.infer<typeof McpConfigSchema>

export const mcp: Connector = {
  id: 'mcp',
  name: 'MCP 服务器',
  description: '给高级用户：连接本机运行的 MCP 服务器（命令方式），勾选允许 Agent 使用的工具。',
  configSchema: McpConfigSchema,
  secretFields: ['env'],
  mask: c => `${c.command} ${(c.args ?? []).join(' ')}`.trim(),
  async test(cfg: McpConfig) {
    try {
      const tools = await withMcp(cfg, c => c.listTools())
      return { ok: true, message: `已连上，找到 ${tools.length} 个工具` }
    } catch (e) { return { ok: false, message: (e as Error).message } }
  },
  actions: []
}
