/**
 * 书库 → 教材的课次（纯逻辑，数据库由调用方传入，单测在内存库上直接跑）。
 *
 * 上传整本教材后，程序在后台把书切成单元、读出书后词表（书库）。书库建好、而且单元是按目录或正文标题认出来的，
 * 就用它替换这份教材原来的课次（原来那份是 AI 逐单元整理的）：
 *  · 每个单元一课：单元标题、印刷页码范围（附 PDF 页码）、单元词表里的单词 / 句子 / 识字写字（作为要点）；
 *  · 知识点只由程序算，不问 AI：
 *     ① 单元自己的文字（标题 + 词表 + 句子）套标志词规则，过线（MATCH_THRESHOLD）的才挂——要好几个同类词一起出现，单个常用词不算；
 *     ② 认得出出版社、年级、学期，且软件内置了这一册的目录：单元标题和目录对得上的，挂目录里写的知识点（标「教材目录」）。
 *        标题对不上（比如上传的是旧版书、内置的是新版目录）就一个都不挂，不按单元序号硬配。
 *  · 老师确认 / 手工指定 / 否决过的对应按单元（Unit 5 / 第五单元，或去掉单元号后标题相同）搬到新课次上；对不上单元的丢掉（报告里给数）。
 *    AI 以前挑的（没锁定的）作废。
 *  · 这份教材之后不再需要 AI 匹配（匹配状态记为完成），界面也不再显示花 token 的匹配按钮。
 * 书库没认出单元（按每 10 页切块）、或单元少于 2 个时不动，原来 AI 整理的课次照用。
 */
import { bookItems, bookUnits, getBook } from './store.ts'
import type { BookRow, UnitRow } from './store.ts'
import { fromBookOf, replaceOutline } from '../course/store.ts'
import { hitsToQuote, matchLessonRules } from '../course/rules.ts'
import { MATCH_THRESHOLD } from '../course/score.ts'
import { detectEdition } from '../course/textbook-edition.ts'
import { makeCatalogProvider } from '../course/textbook-builtin.ts'
import type { CatalogEdition } from '../course/textbook-builtin.ts'
import type { ParsedLesson } from '../course/map.ts'
import { asSubject } from '../../shared/subject.ts'

type Db = any

/** 书库的单元能不能当课次用：按目录 / 正文标题认出来的，至少 2 个 */
export const unitsUsable = (book: Pick<BookRow, 'unitVia'>, units: UnitRow[]): boolean => (book.unitVia === 'toc' || book.unitVia === 'heading') && units.length >= 2

const HEAD_RE = /^(?:(?:unit|module|lesson|chapter|part)\s*\d{1,3}|第\s*[0-9０-９零〇一二两三四五六七八九十百]+\s*(?:单元|课|章|模块|专题))/i
/** 单元标题的开头（Unit 1 / 第一单元），课次编号用；没有就用整个标题（Recycle 1） */
export const unitHead = (title: string): string => (HEAD_RE.exec(title.trim())?.[0] ?? title.trim()).replace(/\s+/g, ' ').slice(0, 60)

