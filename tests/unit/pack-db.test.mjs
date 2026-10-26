// 数据包的导出 / 暂存校验 / 合并 / 覆盖 / 回滚 / 崩溃恢复。全部用真实迁移建的文件库和真实文件目录。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { makeEnv, paperWithFiles, openDb, treeHash, count, root, LATEST, migrate, newDb, addPaper } from './helpers/packenv.mjs'
import { makeZip } from './helpers/zip.mjs'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge, applyOverwrite, summarizePack, listBackups } from '../../src/main/pack/apply.ts'
import { classifyEntry } from '../../src/main/pack/names.ts'
import { PackError } from '../../src/main/pack/errors.ts'
import { readJournal, recoverImportJournal, writeJournal, MARKER_KEY } from '../../src/main/pack/journal.ts'
import * as S from '../../src/main/stats/core.ts'
import yauzl from 'yauzl'
import { withRetry } from '../../src/main/pack/fsretry.ts'

const migrateFn = (db, from) => migrate(db, from)
const prep = dbPath => prepareStagedDb(dbPath, { openDb, migrate: migrateFn, latest: LATEST })
const SECRET = 'SECRET-KEY-CIPHERTEXT-9f3a7c1e-DO-NOT-LEAK'
const kp = c => c
const Q = (code, score = 2, extra = {}) => ({ kp: kp(code), qtype: 'MC', score, difficulty: 3, ...extra })

async function exportOf(env, name = 'pack') {
  const out = path.join(env.dir, `${name}.ewb.zip`)
  const res = await buildPack({ db: env.db, openDb, filesDir: env.filesDir, outPath: out, tmpDir: path.join(env.dir, `tmp-${name}`), appVersion: '0.4.0-test' })
  return { out, res }
}
async function stageOf(zip, into) {
  const dir = path.join(into.dir, `stage-${path.basename(zip)}`)
  const ex = await extractPack(zip, dir)
  const info = prep(ex.dbPath)
  return { ex, info, staged: { dbPath: ex.dbPath, filesDir: ex.filesDir }, dir }
}
const entriesOf = zip => new Promise((res, rej) => yauzl.open(zip, { lazyEntries: true }, (e, z) => { if (e) return rej(e); const a = []; z.on('entry', x => { a.push(x.fileName); z.readEntry() }); z.on('end', () => res(a)); z.readEntry() }))
const sampleStats = db => { const d = S.distribution(db, {}); return { papers: d.papers, questions: d.questions, totalScore: d.totalScore, nodes: d.nodes.map(n => [n.code, n.papers, n.questions, n.score]), qtypes: d.qtypes.map(t => [t.code, t.questions, t.score]) } }

// ─────────── 源环境 A：有 3 份卷子 + 1 份示例卷 + 一份自建知识点 ───────────
const A = makeEnv('A')
A.db.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin) VALUES ('GR.TENSE.U1', 'GR.TENSE', '自建：时态综合', 2, 999, 0)").run()
const a1 = paperWithFiles(A, { title: '甲', year: 2024, grade: '4', hash: 'h-a1', questions: [Q('GR.NOUN.PLURAL.REG'), Q('GR.TENSE.PAST.REG', 3, { err: true, reason: '加-ed' }), Q('GR.TENSE.U1', 2, { sec: ['GR.NOUN.PLURAL.REG'] })] }, 2)
const a2 = paperWithFiles(A, { title: '乙', year: 2025, grade: '4', hash: 'h-a2', questions: [Q('GR.TENSE.FUT.GOING'), Q('RD.DETAIL.FACT', 3)] }, 3)
const a3 = paperWithFiles(A, { title: '丙（待审核）', year: 2025, grade: '5', status: 'reviewing', hash: 'h-a3', questions: [Q('GR.ADJ.COMPARE.REG')] }, 1)
const aSample = paperWithFiles(A, { title: '示例', year: 2025, grade: '4', hash: 'sample-x', questions: [Q('GR.TENSE.PAST.REG')] }, 1)
A.db.prepare('UPDATE papers SET is_sample = 1 WHERE id = ?').run(aSample)
// 机器专属的设置：密钥密文、AI 配置、数据目录、引导状态——这些绝不能进包；提示词覆盖、默认教材可以
const put = (k, v) => A.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(k, JSON.stringify(v))
put('ai_key_enc', SECRET); put('ai_config', { base_url: 'https://api.example.com', model: 'm' }); put('onboarding_done', true); put('ui_stats_filter', { grade: '4' }); put('ai_prompts', { 'p3_report.system': '自定义的提示词' }); put('default_textbook', '人教PEP')
A.db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown, model, title, checked_rev, checked_sig, checked_json) VALUES ('11111111-1111-4111-8111-111111111111', 'report', '{}', '# r', 'm', 't', 5, 's', '{"fresh":true}')`).run()
A.db.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown, checked_rev) VALUES ('sk', 'ck', 'v1', 'fp', '{}', '# a', 7)`).run()

// ── 导出 ──
const { out: zipA, res: resA } = await exportOf(A)
{
  const names = await entriesOf(zipA)
  assert.ok(names.every(n => classifyEntry(n)), '包里的每个条目名都在白名单里：' + names.filter(n => !classifyEntry(n)).join(','))
  assert.ok(names.includes('manifest.json') && names.includes('db.sqlite'))
  assert.ok(!names.some(n => n.includes(aSample)), '示例卷的文件不进包')
  assert.ok(names.some(n => n === `files/${a1}/original.pdf`) && names.some(n => n === `files/${a1}/media/1.png`), '原件和附件图都在')
  assert.equal(resA.manifest.paperCount, 3, '卷数 = 非示例的 3 份')
  assert.equal(resA.manifest.questionCount, 6)
  assert.equal(resA.manifest.schemaVersion, LATEST)
  assert.equal(resA.manifest.appVersion, '0.4.0-test')
  // 密钥与机器专属设置不进包：解出快照库逐项看，并且整个文件里搜不到密文字节（secure_delete + 重新 VACUUM）
  const st = await stageOf(zipA, A)
  const snap = openDb(st.ex.dbPath)
  const keys = snap.prepare('SELECT key FROM settings ORDER BY key').all().map(r => r.key)
  assert.deepEqual(keys, ['ai_prompts', 'default_textbook'], '只留白名单里的设置：' + keys)
  assert.equal(count(snap, 'SELECT COUNT(*) c FROM papers WHERE is_sample = 1'), 0, '快照里没有示例卷')
  assert.equal(count(snap, 'SELECT COUNT(*) c FROM papers'), 3)
  assert.equal(snap.prepare('SELECT checked_rev FROM reports').get().checked_rev, null, '报告的"上次核对结论"不带走')
  snap.close()
  const raw = fs.readFileSync(st.ex.dbPath)
  assert.ok(!raw.includes(Buffer.from(SECRET)), '数据库文件里搜不到密钥密文（空闲页里也没有）')
  assert.ok(!raw.includes(Buffer.from('api.example.com')), 'AI 服务地址也不在里面')
  assert.ok(!fs.readFileSync(zipA).includes(Buffer.from(SECRET)), '整个 zip 里（db 虽被压缩，其它条目未压缩）也找不到密钥')
  // 压缩过的 db 条目：解出来再搜一遍已经做了（raw）；另外 zip 里没有 settings 以外的地方存密钥
}
assert.ok(!fs.existsSync(path.join(A.dir, 'tmp-pack', 'snapshot.sqlite')), '导出后临时快照被清掉')
assert.ok(!fs.existsSync(zipA + '.part'), '没有遗留 .part 文件')

