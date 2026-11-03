/**
 * 课程体系的读写（数据库层）。数据库由调用方传入（不依赖 electron），单测在内存库上直接加载。
 * 表结构见 db.ts 的 v11（course_outlines / course_levels / course_lessons / course_kp_check / course_kp_map）。
 */
import crypto from 'node:crypto'
import { safeKpName } from '../../shared/code-guard.ts'
import { lessonSearchText, lessonQuoteText, kpSig, planMerge } from './match.ts'
import type { KpLite, LessonLite, MatchEntry, ExistingMap } from './match.ts'
import { lessonHash, planReplace, countsOf } from './replace-diff.ts'
import type { OldLesson, ReplaceCounts } from './replace-diff.ts'
import type { MapWarning, ParsedLesson, ParsedLevel, PointKind } from './map.ts'

type Db = any

export type Scene = 'org' | 'school' | 'family' | 'other'
export const SCENES: Scene[] = ['org', 'school', 'family', 'other']
export const MAX_LEVELS = 40
export const MAX_LESSONS = 20000

export interface OutlineInput {
  name: string
  scene: Scene
  termNote: string
  sourceName: string
  sourceHash: string
  mapping: unknown
  warnings: MapWarning[]
  aiModel: string
  status: 'active' | 'draft'
  levels: ParsedLevel[]
}

/** 读库里的 JSON 文本：解析失败、或形状和 fallback 不一样（该是数组却是对象 / 字符串……）一律用 fallback——数据包里来的内容不能把界面搞崩 */
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    if (!s) return fallback
    const v = JSON.parse(s)
    if (Array.isArray(fallback)) return Array.isArray(v) ? v as T : fallback
    if (fallback !== null && typeof fallback === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as T : fallback
    return v as T
  } catch { return fallback }
}
const uuid = () => crypto.randomUUID()

function insertLessons(db: Db, outlineId: string, levelId: number, levelName: string, lessons: ParsedLesson[]): void {
  const ins = db.prepare(`INSERT INTO course_lessons (outline_id, level_id, seq, no_label, title, theme, textbook_ref, points_json, raw_json, search_text, text_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const l of lessons) {
    ins.run(outlineId, levelId, l.seq, l.noLabel, l.title, l.theme, l.textbookRef, JSON.stringify(l.points), JSON.stringify(l.raw), lessonSearchText({ levelName, noLabel: l.noLabel, title: l.title, theme: l.theme, textbookRef: l.textbookRef, points: l.points }), lessonHash(l))
  }
}

/** 新建课程体系（一个事务）。返回 id */
export function createOutline(db: Db, input: OutlineInput): string {
  const total = input.levels.reduce((n, l) => n + l.lessons.length, 0)
  if (input.levels.length > MAX_LEVELS) throw new Error(`级别太多（最多 ${MAX_LEVELS} 个）`)
  if (total > MAX_LESSONS) throw new Error(`课次太多（最多 ${MAX_LESSONS} 课）`)
  const id = uuid()
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO course_outlines (id, name, scene, term_note, source_name, source_hash, status, active, rev, mapping_json, warnings_json, ai_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`).run(id, input.name, input.scene, input.termNote, input.sourceName, input.sourceHash, input.status, JSON.stringify(input.mapping ?? null), JSON.stringify(input.warnings), input.aiModel)
    const insLv = db.prepare('INSERT INTO course_levels (outline_id, name, sort) VALUES (?, ?, ?)')
    input.levels.forEach((lv, i) => {
      const r = insLv.run(id, lv.name, i)
      insertLessons(db, id, Number(r.lastInsertRowid), lv.name, lv.lessons)
    })
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
  return id
}

/** 替换前的比对（不改库）：新增 / 修改 / 删除多少课，以及涉及改动的课上已有多少条知识点对应 */
export function diffOutline(db: Db, id: string, levels: ParsedLevel[]): ReplaceCounts & { affectedMaps: number; lockedLost: number; lockedRecheck: number } {
  const old = oldLessons(db, id)
  const plan = planReplace(old, levels)
  const touched = [...plan.changed.map(c => c.id), ...plan.removedIds]
  let affected = 0
  if (touched.length) {
    const q = db.prepare('SELECT COUNT(*) c FROM course_kp_map WHERE lesson_id = ? AND locked = 0')
    for (const t of touched) affected += (q.get(t) as any).c
  }
  return { ...countsOf(plan), affectedMaps: affected, ...lockedImpact(db, plan) }
}