const pageText = (a: number | null, b: number | null): string => (a == null ? '' : b == null || b === a ? `第 ${a} 页` : `第 ${a}–${b} 页`)
const clip = (s: string, n = 1900) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 一本书 → 课次（一个单元一课）。书不可用返回 null */
export function lessonsFromBook(db: Db, bookId: string): ParsedLesson[] | null {
  const book = getBook(db, bookId)
  if (!book) return null
  const units = bookUnits(db, bookId)
  if (!unitsUsable(book, units)) return null
  const items = bookItems(db, bookId)
  const printedAt = db.prepare('SELECT printed FROM book_pages WHERE book_id = ? AND page = ?')
  return units.map((u, i): ParsedLesson => {
    const mine = items.filter(x => x.unitKey === u.key)
    const of = (k: string) => [...new Set(mine.filter(x => x.kind === k).map(x => x.text.trim()).filter(Boolean))]
    const pEnd = (printedAt.get(bookId, u.pageEnd) as any)?.printed ?? null
    const printed = pageText(u.printedStart, u.printedStart != null && pEnd != null && pEnd >= u.printedStart ? pEnd : null)
    const pdf = pageText(u.pageStart, u.pageEnd)
    const points: ParsedLesson['points'] = [{ kind: 'other', label: '页码', text: printed ? `${printed}（PDF ${pdf}）` : `PDF ${pdf}` }]
    const words = of('word'), phrases = of('phrase'), sents = of('sentence'), reads = of('char-read'), writes = of('char-write')
    if (words.length) points.push({ kind: 'word', label: '单词', text: clip(words.join(', ')) })
    if (phrases.length) points.push({ kind: 'word', label: '词语', text: clip(phrases.join('、')) })
    if (sents.length) points.push({ kind: 'pattern', label: '句子', text: clip(sents.join('; ')) })
    if (reads.length) points.push({ kind: 'other', label: '识字', text: clip(reads.join(' ')) })
    if (writes.length) points.push({ kind: 'other', label: '写字', text: clip(writes.join(' ')) })
    return { seq: i + 1, noLabel: unitHead(u.title), title: u.title.slice(0, 300), theme: '', textbookRef: '', points, raw: { 单元: u.title.slice(0, 300), 页码: printed || pdf, 来源: '课本原文库' } }
  })
}

// ───────────────────────── 内置目录对单元 ─────────────────────────

const numOf = (t: string): number | null => { const m = /^(?:unit|module|lesson|chapter|part)\s*(\d{1,3})/i.exec(t.trim()); return m ? Number(m[1]) : null }
/** 标题去掉「Unit 1 / 第一单元」开头、标点和空白，英文小写 */
export const titleCore = (t: string): string => t.normalize('NFKC').trim().replace(HEAD_RE, '').toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, '')

/**
 * 书里的单元标题 ↔ 目录里的单元标题：去掉单元号后相同，或一个包含另一个（至少 4 个字符）；两边都有单元号时号也要相同。
 * 能对上的不到一半（至少 2 个）就当不是同一版书，全部不对（旧版书 + 新版目录这种情况）。
 */
export function alignCatalogUnits(bookTitles: string[], catTitles: string[]): Array<number | null> {
  const used = new Set<number>()
  const out = bookTitles.map(bt => {
    const a = titleCore(bt), na = numOf(bt)
    if (!a) return null
    const j = catTitles.findIndex((ct, k) => {
      if (used.has(k)) return false
      const b = titleCore(ct), nb = numOf(ct)
      if (!b || (na != null && nb != null && na !== nb)) return false
      return a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)))
    })
    if (j < 0) return null
    used.add(j)
    return j
  })
  const linked = out.filter(x => x != null).length
  return linked >= Math.max(2, Math.ceil(bookTitles.length / 2)) ? out : bookTitles.map(() => null)
}

/** 认出这本书是哪一版哪一册：书库记下的版本名 → 书名 → 前几页文字 */
function editionOfBook(db: Db, book: BookRow) {
  const front = (db.prepare('SELECT text FROM book_pages WHERE book_id = ? AND page <= 4 ORDER BY page').all(book.id) as any[]).map(r => String(r.text ?? '')).join('\n')
  for (const s of [book.edition ?? '', book.name, front]) { const e = s ? detectEdition(s) : null; if (e?.semester) return e }
  return null
}

export interface CatalogLink { label: string; units: Array<{ title: string; kps: string[] } | null> }
/** 书库里每个单元对到的内置目录单元（对不上的为 null）；没有这一册的目录返回 null */
export function catalogLinkOf(db: Db, book: BookRow, units: UnitRow[], subject: string, editions: CatalogEdition[]): CatalogLink | null {
  const info = editionOfBook(db, book)
  if (!info || !info.semester) return null
  const prov = makeCatalogProvider(editions)
  const hit = prov.find({ subject, edition: info.edition, grade: info.grade, semester: info.semester })
  if (!hit) return null
  const cat = prov.units(hit.id)
  const idx = alignCatalogUnits(units.map(u => u.title), cat.map(c => c.title))
  if (!idx.some(x => x != null)) return null
  return { label: hit.label, units: idx.map(j => (j == null ? null : { title: cat[j].title, kps: cat[j].kps })) }
}

