// 数据包里的课程大纲：默认随包带走、导出时可以不带；导入（合并 / 覆盖）按外键整体复制并重新编号；话术缓存不带；坏的体系 id 拒绝；旧包（没有课程表）照常导入。
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { makeEnv, paperWithFiles, openDb, count, LATEST, migrate } from './helpers/packenv.mjs'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge, applyOverwrite, summarizePack } from '../../src/main/pack/apply.ts'
import { PackError } from '../../src/main/pack/errors.ts'
import { addCourseware, listCourseware, readCoursewareText, lessonKey } from '../../src/main/course/courseware.ts'
import { createOutline, applyMatchBatch, editMap, targetKps, listOutlines, mapRows } from '../../src/main/course/store.ts'

const prep = dbPath => prepareStagedDb(dbPath, { openDb, migrate: (db, from) => migrate(db, from), latest: LATEST })
const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: `w${seq}` }], raw: { 标题: title } })

async function exportOf(env, name, opts = {}) {
  const out = path.join(env.dir, `${name}.ewb.zip`)
  const res = await buildPack({ db: env.db, openDb, filesDir: env.filesDir, outPath: out, tmpDir: path.join(env.dir, `tmp-${name}`), appVersion: 'test', ...opts })
  return { out, res }
}
async function stageOf(zip, into) {
  const ex = await extractPack(zip, path.join(into.dir, `stage-${path.basename(zip)}`))
  const info = prep(ex.dbPath)
  return { staged: { dbPath: ex.dbPath, filesDir: ex.filesDir }, info }
}

// ── 源电脑 A：一份卷子 + 一个课程体系（含匹配结果、人工确认）+ 话术缓存 ──
const A = makeEnv('courseA')
paperWithFiles(A, { title: '甲', year: 2025, grade: '4', hash: 'h1', questions: [{ kp: 'GR.TENSE.PAST.REG', qtype: 'MC', score: 2, err: true }, { kp: 'GR.NOUN.PLURAL.REG', qtype: 'MC', score: 2 }] }, 1)
const oid = createOutline(A.db, {
  name: '示例体系 A', scene: 'org', termNote: '2026 秋', sourceName: 'x', sourceHash: 'h', mapping: { s: 1 }, warnings: [], aiModel: 'm', status: 'active',
  levels: [{ name: '基础级', lessons: [lesson(1, 'Hello'), lesson(2, 'Past')] }, { name: '进阶级', lessons: [lesson(1, 'Plural')] }]
})
const lid = Object.fromEntries(A.db.prepare('SELECT id, title FROM course_lessons').all().map(r => [r.title, r.id]))
const kps = targetKps(A.db)
applyMatchBatch(A.db, oid, [
  { code: 'GR.TENSE.PAST.REG', none: false, maps: [{ lessonId: lid.Past, confidence: 'high', quote: 'w2', reason: 'r', quoteOk: true }] },
  { code: 'GR.NOUN.PLURAL.REG', none: false, maps: [{ lessonId: lid.Plural, confidence: 'medium', quote: '', reason: 'r', quoteOk: false }] }
], { rev: 1, model: 'm', promptVersion: 'v', sigs: new Map(kps.map(k => [k.code, k.sig])) })
editMap(A.db, { op: 'confirm', kp: 'GR.TENSE.PAST.REG', lessonId: lid.Past })
A.db.prepare("INSERT INTO course_advice (scope_key, cache_key, markdown, confirmed_at) VALUES ('sk', 'ck', '一段话', '2026-11-02 10:00:00')").run()

// ── 导出：默认带课程；话术缓存永远不带 ──
{
  const { out, res } = await exportOf(A, 'with')
  assert.equal(res.manifest.courseCount, 1)
  assert.equal(res.manifest.courseIncluded, true)
  const { info } = await stageOf(out, A)
  assert.equal(info.papers, 1)
  const ex = await extractPack(out, path.join(A.dir, 'peek'))
  const pk = openDb(ex.dbPath, { readOnly: true })
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM course_outlines'), 1)
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM course_lessons'), 3)
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM course_kp_map'), 2)
  assert.equal(count(pk, 'SELECT COUNT(*) c FROM course_advice'), 0, '话术缓存不带走')
  pk.close()
}
// ── 导出：取消勾选 → 包里没有课程 ──
{
  const { out, res } = await exportOf(A, 'without', { withCourse: false })
  assert.equal(res.manifest.courseCount, 0)
  assert.equal(res.manifest.courseIncluded, false)
  const ex = await extractPack(out, path.join(A.dir, 'peek2'))
  const pk = openDb(ex.dbPath, { readOnly: true })
  for (const t of ['course_outlines', 'course_levels', 'course_lessons', 'course_kp_map', 'course_kp_check']) assert.equal(count(pk, `SELECT COUNT(*) c FROM ${t}`), 0, t)
  pk.close()
  // 本机的课程不受导出影响
  assert.equal(count(A.db, 'SELECT COUNT(*) c FROM course_outlines'), 1)
}

