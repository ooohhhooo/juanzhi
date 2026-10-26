/**
 * 把暂存好的数据包写进正在使用的库（合并 / 覆盖）。**只按列拷贝数据**：
 * 数据包里的库先在暂存阶段处理过（stage-db.ts：完整性检查、触发器和视图删除、旧版本迁移到最新、内容校验），
 * 这里把它 ATTACH 成只读的数据来源，用 `INSERT INTO main.t (列…) SELECT 列… FROM pk.t`，只拷两边都有的列。
 * 主库的表结构、触发器、索引一个字都不会被数据包改动。
 *
 * 原子性：库的写入是一个 `BEGIN IMMEDIATE` 事务；文件（files/ 目录）的改名发生在提交之前，并且整个「写库 + 改名 + 提交」
 * 是同步执行的（中间没有 await，渲染端的其它请求插不进来，看不到未提交的数据）。任何一步失败：回滚事务、把改过名的目录改回去。
 * 覆盖导入另有 journal（journal.ts）保护「改了目录、还没提交就崩溃」。
 * 纯函数模块（不依赖 electron），单测直接加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PackError } from './errors.ts'
import { MARKER_KEY, clearJournal, revertSwap, writeJournal } from './journal.ts'
import type { ImportJournal } from './journal.ts'
import { PACK_SETTING_KEYS } from './manifest.ts'
import { UUID_RE } from './names.ts'
import { renameRetry } from './fsretry.ts'
import { checkPackSetting } from './settings-rules.ts'

export interface ApplyDeps {
  /** 正在使用的库 */
  db: any
  dataDir: string
  filesDir: string
  now?: () => Date
  /** 测试用的故障注入：'after-db' = 写完库、改名之前；'after-swap' = 改完名、提交之前 */
  fault?: string | null
}

export interface Staged {
  dbPath: string
  filesDir: string
}

