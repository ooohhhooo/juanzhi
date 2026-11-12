/**
 * 书库服务（主进程）：整本教材 PDF → 逐页文字 + 单元 + 附录词表 → 存进本机数据库，之后可搜索。
 * - 同一个文件按内容哈希只处理一次（已有就跳过，只更新“关联的课程体系”）；
 * - 后台排队，一次只处理一本，可取消；失败只记日志和状态，不影响教材上传本身；
 * - 不用 AI 理解书的内容；AI 只在边界页认不出单元时，在已认出的单元里选一个（没配置 AI 就不问）。
 */
import { getDb } from '../db'
import { log } from '../log'
import { notifyDataChanged } from '../events'
import { loadConfig } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { parseModelOf } from '../ai/types'
import { jsonCall } from '../course/service'
import { buildBook } from './build'
import type { BookSummary } from './build'
import { getBook, hasBook, saveBook } from './store'
import { makeOcr, ocrAvailable, readTextLayer } from './reader'
import type { UnitClassifier } from './structure'
import { syncOutlineFromBook, syncPendingBooks } from './outline'
import { CATALOG } from '../course/catalog'

export interface BuildRequest { file: string; hash: string; name: string; subject?: string | null; edition?: string | null; outlineId?: string | null; totalPages?: number }
export type BuildState = { hash: string; name: string; /** 关联的课程体系（教材详情里按它找建库进度） */ outlineId?: string | null; state: 'queued' | 'running' | 'done' | 'skipped' | 'error'; done: number; total: number; what: string; summary?: BookSummary; error?: string }

/** 书库最多处理多少页的书（和教材上传的 300 页上限一致，留一点余量） */
export const BOOK_MAX_PAGES = 400

const states = new Map<string, BuildState>()
const queue: BuildRequest[] = []
let running: { hash: string; ctl: AbortController } | null = null

export const buildStates = (): BuildState[] => [...states.values()]

/** 书库建好（或本来就有）后：用它的单元替换这份上传教材的课次，知识点由程序重算（见 outline.ts）；失败只记日志 */
function syncOutline(outlineId: string | null | undefined, hash: string): void {
  if (!outlineId) return
  try {
    const r = syncOutlineFromBook(getDb(), outlineId, hash, CATALOG)
    if (r) { log.info('bookindex', '教材课次改用书库单元', { lessons: r.lessons, byWords: r.byWords, byCatalog: r.byCatalog, linkedUnits: r.linkedUnits }); notifyDataChanged('course') }
  } catch (e) { log.warn('bookindex', '教材课次改用书库单元失败', { msg: (e as Error).message.slice(0, 80) }) }
}

/** 启动时补一次：升级前上传、已经有书库的教材，课次换成书库单元 */
export function syncPendingOutlines(): void {
  try {
    const n = syncPendingBooks(getDb(), CATALOG)
    if (n) { log.info('bookindex', '启动时把教材课次改用书库单元', { outlines: n }); notifyDataChanged('course') }
  } catch (e) { log.warn('bookindex', '启动时同步教材课次失败', { msg: (e as Error).message.slice(0, 80) }) }
}

const aiReady = (): boolean => { const c = loadConfig(); return !!(c.base_url && parseModelOf(c) && getApiKey()) }

/** 边界页的单元归属：问 AI，但只允许从“已认出的单元”里选（structure.resolveUncertain 还会再核对一遍） */
function aiClassifier(signal: AbortSignal): UnitClassifier | undefined {
  if (!aiReady()) return undefined
  const model = parseModelOf(loadConfig())
  if (!model) return undefined
  return async (pages, units) => {
    const system = '你在帮老师把教材的页对到单元。只能从给定的单元列表里选一个 key，认不出就填 null。不要编造新的单元。只输出 JSON：{"页码":"单元key或null", ...}'
    const user = `单元列表：\n${units.map(u => `${u.key}\t${u.title}`).join('\n')}\n\n每页开头的文字：\n${pages.map(p => `第${p.page}页：${p.head}`).join('\n')}`
    const r = await jsonCall({ kind: 'book-unit', model, system, user, signal })
    const obj = JSON.parse(r.content) as Record<string, unknown>
    const out: Record<string, string | null> = {}
    for (const p of pages) { const v = obj[String(p.page)]; out[String(p.page)] = typeof v === 'string' ? v : null }
    return out
  }
}

