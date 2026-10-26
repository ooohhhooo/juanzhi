import { ipcMain } from 'electron'
import crypto from 'node:crypto'
import { z } from 'zod'
import { getDb } from '../db'
import { listKps, listQtypes } from '../ai/taxonomy'
import { notifyDataChanged } from '../events'
import { LOW_CONFIDENCE } from '../parse/validate'

const UuidSchema = z.string().uuid()
const unit = z.number().min(0).max(1)

const PatchSchema = z.object({
  no_label: z.string().min(1).max(30).optional(),
  section: z.string().max(40).optional(),
  qtype: z.string().max(30).optional(),
  stem: z.string().max(8000).optional(),
  options: z.array(z.string().max(1000)).max(12).optional(),
  answer: z.string().max(1000).optional(),
  score: z.number().min(0).max(200).nullable().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  error_prone: z.boolean().optional(),
  error_reason: z.string().max(300).optional(),
  bbox: z.tuple([unit, unit, unit, unit]).nullable().optional(),
  page_idx: z.number().int().min(1).max(500).optional(),
  kp_main: z.string().max(80).nullable().optional(),
  kp_secondary: z.array(z.string().max(80)).max(3).optional(),
  reviewed: z.boolean().optional()
}).strict()

const SplitSchema = z.object({
  first: z.object({ stem: z.string().max(8000), options: z.array(z.string().max(1000)).max(12) }),
  second: z.object({ no_label: z.string().min(1).max(30), stem: z.string().max(8000), options: z.array(z.string().max(1000)).max(12) })
})

interface QuestionRow {
  id: string; paper_id: string; ord: number; no_label: string | null; no: number | null; section: string | null; section_title: string | null
  qtype: string | null; material_id: string | null; stem: string | null; options: string | null; answer: string | null; score: number | null
  difficulty: number | null; error_prone: number; error_reason: string | null; page_idx: number | null; bbox_json: string | null
  bbox_source: string | null; anchor: string | null; anchor_ref: string | null; confidence: number | null; reviewed: number
  kp_suggestion: string | null; kp_suggestion_status: string | null; flags_json: string; edited: number
}

const json = <T,>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) : fallback } catch { return fallback } }

function toView(r: QuestionRow, kps: Array<{ kp_code: string; is_primary: number }>) {
  return {
    id: r.id, paper_id: r.paper_id, ord: r.ord, no: r.no_label ?? String(r.no ?? ''), section: r.section ?? '', section_title: r.section_title ?? '',
    qtype: r.qtype ?? 'OTHER', material_id: r.material_id, stem: r.stem ?? '', options: json<string[]>(r.options, []), answer: r.answer ?? '',
    score: r.score, difficulty: r.difficulty ?? 3, error_prone: !!r.error_prone, error_reason: r.error_reason ?? '',
    page_idx: r.page_idx, bbox: json<number[] | null>(r.bbox_json, null), bbox_source: r.bbox_source ?? 'none',
    confidence: r.confidence ?? 1, reviewed: !!r.reviewed, kp_suggestion: r.kp_suggestion ?? '', kp_suggestion_status: r.kp_suggestion_status,
    flags: json<string[]>(r.flags_json, []), edited: !!r.edited,
    kp_main: kps.find(k => k.is_primary)?.kp_code ?? null,
    kp_secondary: kps.filter(k => !k.is_primary).map(k => k.kp_code)
  }
}

function listForPaper(paperId: string) {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY ord').all(paperId) as unknown as QuestionRow[]
  const kpRows = db.prepare(`SELECT qk.question_id, qk.kp_code, qk.is_primary FROM question_kps qk JOIN questions q ON q.id = qk.question_id WHERE q.paper_id = ?`)
    .all(paperId) as unknown as Array<{ question_id: string; kp_code: string; is_primary: number }>
  const by = new Map<string, Array<{ kp_code: string; is_primary: number }>>()
  for (const k of kpRows) {
    if (!by.has(k.question_id)) by.set(k.question_id, [])
    by.get(k.question_id)!.push(k)
  }
  return rows.map(r => toView(r, by.get(r.id) ?? []))
}

