/**
 * Skill 成长的数据层（纯函数 + node:sqlite / fs，数据库句柄和目录由调用方传入，单测用内存库和临时目录）：
 * 回答完成后记指纹和用户信号、判断是否提示「存成 Skill」、Skill 的版本 / 历史 / 使用记录、「最近 3 次都被改」的更新提示。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getSession } from '../store.ts'
import { extractTurns, isRevision, toolNamesOf } from './turns.ts'
import type { Turn } from './turns.ts'
import { groupTurns, isCovered, jaccard, keywordsOf, makeFp, stripVariables, similar, suggestFor, turnKey, WINDOW_DAYS } from './fingerprint.ts'
import type { Cover, TurnFp, TurnRec } from './fingerprint.ts'
import { listUserSkillFiles, saveSkill, skillFromText, skillText } from '../playbooks/manage.ts'
import type { SkillInput } from '../playbooks/manage.ts'

type Db = any
const STATE_KEY = 'skill_suggest_v1'

interface State {
  shown: Array<{ fp: TurnFp; sessionId: string; answerSeq: number; label: string; at: number }>
  dismissed: TurnFp[]
  updShown: Array<{ name: string; version: number; sessionId: string; answerSeq: number; useId: number }>
  updDismissed: Array<{ name: string; version: number; useId: number }>
}
function readState(db: Db): State {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(STATE_KEY) as any
  let v: any = {}
  try { v = row ? JSON.parse(row.value_json) : {} } catch { v = {} }
  return { shown: Array.isArray(v.shown) ? v.shown : [], dismissed: Array.isArray(v.dismissed) ? v.dismissed : [], updShown: Array.isArray(v.updShown) ? v.updShown : [], updDismissed: Array.isArray(v.updDismissed) ? v.updDismissed : [] }
}
function writeState(db: Db, s: State): void {
  const t: State = { ...s, shown: s.shown.slice(-100), dismissed: s.dismissed.slice(-100), updShown: s.updShown.slice(-100), updDismissed: s.updDismissed.slice(-100) }
  db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(STATE_KEY, JSON.stringify(t))
}

const ms = (s: string): number => { const t = Date.parse(String(s).replace(' ', 'T')); return Number.isFinite(t) ? t : Date.now() }

// ───────── Skill 元信息 ─────────
export interface SkillMeta { name: string; version: number; sampleCount: number; fp: TurnFp | null; sources: Array<{ sessionId: string; answerSeq: number }>; updatedAt: string }
export function getMeta(db: Db, name: string): SkillMeta | null {
  const r = db.prepare('SELECT * FROM skill_meta WHERE name = ?').get(name) as any
  if (!r) return null
  let fp: TurnFp | null = null, sources: SkillMeta['sources'] = []
  try { fp = JSON.parse(r.fp_json); if (!fp || !Array.isArray(fp.tools)) fp = null } catch { fp = null }
  try { sources = JSON.parse(r.sources_json) } catch { sources = [] }
  return { name: r.name, version: r.version, sampleCount: r.sample_count, fp, sources: Array.isArray(sources) ? sources : [], updatedAt: r.updated_at }
}
export function allMeta(db: Db): SkillMeta[] { return (db.prepare('SELECT name FROM skill_meta').all() as any[]).map(r => getMeta(db, r.name)!).filter(Boolean) }
function putMeta(db: Db, m: { name: string; version: number; sampleCount: number; fp: TurnFp | null; sources: SkillMeta['sources'] }): void {
  db.prepare("INSERT OR REPLACE INTO skill_meta (name, version, sample_count, fp_json, sources_json, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))")
    .run(m.name, m.version, m.sampleCount, JSON.stringify(m.fp ?? {}), JSON.stringify(m.sources))
}
export function coversOf(db: Db): Cover[] {
  return allMeta(db).map(m => ({ name: m.name, fp: m.fp ?? { role: '', tools: [], kw: [] }, sources: m.sources }))
}

// ───────── 回答记录 ─────────
export function listTurnRecs(db: Db, now: number, windowDays = WINDOW_DAYS): TurnRec[] {
  const rows = db.prepare("SELECT session_id, answer_seq, fp_json, rating, created_at FROM agent_turns WHERE created_at >= datetime(?, 'unixepoch', 'localtime') ORDER BY created_at DESC LIMIT 400").all(Math.floor((now - windowDays * 86400_000) / 1000)) as any[]
  const out: TurnRec[] = []
  for (const r of rows) { try { const fp = JSON.parse(r.fp_json); if (fp && Array.isArray(fp.tools) && !fp.rev) out.push({ sessionId: r.session_id, answerSeq: r.answer_seq, fp, at: ms(r.created_at), rating: r.rating, label: String(fp.label ?? '') }) } catch { /* 跳过 */ } }
  return out
}

