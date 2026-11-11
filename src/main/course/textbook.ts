/**
 * 内置学校教材：目录的类型与校验、把目录里的几册变成一份「学校教材」课程大纲（kind = 'textbook'）。
 * 每个单元是一课；单元考到的知识点（目录里的 kps）直接写进 course_kp_map（source = 'builtin'，不经过 AI），
 * 并把这个学科的所有知识点都记为「已检查」，所以匹配状态永远是「已完成」，不会提示要去匹配。
 * 数据库由调用方传入（不依赖 electron），单测在内存库上直接加载。
 */
import { SUBJECTS, asSubject, isSubjectId } from '../../shared/subject.ts'
import type { SubjectId } from '../../shared/subject.ts'
import type { ParsedLevel, ParsedLesson } from './map.ts'
import { createOutline, replaceOutline } from './store.ts'

type Db = any

export type Semester = '上' | '下' | '全'
/** no 为 null：没有序号的（准备课、综合实践、数学好玩、复习等），用 label 或标题显示；单元顺序以数组顺序为准 */
export interface CatalogUnit { no: number | null; label?: string; title: string; lessons?: string[]; kps: string[]; note?: string }
export interface CatalogBook { grade: number; semester: Semester; editionYear?: string; /** 如「旧版（2012 版）……新版目录还没公开」 */ note?: string; units: CatalogUnit[] }
export interface CatalogEdition {
  id: string
  subject: SubjectId
  /** 版本名（界面显示） */
  edition: string
  /** 和 SUBJECTS[subject].textbooks 里的写法一致（试卷库的「教材版本」） */
  textbookValue: string
  checkedAt: string
  sources: Array<{ title: string; url: string }>
  books: CatalogBook[]
}

export const GRADE_ZH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
export const bookKey = (b: Pick<CatalogBook, 'grade' | 'semester'>): string => `${b.grade}${b.semester}`
export const bookLabel = (b: Pick<CatalogBook, 'grade' | 'semester'>): string => `${GRADE_ZH[b.grade] ?? b.grade}年级${b.semester === '全' ? '全一' : b.semester}册`

/** 校验一份目录文件，返回问题列表（空 = 没问题）。knownKps：所有知识点代码（全学科） */
export function validateEdition(raw: unknown, knownKps: Set<string>): string[] {
  const errs: string[] = []
  const e = raw as Partial<CatalogEdition> | null
  if (!e || typeof e !== 'object') return ['不是对象']
  const at = (m: string) => errs.push(`${e.id ?? '?'}：${m}`)
  if (typeof e.id !== 'string' || !/^[a-z]+-[a-z]+$/.test(e.id)) at('id 要是「学科-版本」小写英文，如 math-renjiao')
  if (!isSubjectId(e.subject)) { at('subject 不是 chinese / math / english'); return errs }
  if (typeof e.id === 'string' && !e.id.startsWith(e.subject + '-')) at(`id 应以 ${e.subject}- 开头`)
  if (!e.edition || typeof e.edition !== 'string') at('缺 edition')
  if (!SUBJECTS[e.subject].textbooks.includes(String(e.textbookValue))) at(`textbookValue「${e.textbookValue}」不在 ${e.subject} 的教材版本列表里`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.checkedAt))) at('checkedAt 要是 YYYY-MM-DD')
  if (!Array.isArray(e.sources) || e.sources.length === 0 || e.sources.some(s => !s || !s.title || !s.url)) at('sources 至少一条，每条有 title 和 url')
  if (!Array.isArray(e.books) || e.books.length === 0) { at('books 为空'); return errs }
  const seen = new Set<string>()
  for (const b of e.books) {
    if (!b || !Number.isInteger(b.grade) || b.grade < 1 || b.grade > 9) { at(`年级不合法：${b?.grade}`); continue }
    if (!['上', '下', '全'].includes(b.semester)) { at(`学期不合法：${b.grade}年级 ${b.semester}`); continue }
    const key = bookKey(b)
    if (seen.has(key)) at(`${key} 重复`)
    seen.add(key)
    if (!Array.isArray(b.units) || b.units.length === 0) { at(`${key} 没有单元`); continue }
    const nos = new Set<number>()
    for (const u of b.units) {
      if (!u || (u.no !== null && (!Number.isInteger(u.no) || u.no < 0))) { at(`${key} 单元序号不合法`); continue }
      if (u.no !== null) { if (nos.has(u.no)) at(`${key} 单元序号 ${u.no} 重复`); nos.add(u.no) }
      if (u.label !== undefined && typeof u.label !== 'string') at(`${key} 单元 ${u.no ?? u.title} 的 label 要是字符串`)
      if (!u.title || typeof u.title !== 'string') at(`${key} 单元 ${u.no ?? u.label} 缺标题`)
      if (u.lessons !== undefined && (!Array.isArray(u.lessons) || u.lessons.some(l => typeof l !== 'string'))) at(`${key} 单元 ${u.no ?? u.title} 的 lessons 要是字符串数组`)
      if (!Array.isArray(u.kps)) { at(`${key} 单元 ${u.no ?? u.title} 缺 kps 数组`); continue }
      for (const c of u.kps) if (!knownKps.has(c)) at(`${key} 单元 ${u.no ?? u.title} 的知识点代码不存在：${c}`)
    }
  }
  return errs
}

