import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getMainWindow } from '../window'
import { StatsFilterSchema } from '../stats/filter'
import { deleteReport, generateReport, getReport, listReports, previewReport } from '../report/service'
import { exportMarkdown, exportPdf } from '../report/export'
import { safeStem } from '../report/export-plan'

const FilterArg = StatsFilterSchema.default({})
const IdSchema = z.string().uuid()
const clean = (e: unknown) => (e as Error).message

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` }

export function registerReportIpc(): void {
  ipcMain.handle('report:list', async () => listReports())
  ipcMain.handle('report:get', async (_e, rawId: unknown) => getReport(IdSchema.parse(rawId)))
  ipcMain.handle('report:preview', async (_e, rawFilter?: unknown) => previewReport(FilterArg.parse(rawFilter ?? {})))
  ipcMain.handle('report:delete', async (_e, rawId: unknown) => deleteReport(IdSchema.parse(rawId)))

  // 流式增量走 ai:chunk，只发给发起请求的窗口（和 P2 一样）
  ipcMain.handle('report:generate', async (e, rawFilter: unknown, rawRequestId: unknown) => {
    const filter = FilterArg.parse(rawFilter ?? {})
    const requestId = z.string().uuid().parse(rawRequestId)
    const sender = e.sender
    return generateReport(filter, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })

  /** 导出：弹系统「另存为」（Markdown 的图片放进同名文件夹；PDF 用隐藏窗口打印）。取消返回 { saved: false } */
  ipcMain.handle('report:export', async (_e, rawId: unknown, rawFmt: unknown) => {
    const id = IdSchema.parse(rawId)
    const fmt = z.enum(['md', 'pdf']).parse(rawFmt)
    const report = getReport(id)
    if (!report) throw new Error('这份报告已经不存在了')
    const win = getMainWindow()
    const base = safeStem(`考情分析报告-${report.filterDesc.replace(/ · /g, '-')}-${stamp()}`)
    const opts: Electron.SaveDialogOptions = fmt === 'md'
      ? { title: '导出 Markdown（截图会放进同名文件夹）', defaultPath: `${base}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }
      : { title: '导出 PDF', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    let out = r.filePath
    if (!out.toLowerCase().endsWith(`.${fmt}`)) out += `.${fmt}`
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (fmt === 'md') {
        const m = exportMarkdown(report, out)
        return { saved: true, path: m.mdPath, dir: m.dir, images: m.images, missingImages: m.missingImages, bytes: fs.statSync(m.mdPath).size }
      }
      const p = await exportPdf(report, out)
      return { saved: true, path: p.pdfPath, bytes: p.bytes, images: p.images }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用或没有写入权限，请关闭后重试' : `导出失败：${clean(err)}`)
    }
  })
}
