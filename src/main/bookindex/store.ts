/**
 * 书库：存取（node:sqlite）。
 * 表由 v16 迁移建（db.ts 里的 v15→v16，建表语句是冻结的）；全文索引用 FTS5，建在代码里（ensureFts），因为虚拟表不进迁移：
 * 它能从 book_pages 随时重建，数据包导出时也直接丢掉，不依赖对方机器的 SQLite 编译选项。
 * FTS5 不可用时退化成“在内存里对页文字切词后扫描”（几千页以内毫无压力）。
 */
import type { BookData } from './build.ts'
import { indexTokens } from './tokens.ts'

type Db = any


export interface BookMeta { subject?: string | null; edition?: string | null; outlineId?: string | null }

const ftsState = new WeakMap<object, boolean>()

/** 保证全文索引表存在（FTS5 可用时）。返回是否可用。缺表但已有书页时按现有页重建 */
export function ensureFts(db: Db): boolean {
  const known = ftsState.get(db)
  if (known !== undefined) return known
  let ok = false
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'book_fts'").get()
    if (!has) {
      db.exec("CREATE VIRTUAL TABLE book_fts USING fts5(tokens, book_id UNINDEXED, page UNINDEXED, tokenize = 'unicode61')")
      const rows = db.prepare('SELECT book_id, page, text FROM book_pages').all() as Array<{ book_id: string; page: number; text: string }>
      const ins = db.prepare('INSERT INTO book_fts (tokens, book_id, page) VALUES (?, ?, ?)')
      for (const r of rows) ins.run(indexTokens(r.text).join(' '), r.book_id, r.page)
    }
    ok = true
  } catch { ok = false }
  ftsState.set(db, ok)
  return ok
}

/** 测试用：假装 FTS5 不可用，走退化路径 */
export function forceNoFts(db: Db): void { ftsState.set(db, false) }

export function hasBook(db: Db, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM book_files WHERE id = ?').get(id)
}

