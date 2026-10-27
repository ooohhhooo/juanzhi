import { ipcMain, dialog, clipboard, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getMainWindow } from '../window'
import { StatsFilterSchema } from '../stats/filter'
import { assertExportable, confirmReport, dataScopeNote, deleteReport, exportableMarkdown, generateReport, getReport, listReports, previewReport, removeReportSentence, wechatText } from '../report/service'
import { exportDocx, exportMarkdown, exportPdf } from '../report/export'
import { safeStem } from '../report/export-plan'
import { READERS, READER_LABEL } from '../../shared/report-post'

const FilterArg = StatsFilterSchema.default({})
const IdSchema = z.string().uuid()
const ReaderSchema = z.enum(READERS as [string, ...string[]]).default('full')
const clean = (e: unknown) => (e as Error).message

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` }

/** 这次运行里导出过的文件：「在文件夹里显示」只认它们，页面脚本不能借这个通道打开任意路径 */
const exported = new Set<string>()

export function registerReportIpc(): void {
  ipcMain.handle('report:list', async () => listReports())
  ipcMain.handle('report:get', async (_e, rawId: unknown) => getReport(IdSchema.parse(rawId)))
  ipcMain.handle('report:preview', async (_e, rawFilter?: unknown, rawReader?: unknown) => previewReport(FilterArg.parse(rawFilter ?? {}), ReaderSchema.parse(rawReader ?? undefined) as any))
  ipcMain.handle('report:delete', async (_e, rawId: unknown) => deleteReport(IdSchema.parse(rawId)))
  /** 老师点「我已核对」：家长版据此才能导出 / 复制；家长版要带上「已确认无误」的未核实句子，没处理的未核实句子会被拒绝 */
  ipcMain.handle('report:confirm', async (_e, rawId: unknown, rawAcknowledged?: unknown) => confirmReport(IdSchema.parse(rawId), z.array(z.string().max(2000)).max(500).default([]).parse(rawAcknowledged ?? [])))

  /** 核对时从报告里删掉清单里的一句「未核实 / 矛盾」的话；已核对的报告不能再改 */
  ipcMain.handle('report:removeSentence', async (_e, rawId: unknown, rawSentence: unknown) => removeReportSentence(IdSchema.parse(rawId), z.string().min(1).max(2000).parse(rawSentence)))

  // 流式增量走 ai:chunk，只发给发起请求的窗口（和 P2 一样）
  ipcMain.handle('report:generate', async (e, rawFilter: unknown, rawRequestId: unknown, rawReader?: unknown) => {
    const filter = FilterArg.parse(rawFilter ?? {})
    const requestId = z.string().uuid().parse(rawRequestId)
    const reader = ReaderSchema.parse(rawReader ?? undefined) as any
    const sender = e.sender
    return generateReport(filter, reader, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })

  /** 复制到微信：纯文本（带换行和序号，没有 Markdown 符号），写进系统剪贴板；家长版没核对不给复制 */
  ipcMain.handle('report:copyWechat', async (_e, rawId: unknown) => {
    const report = getReport(IdSchema.parse(rawId))
    if (!report) throw new Error('这份报告已经不存在了')
    assertExportable(report)
    const text = wechatText(report)
    clipboard.writeText(text)
    return { text, chars: text.length }
  })

  /** 导出：弹系统「另存为」（Markdown 的图片放进同名文件夹；PDF 用隐藏窗口打印；Word 直接写 .docx）。取消返回 { saved: false } */
  ipcMain.handle('report:export', async (_e, rawId: unknown, rawFmt: unknown) => {
    const id = IdSchema.parse(rawId)
    const fmt = z.enum(['md', 'pdf', 'docx']).parse(rawFmt)
    const report = getReport(id)
    if (!report) throw new Error('这份报告已经不存在了')
    assertExportable(report)
    // 家长版核对后去掉「未核实」标记（和复制到微信口径一致）；其他版本保留
    const exp = { ...report, markdown: exportableMarkdown(report) }
    const note = dataScopeNote(report)
    const win = getMainWindow()
    const base = safeStem(`考情分析报告-${READER_LABEL[report.reader]}-${report.filterDesc.replace(/ · /g, '-')}-${stamp()}`)
    const opts: Electron.SaveDialogOptions = fmt === 'md'
      ? { title: '导出 Markdown（截图会放进同名文件夹）', defaultPath: `${base}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }
      : fmt === 'pdf'
        ? { title: '导出 PDF', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
        : { title: '导出 Word', defaultPath: `${base}.docx`, filters: [{ name: 'Word 文档', extensions: ['docx'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    let out = r.filePath
    if (!out.toLowerCase().endsWith(`.${fmt}`)) out += `.${fmt}`
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (fmt === 'md') {
        const m = exportMarkdown(exp, out, note)
        exported.add(path.resolve(m.mdPath))
        return { saved: true, path: m.mdPath, dir: m.dir, images: m.images, missingImages: m.missingImages, bytes: fs.statSync(m.mdPath).size }
      }
      if (fmt === 'pdf') {
        const p = await exportPdf(exp, out, note)
        exported.add(path.resolve(p.pdfPath))
        return { saved: true, path: p.pdfPath, bytes: p.bytes, images: p.images }
      }
      const d = await exportDocx(exp, out, note)
      exported.add(path.resolve(d.docxPath))
      return { saved: true, path: d.docxPath, bytes: d.bytes, images: d.images }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用或没有写入权限，请关闭后重试' : `导出失败：${clean(err)}`)
    }
  })

  /** 在文件管理器里显示刚导出的文件（只认这次运行里导出过的路径） */
  ipcMain.handle('report:reveal', async (_e, rawPath: unknown) => {
    const p = path.resolve(z.string().min(1).max(2000).parse(rawPath))
    if (!exported.has(p)) return false
    shell.showItemInFolder(p)
    return true
  })
}