function getRow(id: string): QuestionRow {
  const r = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id) as unknown as QuestionRow | undefined
  if (!r) throw new Error('题目不存在')
  return r
}

function setKps(questionId: string, main: string | null, secondary: string[]): void {
  const db = getDb()
  const known = new Set((db.prepare('SELECT code FROM kps').all() as Array<{ code: string }>).map(k => k.code))
  if (main && !known.has(main)) throw new Error(`知识点代码不存在：${main}`)
  for (const s of secondary) if (!known.has(s)) throw new Error(`知识点代码不存在：${s}`)
  db.prepare('DELETE FROM question_kps WHERE question_id = ?').run(questionId)
  const ins = db.prepare('INSERT OR IGNORE INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
  if (main) ins.run(questionId, main, 1)
  for (const s of secondary) if (s !== main) ins.run(questionId, s, 0)
}

function unionBox(a: number[] | null, b: number[] | null): number[] | null {
  if (!a || !b) return a ?? b
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1])
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3])
  return [x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v * 1000) / 1000)
}

/** 已「完成」的试卷里内容又变了（编辑、拆分、合并、删除、采纳建议）→ 回到「待审核」，不让状态和内容对不上 */
function reopenIfDone(paperId: string): void {
  const r = getDb().prepare("UPDATE papers SET status = 'reviewing' WHERE id = ? AND status = 'done'").run(paperId)
  if (r.changes > 0) notifyDataChanged('papers')
}