// ───────────────────────── 同步 ─────────────────────────

const headKey = (t: string): string => (HEAD_RE.exec(t.normalize('NFKC').trim())?.[0] ?? '').toLowerCase().replace(/\s+/g, '')
/** 两个课次标题说的是不是同一个单元：都有单元号时比单元号，否则比去掉单元号后的标题 */
export function sameUnit(a: string, b: string): boolean {
  const ha = headKey(a), hb = headKey(b)
  if (ha && hb) return ha === hb
  const ca = titleCore(a), cb = titleCore(b)
  return !!ca && ca === cb
}

/** 单元文字（标题 + 词表 + 句子）套标志词规则：过线的才算 */
export function unitRuleKps(lesson: Pick<ParsedLesson, 'title' | 'points'>, codes: Iterable<string>): Array<{ code: string; quote: string; score: number }> {
  const text = [lesson.title, ...lesson.points.filter(p => p.label !== '页码').map(p => p.text.replace(/[;；]\s*/g, '\n'))].join('\n')
  return matchLessonRules(text, codes).filter(m => m.score >= MATCH_THRESHOLD).map(m => ({ code: m.code, quote: hitsToQuote(m.hits), score: m.score }))
}

export interface SyncResult { lessons: number; maps: number; byWords: number; byCatalog: number; catalog: string | null; linkedUnits: number; /** 老师确认 / 否决过、搬到新课次上的 / 对不上单元丢掉的 */ teacherKept: number; teacherLost: number }

/**
 * 用书库替换教材的课次并重算知识点。不是上传的教材（内置 / 机构课程）、书库不可用 → 返回 null，什么都不动。
 * 同一本书再同步一次结果一样（课次内容不变时不升版本号）。
 */
