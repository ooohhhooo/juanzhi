import { ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import { getDb } from '../db'
import { isPathAllowed } from '../allowedPaths'
import { notifyDataChanged } from '../events'
import { SUBJECT_IDS } from '../../shared/subject'
import { bookPage, bookUnits, getBook, listBooks, removeBook, unitWordList } from '../bookindex/store'
import { searchBooks } from '../bookindex/search'
import { buildStates, cancelBookBuild, scheduleBookBuild } from '../bookindex/service'

const IdArg = z.string().min(8).max(64)
const SearchOpts = z.object({
  bookIds: z.array(IdArg).max(50).optional(),
  subject: z.enum(SUBJECT_IDS).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  question: z.boolean().optional(),
  includeFront: z.boolean().optional()
}).default({})

/** 教材书库：搜索 / 查询 / 管理。书的原文只在本机，不发给 AI */
export function registerBookIndexIpc(): void {
  ipcMain.handle('books:list', async () => listBooks(getDb()))
  ipcMain.handle('books:status', async () => buildStates())
  ipcMain.handle('books:search', async (_e, query: unknown, opts?: unknown) =>
    searchBooks(getDb(), z.string().max(4000).parse(query ?? ''), SearchOpts.parse(opts ?? undefined)))
  ipcMain.handle('books:units', async (_e, id: unknown) => bookUnits(getDb(), IdArg.parse(id)))
  ipcMain.handle('books:page', async (_e, id: unknown, page: unknown) => bookPage(getDb(), IdArg.parse(id), z.number().int().min(1).max(5000).parse(page)))
  ipcMain.handle('books:unitWords', async (_e, id: unknown, unitKey: unknown) => unitWordList(getDb(), IdArg.parse(id), z.string().max(80).parse(unitKey)))

  /** 手动把一本教材 PDF 加进书库（路径必须是对话框返回或拖入时登记过的） */
  ipcMain.handle('books:addFile', async (_e, raw: unknown) => {
    const p = z.object({ path: z.string().min(1).max(2000), name: z.string().max(200).optional(), subject: z.enum(SUBJECT_IDS).optional() }).parse(raw)
    if (!isPathAllowed(p.path)) throw new Error('这个文件没有经过选择对话框或拖入，不能读取')
    if (!/\.pdf$/i.test(p.path)) throw new Error('书库目前只支持 PDF 教材')
    const hash = await new Promise<string>((resolve, reject) => { const h = crypto.createHash('sha1'); const st = fs.createReadStream(p.path); st.on('data', c => h.update(c)); st.on('error', reject); st.on('end', () => resolve(h.digest('hex'))) })
    const name = (p.name ?? p.path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')).slice(0, 200)
    return scheduleBookBuild({ file: p.path, hash, name, subject: p.subject ?? null })
  })
  ipcMain.handle('books:cancel', async (_e, hash: unknown) => { cancelBookBuild(IdArg.parse(hash)); return true })
  ipcMain.handle('books:remove', async (_e, id: unknown) => {
    const bid = IdArg.parse(id)
    if (!getBook(getDb(), bid)) return false
    removeBook(getDb(), bid)
    notifyDataChanged('books')
    return true
  })
}
