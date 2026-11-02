import { app, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { collectDiagnostics, writeDiagnosticsZip, shortDiagnosisText, feedbackLink } from '../diagnostics'
import { DIAG_NEVER_INCLUDED } from '../diagnostics-core'
import { getDataDir } from '../db'
import { getMainWindow } from '../window'
import { isInside } from '../cli/outfile'
import { log, logRendererError } from '../log'

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` }

export function registerDiagnosticsIpc(): void {
  // 先让用户看到里面到底有什么，再决定存不存
  ipcMain.handle('diagnostics:preview', async () => {
    const entries = await collectDiagnostics()
    return {
      entries: entries.map(e => ({ name: e.name, desc: e.desc, bytes: e.bytes })),
      totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
      neverIncluded: DIAG_NEVER_INCLUDED
    }
  })

  ipcMain.handle('diagnostics:export', async () => {
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = {
      title: '导出诊断信息', defaultPath: `卷知诊断信息-${stamp()}.zip`, filters: [{ name: '压缩包（.zip）', extensions: ['zip'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    let out = r.filePath
    if (!/\.zip$/i.test(out)) out += '.zip'
    if (isInside(out, getDataDir()) || isInside(out, app.getPath('userData'))) throw new Error('不能把诊断信息保存在应用的数据目录里面，请换一个位置')
    const entries = await collectDiagnostics()
    const bytes = await writeDiagnosticsZip(entries, out)
    log.info('diagnostics', '已导出诊断信息', { files: entries.length, bytes })
    return { saved: true, path: out, dir: path.dirname(out), bytes, files: entries.length }
  })

  ipcMain.handle('diagnostics:short', async () => shortDiagnosisText())
  ipcMain.handle('feedback:url', async () => feedbackLink())
  ipcMain.handle('feedback:open', async () => { await shell.openExternal(feedbackLink()); return true })

  // 渲染端错误上报（每分钟最多 30 条，在 logRendererError 里限速）
  ipcMain.on('log:renderer', (_e, msg: unknown) => { if (typeof msg === 'string') logRendererError(msg) })
}
