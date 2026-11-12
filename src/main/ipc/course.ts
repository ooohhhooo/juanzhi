import { ipcMain, dialog, clipboard } from 'electron'
import fs from 'node:fs'
import { z } from 'zod'
import { getDb, getDataDir } from '../db'
import { getMainWindow } from '../window'
import { allowPath } from '../allowedPaths'
import { notifyDataChanged } from '../events'
import { log } from '../log'
import { StatsFilterSchema } from '../stats/filter'
import { asSubject, SUBJECT_IDS } from '../../shared/subject'
import { describeFilter } from '../stats/p2'
import { AiError } from '../ai/client'
import { withSpend } from './cost'
import { CourseFileError } from '../course/table-read'
import { COL_FIELDS } from '../course/map'
import { courseDashboard, gapsToCsv } from '../course/stats'
import { compareCourseTextbook, compareToCsv, compareToText } from '../course/compare'
import { CATALOG, findEdition } from '../course/catalog'
import { addBuiltinTextbook, catalogInfo, makeCatalogProvider, markBuiltinChecked, refreshBuiltinTextbook } from '../course/textbook-builtin'
import { setCatalogProvider } from '../course/textbook-edition'
import { SCENES, applyTextbookMaps, confirmDraft, createOutline, setOutlineKind, diffOutline, editMap, getOutline, listOutlines, mapRows, removeOutline, renameOutline, replaceOutline, searchLessons, setOutlineActive } from '../course/store'
import {
  adviceState, cancelMatch, confirmAdvice, copyAdvice, estimateMatch, generateAdvice, makeTemplate, matchProgressOf, previewOutline,
  cancelSuggest, setJobHooks, setSessionSubject, outlineBusy, readSourceFile, resolveLevels, readSourceText, runMatch, sessionOf, suggestMappings, sourceInfo, keepSession, dropSession,
  sessionKind, sessionBuiltinId, textbookPageOf, textbookUnitsOf, useBuiltinCatalog
} from '../course/service'
import { promptVersionFor } from '../ai/prompts'
import type { SuggestResult } from '../course/service'
import { createJobQueue } from '../course/job-queue'
import { researchTableWithCourseware, clampPerKp } from '../course/research-table'
import { researchXlsx } from '../course/research-xlsx'
import { polishAdvice } from '../course/research-service'
import { addCourseware, dropCoursewareOf, listCourseware, lessonKey, removeCourseware } from '../course/courseware'
import { readCoursewareFile } from '../course/doc-read'
import type { AdviceScope } from '../course/service'