export interface ImportReport {
  mode: 'merge' | 'overwrite'
  papersAdded: number
  /** 包里已经在本机的（同一个 id）：跳过 */
  papersSkipped: number
  /** 新增的试卷里，文件内容和本机另一份相同（file_hash 相同、id 不同）的份数——统计时只算一份 */
  sameFileAsExisting: number
  questionsAdded: number
  kpsAdded: number
  kpsRemapped: number
  reportsAdded: number
  /** 页面图在包里找不到的页数 */
  missingPageImages: number
  /** 随包补进来的自定义提示词条数（本机没设置过才补）：它们会影响之后的 AI 分析和报告，所以要在报告里说出来 */
  promptsImported: number
  /** 包里有自定义提示词、但本机已经有自己的（保持本机的）：包里的条数 */
  promptsKeptLocal: number
  warnings: string[]
  backup?: { dir: string; dbFile: string; filesDir: string; bytes: number }
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`
const colsOf = (db: any, schema: string, table: string): string[] => (db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all() as any[]).map(c => c.name)
const one = (db: any, sql: string, ...p: any[]): any => db.prepare(sql).get(...p)
const count = (db: any, sql: string, ...p: any[]): number => (one(db, sql, ...p) as any).c as number

/** 按列拷贝：只拷主库和数据来源都有的列；skip 是不拷的列，force 是列 → 固定的 SQL 表达式 */
function copyRows(db: any, table: string, o: { skip?: string[]; force?: Record<string, string>; where?: string; orIgnore?: boolean } = {}): number {
  const skip = new Set(o.skip ?? [])
  const force = o.force ?? {}
  const src = colsOf(db, 'pk', table)
  const use = colsOf(db, 'main', table).filter(c => src.includes(c) && !skip.has(c) && !(c in force))
  const names = [...use, ...Object.keys(force)]
  const exprs = [...use.map(c => `s.${q(c)}`), ...Object.values(force)]
  if (names.length === 0) return 0
  const r = db.prepare(`INSERT ${o.orIgnore ? 'OR IGNORE ' : ''}INTO main.${q(table)} (${names.map(q).join(', ')}) SELECT ${exprs.join(', ')} FROM pk.${q(table)} AS s${o.where ? ` WHERE ${o.where}` : ''}`).run()
  return Number(r.changes)
}

function attach(db: any, file: string): void {
  db.prepare('ATTACH DATABASE ? AS pk').run(file)
}
function detach(db: any): void {
  try { db.exec('DETACH DATABASE pk') } catch { /* 没附加上 */ }
}

/** 从包里取出「要导入的试卷」：非示例、id 合法；合并时再去掉本机已有的 */
function fillImportSets(db: any, mode: 'merge' | 'overwrite'): { total: number; fresh: number; samples: number } {
  db.exec('DROP TABLE IF EXISTS temp.imp_papers; DROP TABLE IF EXISTS temp.imp_q; DROP TABLE IF EXISTS temp.kpmap')
  db.exec('CREATE TEMP TABLE imp_papers (id TEXT PRIMARY KEY)')
  db.exec('CREATE TEMP TABLE imp_q (id TEXT PRIMARY KEY)')
  const hasSample = colsOf(db, 'pk', 'papers').includes('is_sample')
  const total = count(db, 'SELECT COUNT(*) c FROM pk.papers')
  const samples = hasSample ? count(db, 'SELECT COUNT(*) c FROM pk.papers WHERE is_sample = 1') : 0
  db.exec(`INSERT INTO temp.imp_papers SELECT s.id FROM pk.papers s WHERE ${hasSample ? 's.is_sample = 0 AND ' : ''}${mode === 'merge' ? 's.id NOT IN (SELECT id FROM main.papers)' : '1'}`)
  db.exec('INSERT INTO temp.imp_q SELECT s.id FROM pk.questions s WHERE s.paper_id IN (SELECT id FROM temp.imp_papers)')
  return { total, fresh: count(db, 'SELECT COUNT(*) c FROM temp.imp_papers'), samples }
}

/** 数据包里的知识点并进本机的树。返回（旧代码 → 新代码）的映射和新增 / 改号的个数 */
function mergeKps(db: any): { map: Map<string, string>; added: number; remapped: number } {
  const dst = new Map((db.prepare('SELECT * FROM main.kps').all() as any[]).map(k => [k.code, k]))
  const src = db.prepare('SELECT * FROM pk.kps ORDER BY level, sort, code').all() as any[]
  const taken = new Set<string>([...dst.keys(), ...src.map(k => k.code)])
  const map = new Map<string, string>()
  const resolved = (c: string | null) => (c == null || c === '' ? null : map.get(c) ?? c)
  const ins = db.prepare(`INSERT INTO main.kps (code, parent_code, name, level, intro_grade, sort, deprecated, merged_into, note, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const placed = new Set<string>(dst.keys())
  let added = 0, remapped = 0
  const pending: Array<{ k: any; code: string }> = []
  for (const k of src) {
    const d = dst.get(k.code)
    const parent = resolved(k.parent_code)
    if (d) {
      // 本机的内置节点同代码的一律当同一个节点（不看包里的名字和标志）；自建节点要名字和上级都一致才算同一个
      const same = d.builtin === 1 || (d.name === k.name && (d.parent_code ?? null) === (parent ?? null))
      if (same) continue
      // 同一个代码、含义不同（两台电脑各自新建了节点，编号撞了）：给包里的这个换一个新代码，题目标注也跟着换
      const prefix = parent ?? 'U'
      let n = 1
      while (taken.has(`${prefix}.U${n}`)) n++
      const code = `${prefix}.U${n}`
      taken.add(code)
      map.set(k.code, code)
      remapped++
      pending.push({ k, code })
    } else {
      pending.push({ k, code: k.code })
    }
  }
  // 层级按「合并之后实际挂到的上级」重新算，不信包里的 level：本机内置节点同代码时按本机的为准，
  // 包里的子节点跟着挂过去，层级就可能和包里记的不一样；超过 3 层的整批拒绝，不留下半棵树。
  const levelOf = new Map<string, number>([...dst.entries()].map(([c, d]) => [c, d.level as number]))
  for (const { k, code } of pending) {
    const parent = resolved(k.parent_code)
    const mergedInto = k.merged_into ? resolved(k.merged_into) : null
    let level = 1
    if (parent) {
      const pl = levelOf.get(parent)
      if (pl == null) throw new PackError('bad_content', `数据包里的知识点「${k.name}」的上级找不到，已拒绝导入`)
      level = pl + 1
    }
    if (level > 3) throw new PackError('bad_content', `数据包里的知识点「${k.name}」合并之后会超过 3 层，已拒绝导入`)
    ins.run(code, parent, k.name, level, k.intro_grade ?? null, k.sort ?? 0,
      k.deprecated ? 1 : 0, mergedInto && (placed.has(mergedInto) || pending.some(p => p.code === mergedInto)) ? mergedInto : null, k.note ?? null, 0)   // 包里新出现的节点一律当自建（builtin = 0）：不信任包里的内置标志，否则一个节点被标成内置就删不掉、移不动了
    placed.add(code)
    levelOf.set(code, level)
    added++
  }
  return { map, added, remapped }
}

/** 数据包里不是「干净状态」的试卷（导出时还在提取 / 解析）：和重启恢复一样处理，免得队列里出现不存在的任务 */
function normalizeImported(db: any): void {
  db.exec(`
    UPDATE main.papers SET status = 'failed', error = '数据包里这份试卷导出时还没有处理完，请点「重试」重新提取', error_stage = 'extract'
      WHERE id IN (SELECT id FROM temp.imp_papers) AND status IN ('imported', 'extracting');
    UPDATE main.papers SET status = CASE WHEN EXISTS (SELECT 1 FROM main.questions q WHERE q.paper_id = papers.id) THEN 'reviewing' ELSE 'extracted' END, parse_stage = NULL
      WHERE id IN (SELECT id FROM temp.imp_papers) AND status = 'parsing';
    UPDATE main.parse_runs SET status = 'interrupted' WHERE paper_id IN (SELECT id FROM temp.imp_papers) AND status IN ('running', 'ai_done');
    UPDATE main.papers SET status = 'failed', error = '数据包里这份试卷的状态无法识别，请点「重试」重新提取', error_stage = 'extract'
      WHERE id IN (SELECT id FROM temp.imp_papers) AND status NOT IN ('imported','extracting','extracted','parsing','reviewing','done','failed');
  `)
}

/** 设置：本机已经有的不覆盖（覆盖导入也一样）；本机没有的，按键逐个校验后补上，不合格的丢弃并在报告里说明 */
function importSettings(db: any, report: ImportReport): void {
  const rows = db.prepare(`SELECT key, value_json FROM pk.settings WHERE key IN (${PACK_SETTING_KEYS.map(() => '?').join(',')})`).all(...PACK_SETTING_KEYS) as any[]
  const has = db.prepare('SELECT 1 FROM main.settings WHERE key = ?')
  const ins = db.prepare('INSERT INTO main.settings (key, value_json) VALUES (?, ?)')
  for (const r of rows) {
    const c = checkPackSetting(r.key, r.value_json)
    if (c.note) report.warnings.push(c.note)
    if (!c.ok) continue
    const absent = !has.get(r.key)
    if (absent) ins.run(r.key, JSON.stringify(c.value))
    if (r.key === 'ai_prompts') {
      const n = Object.keys(c.value as Record<string, string>).length
      if (absent) report.promptsImported = n; else report.promptsKeptLocal = n
    }
  }
}

function bumpRev(db: any): void { db.exec('UPDATE main.data_rev SET rev = rev + 1 WHERE id = 1') }

function copyChildren(db: any, kpMap: Map<string, string>): { questions: number } {
  copyRows(db, 'pages', { skip: ['id'], where: 's.paper_id IN (SELECT id FROM temp.imp_papers)' })
  copyRows(db, 'paper_assets', { skip: ['id'], where: 's.paper_id IN (SELECT id FROM temp.imp_papers)' })
  const questions = copyRows(db, 'questions', { where: 's.paper_id IN (SELECT id FROM temp.imp_papers)' })
  if (kpMap.size) {
    db.exec('CREATE TEMP TABLE kpmap (old TEXT PRIMARY KEY, new TEXT NOT NULL)')
    const ins = db.prepare('INSERT INTO temp.kpmap VALUES (?, ?)')
    for (const [a, b] of kpMap) ins.run(a, b)
    // 重映射后同一道题可能出现两条相同的（题, 代码）：OR IGNORE，且先写主知识点
    db.exec(`INSERT OR IGNORE INTO main.question_kps (question_id, kp_code, is_primary)
      SELECT s.question_id, COALESCE((SELECT new FROM temp.kpmap m WHERE m.old = s.kp_code), s.kp_code), s.is_primary
      FROM pk.question_kps s WHERE s.question_id IN (SELECT id FROM temp.imp_q) ORDER BY s.is_primary DESC`)
  } else {
    copyRows(db, 'question_kps', { where: 's.question_id IN (SELECT id FROM temp.imp_q)' })
  }
  copyRows(db, 'materials', { skip: ['id'], where: 's.paper_id IN (SELECT id FROM temp.imp_papers)' })
  copyRows(db, 'parse_runs', { skip: ['id'], where: 's.paper_id IN (SELECT id FROM temp.imp_papers)' })
  return { questions }
}

function copyReports(db: any, orIgnore: boolean): number {
  // 基于示例数据筛选生成的报告不导入（示例数据不进包，包里夹带的也不要）
  const ids = (db.prepare(`SELECT id FROM pk.reports WHERE COALESCE(filter_json, '') NOT LIKE '%"sample":true%'`).all() as any[]).map(r => r.id).filter((id: unknown) => typeof id === 'string' && UUID_RE.test(id))
  let n = 0
  for (const id of ids) {
    // 「上次核对结论」属于那台电脑当时的数据修订号，带过来没有意义；置空，第一次读时会重新核对
    n += copyRows(db, 'reports', { orIgnore, where: `s.id = '${id}'`, force: { checked_rev: 'NULL', checked_sig: 'NULL', checked_json: 'NULL' } })
  }
  return n
}

/** 包里有页面图但解包后找不到的页数（只做提示，不拒绝） */
export function countMissingPageImages(db: any, stagedFilesDir: string): number {
  let missing = 0
  for (const r of db.prepare(`SELECT s.paper_id pid, s.image_rel rel FROM pk.pages s WHERE s.image_rel <> '' AND s.paper_id IN (SELECT id FROM temp.imp_papers)`).all() as any[]) {
    if (!fs.existsSync(path.join(stagedFilesDir, r.pid, r.rel))) missing++
  }
  return missing
}

export interface PackSummary {
  papersInPack: number
  questionsInPack: number
  pagesInPack: number
  /** 合并时会新增的试卷数 / 本机已有的（同一个 id） */
  papersNew: number
  papersExisting: number
  /** 新增的试卷里和本机另一份是同一个文件的 */
  sameFileAsExisting: number
  customKps: number
  samplesIgnored: number
  missingPageImages: number
  livePapers: number
}

/** 导入前给老师看的摘要（不改任何东西） */
export function summarizePack(deps: ApplyDeps, staged: Staged): PackSummary {
  const db = deps.db
  attach(db, staged.dbPath)
  try {
    const sets = fillImportSets(db, 'merge')
    const hasSample = colsOf(db, 'pk', 'papers').includes('is_sample')
    const real = hasSample ? 'WHERE is_sample = 0' : ''
    const sameFile = count(db, `SELECT COUNT(*) c FROM pk.papers s WHERE s.id IN (SELECT id FROM temp.imp_papers) AND EXISTS (SELECT 1 FROM main.papers m WHERE m.file_hash = s.file_hash)`)
    return {
      papersInPack: sets.total - sets.samples,
      questionsInPack: count(db, `SELECT COUNT(*) c FROM pk.questions WHERE paper_id IN (SELECT id FROM pk.papers ${real})`),
      pagesInPack: count(db, `SELECT COUNT(*) c FROM pk.pages WHERE paper_id IN (SELECT id FROM pk.papers ${real})`),
      papersNew: sets.fresh, papersExisting: sets.total - sets.samples - sets.fresh, sameFileAsExisting: sameFile,
      customKps: count(db, 'SELECT COUNT(*) c FROM pk.kps WHERE builtin = 0'), samplesIgnored: sets.samples,
      // 摘要里的「缺页面图」按「合并」时的新试卷算；覆盖时是全部试卷，数字只作参考
      missingPageImages: countMissingPageImages(db, staged.filesDir),
      livePapers: count(db, 'SELECT COUNT(*) c FROM main.papers WHERE is_sample = 0')
    }
  } finally {
    try { db.exec('DROP TABLE IF EXISTS temp.imp_papers; DROP TABLE IF EXISTS temp.imp_q') } catch { /* 忽略 */ }
    detach(db)
  }
}

// ───────────────────────── 合并 ─────────────────────────

export function applyMerge(deps: ApplyDeps, staged: Staged): ImportReport {
  const db = deps.db
  const report: ImportReport = { mode: 'merge', papersAdded: 0, papersSkipped: 0, sameFileAsExisting: 0, questionsAdded: 0, kpsAdded: 0, kpsRemapped: 0, reportsAdded: 0, missingPageImages: 0, promptsImported: 0, promptsKeptLocal: 0, warnings: [] }
  attach(db, staged.dbPath)
  const moved: Array<{ from: string; to: string }> = []
  let inTx = false
  try {
    db.exec('BEGIN IMMEDIATE'); inTx = true
    const sets = fillImportSets(db, 'merge')
    report.papersSkipped = sets.total - sets.samples - sets.fresh
    if (sets.samples) report.warnings.push(`数据包里有 ${sets.samples} 份示例试卷，已忽略（示例数据不参与导入）`)
    // 新增的题目 id 不能和本机已有的撞（不同试卷下的同一个题目 id 只可能是恶意构造的）
    const clash = count(db, 'SELECT COUNT(*) c FROM temp.imp_q WHERE id IN (SELECT id FROM main.questions)')
    if (clash) throw new PackError('bad_content', '数据包里有题目的编号和本机已有的题目撞了，已拒绝导入')

    const kp = mergeKps(db)
    report.kpsAdded = kp.added; report.kpsRemapped = kp.remapped
    copyRows(db, 'qtypes', { orIgnore: true })
    importSettings(db, report)

    const hadHash = new Set((db.prepare('SELECT DISTINCT file_hash h FROM main.papers').all() as any[]).map(r => r.h))
    const newHashRows = db.prepare('SELECT s.id id, s.file_hash h FROM pk.papers s WHERE s.id IN (SELECT id FROM temp.imp_papers)').all() as any[]
    report.sameFileAsExisting = newHashRows.filter(r => hadHash.has(r.h)).length
    report.papersAdded = copyRows(db, 'papers', {
      where: 's.id IN (SELECT id FROM temp.imp_papers)',
      force: { is_sample: '0', duplicate_of: `CASE WHEN s.duplicate_of IS NOT NULL AND (s.duplicate_of IN (SELECT id FROM main.papers) OR s.duplicate_of IN (SELECT id FROM temp.imp_papers)) THEN s.duplicate_of ELSE NULL END` }
    })
    // 和本机另一份是同一个文件（但不是同一条记录）：标出「重复于」，统计时只算一份
    db.exec(`UPDATE main.papers SET duplicate_of = (SELECT o.id FROM main.papers o WHERE o.file_hash = papers.file_hash AND o.id NOT IN (SELECT id FROM temp.imp_papers) ORDER BY o.created_at, o.rowid LIMIT 1)
      WHERE id IN (SELECT id FROM temp.imp_papers) AND duplicate_of IS NULL AND EXISTS (SELECT 1 FROM main.papers o WHERE o.file_hash = papers.file_hash AND o.id NOT IN (SELECT id FROM temp.imp_papers))`)
    const ch = copyChildren(db, kp.map)
    report.questionsAdded = ch.questions
    report.reportsAdded = copyReports(db, true)
    normalizeImported(db)
    bumpRev(db)
    report.missingPageImages = countMissingPageImages(db, staged.filesDir)
    if (report.missingPageImages) report.warnings.push(`有 ${report.missingPageImages} 页的页面图在数据包里找不到，对应的截图会显示为空`)
    if (deps.fault === 'after-db') throw new Error('测试注入的故障：写库之后')

    // 文件：只搬新增试卷的目录
    const newIds = (db.prepare('SELECT id FROM temp.imp_papers').all() as any[]).map(r => r.id as string)
    fs.mkdirSync(deps.filesDir, { recursive: true })
    for (const id of newIds) {
      const from = path.join(staged.filesDir, id)
      if (!fs.existsSync(from)) continue
      const to = path.join(deps.filesDir, id)
      if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })   // 库里没有这份试卷，所以这个目录只是遗留的垃圾
      renameRetry(from, to)
      moved.push({ from, to })
    }
    if (deps.fault === 'after-swap') throw new Error('测试注入的故障：改名之后')
    db.exec('COMMIT'); inTx = false
    return report
  } catch (e) {
    if (inTx) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } }
    for (const m of moved.reverse()) { try { renameRetry(m.to, m.from) } catch { /* 尽力而为 */ } }
    if (e instanceof PackError) throw e
    throw new PackError('apply_failed', `导入失败，已全部撤销，现有数据没有变化：${(e as Error).message}`)
  } finally {
    try { db.exec('DROP TABLE IF EXISTS temp.imp_papers; DROP TABLE IF EXISTS temp.imp_q; DROP TABLE IF EXISTS temp.kpmap; DROP TABLE IF EXISTS temp.local_builtin') } catch { /* 忽略 */ }
    detach(db)
  }
}

