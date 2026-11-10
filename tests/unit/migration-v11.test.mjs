// M9 迁移 v11：一次建好 M9 的全部表结构（识别方式、批次明细、课程对照、报告分段、变形题）。
// 配套纪律：v1–v10 一个字都不能改（冻结哈希），v11 随 beta.1 发出后也冻结——要改只追加 v12。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrations, newDb, addPaper } from './helpers/db.mjs'

const ms = migrations()
assert.equal(ms.length, 13, '迁移数组共 13 项（v1–v13；v12 是内置助手的表，v13 是学科，见 migration-v13）')

// ───────── 冻结：v1–v10 的源码哈希写死，谁改了旧迁移谁失败 ─────────
// 取 db.ts 里从「v10 用的缩框函数」到「v10 → v11」注释之前的原文（含 v1–v10 全部迁移和它们依赖的冻结函数），换行归一后求哈希
const src = fs.readFileSync(path.resolve('src/main/db.ts'), 'utf8').replace(/\r\n/g, '\n')
const start = src.indexOf('/**\n * 迁移 v10 用的')
const end = src.indexOf('  // v10 → v11（M9 公测版）')
assert.ok(start >= 0 && end > start, '找得到 v1–v10 的原文范围')
const frozenText = src.slice(start, end)
const FROZEN_V1_V10 = '5fac55aa5156f3273bab675f1f11807c85623d1d9b0ffbf082b0d7365b916ea2'
const got = crypto.createHash('sha256').update(frozenText).digest('hex')
if (process.env.EWB_PRINT_MIGRATION_HASH) console.log('FROZEN_V1_V10 =', got)
else assert.equal(got, FROZEN_V1_V10, '不要改 v1–v10 的迁移（已发出去的版本，用户的库已经跑过它们）；要改结构请追加新的迁移')

// ───────── v10 库（含数据）升级到 v11 ─────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-v11-'))
  const file = path.join(dir, 'v10.sqlite')
  const { db } = newDb(file, 10)
  const pid = addPaper(db, { title: '升级前的卷', questions: [{ no: 1, qtype: 'MC', kp: 'GR.NOUN.PLURAL.REG', err: true, reason: 'x', bbox: [0.1, 0.1, 0.5, 0.05] }] })
  db.prepare("INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text, ocr_conf) VALUES (?, 1, 'page-1.png', 100, 100, 'ocr', '[]', 'hi', 0.8)").run(pid)
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('ai_config', ?)").run(JSON.stringify({ provider: 'deepseek', base_url: 'https://x', model: 'deepseek-v4-pro', vision_model: 'v', concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 32768, max_tokens_auto: true }))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10)
  const before = {
    papers: db.prepare('SELECT * FROM papers').all(), questions: db.prepare('SELECT * FROM questions').all(),
    pages: db.prepare('SELECT * FROM pages').all(), kps: db.prepare('SELECT COUNT(*) c FROM kps').get().c
  }
  db.exec('BEGIN'); ms[10](db); db.exec('PRAGMA user_version = 11'); db.exec('COMMIT')
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
  for (const c of ['recognizer', 'ocr_lang', 'ocr_ms', 'rec_reason', 'quality_json']) assert.ok(cols('pages').includes(c), `pages.${c}`)
  for (const c of ['ms', 'err_code', 'attempts']) assert.ok(cols('ai_usage').includes(c), `ai_usage.${c}`)
  assert.ok(cols('reports').includes('options_json')); assert.ok(cols('papers').includes('diag_json'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  for (const t of ['parse_batches', 'course_outlines', 'course_levels', 'course_lessons', 'course_kp_check', 'course_kp_map', 'course_advice', 'report_parts', 'report_variants']) assert.ok(tables.includes(t), `新表 ${t}`)
  // 旧数据一行没变（新列为 NULL，不影响原有列）
  const same = (after, was) => after.map(r => Object.fromEntries(Object.keys(was[0]).map(k => [k, r[k]])))
  assert.deepEqual(same(db.prepare('SELECT * FROM papers').all(), before.papers), before.papers.map(r => ({ ...r })))
  assert.deepEqual(same(db.prepare('SELECT * FROM questions').all(), before.questions), before.questions.map(r => ({ ...r })))
  const pg = db.prepare('SELECT * FROM pages').get()
  assert.equal(pg.text, 'hi'); assert.equal(pg.ocr_conf, 0.8); assert.equal(pg.recognizer, null)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM kps').get().c, before.kps)
  assert.equal(JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key='ai_config'").get().value_json).model, 'deepseek-v4-pro', '设置里的 AI 配置原样保留（新字段读取时按默认值补）')
  // 重复执行也不出错（用 IF NOT EXISTS / 先查列）
  db.exec('BEGIN'); ms[10](db); db.exec('COMMIT')
  // 级联：删课程体系 → 级别 / 课次 / 对应关系都没了；删报告 → 分段 / 变形题没了；删试卷 → 批次明细没了
  db.exec('PRAGMA foreign_keys=ON')
  db.exec("INSERT INTO course_outlines (id, name) VALUES ('o1', '示例体系 A')")
  db.exec("INSERT INTO course_levels (outline_id, name) VALUES ('o1', '基础级')")
  const lv = db.prepare('SELECT id FROM course_levels').get().id
  db.prepare("INSERT INTO course_lessons (outline_id, level_id, seq, no_label, title) VALUES ('o1', ?, 5, '第 5 课', 'Animals')").run(lv)
  const ls = db.prepare('SELECT id FROM course_lessons').get().id
  db.prepare("INSERT INTO course_kp_map (outline_id, kp_code, lesson_id, confidence) VALUES ('o1', 'GR.NOUN.PLURAL.REG', ?, 'high')").run(ls)
  db.exec("INSERT INTO course_kp_check (outline_id, kp_code, result) VALUES ('o1', 'GR.NOUN.PLURAL.REG', 'matched')")
  db.exec("DELETE FROM course_outlines WHERE id = 'o1'")
  for (const t of ['course_levels', 'course_lessons', 'course_kp_map', 'course_kp_check']) assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, `${t} 随体系级联删除`)
  db.exec("INSERT INTO reports (id, kind, markdown) VALUES ('r1', 'p3', 'x')")
  db.exec("INSERT INTO report_parts (report_id, part) VALUES ('r1', 'main')")
  db.exec("INSERT INTO report_variants (id, report_id, seq) VALUES ('v1', 'r1', 1)")
  db.exec("DELETE FROM reports WHERE id = 'r1'")
  assert.equal(db.prepare('SELECT COUNT(*) c FROM report_parts').get().c, 0); assert.equal(db.prepare('SELECT COUNT(*) c FROM report_variants').get().c, 0)
  db.prepare("INSERT INTO parse_batches (paper_id, seq, mode, model, attempts, truncated, ms, ok) VALUES (?, 1, 'text', 'm', 2, 1, 1234, 1)").run(pid)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM parse_batches').get().c, 1)
  db.prepare('DELETE FROM papers WHERE id = ?').run(pid)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM parse_batches').get().c, 0, '批次明细随试卷删除')
  db.close()
}

// ───────── 全新库一路迁移到 v11 ─────────
{
  const { db, version } = newDb()
  assert.equal(version, 13)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13)
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
  for (const i of ['idx_parse_batches_paper', 'idx_parse_batches_model', 'idx_course_lessons_o', 'idx_course_kp_map_o', 'idx_course_kp_check_o', 'idx_report_variants_r']) assert.ok(idx.includes(i), i)
  db.close()
}
console.log('migration-v11.test ✓')
