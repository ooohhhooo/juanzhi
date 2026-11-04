/**
 * 通用 MCP 连接器：本地命令（stdio）或网址（Streamable HTTP）。动作是服务器自己的工具，所以这里 actions 为空。
 * 密钥（环境变量、请求头、含密钥的参数、网址）都加密存放，界面和日志里只显示名称或域名。
 */
import type { Connector } from './types'
import { withMcp } from './mcp-client'
import { McpConfigSchema, mcpSummary, type McpConfig } from './mcp-config'

export const mcp: Connector = {
  id: 'mcp',
  name: 'MCP 服务器',
  description: '连接任意 MCP 服务器：本机命令或网址，勾选允许助手使用的工具。',
  configSchema: McpConfigSchema,
  secretFields: ['env', 'headers', 'secretArgs', 'url'],
  mask: mcpSummary,
  async test(cfg: McpConfig) {
    try {
      const tools = await withMcp(cfg, c => c.listTools())
      return { ok: true, message: `已连上，找到 ${tools.length} 个工具` }
    } catch (e) { return { ok: false, message: (e as Error).message } }
  },
  actions: []
}
