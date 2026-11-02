import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import { z } from 'zod'
import { getDb } from '../db'
import { getMainWindow } from '../window'
import { allowPath } from '../allowedPaths'
import { notifyDataChanged } from '../events'
import { log } from '../log'
import { StatsFilterSchema } from '../stats/filter'
import { describeFilter } from '../stats/p2'
import { AiError } from '../ai/client'
import { CourseFileError } from '../course/table-read'
import { COL_FIELDS } from '../course/map'
import { courseDashboard, gapsToCsv } from '../course/stats'
import { SCENES, confirmDraft, createOutline, diffOutline, editMap, getOutline, listOutlines, mapRows, removeOutline, renameOutline, replaceOutline, searchLessons, setOutlineActive } from '../course/store'
import {
  adviceState, cancelMatch, confirmAdvice, copyAdvice, estimateMatch, generateAdvice, makeTemplate, matchProgressOf, previewOutline,
  readSourceFile, readSourceText, runMatch, sessionOf, suggestMappings
} from '../course/service'
import type { AdviceScope } from '../course/service'

const FilterArg = StatsFilterSchema.default({})
const IdSchema = z.string().uuid()
const OutlineIds = z.array(IdSchema).max(20)

const MappingSchema = z.object({
  headerRows: z.number().int().min(0).max(10),
  levelName: z.string().max(60),
  columns: z.array(z.object({ col: z.number().int().min(0).max(59), field: z.enum(COL_FIELDS) })).max(60),
  skipMarkers: z.array(z.string().max(20)).max(20),
  uncertain: z.array(z.string().max(120)).max(10)
})
const MappingsSchema = z.record(z.string().max(80), MappingSchema.nullable()).refine(o => Object.keys(o).length <= 20, '工作表太多')

const LessonSchema = z.object({
  seq: z.number().int().min(0).max(99999),
  noLabel: z.string().max(60),
  title: z.string().max(300),
  theme: z.string().max(300),
  textbookRef: z.string().max(500),
  points: z.array(z.object({ kind: z.enum(['word', 'pattern', 'phonics', 'expression', 'skill', 'other']), label: z.string().max(80), text: z.string().max(2000) })).max(12),
  raw: z.record(z.string().max(100), z.string().max(2000)).refine(o => Object.keys(o).length <= 80, '列太多')
})
const LevelsSchema = z.array(z.object({ name: z.string().min(1).max(60), lessons: z.array(LessonSchema).max(20000) })).max(40)
  .refine(ls => ls.reduce((n, l) => n + l.lessons.length, 0) <= 20000, '课次太多')
  .refine(ls => new Set(ls.map(l => l.name)).size === ls.length, '级别名不能重复')
const WarningsSchema = z.array(z.object({ kind: z.string().max(30), sheet: z.string().max(80), row: z.number().int().min(0).max(100000), text: z.string().max(300) })).max(300)

const SaveSchema = z.object({
  sessionId: IdSchema.optional(),
  name: z.string().trim().min(1, '请给课程体系起个名字').max(60),
  scene: z.enum(SCENES as [string, ...string[]]),
  termNote: z.string().max(100).default(''),
  replaceId: IdSchema.optional(),
  levels: LevelsSchema,
  warnings: WarningsSchema.default([]),
  mappings: MappingsSchema.default({}),
  aiModel: z.string().max(120).default('')
})

const ScopeSchema = z.object({ filter: FilterArg, outlineIds: OutlineIds })
const toScope = (raw: unknown): AdviceScope => {
  const s = ScopeSchema.parse(raw)
  return { filter: s.filter, outlineIds: s.outlineIds }
}

const fileFailure = (e: unknown): never => {
  if (e instanceof CourseFileError) throw new Error(e.message)
  throw e
}

