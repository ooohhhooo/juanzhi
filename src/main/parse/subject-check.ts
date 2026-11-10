/**
 * 导入后的学科核对（纯逻辑，数据库句柄由调用方传入，不依赖 electron，可单测）：
 *  - checkSubjectAfterExtract：提取完成后按卷面文字判断学科；有把握且和当前学科不同 → 写 subject_hint，等用户确认；
 *  - resolvePaperSubject：用户在提醒里选了学科；
 *  - changePaperSubject：用户手动「改学科」：删掉旧题目、按新学科重新识别。
 */
import { detectSubject } from '../../shared/classify.ts'
import { asSubject, isSubjectId, subjectName } from '../../shared/subject.ts'
import type { SubjectId } from '../../shared/subject.ts'

/** 取一份卷子各页的文字（优先 pages.text，没有就用 lines_json 里的行） */
export function paperText(db: any, paperId: string): string {
  const rows = db.prepare('SELECT text, lines_json FROM pages WHERE paper_id = ? ORDER BY idx').all(paperId) as Array<{ text: string | null; lines_json: string | null }>
  return rows.map(r => {
    if (r.text && r.text.trim()) return r.text
    try { return (JSON.parse(r.lines_json || '[]') as Array<{ text?: string }>).map(l => l.text ?? '').join('\n') } catch { return '' }
  }).join('\n')
}

export interface SubjectCheck {
  /** 'hint'：有把握但和当前学科不同，已写入 subject_hint，不要解析 */
  action: 'parse' | 'hint'
  hint?: SubjectId
  reason?: string
}

/** 提取完成后调用：决定能不能直接进入解析 */
export function checkSubjectAfterExtract(db: any, paperId: string): SubjectCheck {
  const p = db.prepare('SELECT subject, title, subject_hint, subject_confirmed FROM papers WHERE id = ?').get(paperId) as { subject: string; title: string; subject_hint: string | null; subject_confirmed: number } | undefined
  if (!p) return { action: 'parse' }
  if (p.subject_confirmed) return { action: 'parse' }   // 用户已经选过学科：尊重用户，不再提醒
  const cur = asSubject(p.subject)
  const r = detectSubject(paperText(db, paperId), p.title ?? '')
  if (r.sure && r.subject && r.subject !== cur) {
    db.prepare('UPDATE papers SET subject_hint = ? WHERE id = ?').run(r.subject, paperId)
    return { action: 'hint', hint: r.subject, reason: r.reason }
  }
  if (p.subject_hint) db.prepare('UPDATE papers SET subject_hint = NULL WHERE id = ?').run(paperId)
  return { action: 'parse' }
}

/** 是否正在等用户确认学科（解析队列据此拒绝解析） */
export function hasSubjectHint(db: any, paperId: string): boolean {
  const r = db.prepare('SELECT subject_hint FROM papers WHERE id = ?').get(paperId) as { subject_hint: string | null } | undefined
  return !!r?.subject_hint
}

/** 用户在提醒里选了学科：设 subject、清 hint。返回 true = 学科真的变了 */
export function resolvePaperSubject(db: any, paperId: string, subject: SubjectId): boolean {
  if (!isSubjectId(subject)) throw new Error('不认识的学科')
  const p = db.prepare('SELECT subject FROM papers WHERE id = ?').get(paperId) as { subject: string } | undefined
  if (!p) throw new Error('试卷不存在')
  db.prepare('UPDATE papers SET subject = ?, subject_hint = NULL, subject_confirmed = 1 WHERE id = ?').run(subject, paperId)
  return asSubject(p.subject) !== subject
}

export type ChangeResult =
  | { ok: true; changed: boolean; reparse: boolean }
  | { ok: false; needConfirm: true; reviewed: number }

/**
 * 改学科：已审核的题要二次确认（confirmLoseReview）；处理中的不允许改（busy 由调用方判断，传 true 就抛错）。
 * 改完删掉旧题目和材料，旧的 AI 结果作废；有页面的退回「已提取」，reparse=true 提示调用方重新解析。
 */
export function changePaperSubject(db: any, paperId: string, subject: SubjectId, opts: { confirmLoseReview?: boolean; busy?: boolean } = {}): ChangeResult {
  if (!isSubjectId(subject)) throw new Error('不认识的学科')
  const p = db.prepare('SELECT subject, status, subject_hint FROM papers WHERE id = ?').get(paperId) as { subject: string; status: string; subject_hint: string | null } | undefined
  if (!p) throw new Error('试卷不存在')
  if (opts.busy || ['imported', 'extracting', 'parsing'].includes(p.status)) throw new Error('试卷正在处理中，请稍候再改学科')
  if (asSubject(p.subject) === subject) {
    db.prepare('UPDATE papers SET subject_hint = NULL, subject_confirmed = 1 WHERE id = ?').run(paperId)
    return { ok: true, changed: false, reparse: false }
  }
  // 已审核：整份确认过（done），或者有逐题标记「已审核」的题
  const reviewedQs = (db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ? AND reviewed = 1').get(paperId) as { c: number }).c
  const total = (db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(paperId) as { c: number }).c
  const reviewed = p.status === 'done' ? total : reviewedQs
  if (reviewed > 0 && !opts.confirmLoseReview) return { ok: false, needConfirm: true, reviewed }

  const pages = (db.prepare('SELECT COUNT(*) c FROM pages WHERE paper_id = ?').get(paperId) as { c: number }).c
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM questions WHERE paper_id = ?').run(paperId)
    db.prepare('DELETE FROM materials WHERE paper_id = ?').run(paperId)
    db.prepare("UPDATE parse_runs SET result_json = NULL, status = CASE WHEN status IN ('done','ai_done','running') THEN 'superseded' ELSE status END WHERE paper_id = ?").run(paperId)
    db.prepare('UPDATE papers SET subject = ?, subject_hint = NULL, subject_confirmed = 1 WHERE id = ?').run(subject, paperId)
    if (pages > 0) {
      db.prepare("UPDATE papers SET status = 'extracted', error = NULL, error_detail = NULL, error_stage = NULL, parse_stage = NULL, warning = NULL, parsed_at = NULL, prompt_version = NULL WHERE id = ?").run(paperId)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { ok: true, changed: true, reparse: pages > 0 }
}

export const hintText = (hint: SubjectId, reason?: string): string => `这份看起来是${subjectName(hint)}卷${reason ? `（${reason}）` : ''}`