// ───────────────────────── 目录读取（给界面选） ─────────────────────────

export interface CatalogBookInfo { key: string; label: string; /** 教材版本年份（新版 / 旧版） */ editionYear: string; /** 旧版：新版目录还没公开 */ legacy: boolean; note: string; grade: number; semester: Semester; units: number }
export interface CatalogInfo { id: string; subject: SubjectId; edition: string; textbookValue: string; checkedAt: string; sources: CatalogEdition['sources']; books: CatalogBookInfo[] }

export function catalogInfo(editions: CatalogEdition[], subject?: unknown): CatalogInfo[] {
  const sub = subject === undefined ? null : asSubject(subject)
  return editions.filter(e => !sub || e.subject === sub).map(e => ({
    id: e.id, subject: e.subject, edition: e.edition, textbookValue: e.textbookValue, checkedAt: e.checkedAt, sources: e.sources,
    books: e.books.map(b => ({ key: bookKey(b), label: bookLabel(b), editionYear: b.editionYear ?? '', legacy: /^旧版/.test(b.note ?? ''), note: b.note ?? '', grade: b.grade, semester: b.semester, units: b.units.length }))
  }))
}

// ───────────────────────── 生成课程大纲 ─────────────────────────

const unitLabel = (u: CatalogUnit) => (u.no ?  `第${u.no}单元` : (u.label || u.title))

function levelOf(ed: CatalogEdition, b: CatalogBook): ParsedLevel {
  const ref = `${ed.edition} ${bookLabel(b)}${b.editionYear ? `（${b.editionYear} 版）` : ''}`
  const lessons: ParsedLesson[] = b.units.map((u, i) => ({
    seq: i + 1, noLabel: unitLabel(u), title: u.title, theme: '', textbookRef: ref,
    points: [
      ...(u.lessons?.length ? [{ kind: 'other' as const, label: '内容', text: u.lessons.join('、') }] : []),
      ...(u.note ? [{ kind: 'other' as const, label: '说明', text: u.note }] : [])
    ],
    raw: { 单元: unitLabel(u), 标题: u.title }
  }))
  return { name: bookLabel(b), lessons }
}

/** 按年级、学期排好的所选册（keys 里没有的忽略） */
export function pickBooks(ed: CatalogEdition, keys: string[]): CatalogBook[] {
  const want = new Set(keys)
  return ed.books.filter(b => want.has(bookKey(b))).sort((a, b) => a.grade - b.grade || (a.semester === '上' ? -1 : 1) - (b.semester === '上' ? -1 : 1))
}

export function builtinName(ed: CatalogEdition, books: CatalogBook[]): string {
  const grades = [...new Set(books.map(b => b.grade))]
  const text = books.length > 4 || grades.length > 2 ? `${books.length} 册` : books.map(bookLabel).join('、')
  return `${ed.edition} ${text}`.slice(0, 60)
}

export const builtinId = (ed: CatalogEdition, books: CatalogBook[]): string => `${ed.id}:${books.map(bookKey).join(',')}`
export function parseBuiltinId(s: string): { editionId: string; keys: string[] } | null {
  const m = /^([a-z]+-[a-z]+):(.+)$/.exec(s ?? '')
  return m ? { editionId: m[1], keys: m[2].split(',').filter(Boolean) } : null
}

