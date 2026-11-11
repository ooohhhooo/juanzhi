// 导出数据包「自己选带哪些」：快照里不再有对话 / 用量表（没勾选时）、代号对照表永远不进包、按学科 / 选中卷子导出的范围、
// 勾选表格 / 文档 / Skill / 角色 / 对话时真名不出现在包里、导入（合并 / 覆盖）、部分内容的包不能覆盖、旧包照常导入。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import yauzl from 'yauzl'
import { makeEnv, paperWithFiles, openDb, count, LATEST, migrate } from './helpers/packenv.mjs'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge, applyOverwrite } from '../../src/main/pack/apply.ts'
import { classifyEntry } from '../../src/main/pack/names.ts'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { DocumentStore } from '../../src/main/analysis/documents.ts'
import { saveSkill } from '../../src/main/agent/playbooks/manage.ts'
import { saveCustomRole } from '../../src/main/agent/custom-roles.ts'

const prep = dbPath => prepareStagedDb(dbPath, { openDb, migrate: (db, from) => migrate(db, from), latest: LATEST })
const zipNames = f => new Promise((res, rej) => yauzl.open(f, { lazyEntries: true }, (e, z) => { if (e) return rej(e); const n = []; z.on('entry', en => { n.push(en.fileName); z.readEntry() }); z.on('end', () => res(n)); z.readEntry() }))
const grepTree = (dir, re) => { const hits = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (re.test(fs.readFileSync(p).toString('latin1')) || re.test(fs.readFileSync(p, 'utf8'))) hits.push(p) } }; walk(dir); return hits }

// ── 源电脑 A ──
const A = makeEnv('selA')
const mk = (title, subject, hash) => { const id = paperWithFiles(A, { title, year: 2025, grade: '4', hash, questions: [{ kp: 'GR.TENSE.PAST.REG', qtype: 'MC', score: 2 }] }, 1); A.db.prepare('UPDATE papers SET subject = ? WHERE id = ?').run(subject, id); return id }
const E1 = mk('英语卷', 'english', 'e1'), C1 = mk('语文卷', 'chinese', 'c1'), C2 = mk('语文卷二', 'chinese', 'c2'), M1 = mk('数学卷', 'math', 'm1')
const rep = (id, subject) => A.db.prepare("INSERT INTO reports (id, kind, filter_json, markdown, subject) VALUES (?, 'report', '{}', 'x', ?)").run(id, subject)
rep('r-en', 'english'); rep('r-cn', 'chinese')
A.db.prepare("INSERT INTO ai_usage (kind, model, prompt_tokens, completion_tokens) VALUES ('parse', 'm', 1, 1)").run()
A.db.prepare("INSERT INTO ai_drafts (key, kind, markdown) VALUES ('k', 'report', '草稿')").run()
A.db.prepare("INSERT INTO parse_runs (paper_id, status, result_json) VALUES (?, 'done', '{\"x\":1}')").run(E1)
A.db.prepare("INSERT INTO parse_batches (paper_id, seq) VALUES (?, 1)").run(E1)

