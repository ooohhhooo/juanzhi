/**
 * 数据包里的数据库一律不信任：它被当作一个「会被我们按列读取的数据来源」，绝不整库替换进来。
 * 暂存阶段（在暂存目录里的那份副本上做，不碰正在用的库）：
 *  1. PRAGMA integrity_check 必须是 ok（损坏的库拒绝）；
 *  2. 版本检查：比本程序新的拒绝并提示升级；旧的在这份副本上跑本程序的迁移升到最新（所以后面读到的列和现在一致）；
 *  3. 删掉副本里所有触发器和视图——它们是可执行对象，哪怕只是在副本上跑迁移 / 读取，也不让它们有机会执行；
 *  4. 内容校验：必需的表和列都在；试卷 id、题目 id 必须是 UUID（它们会被拼进文件路径、传给 IPC）；
 *     页面图 / 附件的相对路径必须是固定格式（它们会被拼进文件路径）；外键完整。
 * 纯函数模块：数据库类通过 openDb 参数传入，迁移通过 migrate 参数传入，单测直接加载。
 */
import { PackError } from './errors.ts'
import { validateKpRows } from './kp-rules.ts'
import { UUID_RE } from './names.ts'

export type OpenDb = (file: string, opts?: { readOnly?: boolean }) => any

/** 副本里必须有的表和列（最新结构的子集：这些是导入要读的） */
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  papers: ['id', 'title', 'file_name', 'file_hash', 'status', 'created_at'],
  pages: ['paper_id', 'idx', 'image_rel'],
  paper_assets: ['paper_id', 'rel_path'],
  questions: ['id', 'paper_id', 'ord'],
  question_kps: ['question_id', 'kp_code', 'is_primary'],
  materials: ['paper_id', 'mid'],
  parse_runs: ['paper_id', 'status'],
  kps: ['code', 'parent_code', 'name', 'level'],
  qtypes: ['code', 'name'],
  settings: ['key', 'value_json']
}

export const PAGE_REL_RE = /^page-\d{1,4}\.png$/
export const ASSET_REL_RE = /^media\/\d{1,4}\.(?:png|jpg|gif)$/

export const MAX_PAPERS = 100_000
export const MAX_QUESTIONS = 5_000_000

export interface StagedInfo {
  /** 包里数据库原来的版本 */
  originalVersion: number
  migrated: boolean
  papers: number
  questions: number
  pages: number
  samplePapers: number
}

export function userVersionOf(db: any): number {
  return (db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0
}

/** 对暂存目录里的 db.sqlite 做上面的 1–4 步，原地修改。成功返回统计；任何问题抛 PackError */
export function prepareStagedDb(dbPath: string, deps: { openDb: OpenDb; migrate: (db: any, from: number) => void; latest: number }): StagedInfo {
  let db: any
  try {
    db = deps.openDb(dbPath)
  } catch {
    throw new PackError('corrupt_db', '数据包里的数据库打不开，数据包可能已损坏')
  }
  try {
    // 1. 完整性
    let rows: any[]
    try {
      db.exec('PRAGMA trusted_schema = OFF')
      rows = db.prepare('PRAGMA integrity_check').all()
    } catch {
      throw new PackError('corrupt_db', '数据包里的数据库已损坏（无法读取），已拒绝导入')
    }
    const msgs = rows.map(r => String(Object.values(r)[0]))
    if (msgs.length !== 1 || msgs[0] !== 'ok') {
      throw new PackError('corrupt_db', `数据包里的数据库没有通过完整性检查（${msgs.slice(0, 2).join('；').slice(0, 120)}），已拒绝导入`)
    }
    // 2. 版本
    const ver = userVersionOf(db)
    if (ver < 1) throw new PackError('bad_format', '数据包里的数据库不是本软件的数据库（没有版本号），已拒绝导入')
    if (ver > deps.latest) {
      throw new PackError('too_new', `这个数据包来自更新版本的软件（数据库版本 v${ver}，当前软件只支持到 v${deps.latest}）。请先把本软件升级到最新版，再导入`)
    }
    // 3. 删除可执行对象（触发器、视图）
    db.exec('PRAGMA journal_mode = DELETE')
    for (const o of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view')").all() as any[]) {
      db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${String(o.name).replace(/"/g, '""')}"`)
    }
    // 4a. 旧版本：在这份副本上升到最新
    if (ver < deps.latest) deps.migrate(db, ver)
    // 迁移也可能创建触发器（本程序自己的），副本只用来读数据，一并删掉
    for (const o of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view')").all() as any[]) {
      db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${String(o.name).replace(/"/g, '""')}"`)
    }
    // 4b. 必需的表和列
    for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) {
      const have = (db.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map(c => c.name)
      if (have.length === 0) throw new PackError('bad_content', `数据包里的数据库缺少表「${t}」，数据包不完整`)
      const miss = cols.filter(c => !have.includes(c))
      if (miss.length) throw new PackError('bad_content', `数据包里的数据库「${t}」表缺少列：${miss.join('、')}`)
    }
    // 4c. 内容校验
    const count = (sql: string) => (db.prepare(sql).get() as any).c as number
    const papers = count('SELECT COUNT(*) c FROM papers')
    const questions = count('SELECT COUNT(*) c FROM questions')
    if (papers > MAX_PAPERS || questions > MAX_QUESTIONS) throw new PackError('too_big', '数据包里的试卷或题目数量超出上限，已拒绝导入')
    for (const r of db.prepare('SELECT id FROM papers').all() as any[]) {
      if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) throw new PackError('bad_content', '数据包里有试卷的编号格式不对（不是 UUID），已拒绝导入')
    }
    for (const r of db.prepare('SELECT id FROM questions').all() as any[]) {
      if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) throw new PackError('bad_content', '数据包里有题目的编号格式不对（不是 UUID），已拒绝导入')
    }
    for (const r of db.prepare("SELECT DISTINCT image_rel v FROM pages WHERE image_rel IS NOT NULL AND image_rel <> ''").all() as any[]) {
      if (!PAGE_REL_RE.test(String(r.v))) throw new PackError('bad_content', '数据包里有页面图的路径格式不对，已拒绝导入')
    }
    for (const r of db.prepare('SELECT DISTINCT rel_path v FROM paper_assets').all() as any[]) {
      if (!ASSET_REL_RE.test(String(r.v))) throw new PackError('bad_content', '数据包里有附件图的路径格式不对，已拒绝导入')
    }
    validateKpRows(db.prepare('SELECT code, parent_code, name, level, intro_grade, note FROM kps').all() as any[])
    const fk = db.prepare('PRAGMA foreign_key_check').all() as any[]
    if (fk.length) throw new PackError('bad_content', `数据包里的数据有 ${fk.length} 处引用不存在的记录（例如题目指向不存在的试卷），已拒绝导入`)
    const pages = count('SELECT COUNT(*) c FROM pages')
    const cols = (db.prepare('PRAGMA table_info("papers")').all() as any[]).map(c => c.name)
    const samplePapers = cols.includes('is_sample') ? count('SELECT COUNT(*) c FROM papers WHERE is_sample = 1') : 0
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { originalVersion: ver, migrated: ver < deps.latest, papers, questions, pages, samplePapers }
  } catch (e) {
    if (e instanceof PackError) throw e
    throw new PackError('corrupt_db', `数据包里的数据库无法读取或升级（${(e as Error).message.slice(0, 120)}），已拒绝导入`)
  } finally {
    try { db.close() } catch { /* 已关闭 */ }
  }
}
