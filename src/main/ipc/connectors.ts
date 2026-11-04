import { dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { CONNECTORS, getConnector } from '../connectors/registry'
import { fullConfig, listViews, removeEntry, saveEntry, setAllowed, setLastTest, setTools } from '../connectors/store'
import { withMcp } from '../connectors/mcp-client'
import { getConnectorTools } from '../connectors/tools'
import { redactKey } from '../connectors/wecom-core'
import { getPreset } from '../../shared/connector-presets'
import { log } from '../log'
import { getMainWindow } from '../window'
import { allowSendOnce } from '../connectors/send-guard'

const SaveSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().max(40),
  name: z.string().max(60),
  config: z.record(z.unknown())
})

/** MCP 配置等于「让卷知在本机运行一条命令」或「连到一个网址」：保存 / 测试前必须让用户在原生对话框里看到命令、参数（或网址域名）和密钥项名称并确认，密钥值不显示。EWB_TEST_HOOKS=1 时自动通过 */
async function confirmMcpRun(cfg: Record<string, unknown>, what: '保存' | '测试'): Promise<boolean> {
  if (process.env.EWB_TEST_HOOKS === '1') return true
  const envNames = Object.keys((cfg.env as Record<string, unknown>) ?? {})
  const headerNames = Object.keys((cfg.headers as Record<string, unknown>) ?? {})
  const remote = cfg.transport === 'http'
  let detail: string
  if (remote) {
    let host = ''
    try { host = new URL(String(cfg.url ?? '')).origin } catch { /* 无效网址 */ }
    detail = [`服务器：${host || '（无效网址）'}（路径和参数已隐藏）`, `请求头（只列名称）：${headerNames.length ? headerNames.join('、') : '（无）'}`].join('\n')
  } else {
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
    const hidden = Array.isArray(cfg.secretArgs) ? cfg.secretArgs.length : 0
    detail = [`命令：${String(cfg.command ?? '')}`, `参数：${args.length ? args.map(a => JSON.stringify(a)).join(' ') : '（无）'}${hidden ? `（另有 ${hidden} 个参数已隐藏）` : ''}`, `环境变量（只列名称）：${envNames.length ? envNames.join('、') : '（无）'}`].join('\n')
  }
  const opts: Electron.MessageBoxOptions = {
    type: 'warning', buttons: [`确认${what}`, '取消'], defaultId: 1, cancelId: 1, noLink: true,
    title: remote ? '确认 MCP 网址' : '确认 MCP 命令',
    message: remote
      ? (what === '测试' ? '测试会连到下面这个服务器。只在你信任它时继续。' : '保存后，助手可以连到下面这个服务器，并在你确认后把内容发给它。只在你信任它时继续。')
      : (what === '测试' ? '测试会在本机运行下面这条命令。只在你信任它时继续。' : '保存后，卷知会在本机运行下面这条命令。只在你信任它时继续。'),
    detail
  }
  const win = getMainWindow()
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}

export function registerConnectorsIpc(): void {
  // 仅自动化测试：让测试进程能直接调用 Agent 工具（正式运行不存在）
  if (process.env.EWB_TEST_HOOKS === '1') (globalThis as any).__ewbConnectorTools = getConnectorTools

  ipcMain.handle('connectors:types', async () => CONNECTORS.map(c => ({ id: c.id, name: c.name, description: c.description })))
  ipcMain.handle('connectors:list', async () => listViews())
  ipcMain.handle('connectors:save', async (_e, raw: unknown) => {
    const req = SaveSchema.parse(raw)
    if (req.type === 'mcp') {
      const old = req.id ? fullConfig(req.id) : null
      const merged: Record<string, unknown> = { ...(old?.config ?? {}) }
      for (const [k, v] of Object.entries(req.config)) { if ((k === 'env' || k === 'headers') && (v == null || (typeof v === 'object' && !Object.keys(v as object).length)) && old) continue; merged[k] = v }
      if (!(await confirmMcpRun(merged, '保存'))) throw new Error('已取消：没有保存这个 MCP 配置')
    }
    return saveEntry(req)
  })
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
        if (!(await confirmMcpRun(f.config, '测试'))) throw new Error('已取消：没有运行这个 MCP 命令')
        const tools = await withMcp(f.config, cl => cl.listTools())
        setTools(id, tools)
        result = { ok: true, message: `已连上，找到 ${tools.length} 个工具` }
      } else result = await c.test(f.config)
    } catch (e) { result = { ok: false, message: redactKey((e as Error).message) } }
    log.info('connectors', `测试 ${c.id}：${result.ok ? '成功' : '失败'}`)
    const message = redactKey(result.message)
    if (!message.startsWith('已取消')) setLastTest(id, { ok: result.ok, message })
    return { ...result, message, connectors: listViews() }
  })

  /** 选一个要发出去的文件：弹系统文件对话框，选中的文件记一次性发送许可（只有这样选的文件才能被「发文件」动作发出去） */
  ipcMain.handle('connectors:pickSendFile', async () => {
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择要发送的文件', properties: ['openFile'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    allowSendOnce(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('connectors:openDocs', async (_e, id: unknown) => {
    const p = getPreset(z.string().max(40).parse(id))
    if (!p) throw new Error('没有这个预设')
    await shell.openExternal(p.docs)
    return true
  })

  // 石墨：只打开官网（支持导入 Word、Markdown 文件），不写具体私有地址
  ipcMain.handle('connectors:openShimo', async () => { await shell.openExternal('https://shimo.im'); return true })
}