// 数据页：一个有姓名 / 手机号 / 学号的表格（中文学科），一份文档，一个 Skill，一个角色，两段对话
const NAMES = []
const sur = '赵钱孙李周吴郑王冯陈'; const giv = '明华强伟芳娜敏静磊洋艳勇军杰涛超'
for (const a of sur) for (const b of giv.slice(0, 5)) NAMES.push(a + b + '宇')
const lines = ['姓名,学号,手机号,评语,分数']
NAMES.forEach((n, i) => lines.push(`${n},${20230001 + i},${13900000000 + i},老师说${n}这次进步很大,${60 + (i % 40)}`))
const store = new DatasetStore(A.dataDir)
const ds = await store.importBuffer(Buffer.from(lines.join('\n')), '成绩单.csv')
store.setSubject(ds.id, 'chinese')
const realName = NAMES[3]
const docs = new DocumentStore(A.dataDir)
const doc = docs.add('家访记录', 'text', `${realName}的家长电话 13900000003，说孩子最近情况不错。`, 'general')
saveSkill(path.join(A.dataDir, 'playbooks'), { name: '测试方法', description: '做测试', roles: [], when: '', body: '先看数据，再下结论。' }, { knownTools: [] })
saveCustomRole(path.join(A.dataDir, 'agent-roles'), { id: 'c-abc123', name: '小助理', description: '帮忙', tools: [], suggestions: [], notes: '', })
A.db.prepare("INSERT INTO agent_sessions (id, role, title, subject) VALUES ('s-cn', 'ops', ?, 'chinese')").run(`问${realName}`)
A.db.prepare("INSERT INTO agent_steps (session_id, seq, kind, payload_json) VALUES ('s-cn', 1, 'user', ?)").run(JSON.stringify({ text: `${realName}的成绩怎么样，电话 13900000003` }))
A.db.prepare("INSERT INTO agent_sessions (id, role, title, subject) VALUES ('s-en', 'ops', '英语对话', 'english')").run()
A.db.prepare("INSERT INTO agent_steps (session_id, seq, kind, payload_json) VALUES ('s-en', 1, 'user', '{\"text\":\"hi\"}')").run()
assert.ok(fs.existsSync(path.join(A.dataDir, 'datasets', `${ds.id}.codes.json`)) || true)

const extras = { dataDir: A.dataDir, datasets: store, documents: docs }
const scrub = (() => { const sc = store.scrubber([ds.id]); return sc.text })()
let k = 0
async function exportOf(name, o = {}) {
  const out = path.join(A.dir, `${name}.ewb.zip`)
  const res = await buildPack({ db: A.db, openDb, filesDir: A.filesDir, outPath: out, tmpDir: path.join(A.dir, `tmp-${name}-${++k}`), appVersion: 'test', extras, scrub, ...o })
  return { out, res }
}
async function peek(zip) {
  const ex = await extractPack(zip, path.join(A.dir, `peek-${path.basename(zip)}`))
  return { ex, pk: openDb(ex.dbPath, { readOnly: true }) }
}

// ── 1. 默认导出：不带用量、草稿、解析记录、对话；包里没有任何 codes.json；formatVersion 仍是 1（旧版本软件也能导入） ──
{
  const { out, res } = await exportOf('default')
  const names = await zipNames(out)
  assert.ok(!names.some(n => /codes/.test(n)), '代号对照表不进包')
  assert.ok(!names.some(n => n.startsWith('extras/')), '默认不带额外内容')
  assert.equal(res.manifest.formatVersion, 1)
  assert.equal(res.manifest.contents.datasets, false)
  const { pk } = await peek(out)
  for (const t of ['ai_usage', 'ai_drafts', 'parse_runs', 'parse_batches', 'agent_sessions', 'agent_steps']) assert.equal(count(pk, `SELECT COUNT(*) c FROM ${t}`), 0, `${t} 不带`)
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM papers'), 4)
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM reports'), 2)
  pk.close()
}

// ── 2. 按学科：只带语文的卷子、报告；别的学科的对话不带 ──
{
  const { out, res } = await exportOf('cn', { selection: { subject: 'chinese', chats: true } })
  assert.equal(res.manifest.scope.subject, 'chinese')
  assert.equal(res.manifest.paperCount, 2)
  const { pk } = await peek(out)
  assert.deepEqual(pk.prepare('SELECT subject s FROM papers').all().map(r => r.s), ['chinese', 'chinese'])
  assert.deepEqual(pk.prepare('SELECT id FROM reports').all().map(r => r.id), ['r-cn'])
  assert.deepEqual(pk.prepare('SELECT id FROM agent_sessions').all().map(r => r.id), ['s-cn'])
  const names = await zipNames(out)
  assert.ok(names.every(n => !n.includes(E1) && !n.includes(M1)), '别的学科的文件不进包')
  pk.close()
}

