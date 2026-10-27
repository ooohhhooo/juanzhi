import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getDb, getFilesDir } from '../db'
import { registerImports, reprocessPaper, isQueued } from '../pipeline/queue'
import { isParseActive } from '../parse/queue'
import { redetectAfterRemoval } from '../parse/similar'
import { similarScanStatus, startSimilarScan } from '../similar-runner'
import { notifyDataChanged } from '../events'
import { PaperMetaSchema, PaperFilterSchema, ImportOptionsSchema } from '../types'
import { allowPath } from '../allowedPaths'
import { getMainWindow } from '../window'

const UuidSchema = z.string().uuid()
const PathsSchema = z.array(z.string().min(1)).min(1).max(100)

export function registerPaperIpc(): void {
  // 只有 preload 的 getPathForFile（对真实 File 对象取路径）会发这条消息，渲染端页面脚本调用不到
  ipcMain.on('paths:register', (_event, p: unknown) => {
    if (typeof p === 'string' && p.length < 4096) allowPath(p)
  })

  ipcMain.handle('papers:import', async (_event, rawPaths: unknown, rawOpts?: unknown) => {
    return registerImports(PathsSchema.parse(rawPaths), ImportOptionsSchema.parse(rawOpts))
  })

  ipcMain.handle('papers:assets', async (_event, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    return getDb().prepare('SELECT * FROM paper_assets WHERE paper_id = ? ORDER BY page_idx, seq').all(id)
  })

  ipcMain.handle('papers:reprocess', async (_event, rawId: unknown) => {
    reprocessPaper(UuidSchema.parse(rawId))
    return true
  })

  ipcMain.handle('papers:list', async (_event, filter?: unknown) => {
    const db = getDb()
    let sql = 'SELECT papers.*, (SELECT s.title FROM papers s WHERE s.id = papers.similar_to) AS similar_title FROM papers WHERE 1=1'
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
    return db.prepare('SELECT papers.*, (SELECT s.title FROM papers s WHERE s.id = papers.similar_to) AS similar_title FROM papers WHERE id = ?').get(id) ?? null
  })

  /** 「确实是新卷，计入统计」：老师看过提示后确认这份不是重复卷（以后不再标成疑似重复） */
  ipcMain.handle('papers:acceptSimilar', async (_event, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const r = getDb().prepare("UPDATE papers SET similar_state = 'accepted' WHERE id = ? AND similar_state = 'suspect'").run(id)
    if (r.changes > 0) notifyDataChanged('papers')
    return r.changes > 0
  })

  /**
   * 「检查重复试卷」：后台对库里已有的卷子（按导入先后）补跑一遍疑似重复检测，不卡界面；老师确认过的不动。
   * 返回的 Promise 在扫描结束时才完成（按钮可以据此显示「检查中」）；进度走 `similar:progress` 事件，`papers.scanSimilarStatus()` 可随时查询。
   */
  ipcMain.handle('papers:scanSimilar', async () => startSimilarScan())
  ipcMain.handle('papers:scanSimilarStatus', async () => similarScanStatus())

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
      const before = db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as Record<string, unknown> | undefined
      params.push(id)
      db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      // 用户亲手改过（值真的变了）的字段不再算「AI 猜测」。编辑表单一次提交全部字段，
      // 所以不能按「提交了哪些字段」判断，只看哪些字段的值和之前不同
      const changed = Object.entries(m).filter(([k, v]) => v !== undefined && (before?.[k] ?? null) !== v).map(([k]) => k)
      const aiJson = before?.ai_meta_json as string | null | undefined
      if (aiJson && changed.length) {
        try {
          const kept = (JSON.parse(aiJson) as string[]).filter(k => !changed.includes(k))
          db.prepare('UPDATE papers SET ai_meta_json = ? WHERE id = ?').run(JSON.stringify(kept), id)
        } catch { /* 忽略损坏的标记 */ }
      }
      notifyDataChanged('papers')
    }

    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id) ?? null
  })

  ipcMain.handle('papers:remove', async (_event, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const db = getDb()

    const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(id)
    if (!paper) return false
    if (paper.status === 'extracting' || paper.status === 'parsing' || isQueued(id) || isParseActive(id)) {
      throw new Error('试卷正在处理中，请稍候再删除')
    }

    db.prepare('DELETE FROM papers WHERE id = ?').run(id)  // pages / paper_assets 由外键级联删除

    const paperDir = path.join(getFilesDir(), id)
    try {
      if (fs.existsSync(paperDir)) {
        fs.rmSync(paperDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    } catch (e) {
      console.warn(`[papers] 清理文件目录失败: ${(e as Error).message}`)
    }

    // 原来因这份被标成「疑似重复」的卷子，原卷没了：重新判断（可能恢复计入统计）
    try { redetectAfterRemoval(db, id) } catch (e) { console.warn(`[papers] 重新检查重复卷失败: ${(e as Error).message}`) }

    notifyDataChanged('papers', 'pages', 'questions')
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
    if (result.canceled) return []
    result.filePaths.forEach(allowPath)
    return result.filePaths
  })
}
