import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow, clipboard, ClipboardItem } from 'electron'
import { z } from 'zod'
import { getDataDir } from '../db'
import { getMainWindow } from '../window'
import { allowedFormats, exportOutput } from '../agent/outputs/export'
import { restoreDeep } from '../agent/names'
import { getBoard } from '../analysis/report/tools'
import { rerenderCard } from '../cards/make'
import { entryPath, getEntry, listOutputs, onOutputsChanged, readContent, safeFileStem, sessionDir } from '../agent/outputs/store'

const SessionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const IdSchema = z.string().regex(/^[a-z]\d{1,6}$/)
const FormatSchema = z.enum(['docx', 'pdf', 'xlsx', 'csv', 'md'])
const scope = (sessionId: string) => ({ dataDir: getDataDir(), sessionId })

export function registerAgentOutputsIpc(): void {
  // 产出变化 → 通知所有窗口（右侧面板据此实时刷新）
  onOutputsChanged(sessionId => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('agent-outputs:changed', sessionId) })

  ipcMain.handle('agent-outputs:list', async (_e, rawSid: unknown) => listOutputs(scope(SessionSchema.parse(rawSid))))
  ipcMain.handle('agent-outputs:read', async (_e, rawSid: unknown, rawId: unknown) => { const sid = SessionSchema.parse(rawSid); const c = readContent(scope(sid), IdSchema.parse(rawId)); return c.type === 'image' ? c : restoreDeep(sid, c) })   // 显示给用户的内容还原成真名
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
  /** 图片产出：复制图片到剪贴板 / 另存为（只认索引里登记的图片） */
  const imageOf = (rawSid: unknown, rawId: unknown) => {
    const s = scope(SessionSchema.parse(rawSid))
    const e = getEntry(s, IdSchema.parse(rawId))
    const p = e && e.type === 'image' ? entryPath(s, e.id) : null
    if (!e || !p) throw new Error('找不到这张图片')
    return { e, p }
  }
  /** 卡片换模板：同样的内容按另一个模板重画（不调用 AI），原地替换这张图 */
  ipcMain.handle('agent-outputs:rerenderCard', async (_e, rawSid: unknown, rawId: unknown, rawTid: unknown) => rerenderCard(scope(SessionSchema.parse(rawSid)), IdSchema.parse(rawId), z.string().min(1).max(20).parse(rawTid)))
  ipcMain.handle('agent-outputs:copyImage', async (_e, rawSid: unknown, rawId: unknown) => {
    const { p } = imageOf(rawSid, rawId)
    const buf = fs.readFileSync(p)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(buf)], { type: 'image/png' }) })])
    return true
  })
  ipcMain.handle('agent-outputs:saveImage', async (_e, rawSid: unknown, rawId: unknown) => {
    const { e, p } = imageOf(rawSid, rawId)
    const win = getMainWindow()
    const opts = { defaultPath: `${safeFileStem(e.name)}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    const out = r.filePath.toLowerCase().endsWith('.png') ? r.filePath : r.filePath + '.png'
    fs.copyFileSync(p, out)
    return { saved: true, path: path.resolve(out) }
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
