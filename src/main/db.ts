import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

const MIGRATIONS: Array<(db: any) => void> = [
  // v0 → v1: 初始 schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        grade TEXT,
        semester TEXT,
        school_year_start INTEGER,
        exam_type TEXT,
        textbook TEXT,
        region TEXT,
        school TEXT,
        total_score INTEGER,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'imported',
        error TEXT,
        page_count INTEGER NOT NULL DEFAULT 0,
        ai_model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        image_rel TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        text_source TEXT NOT NULL DEFAULT 'ocr',
        lines_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        no INTEGER,
        section TEXT,
        qtype TEXT,
        stem TEXT,
        options TEXT,
        answer TEXT,
        score REAL,
        difficulty INTEGER,
        error_prone INTEGER DEFAULT 0,
        error_reason TEXT,
        page_idx INTEGER,
        bbox_json TEXT,
        anchor TEXT,
        confidence REAL,
        reviewed INTEGER DEFAULT 0,
        kp_suggestion TEXT
      );

      CREATE TABLE IF NOT EXISTS question_kps (
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        kp_code TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (question_id, kp_code)
      );

      CREATE TABLE IF NOT EXISTS kps (
        code TEXT PRIMARY KEY,
        parent_code TEXT,
        name TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        intro_grade INTEGER,
        sort INTEGER NOT NULL DEFAULT 0,
        deprecated INTEGER NOT NULL DEFAULT 0,
        merged_into TEXT
      );

      CREATE TABLE IF NOT EXISTS qtypes (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        "group" TEXT NOT NULL DEFAULT 'written'
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        filter_json TEXT,
        markdown TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pages_paper ON pages(paper_id);
      CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
      CREATE INDEX IF NOT EXISTS idx_papers_hash ON papers(file_hash);
      CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);
    `)
  },

  // v1 → v2: 为 v1 已有的 pages 表添加 text 和 ocr_conf 列
  (db) => {
    const cols = db.prepare("PRAGMA table_info(pages)").all()
    const colNames = cols.map((c: any) => c.name)
    if (!colNames.includes('text')) {
      db.exec('ALTER TABLE pages ADD COLUMN text TEXT')
    }
    if (!colNames.includes('ocr_conf')) {
      db.exec('ALTER TABLE pages ADD COLUMN ocr_conf REAL')
    }
  },

  // v2 → v3: 记录提取完成时间（M2 据此区分「已提取」与「已解析」）
  (db) => {
    const cols = db.prepare("PRAGMA table_info(papers)").all().map((c: any) => c.name)
    if (!cols.includes('extracted_at')) {
      db.exec('ALTER TABLE papers ADD COLUMN extracted_at TEXT')
    }
  }
]

let db: any = null

export function getDataDir(): string {
  const base = app.getPath('userData')
  return path.join(base, 'workbench-data')
}

export function getFilesDir(): string {
  return path.join(getDataDir(), 'files')
}

function getDbPath(): string {
  return path.join(getDataDir(), 'db.sqlite')
}

export function getDb(): any {
  if (!db) throw new Error('数据库未初始化')
  return db
}

export async function initDatabase(): Promise<void> {
  const dataDir = getDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(getFilesDir(), { recursive: true })

  const dbPath = getDbPath()
  let DatabaseClass: any

  try {
    const sqliteModule = require('node:sqlite')
    DatabaseClass = sqliteModule.DatabaseSync
    console.log('[db] 使用 node:sqlite')
  } catch {
    throw new Error('node:sqlite 不可用，请确认 Electron/Node 版本支持')
  }

  db = new DatabaseClass(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('PRAGMA busy_timeout=5000')

  const currentVersion = (() => {
    try {
      const row = db.prepare('PRAGMA user_version').get()
      return row?.user_version ?? 0
    } catch {
      return 0
    }
  })()

  const targetVersion = MIGRATIONS.length

  if (currentVersion > targetVersion) {
    db.close()
    db = null
    throw new Error(
      `数据库版本 (${currentVersion}) 高于程序版本 (${targetVersion})，请升级应用`
    )
  }

  for (let v = currentVersion; v < targetVersion; v++) {
    console.log(`[db] 执行迁移 v${v} → v${v + 1}`)
    db.exec('BEGIN')
    try {
      MIGRATIONS[v](db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 v${v}→v${v + 1} 失败: ${(e as Error).message}`)
    }
  }

  if (currentVersion < targetVersion) {
    console.log(`[db] schema 已升级到 v${targetVersion}`)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