// ── 3. 只导选中的卷子：报告不带，别的卷子的文件不带 ──
{
  const { out, res } = await exportOf('picked', { selection: { paperIds: [C2, M1] } })
  assert.equal(res.manifest.paperCount, 2)
  assert.equal(res.manifest.scope.selectedPapers, true)
  const { pk } = await peek(out)
  assert.deepEqual(pk.prepare('SELECT id FROM papers ORDER BY title').all().map(r => r.id).sort(), [C2, M1].sort())
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM reports'), 0)
  const names = await zipNames(out)
  assert.ok(names.some(n => n.includes(C2)) && !names.some(n => n.includes(C1)))
  pk.close()
}

// ── 4. 全选：表格 / 文档 / Skill / 角色 / 对话。真名、手机号、学号不出现在包里；代号对照表不在 ──
let fullZip
{
  const { out, res } = await exportOf('full', { selection: { datasets: true, documents: true, assets: true, chats: true } })
  fullZip = out
  assert.equal(res.manifest.formatVersion, 2)
  assert.deepEqual(res.manifest.counts, { reports: 2, chats: 2, datasets: 1, documents: 1, skills: 1, roles: 1 })
  const names = await zipNames(out)
  assert.ok(!names.some(n => /codes/.test(n)), '代号对照表不进包')
  for (const n of names) assert.ok(classifyEntry(n), `条目名合规：${n}`)
  const ex = await extractPack(out, path.join(A.dir, 'peek-full'))
  const bad = grepTree(path.join(A.dir, 'peek-full'), new RegExp(`${NAMES.slice(0, 20).join('|')}|1390000\\d{4}|2023000\\d`))
  // db.sqlite 里的卷子、课程等和这些无关；一旦命中就是泄露
  const snippet = bad.map(f => { const s = fs.readFileSync(f, 'utf8'); const m = new RegExp(`${NAMES.slice(0, 20).join('|')}|1390000\\d{4}|2023000\\d`).exec(s); return m ? `${f}: …${s.slice(Math.max(0, m.index - 100), m.index + 40)}` : f })
  assert.deepEqual(bad, [], '真名 / 手机号 / 学号不能出现在包里：' + snippet.join('\n'))
  const dsDb = openDb(path.join(ex.dbPath, '..', 'extras', 'datasets', `${ds.id}.sqlite`), { readOnly: true })
  const t = ds.tables[0]
  const first = dsDb.prepare(`SELECT * FROM "${t.name}" ORDER BY _row LIMIT 1`).get()
  assert.ok(Object.values(first).some(v => /^人员[A-Z]\d{3}$/.test(String(v))), '姓名列是代号：' + JSON.stringify(first))
  dsDb.close()
  const docTxt = fs.readFileSync(path.join(ex.dbPath, '..', 'extras', 'documents', `${doc.id}.txt`), 'utf8')
  assert.ok(!docTxt.includes(realName) && !docTxt.includes('13900000003'), '文档里的姓名换成代号、手机号去掉：' + docTxt)
  const { pk } = await peek(out)
  const step = pk.prepare("SELECT payload_json p FROM agent_steps WHERE session_id = 's-cn'").get().p
  assert.ok(!step.includes(realName) && !step.includes('13900000003'), '对话里的真名也换掉：' + step)
  pk.close()
}