export interface RecordResult { rec: TurnRec; created: boolean }

/**
 * 一次回答完成后调用：记指纹、记用户这句是不是在改上一个回答、记读取了哪些 Skill、判断要不要提示。
 * userSkills = 我的 Skill 的名字（只有这些才会提示「更新」）。
 */
export function recordTurn(db: Db, sessionId: string, o: { userSkills: Iterable<string>; now?: number }): RecordResult | null {
  const sess = getSession(db, sessionId)
  if (!sess) return null
  const turns = extractTurns(sess.steps)
  const last = turns[turns.length - 1]
  if (!last || last.stop !== 'answered') return null
  const exists = db.prepare('SELECT 1 FROM agent_turns WHERE session_id = ? AND answer_seq = ?').get(sessionId, last.answerSeq)
  const now = o.now ?? Date.now()
  const fp = { ...makeFp(sess.session.role, toolNamesOf(last), last.request) }
  const label = stripVariables(last.request).replace(/\s+/g, '').slice(0, 24) || last.request.slice(0, 20)
  const rec: TurnRec = { sessionId, answerSeq: last.answerSeq, fp, at: now, label, rating: null }
  if (exists) return { rec, created: false }
  // 这句话是不是在改上一个回答（同一分支里的上一个回合）：改稿的追问不算「又做了一次这类事」，不进分组
  const prev = [...turns.slice(0, -1)].reverse().find(t => t.branchId === last.branchId)
  const isRev = !!prev && isRevision(last.request)
  db.prepare('INSERT INTO agent_turns (session_id, answer_seq, role, subject, fp_json, created_at) VALUES (?, ?, ?, ?, ?, datetime(?, \'unixepoch\', \'localtime\'))')
    .run(sessionId, last.answerSeq, sess.session.role, sess.session.subject, JSON.stringify({ ...fp, label: rec.label, ...(isRev ? { rev: true } : {}) }), Math.floor(now / 1000))

  const revisedSkills: string[] = []
  if (prev && isRev) {
    db.prepare('UPDATE agent_turns SET revised = 1, revise_text = ? WHERE session_id = ? AND answer_seq = ?').run(last.request.slice(0, 200), sessionId, prev.answerSeq)
    revisedSkills.push(...prev.skills)
  }
  // 读取过的 Skill：按当时的版本记一次使用
  const usedHere = new Set(last.skills)
  const useStmt = db.prepare('INSERT OR IGNORE INTO skill_use (skill_name, skill_version, session_id, answer_seq) VALUES (?, ?, ?, ?)')
  for (const n of usedHere) useStmt.run(n, getMeta(db, n)?.version ?? 1, sessionId, last.answerSeq)

  const st = readState(db)
  // 1) 同一类事凑够 3 次、还没有 Skill 覆盖：提示一次
  const sug = isRev ? null : suggestFor(rec, listTurnRecs(db, now), { now, covers: coversOf(db), dismissed: st.dismissed, shown: st.shown.map(s => s.fp) })
  if (sug) st.shown.push({ fp: fp, sessionId, answerSeq: last.answerSeq, label: sug.label, at: now })
  // 2) 我的 Skill 最近 3 次都被改 / 被点踩：提示更新（挂在这次回答下面）
  const mine = new Set(o.userSkills)
  for (const n of new Set([...usedHere, ...revisedSkills])) {
    if (!mine.has(n)) continue
    const u = updateSuggestion(db, n)
    if (!u) continue
    if (st.updDismissed.some(d => d.name === n && d.version === u.version && d.useId === u.lastUseId)) continue
    if (st.updShown.some(d => d.name === n && d.version === u.version && d.useId === u.lastUseId)) continue
    st.updShown.push({ name: n, version: u.version, sessionId, answerSeq: last.answerSeq, useId: u.lastUseId })
  }
  writeState(db, st)
  return { rec, created: true }
}