/** 替换会影响多少条老师确认 / 锁定的对应：课被删（含整个级别被删）= 丢失；课的内容变了 = 需要重新核对 */
function lockedImpact(db: Db, plan: ReturnType<typeof planReplace>): { lockedLost: number; lockedRecheck: number } {
  const q = db.prepare("SELECT COUNT(*) c FROM course_kp_map WHERE lesson_id = ? AND (locked = 1 OR state = 'confirmed')")
  let lost = 0, recheck = 0
  for (const rid of plan.removedIds) lost += (q.get(rid) as any).c
  for (const c of plan.changed) recheck += (q.get(c.id) as any).c
  return { lockedLost: lost, lockedRecheck: recheck }
}

const oldLessons = (db: Db, id: string): OldLesson[] =>
  (db.prepare('SELECT l.id, lv.name levelName, l.seq, l.text_hash hash FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id WHERE l.outline_id = ? ORDER BY lv.sort, l.seq, l.id').all(id) as any[])
    .map(r => ({ id: r.id, levelName: r.levelName, seq: r.seq, hash: r.hash ?? '' }))

/**
 * 替换内容（同一个体系 id，保留匹配结果）：按（级别 + 课次）配对；内容变了的课清掉没锁定的 AI 建议，锁定的保留；
 * 被删的课连同它的对应一起删（外键级联）。有任何改动 rev + 1，匹配状态因此变成「大纲已更新，需要重新匹配」。
 */
