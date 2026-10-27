import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { buildKpRows, QTYPE_SEEDS_V1 } from './seed/taxonomy'
import { KP_PLAIN } from './seed/kp-plain'
import { backupBeforeUpgrade, dbHasData, restoreBackup } from './db-backup'
import { repairKpNames } from './db-repair'
import { configuredDataDir, defaultDataDir } from './datadir'
import { recoverImportJournalDetailed, startupNoticeOf } from './pack/journal'
import type { StartupNotice } from './pack/journal'

/**
 * 迁移 v10 用的「把挤进下一题题号的框缩回去」：这里冻结一份当时的算法（和 shared/crop.ts 的 repairNeighborEdges 当时一致）。
 * 迁移不能依赖以后还会改的函数——有人改了 crop.ts，还没升级的库在 v10 里的行为就变了。
 */
function repairNeighborEdgesV10(rows: Array<{ id: string; page: number; bbox: number[] | null; source?: string | null }>): Array<{ id: string; bbox: number[] }> {
  const SEAM = 0.008
  const out: Array<{ id: string; bbox: number[] }> = []
  const byPage = new Map<number, typeof rows>()
  for (const r of rows) if (r.bbox && r.bbox.length === 4 && r.bbox[2] > 0 && r.bbox[3] > 0) {
    if (!byPage.has(r.page)) byPage.set(r.page, [])
    byPage.get(r.page)!.push(r)
  }
  for (const list of byPage.values()) {
    for (const a of list) {
      if (a.source === 'manual') continue
      const [ax, ay, aw, ah] = a.bbox as number[]
      let right = ax + aw
      for (const b of list) {
        if (b === a) continue
        const [bx, by, , bh] = b.bbox as number[]
        const overlap = Math.min(ay + ah, by + bh) - Math.max(ay, by)
        if (overlap < Math.min(ah, bh) * 0.5) continue
        if (bx <= ax + 0.02 || bx >= right + 0.02) continue
        right = Math.min(right, bx - SEAM)
      }
      if (right < ax + aw - 1e-6 && right > ax + 0.02) out.push({ id: a.id, bbox: [ax, ay, Math.round((right - ax) * 1000) / 1000, ah] })
    }
  }
  return out
}

