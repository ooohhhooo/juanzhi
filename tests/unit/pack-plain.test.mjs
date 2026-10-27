// M6 数据包：知识点的白话释义 / 例句 / 例词随包走；旧版本（v9）的包照常能导入；带脏字符的包不会把换行 / 竖线带进给 AI 的提示词。
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeEnv, paperWithFiles, openDb, LATEST, migrate, newDb, count } from './helpers/packenv.mjs'
import { makeZip } from './helpers/zip.mjs'
import fs from 'node:fs'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge, applyOverwrite } from '../../src/main/pack/apply.ts'

const prep = dbPath => prepareStagedDb(dbPath, { openDb, migrate: (db, from) => migrate(db, from), latest: LATEST })
async function packOf(env, name) {
  const out = path.join(env.dir, `${name}.ewb.zip`)
  await buildPack({ db: env.db, openDb, filesDir: env.filesDir, outPath: out, tmpDir: path.join(env.dir, `tmp-${name}`), appVersion: '1.0.0-test' })
  return out
}
async function stage(zip, env, tag) {
  const ex = await extractPack(zip, path.join(env.dir, `stage-${tag}`))
  const info = prep(ex.dbPath)
  return { ex, info, staged: { dbPath: ex.dbPath, filesDir: ex.filesDir } }
}

// 源：一个自建节点带白话 / 例句；再把内置节点「物主代词」改成自己的说法
const A = makeEnv('plainA')
A.db.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin, plain, example_en, example_zh, hint_words, note) VALUES ('GR.TENSE.U1', 'GR.TENSE', '自建：时态综合', 2, 999, 0, '一句话说清楚', 'I **played** football.', '我踢了足球。', 'played / went', null)").run()
A.db.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin, plain) VALUES ('GR.TENSE.U2', 'GR.TENSE', '脏数据', 2, 1000, 0, '第一行\n第二行｜竖线|后面')").run()   // 旧版本可能留下带换行 / 竖线的文字
paperWithFiles(A, { title: '甲', year: 2025, grade: '4', hash: 'h-pl', questions: [{ kp: 'GR.TENSE.U1', qtype: 'MC', score: 2, difficulty: 3 }] }, 1)
const zip = await packOf(A, 'p')
{
  // 导出的包里新字段在；脏字符已折成一行（导出端折，导入端还会再折一次）
  const st = await stage(zip, A, 'a')
  const d = openDb(st.ex.dbPath, { readOnly: true })
  const k = d.prepare("SELECT plain, example_en, example_zh, hint_words FROM kps WHERE code = 'GR.TENSE.U1'").get()
  assert.deepEqual({ ...k }, { plain: '一句话说清楚', example_en: 'I **played** football.', example_zh: '我踢了足球。', hint_words: 'played / went' })
  assert.equal(d.prepare("SELECT plain p FROM kps WHERE code = 'GR.TENSE.U2'").get().p, '第一行 第二行｜竖线 后面', '换行、竖线折成空格（全角竖线是普通字符，保留）')
  assert.equal(d.prepare("SELECT COUNT(*) c FROM kps WHERE builtin = 1 AND plain IS NOT NULL").get().c, 145, '内置节点的白话也在包里')
  d.close()
}
// 合并进另一台电脑：自建节点连同白话 / 例句一起进来；本机的内置节点以本机为准（不被包里的覆盖）
{
  const B = makeEnv('plainB')
  B.db.prepare("UPDATE kps SET plain = '本机改过的说法' WHERE code = 'GR.PRON.POSS'").run()
  const st = await stage(zip, B, 'b')
  const rep = applyMerge(B.deps, st.staged)
  assert.ok(rep.kpsAdded >= 2)
  assert.deepEqual({ ...B.db.prepare("SELECT plain, example_en, example_zh, hint_words FROM kps WHERE code = 'GR.TENSE.U1'").get() }, { plain: '一句话说清楚', example_en: 'I **played** football.', example_zh: '我踢了足球。', hint_words: 'played / went' })
  assert.equal(B.db.prepare("SELECT plain p FROM kps WHERE code = 'GR.PRON.POSS'").get().p, '本机改过的说法', '内置节点同代码的以本机为准')
}
// 覆盖导入：新字段整体带过来
{
  const C = makeEnv('plainC')
  const st = await stage(zip, C, 'c')
  applyOverwrite(C.deps, st.staged)
  assert.equal(C.db.prepare("SELECT example_zh z FROM kps WHERE code = 'GR.TENSE.U1'").get().z, '我踢了足球。')
  assert.equal(count(C.db, 'SELECT COUNT(*) c FROM kps WHERE builtin = 1 AND plain IS NOT NULL'), 145)
}
// 旧版本（v9）的包：升级后新列为空；内置节点由迁移补上白话，包里的自建节点没有白话也照常导入
{
  const O = makeEnv('plainOld')
  const dest = makeEnv('plainNew')
  const oldDb = newDb(path.join(O.dir, 'v9.sqlite'), 9).db
  const pid = '123e4567-e89b-42d3-a456-426614174999'
  oldDb.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin) VALUES ('GR.TENSE.U9', 'GR.TENSE', '旧包里的自建', 2, 999, 0)").run()
  oldDb.prepare("INSERT INTO papers (id, title, file_name, file_hash, status, grade, school_year_start) VALUES (?, '旧卷', 'a.pdf', 'hold', 'done', '4', 2024)").run(pid)
  oldDb.exec(`VACUUM INTO '${path.join(O.dir, 'v9-snap.sqlite').replace(/'/g, "''")}'`)
  oldDb.close()
  const man = { format: 'ewb-pack', formatVersion: 1, schemaVersion: 9, appVersion: '1.0.0', exportedAt: '2026-01-01T00:00:00Z', paperCount: 1, questionCount: 0 }
  const zip = path.join(O.dir, 'old.ewb.zip')
  fs.writeFileSync(zip, makeZip([{ name: 'manifest.json', data: JSON.stringify(man) }, { name: 'db.sqlite', data: fs.readFileSync(path.join(O.dir, 'v9-snap.sqlite')), method: 8 }]))
  const ex = await extractPack(zip, path.join(dest.dir, 'stage-old'))
  const info = prep(ex.dbPath)
  assert.equal(info.originalVersion, 9); assert.equal(info.migrated, true)
  const rep = applyMerge(dest.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.ok(rep.kpsAdded >= 1)
  assert.equal(dest.db.prepare("SELECT plain p FROM kps WHERE code = 'GR.TENSE.U9'").get().p, null)
  assert.equal(count(dest.db, 'SELECT COUNT(*) c FROM papers WHERE id = ?', pid), 1)
  assert.equal(count(dest.db, "SELECT COUNT(*) c FROM kps WHERE builtin = 1 AND plain IS NOT NULL"), 145)
}
console.log('pack-plain.test ✓')