// ── 合并导入到电脑 B：课程整体复制，课次 id 重新编号，对应关系跟着走；本机已有同 id 的跳过 ──
{
  const { out } = await exportOf(A, 'for-merge')
  const B = makeEnv('courseB')
  // B 里先建一个别的体系，让课次自增 id 和 A 的撞上，验证重新编号
  createOutline(B.db, { name: 'B 自己的', scene: 'school', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '甲', lessons: [lesson(1, 'b1'), lesson(2, 'b2'), lesson(3, 'b3'), lesson(4, 'b4')] }] })
  const st = await stageOf(out, B)
  const sum = summarizePack({ ...B.deps }, st.staged)
  assert.equal(sum.coursesInPack, 1)
  assert.equal(sum.coursesNew, 1)
  const rep = applyMerge(B.deps, st.staged)
  assert.equal(rep.coursesAdded, 1)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_outlines'), 2)
  const cards = listOutlines(B.db)
  const got = cards.find(c => c.id === oid)
  assert.ok(got, '体系 id 不变')
  assert.deepEqual([got.name, got.scene, got.termNote, got.levels, got.lessons, got.rev], ['示例体系 A', 'org', '2026 秋', 2, 3, 1])
  const maps = mapRows(B.db, oid)
  assert.equal(maps.length, 2)
  // 对应关系指向的是 B 里这个体系自己的课次（标题对得上），不是 B 自己那个体系的课次
  const titleOf = id => B.db.prepare('SELECT title, outline_id FROM course_lessons WHERE id = ?').get(id)
  const past = maps.find(m => m.kp === 'GR.TENSE.PAST.REG')
  assert.deepEqual([titleOf(past.lessonId).title, titleOf(past.lessonId).outline_id, past.state, past.locked], ['Past', oid, 'confirmed', true], '人工确认的状态随包走')
  assert.equal(titleOf(maps.find(m => m.kp === 'GR.NOUN.PLURAL.REG').lessonId).title, 'Plural')
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_levels WHERE outline_id = ?', oid), 2)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_kp_check WHERE outline_id = ?', oid), 2)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_advice'), 0)
  assert.equal(B.db.prepare('PRAGMA foreign_key_check').all().length, 0, '外键完整')
  // 再合并一次：同 id 的跳过，不会重复
  const st2 = await stageOf(out, B)
  const rep2 = applyMerge(B.deps, st2.staged)
  assert.equal(rep2.coursesAdded, 0)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_outlines'), 2)
  assert.equal(count(B.db, 'SELECT COUNT(*) c FROM course_lessons'), 7)
}

// ── 覆盖导入：包里带课程就整体替换；包里没带课程（取消勾选）不会清空本机的课程 ──
{
  const { out } = await exportOf(A, 'for-overwrite')
  const C = makeEnv('courseC')
  createOutline(C.db, { name: 'C 旧的', scene: 'family', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '甲', lessons: [lesson(1, 'c1')] }] })
  const rep = applyOverwrite({ ...C.deps }, (await stageOf(out, C)).staged)
  assert.equal(rep.coursesAdded, 1)
  assert.deepEqual(listOutlines(C.db).map(c => c.name), ['示例体系 A'], '覆盖：本机旧的课程被包里的替换')
  assert.equal(mapRows(C.db, oid).length, 2)

  const { out: noCourse } = await exportOf(A, 'for-overwrite-nocourse', { withCourse: false })
  const D = makeEnv('courseD')
  createOutline(D.db, { name: 'D 自己的', scene: 'school', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '甲', lessons: [lesson(1, 'd1')] }] })
  const rep2 = applyOverwrite({ ...D.deps }, (await stageOf(noCourse, D)).staged)
  assert.equal(rep2.coursesAdded, 0)
  assert.deepEqual(listOutlines(D.db).map(c => c.name), ['D 自己的'], '包里没带课程：本机的课程保留')
}

// ── 坏的体系 id：整包拒绝 ──
{
  const { out } = await exportOf(A, 'bad-id')
  const ex = await extractPack(out, path.join(A.dir, 'stage-bad'))
  const db = openDb(ex.dbPath)
  db.exec("PRAGMA foreign_keys = OFF; UPDATE course_outlines SET id = '../../etc'")
  db.close()
  assert.throws(() => prep(ex.dbPath), e => e instanceof PackError && e.code === 'bad_content' && /课程体系的编号/.test(e.message))
}

