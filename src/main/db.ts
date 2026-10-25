import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { buildKpRows, QTYPE_SEEDS_V1 } from './seed/taxonomy'

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
  },

  // v3 → v4：状态流加入 extracted；警告与错误分列；重复导入标记；OCR 失败原因；docx 附件表
  (db) => {
    const paperCols = db.prepare("PRAGMA table_info(papers)").all().map((c: any) => c.name)
    if (!paperCols.includes('warning')) db.exec('ALTER TABLE papers ADD COLUMN warning TEXT')
    if (!paperCols.includes('duplicate_of')) db.exec('ALTER TABLE papers ADD COLUMN duplicate_of TEXT')
    const pageCols = db.prepare("PRAGMA table_info(pages)").all().map((c: any) => c.name)
    if (!pageCols.includes('ocr_error')) db.exec('ALTER TABLE pages ADD COLUMN ocr_error TEXT')
    if (!pageCols.includes('text_layer_chars')) db.exec('ALTER TABLE pages ADD COLUMN text_layer_chars INTEGER')

    // M1 里所有 done 都只代表「提取完成」，映射无歧义；原先挂在 error 上的警告挪到 warning
    db.exec(`
      UPDATE papers SET warning = error, error = NULL WHERE status = 'done' AND error IS NOT NULL;
      UPDATE papers SET status = 'extracted' WHERE status = 'done';
      UPDATE pages SET text_source = 'ocr' WHERE text_source = 'pdf-text+ocr';

      CREATE TABLE IF NOT EXISTS paper_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        page_idx INTEGER NOT NULL DEFAULT 1,
        seq INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_assets_paper ON paper_assets(paper_id);
    `)
  },

  // v4 → v5（M2）：AI 解析。题目表补列、材料/解析记录/用量表、知识点树与题型种子。
  // 全部是增量操作（只加列、加表、INSERT OR IGNORE），已有数据原样保留。
  // 不重建 questions：question_kps 对它有外键级联，DROP 会连带清空标注。
  (db) => {
    const addCol = (table: string, col: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name)
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
    addCol('papers', 'prompt_version', 'TEXT')
    addCol('papers', 'ai_meta_json', 'TEXT')   // AI 预填过的字段名数组（界面标「AI 猜测」）
    addCol('papers', 'parse_stage', 'TEXT')
    addCol('papers', 'error_stage', 'TEXT')    // failed 时是哪个阶段失败：extract / parse
    addCol('papers', 'parsed_at', 'TEXT')

    addCol('kps', 'note', 'TEXT')
    addCol('kps', 'builtin', 'INTEGER NOT NULL DEFAULT 0')
    addCol('qtypes', 'note', 'TEXT')
    addCol('qtypes', 'sort', 'INTEGER NOT NULL DEFAULT 0')
    addCol('qtypes', 'builtin', 'INTEGER NOT NULL DEFAULT 0')

    // 旧 questions.no 是 INTEGER 亲和性，装不下 "21(1)"、"~1" 这类题号，新增 no_label 作为权威题号
    addCol('questions', 'ord', 'INTEGER NOT NULL DEFAULT 0')
    addCol('questions', 'no_label', 'TEXT')
    addCol('questions', 'section_title', 'TEXT')
    addCol('questions', 'material_id', 'TEXT')
    addCol('questions', 'bbox_source', 'TEXT')           // text-anchor / vision / manual / none
    addCol('questions', 'anchor_ref', 'TEXT')
    addCol('questions', 'kp_suggestion_status', 'TEXT')  // pending / approved / rejected
    addCol('questions', 'flags_json', "TEXT NOT NULL DEFAULT '[]'")
    addCol('questions', 'edited', 'INTEGER NOT NULL DEFAULT 0')

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_questions_paper_ord ON questions(paper_id, ord);

      CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        mid TEXT NOT NULL,
        section TEXT,
        kind TEXT,
        text TEXT NOT NULL DEFAULT '',
        page_idx INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_materials_paper ON materials(paper_id);

      CREATE TABLE IF NOT EXISTS parse_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        prompt_version TEXT,
        model TEXT,
        vision_model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        result_json TEXT,
        usage_json TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_parse_runs_paper ON parse_runs(paper_id);

      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT,
        kind TEXT NOT NULL,
        model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `)

    // 种子：INSERT OR IGNORE，重复执行或用户已改过同代码节点都不会被覆盖
    const insKp = db.prepare(`
      INSERT OR IGNORE INTO kps (code, parent_code, name, level, intro_grade, sort, deprecated, merged_into, note, builtin)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, 1)
    `)
    for (const r of buildKpRows()) insKp.run(r.code, r.parent_code, r.name, r.level, r.intro_grade, r.sort, r.note)
    const insQt = db.prepare(`INSERT OR IGNORE INTO qtypes (code, name, "group", note, sort, builtin) VALUES (?, ?, ?, ?, ?, 1)`)
    QTYPE_SEEDS_V1.forEach(([code, name, group, note], i) => insQt.run(code, name, group, note, (i + 1) * 10))
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
