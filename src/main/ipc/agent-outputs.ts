import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { z } from 'zod'
import { getDataDir } from '../db'
import { getMainWindow } from '../window'
import { allowedFormats, exportOutput } from '../agent/outputs/export'
import { restoreDeep } from '../agent/names'
import { getBoard } from '../analysis/report/tools'
import { entryPath, getEntry, listOutputs, onOutputsChanged, readContent, safeFileStem, sessionDir } from '../agent/outputs/store'

const SessionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const IdSchema = z.string().regex(/^[a-z]\d{1,6}$/)
const FormatSchema = z.enum(['docx', 'pdf', 'xlsx', 'csv', 'md'])
const scope = (sessionId: string) => ({ dataDir: getDataDir(), sessionId })

export function registerAgentOutputsIpc(): void {
  // 产出变化 → 通知所有窗口（右侧面板据此实时刷新）
  onOutputsChanged(sessionId => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('agent-outputs:changed', sessionId) })

  ipcMain.handle('agent-outputs:list', async (_e, rawSid: unknown) => listOutputs(scope(SessionSchema.parse(rawSid))))
  ipcMain.handle('agent-outputs:read', async (_e, rawSid: unknown, rawId: unknown) => { const sid = SessionSchema.parse(rawSid); return restoreDeep(sid, readContent(scope(sid), IdSchema.parse(rawId))) })   // 显示给用户的内容还原成真名
  /** 本会话的看板规格（显示用，已还原真名）；还没有看板返回 null */
  ipcMain.handle('agent-outputs:board', async (_e, rawSid: unknown) => { const sid = SessionSchema.parse(rawSid); const b = getBoard({ sessionId: sid, dataDir: getDataDir() }); return b ? restoreDeep(sid, b) : null })
  /** 导出：弹「另存为」让用户选位置（只写用户选的文件） */
  ipcMain.handle('agent-outputs:export', async (_e, rawSid: unknown, rawId: unknown, rawFmt: unknown) => {
    const s = scope(SessionSchema.parse(rawSid)), id = IdSchema.parse(rawId), fmt = FormatSchema.parse(rawFmt)
    const e = getEntry(s, id)
    if (!e) throw new Error('找不到这份产出')
    if (!allowedFormats(e.type).includes(fmt)) throw new Error('这份产出不能导出为这种格式')
    const win = getMainWindow()
    const opts = { defaultPath: `${safeFileStem(e.name)}.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    const out = await exportOutput(s, id, fmt, r.filePath)
    return { saved: true, ...out }
  })
  /** 在文件夹里显示（只认索引里登记的文件，页面脚本不能借此打开任意路径） */
  ipcMain.handle('agent-outputs:reveal', async (_e, rawSid: unknown, rawId: unknown) => {
    const s = scope(SessionSchema.parse(rawSid))
    const p = entryPath(s, IdSchema.parse(rawId))
    if (p) shell.showItemInFolder(p)
    else await shell.openPath(sessionDir(s))
    return true
  })
}
