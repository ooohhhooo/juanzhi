/**
 * 题目截图的框用页面墨迹修准（算法在 ink.ts，纯函数）：这里负责读页面图片、改库。需要 electron（nativeImage）。
 *  · 解析完成后对这份卷子修一次（run.ts）；
 *  · 旧数据：启动后在后台把已有卷子的框（不含老师手画的）逐份修一遍，只做一次（settings.crop_refined_v1），分片让出事件循环，不挡窗口。
 */
import path from 'node:path'
import { nativeImage } from 'electron'
import { getDb, getFilesDir } from '../db'
import { notifyDataChanged } from '../events'
import { grayFromBgra, refineBoxes } from './ink'
import type { Gray } from './ink'

const FLAG = 'crop_refined_v1'

function loadGray(paperId: string, rel: string): Gray | null {
  if (!/^page-\d{1,4}\.png$/.test(rel) || !/^[0-9a-f-]{36}$/.test(paperId)) return null
  const file = path.resolve(getFilesDir(), paperId, rel)
  if (!file.startsWith(path.resolve(getFilesDir()) + path.sep)) return null
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  return grayFromBgra(img.toBitmap(), width, height)
}

const BACKUP = 'crop_orig_v1'

function readBackup(db: any): Record<string, string> {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(BACKUP) as any
  try { return row ? JSON.parse(row.value_json) : {} } catch { return {} }
}

/**
 * 修一份卷子里所有题的框（老师手画的不动）；返回改了几道题。
 * 改之前把原框存进 settings.crop_orig_v1（题目 id → 原来的 bbox_json，只存第一次的原框），以后可以用 restoreOriginalBoxes 还原。
 */
export function refinePaperBoxes(paperId: string): number {
  const db = getDb()
  const pages = db.prepare("SELECT idx, image_rel FROM pages WHERE paper_id = ? AND image_rel <> ''").all(paperId) as Array<{ idx: number; image_rel: string }>
  const upd = db.prepare('UPDATE questions SET bbox_json = ? WHERE id = ?')
  const backup = readBackup(db)
  let changed = 0
  const changes: Array<{ id: string; orig: string; next: string }> = []
  for (const pg of pages) {
    const qs = db.prepare('SELECT id, bbox_json, bbox_source FROM questions WHERE paper_id = ? AND page_idx = ? AND bbox_json IS NOT NULL').all(paperId, pg.idx) as any[]
    if (qs.length === 0) continue
    const gray = loadGray(paperId, pg.image_rel)
    if (!gray) continue
    const orig = new Map<string, string>(qs.map(q => [q.id as string, q.bbox_json as string]))
    const boxes = qs.map(q => { let b: number[] | null = null; try { b = JSON.parse(q.bbox_json) } catch { /* 坏数据不动 */ } return { id: q.id as string, bbox: b ?? [], source: q.bbox_source as string | null } })
    for (const r of refineBoxes(gray, boxes)) changes.push({ id: r.id, orig: orig.get(r.id) ?? '', next: JSON.stringify(r.bbox) })
  }
  if (changes.length === 0) return 0
  db.exec('BEGIN')
  try {
    for (const c of changes) { if (!(c.id in backup) && c.orig) backup[c.id] = c.orig; upd.run(c.next, c.id); changed++ }
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(BACKUP, JSON.stringify(backup))
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
  return changed
}

/** 还原修框之前的原框（给排查用：备份在 settings.crop_orig_v1）；手画过的框不还原。返回还原了几道题 */
export function restoreOriginalBoxes(): number {
  const db = getDb()
  const backup = readBackup(db)
  let n = 0
  db.exec('BEGIN')
  try {
    for (const [id, orig] of Object.entries(backup)) {
      const r = db.prepare("UPDATE questions SET bbox_json = ? WHERE id = ? AND COALESCE(bbox_source, '') <> 'manual'").run(orig, id)
      n += Number(r.changes)
    }
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
  return n
}

/** 修一批卷子（后台，分片让出事件循环） */
async function refineMany(ids: string[]): Promise<number> {
  let total = 0
  for (const id of ids) {
    try { total += refinePaperBoxes(id) } catch (e) { console.warn(`[crop] 修框失败（${id}）：${(e as Error).message}`) }
    await new Promise<void>(res => setImmediate(res))
  }
  return total
}

/** 旧数据：后台逐份修一遍（只做一次）。返回 Promise<修了几道题>；已经做过返回 0 */
export async function refineAllOnce(): Promise<number> {
  const db = getDb()
  const done = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(FLAG) as any
  if (done) return 0
  const ids = (db.prepare("SELECT id FROM papers WHERE is_sample = 0 AND status IN ('reviewing', 'done') ORDER BY created_at, rowid").all() as Array<{ id: string }>).map(r => r.id)
  const total = await refineMany(ids)
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, 'true')").run(FLAG)
  if (total) notifyDataChanged('questions')
  return total
}

/**
 * 导入数据包之后：新增的卷子（合并导入给出 id；覆盖导入传 'all'）也要走同一套修框——框的留白现在只由 ink.ts 保证（PAD = 0），
 * 别的机器上解析出来的老框不修，裁出来会偏紧。
 */
export async function refineImported(ids: string[] | 'all'): Promise<number> {
  const db = getDb()
  if (ids === 'all') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(FLAG)
    return refineAllOnce()
  }
  const total = await refineMany(ids)
  if (total) notifyDataChanged('questions')
  return total
}
