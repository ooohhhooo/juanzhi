/**
 * 导出一份报告到指定路径（界面「另存为」之后、命令行 `report export` 共用）。需要 electron（裁图、PDF）。
 * 家长版没点过「我已核对」时（只有命令行会走到这里）：导出的文件开头带醒目的草稿标记，保留「未核实」标记，页脚写「AI 草稿」；
 * 返回值里 draft = true 并带 warning。界面的导出不走草稿路径：家长版没核对，界面根本不让导出（assertExportable）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { exportDocx, exportMarkdown, exportPdf } from './export'
import { confirmBlockReason } from '../../shared/report-post'
import { assertExportable, dataScopeNote, exportableMarkdown } from './service'
import type { ReportDetail } from './service'

export type ExportFormat = 'md' | 'pdf' | 'docx'

/** 命令行导出未核对的家长版时，写在文件最前面的标记（Markdown / Word / PDF 都有） */
export const PARENT_DRAFT_BANNER = 'AI 草稿 · 未经老师核对，请勿直接发给家长'
export const PARENT_DRAFT_WARNING = `${PARENT_DRAFT_BANNER}：家长版需要老师在卷知界面里读一遍、点「我已核对」后才能发给家长；命令行不能替老师点这个按钮。`

export interface ExportOutcome {
  path: string
  dir?: string | null
  images: number
  missingImages?: number
  bytes: number
  /** 家长版没有经过老师核对：文件是草稿 */
  draft: boolean
  warning?: string
}

/** 这份报告能不能导出（界面和命令行的把关）；命令行允许未核对的家长版导出成草稿，其余把关照旧（内容太少、有矛盾句、超过 300 字仍拒绝） */
export function exportBlock(report: ReportDetail, opts: { allowParentDraft: boolean }): string | null {
  if (opts.allowParentDraft && report.reader === 'parent' && !report.confirmedAt) return confirmBlockReason(report)
  try { assertExportable(report) } catch (e) { return (e as Error).message }
  return null
}

export async function exportReportTo(report: ReportDetail, fmt: ExportFormat, outPath: string, opts: { allowParentDraft?: boolean } = {}): Promise<ExportOutcome> {
  const draft = !!opts.allowParentDraft && report.reader === 'parent' && !report.confirmedAt
  const why = exportBlock(report, { allowParentDraft: !!opts.allowParentDraft })
  if (why) throw new Error(why)
  // 家长版核对后去掉「未核实」标记；草稿（没核对）保留标记，并在最前面加醒目的草稿标记
  const body = draft ? report.markdown : exportableMarkdown(report)
  const exp = { ...report, markdown: draft ? `> **${PARENT_DRAFT_BANNER}**\n\n${body}` : body }
  const note = dataScopeNote(report)
  let out = outPath
  if (!out.toLowerCase().endsWith(`.${fmt}`)) out += `.${fmt}`
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    if (fmt === 'md') {
      const m = exportMarkdown(exp, out, note)
      return { path: m.mdPath, dir: m.dir, images: m.images, missingImages: m.missingImages, bytes: fs.statSync(m.mdPath).size, draft, ...(draft ? { warning: PARENT_DRAFT_WARNING } : {}) }
    }
    if (fmt === 'pdf') {
      const p = await exportPdf(exp, out, note)
      return { path: p.pdfPath, images: p.images, bytes: p.bytes, draft, ...(draft ? { warning: PARENT_DRAFT_WARNING } : {}) }
    }
    const d = await exportDocx(exp, out, note)
    return { path: d.docxPath, images: d.images, bytes: d.bytes, draft, ...(draft ? { warning: PARENT_DRAFT_WARNING } : {}) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用或没有写入权限，请关闭后重试' : `导出失败：${(err as Error).message}`)
  }
}