export function syncOutlineFromBook(db: Db, outlineId: string, bookId: string, editions: CatalogEdition[]): SyncResult | null {
  const o = db.prepare('SELECT id, kind, builtin_id, subject, source_name, source_hash, warnings_json FROM course_outlines WHERE id = ?').get(outlineId) as any
  if (!o || o.kind !== 'textbook' || o.builtin_id) return null
  const book = getBook(db, bookId)
  if (!book) return null
  const units = bookUnits(db, bookId)
  const lessons = lessonsFromBook(db, bookId)
  if (!lessons) return null
  const subject = asSubject(o.subject)
  const levels = db.prepare('SELECT name FROM course_levels WHERE outline_id = ? ORDER BY sort, id').all(outlineId) as any[]
  const levelName = (levels.length === 1 ? String(levels[0].name) : book.name).slice(0, 60) || '教材'
  const codes = (db.prepare('SELECT code FROM kps WHERE subject = ? AND deprecated = 0').all(subject) as any[]).map(r => r.code as string)
  const link = catalogLinkOf(db, book, units, subject, editions)
  const known = new Set(codes)
  const own = !db.isTransaction
  if (own) db.exec('BEGIN')
  try {
    // 老师确认 / 手工指定 / 否决过的：记下所在单元的标题，换完课次再按单元搬回去
    const teacher = db.prepare(`SELECT m.kp_code, m.confidence, m.reason, m.quote, m.source, m.state, m.locked, l.title FROM course_kp_map m JOIN course_lessons l ON l.id = m.lesson_id
      WHERE m.outline_id = ? AND (m.locked = 1 OR m.state IN ('confirmed', 'rejected') OR m.source = 'manual')`).all(outlineId) as any[]
    replaceOutline(db, outlineId, { sourceName: o.source_name ?? book.name, sourceHash: o.source_hash ?? '', mapping: { fromBook: bookId }, warnings: [], aiModel: '', levels: [{ name: levelName, lessons }], confirmLockedLoss: true })
    // 程序重算：旧对应全部清掉（AI 挑的、上次同步写的作废），老师的按单元搬回
    db.prepare('DELETE FROM course_kp_map WHERE outline_id = ?').run(outlineId)
    const rows = db.prepare('SELECT l.id, l.seq, l.title FROM course_lessons l WHERE l.outline_id = ?').all(outlineId) as any[]
    const idOf = new Map(rows.map(r => [r.seq as number, r.id as number]))
    const back = db.prepare('INSERT OR IGNORE INTO course_kp_map (outline_id, kp_code, lesson_id, confidence, reason, quote, source, state, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    let teacherKept = 0, teacherLost = 0
    for (const m of teacher) {
      const to = rows.find(r => sameUnit(String(m.title ?? ''), String(r.title ?? '')))
      if (to && Number(back.run(outlineId, m.kp_code, to.id, m.confidence, m.reason, m.quote, m.source, m.state, m.locked).changes) > 0) teacherKept++
      else teacherLost++
    }
    const ins = db.prepare('INSERT OR IGNORE INTO course_kp_map (outline_id, kp_code, lesson_id, confidence, reason, quote, source, state, locked) VALUES (?, ?, ?, ?, ?, ?, ?, \'suggested\', 0)')
    const mapped = new Set<string>()
    let byWords = 0, byCatalog = 0
    lessons.forEach((l, i) => {
      const lid = idOf.get(l.seq)
      if (!lid) return
      for (const r of unitRuleKps(l, codes)) {
        if (Number(ins.run(outlineId, r.code, lid, r.score >= 80 ? 'high' : 'medium', `课本单元词表命中：${r.quote}`.slice(0, 80), r.quote, 'rule').changes) > 0) { byWords++; mapped.add(r.code) }
      }
      const cu = link?.units[i]
      if (cu) for (const c of new Set(cu.kps)) {
        if (!known.has(c)) continue
        if (Number(ins.run(outlineId, c, lid, 'high', `教材目录：${link!.label} ${cu.title}`.slice(0, 80), '', 'builtin').changes) > 0) { byCatalog++; mapped.add(c) }
      }
    })
    for (const r of db.prepare("SELECT DISTINCT kp_code FROM course_kp_map WHERE outline_id = ? AND state <> 'rejected'").all(outlineId) as any[]) mapped.add(r.kp_code)
    // 所有知识点都记为「已检查」（和内置教材一样）：这份教材不再需要 AI 匹配
    const rev = (db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(outlineId) as any).rev
    db.prepare('DELETE FROM course_kp_check WHERE outline_id = ?').run(outlineId)
    const chk = db.prepare("INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) VALUES (?, ?, ?, ?, '', 'book', '')")
    for (const c of codes) chk.run(outlineId, c, mapped.has(c) ? 'matched' : 'none', rev)
    if (own) db.exec('COMMIT')
    return { lessons: lessons.length, maps: byWords + byCatalog, byWords, byCatalog, catalog: link?.label ?? null, linkedUnits: link ? link.units.filter(Boolean).length : 0, teacherKept, teacherLost }
  } catch (e) { if (own) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } } throw e }
}

/** 已有书库、但课次还不是从书库来的上传教材（升级前上传的）：每份教材取最新的一本书同步一次。返回同步了几份 */
export function syncPendingBooks(db: Db, editions: CatalogEdition[]): number {
  const rows = db.prepare(`SELECT o.id, o.mapping_json, (SELECT b.id FROM book_files b WHERE b.outline_id = o.id ORDER BY b.built_at DESC LIMIT 1) book_id
    FROM course_outlines o WHERE o.kind = 'textbook' AND o.builtin_id IS NULL`).all() as any[]
  let n = 0
  for (const r of rows) {
    if (!r.book_id || fromBookOf(r.mapping_json) === r.book_id) continue
    if (syncOutlineFromBook(db, r.id, r.book_id, editions)) n++
  }
  return n
}