/** 排队建书库。已经建过的（同一个内容哈希）不重复处理；返回当前状态 */
export function scheduleBookBuild(req: BuildRequest): BuildState {
  const db = getDb()
  if (hasBook(db, req.hash)) {
    if (req.outlineId) db.prepare('UPDATE book_files SET outline_id = ? WHERE id = ?').run(req.outlineId, req.hash)
    const b = getBook(db, req.hash)
    const st: BuildState = { hash: req.hash, name: req.name, outlineId: req.outlineId ?? b?.outlineId ?? null, state: 'skipped', done: b?.totalPages ?? 0, total: b?.totalPages ?? 0, what: '已在书库里', summary: b?.summary }
    states.set(req.hash, st)
    syncOutline(req.outlineId, req.hash)
    return st
  }
  const cur = states.get(req.hash)
  if (cur && (cur.state === 'queued' || cur.state === 'running')) return cur
  if (req.totalPages && req.totalPages > BOOK_MAX_PAGES) {
    const st: BuildState = { hash: req.hash, name: req.name, outlineId: req.outlineId ?? null, state: 'error', done: 0, total: req.totalPages, what: '', error: `这本书有 ${req.totalPages} 页，超过书库的 ${BOOK_MAX_PAGES} 页上限，没有建书库` }
    states.set(req.hash, st)
    return st
  }
  const st: BuildState = { hash: req.hash, name: req.name, outlineId: req.outlineId ?? null, state: 'queued', done: 0, total: req.totalPages ?? 0, what: '排队中' }
  states.set(req.hash, st)
  queue.push(req)
  void pump()
  return st
}

export function cancelBookBuild(hash: string): void {
  const i = queue.findIndex(r => r.hash === hash)
  if (i >= 0) { queue.splice(i, 1); states.delete(hash) }
  if (running?.hash === hash) running.ctl.abort()
}

async function pump(): Promise<void> {
  if (running) return
  const req = queue.shift()
  if (!req) return
  const ctl = new AbortController()
  running = { hash: req.hash, ctl }
  const st = states.get(req.hash)!
  st.state = 'running'; st.what = '读取文字'
  const t0 = Date.now()
  const ocr = ocrAvailable() ? makeOcr(req.file, ctl.signal) : null
  try {
    const book = await buildBook({
      hash: req.hash, name: req.name, signal: ctl.signal,
      textLayer: async () => {
        const out = await readTextLayer(req.file, ctl.signal, (d, t) => { st.done = d; st.total = t; st.what = '页（读取文字）' })
        if (out.length > BOOK_MAX_PAGES) throw new Error(`这本书有 ${out.length} 页，超过书库的 ${BOOK_MAX_PAGES} 页上限`)
        return out
      },
      ocr: ocr ? ocr.run : undefined,
      classify: aiClassifier(ctl.signal),
      onProgress: (d, t, what) => { st.done = d; st.total = t; st.what = what }
    })
    saveBook(getDb(), book, { subject: req.subject ?? null, edition: req.edition ?? null, outlineId: req.outlineId ?? null })
    syncOutline(req.outlineId, req.hash)
    st.state = 'done'; st.summary = book.summary; st.what = '完成'
    log.info('bookindex', '书库建好', { ms: Date.now() - t0, pages: book.summary.pages, units: book.summary.units, words: book.summary.words, sentences: book.summary.sentences, ocr: book.summary.ocrPages })
    notifyDataChanged('books')
  } catch (e) {
    st.state = 'error'; st.error = ctl.signal.aborted ? '已取消' : (e as Error).message
    log.warn('bookindex', '建书库失败', { ms: Date.now() - t0, aborted: ctl.signal.aborted })
  } finally {
    ocr?.done()
    running = null
    void pump()
  }
}