export const MIGRATIONS: Array<(db: any) => void> = [
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
  },

  // v5 → v6（M3）：分析看板。统计按知识点/学年聚合需要的索引；P2 同比分析的结果缓存表。只加索引、加表，不动已有数据。
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_question_kps_kp ON question_kps(kp_code);
      CREATE INDEX IF NOT EXISTS idx_papers_stats ON papers(status, school_year_start);
      CREATE INDEX IF NOT EXISTS idx_questions_paper_qtype ON questions(paper_id, qtype);

      -- 每个「同比范围」（筛选条件 + 目标 + 基线 + 层级）一行，重新生成时覆盖。
      -- cache_key = 范围 + 提示词版本 + 数据指纹 的哈希；与当前算出来的不同 = 已过期（界面提示「可重新生成」，不会自动重算）
      CREATE TABLE IF NOT EXISTS ai_analyses (
        scope_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'p2_yoy',
        cache_key TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        markdown TEXT NOT NULL,
        refs_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `)
  },

  // v6 → v7（M3 审核返工）：P2 缓存状态不再每次重算整套统计。
  //  - data_rev：一个单调递增的「数据修订号」，对 papers / questions / question_kps / kps / qtypes 的任何增删改都由触发器 +1
  //    （比让每个写数据的地方记得去通知可靠，也能跨重启）；
  //  - ai_analyses 记下上次核对时的修订号与提示词模板签名：两者都没变就直接用上次的核对结果，变了才重新算一遍并记下。
  (db) => {
    const addCol = (table: string, col: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name)
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
    addCol('ai_analyses', 'template_sig', 'TEXT')     // 生成时 P2 提示词模板（system + user，未填数据）的哈希
    addCol('ai_analyses', 'checked_rev', 'INTEGER')   // 上次核对「是否过期」时的数据修订号
    addCol('ai_analyses', 'checked_sig', 'TEXT')      // 上次核对时的提示词模板签名
    addCol('ai_analyses', 'checked_json', 'TEXT')     // 上次核对的结论：{ fresh, reasons, promptError, empty }
    db.exec(`
      CREATE TABLE IF NOT EXISTS data_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO data_rev (id, rev) VALUES (1, 0);
    `)
    for (const t of ['papers', 'questions', 'question_kps', 'kps', 'qtypes']) {
      for (const [suffix, ev] of [['i', 'INSERT'], ['u', 'UPDATE'], ['d', 'DELETE']]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS trg_rev_${t}_${suffix} AFTER ${ev} ON ${t} BEGIN UPDATE data_rev SET rev = rev + 1 WHERE id = 1; END;`)
      }
    }
  },

  // v7 → v8（M3 复审返工）：修订号触发器太「宽」——导入、提取、解析阶段对 papers 的任何写入（含进度字段）都推高修订号，
  // 打开着同比页时每 500ms 就会让 P2 缓存状态整套重算一遍。改成只有「会影响统计」的写入才推高：
  //   · papers：新增/删除/改了统计会用到的列，且（改之前或改之后）状态是 done / reviewing；状态从计入变为不计入、或反过来，也推高；
  //   · questions / question_kps：所属卷子当前是 done / reviewing；
  //   · kps / qtypes：照旧（树与题型表一变，所有统计都变）。
  // 前提：题和标注不会在卷子之间移动（应用里没有任何代码改 questions.paper_id；question_kps.question_id 同理）。
  //   所以 questions / question_kps 的更新触发器只看 NEW 所属的卷子；真要做「把题挪到另一份卷子」，必须同时用新迁移把这两个触发器改成 OLD、NEW 都看。
  // v7 的触发器 DROP 后重建（v7 本身不动）；顺手把修订号 +1，让升级后的第一次读状态重新核对一遍。
  (db) => {
    const counted = "('done','reviewing')"
    for (const t of ['papers', 'questions', 'question_kps']) {
      for (const suffix of ['i', 'u', 'd']) db.exec(`DROP TRIGGER IF EXISTS trg_rev_${t}_${suffix}`)
    }
    const bump = 'UPDATE data_rev SET rev = rev + 1 WHERE id = 1;'
    db.exec(`
      CREATE TRIGGER trg_rev_papers_i AFTER INSERT ON papers WHEN NEW.status IN ${counted} BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_papers_u AFTER UPDATE OF status, grade, semester, school_year_start, exam_type, textbook, region, file_hash, created_at, title ON papers
        WHEN OLD.status IN ${counted} OR NEW.status IN ${counted} BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_papers_d AFTER DELETE ON papers WHEN OLD.status IN ${counted} BEGIN ${bump} END;

      CREATE TRIGGER trg_rev_questions_i AFTER INSERT ON questions
        WHEN EXISTS (SELECT 1 FROM papers p WHERE p.id = NEW.paper_id AND p.status IN ${counted}) BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_questions_u AFTER UPDATE ON questions
        WHEN EXISTS (SELECT 1 FROM papers p WHERE p.id = NEW.paper_id AND p.status IN ${counted}) BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_questions_d AFTER DELETE ON questions
        WHEN EXISTS (SELECT 1 FROM papers p WHERE p.id = OLD.paper_id AND p.status IN ${counted}) BEGIN ${bump} END;

      CREATE TRIGGER trg_rev_question_kps_i AFTER INSERT ON question_kps
        WHEN EXISTS (SELECT 1 FROM questions q JOIN papers p ON p.id = q.paper_id WHERE q.id = NEW.question_id AND p.status IN ${counted}) BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_question_kps_u AFTER UPDATE ON question_kps
        WHEN EXISTS (SELECT 1 FROM questions q JOIN papers p ON p.id = q.paper_id WHERE q.id = NEW.question_id AND p.status IN ${counted}) BEGIN ${bump} END;
      CREATE TRIGGER trg_rev_question_kps_d AFTER DELETE ON question_kps
        WHEN EXISTS (SELECT 1 FROM questions q JOIN papers p ON p.id = q.paper_id WHERE q.id = OLD.question_id AND p.status IN ${counted}) BEGIN ${bump} END;
      UPDATE data_rev SET rev = rev + 1 WHERE id = 1;
    `)
  },

  // v8 → v9（M4）：报告与数据。
  //  - papers.is_sample：示例数据的标记（统计默认只看真实数据，示例数据要单独切换才看得到；清除示例数据按它删）；
  //  - reports（v1 就有的表）补列：P3 报告的引用索引、警示、样本提示、数据指纹/缓存键/提示词模板签名，以及和 ai_analyses 一样的「上次核对结论」，
  //    用来判断「已过期」而不必每次整套重算；
  //  - papers 的修订号更新触发器把 is_sample 也列进去（v8 里的触发器 DROP 后重建；v8 本身不动）。
  (db) => {
    const addCol = (table: string, col: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name)
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
    addCol('papers', 'is_sample', 'INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE INDEX IF NOT EXISTS idx_papers_sample ON papers(is_sample)')
    addCol('reports', 'title', 'TEXT')
    addCol('reports', 'refs_json', "TEXT NOT NULL DEFAULT '[]'")
    addCol('reports', 'warnings_json', "TEXT NOT NULL DEFAULT '[]'")
    addCol('reports', 'sample_warning', 'TEXT')
    addCol('reports', 'fingerprint', 'TEXT')
    addCol('reports', 'cache_key', 'TEXT')
    addCol('reports', 'template_sig', 'TEXT')
    addCol('reports', 'prompt_version', 'TEXT')
    addCol('reports', 'usage_json', 'TEXT')
    addCol('reports', 'checked_rev', 'INTEGER')
    addCol('reports', 'checked_sig', 'TEXT')
    addCol('reports', 'checked_json', 'TEXT')
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      DROP TRIGGER IF EXISTS trg_rev_papers_u;
      CREATE TRIGGER trg_rev_papers_u AFTER UPDATE OF status, grade, semester, school_year_start, exam_type, textbook, region, file_hash, created_at, title, is_sample ON papers
        WHEN OLD.status IN ('done','reviewing') OR NEW.status IN ('done','reviewing') BEGIN UPDATE data_rev SET rev = rev + 1 WHERE id = 1; END;
      UPDATE data_rev SET rev = rev + 1 WHERE id = 1;
    `)
  },

  // v9 → v10（M6）：让不懂英语的人也能用。
  //  - kps：白话释义 plain、例句 example_en / example_zh、例词 hint_words（内置节点由 seed/kp-plain 写入；自建节点可在知识点编辑器里填，空着就不显示）；
  //  - papers：error_detail（失败的技术详情，界面收在「查看详情」里）、similar_to / similar_ratio / similar_state（疑似重复或部分重复：
  //    suspect = 默认不计入统计，accepted = 老师确认「确实是新卷」后计入）；papers 的修订号触发器把 similar_state 也列进去；
  //  - reports：reader（full 完整数据版 / boss 老板版 / parent 家长版 / teacher 老师版；旧报告都是 full）、confirmed_at（家长版「我已核对」）、
  //    verify_json（事实核对里没对上证据的句子；ai_analyses 也有一列）；
  //  - ai_drafts：P2 / P3 失败时保留的「未完成草稿」；
  //  - settings.ai_config：输出上限「自动」。旧默认 8192（等于旧版内置默认，视为用户没改过）→ 自动（按模型取默认，推理模型 32768）；
  //    其余数值视为用户手改过，保留并关闭自动。
  (db) => {
    const addCol = (table: string, col: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name)
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
    for (const c of ['plain', 'example_en', 'example_zh', 'hint_words']) addCol('kps', c, 'TEXT')
    addCol('papers', 'error_detail', 'TEXT')
    addCol('papers', 'similar_to', 'TEXT')
    addCol('papers', 'similar_ratio', 'REAL')
    addCol('papers', 'similar_state', 'TEXT')
    addCol('reports', 'reader', "TEXT NOT NULL DEFAULT 'full'")
    addCol('reports', 'confirmed_at', 'TEXT')
    addCol('reports', 'verify_json', 'TEXT')
    addCol('ai_analyses', 'verify_json', 'TEXT')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_drafts (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        markdown TEXT NOT NULL DEFAULT '',
        refs_json TEXT NOT NULL DEFAULT '[]',
        message TEXT,
        detail TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_papers_similar ON papers(similar_state);
      DROP TRIGGER IF EXISTS trg_rev_papers_u;
      CREATE TRIGGER trg_rev_papers_u AFTER UPDATE OF status, grade, semester, school_year_start, exam_type, textbook, region, file_hash, created_at, title, is_sample, similar_state ON papers
        WHEN OLD.status IN ('done','reviewing') OR NEW.status IN ('done','reviewing') BEGIN UPDATE data_rev SET rev = rev + 1 WHERE id = 1; END;
    `)
    const upd = db.prepare('UPDATE kps SET plain = ?, example_en = ?, example_zh = ?, hint_words = ? WHERE code = ? AND plain IS NULL')
    for (const [code, v] of Object.entries(KP_PLAIN) as Array<[string, { plain: string; example_en: string; example_zh: string; hint_words: string }]>) upd.run(v.plain, v.example_en, v.example_zh, v.hint_words, code)
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'ai_config'").get() as { value_json: string } | undefined
    if (row) {
      try {
        const c = JSON.parse(row.value_json)
        if (c && typeof c === 'object' && !Array.isArray(c) && !('max_tokens_auto' in c)) {
          const legacy = c.max_tokens === undefined || c.max_tokens === 8192
          c.max_tokens_auto = legacy
          if (legacy) c.max_tokens = 32768
          db.prepare("UPDATE settings SET value_json = ? WHERE key = 'ai_config'").run(JSON.stringify(c))
        }
      } catch { /* 损坏的配置：loadConfig 会回退默认值，不在迁移里处理 */ }
    }
    // 旧版本定位出来的框，在同一行挤着两道题时，前一题的右边会伸进后一题的题号（「16. … 17」）：把它缩回到后一题前面（手工画的框不动）
    const boxRows = db.prepare("SELECT id, paper_id, page_idx, bbox_json, bbox_source FROM questions WHERE bbox_json IS NOT NULL AND (bbox_source IS NULL OR bbox_source <> 'manual')").all() as any[]
    const byPaper = new Map<string, any[]>()
    for (const r of boxRows) { if (!byPaper.has(r.paper_id)) byPaper.set(r.paper_id, []); byPaper.get(r.paper_id)!.push(r) }
    const fixBox = db.prepare('UPDATE questions SET bbox_json = ? WHERE id = ?')
    for (const list of byPaper.values()) {
      const rows = list.map(r => { let b = null; try { b = JSON.parse(r.bbox_json) } catch { /* 坏数据不动 */ } return { id: r.id, page: r.page_idx ?? 0, bbox: Array.isArray(b) ? b : null, source: r.bbox_source } })
      for (const f of repairNeighborEdgesV10(rows)) fixBox.run(JSON.stringify(f.bbox), f.id)
    }
    db.exec('UPDATE data_rev SET rev = rev + 1 WHERE id = 1')
  }
]