// ── 往返：导出 → 全新环境覆盖导入，卷数 / 题数 / 统计 / 文件哈希全部一致 ──
{
  const B = makeEnv('B')
  const st = await stageOf(zipA, B)
  assert.equal(st.info.papers, 3); assert.equal(st.info.questions, 6); assert.equal(st.info.migrated, false)
  const sum = summarizePack(B.deps, st.staged)
  assert.deepEqual([sum.papersInPack, sum.papersNew, sum.papersExisting, sum.questionsInPack], [3, 3, 0, 6])
  assert.equal(sum.missingPageImages, 0)
  const rep = applyOverwrite(B.deps, st.staged)
  assert.equal(rep.papersAdded, 3); assert.equal(rep.questionsAdded, 6)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM papers'), 3); assert.equal(count(B.db, 'SELECT COUNT(*) c FROM questions'), 6)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM pages'), 6, 'A 的页面：2+3+1')
  // 看板数字一致（与 A 去掉示例卷后的统计比；A 里示例卷默认也不计入，所以直接比）
  assert.deepEqual(sampleStats(B.db), sampleStats(A.db), '导入后看板数字与源库一致')
  assert.deepEqual(S.distribution(B.db, { includeReviewing: true }).nodes.map(n => [n.code, n.papers]), S.distribution(A.db, { includeReviewing: true }).nodes.map(n => [n.code, n.papers]))
  // 文件逐个哈希一致（截图 / 页面图 / 原件 / 附件）
  const ha = treeHash(A.filesDir); delete ha[`${aSample}/original.pdf`]; for (const k of Object.keys(ha)) if (k.startsWith(aSample)) delete ha[k]
  assert.deepEqual(treeHash(B.filesDir), ha, '文件目录逐个文件的哈希一致')
  // 设置：提示词覆盖随包走，机器专属的没有
  const sets = B.db.prepare("SELECT key FROM settings WHERE key <> ? ORDER BY key").all(MARKER_KEY).map(r => r.key)
  assert.deepEqual(sets, ['ai_prompts', 'default_textbook'])
  // 自建知识点随包走，题目标注指向它
  assert.equal(B.db.prepare("SELECT name FROM kps WHERE code = 'GR.TENSE.U1'").get().name, '自建：时态综合')
  assert.equal(count(B.db, "SELECT COUNT(*) c FROM question_kps WHERE kp_code = 'GR.TENSE.U1'"), 1)
  // 数据修订号被推高（缓存据此失效）
  assert.ok(count(B.db, 'SELECT rev c FROM data_rev') > 0)
  // 旧数据备份：第一次导入到空库时也有备份（空库的快照）
  assert.equal(listBackups(B.dataDir).length, 1)
  assert.ok(rep.backup && fs.existsSync(rep.backup.dbFile))
  // 外键完整、触发器还是主库自己的那一套
  assert.equal(B.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  assert.equal(count(B.db, "SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'"), count(A.db, "SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'"))
}

// ── 合并：按 UUID 去重 ──
{
  // 1) 合并回源库自己：一份都不新增
  const st = await stageOf(zipA, A)
  const before = sampleStats(A.db)
  const rep = applyMerge(A.deps, st.staged)
  assert.equal(rep.papersAdded, 0); assert.equal(rep.papersSkipped, 3); assert.equal(rep.questionsAdded, 0)
  assert.equal(count(A.db, 'SELECT COUNT(*) c FROM papers WHERE is_sample = 0'), 3, '合并自己不产生重复')
  assert.deepEqual(sampleStats(A.db), before)
  // 2) 合并进另一台电脑 C（有自己的 2 份卷子，其中 1 份和 A 的 a1 是同一条记录）
  const C = makeEnv('C')
  const c1 = paperWithFiles(C, { title: 'C 自己的', year: 2025, grade: '6', hash: 'h-c1', questions: [Q('VO.TOPIC.WEATHER')] }, 1)
  const stA = await stageOf(zipA, C)
  // 先把 a1 作为同一条记录放进 C（模拟"上次已经导入过一部分"）
  const first = applyMerge(C.deps, stA.staged)
  assert.equal(first.papersAdded, 3); assert.equal(first.papersSkipped, 0)
  assert.equal(first.promptsImported, 1, '导入报告里说出随包补进来 1 条自定义提示词（P2-6）'); assert.equal(first.promptsKeptLocal, 0)
  assert.equal(count(C.db, 'SELECT COUNT(*) c FROM papers'), 4)
  // 设置：本机没设置过的（自定义提示词、默认教材）随包补上；机器专属的（密钥、AI 配置）不会有
  assert.deepEqual(C.db.prepare("SELECT key FROM settings ORDER BY key").all().map(r => r.key), ['ai_prompts', 'default_textbook'])
  // 再导入一次同一个包：全部跳过，没有重复
  const again = await stageOf(zipA, C)
  const second = applyMerge(C.deps, again.staged)
  assert.equal(second.papersAdded, 0); assert.equal(second.papersSkipped, 3)
  assert.equal(count(C.db, 'SELECT COUNT(*) c FROM papers'), 4); assert.equal(count(C.db, 'SELECT COUNT(*) c FROM questions'), 7)
  assert.equal(count(C.db, 'SELECT COUNT(*) c FROM question_kps WHERE kp_code = ?', 'GR.TENSE.U1'), 1, '自建知识点只加一次')
  assert.equal(count(C.db, "SELECT COUNT(*) c FROM kps WHERE code = 'GR.TENSE.U1'"), 1)
  assert.ok(fs.existsSync(path.join(C.filesDir, a1, 'page-2.png')) && fs.existsSync(path.join(C.filesDir, c1, 'page-1.png')), '新增试卷的文件搬进来了，自己的还在')
  assert.equal(count(C.db, "SELECT COUNT(*) c FROM papers WHERE id IN (SELECT id FROM papers) AND is_sample = 0"), 4)
  // 合并没有备份、没有整库替换
  assert.equal(listBackups(C.dataDir).length, 0)
  // 本机已经设置过的不被覆盖
  const C2 = makeEnv('C2')
  C2.db.prepare("INSERT INTO settings (key, value_json) VALUES ('ai_prompts', '{\"mine\":\"本机的提示词\"}')").run()
  const repC2 = applyMerge(C2.deps, (await stageOf(zipA, C2)).staged)
  assert.equal(repC2.promptsImported, 0); assert.equal(repC2.promptsKeptLocal, 1, '本机已有 → 报告里说明保持本机的、包里 1 条没生效')
  assert.equal(C2.db.prepare("SELECT value_json v FROM settings WHERE key = 'ai_prompts'").get().v, '{"mine":"本机的提示词"}', '合并不覆盖本机已有的设置')
  assert.equal(C2.db.prepare("SELECT value_json v FROM settings WHERE key = 'default_textbook'").get().v, '"人教PEP"', '本机没有的设置补上')
  // 3) 同一个文件、不同记录（两台电脑各自导入了同一份 PDF）：保留两条，标出重复，统计只算一份
  const D = makeEnv('D')
  const d1 = paperWithFiles(D, { title: '同一份 PDF 的另一条记录', year: 2024, grade: '4', hash: 'h-a1', questions: [Q('GR.NOUN.PLURAL.REG')] }, 1)
  const stD = await stageOf(zipA, D)
  const rd = applyMerge(D.deps, stD.staged)
  assert.equal(rd.sameFileAsExisting, 1, 'a1 与 D 里的 d1 文件哈希相同')
  assert.equal(D.db.prepare('SELECT duplicate_of FROM papers WHERE id = ?').get(a1).duplicate_of, d1)
  const dup = S.distribution(D.db, {})
  assert.equal(dup.papers, 2, 'D 里已确认的有 d1、a1（同一个文件）、a2 三条记录——统计里同一个文件只算一份：2 份')
  assert.equal(S.distribution(D.db, { includeDuplicates: true }).papers, 3)
}

// ─────────── 暂存校验：版本 / 损坏 / 可执行对象 / 内容 ───────────
const stageCopy = async (zip, env, tag) => {   // 解出来后可以随意改的暂存库
  const dir = path.join(env.dir, `stage-${tag}`)
  const ex = await extractPack(zip, dir)
  return ex
}