// ── 包里没有课程（没勾选带课程，或旧版本的包）：照常导入，课程为 0 ──
{
  const E = makeEnv('courseE')
  paperWithFiles(E, { title: '旧', year: 2024, grade: '4', hash: 'old', questions: [{ kp: 'GR.NOUN.PLURAL.REG', qtype: 'MC', score: 2 }] }, 1)
  const F = makeEnv('courseF')
  const { out } = await exportOf(E, 'plain')
  const rep = applyMerge(F.deps, (await stageOf(out, F)).staged)
  assert.equal(rep.coursesAdded, 0)
  assert.equal(rep.papersAdded, 1)
}

// ── 畸形的数据包：枚举、类型、长度都被规整，不会把坏值带进库 ──
{
  const { out } = await exportOf(A, 'malformed')
  const ex = await extractPack(out, path.join(A.dir, 'stage-malformed'))
  const pk = openDb(ex.dbPath)
  pk.exec(`UPDATE course_outlines SET scene = 'evil', status = 'weird', active = 7, rev = -3, name = '${'名'.repeat(500)}', mapping_json = '[1,2]', warnings_json = '{"x":1}'`)
  pk.exec(`UPDATE course_lessons SET points_json = '{"a":1}', raw_json = '[1]', title = '${'题'.repeat(5000)}', seq = -5`)
  pk.exec(`UPDATE course_kp_map SET confidence = 'ultra', state = 'x', source = 'robot', locked = 9, quote = '${'q'.repeat(999)}'`)
  pk.exec(`UPDATE course_kp_check SET result = 'bogus', outline_rev = 'abc'`)
  pk.close()
  const info = prep(ex.dbPath)
  assert.ok(info.papers >= 1)
  const E = makeEnv('courseMal')
  applyMerge(E.deps, { dbPath: ex.dbPath, filesDir: ex.filesDir })
  const o = E.db.prepare('SELECT * FROM course_outlines').get()
  assert.deepEqual([o.scene, o.status, o.active, o.rev, o.name.length, o.mapping_json, o.warnings_json], ['other', 'draft', 1, 1, 60, '{}', '[]'])
  const l = E.db.prepare('SELECT * FROM course_lessons ORDER BY id').all()
  assert.ok(l.every(x => x.points_json === '[]' || Array.isArray(JSON.parse(x.points_json))) && l.every(x => x.raw_json === '{}') && l.every(x => x.title.length <= 300 && x.seq === 0))
  const m = E.db.prepare('SELECT * FROM course_kp_map').all()
  assert.ok(m.length && m.every(x => x.confidence === 'low' && x.state === 'suggested' && x.source === 'ai' && x.locked === 1 && x.quote.length <= 200))
  assert.ok(E.db.prepare('SELECT * FROM course_kp_check').all().every(x => x.result === 'none' && x.outline_rev === 0))
}

// ── 合并：本机已有同 id、包里的 rev 更新 → 默认跳过，勾选“更新”才用包里的 ──
{
  const B = makeEnv('courseNewer')
  const { out } = await exportOf(A, 'newer-base')
  applyMerge(B.deps, (await stageOf(out, B)).staged)
  A.db.prepare('UPDATE course_outlines SET rev = 5, name = ? WHERE id = ?').run('示例体系 A（新版）', oid)
  const { out: out2 } = await exportOf(A, 'newer')
  const st = await stageOf(out2, B)
  assert.equal(summarizePack({ ...B.deps }, st.staged).coursesNewer, 1)
  const r0 = applyMerge(B.deps, st.staged)
  assert.deepEqual([r0.coursesAdded, r0.coursesUpdated], [0, 0])
  assert.equal(listOutlines(B.db)[0].name, '示例体系 A')
  const r1 = applyMerge(B.deps, (await stageOf(out2, B)).staged, { updateCourses: true })
  assert.equal(r1.coursesUpdated, 1)
  assert.deepEqual([listOutlines(B.db)[0].name, listOutlines(B.db)[0].rev, B.db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c], ['示例体系 A（新版）', 5, 3])
}