export function registerQuestionIpc(): void {
  ipcMain.handle('questions:list', async (_e, rawPaperId: unknown) => {
    const paperId = UuidSchema.parse(rawPaperId)
    const db = getDb()
    const materials = db.prepare('SELECT mid, section, kind, text, page_idx FROM materials WHERE paper_id = ? ORDER BY id').all(paperId)
    // 只看已成功完成的那次解析：取消/失败的运行属于别的结果，不能当作当前这批题目的来源
    const run = db.prepare("SELECT id, prompt_version, model, vision_model, status, started_at, finished_at, result_json FROM parse_runs WHERE paper_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(paperId) as any
    let notes: string[] = []
    if (run?.result_json) { try { notes = JSON.parse(run.result_json).notes ?? [] } catch { /* 忽略 */ } }
    return {
      questions: listForPaper(paperId),
      materials,
      notes,
      lowConfidence: LOW_CONFIDENCE,
      run: run ? { id: run.id, prompt_version: run.prompt_version, model: run.model, vision_model: run.vision_model, status: run.status, finished_at: run.finished_at } : null
    }
  })

  /** 审核列表用：每份试卷的题数、已确认数、需关注数（低置信度或有待处理的知识点建议） */
  ipcMain.handle('questions:summary', async () => {
    return getDb().prepare(`
      SELECT paper_id, COUNT(*) total, SUM(reviewed) reviewed,
        SUM(CASE WHEN reviewed = 0 AND (confidence < ? OR kp_suggestion_status = 'pending') THEN 1 ELSE 0 END) attention
      FROM questions GROUP BY paper_id
    `).all(LOW_CONFIDENCE)
  })

  ipcMain.handle('questions:update', async (_e, rawId: unknown, rawPatch: unknown) => {
    const id = UuidSchema.parse(rawId)
    const p = PatchSchema.parse(rawPatch)
    const db = getDb()
    const cur = getRow(id)
    if (p.qtype !== undefined && !db.prepare('SELECT 1 FROM qtypes WHERE code = ?').get(p.qtype)) throw new Error(`题型不存在：${p.qtype}`)

    const sets: string[] = []
    const vals: any[] = []
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }
    let contentChanged = false
    if (p.no_label !== undefined) { set('no_label', p.no_label); set('no', /^\d+$/.test(p.no_label) ? Number(p.no_label) : null); contentChanged = true }
    for (const k of ['section', 'qtype', 'stem', 'answer', 'score', 'difficulty', 'error_reason', 'page_idx'] as const) {
      if (p[k] !== undefined) { set(k, p[k]); contentChanged = true }
    }
    if (p.options !== undefined) { set('options', JSON.stringify(p.options)); contentChanged = true }
    if (p.error_prone !== undefined) { set('error_prone', p.error_prone ? 1 : 0); contentChanged = true }
    if (p.bbox !== undefined) {
      set('bbox_json', p.bbox ? JSON.stringify(p.bbox) : null)
      set('bbox_source', p.bbox ? 'manual' : 'none')
      contentChanged = true
    }
    if (p.reviewed !== undefined) set('reviewed', p.reviewed ? 1 : 0)
    if (contentChanged) set('edited', 1)

    db.exec('BEGIN')
    try {
      if (sets.length) db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
      if (p.kp_main !== undefined || p.kp_secondary !== undefined) {
        const existing = db.prepare('SELECT kp_code, is_primary FROM question_kps WHERE question_id = ?').all(id) as unknown as Array<{ kp_code: string; is_primary: number }>
        const main = p.kp_main !== undefined ? p.kp_main : existing.find(k => k.is_primary)?.kp_code ?? null
        const secondary = p.kp_secondary !== undefined ? p.kp_secondary : existing.filter(k => !k.is_primary).map(k => k.kp_code)
        setKps(id, main, secondary)
        db.prepare('UPDATE questions SET edited = 1 WHERE id = ?').run(id)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    if (contentChanged || p.kp_main !== undefined || p.kp_secondary !== undefined) reopenIfDone(cur.paper_id)
    notifyDataChanged('questions')
    return listForPaper(cur.paper_id).find(q => q.id === id) ?? null
  })

  ipcMain.handle('questions:remove', async (_e, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const q = getRow(id)
    const db = getDb()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM questions WHERE id = ?').run(id)
      db.prepare('UPDATE questions SET ord = ord - 1 WHERE paper_id = ? AND ord > ?').run(q.paper_id, q.ord)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    reopenIfDone(q.paper_id)
    notifyDataChanged('questions')
    return true
  })

  ipcMain.handle('questions:split', async (_e, rawId: unknown, rawBody: unknown) => {
    const id = UuidSchema.parse(rawId)
    const body = SplitSchema.parse(rawBody)
    const q = getRow(id)
    const db = getDb()
    const newId = crypto.randomUUID()
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE questions SET ord = ord + 1 WHERE paper_id = ? AND ord > ?').run(q.paper_id, q.ord)
      db.prepare('UPDATE questions SET stem = ?, options = ?, edited = 1, reviewed = 0 WHERE id = ?').run(body.first.stem, JSON.stringify(body.first.options), id)
      db.prepare(`INSERT INTO questions (id, paper_id, ord, no, no_label, section, section_title, qtype, material_id, stem, options, answer, score,
          difficulty, error_prone, error_reason, page_idx, bbox_json, bbox_source, anchor, anchor_ref, confidence, reviewed, kp_suggestion,
          kp_suggestion_status, flags_json, edited)
        SELECT ?, paper_id, ord + 1, ?, ?, section, section_title, qtype, material_id, ?, ?, '', NULL, difficulty, error_prone, error_reason,
          page_idx, bbox_json, bbox_source, anchor, anchor_ref, MIN(COALESCE(confidence, 1), 0.69), 0, '', NULL, flags_json, 1
        FROM questions WHERE id = ?`)
        .run(newId, /^\d+$/.test(body.second.no_label) ? Number(body.second.no_label) : null, body.second.no_label, body.second.stem, JSON.stringify(body.second.options), id)
      db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) SELECT ?, kp_code, is_primary FROM question_kps WHERE question_id = ?').run(newId, id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    reopenIfDone(q.paper_id)
    notifyDataChanged('questions')
    return newId
  })

  /** 与下一题合并：题干换行拼接、选项相接、分值相加、bbox 取并集，保留本题的知识点 */
  ipcMain.handle('questions:merge', async (_e, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    const a = getRow(id)
    const db = getDb()
    const b = db.prepare('SELECT * FROM questions WHERE paper_id = ? AND ord = ?').get(a.paper_id, a.ord + 1) as unknown as QuestionRow | undefined
    if (!b) throw new Error('这已经是最后一题，没有可合并的下一题')
    const stem = [a.stem, b.stem].filter(Boolean).join('\n')
    const options = [...json<string[]>(a.options, []), ...json<string[]>(b.options, [])]
    const score = a.score === null && b.score === null ? null : (a.score ?? 0) + (b.score ?? 0)
    const samePage = a.page_idx === b.page_idx
    const bbox = samePage ? unionBox(json(a.bbox_json, null), json(b.bbox_json, null)) : json(a.bbox_json, null)
    const flags = [...new Set([...json<string[]>(a.flags_json, []), ...json<string[]>(b.flags_json, [])])]
    // 被合并的一题的知识点不能悄悄丢掉：本题的主知识点不变，对方的主/次知识点并入次知识点（最多 3 个）
    const kpOf = (qid: string) => db.prepare('SELECT kp_code, is_primary FROM question_kps WHERE question_id = ?').all(qid) as unknown as Array<{ kp_code: string; is_primary: number }>
    const ka = kpOf(a.id), kb = kpOf(b.id)
    const mainA = ka.find(k => k.is_primary)?.kp_code ?? kb.find(k => k.is_primary)?.kp_code ?? null
    const secondary = [...new Set([...ka.filter(k => !k.is_primary), ...kb].map(k => k.kp_code))].filter(c => c !== mainA).slice(0, 3)
    // kp_suggestion 也只留一条：本题有就用本题的，否则用对方的（带着各自的状态）
    const keepB = !a.kp_suggestion && !!b.kp_suggestion
    const sugg = keepB ? b.kp_suggestion : a.kp_suggestion
    const suggStatus = keepB ? b.kp_suggestion_status : a.kp_suggestion_status
    db.exec('BEGIN')
    try {
      db.prepare(`UPDATE questions SET stem = ?, options = ?, score = ?, bbox_json = ?, bbox_source = ?, flags_json = ?, kp_suggestion = ?, kp_suggestion_status = ?, edited = 1, reviewed = 0 WHERE id = ?`)
        .run(stem, JSON.stringify(options), score, bbox ? JSON.stringify(bbox) : null, bbox ? (samePage ? 'manual' : a.bbox_source) : 'none', JSON.stringify(flags), sugg, suggStatus, id)
      setKps(id, mainA, secondary)
      db.prepare('DELETE FROM questions WHERE id = ?').run(b.id)
      db.prepare('UPDATE questions SET ord = ord - 1 WHERE paper_id = ? AND ord > ?').run(a.paper_id, a.ord + 1)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    reopenIfDone(a.paper_id)
    notifyDataChanged('questions')
    return true
  })

  /** 确认整份试卷：markAll=true 时把所有题标为已确认，状态置为 done */
  ipcMain.handle('questions:confirmPaper', async (_e, rawPaperId: unknown, markAll: unknown) => {
    const paperId = UuidSchema.parse(rawPaperId)
    const all = z.boolean().parse(markAll)
    const db = getDb()
    const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(paperId) as { status: string } | undefined
    if (!paper) throw new Error('试卷不存在')
    if (!['reviewing', 'done'].includes(paper.status)) throw new Error('这份试卷还没有解析完成，不能确认')
    const pending = (db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ? AND reviewed = 0').get(paperId) as { c: number }).c
    if (pending > 0 && !all) throw new Error(`还有 ${pending} 道题没有确认`)
    db.exec('BEGIN')
    try {
      if (all) db.prepare('UPDATE questions SET reviewed = 1 WHERE paper_id = ?').run(paperId)
      db.prepare("UPDATE papers SET status = 'done' WHERE id = ?").run(paperId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    notifyDataChanged('papers', 'questions')
    return true
  })

  ipcMain.handle('questions:reopen', async (_e, rawPaperId: unknown) => {
    const paperId = UuidSchema.parse(rawPaperId)
    getDb().prepare("UPDATE papers SET status = 'reviewing' WHERE id = ? AND status = 'done'").run(paperId)
    notifyDataChanged('papers')
    return true
  })

  // ───── 知识点树 / 题型 / kp_suggestion ─────

  // includeDeprecated：设置页的编辑器要看到停用的节点；审核页的选择器默认不含（停用的节点不再提供给 AI 和选择器，已有标注不受影响）
  ipcMain.handle('taxonomy:tree', async (_e, rawOpts?: unknown) => {
    const opts = z.object({ includeDeprecated: z.boolean().optional() }).strict().optional().parse(rawOpts)
    return { kps: listKps(!!opts?.includeDeprecated), qtypes: listQtypes() }
  })

  /**
   * 老师采纳 AI 的新增知识点建议：这才会在树里新建节点（AI 解析本身从不写树）。
   * 新节点成为本题主知识点，原主知识点降为次知识点。树最多 3 层，父节点已在第 3 层时挂到它的上一级。
   */
  ipcMain.handle('taxonomy:approveSuggestion', async (_e, rawId: unknown, rawBody: unknown) => {
    const id = UuidSchema.parse(rawId)
    const body = z.object({ parent_code: z.string().max(80).nullable(), name: z.string().trim().min(1).max(30) }).parse(rawBody)
    const q = getRow(id)
    const db = getDb()
    let parent = body.parent_code ? (db.prepare('SELECT code, parent_code, level, sort FROM kps WHERE code = ?').get(body.parent_code) as any) : null
    if (body.parent_code && !parent) throw new Error('父节点不存在')
    if (parent && parent.level >= 3) parent = parent.parent_code ? db.prepare('SELECT code, parent_code, level, sort FROM kps WHERE code = ?').get(parent.parent_code) : null

    db.exec('BEGIN')
    try {
      const pcode: string | null = parent?.code ?? null
      const same = db.prepare('SELECT code FROM kps WHERE parent_code IS ? AND name = ? AND deprecated = 0').get(pcode, body.name) as { code: string } | undefined
      let code = same?.code
      if (!code) {
        const prefix = pcode ?? 'U'
        let n = 1
        while (db.prepare('SELECT 1 FROM kps WHERE code = ?').get(`${prefix}.U${n}`)) n++
        code = `${prefix}.U${n}`
        const sort = parent ? parent.sort + n : ((db.prepare('SELECT MAX(sort) m FROM kps').get() as any).m ?? 0) + 10
        db.prepare(`INSERT INTO kps (code, parent_code, name, level, intro_grade, sort, deprecated, note, builtin) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, 0)`)
          .run(code, pcode, body.name, (parent?.level ?? 0) + 1, sort, `由老师采纳 AI 建议新增（题 ${q.no_label ?? ''}）`)
      }
      const oldMain = (db.prepare('SELECT kp_code FROM question_kps WHERE question_id = ? AND is_primary = 1').get(id) as any)?.kp_code as string | undefined
      const secondary = (db.prepare('SELECT kp_code FROM question_kps WHERE question_id = ? AND is_primary = 0').all(id) as Array<{ kp_code: string }>).map(r => r.kp_code)
      if (oldMain && oldMain !== code) secondary.unshift(oldMain)
      setKps(id, code, [...new Set(secondary)].filter(c => c !== code).slice(0, 3))
      db.prepare("UPDATE questions SET kp_suggestion_status = 'approved', edited = 1 WHERE id = ?").run(id)
      db.exec('COMMIT')
      reopenIfDone(q.paper_id)
      notifyDataChanged('questions', 'taxonomy')
      return code
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })

  ipcMain.handle('taxonomy:rejectSuggestion', async (_e, rawId: unknown) => {
    const id = UuidSchema.parse(rawId)
    getDb().prepare("UPDATE questions SET kp_suggestion_status = 'rejected', edited = 1 WHERE id = ?").run(id)
    notifyDataChanged('questions')
    return true
  })
}
