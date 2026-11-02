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
import { PaperMetaSchema, PaperFilterSchema, ImportOptionsSchema, BatchIdsSchema } from '../types'
import type { BatchItemResult } from '../types'
import { allowPath, isPathAllowed } from '../allowedPaths'
import { walkFolder } from '../pipeline/folder-walk'
import type { SkippedFile } from '../pipeline/folder-walk'
import { getMainWindow } from '../window'

const UuidSchema = z.string().uuid()
const PathsSchema = z.array(z.string().min(1)).min(1).max(100)
/** 展开路径：一次最多 100 个入口（文件或文件夹） */
const ExpandSchema = z.array(z.string().min(1).max(4096)).min(1).max(100)

/** 改一份试卷的信息（单份和批量共用）。用户亲手改过（值真的变了）的字段不再算「AI 猜测」 */
function updatePaperMeta(id: string, m: ReturnType<typeof PaperMetaSchema.parse>): void {
  const db = getDb()
  const sets: string[] = []
  const params: any[] = []
  for (const [key, val] of Object.entries(m)) {
    if (val !== undefined) {
      sets.push(`${key} = ?`)
      params.push(val === null ? null : val)
    }
  }
  if (sets.length === 0) return
  const before = db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as Record<string, unknown> | undefined
  params.push(id)
  db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  // 编辑表单一次提交全部字段，所以不能按「提交了哪些字段」判断，只看哪些字段的值和之前不同
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

/** 删一份试卷的库记录（单份和批量共用）：正在处理的拒绝；返回 false = 本来就不存在。文件目录由 removePaperFiles 另删（不放进事务） */
function removePaperRows(id: string): boolean {
  const db = getDb()
  const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(id)
  if (!paper) return false
  if (paper.status === 'extracting' || paper.status === 'parsing' || isQueued(id) || isParseActive(id)) {
    throw new Error('试卷正在处理中，请稍候再删除')
  }
  db.prepare('DELETE FROM papers WHERE id = ?').run(id)  // pages / paper_assets 由外键级联删除
  // 原来因这份被标成「疑似重复」的卷子，原卷没了：重新判断（可能恢复计入统计）
  try { redetectAfterRemoval(db, id) } catch (e) { console.warn(`[papers] 重新检查重复卷失败: ${(e as Error).message}`) }
  return true
}

function removePaperFiles(id: string): void {
  const paperDir = path.join(getFilesDir(), id)
  try {
    if (fs.existsSync(paperDir)) {
      fs.rmSync(paperDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  } catch (e) {
    console.warn(`[papers] 清理文件目录失败: ${(e as Error).message}`)
  }
}

function removePaper(id: string): boolean {
  const ok = removePaperRows(id)
  if (ok) { removePaperFiles(id); notifyDataChanged('papers', 'pages', 'questions') }
  return ok
}

/** 批量处理：每 BATCH_CHUNK 份一个事务（一次写盘），份与份之间让出主进程，界面不会卡住 */
const BATCH_CHUNK = 100
const yieldNow = () => new Promise<void>(r => setImmediate(r))
async function inChunks<T>(ids: string[], work: (id: string) => T, afterCommit?: (done: Array<{ id: string; r: T }>) => void): Promise<Array<{ id: string; r: T | Error }>> {
  const db = getDb()
  const out: Array<{ id: string; r: T | Error }> = []
  for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
    const part = ids.slice(i, i + BATCH_CHUNK)
    const done: Array<{ id: string; r: T }> = []
    db.exec('BEGIN')
    try {
      for (const id of part) {
        try { const r = work(id); done.push({ id, r }); out.push({ id, r }) } catch (e) { out.push({ id, r: e as Error }) }
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已经结束 */ }
      throw e
    }
    afterCommit?.(done)
    await yieldNow()
  }
  return out
}

export function registerPaperIpc(): void {
  // 只有 preload 的 getPathForFile（对真实 File 对象取路径）会发这条消息，渲染端页面脚本调用不到
  ipcMain.on('paths:register', (_event, p: unknown) => {
    if (typeof p === 'string' && p.length < 4096) allowPath(p)
  })

  ipcMain.handle('papers:import', async (_event, rawPaths: unknown, rawOpts?: unknown) => {
    return registerImports(PathsSchema.parse(rawPaths), ImportOptionsSchema.parse(rawOpts))
  })

  /**
   * 把拖入 / 选择的路径展开：文件原样保留，文件夹递归扫描出里面支持的试卷文件（跳过 ._、隐藏文件、不支持的类型）。
   * 文件夹本身必须是经对话框或 preload 登记过的；扫出来的文件随之视为已授权。真正导入仍走 papers:import（逐个再检查）。
   */
  ipcMain.handle('papers:expandPaths', async (_event, rawPaths: unknown) => {
    const paths = ExpandSchema.parse(rawPaths)
    const files: string[] = []
    const skipped: SkippedFile[] = []
    let folders = 0
    let truncated = false
    for (const p of paths) {
      let isDir = false
      try { isDir = fs.statSync(p).isDirectory() } catch { /* 不存在：当文件交给导入去报错 */ }
      if (!isDir) { files.push(p); continue }
      if (!isPathAllowed(p)) { skipped.push({ name: path.basename(p), reason: '文件夹未经授权：请通过对话框选择或拖入窗口' }); continue }
      folders++
      const r = walkFolder(p)
      r.files.forEach(allowPath)
      files.push(...r.files)
      skipped.push(...r.skipped)
      truncated = truncated || r.truncated
    }
    return { files, folders, skipped, truncated }
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = { title: '选择放试卷的文件夹', properties: ['openDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    result.filePaths.forEach(allowPath)
    return result.filePaths
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
    updatePaperMeta(id, PaperMetaSchema.parse(meta))
    return getDb().prepare('SELECT * FROM papers WHERE id = ?').get(id) ?? null
  })

  /** 批量改信息：同一份改动逐份套用（校验、AI 猜测标记的处理和单份修改完全一样）；只改传进来的字段 */
  ipcMain.handle('papers:batchUpdate', async (_event, rawIds: unknown, meta: unknown) => {
    const ids = BatchIdsSchema.parse(rawIds)
    const m = PaperMetaSchema.omit({ title: true }).strict().parse(meta)
    if (Object.values(m).every(v => v === undefined)) throw new Error('没有要修改的内容')
    const db = getDb()
    const res = await inChunks(ids, id => {
      if (!db.prepare('SELECT 1 FROM papers WHERE id = ?').get(id)) return false
      updatePaperMeta(id, m)
      return true
    })
    return res.map(({ id, r }): BatchItemResult => r instanceof Error ? { id, ok: false, reason: r.message } : r ? { id, ok: true } : { id, ok: false, reason: '这份试卷已经不存在' })
  })

  ipcMain.handle('papers:remove', async (_event, rawId: unknown) => removePaper(UuidSchema.parse(rawId)))

  /** 批量删除：逐份走和单份删除同一条规则（removePaperRows）；正在提取 / 解析 / 排队的试卷不删，原因写在结果里；库记录一个事务删完再清文件 */
  ipcMain.handle('papers:batchRemove', async (_event, rawIds: unknown) => {
    const ids = BatchIdsSchema.parse(rawIds)
    const res = await inChunks(ids, removePaperRows, done => { for (const d of done) if (d.r) removePaperFiles(d.id) })
    notifyDataChanged('papers', 'pages', 'questions')
    return res.map(({ id, r }): BatchItemResult => r instanceof Error ? { id, ok: false, reason: r.message } : r ? { id, ok: true } : { id, ok: false, reason: '这份试卷已经不存在' })
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
