import { ipcMain } from 'electron'
import { z } from 'zod'
import { BoardSpecSchema, ColumnSchema } from '../analysis/report/spec'
import { EXPORT_FORMATS } from '../analysis/report/tools'
import { exportBoardWithDialog, exportTableWithDialog } from '../analysis/report/export-run'

const RowsSchema = z.array(z.record(z.union([z.string().max(2000), z.number().finite(), z.null()]))).max(20000)

/** 分析看板 / 名单导出：弹「另存为」后只写用户选的文件（只读类通道） */
export function registerAnalysisReportIpc(): void {
  ipcMain.handle('analysisReport:export', async (_e, rawSpec: unknown, rawFmt: unknown) =>
    exportBoardWithDialog(BoardSpecSchema.parse(rawSpec), z.enum(EXPORT_FORMATS).parse(rawFmt)))
  ipcMain.handle('analysisReport:exportTable', async (_e, rawCols: unknown, rawRows: unknown, rawName: unknown) =>
    exportTableWithDialog(z.array(ColumnSchema).min(1).max(60).parse(rawCols), RowsSchema.parse(rawRows), z.string().max(60).default('名单').parse(rawName ?? undefined)))
}