/** 某次回答的指纹（去掉给界面用的 label）；Skill 保存时记下，用来判断以后同类的事是否已有 Skill 覆盖 */
export function turnFp(db: Db, sessionId: string, answerSeq: number): TurnFp | null {
  const r = db.prepare('SELECT fp_json FROM agent_turns WHERE session_id = ? AND answer_seq = ?').get(sessionId, answerSeq) as any
  try { const f = JSON.parse(r.fp_json); return { role: f.role, tools: f.tools, kw: f.kw } } catch { return null }
}

export function setRating(db: Db, sessionId: string, answerSeq: number, rating: 1 | -1 | null): void {
  db.prepare('UPDATE agent_turns SET rating = ? WHERE session_id = ? AND answer_seq = ?').run(rating, sessionId, answerSeq)
}
/** 用户导出了这个对话的产出：把这个对话里的回答都记成「导出过」（强信号） */
export function markExported(db: Db, sessionId: string): void {
  db.prepare('UPDATE agent_turns SET exported = 1 WHERE session_id = ?').run(sessionId)
}

export interface TurnSignals { rating: number | null; exported: boolean; revised: boolean; reviseText: string; at: number }
export function signalsOf(db: Db, sessionId: string, answerSeq: number): TurnSignals {
  const r = db.prepare('SELECT rating, exported, revised, revise_text, created_at FROM agent_turns WHERE session_id = ? AND answer_seq = ?').get(sessionId, answerSeq) as any
  return r ? { rating: r.rating ?? null, exported: !!r.exported, revised: !!r.revised, reviseText: r.revise_text ?? '', at: ms(r.created_at) } : { rating: null, exported: false, revised: false, reviseText: '', at: 0 }
}

// ───────── 提示 ─────────
export interface CreateHint { kind: 'create'; count: number; label: string }
export interface UpdateHint { kind: 'update'; name: string; count: number; hint: string }
export interface TurnInfo { rating: number | null; exported: boolean; create: CreateHint | null; updates: UpdateHint[]; skills: string[] }

export function turnInfo(db: Db, sessionId: string, answerSeq: number, now = Date.now()): TurnInfo {
  const sig = signalsOf(db, sessionId, answerSeq)
  const st = readState(db)
  let create: CreateHint | null = null
  const shown = st.shown.find(s => s.sessionId === sessionId && s.answerSeq === answerSeq)
  if (shown) {
    const recs = listTurnRecs(db, now)
    const group = groupTurns(recs, now).find(g => g.some(t => turnKey(t) === turnKey({ sessionId, answerSeq })))
    if (group && !isCovered(group, coversOf(db)) && !st.dismissed.some(d => group.some(t => similar(t.fp, d)))) create = { kind: 'create', count: group.length, label: shown.label }
  }
  const updates: UpdateHint[] = []
  for (const u of st.updShown.filter(x => x.sessionId === sessionId && x.answerSeq === answerSeq)) {
    const cur = updateSuggestion(db, u.name)
    if (!cur || cur.version !== u.version || cur.lastUseId !== u.useId) continue
    if (st.updDismissed.some(d => d.name === u.name && d.version === u.version && d.useId === u.useId)) continue
    updates.push({ kind: 'update', name: u.name, count: cur.count, hint: cur.hint })
  }
  const skills = (db.prepare('SELECT skill_name FROM skill_use WHERE session_id = ? AND answer_seq = ?').all(sessionId, answerSeq) as any[]).map(r => String(r.skill_name))
  return { rating: sig.rating, exported: sig.exported, create, updates, skills }
}

