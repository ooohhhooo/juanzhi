import { ipcMain, dialog, clipboard, ClipboardItem, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { SUBJECT_IDS } from '../../shared/subject'
import { getMainWindow } from '../window'
import { withSpend } from './cost'
import { StatsFilterSchema } from '../stats/filter'
import { assertExportable, confirmReport, deleteReport, generateReport, getReport, listReports, previewReport, removeReportSentence, retryReportPart, tickVariant, wechatText } from '../report/service'
import { cardTemplateRows, renderMapped } from '../report/share-card'
import { answercardToCard, parentTextToBrief, trickToCard } from '../report/share-card-content'
import { getDataDir } from '../db'
import { exportReportTo } from '../report/export-run'
import { safeStem } from '../report/export-plan'
import { READERS, READER_LABEL } from '../../shared/report-post'

const FilterArg = StatsFilterSchema.default({})
const IdSchema = z.string().uuid()
const ReaderSchema = z.enum(READERS as [string, ...string[]]).default('full')
/** 生成选项（课程对照、家长版一句话）：严格限定字段，不接受别的东西 */
const OptionsSchema = z.object({
  course: z.object({ outlineIds: z.array(z.string().max(80)).max(20) }).strict().optional(),
  parentHint: z.boolean().optional()
}).strict().default({})
const clean = (e: unknown) => (e as Error).message

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` }

/** 这次运行里导出过的文件：「在文件夹里显示」只认它们，页面脚本不能借这个通道打开任意路径 */
const exported = new Set<string>()

export function registerReportIpc(): void {
  ipcMain.handle('report:list', async (_e, rawSubject?: unknown) => listReports(z.enum(SUBJECT_IDS).optional().parse(rawSubject ?? undefined)))
  ipcMain.handle('report:get', async (_e, rawId: unknown) => getReport(IdSchema.parse(rawId)))
  ipcMain.handle('report:preview', async (_e, rawFilter?: unknown, rawReader?: unknown) => previewReport(FilterArg.parse(rawFilter ?? {}), ReaderSchema.parse(rawReader ?? undefined) as any))
  ipcMain.handle('report:delete', async (_e, rawId: unknown) => deleteReport(IdSchema.parse(rawId)))
  /** 老师点「我已核对」：家长版据此才能导出 / 复制；家长版要带上「已确认无误」的未核实句子，没处理的未核实句子会被拒绝 */
  ipcMain.handle('report:confirm', async (_e, rawId: unknown, rawAcknowledged?: unknown) => confirmReport(IdSchema.parse(rawId), z.array(z.string().max(2000)).max(500).default([]).parse(rawAcknowledged ?? [])))

  /** 核对时从报告里删掉清单里的一句「未核实 / 矛盾」的话；已核对的报告不能再改 */
  ipcMain.handle('report:removeSentence', async (_e, rawId: unknown, rawSentence: unknown) => removeReportSentence(IdSchema.parse(rawId), z.string().min(1).max(2000).parse(rawSentence)))

  // 流式增量走 ai:chunk，只发给发起请求的窗口（和 P2 一样）
  ipcMain.handle('report:generate', async (e, rawFilter: unknown, rawRequestId: unknown, rawReader?: unknown, rawOptions?: unknown) => {
    const filter = FilterArg.parse(rawFilter ?? {})
    const options = OptionsSchema.parse(rawOptions ?? {})
    const requestId = z.string().uuid().parse(rawRequestId)
    const reader = ReaderSchema.parse(rawReader ?? undefined) as any
    const sender = e.sender
    return withSpend('report', () => generateReport(filter, reader, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } }, options))
  })

  /** 只重新生成报告里的一个附加段（口诀 / 变形题 / 以后的课程对照）；进度走 ai:chunk 的 part 事件，只发给发起请求的窗口 */
  ipcMain.handle('report:retryPart', async (e, rawId: unknown, rawPart: unknown, rawRequestId: unknown) => {
    const id = IdSchema.parse(rawId)
    const part = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).parse(rawPart)
    const requestId = z.string().uuid().parse(rawRequestId)
    const sender = e.sender
    return retryReportPart(id, part, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })

  /** 老师逐题勾「我核对过」：勾了的 AI 变形题才会放进答题卡 */
  ipcMain.handle('report:variantTick', async (_e, rawId: unknown, rawVariantId: unknown, rawOk: unknown) =>
    tickVariant(IdSchema.parse(rawId), z.string().min(1).max(100).parse(rawVariantId), z.boolean().parse(rawOk)))

  /** 把一张卡片图片交出去：copy 写剪贴板，save 弹系统「另存为」。取消返回 { saved: false } */
  const deliver = async (img: { png: Buffer; width: number; height: number }, mode: 'save' | 'copy', title: string, stem: string, extra: Record<string, unknown>) => {
    if (mode === 'copy') {
      // Electron 45 的剪贴板是 W3C 风格的异步接口：写一个 image/png 条目
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.png)], { type: 'image/png' }) })])
      return { saved: true, width: img.width, height: img.height, ...extra }
    }
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title, defaultPath: `${safeStem(stem)}-${stamp()}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false, ...extra }
    const out = r.filePath.toLowerCase().endsWith('.png') ? r.filePath : `${r.filePath}.png`
    fs.writeFileSync(out, img.png)
    exported.add(path.resolve(out))
    return { saved: true, path: out, width: img.width, height: img.height, ...extra }
  }
  const TemplateArg = z.string().regex(/^[a-z0-9-]{1,24}$/).optional()

  /** 卡片模板清单（学生 / 家长），带当前默认；报告页的模板下拉用 */
  ipcMain.handle('report:cardTemplates', async () => cardTemplateRows(getDataDir()))

  /** 老师版口诀卡 / 答题卡存成 / 复制成图片：走新的分享卡片引擎（默认学生模板，可指定 templateId）。1086×1448 */
  ipcMain.handle('report:cardImage', async (_e, rawId: unknown, rawKind: unknown, rawIndex: unknown, rawMode: unknown, rawTemplate?: unknown) => {
    const id = IdSchema.parse(rawId)
    const kind = z.enum(['trick', 'answercard']).parse(rawKind)
    const index = z.number().int().min(0).max(50).parse(rawIndex)
    const mode = z.enum(['save', 'copy']).parse(rawMode)
    const templateId = TemplateArg.parse(rawTemplate ?? undefined)
    const report = getReport(id)
    if (!report) throw new Error('这份报告已经不存在了')
    assertExportable(report)
    const mapped = kind === 'trick' ? trickToCard(report.markdown, index, report.filter?.subject) : answercardToCard(report.markdown, index)
    if (!mapped) throw new Error(kind === 'answercard' ? '答题卡里还没有题：请先在下面逐题勾「我核对过」' : '没有找到这张卡片')
    const img = await renderMapped(getDataDir(), mapped, templateId)
    return deliver(img, mode, kind === 'answercard' ? '保存答题卡图片' : '保存口诀卡图片', kind === 'answercard' ? '答题卡' : `口诀大招-${index + 1}`, { templateId: img.templateId, notes: img.notes })
  })

  /** 家长卡片会放哪些话（不渲染）：给界面显示“只放了前几句”的说明 */
  ipcMain.handle('report:parentCardPlan', async (_e, rawId: unknown) => {
    const report = getReport(IdSchema.parse(rawId))
    if (!report) throw new Error('这份报告已经不存在了')
    if (report.reader !== 'parent') throw new Error('只有家长版可以生成家长卡片')
    try { return { ok: true as const, notes: parentTextToBrief(wechatText(report)).notes } } catch (e) { return { ok: false as const, message: clean(e) } }
  })

  /** 家长版 → 「绘本来信」家长卡片：和导出同一道门槛（没点「我已核对」不给出） */
  ipcMain.handle('report:parentCard', async (_e, rawId: unknown, rawMode: unknown, rawTemplate?: unknown) => {
    const report = getReport(IdSchema.parse(rawId))
    if (!report) throw new Error('这份报告已经不存在了')
    const mode = z.enum(['save', 'copy']).parse(rawMode)
    const templateId = TemplateArg.parse(rawTemplate ?? undefined)
    if (report.reader !== 'parent') throw new Error('只有家长版可以生成家长卡片')
    assertExportable(report)
    const mapped = parentTextToBrief(wechatText(report))
    const img = await renderMapped(getDataDir(), mapped, templateId)
    return deliver(img, mode, '保存家长卡片', '家长卡片', { templateId: img.templateId, notes: img.notes })
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

  /** 老师版「可发给家长的话」复制给家长：没点「我已核对」不给复制（和课程看板里的话术同一道门槛）；过期的报告也不给 */
  ipcMain.handle('report:copyCourseAdvice', async (_e, rawId: unknown) => {
    const report = getReport(IdSchema.parse(rawId))
    if (!report) throw new Error('这份报告已经不存在了')
    assertExportable(report)   // 和导出同一道门槛（正在生成 / 家长版没核对等）
    if (!report.courseAdvice) throw new Error('这份报告里没有课程建议')
    if (!report.confirmedAt) throw new Error('请先点「我已核对」，确认这段话没问题再复制给家长')
    if (report.status === 'stale') throw new Error('这份报告已经过期（数据或课程有变化），请重新生成并核对后再复制')
    clipboard.writeText(report.courseAdvice)
    return { text: report.courseAdvice, chars: report.courseAdvice.length }
  })

  /** 导出：弹系统「另存为」（Markdown 的图片放进同名文件夹；PDF 用隐藏窗口打印；Word 直接写 .docx）。取消返回 { saved: false } */
  ipcMain.handle('report:export', async (_e, rawId: unknown, rawFmt: unknown) => {
    const id = IdSchema.parse(rawId)
    const fmt = z.enum(['md', 'pdf', 'docx']).parse(rawFmt)
    const report = getReport(id)
    if (!report) throw new Error('这份报告已经不存在了')
    assertExportable(report)
    const win = getMainWindow()
    const base = safeStem(`考情分析报告-${READER_LABEL[report.reader]}-${report.filterDesc.replace(/ · /g, '-')}-${stamp()}`)
    const opts: Electron.SaveDialogOptions = fmt === 'md'
      ? { title: '导出 Markdown（截图会放进同名文件夹）', defaultPath: `${base}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }
      : fmt === 'pdf'
        ? { title: '导出 PDF', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
        : { title: '导出 Word', defaultPath: `${base}.docx`, filters: [{ name: 'Word 文档', extensions: ['docx'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    const o = await exportReportTo(report, fmt, r.filePath)
    exported.add(path.resolve(o.path))
    return fmt === 'md'
      ? { saved: true, path: o.path, dir: o.dir, images: o.images, missingImages: o.missingImages, bytes: o.bytes }
      : { saved: true, path: o.path, bytes: o.bytes, images: o.images }
  })

  /** 在文件管理器里显示刚导出的文件（只认这次运行里导出过的路径） */
  ipcMain.handle('report:reveal', async (_e, rawPath: unknown) => {
    const p = path.resolve(z.string().min(1).max(2000).parse(rawPath))
    if (!exported.has(p)) return false
    shell.showItemInFolder(p)
    return true
  })
}
