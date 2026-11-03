/**
 * 看板 / 名单导出的落盘（弹保存对话框 + 写文件）。需要 electron。
 * 纯生成逻辑在 export-xlsx / export-html / export-docx，单测直接测它们。
 */
import { dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getMainWindow } from '../../window'
import { cleanAppleDouble } from '../../report/export'
import { safeStem } from '../../report/export-plan'
import { exportBoardDocx } from './export-docx'
import { buildBoardHtml } from './export-html'
import { exportBoardXlsx, exportTableXlsx } from './export-xlsx'
import type { BoardSpec, Cell, Column } from './spec'
import type { ExportFormat } from './tools'

const FORMATS: Record<ExportFormat, { label: string; ext: string; name: string }> = {
  xlsx: { label: '导出 Excel', ext: 'xlsx', name: 'Excel 表格' },
  html: { label: '导出网页', ext: 'html', name: '网页' },
  docx: { label: '导出 Word', ext: 'docx', name: 'Word 文档' }
}
const stamp = (): string => { const d = new Date(); const p = (n: number): string => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` }

/** 这次运行里导出过的文件路径（给「在文件夹里显示」之类用） */
export const exportedPaths = new Set<string>()

function writeFile(file: string, data: Buffer | string): number {
  try {
    fs.writeFileSync(file, data)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用（比如 Excel 里还开着它）或没有写入权限，请关闭后重试' : `保存失败：${(e as Error).message}`)
  }
  cleanAppleDouble(path.dirname(file), [path.basename(file)])
  exportedPaths.add(path.resolve(file))
  return typeof data === 'string' ? Buffer.byteLength(data) : data.length
}

export async function buildBoardFile(spec: BoardSpec, format: ExportFormat): Promise<Buffer | string> {
  return format === 'xlsx' ? exportBoardXlsx(spec) : format === 'docx' ? exportBoardDocx(spec) : buildBoardHtml(spec)
}

export async function exportBoardTo(spec: BoardSpec, format: ExportFormat, file: string): Promise<{ path: string; bytes: number }> {
  const bytes = writeFile(file, await buildBoardFile(spec, format))
  return { path: file, bytes }
}

async function pickPath(title: string, defaultName: string, ext: string, name: string): Promise<string | null> {
  const win = getMainWindow()
  const opts: Electron.SaveDialogOptions = { title, defaultPath: defaultName, filters: [{ name, extensions: [ext] }] }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return r.canceled || !r.filePath ? null : r.filePath
}

/** 弹保存对话框并导出看板；取消返回 { saved: false } */
export async function exportBoardWithDialog(spec: BoardSpec, format: ExportFormat): Promise<{ saved: boolean; path?: string; bytes?: number }> {
  const f = FORMATS[format]
  const file = await pickPath(f.label, `${safeStem(spec.title)}-${stamp()}.${f.ext}`, f.ext, f.name)
  if (!file) return { saved: false }
  const o = await exportBoardTo(spec, format, file)
  return { saved: true, ...o }
}

export async function exportTableWithDialog(columns: Column[], rows: Array<Record<string, Cell>>, sheetName: string): Promise<{ saved: boolean; path?: string; bytes?: number }> {
  const file = await pickPath('导出名单', `${safeStem(sheetName)}-${stamp()}.xlsx`, 'xlsx', 'Excel 表格')
  if (!file) return { saved: false }
  const bytes = writeFile(file, await exportTableXlsx(columns, rows, sheetName))
  return { saved: true, path: file, bytes }
}