/** 「不用了」：这一类事以后不再提示 */
export function dismissCreate(db: Db, sessionId: string, answerSeq: number): void {
  const st = readState(db)
  const s = st.shown.find(x => x.sessionId === sessionId && x.answerSeq === answerSeq)
  if (s) { st.dismissed.push(s.fp); writeState(db, st) }
}
export function dismissUpdate(db: Db, name: string): void {
  const u = updateSuggestion(db, name)
  if (!u) return
  const st = readState(db)
  st.updDismissed.push({ name, version: u.version, useId: u.lastUseId })
  writeState(db, st)
}

/** 最近 3 次使用（当前版本）都被改过 / 点了踩，并且修改意见有共同点 → 建议更新 */
export function updateSuggestion(db: Db, name: string): { count: number; hint: string; version: number; lastUseId: number; revisions: string[] } | null {
  const ver = getMeta(db, name)?.version ?? 1
  const rows = db.prepare(`SELECT u.id, t.rating, t.revised, t.revise_text FROM skill_use u LEFT JOIN agent_turns t ON t.session_id = u.session_id AND t.answer_seq = u.answer_seq
    WHERE u.skill_name = ? AND u.skill_version = ? ORDER BY u.id DESC LIMIT 3`).all(name, ver) as any[]
  if (rows.length < 3) return null
  if (!rows.every(r => r.revised || r.rating === -1)) return null
  const texts = rows.filter(r => r.revised && r.revise_text).map(r => String(r.revise_text))
  let hint = ''
  if (texts.length >= 2) {
    const counts = new Map<string, number>()
    for (const t of texts) for (const k of new Set(keywordsOf(t))) counts.set(k, (counts.get(k) ?? 0) + 1)
    // 「改 / 短 / 一点」这类只是在说怎么改，不说改的是什么：优先取说「改了哪里」的词（结尾、开头、称呼……）
    const verbish = /[改换调整重写删加去不要太再点一些短长简]/
    const all = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    const common = all.filter(([k]) => !verbish.test(k)).length ? all.filter(([k]) => !verbish.test(k)) : all
    if (!common.length) return null
    hint = common[0][0]
  }
  return { count: 3, hint, version: ver, lastUseId: rows[0].id, revisions: texts }
}

// ───────── 取样本 ─────────
export interface LoadedSample { sessionId: string; answerSeq: number; turn: Turn; signals: TurnSignals; at: number; finalAnswer?: string; revisions: string[]; title: string }

/** 取某次回答作为样本；如果用户后来又在同一分支要求修改，用改完后的最终回答，并带上修改意见 */
export function loadSample(db: Db, sessionId: string, answerSeq: number): LoadedSample | null {
  const sess = getSession(db, sessionId)
  if (!sess) return null
  const turns = extractTurns(sess.steps)
  const i = turns.findIndex(t => t.answerSeq === answerSeq)
  if (i < 0) return null
  const turn = turns[i]
  let finalAnswer: string | undefined
  const revisions: string[] = []
  for (const t of turns.slice(i + 1)) {
    if (t.branchId !== turn.branchId || !isRevision(t.request)) break
    revisions.push(t.request); finalAnswer = t.answer
  }
  const signals = signalsOf(db, sessionId, answerSeq)
  return { sessionId, answerSeq, turn, signals, at: signals.at, finalAnswer, revisions, title: sess.session.title }
}

/** 一组回答里每个对应的样本（取不到的跳过） */
export function loadSamples(db: Db, refs: Array<{ sessionId: string; answerSeq: number }>): LoadedSample[] {
  return refs.map(r => loadSample(db, r.sessionId, r.answerSeq)).filter((x): x is LoadedSample => !!x)
}

/** 这次提示对应的那一组里的全部回答 */
export function groupRefsFor(db: Db, sessionId: string, answerSeq: number, now = Date.now()): TurnRec[] {
  const group = groupTurns(listTurnRecs(db, now), now).find(g => g.some(t => turnKey(t) === turnKey({ sessionId, answerSeq })))
  return group ?? []
}