/** 保存（同一个 id 先删后写，所以重复处理同一个文件也只有一份） */
export function saveBook(db: Db, b: BookData, meta: BookMeta = {}): void {
  const fts = ensureFts(db)
  db.exec('BEGIN')
  try {
    removeBookRows(db, b.hash, fts)
    db.prepare('INSERT INTO book_files (id, name, subject, edition, total_pages, unit_via, summary_json, outline_id, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.hash, b.name, meta.subject ?? null, meta.edition ?? null, b.pages.length, b.structure.via, JSON.stringify(b.summary), meta.outlineId ?? null, new Date().toISOString())
    const iu = db.prepare('INSERT INTO book_units (book_id, seq, key, title, page_start, page_end, printed_start, sections_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const u of b.structure.units) iu.run(b.hash, u.seq, u.key, u.title, u.pageStart, u.pageEnd, u.printedStart, JSON.stringify(u.sections))
    const ip = db.prepare('INSERT INTO book_pages (book_id, page, printed, unit_seq, kind, via, text, pinyin_removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const ifts = fts ? db.prepare('INSERT INTO book_fts (tokens, book_id, page) VALUES (?, ?, ?)') : null
    for (const p of b.pages) {
      ip.run(b.hash, p.page, p.printed, p.unitSeq, p.kind, p.via, p.text, p.pinyinRemoved)
      if (ifts && p.text) ifts.run(indexTokens(p.text).join(' '), b.hash, p.page)
    }
    const ii = db.prepare('INSERT INTO book_items (book_id, seq, kind, text, gloss, unit_key, printed_ref, pdf_ref, app_page, lesson_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    b.appendix.forEach((a, i) => ii.run(b.hash, i + 1, a.kind, a.text, a.gloss, a.unitKey, a.printedRef, a.pdfRef, a.appPage, a.lessonNo))
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  cacheDrop(b.hash)
}

function removeBookRows(db: Db, id: string, fts: boolean): void {
  if (fts) db.prepare('DELETE FROM book_fts WHERE book_id = ?').run(id)
  db.prepare('DELETE FROM book_files WHERE id = ?').run(id)   // 外键级联带走单元、页、词表
}

export function removeBook(db: Db, id: string): void {
  const fts = ensureFts(db)
  db.exec('BEGIN')
  try { removeBookRows(db, id, fts); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
  cacheDrop(id)
}

export interface BookRow { id: string; name: string; subject: string | null; edition: string | null; totalPages: number; unitVia: string | null; outlineId: string | null; builtAt: string; summary: any }

export function listBooks(db: Db): BookRow[] {
  return (db.prepare('SELECT * FROM book_files ORDER BY built_at DESC').all() as any[]).map(r => ({
    id: r.id, name: r.name, subject: r.subject, edition: r.edition, totalPages: r.total_pages, unitVia: r.unit_via, outlineId: r.outline_id, builtAt: r.built_at, summary: safeJson(r.summary_json)
  }))
}
export function getBook(db: Db, id: string): BookRow | null { return listBooks(db).find(b => b.id === id) ?? null }

const safeJson = (s: string) => { try { return JSON.parse(s) } catch { return null } }

export interface UnitRow { seq: number; key: string; title: string; pageStart: number; pageEnd: number; printedStart: number | null; sections: Array<{ title: string; printed: number; page: number; lessonNo: number | null }> }
export function bookUnits(db: Db, id: string): UnitRow[] {
  return (db.prepare('SELECT * FROM book_units WHERE book_id = ? ORDER BY seq').all(id) as any[]).map(r => ({
    seq: r.seq, key: r.key, title: r.title, pageStart: r.page_start, pageEnd: r.page_end, printedStart: r.printed_start, sections: safeJson(r.sections_json) ?? []
  }))
}

export interface PageRow { page: number; printed: number | null; unitSeq: number | null; kind: string; via: string; text: string }
export function bookPage(db: Db, id: string, page: number): PageRow | null {
  const r = db.prepare('SELECT * FROM book_pages WHERE book_id = ? AND page = ?').get(id, page)
  return r ? { page: r.page, printed: r.printed, unitSeq: r.unit_seq, kind: r.kind, via: r.via, text: r.text } : null
}

export interface ItemRow { seq: number; kind: string; text: string; gloss: string; unitKey: string | null; printedRef: number | null; pdfRef: number | null; appPage: number; lessonNo: number | null }
export function bookItems(db: Db, id: string, kind?: string): ItemRow[] {
  const rows = kind ? db.prepare('SELECT * FROM book_items WHERE book_id = ? AND kind = ? ORDER BY seq').all(id, kind) : db.prepare('SELECT * FROM book_items WHERE book_id = ? ORDER BY seq').all(id)
  return (rows as any[]).map(r => ({ seq: r.seq, kind: r.kind, text: r.text, gloss: r.gloss, unitKey: r.unit_key, printedRef: r.printed_ref, pdfRef: r.pdf_ref, appPage: r.app_page, lessonNo: r.lesson_no }))
}

/** 某单元的词语 / 句子清单（教研对照表以后按单元取词用） */
export function unitWordList(db: Db, id: string, unitKey: string): ItemRow[] {
  return bookItems(db, id).filter(i => i.unitKey === unitKey)
}

// ───────────────────────── 缓存（搜索时按书读页文字） ─────────────────────────

interface Cached { pages: Array<PageRow & { norm?: string }>; items: ItemRow[]; units: UnitRow[]; name: string; subject: string | null }
const cache = new Map<string, Cached>()
export const cacheDrop = (id: string): void => { cache.delete(id) }
export function cacheClear(): void { cache.clear() }
export function loadBook(db: Db, id: string): Cached | null {
  const hit = cache.get(id)
  if (hit) return hit
  const f = db.prepare('SELECT name, subject FROM book_files WHERE id = ?').get(id)
  if (!f) return null
  const pages = (db.prepare('SELECT * FROM book_pages WHERE book_id = ? ORDER BY page').all(id) as any[]).map(r => ({ page: r.page, printed: r.printed, unitSeq: r.unit_seq, kind: r.kind, via: r.via, text: r.text }))
  const c: Cached = { pages, items: bookItems(db, id), units: bookUnits(db, id), name: f.name, subject: f.subject }
  if (cache.size > 12) cache.clear()
  cache.set(id, c)
  return c
}

// ───────────────────────── 候选页 ─────────────────────────

const q = (t: string) => '"' + t.replace(/"/g, '""') + '"'

/** 用词在全文索引里找候选页（任一词命中即可，按相关度取前 limit 页）；FTS5 不可用时扫描 */
export function candidatePages(db: Db, bookIds: string[], tokens: string[], limit = 400): Array<{ bookId: string; page: number }> {
  if (!tokens.length || !bookIds.length) return []
  if (ensureFts(db)) {
    const ph = bookIds.map(() => '?').join(',')
    const match = tokens.slice(0, 40).map(q).join(' OR ')
    try {
      return (db.prepare(`SELECT book_id, page FROM book_fts WHERE book_fts MATCH ? AND book_id IN (${ph}) ORDER BY bm25(book_fts) LIMIT ?`).all(match, ...bookIds, limit) as any[]).map(r => ({ bookId: r.book_id, page: Number(r.page) }))
    } catch { /* 查询语法问题：退化 */ }
  }
  const want = new Set(tokens)
  const out: Array<{ bookId: string; page: number }> = []
  for (const id of bookIds) {
    const b = loadBook(db, id)
    if (!b) continue
    for (const p of b.pages) if (p.text && indexTokens(p.text).some(t => want.has(t))) out.push({ bookId: id, page: p.page })
  }
  return out.slice(0, limit)
}
