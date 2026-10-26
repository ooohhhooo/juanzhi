// 示例数据：内置合成卷的结构（多年级、≥3 个学年、题目与标注都在树里）、加载 / 重复加载 / 清除，
// 以及最重要的——不混进真实数据的统计（默认只看真实数据，要切到「示例数据」才看得到）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { SAMPLE_PAPERS, POOL, sampleTitle } from '../../src/main/sample/data.ts'
import { loadSample, clearSample, sampleStatus, sampleId, sampleQuestionId } from '../../src/main/sample/load.ts'
import { UUID_RE } from '../../src/main/pack/names.ts'
import { StatsFilterSchema } from '../../src/main/stats/filter.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-sample-'))
const filesDir = path.join(tmp, 'files')
fs.mkdirSync(filesDir)
const { db } = newDb()
const kpCodes = new Set(db.prepare('SELECT code FROM kps').all().map(r => r.code))
const qtypeCodes = new Set(db.prepare('SELECT code FROM qtypes').all().map(r => r.code))

// ── 数据本身 ──
assert.equal(SAMPLE_PAPERS.length, 12)
assert.ok(new Set(SAMPLE_PAPERS.map(p => p.year)).size >= 3, '≥3 个学年')
assert.ok(new Set(SAMPLE_PAPERS.map(p => p.grade)).size >= 2, '多个年级')
assert.equal(new Set(SAMPLE_PAPERS.map(p => p.key)).size, 12, 'key 唯一')
for (const p of SAMPLE_PAPERS) {
  assert.ok(p.qs.length >= 8, `${p.key} 每份至少 8 道题`)
  for (const id of p.qs) {
    const x = POOL[id]
    assert.ok(x, `题库里没有 ${id}`)
    assert.ok(kpCodes.has(x.kp), `${id} 的知识点 ${x.kp} 不在内置树里`)
    assert.ok(qtypeCodes.has(x.qtype), `${id} 的题型 ${x.qtype} 不在题型表里`)
    assert.ok(x.stem.length > 10 && x.diff >= 1 && x.diff <= 5 && x.score > 0)
  }
  assert.equal(new Set(p.qs).size, p.qs.length, `${p.key} 一份卷子里不重复用同一道题`)
}
assert.ok(SAMPLE_PAPERS.some(p => p.qs.some(id => POOL[id].err)), '有易错题')
// id 稳定且是合法 UUID
assert.equal(sampleId('2025-g4-fin'), sampleId('2025-g4-fin')); assert.ok(UUID_RE.test(sampleId('2025-g4-fin'))); assert.ok(UUID_RE.test(sampleQuestionId('2025-g4-fin', 3)))
assert.notEqual(sampleId('a'), sampleId('b'))

// ── 假的页面渲染（真实渲染需要 Electron）：每份卷子 1 页，每题一个框 ──
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
let renderCalls = 0
const render = async papers => { renderCalls++; return papers.map(p => ({ pages: [{ png, width: 1240, height: 1754, text: p.title }], boxes: p.questions.map((_, i) => ({ page: 1, bbox: [0.05, 0.1 + i * 0.05, 0.9, 0.04] })) })) }

// 真实数据：先放几份"用户自己的卷子"，记下统计
addPaper(db, { title: '用户真实卷', year: 2025, grade: '4', questions: [{ kp: 'GR.TENSE.PAST.REG', score: 2, difficulty: 3 }, { kp: 'FN.SHOP', score: 2, difficulty: 2 }] })
const realBefore = JSON.stringify([S.distribution(db, {}), S.overview(db, {}), S.hot(db, {}, 2), S.matrix(db, {}, 1), S.compare(db, {}, 2025, { lt: 2025 }, 2)])
assert.deepEqual(sampleStatus(db), { loaded: false, papers: 0, questions: 0 })