// ───────────────────────── 覆盖 ─────────────────────────

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`

export function backupsRoot(dataDir: string): string { return path.join(dataDir, 'backups') }

/** 只保留最新的 keep 份导入前备份 */
export function pruneBackups(dataDir: string, keep = 2): void {
  const root = backupsRoot(dataDir)
  try {
    const names = fs.readdirSync(root).filter(n => /^pre-import-\d{8}-\d{6}(-[0-9a-f]{4})?$/.test(n)).sort()
    for (const n of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(root, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch { /* 没有备份目录 */ }
}

export function listBackups(dataDir: string): Array<{ name: string; dir: string; createdAt: string }> {
  const root = backupsRoot(dataDir)
  try {
    return fs.readdirSync(root).filter(n => /^pre-import-\d{8}-\d{6}(-[0-9a-f]{4})?$/.test(n)).sort().reverse().map(n => ({ name: n, dir: path.join(root, n), createdAt: fs.statSync(path.join(root, n)).mtime.toISOString() }))
  } catch { return [] }
}

export function applyOverwrite(deps: ApplyDeps, staged: Staged): ImportReport {
  const db = deps.db
  const report: ImportReport = { mode: 'overwrite', papersAdded: 0, papersSkipped: 0, sameFileAsExisting: 0, questionsAdded: 0, kpsAdded: 0, kpsRemapped: 0, reportsAdded: 0, missingPageImages: 0, promptsImported: 0, promptsKeptLocal: 0, warnings: [] }
  const now = (deps.now ?? (() => new Date()))()
  const importId = crypto.randomUUID()
  const backupDir = path.join(backupsRoot(deps.dataDir), `pre-import-${stamp(now)}-${importId.slice(0, 4)}`)
  const backupDb = path.join(backupDir, 'db.sqlite')
  const backupFiles = path.join(backupDir, 'files')

  // 0. 先备份当前的库（VACUUM INTO 是一致的快照）。备份失败就不继续——没有退路的覆盖不做
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    db.prepare('VACUUM INTO ?').run(backupDb)
  } catch (e) {
    try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    throw new PackError('apply_failed', `导入前的备份没能完成，已取消导入（现有数据没有变化）：${(e as Error).message}`)
  }

  attach(db, staged.dbPath)
  let inTx = false
  let swapped = false
  let committed = false   // COMMIT 成功之后一切都以「已导入」为准：之后的清理失败只记提示，绝不回滚 / 换回文件目录
  const journal: ImportJournal = { id: importId, filesDir: deps.filesDir, backupFilesDir: backupFiles, startedAt: now.toISOString() }
  try {
    db.exec('BEGIN IMMEDIATE'); inTx = true
    const sets = fillImportSets(db, 'overwrite')
    if (sets.samples) report.warnings.push(`数据包里有 ${sets.samples} 份示例试卷，已忽略（示例数据不参与导入）`)

    // 清空现有数据（papers 的外键级联带走页面、题目、标注、材料、解析记录）
    // 知识点树：包里必须带着本机所有的内置节点（缺了说明包是空的 / 残缺的），否则整批回滚；包里的 builtin 标志不信，只认本机的内置代码
    db.exec('CREATE TEMP TABLE local_builtin (code TEXT PRIMARY KEY)')
    db.exec('INSERT INTO temp.local_builtin SELECT code FROM main.kps WHERE builtin = 1')
    const lacking = count(db, 'SELECT COUNT(*) c FROM temp.local_builtin WHERE code NOT IN (SELECT code FROM pk.kps)')
    if (lacking > 0) throw new PackError('bad_content', `数据包里的知识点树缺少 ${lacking} 个内置节点（数据包不完整或被改过），为了不丢掉本机的知识点树，已拒绝覆盖导入`)
    db.exec(`DELETE FROM main.papers; DELETE FROM main.reports; DELETE FROM main.ai_analyses; DELETE FROM main.ai_usage; DELETE FROM main.kps; DELETE FROM main.qtypes;`)

    report.kpsAdded = copyRows(db, 'kps', { force: { builtin: 'CASE WHEN s.code IN (SELECT code FROM temp.local_builtin) THEN 1 ELSE 0 END' } })
    copyRows(db, 'qtypes')
    report.papersAdded = copyRows(db, 'papers', { where: 's.id IN (SELECT id FROM temp.imp_papers)', force: { is_sample: '0' } })
    const ch = copyChildren(db, new Map())
    report.questionsAdded = ch.questions
    copyRows(db, 'ai_usage', { skip: ['id'] })
    report.reportsAdded = copyReports(db, false)
    copyRows(db, 'ai_analyses', { where: `COALESCE(s.scope_json, '') NOT LIKE '%"sample":true%'`, force: { checked_rev: 'NULL', checked_sig: 'NULL', checked_json: 'NULL' } })
    importSettings(db, report)
    normalizeImported(db)
    db.prepare('INSERT OR REPLACE INTO main.settings (key, value_json) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify(importId))
    bumpRev(db)

    // 自检：写进去的数量要和数据包里的一致
    if (count(db, 'SELECT COUNT(*) c FROM main.papers') !== sets.fresh) throw new Error('导入后的试卷数和数据包里的不一致')
    if (count(db, 'SELECT COUNT(*) c FROM main.questions') !== count(db, 'SELECT COUNT(*) c FROM temp.imp_q')) throw new Error('导入后的题目数和数据包里的不一致')
    const fkBad = (db.prepare('PRAGMA foreign_key_check').all() as any[]).length
    if (fkBad) throw new Error('导入后的数据有引用不存在记录的情况')
    report.missingPageImages = countMissingPageImages(db, staged.filesDir)
    if (report.missingPageImages) report.warnings.push(`有 ${report.missingPageImages} 页的页面图在数据包里找不到，对应的截图会显示为空`)
    if (deps.fault === 'after-db') throw new Error('测试注入的故障：写库之后')

    // 文件：先把「数据包里没有对应试卷」的目录删掉，再整体换目录
    const keep = new Set((db.prepare('SELECT id FROM temp.imp_papers').all() as any[]).map(r => r.id as string))
    fs.mkdirSync(staged.filesDir, { recursive: true })
    for (const n of fs.readdirSync(staged.filesDir)) if (!keep.has(n)) fs.rmSync(path.join(staged.filesDir, n), { recursive: true, force: true })
    writeJournal(deps.dataDir, journal)
    fs.mkdirSync(deps.filesDir, { recursive: true })
    renameRetry(deps.filesDir, backupFiles)
    swapped = true
    renameRetry(staged.filesDir, deps.filesDir)
    if (deps.fault === 'after-swap') throw new Error('测试注入的故障：换目录之后')
    db.exec('COMMIT'); inTx = false
    committed = true
    // ── 提交点之后：只做清理，每一步各自兜住，失败只在报告里提示 ──
    report.backup = { dir: backupDir, dbFile: backupDb, filesDir: backupFiles, bytes: 0 }
    try {
      if (deps.fault === 'cleanup-fail') throw new Error('测试注入的故障：提交之后的清理')
      clearJournal(deps.dataDir)
    } catch (e2) {
      report.warnings.push(`导入已经完成，但清理导入记录时出错（${(e2 as Error).message}）。数据没有问题；这条记录会在下次启动时自动清理`)
    }
    try { report.backup.bytes = dirBytes(backupDir) } catch { /* 只是显示用 */ }
    try { pruneBackups(deps.dataDir, 2) } catch { /* 旧备份留着也无妨 */ }
    return report
  } catch (e) {
    if (committed) return report   // 保险：理论上提交之后不会走到这里
    if (inTx) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } }
    let undo = ''
    let reverted = true
    if (swapped) {
      try { undo = revertSwap(journal, staged.filesDir) } catch (e2) { reverted = false; undo = `（把目录换回去时出错：${(e2 as Error).message}，旧数据保存在 ${backupDir}）` }
    }
    try { clearJournal(deps.dataDir) } catch { /* 忽略 */ }
    try { fs.mkdirSync(deps.filesDir, { recursive: true }) } catch { /* 忽略 */ }
    // 已经全部撤销：这份备份没用了，别留着占磁盘（撤销没成功的话要留着）
    if (reverted) { try { fs.rmSync(backupDir, { recursive: true, force: true }); fs.rmdirSync(backupsRoot(deps.dataDir)) } catch { /* 忽略（backups 里还有别的备份时 rmdir 会失败，正好） */ } }
    if (e instanceof PackError) throw e
    throw new PackError('apply_failed', `导入失败，已全部撤销，现有数据没有变化：${(e as Error).message}${undo ? `。${undo}` : ''}`)
  } finally {
    try { db.exec('DROP TABLE IF EXISTS temp.imp_papers; DROP TABLE IF EXISTS temp.imp_q; DROP TABLE IF EXISTS temp.kpmap; DROP TABLE IF EXISTS temp.local_builtin') } catch { /* 忽略 */ }
    detach(db)
  }
}

function dirBytes(dir: string): number {
  let n = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) n += dirBytes(p)
      else if (ent.isFile()) n += fs.statSync(p).size
    }
  } catch { /* 目录不存在 */ }
  return n
}