export function registerCourseIpc(): void {
  const db = () => getDb()

  // ───── 管理 ─────
  ipcMain.handle('course:list', async () => listOutlines(db()))
  ipcMain.handle('course:get', async (_e, id: unknown) => getOutline(db(), IdSchema.parse(id)))
  ipcMain.handle('course:maps', async (_e, id: unknown) => mapRows(db(), IdSchema.parse(id)))
  ipcMain.handle('course:search', async (_e, ids: unknown, q: unknown) => searchLessons(db(), OutlineIds.parse(ids), z.string().max(60).parse(q ?? ''), 20))

  ipcMain.handle('course:setActive', async (_e, id: unknown, active: unknown) => {
    const ok = setOutlineActive(db(), IdSchema.parse(id), z.boolean().parse(active))
    notifyDataChanged('course')
    return ok
  })
  ipcMain.handle('course:rename', async (_e, id: unknown, name: unknown) => {
    const ok = renameOutline(db(), IdSchema.parse(id), z.string().trim().min(1).max(60).parse(name))
    notifyDataChanged('course')
    return ok
  })
  ipcMain.handle('course:confirmDraft', async (_e, id: unknown) => {
    const ok = confirmDraft(db(), IdSchema.parse(id))
    notifyDataChanged('course')
    return ok
  })
  ipcMain.handle('course:remove', async (_e, id: unknown) => {
    const ok = removeOutline(db(), IdSchema.parse(id))
    log.info('course', '删除课程体系', { ok })
    notifyDataChanged('course')
    return ok
  })

  // ───── 上传向导 ─────
  /** 选文件：弹系统对话框（路径随之登记），读成「读取会话」。取消返回 null */
  ipcMain.handle('course:pickFile', async () => {
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择课程表', filters: [{ name: '表格（.xlsx / .csv）', extensions: ['xlsx', 'csv', 'txt', 'xls', 'tsv'] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    allowPath(r.filePaths[0])
    return readSourceFile(r.filePaths[0]).catch(fileFailure)
  })
  /** 拖入文件：路径必须是 preload 对真实 File 取过路径、登记过的 */
  ipcMain.handle('course:readFile', async (_e, p: unknown) => readSourceFile(z.string().min(1).max(2000).parse(p)).catch(fileFailure))
  ipcMain.handle('course:readText', async (_e, t: unknown) => readSourceText(z.string().min(1).max(5_000_000).parse(t)).catch(fileFailure))

  /** 认列：会调用 AI（写 ai_usage），归写入类 */
  ipcMain.handle('course:suggest', async (_e, raw: unknown) => {
    const p = z.object({ sessionId: IdSchema, mode: z.enum(['ai', 'guess', 'manual']) }).parse(raw)
    try {
      const r = await suggestMappings(p.sessionId, p.mode)
      notifyDataChanged('usage')
      return r
    } catch (e) {
      if (e instanceof AiError) throw new Error(e.message)
      return fileFailure(e)
    }
  })
  ipcMain.handle('course:preview', async (_e, raw: unknown) => {
    const p = z.object({ sessionId: IdSchema, mappings: MappingsSchema }).parse(raw)
    try { return previewOutline(p.sessionId, p.mappings) } catch (e) { return fileFailure(e) }
  })
  ipcMain.handle('course:diff', async (_e, raw: unknown) => {
    const p = z.object({ id: IdSchema, levels: LevelsSchema }).parse(raw)
    return diffOutline(db(), p.id, p.levels)
  })

  ipcMain.handle('course:save', async (_e, raw: unknown) => {
    const p = SaveSchema.parse(raw)
    const src = p.sessionId ? (() => { try { return sessionOf(p.sessionId!) } catch { return null } })() : null
    const common = { sourceName: src?.name ?? '', sourceHash: src?.hash ?? '', mapping: p.mappings, warnings: p.warnings as never, aiModel: p.aiModel, levels: p.levels as never }
    if (p.replaceId) {
      const r = replaceOutline(db(), p.replaceId, common)
      log.info('course', '替换课程体系', { added: r.added, changed: r.changed, removed: r.removed })
      notifyDataChanged('course')
      return { id: p.replaceId, replaced: true, ...r }
    }
    const id = createOutline(db(), { ...common, name: p.name, scene: p.scene as never, termNote: p.termNote, status: 'active' })
    log.info('course', '保存课程体系', { levels: p.levels.length, lessons: p.levels.reduce((n, l) => n + l.lessons.length, 0) })
    notifyDataChanged('course')
    return { id, replaced: false }
  })

  // ───── 模板 ─────
  ipcMain.handle('course:template', async (_e, kind: unknown) => {
    const k = z.enum(['blank', 'sample']).parse(kind)
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title: k === 'blank' ? '保存空白模板' : '保存示例（虚构数据）', defaultPath: k === 'blank' ? '课程表模板.xlsx' : '课程表示例（虚构）.xlsx', filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    const buf = await makeTemplate(k)
    try { fs.writeFileSync(r.filePath, buf) } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用或没有写入权限，请换一个位置' : `保存失败：${(e as Error).message}`)
    }
    return { saved: true, path: r.filePath }
  })

  // ───── 匹配 ─────
  ipcMain.handle('course:matchEstimate', async (_e, id: unknown, onlyNew: unknown) => estimateMatch(db(), IdSchema.parse(id), z.boolean().default(false).parse(onlyNew)))
  ipcMain.handle('course:matchProgress', async (_e, id: unknown) => matchProgressOf(IdSchema.parse(id)))
  ipcMain.handle('course:matchCancel', async (_e, id: unknown) => cancelMatch(IdSchema.parse(id)))
  ipcMain.handle('course:match', async (e, id: unknown, onlyNew: unknown) => {
    const outlineId = IdSchema.parse(id)
    const sender = e.sender
    const r = await runMatch(db(), outlineId, {
      onlyNew: z.boolean().default(false).parse(onlyNew),
      onProgress: p => { if (!sender.isDestroyed()) sender.send('course:progress', p) }
    })
    notifyDataChanged('course', 'usage')
    return r
  })
  ipcMain.handle('course:mapEdit', async (_e, raw: unknown) => {
    const edit = z.union([
      z.object({ op: z.enum(['confirm', 'reject', 'reset']), kp: z.string().max(80), lessonId: z.number().int() }),
      z.object({ op: z.literal('add'), outlineId: IdSchema, kp: z.string().max(80), lessonId: z.number().int() }),
      z.object({ op: z.literal('none'), outlineId: IdSchema, kp: z.string().max(80) })
    ]).parse(raw)
    const ok = editMap(db(), edit as never)
    notifyDataChanged('course')
    return ok
  })

  // ───── 看板 ─────
  ipcMain.handle('course:dashboard', async (_e, raw: unknown) => {
    const s = toScope(raw)
    return courseDashboard(db(), s.filter, s.outlineIds)
  })
  ipcMain.handle('course:exportGaps', async (_e, raw: unknown) => {
    const s = toScope(raw)
    const d = courseDashboard(db(), s.filter, s.outlineIds)
    const csv = gapsToCsv(d.gaps.rows, { filterDesc: describeFilter(s.filter, 0), outlineNames: d.outlines.map(o => o.name), scene: d.outlines[0]?.scene ?? 'org' })
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title: '导出课程没覆盖的考点', defaultPath: '课程没覆盖的考点.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    try { fs.writeFileSync(r.filePath, csv, 'utf8') } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用（比如 Excel 里还开着它）或没有写入权限，请关闭后重试' : `保存失败：${(e as Error).message}`)
    }
    return { saved: true, path: r.filePath, rows: d.gaps.rows.length }
  })

  // ───── 家长沟通建议（流式走 ai:chunk，取消用 ai:cancel） ─────
  ipcMain.handle('course:adviceState', async (_e, raw: unknown) => adviceState(db(), toScope(raw)))
  ipcMain.handle('course:adviceGenerate', async (e, raw: unknown, rawRequestId: unknown) => {
    const scope = toScope(raw)
    const requestId = z.string().uuid().parse(rawRequestId)
    const sender = e.sender
    return generateAdvice(db(), scope, requestId,
      ev => { if (!sender.isDestroyed()) sender.send('ai:chunk', ev) },
      cb => { sender.once('destroyed', cb); return () => { sender.removeListener('destroyed', cb) } })
  })
  ipcMain.handle('course:adviceConfirm', async (_e, raw: unknown, acknowledged: unknown) => {
    const s = toScope(raw)
    const st = adviceState(db(), s)
    if (st.status !== 'fresh') return { ok: false, message: st.status === 'none' ? '还没有生成过建议' : '这份建议已经过期，请重新生成后再核对' }
    const r = confirmAdvice(db(), st.scopeKey, z.array(z.string().max(2000)).max(100).default([]).parse(acknowledged ?? []))
    notifyDataChanged('analysis')
    return r
  })
  ipcMain.handle('course:adviceCopy', async (_e, raw: unknown) => copyAdvice(db(), toScope(raw)))
}