// ── 加载 ──
const r = await loadSample(db, filesDir, render, new Date(2026, 9, 26, 12, 0, 0))
assert.deepEqual([r.papers, r.alreadyLoaded], [12, false]); assert.ok(r.questions >= 96)
assert.equal(sampleStatus(db).papers, 12)
assert.equal(db.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1 AND status = ?').get('done').c, 12, '示例卷是已确认状态，加载后看板直接有内容')
assert.equal(db.prepare('SELECT COUNT(*) c FROM question_kps WHERE question_id IN (SELECT id FROM questions WHERE paper_id IN (SELECT id FROM papers WHERE is_sample = 1))').get().c, r.questions, '每道题都有主知识点')
assert.ok(db.prepare('SELECT title FROM papers WHERE is_sample = 1').all().every(p => p.title.startsWith('【示例】')))
assert.equal(db.prepare('SELECT title FROM papers WHERE id = ?').get(sampleId(SAMPLE_PAPERS[5].key)).title, sampleTitle(SAMPLE_PAPERS[5]))
for (const p of SAMPLE_PAPERS) assert.ok(fs.existsSync(path.join(filesDir, sampleId(p.key), 'page-1.png')), '页面图写出来了')
const q0 = db.prepare('SELECT bbox_json, page_idx, bbox_source FROM questions WHERE id = ?').get(sampleQuestionId(SAMPLE_PAPERS[0].key, 0))
assert.deepEqual([JSON.parse(q0.bbox_json), q0.page_idx, q0.bbox_source], [[0.05, 0.1, 0.9, 0.04], 1, 'manual'], '定位框来自渲染结果')
// 重复加载：不重复
const again = await loadSample(db, filesDir, render)
assert.equal(again.alreadyLoaded, true); assert.equal(renderCalls, 1, '已经加载过就不再渲染'); assert.equal(db.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1').get().c, 12)

// ── 不混进真实数据的统计 ──
assert.equal(JSON.stringify([S.distribution(db, {}), S.overview(db, {}), S.hot(db, {}, 2), S.matrix(db, {}, 1), S.compare(db, {}, 2025, { lt: 2025 }, 2)]), realBefore, '加载示例数据后，真实数据的所有统计一个数字都没变')
const smp = S.distribution(db, { sample: true })
assert.equal(smp.papers, 12); assert.equal(smp.questions, r.questions); assert.ok(smp.nodes.length > 20, '示例数据的看板有内容')
assert.equal(S.distribution(db, {}).papers, 1)
// 同比：示例数据有 3 个学年，2025 vs 之前有新增 / 消失 / 变化
const cmp = S.compare(db, { sample: true, grade: '4' }, 2025, { lt: 2025 }, 2)
assert.deepEqual(cmp.availableYears, [2023, 2024, 2025])
assert.ok(cmp.added.some(i => i.code === 'GR.TENSE.FUT'), '2025 新增一般将来时')
assert.ok(cmp.removed.some(i => i.code === 'PH.PHONICS'), '字母与字母组合发音在 2025 不再出现')
assert.ok(cmp.up.length + cmp.down.length > 0)
assert.equal(S.overview(db, { sample: true }).cards.papers, 12); assert.equal(S.overview(db, {}).cards.papers, 1)
// 筛选候选值也分开
assert.deepEqual(S.filterOptions(db).years, [2025]); assert.deepEqual(S.filterOptions(db, { sample: true }).years, [2023, 2024, 2025])
assert.deepEqual(S.filterOptions(db).textbooks, ['人教PEP']); assert.deepEqual(S.filterOptions(db, { sample: true }).textbooks, ['外研版', '人教PEP'].sort())
// 去重（同一文件只算一份）在示例数据里不吞卷子：12 份 hash 各不相同
assert.equal(S.scopeNotes(db, { sample: true }).duplicates, 0)
// 筛选对象的校验：sample 必须是布尔
assert.ok(StatsFilterSchema.safeParse({ sample: true }).success); assert.ok(!StatsFilterSchema.safeParse({ sample: 'yes' }).success)

// ── 清除 ──
const reportId = '22222222-2222-4222-8222-222222222222'
db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown) VALUES (?, 'report', ?, '# x')`).run(reportId, JSON.stringify({ sample: true, grade: '4' }))
db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown) VALUES ('33333333-3333-4333-8333-333333333333', 'report', '{"grade":"4"}', '# 真实')`).run()
db.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES ('s1', 'c', 'v', 'f', ?, 'x')`).run(JSON.stringify({ filter: { sample: true } }))
db.prepare(`INSERT INTO ai_analyses (scope_key, cache_key, prompt_version, fingerprint, scope_json, markdown) VALUES ('s2', 'c', 'v', 'f', ?, 'x')`).run(JSON.stringify({ filter: { grade: '4' } }))
const c = clearSample(db, filesDir)
assert.equal(c.papers, 12); assert.equal(c.reports, 1)
assert.deepEqual(sampleStatus(db), { loaded: false, papers: 0, questions: 0 })
assert.equal(db.prepare('SELECT COUNT(*) c FROM questions').get().c, 2, '只剩用户真实卷的 2 道题（级联删除了示例题与标注）')
assert.equal(db.prepare('SELECT COUNT(*) c FROM question_kps').get().c, 2)
assert.equal(db.prepare('SELECT COUNT(*) c FROM pages').get().c, 0)
assert.deepEqual(fs.readdirSync(filesDir), [], '示例卷的文件目录也删了')
assert.deepEqual(db.prepare('SELECT id FROM reports').all().map(r => r.id), ['33333333-3333-4333-8333-333333333333'], '只删基于示例筛选生成的报告')
assert.deepEqual(db.prepare('SELECT scope_key FROM ai_analyses').all().map(r => r.scope_key), ['s2'])
assert.equal(JSON.stringify([S.distribution(db, {}), S.overview(db, {}), S.hot(db, {}, 2), S.matrix(db, {}, 1), S.compare(db, {}, 2025, { lt: 2025 }, 2)]), realBefore, '清除后真实数据的统计仍然一模一样')
// 清除后能再加载
assert.equal((await loadSample(db, filesDir, render)).alreadyLoaded, false); assert.equal(renderCalls, 2)
// 渲染失败不留半截：库里没有、目录也没有
clearSample(db, filesDir)
await assert.rejects(() => loadSample(db, filesDir, async () => { throw new Error('渲染窗口崩了') }), /渲染窗口崩了/)
assert.equal(sampleStatus(db).loaded, false); assert.deepEqual(fs.readdirSync(filesDir), [])
// 库写失败（比如题里用了不存在的知识点）→ 回滚且删掉已写出的页面图
{
  const { db: d2 } = newDb(); d2.exec("DELETE FROM kps WHERE code = 'GR.TENSE.FUT.GOING'")
  const fd = path.join(tmp, 'files2'); fs.mkdirSync(fd)
  await assert.rejects(() => loadSample(d2, fd, render), /树里不存在的知识点/)
  assert.equal(sampleStatus(d2).loaded, false); assert.deepEqual(fs.readdirSync(fd), [], '库写失败时已写出的页面图被清掉')
  assert.equal(d2.prepare('SELECT COUNT(*) c FROM questions').get().c, 0)
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log('sample-data.test ✓')