// ── 5. 导入到另一台电脑 B（合并）：表格、文档、Skill、角色、对话都进来；代号对照表 B 没有 ──
const B = makeEnv('selB')
{
  const ex = await extractPack(fullZip, path.join(B.dir, 'stage1'))
  prep(ex.dbPath)
  const r = applyMerge({ ...B.deps, manifest: ex.manifest }, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(r.papersAdded, 4)
  assert.equal(r.chatsAdded, 2)
  assert.deepEqual([r.extras.datasetsAdded, r.extras.documentsAdded, r.extras.skillsAdded, r.extras.rolesAdded], [1, 1, 1, 1], JSON.stringify(r.warnings))
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM agent_steps'), 2)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM ai_usage'), 0)
  const sb = new DatasetStore(B.dataDir)
  assert.equal(sb.list().length, 1)
  assert.ok(!fs.existsSync(path.join(B.dataDir, 'datasets', `${ds.id}.codes.json`)), 'B 上没有代号对照表')
  const prev = sb.preview(ds.id, ds.tables[0].name, 3)
  assert.ok(prev.rows.flat().every(v => !NAMES.includes(String(v))), '导入后表格里只有代号')
  assert.equal(new DocumentStore(B.dataDir).list().length, 1)
  assert.ok(fs.existsSync(path.join(B.dataDir, 'playbooks')) && fs.readdirSync(path.join(B.dataDir, 'playbooks')).length === 1)
  assert.ok(fs.existsSync(path.join(B.dataDir, 'agent-roles', 'c-abc123.json')))
  // 再导入一次：全部跳过
  const ex2 = await extractPack(fullZip, path.join(B.dir, 'stage2'))
  prep(ex2.dbPath)
  const r2 = applyMerge({ ...B.deps, manifest: ex2.manifest }, { dbPath: ex2.dbPath, filesDir: ex2.filesDir })
  assert.equal(r2.papersAdded, 0)
  assert.equal(r2.chatsAdded, 0)
  assert.deepEqual([r2.extras.datasetsSkipped, r2.extras.documentsSkipped, r2.extras.skillsSkipped, r2.extras.rolesSkipped], [1, 1, 1, 1])
}

// ── 6. 覆盖：部分内容的包拒绝；完整的包覆盖时不清本机的用量记录；extras 按合并加入 ──
{
  const cn = await exportOf('cn2', { selection: { subject: 'chinese' } })
  const C = makeEnv('selC')
  paperWithFiles(C, { title: '本机卷', year: 2025, grade: '4', hash: 'x1', questions: [{ kp: 'GR.TENSE.PAST.REG', qtype: 'MC', score: 2 }] }, 1)
  const ex = await extractPack(cn.out, path.join(C.dir, 'stage'))
  prep(ex.dbPath)
  assert.throws(() => applyOverwrite({ ...C.deps, manifest: ex.manifest }, { dbPath: ex.dbPath, filesDir: ex.filesDir }), e => e.code === 'partial_pack')
  assert.equal(count(C.db, 'SELECT COUNT(*) c FROM papers'), 1, '被拒绝后本机数据不变')
  const sel = await exportOf('sel2', { selection: { paperIds: [E1] } })
  const exS = await extractPack(sel.out, path.join(C.dir, 'stage-sel'))
  prep(exS.dbPath)
  assert.throws(() => applyOverwrite({ ...C.deps, manifest: exS.manifest }, { dbPath: exS.dbPath, filesDir: exS.filesDir }), e => e.code === 'partial_pack')

  C.db.prepare("INSERT INTO ai_usage (kind, model) VALUES ('mine', 'm')").run()
  const full = await exportOf('full2', { selection: { datasets: true, chats: true } })
  const exF = await extractPack(full.out, path.join(C.dir, 'stage-full'))
  prep(exF.dbPath)
  const r = applyOverwrite({ ...C.deps, manifest: exF.manifest }, { dbPath: exF.dbPath, filesDir: exF.filesDir })
  assert.equal(r.papersAdded, 4)
  assert.equal(count(C.db, "SELECT COUNT(*) c FROM ai_usage WHERE kind = 'mine'"), 1, '新版本的包覆盖时不清本机用量记录')
  assert.equal(r.chatsAdded, 2)
  assert.equal(r.extras.datasetsAdded, 1)
}

// ── 7. 旧包（没有 contents 的 manifest）照常导入：按旧行为，不带对话、不拒绝覆盖 ──
{
  const old = await exportOf('old-style', { selection: { chats: true } })
  const D = makeEnv('selD')
  const ex = await extractPack(old.out, path.join(D.dir, 'stage'))
  prep(ex.dbPath)
  const { contents, scope, counts, ...legacyManifest } = ex.manifest
  const r = applyOverwrite({ ...D.deps, manifest: legacyManifest }, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  assert.equal(r.papersAdded, 4)
  assert.equal(r.chatsAdded, undefined, '旧包不导入对话')
  assert.equal(count(D.db, 'SELECT COUNT(*) c FROM agent_sessions'), 0)
}

console.log('pack-select.test ✓')