// ── 覆盖导入（包里没有课程）：本机课程保留，但指向已不存在的知识点的对应 / 检查结果被清掉，保持一致 ──
{
  const D = makeEnv('courseOverKp')
  const did = createOutline(D.db, { name: 'D', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: 'x', lessons: [lesson(1, 'a')] }] })
  const lidD = D.db.prepare('SELECT id FROM course_lessons').get().id
  D.db.prepare("INSERT INTO course_kp_map (outline_id, kp_code, lesson_id) VALUES (?, 'NO.SUCH.KP', ?), (?, 'GR.NOUN.PLURAL.REG', ?)").run(did, lidD, did, lidD)
  D.db.prepare("INSERT INTO course_kp_check (outline_id, kp_code, result, outline_rev) VALUES (?, 'NO.SUCH.KP', 'matched', 1)").run(did)
  const { out } = await exportOf(A, 'ov-nocourse', { withCourse: false })
  applyOverwrite({ ...D.deps }, (await stageOf(out, D)).staged)
  assert.deepEqual(D.db.prepare('SELECT kp_code FROM course_kp_map').all().map(r => r.kp_code), ['GR.NOUN.PLURAL.REG'])
  assert.equal(D.db.prepare('SELECT COUNT(*) c FROM course_kp_check').get().c, 0)
}

// ── 课件随包走：只带被导出的大纲；合并不覆盖本机已有的；覆盖按大纲整体替换；没勾课程大纲不带 ──
{
  const G = makeEnv('cwG')
  const o1 = createOutline(G.db, { name: '大纲一', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '基础级', lessons: [lesson(1, 'a')] }] })
  const o2 = createOutline(G.db, { name: '大纲二', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: '基础级', lessons: [lesson(1, 'b')] }] })
  const it1 = addCourseware(G.dataDir, o1, lessonKey('基础级', 1), '课件一.pptx', '第一份课件的文字')
  addCourseware(G.dataDir, o2, lessonKey('基础级', 1), '课件二.pdf', '第二份')
  // 只导学科不含 o2 的情形用「没勾课程」代替；这里先验证带上两份大纲的课件
  const { out, res } = await exportOf(G, 'cw', { dataDir: G.dataDir })
  assert.equal(res.manifest.counts.courseware, 2)
  assert.equal(res.manifest.formatVersion, 2, '带课件的包旧版本软件会拒绝')
  const ex = await extractPack(out, path.join(G.dir, 'peek-cw'))
  assert.ok(fs.existsSync(path.join(path.dirname(ex.dbPath), 'courseware', o1, 'index.json')))
  // 没勾课程大纲：不带课件
  const { res: res0 } = await exportOf(G, 'cw-none', { dataDir: G.dataDir, withCourse: false })
  assert.equal(res0.manifest.counts.courseware, undefined)
  // 只带被导出的大纲：把 o2 从库里删掉（模拟只剩一份大纲），它的课件目录还在数据目录里但不该进包
  G.db.prepare('DELETE FROM course_outlines WHERE id = ?').run(o2)
  const { res: res1 } = await exportOf(G, 'cw-one', { dataDir: G.dataDir })
  assert.equal(res1.manifest.counts.courseware, 1, '只带还在的大纲的课件')

  // 合并导入到 H：新大纲的课件带过来；已有同名同节课件的不覆盖
  const { out: outBoth } = await exportOf(G, 'cw-merge', { dataDir: G.dataDir })
  const H = makeEnv('cwH')
  const rep = applyMerge(H.deps, (await stageOf(outBoth, H)).staged)
  assert.equal(rep.coursewareAdded, 1)
  assert.equal(listCourseware(H.dataDir, o1).length, 1)
  assert.equal(readCoursewareText(H.dataDir, o1, it1.id).text, '第一份课件的文字')
  // H 本机改过这份课件：再次合并不覆盖
  addCourseware(H.dataDir, o1, lessonKey('基础级', 1), '课件一.pptx', '本机改过的文字')
  const rep2 = applyMerge(H.deps, (await stageOf(outBoth, H)).staged)
  assert.equal(rep2.coursewareAdded, 0)
  assert.equal(readCoursewareText(H.dataDir, o1, it1.id).text, '本机改过的文字', '合并导入不覆盖本机已有课件')

  // 覆盖导入：按大纲整体替换，本机旧大纲的课件目录被清掉
  const I = makeEnv('cwI')
  const oOld = createOutline(I.db, { name: '本机旧大纲', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', levels: [{ name: 'x', lessons: [lesson(1, 'z')] }] })
  addCourseware(I.dataDir, oOld, lessonKey('x', 1), '旧课件.txt', '旧')
  const rep3 = applyOverwrite({ ...I.deps }, (await stageOf(outBoth, I)).staged)
  assert.equal(rep3.coursewareAdded, 1)
  assert.equal(listCourseware(I.dataDir, oOld).length, 0, '被替换掉的大纲，课件一起清')
  assert.equal(listCourseware(I.dataDir, o1).length, 1)
}

console.log('course-pack.test ✓')
