import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import { getDataDir, getDb } from '../db'
import { getMainWindow } from '../window'
import { allowPath, isPathAllowed } from '../allowedPaths'
import { notifyDataChanged } from '../events'
import { log } from '../log'
import { DatasetError, getStore, setDataDirProvider } from '../analysis/datasets/index'
import { getDocumentStore, setDocumentsDirProvider } from '../analysis/documents'
import { ATTACH_EXTENSIONS, AttachError, attachKindOf, extractText } from '../agent/attachments'

const IdSchema = z.string().uuid()
const NameSchema = z.string().min(1).max(200)

/** 数据集：导入 / 列表 / 概况 / 预览 / 删除 / 敏感列 / 改名 / 备注。数据只存本机的 <数据目录>/datasets/。 */
export function registerDatasetsIpc(): void {
  setDataDirProvider(() => getDataDir())
  setDocumentsDirProvider(() => getDataDir())
  const fail = (e: unknown): never => { throw new Error(e instanceof DatasetError ? e.message : e instanceof Error ? e.message : String(e)) }

  /** 选文件：弹系统对话框（路径随之登记），只返回路径，导入由 datasets:import 做 */
  ipcMain.handle('datasets:pick', async () => {
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择数据文件', filters: [{ name: '表格、图片、文档', extensions: ['xlsx', 'xlsm', 'csv', 'tsv', ...ATTACH_EXTENSIONS] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile', 'multiSelections'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return []
    r.filePaths.forEach(allowPath)
    return r.filePaths
  })

  ipcMain.handle('datasets:import', async (e, raw: unknown) => {
    const paths = z.array(z.string().min(1).max(2000)).min(1).max(20).parse(raw)
    const results: Array<{ file: string; ok: boolean; id?: string; error?: string; kind?: 'dataset' | 'document' }> = []
    for (const p of paths) {
      const file = p.split(/[\\/]/).pop() ?? p
      if (!isPathAllowed(p)) { results.push({ file, ok: false, error: '文件未经授权：请通过“选择文件”或拖入窗口' }); continue }
      // 图片、PDF、Word、文本（.txt 除外，它可能是制表符分隔的表格）：读出文字存成文档资料
      if (attachKindOf(p) && !/\.txt$/i.test(p)) {
        try {
          if (!e.sender.isDestroyed()) e.sender.send('datasets:progress', { fileName: file, phase: 'read', message: '正在读取文字…', done: 0, total: 1 })
          const { kind, text } = await extractText(p)
          const d = getDocumentStore().add(file, kind, text)
          log.info('datasets', '导入文档资料', { kind, chars: d.chars })
          results.push({ file, ok: true, id: d.id, kind: 'document' })
        } catch (err) { results.push({ file, ok: false, error: err instanceof AttachError ? err.message : '读取失败：' + (err instanceof Error ? err.message : String(err)) }) }
        continue
      }
      try {
        const meta = await getStore().importFile(p, { onProgress: pr => { if (!e.sender.isDestroyed()) e.sender.send('datasets:progress', pr) } })
        log.info('datasets', '导入数据集', { tables: meta.tables.length, rows: meta.tables.reduce((a, t) => a + t.rows, 0) })
        results.push({ file, ok: true, id: meta.id, kind: 'dataset' })
      } catch (err) {
        results.push({ file, ok: false, error: err instanceof DatasetError ? err.message : '导入失败：' + (err instanceof Error ? err.message : String(err)) })
      }
    }
    notifyDataChanged('datasets')
    return results
  })

  ipcMain.handle('datasets:list', async () => getStore().list())
  // 文档资料：列表 / 读文字（界面预览）/ 删除；卷知里其他数据的数量（数据页顶部的说明）
  ipcMain.handle('datasets:documents', async () => getDocumentStore().list())
  ipcMain.handle('datasets:documentText', async (_e, id: unknown) => getDocumentStore().text(z.string().max(80).parse(id)).slice(0, 200_000))
  ipcMain.handle('datasets:removeDocument', async (_e, id: unknown) => { const ok = getDocumentStore().remove(z.string().max(80).parse(id)); if (ok) notifyDataChanged('datasets'); return ok })
  ipcMain.handle('datasets:sources', async () => {
    const db = getDb()
    const n = (sql: string) => { try { return (db.prepare(sql).get() as any).c as number } catch { return 0 } }
    return { papers: n('SELECT COUNT(*) c FROM papers WHERE is_sample = 0'), outlines: n("SELECT COUNT(*) c FROM course_outlines WHERE status = 'active'"), reports: n("SELECT COUNT(*) c FROM reports WHERE kind = 'report'") }
  })
  /** 概况：数据集元信息（各表各列的类型、空值率、取值分布、敏感标记、用途提示） */
  ipcMain.handle('datasets:profile', async (_e, id: unknown) => {
    try { return getStore().get(IdSchema.parse(id)) } catch (err) { return fail(err) }
  })
  /** 前 100 行预览：界面显示真名（这个通道只给界面，不进 Agent 工具） */
  ipcMain.handle('datasets:preview', async (_e, id: unknown, table: unknown) => {
    try { return getStore().preview(IdSchema.parse(id), NameSchema.parse(table), 100) } catch (err) { return fail(err) }
  })
  /** 压缩的概况文本（敏感列已代号化）——界面「给 AI 看到的样子」用 */
  ipcMain.handle('datasets:profileText', async (_e, id: unknown, table?: unknown) => {
    try { return getStore().profileText(IdSchema.parse(id), table === undefined ? undefined : NameSchema.parse(table)) } catch (err) { return fail(err) }
  })
  ipcMain.handle('datasets:remove', async (_e, id: unknown) => {
    const ok = getStore().remove(IdSchema.parse(id))
    log.info('datasets', '删除数据集', { ok })
    notifyDataChanged('datasets')
    return ok
  })
  ipcMain.handle('datasets:setSensitive', async (_e, id: unknown, table: unknown, column: unknown, sensitive: unknown) => {
    try {
      getStore().setSensitive(IdSchema.parse(id), NameSchema.parse(table), NameSchema.parse(column), z.boolean().parse(sensitive))
      notifyDataChanged('datasets')
      return true
    } catch (err) { return fail(err) }
  })
  ipcMain.handle('datasets:rename', async (_e, id: unknown, name: unknown) => {
    try { getStore().rename(IdSchema.parse(id), z.string().max(100).parse(name)); notifyDataChanged('datasets'); return true } catch (err) { return fail(err) }
  })
  ipcMain.handle('datasets:setNote', async (_e, id: unknown, note: unknown) => {
    try { getStore().setNote(IdSchema.parse(id), z.string().max(2000).parse(note)); notifyDataChanged('datasets'); return true } catch (err) { return fail(err) }
  })
}