let db: any = null
/** 本次运行用的数据目录：启动时定下来，之后不变（更改数据目录要重启才生效，见 datadir.ts） */
let dataDirResolved: string | null = null

/** 配置里指定的数据目录（没配置 = null，用默认位置）；不检查它是否存在 */
export function configuredDir(): string | null {
  return configuredDataDir(app.getPath('userData'))
}

export function defaultDir(): string {
  return defaultDataDir(app.getPath('userData'))
}

export function getDataDir(): string {
  if (!dataDirResolved) dataDirResolved = configuredDir() ?? defaultDir()
  return dataDirResolved
}

/** 启动时让主进程用指定的目录（index.ts 在目录不可用、用户做了选择之后才调用） */
export function setDataDir(dir: string): void {
  dataDirResolved = dir
}

export function getFilesDir(): string {
  return path.join(getDataDir(), 'files')
}

function getDbPath(): string {
  return path.join(getDataDir(), 'db.sqlite')
}

/** 打开别的 SQLite 文件（数据包里的库、导出的快照）；不是正在使用的那一个 */
export function openSqlite(file: string, opts?: { readOnly?: boolean }): any {
  const { DatabaseSync } = require('node:sqlite')
  return opts ? new DatabaseSync(file, opts) : new DatabaseSync(file)
}