export function replaceOutline(db: Db, id: string, input: Pick<OutlineInput, 'sourceName' | 'sourceHash' | 'mapping' | 'warnings' | 'aiModel' | 'levels'> & { confirmLockedLoss?: boolean }): ReplaceCounts & { affectedMaps: number; lockedLost: number; lockedRecheck: number } {
  const total = input.levels.reduce((n, l) => n + l.lessons.length, 0)
  if (input.levels.length > MAX_LEVELS || total > MAX_LESSONS) throw new Error('级别或课次太多')
  const old = oldLessons(db, id)
  const plan = planReplace(old, input.levels)
  const impact = lockedImpact(db, plan)
  if (impact.lockedLost > 0 && !input.confirmLockedLoss) throw new Error(`需要确认：替换会删掉 ${impact.lockedLost} 条老师确认 / 手工指定的知识点对应（它们所在的课或级别不在新表里了）。请在确认框里明确同意后再替换`)
  const cnt = db.prepare('SELECT COUNT(*) c FROM course_kp_map WHERE lesson_id = ? AND locked = 0')
  let affected = 0
  for (const t of [...plan.changed.map(c => c.id), ...plan.removedIds]) affected += (cnt.get(t) as any).c   // 先数（删级别会级联删课次和对应）
  db.exec('BEGIN')
  try {
    // 级别：同名沿用，新名新建，不在新表里的删掉
    const lvRows = db.prepare('SELECT id, name FROM course_levels WHERE outline_id = ?').all(id) as any[]
    const lvByName = new Map<string, number>(lvRows.map(r => [r.name, r.id]))
    const keepNames = new Set(input.levels.map(l => l.name))
    for (const r of lvRows) if (!keepNames.has(r.name)) db.prepare('DELETE FROM course_levels WHERE id = ?').run(r.id)
    input.levels.forEach((lv, i) => {
      const had = lvByName.get(lv.name)
      if (had) db.prepare('UPDATE course_levels SET sort = ? WHERE id = ?').run(i, had)
      else lvByName.set(lv.name, Number(db.prepare('INSERT INTO course_levels (outline_id, name, sort) VALUES (?, ?, ?)').run(id, lv.name, i).lastInsertRowid))
    })
    // 被删的级别连带删了课次；这里再删「配不上」的课次（级别还在，但这一课没了）
    const stillThere = new Set((db.prepare('SELECT id FROM course_lessons WHERE outline_id = ?').all(id) as any[]).map(r => r.id as number))
    for (const rid of plan.removedIds) if (stillThere.has(rid)) db.prepare('DELETE FROM course_lessons WHERE id = ?').run(rid)
    const upd = db.prepare(`UPDATE course_lessons SET level_id = ?, seq = ?, no_label = ?, title = ?, theme = ?, textbook_ref = ?, points_json = ?, raw_json = ?, search_text = ?, text_hash = ? WHERE id = ?`)
    const write = (lid: number, n: { levelName: string; lesson: ParsedLesson; hash: string }) => {
      const l = n.lesson
      upd.run(lvByName.get(n.levelName), l.seq, l.noLabel, l.title, l.theme, l.textbookRef, JSON.stringify(l.points), JSON.stringify(l.raw),
        lessonSearchText({ levelName: n.levelName, noLabel: l.noLabel, title: l.title, theme: l.theme, textbookRef: l.textbookRef, points: l.points }), n.hash, lid)
    }
    for (const c of plan.changed) {
      db.prepare('DELETE FROM course_kp_map WHERE lesson_id = ? AND locked = 0').run(c.id)   // 没锁定的 AI 建议作废；锁定的人工结果保留……
      write(c.id, c.next)
      // ……但课的内容变了：锁定的对应要重新核对。原文依据不在新内容里的，退回成“待确认的建议”（解除锁定，之后重新匹配可以更新它）；手工指定的留着，只加一句提醒
      const qt = lessonQuoteText({ title: c.next.lesson.title, theme: c.next.lesson.theme, textbookRef: c.next.lesson.textbookRef, points: c.next.lesson.points })
      for (const m of db.prepare('SELECT kp_code, quote, source, reason FROM course_kp_map WHERE lesson_id = ?').all(c.id) as any[]) {
        const gone = m.quote && !qt.toLowerCase().replace(/\s+/g, '').includes(String(m.quote).toLowerCase().replace(/\s+/g, ''))
        const note = '课程内容已更新，需要重新核对'
        if (gone) db.prepare("UPDATE course_kp_map SET state = 'suggested', locked = 0, confidence = 'low', reason = ? WHERE kp_code = ? AND lesson_id = ?").run(`${note}：${m.reason ?? ''}`.slice(0, 80), m.kp_code, c.id)
        else db.prepare('UPDATE course_kp_map SET reason = ? WHERE kp_code = ? AND lesson_id = ?').run(`${note}：${m.reason ?? ''}`.slice(0, 80), m.kp_code, c.id)
      }
    }
    for (const s of plan.same) write(s.id, s.next)   // 内容没变：只同步级别归属和显示顺序
    const insertAdded = (n: { levelName: string; lesson: ParsedLesson }) => insertLessons(db, id, lvByName.get(n.levelName)!, n.levelName, [n.lesson])
    for (const a of plan.added) insertAdded(a)
    const counts = countsOf(plan)
    const changedAny = counts.added + counts.changed + counts.removed > 0
    db.prepare(`UPDATE course_outlines SET source_name = ?, source_hash = ?, mapping_json = ?, warnings_json = ?, ai_model = ?, status = 'active', rev = rev + ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(input.sourceName, input.sourceHash, JSON.stringify(input.mapping ?? null), JSON.stringify(input.warnings), input.aiModel, changedAny ? 1 : 0, id)
    db.exec('COMMIT')
    return { ...counts, affectedMaps: affected, ...impact }
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
}

export function removeOutline(db: Db, id: string): boolean {
  // 话术缓存没有外键：用到这个体系的一并删掉（里面是按这个体系写的文字，体系没了就不该留着）
  for (const r of db.prepare('SELECT scope_key, outline_ids_json FROM course_advice').all() as any[]) {
    if (json<string[]>(r.outline_ids_json, []).includes(id)) db.prepare('DELETE FROM course_advice WHERE scope_key = ?').run(r.scope_key)
  }
  return Number(db.prepare('DELETE FROM course_outlines WHERE id = ?').run(id).changes) > 0
}

export function setOutlineActive(db: Db, id: string, active: boolean): boolean {
  return Number(db.prepare('UPDATE course_outlines SET active = ? WHERE id = ?').run(active ? 1 : 0, id).changes) > 0
}

/** 草稿（命令行导入、尚未在窗口里确认）变成正式：之后才参与对照 */
export function confirmDraft(db: Db, id: string): boolean {
  return Number(db.prepare("UPDATE course_outlines SET status = 'active' WHERE id = ? AND status = 'draft'").run(id).changes) > 0
}

export function renameOutline(db: Db, id: string, name: string): boolean {
  return Number(db.prepare("UPDATE course_outlines SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(name, id).changes) > 0
}

// ───────────────────────── 读 ─────────────────────────

export interface KpTarget extends KpLite { sig: string }

/** 要匹配的知识点：库里（非示例卷）至少有一道题标过的二、三级知识点 */
export function targetKps(db: Db): KpTarget[] {
  const rows = db.prepare(`SELECT DISTINCT k.code, k.name, k.plain, k.example_en, k.hint_words, k.sort FROM kps k
    JOIN question_kps qk ON qk.kp_code = k.code JOIN questions q ON q.id = qk.question_id JOIN papers p ON p.id = q.paper_id
    WHERE p.is_sample = 0 AND k.level >= 2 ORDER BY k.sort, k.code`).all() as any[]
  return rows.map(r => {
    const kp: KpLite = { code: r.code, name: safeKpName(r.name), plain: r.plain ?? '', exampleEn: r.example_en ?? '', hintWords: r.hint_words ?? '' }
    return { ...kp, sig: kpSig(kp) }
  })
}

export type MatchStateKind = 'none' | 'partial' | 'stale' | 'done'
export interface MatchState { state: MatchStateKind; total: number; checked: number }

export function matchState(db: Db, id: string, kps: KpTarget[] = targetKps(db)): MatchState {
  const o = db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(id) as any
  if (!o) return { state: 'none', total: kps.length, checked: 0 }
  // 只看现在要匹配的知识点：老师在二级考点上手工指定的课（那个二级考点自己不是匹配对象）留下的检查记录不算，免得它的旧版本号让状态永远是“需要重新匹配”
  const targets = new Set(kps.map(k => k.code))
  const rows = (db.prepare('SELECT kp_code, outline_rev, kp_sig FROM course_kp_check WHERE outline_id = ?').all(id) as any[]).filter(r => targets.has(r.kp_code))
  if (!rows.length) return { state: 'none', total: kps.length, checked: 0 }
  if (rows.some(r => r.outline_rev !== o.rev)) return { state: 'stale', total: kps.length, checked: 0 }
  const sig = new Map(rows.map(r => [r.kp_code, r.kp_sig]))
  const checked = kps.filter(k => sig.has(k.code) && (sig.get(k.code) === k.sig || !sig.get(k.code))).length
  return { state: checked >= kps.length ? 'done' : 'partial', total: kps.length, checked }
}

export interface OutlineCard {
  id: string; name: string; scene: Scene; termNote: string; sourceName: string; status: 'active' | 'draft'; active: boolean; rev: number
  levels: number; lessons: number; createdAt: string; updatedAt: string; aiModel: string; warnings: MapWarning[]
  match: MatchState
}

export function listOutlines(db: Db): OutlineCard[] {
  const kps = targetKps(db)
  const rows = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM course_levels WHERE outline_id = o.id) levels, (SELECT COUNT(*) FROM course_lessons WHERE outline_id = o.id) lessons
    FROM course_outlines o ORDER BY o.created_at DESC, o.rowid DESC`).all() as any[]
  return rows.map(r => ({
    id: r.id, name: r.name, scene: r.scene, termNote: r.term_note ?? '', sourceName: r.source_name ?? '', status: r.status, active: !!r.active, rev: r.rev,
    levels: r.levels, lessons: r.lessons, createdAt: r.created_at, updatedAt: r.updated_at, aiModel: r.ai_model ?? '', warnings: json(r.warnings_json, []), match: matchState(db, r.id, kps)
  }))
}

export interface LessonRow extends LessonLite { outlineId: string; levelId: number; searchText: string }

export function lessonRows(db: Db, outlineIds: string[]): LessonRow[] {
  if (!outlineIds.length) return []
  const ph = outlineIds.map(() => '?').join(',')
  return (db.prepare(`SELECT l.id, l.outline_id, l.level_id, lv.name levelName, l.seq, l.no_label, l.title, l.theme, l.textbook_ref, l.points_json, l.search_text
    FROM course_lessons l JOIN course_levels lv ON lv.id = l.level_id WHERE l.outline_id IN (${ph}) ORDER BY lv.sort, l.seq, l.id`).all(...outlineIds) as any[]).map(r => ({
    id: r.id, outlineId: r.outline_id, levelId: r.level_id, levelName: r.levelName, seq: r.seq, noLabel: r.no_label ?? '', title: r.title ?? '', theme: r.theme ?? '', textbookRef: r.textbook_ref ?? '',
    points: json<Array<{ kind: PointKind; label: string; text: string }>>(r.points_json, []), searchText: r.search_text ?? ''
  }))
}

export interface OutlineDetail { card: OutlineCard; levels: Array<{ id: number; name: string; lessons: Array<LessonRow & { raw: Record<string, string> }> }> }

export function getOutline(db: Db, id: string): OutlineDetail | null {
  const card = listOutlines(db).find(o => o.id === id)
  if (!card) return null
  const raws = new Map((db.prepare('SELECT id, raw_json FROM course_lessons WHERE outline_id = ?').all(id) as any[]).map(r => [r.id as number, json<Record<string, string>>(r.raw_json, {})]))
  const lessons = lessonRows(db, [id]).map(l => ({ ...l, raw: raws.get(l.id) ?? {} }))
  const levels = (db.prepare('SELECT id, name FROM course_levels WHERE outline_id = ? ORDER BY sort, id').all(id) as any[]).map(lv => ({ id: lv.id, name: lv.name, lessons: lessons.filter(l => l.levelId === lv.id) }))
  return { card, levels }
}

/** 搜索课次（人工「添加课次」用）：按标题 / 词汇 / 句型 / 主题的检索文本 */
export function searchLessons(db: Db, outlineIds: string[], q: string, limit = 20): LessonRow[] {
  const t = q.trim().toLowerCase()
  const all = lessonRows(db, outlineIds)
  const hit = t ? all.filter(l => l.searchText.toLowerCase().includes(t)) : all
  return hit.slice(0, limit)
}

// ───────────────────────── 匹配结果的写入与人工修正 ─────────────────────────

export function existingMaps(db: Db, outlineId: string, kpCode: string): ExistingMap[] {
  return (db.prepare('SELECT lesson_id, locked, state, source FROM course_kp_map WHERE outline_id = ? AND kp_code = ?').all(outlineId, kpCode) as any[])
    .map(r => ({ lessonId: r.lesson_id, locked: !!r.locked, state: r.state, source: r.source }))
}

/** 把一批匹配结果落库（一个事务）；见 match.ts 的 planMerge。none / matched 一起写进 course_kp_check */
export function applyMatchBatch(db: Db, outlineId: string, entries: MatchEntry[], meta: { rev: number; model: string; promptVersion: string; sigs: Map<string, string> }): { matched: number; none: number } {
  let matched = 0, none = 0
  db.exec('BEGIN')
  try {
    const delMap = db.prepare('DELETE FROM course_kp_map WHERE kp_code = ? AND lesson_id = ?')
    const insMap = db.prepare(`INSERT OR REPLACE INTO course_kp_map (outline_id, kp_code, lesson_id, confidence, reason, quote, source, state, locked) VALUES (?, ?, ?, ?, ?, ?, 'ai', 'suggested', 0)`)
    const upCheck = db.prepare(`INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const userNone = db.prepare("SELECT 1 FROM course_kp_check WHERE outline_id = ? AND kp_code = ? AND result = 'user_none'")
    for (const e of entries) {
      if (userNone.get(outlineId, e.code)) {   // 老师说过「没有对应的课」：不覆盖结果，但版本号要跟上，免得匹配状态一直停在“需要重新匹配”
        db.prepare('UPDATE course_kp_check SET outline_rev = ?, kp_sig = ? WHERE outline_id = ? AND kp_code = ?').run(meta.rev, meta.sigs.get(e.code) ?? '', outlineId, e.code)
        continue
      }
      const plan = planMerge(existingMaps(db, outlineId, e.code), e)
      for (const lid of plan.deleteLessonIds) delMap.run(e.code, lid)
      for (const m of plan.insert) insMap.run(outlineId, e.code, m.lessonId, m.confidence, m.reason, m.quote)
      upCheck.run(outlineId, e.code, plan.result, meta.rev, meta.sigs.get(e.code) ?? '', meta.model, meta.promptVersion)
      if (plan.result === 'matched') matched++; else none++
    }
    db.exec('COMMIT')
  } catch (err) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw err }
  return { matched, none }
}

export type MapEdit =
  | { op: 'confirm'; kp: string; lessonId: number }
  | { op: 'reject'; kp: string; lessonId: number }
  | { op: 'reset'; kp: string; lessonId: number }
  | { op: 'add'; outlineId: string; kp: string; lessonId: number }
  | { op: 'none'; outlineId: string; kp: string; force?: boolean }

/** 人工修正：确认 / 否决（锁定，重新匹配永不覆盖）、取消、手工添加、「其实没有对应的课」。立即生效，不调用 AI */
export function editMap(db: Db, e: MapEdit): boolean {
  if (e.op === 'confirm' || e.op === 'reject' || e.op === 'reset') {
    const sql = e.op === 'confirm' ? "UPDATE course_kp_map SET state = 'confirmed', locked = 1 WHERE kp_code = ? AND lesson_id = ?"
      : e.op === 'reject' ? "UPDATE course_kp_map SET state = 'rejected', locked = 1 WHERE kp_code = ? AND lesson_id = ?"
        : 'DELETE FROM course_kp_map WHERE kp_code = ? AND lesson_id = ?'
    return Number(db.prepare(sql).run(e.kp, e.lessonId).changes) > 0
  }
  const o = db.prepare('SELECT rev FROM course_outlines WHERE id = ?').get(e.outlineId) as any
  if (!o) return false
  db.exec('BEGIN')
  try {
    if (e.op === 'add') {
      const l = db.prepare('SELECT 1 FROM course_lessons WHERE id = ? AND outline_id = ?').get(e.lessonId, e.outlineId)
      if (!l) { db.exec('ROLLBACK'); return false }
      db.prepare(`INSERT OR REPLACE INTO course_kp_map (outline_id, kp_code, lesson_id, confidence, reason, quote, source, state, locked) VALUES (?, ?, ?, 'high', '老师手工指定', '', 'manual', 'confirmed', 1)`).run(e.outlineId, e.kp, e.lessonId)
      const cur = db.prepare('SELECT kp_sig FROM course_kp_check WHERE outline_id = ? AND kp_code = ?').get(e.outlineId, e.kp) as any
      db.prepare(`INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) VALUES (?, ?, 'matched', ?, ?, 'manual', '')`).run(e.outlineId, e.kp, o.rev, cur?.kp_sig ?? '')
    } else {
      // 老师确认过的对应不能被悄悄翻成“不对”：有的话先问（force 才继续）
      const confirmed = (db.prepare("SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ? AND kp_code = ? AND state = 'confirmed'").get(e.outlineId, e.kp) as any).c as number
      if (confirmed > 0 && !e.force) { db.exec('ROLLBACK'); throw new Error(`需要确认：这个考点有 ${confirmed} 条老师确认过的对应，标成“没有对应的课”会把它们也改成“不对”`) }
      db.prepare("UPDATE course_kp_map SET state = 'rejected', locked = 1 WHERE outline_id = ? AND kp_code = ?").run(e.outlineId, e.kp)
      const cur = db.prepare('SELECT kp_sig FROM course_kp_check WHERE outline_id = ? AND kp_code = ?').get(e.outlineId, e.kp) as any
      db.prepare(`INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) VALUES (?, ?, 'user_none', ?, ?, 'manual', '')`).run(e.outlineId, e.kp, o.rev, cur?.kp_sig ?? '')
    }
    db.exec('COMMIT')
  } catch (err) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw err }
  return true
}

/** 所有「知识点 → 课次」的对应（设置 → 体系详情 → 知识点对应 用） */
export function mapRows(db: Db, outlineId: string): Array<{ kp: string; kpName: string; lessonId: number; confidence: string; reason: string; quote: string; source: string; state: string; locked: boolean }> {
  return (db.prepare(`SELECT m.kp_code, k.name kp_name, m.lesson_id, m.confidence, m.reason, m.quote, m.source, m.state, m.locked FROM course_kp_map m LEFT JOIN kps k ON k.code = m.kp_code
    WHERE m.outline_id = ? ORDER BY k.sort, m.kp_code, m.lesson_id`).all(outlineId) as any[]).map(r => ({
    kp: r.kp_code, kpName: safeKpName(r.kp_name), lessonId: r.lesson_id, confidence: r.confidence, reason: r.reason ?? '', quote: r.quote ?? '', source: r.source, state: r.state, locked: !!r.locked
  }))
}
