import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getDb, getFilesDir } from '../db'
import { registerImports, reprocessPaper, isQueued } from '../pipeline/queue'
import { notifyDataChanged } from '../events'
import { PaperMetaSchema, PaperFilterSchema } from '../types'
import { getMainWindow } from '../window'

const UuidSchema = z.string().uuid()
const PathsSchema = z.array(z.string().min(1)).min(1).max(100)

export function registerPaperIpc(): void {
  ipcMain.handle('papers:import', async (_event, rawPaths: unknown) => {
    return registerImports(PathsSchema.parse(rawPaths))
  })

  ipcMain.handle('papers:reprocess', async (_event, rawId: unknown) => {
    reprocessPaper(UuidSchema.parse(rawId))
    return true
  })

  ipcMain.handle('papers:list', async (_event, filter?: unknown) => {
    const db = getDb()
    let sql = 'SELECT * FROM papers WHERE 1=1'
    const params: any[] = []

    if (filter) {
      const f = PaperFilterSchema.parse(filter)
      if (f.grade) { sql += ' AND grade = ?'; params.push(f.grade) }
      if (f.semester) { sql += ' AND semester = ?'; params.push(f.semester) }
      if (f.school_year_start !== undefined && f.school_year_start !== null) {
        sql += ' AND school_year_start = ?'; params.push(f.school_year_start)
      }
      if (f.exam_type) { sql += ' AND exam_type = ?'; params.push(f.exam_type) }
      if (f.status) { sql += ' AND status = ?'; params.push(f.status) }
      if (f.textbook) { sql += ' AND textbook = ?'; params.push(f.textbook) }
      if (f.region) { sql += ' AND region = ?'; params.push(f.region) }
    }

    sql += ' ORDER BY created_at DESC'
    return db.prepare(sql).all(...params)
  })

  ipcMain.handle('papers:get', async (_event, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const db = getDb()
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id) ?? null
  })

  ipcMain.handle('papers:update', async (_event, rawId: unknown, meta: unknown) => {
    const id = UuidSchema.parse(rawId)
    const db = getDb()
    const m = PaperMetaSchema.parse(meta)
    const sets: string[] = []
    const params: any[] = []

    for (const [key, val] of Object.entries(m)) {
      if (val !== undefined) {
        sets.push(`${key} = ?`)
        params.push(val === null ? null : val)
      }
    }

    if (sets.length > 0) {
      params.push(id)
      db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      notifyDataChanged('papers')
    }

    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id) ?? null
  })

  ipcMain.handle('papers:remove', async (_event, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const db = getDb()

    const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(id)
    if (!paper) return false
    if (paper.status === 'extracting' || isQueued(id)) {
      throw new Error('试卷正在处理中，请稍候再删除')
    }

    db.prepare('DELETE FROM pages WHERE paper_id = ?').run(id)
    db.prepare('DELETE FROM papers WHERE id = ?').run(id)

    const paperDir = path.join(getFilesDir(), id)
    try {
      if (fs.existsSync(paperDir)) {
        fs.rmSync(paperDir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[papers] 清理文件目录失败: ${(e as Error).message}`)
    }

    notifyDataChanged('papers', 'pages')
    return true
  })

  ipcMain.handle('papers:pages', async (_event, rawPaperId: unknown) => {
    const paperId = UuidSchema.parse(rawPaperId)
    const db = getDb()
    return db.prepare(
      'SELECT * FROM pages WHERE paper_id = ? ORDER BY idx'
    ).all(paperId)
  })

  ipcMain.handle('dialog:openFiles', async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择试卷文件',
      filters: [
        { name: '试卷文件', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'docx'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
}