export function getDb(): any {
  if (!db) throw new Error('数据库未初始化')
  return db
}

let upgradeScanPending = false
/** 升级到 v10 的库里已有卷子：取走「需要补扫重复卷」的标记（只给一次）。启动时由 index.ts 在窗口创建后调用，后台扫描 */
export function takeUpgradeScan(): boolean {
  const v = upgradeScanPending
  upgradeScanPending = false
  return v
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

  // 升级前先备份（只对已有数据的库；全新的库没什么可备份）：迁移失败时回滚到这份，成功后保留最近几份，老师想退回去也有得退
  // 「有数据」看 papers 表里有没有行，不看版本号：user_version = 0 的最老的库（M1 之前没有版本号）有数据时恰恰最需要备份；新建的空库没有表，什么都不做
  const hadData = dbHasData(db)
  let backupPath: string | null = null
  if (hadData && currentVersion < targetVersion) {
    backupPath = backupBeforeUpgrade(db, dbPath, currentVersion)
  }
  try {
    runMigrations(db, currentVersion)
  } catch (e) {
    if (backupPath) {
      try { db.close() } catch { /* 已经关了 */ }
      db = null
      restoreBackup(dbPath, backupPath)
      throw new Error(`${(e as Error).message}（已恢复到升级前的数据，备份在 ${path.basename(backupPath)}）`)
    }
    throw e
  }

  if (currentVersion < targetVersion) {
    console.log(`[db] schema 已升级到 v${targetVersion}`)
  }
  // 名称就是内部代码的知识点（旧版本采纳 AI 建议时留下的）改成「待命名的考点」；只跑一次（settings 里有标记），原名记在 settings.kp_names_orig_v1
  try { const n = repairKpNames(db); if (n) console.log(`[db] 修补了 ${n} 个名称是内部代码的知识点`) } catch (e) { console.warn(`[db] 修补知识点名称失败: ${(e as Error).message}`) }
  // v10 之后重复卷才有检测：旧库里已有的卷子要补扫一遍。扫描不在这里跑（那会在窗口出现前卡住启动）：
  // 记一个标记，主窗口创建后由 index.ts 调 takeUpgradeScan() 在后台启动（similar-runner.ts）
  if (hadData && currentVersion < 10) upgradeScanPending = true

  // 上次覆盖导入如果在「换文件」和「提交」之间崩溃，这里把文件目录和数据库对齐（见 pack/journal.ts）
  // 结果记进 startupNotice，渲染端启动时通过 app:info 取走并弹窗——恢复失败不能只写一行控制台日志（M4 复审 P2-4）
  startupNotice = null
  try {
    const r = recoverImportJournalDetailed(db, dataDir)
    if (r) console.log(`[db] 覆盖导入恢复：${r.message}`)
    startupNotice = startupNoticeOf(r)
  } catch (e) {
    console.warn(`[db] 覆盖导入恢复失败: ${(e as Error).message}`)
    startupNotice = startupNoticeOf(null, e as Error)
  }
}

let startupNotice: StartupNotice | null = null
/** 启动时数据库恢复的结果（没有就是 null）：渲染端用它给老师一个明确的提示 */
export const getStartupNotice = (): StartupNotice | null => startupNotice
/** 取走启动提示：只给一次，取走后在主进程里清掉——页面重载 / macOS 关窗后从 Dock 重开窗口都不会再弹 */
export function takeStartupNotice(): StartupNotice | null {
  const n = startupNotice
  startupNotice = null
  return n
}

/** 从 from 版本升级到最新（每一步一个事务）。数据包导入时对旧版本的数据包副本也用它 */
export function runMigrations(target: any, from: number): void {
  for (let v = from; v < MIGRATIONS.length; v++) {
    console.log(`[db] 执行迁移 v${v} → v${v + 1}`)
    target.exec('BEGIN')
    try {
      MIGRATIONS[v](target)
      target.exec(`PRAGMA user_version = ${v + 1}`)
      target.exec('COMMIT')
    } catch (e) {
      target.exec('ROLLBACK')
      throw new Error(`迁移 v${v}→v${v + 1} 失败: ${(e as Error).message}`)
    }
  }
}

export const LATEST_SCHEMA = MIGRATIONS.length

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