// ───────── 版本历史 ─────────
const safe = (name: string): string => name.replace(/[\\/:*?"<>|\s.]+/g, '-').slice(0, 60) || 'skill'
const histDir = (dir: string, name: string): string => path.join(dir, '.history', safe(name))

export interface VersionInfo { version: number; at: string; current: boolean }
export function listVersions(dir: string, db: Db, name: string): VersionInfo[] {
  const cur = getMeta(db, name)?.version ?? 1
  const out: VersionInfo[] = []
  try {
    for (const f of fs.readdirSync(histDir(dir, name))) {
      const m = /^v(\d+)\.md$/.exec(f)
      if (m) out.push({ version: Number(m[1]), at: fs.statSync(path.join(histDir(dir, name), f)).mtime.toISOString(), current: false })
    }
  } catch { /* 没有历史 */ }
  if (listUserSkillFiles(dir).some(f => f.playbook.name === name)) out.push({ version: cur, at: getMeta(db, name)?.updatedAt ?? '', current: true })
  return out.sort((a, b) => b.version - a.version)
}
export function readVersionText(dir: string, name: string, version: number): string | null {
  try { return fs.readFileSync(path.join(histDir(dir, name), `v${Math.floor(version)}.md`), 'utf8') } catch { return null }
}

export interface SaveOpts {
  originalName?: string
  knownTools: Iterable<string>
  /** 从几次对话来的（手写 / 导入的不用写） */
  sources?: Array<{ sessionId: string; answerSeq: number }>
  sampleCount?: number
  fp?: TurnFp | null
  /** 导入时带来的版本号 */
  version?: number
}

/** 保存一个我的 Skill，同时留历史：改动已有 Skill 时，旧版本存进 .history，版本号 +1 */
export function saveSkillVersioned(dir: string, db: Db, input: SkillInput, o: SaveOpts): { name: string; warnings: string[]; version: number } {
  const key = o.originalName ?? input.name
  const old = listUserSkillFiles(dir).find(f => f.playbook.name === key)
  const oldMeta = getMeta(db, key)
  const oldText = old ? skillText(old.playbook) : null
  const r = saveSkill(dir, input, { originalName: o.originalName, knownTools: o.knownTools })
  const newFile = listUserSkillFiles(dir).find(f => f.playbook.name === r.name)
  const newText = newFile ? skillText(newFile.playbook) : ''
  let version = o.version ?? 1
  if (old && oldText !== null) {
    const oldVer = oldMeta?.version ?? 1
    if (oldText !== newText) {
      fs.mkdirSync(histDir(dir, key), { recursive: true })
      fs.writeFileSync(path.join(histDir(dir, key), `v${oldVer}.md`), oldText, 'utf8')
      version = oldVer + 1
    } else version = oldVer
  }
  if (r.name !== key && oldMeta) db.prepare('DELETE FROM skill_meta WHERE name = ?').run(key)
  putMeta(db, {
    name: r.name, version,
    sampleCount: o.sampleCount ?? oldMeta?.sampleCount ?? 0,
    fp: o.fp !== undefined ? o.fp : oldMeta?.fp ?? null,
    sources: o.sources ?? oldMeta?.sources ?? []
  })
  return { ...r, version }
}

/** 恢复到某个旧版本：当前的先存进历史，恢复后版本号继续往上加 */
export function restoreVersion(dir: string, db: Db, name: string, version: number, knownTools: Iterable<string>): { name: string; warnings: string[]; version: number } {
  const text = readVersionText(dir, name, version)
  if (text === null) throw new Error('找不到这个旧版本')
  const r = skillFromText(text, name)
  if (!r.ok) throw new Error(r.error)
  return saveSkillVersioned(dir, db, { ...r.input, name, origin: undefined }, { originalName: name, knownTools })
}

export function deleteSkillMeta(db: Db, name: string): void { db.prepare('DELETE FROM skill_meta WHERE name = ?').run(name) }
export { jaccard }