// 数据库版本比当前新 → 拒绝并提示升级
{
  const E = makeEnv('newer')
  const ex = await stageCopy(zipA, E, 'newer')
  const d = openDb(ex.dbPath); d.exec(`PRAGMA user_version = ${LATEST + 1}`); d.close()
  assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'too_new' && /升级/.test(e.message))
}
// 只有 PRAGMA integrity_check 才发现得了的损坏：表里的值被改了、索引里没改（普通查询照常读得出来）
{
  const E = makeEnv('subtle')
  const ex = await stageCopy(zipA, E, 'subtle')
  const buf = fs.readFileSync(ex.dbPath)
  const at = buf.indexOf(Buffer.from('h-a1'))
  assert.ok(at > 0, '样本库里能找到 h-a1')
  buf.write('h-zz', at)   // 只改第一处（表里那份），索引 idx_papers_hash 里那份不动
  fs.writeFileSync(ex.dbPath, buf)
  const peek = openDb(ex.dbPath, { readOnly: true })
  assert.equal(peek.prepare('SELECT COUNT(*) c FROM papers').get().c, 3, '这种损坏下普通查询照常能读')
  peek.close()
  assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'corrupt_db' && /完整性检查/.test(e.message), '必须由完整性检查拒绝')
}
// 损坏：乱写中间的字节 / 截断 / 根本不是数据库
{
  const E = makeEnv('corrupt')
  const ex = await stageCopy(zipA, E, 'c1')
  const buf = fs.readFileSync(ex.dbPath)
  for (let i = 4096; i < Math.min(buf.length, 4096 * 3); i++) buf[i] = (buf[i] + 17) & 0xff
  fs.writeFileSync(ex.dbPath, buf)
  assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'corrupt_db', '乱写的页面必须被完整性检查或读取拒绝')
  const ex2 = await stageCopy(zipA, E, 'c2')
  fs.writeFileSync(ex2.dbPath, fs.readFileSync(ex2.dbPath).subarray(0, 5000))
  assert.throws(() => prep(ex2.dbPath), e => e instanceof PackError && e.code === 'corrupt_db')
  const ex3 = await stageCopy(zipA, E, 'c3')
  fs.writeFileSync(ex3.dbPath, 'this is not a sqlite database, only text '.repeat(200))
  assert.throws(() => prep(ex3.dbPath), e => e instanceof PackError && e.code === 'corrupt_db')
}
// 带触发器 / 视图的库：暂存时删掉，导入后主库的触发器和视图一个字都没变，恶意触发器没有执行
{
  const E = makeEnv('evil')
  const p1 = paperWithFiles(E, { title: 'E 自己', year: 2025, grade: '4', hash: 'h-e1', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const ex = await stageCopy(zipA, E, 'evil')
  const d = openDb(ex.dbPath)
  d.exec(`CREATE TABLE loot (v TEXT);
    CREATE TRIGGER evil_i AFTER INSERT ON papers BEGIN DELETE FROM papers WHERE id <> NEW.id; INSERT INTO loot VALUES ('fired'); END;
    CREATE TRIGGER evil_s AFTER INSERT ON settings BEGIN DELETE FROM kps; END;
    CREATE VIEW evil_v AS SELECT * FROM settings;`)
  d.close()
  const info = prep(ex.dbPath)
  const chk = openDb(ex.dbPath)
  assert.equal(count(chk, "SELECT COUNT(*) c FROM sqlite_master WHERE type IN ('trigger','view')"), 0, '暂存库里的触发器和视图都被删掉')
  chk.close()
  const sig = db => JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','view','index') ORDER BY name").all())
  const sigBefore = sig(E.db)
  const rep = applyMerge(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(rep.papersAdded, 3)
  assert.equal(sig(E.db), sigBefore, '主库的触发器 / 视图 / 索引导入前后完全一致')
  assert.equal(E.db.prepare("SELECT name FROM sqlite_master WHERE name = 'loot'").get(), undefined, '数据包里多出来的表没有进主库')
  assert.equal(count(E.db, 'SELECT COUNT(*) c FROM papers'), 4, 'E 自己的 1 份 + 包里的 3 份都在（恶意触发器没有删除任何东西）')
  assert.ok(E.db.prepare('SELECT id FROM papers WHERE id = ?').get(p1))
  // 覆盖模式同样
  const E2 = makeEnv('evil2')
  const ex2 = await stageCopy(zipA, E2, 'evil2')
  const d2 = openDb(ex2.dbPath)
  d2.exec(`CREATE TRIGGER evil_d AFTER DELETE ON papers BEGIN INSERT INTO settings VALUES ('pwned', '1'); END; CREATE VIEW evil_v2 AS SELECT 1;`)
  d2.close()
  prep(ex2.dbPath)
  const before = sig(E2.db)
  applyOverwrite(E2.deps, { dbPath: ex2.dbPath, filesDir: ex2.filesDir })
  assert.equal(sig(E2.db), before)
  assert.equal(E2.db.prepare("SELECT 1 FROM settings WHERE key = 'pwned'").get(), undefined)
}
// 旧版本数据包上带触发器：迁移前就删掉，触发器不会在升级过程中执行。
// 用 v3 的库：v3→v4 的迁移会对 papers 做 UPDATE（done → extracted），触发器如果还在就会被它触发
{
  const E = makeEnv('oldevil')
  const old = newDb(path.join(E.dir, 'old.sqlite'), 3).db
  old.exec("CREATE TABLE loot (v TEXT); CREATE TRIGGER evil_u AFTER UPDATE ON papers BEGIN INSERT INTO loot VALUES ('fired'); END;")
  old.prepare("INSERT INTO papers (id, title, file_name, file_hash, status) VALUES ('123e4567-e89b-42d3-a456-426614174111', 'old', 'o.pdf', 'oh', 'done')").run()
  old.close()
  const info = prep(path.join(E.dir, 'old.sqlite'))
  assert.equal(info.originalVersion, 3); assert.equal(info.migrated, true)
  const chk = openDb(path.join(E.dir, 'old.sqlite'))
  assert.equal(count(chk, 'SELECT COUNT(*) c FROM loot'), 0, '恶意触发器没有在升级过程中执行')
  assert.equal(chk.prepare("SELECT status FROM papers").get().status, 'extracted', '迁移本身照常执行了（v4 把 done 改成 extracted）')
  assert.equal(chk.prepare('PRAGMA user_version').get().user_version, LATEST)
  chk.close()
}
// 内容校验：试卷 id 不是 UUID / 页面图路径含 .. / 题目指向不存在的试卷
{
  const mutate = async (tag, sql, re) => {
    const E = makeEnv(tag)
    const ex = await stageCopy(zipA, E, tag)
    const d = openDb(ex.dbPath); d.exec('PRAGMA foreign_keys = OFF'); d.exec(sql); d.close()
    assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'bad_content' && re.test(e.message), tag)
  }
  await mutate('badid', "UPDATE papers SET id = '../../etc/passwd' WHERE title = '甲'", /编号格式/)
  await mutate('badqid', "UPDATE questions SET id = 'x/../y' WHERE rowid = 1", /编号格式/)
  await mutate('badrel', "UPDATE pages SET image_rel = '../../../x.png' WHERE rowid = 1", /路径格式/)
  await mutate('badasset', "UPDATE paper_assets SET rel_path = '/etc/passwd' WHERE rowid = 1", /路径格式/)
  await mutate('fk', "INSERT INTO questions (id, paper_id, ord) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-00000000dead', 1)", /引用不存在/)
  await mutate('nopapers', 'DROP TABLE materials', /缺少表/)
}

// ─────────── 旧版本数据包能导入并迁移 ───────────
{
  const E = makeEnv('olddst')
  const O = makeEnv('oldsrc')
  const oldDb = newDb(path.join(O.dir, 'v5.sqlite'), 5).db
  const pid = '123e4567-e89b-42d3-a456-426614174222'
  oldDb.prepare("INSERT INTO papers (id, title, file_name, file_hash, status, grade, school_year_start) VALUES (?, 'v5 的卷子', 'a.pdf', 'h5', 'reviewing', '4', 2024)").run(pid)
  oldDb.prepare("INSERT INTO questions (id, paper_id, ord, no_label, qtype, score) VALUES ('123e4567-e89b-42d3-a456-426614174333', ?, 1, '1', 'MC', 2)").run(pid)
  oldDb.prepare("INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES ('123e4567-e89b-42d3-a456-426614174333', 'GR.NOUN.PLURAL.REG', 1)").run()
  oldDb.exec(`VACUUM INTO '${path.join(O.dir, 'v5-snap.sqlite').replace(/'/g, "''")}'`)
  oldDb.close()
  const man = { format: 'ewb-pack', formatVersion: 1, schemaVersion: 5, appVersion: '0.2.0', exportedAt: '2026-01-01T00:00:00Z', paperCount: 1, questionCount: 1 }
  const zip = path.join(O.dir, 'old.ewb.zip')
  fs.writeFileSync(zip, makeZip([{ name: 'manifest.json', data: JSON.stringify(man) }, { name: 'db.sqlite', data: fs.readFileSync(path.join(O.dir, 'v5-snap.sqlite')), method: 8 }, { name: `files/${pid}/page-1.png`, data: 'png' }]))
  const st = await stageOf(zip, E)
  assert.equal(st.info.originalVersion, 5); assert.equal(st.info.migrated, true)
  const rep = applyMerge(E.deps, st.staged)
  assert.equal(rep.papersAdded, 1); assert.equal(rep.questionsAdded, 1)
  assert.equal(E.db.prepare('SELECT is_sample FROM papers WHERE id = ?').get(pid).is_sample, 0)
  assert.equal(S.distribution(E.db, { includeReviewing: true }).papers, 1, '升级后能正常统计')
  assert.ok(fs.existsSync(path.join(E.filesDir, pid, 'page-1.png')))
  // v3 的包：旧语义里 status = done 表示「提取完成」，升级后是 extracted，不会被误当成"已确认"计入统计
  const v3 = newDb(path.join(O.dir, 'v3.sqlite'), 3).db
  const p3 = '123e4567-e89b-42d3-a456-426614174444'
  v3.prepare("INSERT INTO papers (id, title, file_name, file_hash, status) VALUES (?, 'v3', 'a.pdf', 'h3', 'done')").run(p3)
  v3.exec(`VACUUM INTO '${path.join(O.dir, 'v3-snap.sqlite').replace(/'/g, "''")}'`); v3.close()
  const zip3 = path.join(O.dir, 'v3.ewb.zip')
  fs.writeFileSync(zip3, makeZip([{ name: 'manifest.json', data: JSON.stringify({ ...man, schemaVersion: 3, paperCount: 1, questionCount: 0 }) }, { name: 'db.sqlite', data: fs.readFileSync(path.join(O.dir, 'v3-snap.sqlite')) }]))
  const st3 = await stageOf(zip3, E)
  assert.equal(st3.info.originalVersion, 3)
  applyMerge(E.deps, st3.staged)
  assert.equal(E.db.prepare('SELECT status FROM papers WHERE id = ?').get(p3).status, 'extracted', 'v4 迁移的语义在导入时同样生效')
}

// ─────────── 不干净状态 / 示例卷 / 缺图 / 题目 id 撞车 ───────────
{
  const E = makeEnv('misc')
  const ex = await stageCopy(zipA, E, 'misc')
  const d = openDb(ex.dbPath)
  d.exec("UPDATE papers SET status = 'extracting' WHERE title = '乙'; UPDATE papers SET status = 'parsing' WHERE title = '丙（待审核）'; UPDATE papers SET is_sample = 1 WHERE title = '甲'")
  d.close()
  prep(ex.dbPath)
  fs.rmSync(path.join(ex.filesDir, a2, 'page-2.png'))
  const sum = summarizePack(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(sum.samplesIgnored, 1); assert.equal(sum.papersNew, 2); assert.equal(sum.missingPageImages, 1)
  const rep = applyMerge(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(rep.papersAdded, 2); assert.ok(rep.warnings.some(w => /示例试卷/.test(w)) && rep.warnings.some(w => /1 页的页面图/.test(w)))
  assert.equal(E.db.prepare('SELECT status FROM papers WHERE id = ?').get(a2).status, 'failed', '导出时还在提取的 → 失败，等老师点重试')
  assert.equal(E.db.prepare('SELECT status FROM papers WHERE id = ?').get(a3).status, 'reviewing', '解析中的退回待审核（有题）')
  assert.equal(E.db.prepare('SELECT 1 FROM papers WHERE id = ?').get(a1), undefined, '包里的示例卷被忽略')
}
{
  // 题目 id 与本机已有的题目撞了（不同试卷）→ 整批拒绝，什么都不写
  const E = makeEnv('clash')
  const own = paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-own', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const ownQ = E.db.prepare('SELECT id FROM questions WHERE paper_id = ?').get(own).id
  const ex = await stageCopy(zipA, E, 'clash')
  const d = openDb(ex.dbPath); d.exec('PRAGMA foreign_keys = OFF')
  const oldQ = d.prepare('SELECT id FROM questions WHERE rowid = 1').get().id
  d.prepare('UPDATE questions SET id = ? WHERE id = ?').run(ownQ, oldQ); d.prepare('UPDATE question_kps SET question_id = ? WHERE question_id = ?').run(ownQ, oldQ); d.close()
  prep(ex.dbPath)
  const before = { p: count(E.db, 'SELECT COUNT(*) c FROM papers'), q: count(E.db, 'SELECT COUNT(*) c FROM questions'), files: treeHash(E.filesDir) }
  assert.throws(() => applyMerge(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir }), e => e instanceof PackError && e.code === 'bad_content')
  assert.deepEqual({ p: count(E.db, 'SELECT COUNT(*) c FROM papers'), q: count(E.db, 'SELECT COUNT(*) c FROM questions'), files: treeHash(E.filesDir) }, before, '拒绝后什么都没变')
}
// 知识点代码撞车：两台电脑各自新建的节点编号相同、含义不同 → 包里的换新代码，题目标注跟着换
{
  const F = makeEnv('kpclash')
  F.db.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin) VALUES ('GR.TENSE.U1', 'GR.TENSE', '完全不同的自建', 2, 998, 0)").run()
  const fq = paperWithFiles(F, { title: 'F 的', year: 2025, grade: '4', hash: 'h-f', questions: [Q('GR.TENSE.U1')] }, 1)
  const st = await stageOf(zipA, F)
  const rep = applyMerge(F.deps, st.staged)
  assert.equal(rep.kpsRemapped, 1)
  const names = Object.fromEntries(F.db.prepare("SELECT code, name FROM kps WHERE code LIKE 'GR.TENSE.U%'").all().map(r => [r.code, r.name]))
  assert.deepEqual(names, { 'GR.TENSE.U1': '完全不同的自建', 'GR.TENSE.U2': '自建：时态综合' })
  assert.equal(F.db.prepare('SELECT kp_code FROM question_kps WHERE question_id IN (SELECT id FROM questions WHERE paper_id = ?)').get(fq).kp_code, 'GR.TENSE.U1', 'F 自己的题仍指向它自己的 U1')
  const moved = F.db.prepare(`SELECT kp_code FROM question_kps WHERE question_id IN (SELECT id FROM questions WHERE paper_id = ?) AND kp_code LIKE 'GR.TENSE.U%'`).get(a1)
  assert.equal(moved.kp_code, 'GR.TENSE.U2', '包里那道题的标注改指向新代码')
}

// ─────────── 覆盖导入：失败回滚、备份、崩溃恢复 ───────────
{
  const E = makeEnv('rollback')
  paperWithFiles(E, { title: '本机甲', year: 2024, grade: '4', hash: 'h-r1', questions: [Q('GR.NOUN.PLURAL.REG'), Q('VO.TOPIC.FOOD')] }, 2)
  paperWithFiles(E, { title: '本机乙', year: 2025, grade: '4', hash: 'h-r2', questions: [Q('GR.TENSE.PAST.REG')] }, 1)
  E.db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('ai_key_enc', '\"keep-me\"')").run()
  const snapshot = () => ({ stats: sampleStats(E.db), files: treeHash(E.filesDir), papers: E.db.prepare('SELECT id, title, status FROM papers ORDER BY id').all(), rev: count(E.db, 'SELECT rev c FROM data_rev'), keys: E.db.prepare('SELECT key FROM settings ORDER BY key').all().map(r => r.key), kps: count(E.db, 'SELECT COUNT(*) c FROM kps') })
  const before = snapshot()
  for (const fault of ['after-db', 'after-swap']) {
    const st = await stageOf(zipA, E)
    const stagedFiles = treeHash(st.ex.filesDir)
    await assert.rejects(async () => applyOverwrite({ ...E.deps, fault }, st.staged), e => e instanceof PackError && e.code === 'apply_failed' && /已全部撤销/.test(e.message), fault)
    assert.deepEqual(snapshot(), before, `${fault}：失败后库、文件、设置、修订号、知识点树都和导入前完全一样`)
    assert.equal(readJournal(E.dataDir), null, `${fault}：没有遗留 journal`)
    assert.equal(listBackups(E.dataDir).length, 0, `${fault}：已全部撤销，不遗留没用的备份`)
    assert.deepEqual(treeHash(st.ex.filesDir), stagedFiles, `${fault}：暂存的数据包文件还在，可以直接重试`)
    assert.equal(E.db.prepare('PRAGMA foreign_key_check').all().length, 0)
    assert.equal(count(E.db, "SELECT COUNT(*) c FROM sqlite_master WHERE name = 'imp_papers'"), 0)
    // 失败后马上用同一份暂存重试：成功
    if (fault === 'after-swap') {
      const rep = applyOverwrite(E.deps, st.staged)
      assert.equal(rep.papersAdded, 3)
      assert.equal(count(E.db, 'SELECT COUNT(*) c FROM papers'), 3)
      assert.ok(rep.backup && fs.existsSync(path.join(rep.backup.filesDir)), '成功后：旧 files 目录搬进了备份')
      const bk = openDb(rep.backup.dbFile, { readOnly: true })
      assert.deepEqual(bk.prepare('SELECT title FROM papers ORDER BY title').all().map(r => r.title), ['本机乙', '本机甲'].sort(), '备份里是导入前的库')
      bk.close()
      assert.ok(E.db.prepare("SELECT 1 FROM settings WHERE key = 'ai_key_enc'").get(), '本机的 AI 密钥设置不被覆盖掉')
      assert.equal(readJournal(E.dataDir), null)
    }
  }
}
{
  // 备份只留最新 2 份
  const E = makeEnv('prune')
  paperWithFiles(E, { title: 'x', year: 2025, grade: '4', hash: 'h-x', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  for (let i = 0; i < 4; i++) {
    const st = await stageOf(zipA, E)
    applyOverwrite({ ...E.deps, now: () => new Date(2026, 9, 26, 10, 0, i) }, st.staged)
  }
  assert.equal(listBackups(E.dataDir).length, 2, '导入前备份只留最新的 2 份')
}
// 崩溃恢复：换了目录、没提交就崩溃 → 重启时把目录换回去；已提交 → 只清理 journal
{
  const E = makeEnv('crash')
  paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-cr', questions: [Q('VO.TOPIC.FOOD')] }, 2)
  const filesBefore = treeHash(E.filesDir)
  const bk = path.join(E.dataDir, 'backups', 'pre-import-20261026-100000-abcd')
  fs.mkdirSync(bk, { recursive: true })
  const j = { id: 'crash-1', filesDir: E.filesDir, backupFilesDir: path.join(bk, 'files'), startedAt: 'x' }
  writeJournal(E.dataDir, j)
  fs.renameSync(E.filesDir, j.backupFilesDir)
  fs.mkdirSync(E.filesDir); fs.writeFileSync(path.join(E.filesDir, 'new-junk.txt'), 'x')
  const msg = recoverImportJournal(E.db, E.dataDir)
  assert.match(msg, /没有完成/)
  assert.deepEqual(treeHash(E.filesDir), filesBefore, '恢复后 files 目录就是导入之前的')
  assert.equal(readJournal(E.dataDir), null)
  assert.equal(recoverImportJournal(E.db, E.dataDir), null, '没有未完成的导入时什么都不做')
  // 已提交：库里有 marker
  writeJournal(E.dataDir, { ...j, id: 'crash-2' })
  E.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify('crash-2'))
  const msg2 = recoverImportJournal(E.db, E.dataDir)
  assert.match(msg2, /已提交/)
  assert.deepEqual(treeHash(E.filesDir), filesBefore, '已提交的导入不动文件')
}
// 库里留着上一次（已成功的）覆盖导入的 marker，这一次崩溃的导入不能被误判成"已提交"
{
  const E = makeEnv('crash2')
  paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-cr2', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const filesBefore = treeHash(E.filesDir)
  E.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify('an-older-import'))
  const bk = path.join(E.dataDir, 'backups', 'pre-import-20261026-110000-abcd')
  fs.mkdirSync(bk, { recursive: true })
  const j = { id: 'crash-3', filesDir: E.filesDir, backupFilesDir: path.join(bk, 'files'), startedAt: 'x' }
  writeJournal(E.dataDir, j)
  fs.renameSync(E.filesDir, j.backupFilesDir)
  fs.mkdirSync(E.filesDir); fs.writeFileSync(path.join(E.filesDir, 'junk'), 'x')
  assert.match(recoverImportJournal(E.db, E.dataDir), /没有完成/, 'marker 是别的导入的 → 这次没提交')
  assert.deepEqual(treeHash(E.filesDir), filesBefore)
}
// 合并失败（写库之后 / 搬完目录之后）也完全撤销
{
  const E = makeEnv('mergefail')
  paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-mf', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const snap = () => ({ files: treeHash(E.filesDir), p: count(E.db, 'SELECT COUNT(*) c FROM papers'), q: count(E.db, 'SELECT COUNT(*) c FROM questions'), kps: count(E.db, 'SELECT COUNT(*) c FROM kps'), rev: count(E.db, 'SELECT rev c FROM data_rev') })
  const before = snap()
  for (const fault of ['after-db', 'after-swap']) {
    const st = await stageOf(zipA, E)
    const stagedFiles = treeHash(st.ex.filesDir)
    assert.throws(() => applyMerge({ ...E.deps, fault }, st.staged), e => e instanceof PackError && e.code === 'apply_failed')
    assert.deepEqual(snap(), before, fault)
    assert.deepEqual(treeHash(st.ex.filesDir), stagedFiles, `${fault}：搬过去的目录又搬回暂存了`)
  }
}

// ─────────── 审核返工（M4 审核 P1-1 / P1-2 / P1-3 / P2）───────────
// P1-1：COMMIT 之后的清理失败不能把文件目录换回旧的（库已经是新的了）
{
  const E = makeEnv('aftercommit')
  paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-ac', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const st = await stageOf(zipA, E)
  const stagedFiles = treeHash(st.ex.filesDir)
  const rep = applyOverwrite({ ...E.deps, fault: 'cleanup-fail' }, st.staged)
  assert.equal(rep.papersAdded, 3, '清理失败不影响导入结果：照常返回成功')
  assert.ok(rep.warnings.some(w => /导入已经完成，但清理导入记录时出错/.test(w)), '如实提示（不是「已全部撤销」）：' + rep.warnings.join('|'))
  assert.deepEqual(E.db.prepare('SELECT title FROM papers ORDER BY title').all().map(r => r.title).sort(), ['丙（待审核）', '乙', '甲'].sort(), '库是新的')
  assert.deepEqual(treeHash(E.filesDir), stagedFiles, '文件目录也是新的（没有被换回旧的）')
  assert.ok(rep.backup && fs.existsSync(rep.backup.dbFile) && fs.existsSync(rep.backup.filesDir), '备份还在（没有被当成"已撤销"删掉）')
  assert.ok(readJournal(E.dataDir), 'journal 残留（无害）')
  assert.match(recoverImportJournal(E.db, E.dataDir), /已提交/, '下次启动：marker 一致 → 只清 journal')
  assert.equal(readJournal(E.dataDir), null)
  assert.deepEqual(treeHash(E.filesDir), stagedFiles, '恢复不动文件')
}
// P1-2：导入的设置值逐键校验
{
  const mkSettingsPack = async (tag, rows) => {
    const E = makeEnv(tag)
    const ex = await stageCopy(zipA, E, tag)
    const d = openDb(ex.dbPath)
    d.exec('DELETE FROM settings')
    const ins = d.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
    for (const [k, v] of rows) ins.run(k, v)
    d.close()
    prep(ex.dbPath)
    return { E, staged: { dbPath: ex.dbPath, filesDir: ex.filesDir } }
  }
  const bad = [
    ['ai_prompts', 'null'], ['ui_theme', '5'], ['ui_language', '{"a":1}'], ['default_textbook', '"' + 'x'.repeat(200) + '"']
  ]
  const { E, staged } = await mkSettingsPack('badsettings', bad)
  const rep = applyMerge(E.deps, staged)
  assert.deepEqual(E.db.prepare("SELECT key FROM settings WHERE key <> 'import_marker'").all(), [], '非法的设置值一个都没写进来')
  assert.equal(rep.warnings.filter(w => /已忽略/.test(w)).length, 4, '每个被丢弃的设置都在报告里说明：' + rep.warnings.join('|'))
  // 提示词：部分条目不合格 → 只丢不合格的；P1 的 system 缺 JSON 字样、user 缺必需占位符、类型不对
  const prompts = JSON.stringify({ 'p3_report.system': '好的 P3 system', 'p3_report.user': '缺占位符', 'p1_text.system': '没有那个词', 'p2_yoy.system': 5, 'evil.key': 'x', 'p1_text.user': '{{KNOWLEDGE_TREE}} {{QUESTION_TYPES}} {{OCR_TEXT}}' })
  const m2 = await mkSettingsPack('mixedprompts', [['ai_prompts', prompts], ['ui_theme', '"dark"']])
  const r2 = applyMerge(m2.E.deps, m2.staged)
  assert.deepEqual(JSON.parse(m2.E.db.prepare("SELECT value_json v FROM settings WHERE key = 'ai_prompts'").get().v), { 'p3_report.system': '好的 P3 system', 'p1_text.user': '{{KNOWLEDGE_TREE}} {{QUESTION_TYPES}} {{OCR_TEXT}}' }, '只留合格的条目')
  assert.ok(r2.warnings.some(w => /4 条自定义提示词不合格/.test(w)))
  assert.equal(m2.E.db.prepare("SELECT value_json v FROM settings WHERE key = 'ui_theme'").get().v, '"dark"')
  // 覆盖导入：本机已有的设置（提示词、AI 配置）一律保留，不被包覆盖，也不被清掉
  const o = await mkSettingsPack('keeplocal', [['ai_prompts', JSON.stringify({ 'p3_report.system': '包里的' })], ['default_textbook', '"外研版"']])
  o.E.db.prepare("INSERT INTO settings (key, value_json) VALUES ('ai_prompts', ?)").run(JSON.stringify({ 'p3_report.system': '本机的' }))
  o.E.db.prepare("INSERT INTO settings (key, value_json) VALUES ('ai_config', '{\"base_url\":\"https://x\"}')").run()
  applyOverwrite(o.E.deps, o.staged)
  assert.equal(o.E.db.prepare("SELECT value_json v FROM settings WHERE key = 'ai_prompts'").get().v, JSON.stringify({ 'p3_report.system': '本机的' }), '覆盖导入也保留本机的提示词')
  assert.ok(o.E.db.prepare("SELECT 1 FROM settings WHERE key = 'ai_config'").get(), '本机的 AI 配置还在')
  assert.equal(o.E.db.prepare("SELECT value_json v FROM settings WHERE key = 'default_textbook'").get().v, '"外研版"', '本机没有的补上')
}
// P1-3：示例数据派生的报告 / 分析缓存不进包，导入侧也不收
{
  const E = makeEnv('samplereports')
  paperWithFiles(E, { title: '真实', year: 2025, grade: '4', hash: 'h-sr', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const sp = paperWithFiles(E, { title: '示例卷', year: 2025, grade: '4', hash: 'sample-sr', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  E.db.prepare('UPDATE papers SET is_sample = 1 WHERE id = ?').run(sp)
  const ir = E.db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown) VALUES (?, 'report', ?, '# x')`)
  ir.run('44444444-4444-4444-8444-444444444444', JSON.stringify({ sample: true, grade: '4' })); ir.run('55555555-5555-4555-8555-555555555555', JSON.stringify({ grade: '4' }))
  const ia = E.db.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES (?, 'c', 'v', 'f', ?, 'x')`)
  ia.run('sk-sample', JSON.stringify({ filter: { sample: true } })); ia.run('sk-real', JSON.stringify({ filter: { grade: '4' } }))
  const { out } = await exportOf(E, 'withsamplereports')
  const st = await stageOf(out, E)
  const snap = openDb(st.ex.dbPath)
  assert.deepEqual(snap.prepare('SELECT id FROM reports').all().map(r => r.id), ['55555555-5555-4555-8555-555555555555'], '导出的快照里没有示例筛选生成的报告')
  assert.deepEqual(snap.prepare('SELECT scope_key FROM ai_analyses').all().map(r => r.scope_key), ['sk-real'], '也没有示例范围的 P2 分析缓存')
  snap.close()
  // 导入侧：包里被夹带了示例报告 / 分析（手工构造）→ 不收
  const d = openDb(st.ex.dbPath)
  d.prepare(`INSERT INTO reports (id, kind, filter_json, markdown) VALUES ('44444444-4444-4444-8444-444444444444', 'report', ?, '# x')`).run(JSON.stringify({ sample: true }))
  d.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES ('sk-sample', 'c', 'v', 'f', ?, 'x')`).run(JSON.stringify({ filter: { sample: true } }))
  d.close()
  const F = makeEnv('samplereports2')
  applyMerge(F.deps, st.staged)
  assert.equal(count(F.db, `SELECT COUNT(*) c FROM reports WHERE filter_json LIKE '%"sample":true%'`), 0, '合并导入不收示例报告')
  const G = makeEnv('samplereports3')
  applyOverwrite(G.deps, (await stageOf(out, G)).staged)
  const st2 = await stageOf(out, G); const d2 = openDb(st2.ex.dbPath)
  d2.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES ('sk-sample', 'c', 'v', 'f', ?, 'x')`).run(JSON.stringify({ filter: { sample: true } })); d2.close()
  applyOverwrite(G.deps, st2.staged)
  assert.equal(count(G.db, `SELECT COUNT(*) c FROM ai_analyses WHERE scope_json LIKE '%"sample":true%'`), 0, '覆盖导入也不收示例范围的分析缓存')
}
// P2：覆盖导入时包里知识点树为空 / 缺内置节点 → 整批拒绝，本机的树和数据原样
{
  const E = makeEnv('emptykps')
  paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-ek', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const before = { kps: count(E.db, 'SELECT COUNT(*) c FROM kps'), builtin: count(E.db, 'SELECT COUNT(*) c FROM kps WHERE builtin = 1'), p: count(E.db, 'SELECT COUNT(*) c FROM papers'), files: treeHash(E.filesDir) }
  const ex = await stageCopy(zipA, E, 'emptykps')
  const d = openDb(ex.dbPath); d.exec('PRAGMA foreign_keys = OFF; DELETE FROM kps'); d.close()
  prep(ex.dbPath)
  assert.throws(() => applyOverwrite(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir }), e => e instanceof PackError && e.code === 'bad_content' && /缺少 \d+ 个内置节点/.test(e.message))
  assert.deepEqual({ kps: count(E.db, 'SELECT COUNT(*) c FROM kps'), builtin: count(E.db, 'SELECT COUNT(*) c FROM kps WHERE builtin = 1'), p: count(E.db, 'SELECT COUNT(*) c FROM papers'), files: treeHash(E.filesDir) }, before, '拒绝后本机知识点树、卷子、文件原样')
  assert.equal(listBackups(E.dataDir).length, 0)
  // 缺一个内置节点也拒绝
  const ex2 = await stageCopy(zipA, E, 'missingone')
  const d2 = openDb(ex2.dbPath); d2.exec("PRAGMA foreign_keys = OFF; DELETE FROM kps WHERE code = 'FN.SHOP.PRICE'"); d2.close()
  prep(ex2.dbPath)
  assert.throws(() => applyOverwrite(E.deps, { dbPath: ex2.dbPath, filesDir: ex2.filesDir }), e => e instanceof PackError && /缺少 1 个内置节点/.test(e.message))
}
// P2：不信任包里的 builtin 标志
{
  const E = makeEnv('builtinflag')
  const ex = await stageCopy(zipA, E, 'builtinflag')
  const d = openDb(ex.dbPath)
  d.exec("UPDATE kps SET builtin = 1 WHERE code = 'GR.TENSE.U1'; UPDATE kps SET builtin = 0 WHERE code = 'FN.SHOP'")
  d.close()
  prep(ex.dbPath)
  applyMerge(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(E.db.prepare("SELECT builtin b FROM kps WHERE code = 'GR.TENSE.U1'").get().b, 0, '包里新出现的节点即使标成内置也按自建写入（能删除、能移动）')
  assert.equal(E.db.prepare("SELECT builtin b FROM kps WHERE code = 'FN.SHOP'").get().b, 1, '本机的内置节点不被包里的标志改掉')
  const G = makeEnv('builtinflag2')
  const ex2 = await stageCopy(zipA, G, 'builtinflag2')
  const d2 = openDb(ex2.dbPath); d2.exec("UPDATE kps SET builtin = 1 WHERE code = 'GR.TENSE.U1'; UPDATE kps SET builtin = 0 WHERE code = 'FN.SHOP'"); d2.close()
  prep(ex2.dbPath)
  applyOverwrite(G.deps, { dbPath: ex2.dbPath, filesDir: ex2.filesDir })
  assert.equal(G.db.prepare("SELECT builtin b FROM kps WHERE code = 'GR.TENSE.U1'").get().b, 0, '覆盖导入同样：builtin 只认本机的内置代码')
  assert.equal(G.db.prepare("SELECT builtin b FROM kps WHERE code = 'FN.SHOP'").get().b, 1)
}
// P2：journal 存相对路径，恢复时路径必须在数据目录之内
{
  const E = makeEnv('journalpath')
  const bk = path.join(E.dataDir, 'backups', 'pre-import-20261026-120000-abcd')
  fs.mkdirSync(bk, { recursive: true })
  writeJournal(E.dataDir, { id: 'jp-1', filesDir: E.filesDir, backupFilesDir: path.join(bk, 'files'), startedAt: 'x' })
  const raw = fs.readFileSync(path.join(E.dataDir, 'import-journal.json'), 'utf8')
  assert.ok(!raw.includes(E.dataDir) && JSON.parse(raw).filesRel === 'files', 'journal 里没有绝对路径：' + raw)
  assert.deepEqual([readJournal(E.dataDir).filesDir, readJournal(E.dataDir).backupFilesDir], [E.filesDir, path.join(bk, 'files')], '读回来是数据目录下的绝对路径（整个目录搬到别处也对）')
  // 被改成指向数据目录之外 → 认为 journal 无效，恢复什么都不动
  const outside = path.join(E.dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious.txt'), 'x')
  for (const evil of [
    { filesRel: '../outside', backupFilesRel: 'backups/pre-import-20261026-120000-abcd/files' }, { filesRel: 'files', backupFilesRel: outside }, { filesRel: '', backupFilesRel: 'backups/x' },
    // 复审 P2-5：在数据目录里面也不行——只认 files 和 backups/pre-import-…/files
    { filesRel: 'files', backupFilesRel: 'papers' }, { filesRel: 'db-backup', backupFilesRel: 'backups/pre-import-20261026-120000-abcd/files' },
    { filesRel: 'files', backupFilesRel: 'backups/pre-import-20261026-120000-abcd/files/../../..' }, { filesRel: 'files', backupFilesRel: 'backups/other/files' },
    { filesRel: 'files/..', backupFilesRel: 'backups/pre-import-20261026-120000-abcd/files' }
  ]) {
    fs.writeFileSync(path.join(E.dataDir, 'import-journal.json'), JSON.stringify({ id: 'jp-2', startedAt: 'x', ...evil }))
    assert.equal(readJournal(E.dataDir), null, JSON.stringify(evil))
    assert.throws(() => recoverImportJournal(E.db, E.dataDir), /无法识别/, '不认的 journal 不是静默忽略，要抛错让界面提示：' + JSON.stringify(evil))
    assert.ok(!fs.existsSync(path.join(E.dataDir, 'import-journal.json')), '不认的 journal 改名留作线索，不会每次启动都重复')
    assert.ok(fs.readdirSync(E.dataDir).some(n => n.startsWith('import-journal.json.invalid-')), '留有 .invalid- 文件')
    assert.equal(recoverImportJournal(E.db, E.dataDir), null, '改名之后不再重复报')
    assert.ok(fs.existsSync(path.join(outside, 'precious.txt')) && fs.existsSync(E.filesDir), '数据目录之外的东西没被动')
    for (const n of fs.readdirSync(E.dataDir)) if (n.startsWith('import-journal.json.invalid-')) fs.rmSync(path.join(E.dataDir, n))
  }
  // 损坏的 JSON 也一样
  fs.writeFileSync(path.join(E.dataDir, 'import-journal.json'), '{not json')
  assert.throws(() => recoverImportJournal(E.db, E.dataDir), /无法识别/)
  // Windows 风格的反斜杠写法仍然认（同一个合法位置）
  fs.writeFileSync(path.join(E.dataDir, 'import-journal.json'), JSON.stringify({ id: 'jp-3', startedAt: 'x', filesRel: 'files', backupFilesRel: 'backups\\pre-import-20261026-120000-abcd\\files' }))
  assert.equal(readJournal(E.dataDir)?.backupFilesDir, path.join(bk, 'files'))
  fs.rmSync(path.join(E.dataDir, 'import-journal.json'))
}
// 复审 P2-5：崩溃恢复的各个时间点
{
  // ① journal 写好了、files 还没改名（备份里没有 files）：不动任何东西，如实说「保持现状」
  const E1 = makeEnv('stage1')
  paperWithFiles(E1, { title: '本机', year: 2025, grade: '4', hash: 'h-s1', questions: [Q('VO.TOPIC.FOOD')] }, 2)
  const before1 = treeHash(E1.filesDir)
  const bk1 = path.join(E1.dataDir, 'backups', 'pre-import-20261026-130000-abcd'); fs.mkdirSync(bk1, { recursive: true })
  writeJournal(E1.dataDir, { id: 's1', filesDir: E1.filesDir, backupFilesDir: path.join(bk1, 'files'), startedAt: 'x' })
  assert.match(recoverImportJournal(E1.db, E1.dataDir), /没有完成.*保持现状/)
  assert.deepEqual(treeHash(E1.filesDir), before1, '① files 原样')
  assert.equal(readJournal(E1.dataDir), null)
  // ② 旧 files 已经改名进备份、新的还没放进去（files 不存在）：把备份里的换回来
  const E2 = makeEnv('stage2')
  paperWithFiles(E2, { title: '本机', year: 2025, grade: '4', hash: 'h-s2', questions: [Q('VO.TOPIC.FOOD')] }, 2)
  const before2 = treeHash(E2.filesDir)
  const bk2 = path.join(E2.dataDir, 'backups', 'pre-import-20261026-130100-abcd'); fs.mkdirSync(bk2, { recursive: true })
  writeJournal(E2.dataDir, { id: 's2', filesDir: E2.filesDir, backupFilesDir: path.join(bk2, 'files'), startedAt: 'x' })
  fs.renameSync(E2.filesDir, path.join(bk2, 'files'))
  assert.ok(!fs.existsSync(E2.filesDir))
  assert.match(recoverImportJournal(E2.db, E2.dataDir), /换回导入之前/)
  assert.deepEqual(treeHash(E2.filesDir), before2, '② files 被换回')
  assert.ok(!fs.existsSync(path.join(bk2, 'files')))
  // ③ 新旧都换好了、没提交：已有 crash 用例覆盖（换回旧的、新的丢弃）
  // ④ 恢复自己失败（目录被占用）：抛错、journal 留着，下次启动还能再试
  const E4 = makeEnv('stage4')
  paperWithFiles(E4, { title: '本机', year: 2025, grade: '4', hash: 'h-s4', questions: [Q('VO.TOPIC.FOOD')] }, 1)
  const bk4 = path.join(E4.dataDir, 'backups', 'pre-import-20261026-130200-abcd'); fs.mkdirSync(bk4, { recursive: true })
  writeJournal(E4.dataDir, { id: 's4', filesDir: E4.filesDir, backupFilesDir: path.join(bk4, 'files'), startedAt: 'x' })
  fs.renameSync(E4.filesDir, path.join(bk4, 'files'))
  const realRename = fs.renameSync
  fs.renameSync = (a, b) => { if (String(a).startsWith(bk4)) { const e = new Error('EBUSY: simulated'); e.code = 'EBUSY'; throw e } return realRename(a, b) }
  try { assert.throws(() => recoverImportJournal(E4.db, E4.dataDir), /EBUSY/) } finally { fs.renameSync = realRename }
  assert.ok(readJournal(E4.dataDir), '恢复失败时 journal 还在，下次启动再试')
}
// P2：Windows 上目录改名遇到临时占用 → 有限次重试；别的错误立刻抛
{
  let n = 0
  assert.equal(withRetry(() => { if (++n < 3) { const e = new Error('busy'); e.code = 'EBUSY'; throw e } return 'ok' }, 5, 1), 'ok'); assert.equal(n, 3)
  n = 0
  assert.throws(() => withRetry(() => { n++; const e = new Error('exists'); e.code = 'EEXIST'; throw e }, 5, 1), /exists/); assert.equal(n, 1, '非临时错误不重试')
  n = 0
  assert.throws(() => withRetry(() => { n++; const e = new Error('perm'); e.code = 'EPERM'; throw e }, 4, 1), /perm/); assert.equal(n, 4, '一直占用：重试到上限后抛出')
}

// ─────────── 复审返工 P2-1：导入的知识点树要校验 ───────────
{
  const L3 = A.db.prepare("SELECT code FROM kps WHERE level = 3 AND builtin = 1 ORDER BY code LIMIT 1").get().code
  const L2 = A.db.prepare("SELECT code FROM kps WHERE level = 2 AND builtin = 1 ORDER BY code LIMIT 1").get().code
  const cases = [
    ['层级超范围', d => d.exec(`UPDATE kps SET level = 4 WHERE code = '${L3}'`), /层级/],
    ['层级和上级对不上', d => d.exec(`UPDATE kps SET level = 2 WHERE code = '${L3}'`), /对不上/],
    ['上级不存在', d => d.exec(`UPDATE kps SET parent_code = 'NO.SUCH.PARENT' WHERE code = '${L3}'`), /上级.*不存在/],
    ['没有上级却不是第 1 层', d => d.exec(`UPDATE kps SET parent_code = NULL WHERE code = '${L3}'`), /第 1 层/],
    ['成环（层级一起伪造）', d => d.exec(`UPDATE kps SET parent_code = '${L3}', level = 3 WHERE code = '${L2}'; UPDATE kps SET parent_code = '${L2}', level = 3 WHERE code = '${L3}'`), /成环|对不上|层级/],
    ['名称过长', d => d.exec(`UPDATE kps SET name = '${'长'.repeat(31)}' WHERE code = '${L3}'`), /名称超过 30/],
    ['名称为空', d => d.exec(`UPDATE kps SET name = '  ' WHERE code = '${L3}'`), /没有名称/],
    ['说明过长', d => d.exec(`UPDATE kps SET note = '${'说'.repeat(501)}' WHERE code = '${L3}'`), /说明超过 500/],
    ['引入年级越界', d => d.exec(`UPDATE kps SET intro_grade = 9 WHERE code = '${L3}'`), /引入年级/],
    ['引入年级不是整数', d => d.exec(`UPDATE kps SET intro_grade = 2.5 WHERE code = '${L3}'`), /引入年级/]
  ]
  for (const [label, mutate, re] of cases) {
    const E = makeEnv('kpbad')
    const ex = await stageCopy(zipA, E, 'kp-' + label)
    const d = openDb(ex.dbPath); mutate(d); d.close()
    assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'bad_content' && re.test(e.message), `${label}：暂存校验要拒绝`)
  }
  // 正常的包不受影响（A 的包里有自建节点 GR.TENSE.U1 也照样通过）
  const okEx = await stageCopy(zipA, makeEnv('kpok'), 'kp-ok')
  prep(okEx.dbPath)

  // 合并：包里把本机的 3 级内置节点说成根节点、再往下挂 2 层 → 合并后实际会超过 3 层，整批拒绝，本机树一个字不变
  const M = makeEnv('kpmerge')
  const exm = await stageCopy(zipA, M, 'kp-merge')
  const d = openDb(exm.dbPath)
  d.exec(`UPDATE kps SET parent_code = NULL, level = 1 WHERE code = '${L3}'`)
  d.exec(`INSERT INTO kps (code, parent_code, name, level, sort, builtin) VALUES ('X.C', '${L3}', 'C', 2, 1, 0), ('X.D', 'X.C', 'D', 3, 1, 0)`)
  d.close()
  const infoM = prep(exm.dbPath)
  assert.ok(infoM.papers >= 1, '这个包本身是自洽的，暂存校验通过')
  const treeBefore = M.db.prepare('SELECT code, parent_code, level, name FROM kps ORDER BY code').all()
  assert.throws(() => applyMerge(M.deps, { dbPath: exm.dbPath, filesDir: exm.filesDir }), e => e instanceof PackError && e.code === 'bad_content' && /超过 3 层/.test(e.message))
  assert.deepEqual(M.db.prepare('SELECT code, parent_code, level, name FROM kps ORDER BY code').all(), treeBefore, '被拒绝后本机的知识点树完全没变')
  assert.equal(count(M.db, 'SELECT COUNT(*) c FROM papers'), 0, '事务整体回滚：卷子也没进来')
}

// ─────────── 复审返工 P1-A：导出读文件失败不能把主进程带崩 / 让导出永远不结束 ───────────
{
  // yazl 读文件失败时，error 是发在 ZipFile 上的（不在 outputStream 上）：漏监听 → 主进程未捕获异常 + buildPack 的 Promise 永不结束
  const uncaught = []
  const onUncaught = e => uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  const realCreate = fs.createReadStream
  const failWith = code => {
    fs.createReadStream = (p, ...rest) => {
      if (!String(p).endsWith(`${path.sep}page-1.png`)) return realCreate.call(fs, p, ...rest)
      const r = new Readable({ read() {} })
      setImmediate(() => { const e = new Error(`${code}: simulated`); e.code = code; r.destroy(e) })
      return r
    }
  }
  try {
    for (const [code, re] of [['EBUSY', /占用|写入权限|导出失败/], ['EIO', /导出失败/]]) {
      failWith(code)
      const out = path.join(A.dir, `fail-${code}.ewb.zip`)
      const tmp = path.join(A.dir, `tmp-fail-${code}`)
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('buildPack 没有结束（Promise 永不 settle）')), 4000))
      const r = await Promise.race([
        buildPack({ db: A.db, openDb, filesDir: A.filesDir, outPath: out, tmpDir: tmp, appVersion: '0.4.0-test' }).then(() => null, e => e),
        timer
      ])
      assert.ok(r instanceof PackError && r.code === 'io', `${code}：读文件失败应当 reject 一个 PackError，实际 ${r}`)
      assert.match(r.message, re, `${code}：给出中文原因`)
      assert.equal(uncaught.length, 0, `${code}：不能有未捕获异常：${uncaught.map(String)}`)
      assert.ok(!fs.existsSync(`${out}.part`), `${code}：半成品 .part 已清理`)
      assert.ok(!fs.existsSync(out), `${code}：不会留下数据包`)
      assert.ok(!fs.existsSync(path.join(tmp, 'snapshot.sqlite')), `${code}：快照临时文件已清理`)
    }
    // 失败之后，同一个库再导出必须完全正常（锁 / 状态没有被污染）
    fs.createReadStream = realCreate
    const ok = await exportOf(A, 'after-fail')
    assert.ok(fs.existsSync(ok.out) && !fs.existsSync(`${ok.out}.part`))
    assert.equal(ok.res.entries, 2 + ok.res.manifest.fileCount)
  } finally {
    fs.createReadStream = realCreate
    process.off('uncaughtException', onUncaught)
  }
}

fs.rmSync(root, { recursive: true, force: true })
console.log('pack-db.test ✓')