/** 把单元的知识点写成对应：先清掉这份大纲原有的对应和检查记录，再按目录重写 */
function writeMaps(db: Db, outlineId: string, subject: SubjectId, books: CatalogBook[]): { maps: number; kps: number } {
  const kpRows = db.prepare('SELECT code FROM kps WHERE subject = ? AND deprecated = 0').all(subject) as Array<{ code: string }>
  const known = new Set(kpRows.map(r => r.code))
  const rev = (db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(outlineId) as any).rev as number
  const lessonId = new Map<string, number>()
  for (const r of db.prepare('SELECT l.id, l.seq, lv.name lvName FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id WHERE l.outline_id = ?').all(outlineId) as any[]) lessonId.set(`${r.lvName}|${r.seq}`, r.id)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM course_kp_map WHERE outline_id = ?').run(outlineId)
    db.prepare('DELETE FROM course_kp_check WHERE outline_id = ?').run(outlineId)
    const ins = db.prepare(`INSERT OR REPLACE INTO course_kp_map (outline_id, kp_code, lesson_id, confidence, reason, quote, source, state, locked) VALUES (?, ?, ?, 'high', '内置教材目录', '', 'builtin', 'confirmed', 1)`)
    const mapped = new Set<string>()
    let maps = 0
    for (const b of books) {
      for (const [i, u] of b.units.entries()) {
        const lid = lessonId.get(`${bookLabel(b)}|${i + 1}`)
        if (!lid) continue
        for (const c of new Set(u.kps)) {
          if (!known.has(c)) continue   // 知识点库里改过 / 合并过的代码：跳过，不写悬空的对应
          ins.run(outlineId, c, lid); mapped.add(c); maps++
        }
      }
    }
    // 这个学科的所有知识点都记为「已检查」：教材目录讲到的 = matched，其余 = none（教材里没有）
    const up = db.prepare(`INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) VALUES (?, ?, ?, ?, '', 'builtin', '')`)
    for (const r of kpRows) up.run(outlineId, r.code, mapped.has(r.code) ? 'matched' : 'none', rev)
    db.exec('COMMIT')
    return { maps, kps: mapped.size }
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
}

const baseInput = (ed: CatalogEdition, levels: ParsedLevel[]) => ({
  sourceName: `内置教材目录（${ed.edition}，核对于 ${ed.checkedAt}）`, sourceHash: '', mapping: null, warnings: [], aiModel: '', levels
})

/** 添加内置教材：选了几册就是几个级别。返回大纲 id。同一版本同样的几册已经添加过 → 报错（避免重复） */
export function addBuiltinTextbook(db: Db, ed: CatalogEdition, keys: string[]): { id: string; lessons: number; maps: number } {
  const books = pickBooks(ed, keys)
  if (!books.length) throw new Error('请至少选一册')
  const bid = builtinId(ed, books)
  if (db.prepare('SELECT 1 FROM course_outlines WHERE builtin_id = ?').get(bid)) throw new Error('这几册已经添加过了，要更新请在列表里点「重新从内置更新」')
  const levels = books.map(b => levelOf(ed, b))
  const id = createOutline(db, { ...baseInput(ed, levels), name: builtinName(ed, books), scene: 'school', termNote: '', status: 'active', subject: ed.subject, kind: 'textbook', builtinId: bid })
  const r = writeMaps(db, id, ed.subject, books)
  return { id, lessons: levels.reduce((n, l) => n + l.lessons.length, 0), maps: r.maps }
}

/** 重新从内置更新：按这份大纲记下的内置来源重新读目录（目录随软件版本更新后用）。老师手工加的对应会被目录结果覆盖 */
export function refreshBuiltinTextbook(db: Db, id: string, editions: CatalogEdition[]): { lessons: number; maps: number } {
  const row = db.prepare('SELECT builtin_id FROM course_outlines WHERE id = ?').get(id) as any
  const p = parseBuiltinId(row?.builtin_id ?? '')
  if (!p) throw new Error('这份教材不是内置的，不能从内置更新')
  const ed = editions.find(e => e.id === p.editionId)
  if (!ed) throw new Error('这个版本已经不在内置目录里了')
  const books = pickBooks(ed, p.keys)
  if (!books.length) throw new Error('内置目录里已经没有这几册了')
  db.prepare('DELETE FROM course_kp_map WHERE outline_id = ?').run(id)
  const levels = books.map(b => levelOf(ed, b))
  replaceOutline(db, id, { ...baseInput(ed, levels), confirmLockedLoss: true })
  const r = writeMaps(db, id, ed.subject, books)
  return { lessons: levels.reduce((n, l) => n + l.lessons.length, 0), maps: r.maps }
}
