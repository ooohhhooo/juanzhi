// 数据包里的内置教材：kind / builtin_id / source='builtin' 随包走；旧包（课程大纲没有这两列）照常导入，缺的列取默认（机构课程）。
// 另：整本书上传认出版本后的内置目录登记（版本名映射、单元）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeEnv, paperWithFiles, openDb, count, LATEST, migrate } from './helpers/packenv.mjs'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge } from '../../src/main/pack/apply.ts'
import { createOutline, listOutlines, mapRows } from '../../src/main/course/store.ts'
import { addBuiltinTextbook, makeCatalogProvider, markBuiltinChecked } from '../../src/main/course/textbook-builtin.ts'
import { CATALOG } from '../../src/main/course/catalog.ts'

const prep = dbPath => prepareStagedDb(dbPath, { openDb, migrate: (db, from) => migrate(db, from), latest: LATEST })
async function exportOf(env, name) {
  const out = path.join(env.dir, `${name}.ewb.zip`)
  await buildPack({ db: env.db, openDb, filesDir: env.filesDir, outPath: out, tmpDir: path.join(env.dir, `tmp-${name}`), appVersion: 'test' })
  return out
}
const stage = async (zip, env, mutate) => {
  const ex = await extractPack(zip, path.join(env.dir, `stage-${path.basename(zip)}`))
  if (mutate) { const d = openDb(ex.dbPath); try { mutate(d) } finally { d.close() } }
  prep(ex.dbPath)
  return { dbPath: ex.dbPath, filesDir: ex.filesDir }
}

const ed = CATALOG.find(e => e.id === 'math-renjiao')
const A = makeEnv('tbA')
paperWithFiles(A, { title: '甲', year: 2025, grade: '1', hash: 'h1', questions: [{ kp: 'MA.NUM.INT.COUNT', qtype: 'MA_CALC', score: 2 }] }, 1)
A.db.prepare("UPDATE papers SET subject = 'math'").run()
const tb = addBuiltinTextbook(A.db, ed, ['1上'])
const plain = createOutline(A.db, { name: '机构课', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', subject: 'math', levels: [{ name: 'L', lessons: [{ seq: 1, noLabel: '1', title: 't', theme: '', textbookRef: '', points: [], raw: {} }] }] })

// 合并导入到 B：教材的类型、内置来源、内置对应（source = builtin）都保留
{
  const B = makeEnv('tbB')
  const zip = await exportOf(A, 'new')
  const rep = applyMerge(B.deps, await stage(zip, B))
  assert.equal(rep.coursesAdded, 2)
  const cards = listOutlines(B.db, 'math')
  const got = cards.find(c => c.id === tb.id)
  assert.deepEqual([got.kind, got.builtinId, got.match.state], ['textbook', 'math-renjiao:1上', 'done'])
  assert.equal(cards.find(c => c.id === plain).kind, 'course')
  assert.ok(mapRows(B.db, tb.id).length > 0 && mapRows(B.db, tb.id).every(m => m.source === 'builtin' && m.state === 'confirmed'), '内置对应的来源不被改成 ai')
  assert.equal(B.db.prepare('PRAGMA foreign_key_check').all().length, 0)
}

// 旧包：课程大纲表没有 kind / builtin_id 两列（版本号也退回 14），导入后都是机构课程
{
  const C = makeEnv('tbC')
  const zip = await exportOf(A, 'old')
  const rep = applyMerge(C.deps, await stage(zip, C, d => {
    d.exec('DROP INDEX IF EXISTS idx_course_outlines_kind; ALTER TABLE course_outlines DROP COLUMN kind; ALTER TABLE course_outlines DROP COLUMN builtin_id; PRAGMA user_version = 14')
  }))
  assert.equal(rep.coursesAdded, 2)
  const cards = listOutlines(C.db, 'math')
  assert.deepEqual(cards.map(c => [c.kind, c.builtinId]), [['course', ''], ['course', '']])
}

// ── 整本书上传的内置目录登记 ──
{
  const prov = makeCatalogProvider(CATALOG)
  assert.deepEqual(prov.find({ subject: 'math', edition: '人教版', grade: 1, semester: 1 })?.id, 'math-renjiao:1上')
  assert.match(prov.find({ subject: 'math', edition: '人教版', grade: 1, semester: 1 }).label, /人教版 一年级上册/)
  assert.equal(prov.find({ subject: 'english', edition: '人教版', grade: 3, semester: 1 })?.id, 'english-pep:3上', '英语的「人教版」就是人教PEP')
  assert.equal(prov.find({ subject: 'english', edition: '外研版', grade: 3, semester: 1 })?.id, 'english-wy:3上')
  assert.equal(prov.find({ subject: 'chinese', edition: '统编版', grade: 1, semester: 2 })?.id, 'chinese-tongbian:1下')
  assert.equal(prov.find({ subject: 'math', edition: '人教版', grade: 1, semester: null }), null, '认不出学期不提示')
  assert.equal(prov.find({ subject: 'math', edition: '苏教版', grade: 1, semester: 1 })?.id, 'math-sujiao:1上')
  assert.equal(prov.find({ subject: 'math', edition: '青岛版（五四制）', grade: 5, semester: 2 })?.id, 'math-qingdaowusi:5下')
  assert.equal(prov.find({ subject: 'math', edition: '沪教版', grade: 6, semester: 1 }), null, '沪教版小学只有五个年级')
  assert.equal(prov.find({ subject: 'math', edition: '浙教版', grade: 1, semester: 1 }), null, '没有内置的版本不匹配')
  assert.equal(prov.find({ subject: 'chinese', edition: '人教版', grade: 1, semester: 1 }), null, '学科不对不匹配')
  const u = prov.units('math-renjiao:1上')
  assert.ok(u.length >= 5 && u.every(x => x.title && Array.isArray(x.kps)))
  assert.deepEqual(prov.units('乱写'), [])
  // 整本书上传用内置目录保存后：知识点都记为已检查
  const id = createOutline(A.db, { name: '整本书', scene: 'school', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', subject: 'math', kind: 'textbook', builtinId: 'math-renjiao:1上', levels: [{ name: 'X', lessons: [{ seq: 1, noLabel: '1', title: 't', theme: '', textbookRef: '', points: [], raw: {} }] }] })
  markBuiltinChecked(A.db, id, 'math')
  assert.equal(count(A.db, 'SELECT COUNT(*) c FROM course_kp_check WHERE outline_id = ?', id), count(A.db, "SELECT COUNT(*) c FROM kps WHERE subject = 'math' AND deprecated = 0"))
  assert.equal(listOutlines(A.db, 'math').find(c => c.id === id).match.state, 'done')
}
console.log('textbook-pack ok')
