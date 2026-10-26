// 单测用：从 src/main/db.ts 里取出真实的迁移数组（v1–最新）在内存库上执行，得到和应用里一模一样的表结构。
// 不另写一份建表语句——表结构以迁移为准，迁移改了单测自然跟着变。
import fs from 'node:fs'
import path from 'node:path'
import module from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const seed = await import(pathToFileURL(path.join(root, 'src/main/seed/taxonomy.ts')).href)

function loadMigrations() {
  const src = fs.readFileSync(path.join(root, 'src/main/db.ts'), 'utf8')
  const m = /const MIGRATIONS: Array<\(db: any\) => void> = (\[[\s\S]*?\n\])\r?\n\r?\nlet db: any/.exec(src)
  if (!m) throw new Error('db.ts 里找不到 MIGRATIONS')
  const js = module.stripTypeScriptTypes(`const MIGRATIONS = ${m[1]}`)
  return new Function('buildKpRows', 'QTYPE_SEEDS_V1', `${js}\nreturn MIGRATIONS`)(seed.buildKpRows, seed.QTYPE_SEEDS_V1)
}

/** 取出真实的迁移数组（v1–最新），数据包导入 / 升级的单测用它当 migrate */
export function migrations() { return loadMigrations() }
export function migrate(db, from) {
  const ms = loadMigrations()
  for (let v = from; v < ms.length; v++) { db.exec('BEGIN'); ms[v](db); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT') }
}

/** upTo：只升到这个版本（造「旧版本数据包」用）；file：文件库（默认内存库） */
export function newDb(file = ':memory:', upTo) {
  const migrations = loadMigrations()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const n = upTo ?? migrations.length
  migrations.slice(0, n).forEach((fn, i) => { db.exec('BEGIN'); fn(db); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT') })
  return { db, version: migrations.length }
}

/** 清空种子树，换成手写的小树：[code, parent, name, level, intro_grade] */
export function useTree(db, nodes) {
  db.exec('DELETE FROM kps')
  const ins = db.prepare('INSERT INTO kps (code, parent_code, name, level, intro_grade, sort) VALUES (?, ?, ?, ?, ?, ?)')
  nodes.forEach(([code, parent, name, level, grade], i) => ins.run(code, parent, name, level, grade ?? 3, i * 10))
}

let seq = 0
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

/** 造一份卷子。questions: [{ no, qtype, kp: 主, sec: [次], score, difficulty, err, reason }] */
export function addPaper(db, p) {
  const id = p.id ?? uid()
  // hash：同一个文件导入多份时它们的 file_hash 相同（默认每份唯一）；created：导入时间（默认按插入顺序，同一秒内靠 rowid 区分先后）
  db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, file_name, file_hash, status, duplicate_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))`).run(id, p.title ?? `卷${seq}`, p.grade ?? '4', p.semester === undefined ? '上' : p.semester, p.year === undefined ? 2025 : p.year, p.exam ?? '期末', p.textbook ?? '人教PEP', p.region ?? null,
    `${id}.pdf`, p.hash ?? `h-${id}`, p.status ?? 'done', p.dup ?? null, p.created ?? null)
  const iq = db.prepare(`INSERT INTO questions (id, paper_id, ord, no_label, section, qtype, stem, score, difficulty, error_prone, error_reason, page_idx, bbox_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const ik = db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
  ;(p.questions ?? []).forEach((q, i) => {
    const qid = q.id ?? uid()
    iq.run(qid, id, i + 1, String(q.no ?? i + 1), q.section ?? '一', q.qtype ?? 'MC', q.stem ?? `题干${i + 1}`, q.score ?? null, q.difficulty === undefined ? 3 : q.difficulty, q.err ? 1 : 0, q.reason ?? '', q.page ?? 1, q.bbox ? JSON.stringify(q.bbox) : null)
    if (q.kp) ik.run(qid, q.kp, 1)
    for (const s of q.sec ?? []) ik.run(qid, s, 0)
  })
  return id
}
