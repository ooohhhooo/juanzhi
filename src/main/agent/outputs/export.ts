/**
 * 产出导出：md → Word（复用报告的 buildDocx）、md → PDF（和报告一样用隐藏窗口 printToPDF）、表格 → xlsx / csv。
 * electron 只在导出 PDF 时才动态加载，所以 Word / csv 导出可以在单测里直接跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildDocx } from '../../report/docx.ts'
import { markdownToHtml, reportHtmlPage } from '../../../shared/mdhtml.ts'
import { stripRefTags } from '../../../shared/agent-outputs.ts'
import type { OutputExportFormat } from '../../../shared/agent-outputs.ts'
import { cleanMarks, getEntry, readDoc, readTableRows, safeFileStem, sessionDir, toCsv } from './store.ts'
import type { Scope } from './store.ts'

export interface ExportResult { path: string; format: OutputExportFormat; bytes: number; /** 要求 xlsx 但还没接上 xlsx 导出，改存了 csv */ fellBackTo?: 'csv' }

/** 表格 → xlsx 的实现由看板模块提供（exportTable）；集成时调用 setTableExporter 接上。没接时导出 csv */
export type TableExporter = (o: { name: string; columns: string[]; rows: string[][]; outPath: string }) => Promise<void>
let tableExporter: TableExporter | null = null
export function setTableExporter(fn: TableExporter | null): void { tableExporter = fn }

/** 导出到本机的文件把代号还原成真名（由主进程注册：names.ts 的 restoreNames）。没注册 = 原样 */
let restorer: ((sessionId: string, text: string) => string) | null = null
export function setOutputRestorer(fn: ((sessionId: string, text: string) => string) | null): void { restorer = fn }
const rs = (s: Scope, t: string): string => (restorer ? restorer(s.sessionId, t) : t)

export const exportsDir = (s: Scope): string => path.join(sessionDir(s), 'exports')

export function allowedFormats(type: 'md' | 'note' | 'table' | 'board'): OutputExportFormat[] {
  if (type === 'md' || type === 'note') return ['docx', 'pdf', 'md']
  if (type === 'table') return ['xlsx', 'csv']
  return []
}

async function pdfOf(title: string, markdown: string, outPath: string): Promise<number> {
  const { BrowserWindow } = await import('electron')
  const html = reportHtmlPage({ title, bodyHtml: markdownToHtml(markdown), footer: '' })
  const tmp = path.join(os.tmpdir(), `ewb-out-${crypto.randomBytes(6).toString('hex')}.html`)
  fs.writeFileSync(tmp, html, 'utf8')
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })
  try {
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 } })
    fs.writeFileSync(outPath, pdf)
    return pdf.length
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
}

/** 导出到指定路径；outPath 省略时放在会话目录的 exports/ 里 */
export async function exportOutput(s: Scope, id: string, format: OutputExportFormat, outPath?: string): Promise<ExportResult> {
  const e = getEntry(s, id)
  if (!e) throw new Error(`找不到产出 ${id}`)
  if (!allowedFormats(e.type).includes(format)) throw new Error(`「${e.name}」不能导出为 ${format}`)
  let out = outPath ?? path.join(exportsDir(s), `${safeFileStem(e.name)}.${format}`)
  if (!out.toLowerCase().endsWith(`.${format}`)) out += `.${format}`
  fs.mkdirSync(path.dirname(out), { recursive: true })
  let fell: 'csv' | undefined
  if (e.type === 'table') {
    const t0 = readTableRows(s, id)
    const t = { columns: t0.columns.map(c => rs(s, c)), rows: t0.rows.map(r => r.map(c => rs(s, String(c ?? '')))) }
    if (format === 'xlsx' && tableExporter) await tableExporter({ name: e.name, columns: t.columns, rows: t.rows, outPath: out })
    else {
      if (format === 'xlsx') { fell = 'csv'; out = out.replace(/\.xlsx$/i, '.csv') }
      fs.writeFileSync(out, '﻿' + toCsv(t.columns, t.rows))
    }
  } else {
    const md = rs(s, stripRefTags(cleanMarks(readDoc(s, id).markdown)))
    if (format === 'md') fs.writeFileSync(out, md, 'utf8')
    else if (format === 'docx') fs.writeFileSync(out, await buildDocx({ title: rs(s, e.name), markdown: md.replace(/^# .*\n+/, ''), footer: '由卷知助手生成' }))
    else await pdfOf(rs(s, e.name), md, out)
  }
  return { path: out, format: fell ?? format, bytes: fs.statSync(out).size, ...(fell ? { fellBackTo: fell } : {}) }
}