const FilterArg = StatsFilterSchema.default({})
const MAX_FILES = 20
const IdSchema = z.string().uuid()
/** 学科（可选，缺省英语） */
const SubjectArg = z.enum(SUBJECT_IDS).optional()
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
  /** 界面改过格子时才带；没改过只带 sessionId + mappings，由主进程用会话里的整理结果 */
  levels: LevelsSchema.optional(),
  warnings: WarningsSchema.default([]),
  mappings: MappingsSchema.default({}),
  aiModel: z.string().max(120).default(''),
  /** 替换会删掉老师确认 / 手工指定的对应时，用户在确认框里明确同意 */
  confirmLockedLoss: z.boolean().default(false),
  /** 新建体系属于哪个学科（缺省英语）；替换时以原体系为准 */
  subject: SubjectArg,
  /** 课程表 / 教材课本（教材整理会话以会话为准） */
  kind: z.enum(['course', 'textbook']).optional(),
  /** 教材：每个单元（课次 = 单元序号）的知识点，核对界面里老师增删、确认后的结果 */
  unitKps: z.array(z.object({
    seq: z.number().int().min(0).max(99999),
    kps: z.array(z.object({ code: z.string().max(80), confidence: z.string().max(10), quote: z.string().max(200).default(''), reason: z.string().max(200).default(''), confirmed: z.boolean().default(false), manual: z.boolean().default(false) })).max(12)
  })).max(2000).optional()
})
/** 读文件时的选项：课程表 / 教材课本、页码范围（如 "1-60"）、学科 */
const ReadOptsSchema = z.object({ kind: z.enum(['course', 'textbook']).optional(), pageRange: z.string().max(200).optional(), subject: SubjectArg }).optional()

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
  setCatalogProvider(makeCatalogProvider(CATALOG))   // 整本书上传认出版本后，据此提示「用内置目录」

  // ───── 管理 ─────
  ipcMain.handle('course:list', async (_e, subject?: unknown) => listOutlines(db(), SubjectArg.parse(subject ?? undefined)))
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
    const oid = IdSchema.parse(id)
    if (outlineBusy(oid)) throw new Error('这个课程体系正在匹配 / 生成家长建议，请等它结束或先取消，再删除')
    const ok = removeOutline(db(), oid)
    if (ok) dropCoursewareOf(getDataDir(), oid)
    log.info('course', '删除课程体系', { ok })
    notifyDataChanged('course')
    return ok
  })

  // ───── 上传向导 ─────
  /** 选文件（可多选）：弹系统对话框（路径随之登记），每个文件读成一个「读取会话」；读不了的文件只记下原因。取消返回 null */
  ipcMain.handle('course:pickFile', async (_e, rawOpts?: unknown) => {
    const ropts = ReadOptsSchema.parse(rawOpts ?? undefined) ?? {}
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择课程表', filters: [{ name: '课程表（Excel、CSV、Word、PDF、图片）', extensions: ['xlsx', 'csv', 'txt', 'xls', 'tsv', 'docx', 'doc', 'pdf', 'png', 'jpg', 'jpeg', 'heic'] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile', 'multiSelections'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return null
    const sources = [] as Awaited<ReturnType<typeof readSourceFile>>[]
    const errors: string[] = []
    for (const p of r.filePaths.slice(0, MAX_FILES)) {
      allowPath(p)
      try { sources.push(await readSourceFile(p, ropts)) } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
    }
    return { sources, errors }
  })
  /** 拖入文件：路径必须是 preload 对真实 File 取过路径、登记过的 */
  ipcMain.handle('course:readFile', async (_e, p: unknown, rawOpts?: unknown) => readSourceFile(z.string().min(1).max(2000).parse(p), ReadOptsSchema.parse(rawOpts ?? undefined) ?? {}).catch(fileFailure))
  /** 教材整理好之后：每个单元的页码、小节标题和 AI 挑的知识点；看原书某一页；用软件内置的这一册目录 */
  ipcMain.handle('course:textbookUnits', async (_e, sid: unknown) => { try { return textbookUnitsOf(IdSchema.parse(sid)) } catch (e) { return fileFailure(e) } })
  ipcMain.handle('course:textbookPage', async (_e, sid: unknown, page: unknown) => { try { return await textbookPageOf(IdSchema.parse(sid), z.number().int().min(1).max(100000).parse(page)) } catch (e) { return fileFailure(e) } })
  ipcMain.handle('course:useBuiltinCatalog', async (_e, sid: unknown) => { try { return useBuiltinCatalog(IdSchema.parse(sid)) } catch (e) { return fileFailure(e) } })
  ipcMain.handle('course:readText', async (_e, t: unknown) => readSourceText(z.string().min(1).max(5_000_000).parse(t)).catch(fileFailure))

  /** 认列：会调用 AI（写 ai_usage），归写入类 */
  ipcMain.handle('course:suggest', async (_e, raw: unknown) => {
    const p = z.object({ sessionId: IdSchema, mode: z.enum(['ai', 'guess', 'manual']), subject: SubjectArg }).parse(raw)
    if (p.subject) setSessionSubject(p.sessionId, p.subject)
    try {
      const r = await suggestMappings(p.sessionId, p.mode)
      notifyDataChanged('usage')
      return r
    } catch (e) {
      if (e instanceof AiError) throw new Error(e.message)
      return fileFailure(e)
    }
  })

  // ───── 后台整理（任务只放内存，重启后丢失） ─────
  const queue = createJobQueue<SuggestResult>({
    concurrency: 2,
    onChange: () => notifyDataChanged('course', 'usage'),
    onRemoved: j => { dropSession(j.sessionId) },
    run: async (j, signal, report) => {
      const onAbort = () => { cancelSuggest(j.sessionId) }
      signal.addEventListener('abort', onAbort)
      try {
        const sess = sessionOf(j.sessionId)
        return await withSpend('course-organize', () => suggestMappings(j.sessionId, sess.extract ? 'ai' : j.mode, report), { noBalance: !sess.extract && j.mode !== 'ai' })
      } finally { signal.removeEventListener('abort', onAbort) }
    },
    describeError: e => (e instanceof Error ? e.message : String(e)).slice(0, 160)
  })
  setJobHooks({ busy: () => queue.busy(), clear: () => queue.clear() })
  const jobInfo = (j: ReturnType<typeof queue.list>[number]) => ({
    id: j.id, sessionId: j.sessionId, fileName: j.fileName, status: j.status, error: j.error ?? '', name: j.name, scene: j.scene, termNote: j.termNote, replaceId: j.replaceId ?? null, subject: asSubject(j.subject), mode: j.mode, progress: j.status === 'running' ? j.progress ?? null : null
  })
  ipcMain.handle('course:jobStart', async (_e, raw: unknown) => {
    const items = z.array(z.object({
      sessionId: IdSchema, name: z.string().trim().max(60), scene: z.enum(SCENES as [string, ...string[]]), termNote: z.string().max(100).default(''),
      mode: z.enum(['ai', 'manual']), replaceId: IdSchema.optional(), subject: SubjectArg
    })).min(1).max(MAX_FILES).parse(raw)
    // 先全部校验，通过后再统一入队，避免部分入队后抛错、重试时重复建任务
    const seen = new Set<string>()
    const taken = new Set(queue.list().filter(j => j.status === 'queued' || j.status === 'running').map(j => j.sessionId))
    const names = items.map(it => {
      if (seen.has(it.sessionId)) throw new Error('同一个文件被重复添加了，请去掉重复的再试')
      seen.add(it.sessionId)
      if (taken.has(it.sessionId)) throw new Error('这个文件已经在整理中，请不要重复添加')
      return sessionOf(it.sessionId).name
    })
    const out = items.map((it, i) => {
      keepSession(it.sessionId, true)
      setSessionSubject(it.sessionId, it.subject)
      return queue.add({ ...it, fileName: names[i], name: it.name || names[i].slice(0, 60) })
    })
    return out.map(jobInfo)
  })
  ipcMain.handle('course:jobs', async () => queue.list().map(jobInfo))
  /** 待核对的任务交给向导：原表预览 + 认列结果（任务保留，保存成功后才移除） */
  ipcMain.handle('course:jobTake', async (_e, id: unknown) => {
    const j = queue.get(z.string().min(1).max(40).parse(id))
    if (!j || j.status !== 'ready' || !j.result) throw new Error('这个任务已经不在了，请重新添加')
    let source
    try { source = sourceInfo(j.sessionId, sessionOf(j.sessionId)) } catch (e) { return fileFailure(e) }
    return { job: jobInfo(j), source, items: j.result.items, model: j.result.model, organised: !!j.result.source }
  })
  ipcMain.handle('course:jobCancel', async (_e, id: unknown) => queue.remove(z.string().min(1).max(40).parse(id)))
  ipcMain.handle('course:jobRemove', async (_e, id: unknown) => queue.remove(z.string().min(1).max(40).parse(id)))
  ipcMain.handle('course:jobRetry', async (_e, id: unknown) => queue.retry(z.string().min(1).max(40).parse(id)))
  ipcMain.handle('course:suggestCancel', async (_e, sid: unknown) => cancelSuggest(IdSchema.parse(sid)))
  ipcMain.handle('course:preview', async (_e, raw: unknown) => {
    const p = z.object({ sessionId: IdSchema, mappings: MappingsSchema }).parse(raw)
    try { return previewOutline(p.sessionId, p.mappings) } catch (e) { return fileFailure(e) }
  })
  ipcMain.handle('course:diff', async (_e, raw: unknown) => {
    const p = z.object({ id: IdSchema, sessionId: IdSchema.optional(), mappings: MappingsSchema.default({}), levels: LevelsSchema.optional() }).parse(raw)
    try { return diffOutline(db(), p.id, resolveLevels(p.sessionId, p.mappings, p.levels as never).levels) } catch (e) { return fileFailure(e) }
  })

  ipcMain.handle('course:save', async (_e, raw: unknown) => {
    const p = SaveSchema.parse(raw)
    const src = p.sessionId ? (() => { try { return sessionOf(p.sessionId!) } catch { return null } })() : null
    let resolved
    try { resolved = resolveLevels(p.sessionId, p.mappings, p.levels as never) } catch (e) { return fileFailure(e) }
    const levels = resolved.levels.filter(l => l.lessons.length)
    const kind = sessionKind(p.sessionId) ?? p.kind
    const bid = sessionBuiltinId(p.sessionId)
    const common = { sourceName: src?.name ?? '', sourceHash: src?.hash ?? '', mapping: p.mappings, warnings: (p.warnings.length ? p.warnings : resolved.warnings.slice(0, 300)) as never, aiModel: p.aiModel, levels }
    if (p.replaceId) {
      if (outlineBusy(p.replaceId)) throw new Error('这个课程体系正在匹配 / 生成家长建议，请等它结束或先取消，再替换')
      const r = replaceOutline(db(), p.replaceId, { ...common, confirmLockedLoss: p.confirmLockedLoss })
      setOutlineKind(db(), p.replaceId, kind)
      if (p.unitKps?.length) applyTextbookMaps(db(), p.replaceId, p.unitKps, { model: p.aiModel, promptVersion: promptVersionFor('p5_course_textbook') }, false)
      log.info('course', '替换课程体系', { added: r.added, changed: r.changed, removed: r.removed })
      notifyDataChanged('course')
      return { id: p.replaceId, replaced: true, ...r }
    }
    const id = createOutline(db(), { ...common, name: p.name, scene: p.scene as never, termNote: p.termNote, status: 'active', subject: asSubject(src?.subject ?? p.subject), kind, builtinId: bid })
    if (p.unitKps?.length) applyTextbookMaps(db(), id, p.unitKps, { model: p.aiModel, promptVersion: promptVersionFor('p5_course_textbook') })
    if (bid) markBuiltinChecked(db(), id, asSubject(src?.subject ?? p.subject))   // 用内置目录整理的：和「添加学校教材」一样，知识点都记为已检查、不需要 AI 匹配   // 学科以整理会话里锁定的为准，其次才是界面传来的
    log.info('course', '保存课程体系', { levels: levels.length, lessons: levels.reduce((n, l) => n + l.lessons.length, 0) })
    notifyDataChanged('course')
    return { id, replaced: false }
  })

  // ───── 模板 ─────
  ipcMain.handle('course:template', async (_e, kind: unknown, subject?: unknown) => {
    const k = z.enum(['blank', 'sample']).parse(kind)
    const sub = SubjectArg.parse(subject ?? undefined)
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title: k === 'blank' ? '保存空白模板' : '保存示例（虚构数据）', defaultPath: k === 'blank' ? '课程表模板.xlsx' : '课程表示例（虚构）.xlsx', filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    const buf = await makeTemplate(k, sub)
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
    const r = await withSpend('course-match', () => runMatch(db(), outlineId, {
      onlyNew: z.boolean().default(false).parse(onlyNew),
      onProgress: p => { if (!sender.isDestroyed()) sender.send('course:progress', p) }
    }))
    notifyDataChanged('course', 'usage')
    return r
  })
  ipcMain.handle('course:mapEdit', async (_e, raw: unknown) => {
    const edit = z.union([
      z.object({ op: z.enum(['confirm', 'reject', 'reset']), kp: z.string().max(80), lessonId: z.number().int() }),
      z.object({ op: z.literal('add'), outlineId: IdSchema, kp: z.string().max(80), lessonId: z.number().int() }),
      z.object({ op: z.literal('none'), outlineId: IdSchema, kp: z.string().max(80), force: z.boolean().optional() })
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

  // ───── 学校教材：内置目录、添加 / 更新、和机构课程对比 ─────
  ipcMain.handle('course:catalog', async (_e, subject?: unknown) => catalogInfo(CATALOG, SubjectArg.parse(subject ?? undefined) ?? 'english'))
  ipcMain.handle('course:addBuiltin', async (_e, raw: unknown) => {
    const p = z.object({ editionId: z.string().max(40), books: z.array(z.string().max(10)).min(1).max(30) }).parse(raw)
    const ed = findEdition(p.editionId)
    if (!ed) throw new Error('没有这个内置版本')
    const r = addBuiltinTextbook(db(), ed, p.books)
    log.info('course', '添加内置教材', { edition: ed.id, books: p.books.length, lessons: r.lessons })
    notifyDataChanged('course')
    return r
  })
  ipcMain.handle('course:refreshBuiltin', async (_e, id: unknown, confirm: unknown) => {
    const oid = IdSchema.parse(id)
    if (confirm !== true) throw new Error('重新从内置更新会覆盖你手工改过的知识点对应，需要先确认')
    if (outlineBusy(oid)) throw new Error('这份教材正在使用中，请稍后再更新')
    const r = refreshBuiltinTextbook(db(), oid, CATALOG)
    notifyDataChanged('course')
    return r
  })
  const CompareScope = z.object({ filter: FilterArg, courseId: IdSchema, textbookIds: OutlineIds })
  ipcMain.handle('course:compare', async (_e, raw: unknown) => {
    const s = CompareScope.parse(raw)
    return compareCourseTextbook(db(), s.filter, s.courseId, s.textbookIds)
  })
  ipcMain.handle('course:compareCopy', async (_e, raw: unknown) => {
    const s = CompareScope.parse(raw)
    const text = compareToText(compareCourseTextbook(db(), s.filter, s.courseId, s.textbookIds))
    clipboard.writeText(text)
    return { text, chars: text.length }
  })
  ipcMain.handle('course:compareExport', async (_e, raw: unknown) => {
    const s = CompareScope.parse(raw)
    const r0 = compareCourseTextbook(db(), s.filter, s.courseId, s.textbookIds)
    if (!r0.ready) throw new Error(r0.reason)
    const csv = compareToCsv(r0, { filterDesc: describeFilter(s.filter, 0) })
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title: '导出机构课程与学校教材的对比', defaultPath: '机构课程与学校教材对比.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    try { fs.writeFileSync(r.filePath, csv, 'utf8') } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用（比如 Excel 里还开着它）或没有写入权限，请关闭后重试' : `保存失败：${(e as Error).message}`)
    }
    return { saved: true, path: r.filePath, rows: r0.units.reduce((n, u) => n + Math.max(1, u.kps.length), 0) }
  })

  // ───── 教研对照表：机构大纲 A（+B）× 学校教材 × 校内试卷；课件按节挂在大纲上（只在本机读文字，存在数据目录里） ─────
  const ResearchScope = z.object({ filter: FilterArg, courseId: IdSchema, courseBId: IdSchema.optional(), textbookIds: z.array(IdSchema).max(60).default([]), perKp: z.number().int().min(1).max(10).default(3), ai: z.boolean().default(false) })
  const buildResearch = async (raw: unknown) => {
    const s = ResearchScope.parse(raw)
    const table = researchTableWithCourseware(db(), getDataDir(), s.filter, { courseId: s.courseId, courseBId: s.courseBId, textbookIds: s.textbookIds, perKp: clampPerKp(s.perKp) })
    let aiNote = ''
    if (s.ai && table.ready) {
      const r = await polishAdvice(table, getDataDir())
      aiNote = r.note
      notifyDataChanged('usage')
    }
    return { table, aiNote, filterDesc: describeFilter(s.filter, 0) }
  }
  ipcMain.handle('course:researchTable', async (_e, raw: unknown) => buildResearch(raw))
  ipcMain.handle('course:researchExport', async (_e, raw: unknown) => {
    const r = await buildResearch(raw)
    if (!r.table.ready) throw new Error(r.table.reason)
    const buf = await researchXlsx(r.table, { filterDesc: r.filterDesc, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) })
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = { title: '导出教研对照表', defaultPath: '教研对照表.xlsx', filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }] }
    const d = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (d.canceled || !d.filePath) return { saved: false }
    try { fs.writeFileSync(d.filePath, buf) } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? '文件正被其他程序占用（比如 Excel 里还开着它）或没有写入权限，请关闭后重试' : `保存失败：${(e as Error).message}`)
    }
    return { saved: true, path: d.filePath, rows: r.table.lessons.reduce((n, l) => n + Math.max(1, l.kps.length), 0), aiNote: r.aiNote }
  })
  ipcMain.handle('course:coursewareList', async (_e, outlineId: unknown) => listCourseware(getDataDir(), IdSchema.parse(outlineId)))
  /** 给某一节挂课件：弹系统对话框（可多选），文字只在本机读出来 */
  ipcMain.handle('course:coursewareAdd', async (_e, raw: unknown) => {
    const p = z.object({ outlineId: IdSchema, levelName: z.string().min(1).max(80), seq: z.number().int().min(0).max(99999) }).parse(raw)
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择这一节的课件', filters: [{ name: '课件（PDF、Word、PPT、文本、图片）', extensions: ['pdf', 'docx', 'pptx', 'ppt', 'doc', 'txt', 'md', 'png', 'jpg', 'jpeg', 'heic'] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile', 'multiSelections'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return null
    const added: Array<{ id: string; name: string; chars: number }> = []
    const errors: string[] = []
    for (const f of r.filePaths.slice(0, 10)) {
      const name = f.replace(/^.*[\\/]/, '')
      try {
        if (fs.statSync(f).size > 200 * 1024 * 1024) throw new CourseFileError('文件太大了（超过 200MB）')
        const text = await readCoursewareFile(f)
        if (!text.trim()) throw new CourseFileError('没有读到文字（可能整份是图片，需要本机有文字识别）')
        const it = addCourseware(getDataDir(), p.outlineId, lessonKey(p.levelName, p.seq), name, text)
        added.push({ id: it.id, name: it.name, chars: it.chars })
      } catch (e) { errors.push(`${name}：${e instanceof Error ? e.message : String(e)}`) }
    }
    log.info('course', '挂课件', { added: added.length, errors: errors.length })
    return { added, errors }
  })
  ipcMain.handle('course:coursewareRemove', async (_e, outlineId: unknown, id: unknown) => removeCourseware(getDataDir(), IdSchema.parse(outlineId), z.string().min(1).max(40).parse(id)))

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

