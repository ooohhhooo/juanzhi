import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { CONNECTORS, getConnector } from '../connectors/registry'
import { fullConfig, listViews, removeEntry, saveEntry, setAllowed, setTools } from '../connectors/store'
import { withMcp } from '../connectors/mcp-client'
import { getConnectorTools } from '../connectors/tools'
import { redactKey } from '../connectors/wecom-core'
import { log } from '../log'

const SaveSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().max(40),
  name: z.string().max(60),
  config: z.record(z.unknown())
})

export function registerConnectorsIpc(): void {
  // 仅自动化测试：让测试进程能直接调用 Agent 工具（正式运行不存在）
  if (process.env.EWB_TEST_HOOKS === '1') (globalThis as any).__ewbConnectorTools = getConnectorTools

  ipcMain.handle('connectors:types', async () => CONNECTORS.map(c => ({ id: c.id, name: c.name, description: c.description })))
  ipcMain.handle('connectors:list', async () => listViews())
  ipcMain.handle('connectors:save', async (_e, raw: unknown) => saveEntry(SaveSchema.parse(raw)))
  ipcMain.handle('connectors:remove', async (_e, id: unknown) => { removeEntry(z.string().uuid().parse(id)); return true })
  ipcMain.handle('connectors:setAllowed', async (_e, id: unknown, names: unknown) => setAllowed(z.string().uuid().parse(id), z.array(z.string().max(200)).max(500).parse(names)))

  /** 测试连接：企业微信会往群里发「卷知连接测试」；MCP 会启动服务器并刷新工具列表 */
  ipcMain.handle('connectors:test', async (_e, rawId: unknown) => {
    const id = z.string().uuid().parse(rawId)
    const f = fullConfig(id)
    if (!f) throw new Error('找不到这个连接')
    const c = getConnector(f.entry.type)
    if (!c) throw new Error('不支持的连接器类型')
    let result: { ok: boolean; message: string }
    try {
      if (c.id === 'mcp') {
        const tools = await withMcp(f.config, cl => cl.listTools())
        setTools(id, tools)
        result = { ok: true, message: `已连上，找到 ${tools.length} 个工具` }
      } else result = await c.test(f.config)
    } catch (e) { result = { ok: false, message: redactKey((e as Error).message) } }
    log.info('connectors', `测试 ${c.id}：${result.ok ? '成功' : '失败'}`)
    return { ...result, message: redactKey(result.message), connectors: listViews() }
  })

  // 石墨：只打开官网（支持导入 Word、Markdown 文件），不写具体私有地址
  ipcMain.handle('connectors:openShimo', async () => { await shell.openExternal('https://shimo.im'); return true })
}
