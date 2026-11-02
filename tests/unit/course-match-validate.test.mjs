// 知识点 → 课次 匹配的校验与落库：令牌不存在、quote 不在课次原文里降级、锁定不被覆盖、被否决不再加回、重新匹配后锁定保留、分批切分。
import assert from 'node:assert/strict'
import { newDb, useTree } from './helpers/db.mjs'
import { parseMatchResponse, planMerge, outlineLine, kpBatchBlock, kpSig, batchKps, mergeEntries, chunkLines, isMainMap, lessonSearchText } from '../../src/main/course/match.ts'
import { createOutline, applyMatchBatch, editMap, matchState, targetKps, getOutline, existingMaps, mapRows } from '../../src/main/course/store.ts'
import { addPaper } from './helpers/db.mjs'

const lessons = new Map([
  [12, { searchText: lessonSearchText({ levelName: '基础级', noLabel: '5', title: '第 5 课 Animals', theme: '动物', points: [{ text: 'cat, dog, fish' }, { text: "It's a …" }] }) }],
  [13, { searchText: lessonSearchText({ title: '第 6 课 Food', points: [{ text: 'apple, rice' }] }) }]
])
const tokens = new Map([['K1', 'GR.A'], ['K2', 'GR.B'], ['K3', 'GR.C']])
const resp = r => JSON.stringify({ results: r })

// ── 回答校验 ──
{
  const p = parseMatchResponse(resp([
    { kp: 'K1', lesson: '#12', confidence: 'high', quote: 'cat,  dog', reason: '词汇里有' },          // quote 忽略空白 → 通过
    { kp: 'K1', lesson: '#999', confidence: 'high', quote: 'x' },                                  // 课次不存在 → 丢弃
    { kp: 'K1', lesson: '#13', confidence: 'high', quote: '这句话课次里根本没有', reason: '主题像' },    // quote 不在原文 → 降为 low
    { kp: 'K2', none: true },
    { kp: 'K9', lesson: '#12', confidence: 'high', quote: 'cat' },                                 // 知识点令牌不在批里 → 丢弃
    { kp: 'k3', lesson: 12, confidence: 'medium', quote: "It's a …" },                             // 小写令牌、数字课次也认
    { kp: 'K3', lesson: '#12', confidence: 'medium', quote: 'cat' }                                // 同一对重复 → 忽略
  ]), { tokens, lessons })
  const by = Object.fromEntries(p.entries.map(e => [e.code, e]))
  assert.deepEqual(by['GR.A'].maps.map(m => [m.lessonId, m.confidence, m.quoteOk]), [[12, 'high', true], [13, 'low', false]])
  assert.equal(by['GR.A'].maps[0].quote, 'cat,  dog')
  assert.match(by['GR.A'].maps[1].reason, /^仅凭主题推测：主题像/, '降级的条目要标「仅凭主题推测」')
  assert.equal(by['GR.A'].maps[1].quote, '', '没有依据的 quote 不保存')
  assert.equal(by['GR.B'].none, true)
  assert.equal(by['GR.C'].maps.length, 1)
  assert.equal(p.dropped, 2)
  assert.ok(p.problems[0].includes('2 条'))
  // 全是无效课次 → 这个知识点变成 none（不是“没检查过”）
  const q = parseMatchResponse(resp([{ kp: 'K1', lesson: '#999', confidence: 'high', quote: 'x' }]), { tokens, lessons })
  assert.equal(q.entries[0].none, true)
  // 一个知识点最多 5 个对应
  const many = new Map(Array.from({ length: 8 }, (_, i) => [100 + i, { searchText: 'x' }]))
  const m5 = parseMatchResponse(resp(Array.from({ length: 8 }, (_, i) => ({ kp: 'K1', lesson: `#${100 + i}`, confidence: 'low' }))), { tokens, lessons: many })
  assert.equal(m5.entries[0].maps.length, 5)
  // 不是 JSON
  assert.equal(parseMatchResponse('抱歉', { tokens, lessons }).entries.length, 0)
  assert.ok(parseMatchResponse('抱歉', { tokens, lessons }).problems.length)
  // 未出现在回答里的知识点不产生条目
  assert.equal(parseMatchResponse(resp([{ kp: 'K1', none: true }]), { tokens, lessons }).entries.length, 1)
  assert.equal(isMainMap({ state: 'suggested', confidence: 'medium' }), true)
  assert.equal(isMainMap({ state: 'suggested', confidence: 'low' }), false)
  assert.equal(isMainMap({ state: 'confirmed', confidence: 'low' }), true, '老师确认过的按主要对应算')
  assert.equal(isMainMap({ state: 'rejected', confidence: 'high' }), false)
}

// ── 合并计划 ──
{
  const entry = { code: 'GR.A', none: false, maps: [{ lessonId: 1, confidence: 'high', quote: 'q', reason: '', quoteOk: true }, { lessonId: 2, confidence: 'medium', quote: 'q', reason: '', quoteOk: true }, { lessonId: 3, confidence: 'low', quote: '', reason: '', quoteOk: false }] }
  const plan = planMerge([
    { lessonId: 1, locked: false, state: 'suggested', source: 'ai' },   // 旧的 AI 建议 → 删掉后换成新的
    { lessonId: 2, locked: true, state: 'rejected', source: 'ai' },     // 被否决 → 不再加回
    { lessonId: 9, locked: true, state: 'confirmed', source: 'manual' } // 人工确认 → 保留
  ], entry)
  assert.deepEqual(plan.deleteLessonIds, [1])
  assert.deepEqual(plan.insert.map(m => m.lessonId), [1, 3])
  assert.equal(plan.result, 'matched')
  assert.equal(planMerge([{ lessonId: 2, locked: true, state: 'rejected', source: 'ai' }], { code: 'x', none: false, maps: [entry.maps[1]] }).result, 'none', '只剩被否决的 → none')
  assert.equal(planMerge([{ lessonId: 9, locked: true, state: 'confirmed', source: 'manual' }], { code: 'x', none: true, maps: [] }).result, 'matched', '人工确认过的对应还在 → matched')
}

// ── 拼装 ──
{
  const line = outlineLine({ id: 12, levelName: '基础级', seq: 5, noLabel: '5', title: 'Animals', theme: '动物', textbookRef: '示例教材 三上 Unit 2', points: [{ kind: 'word', label: '词汇', text: 'cat, dog' }, { kind: 'pattern', label: '句型', text: "It's a …" }] })
  assert.equal(line, "#12 | 基础级 | 第 5 课《Animals》 | 动物 | 词:cat, dog | 句:It's a … | 对标:示例教材 三上 Unit 2")
  const b = kpBatchBlock([{ code: 'GR.TENSE.PAST', name: '一般过去时', plain: '过去发生的事', exampleEn: 'I played.', hintWords: 'played' }, { code: 'GR.B', name: 'B', plain: '', exampleEn: '', hintWords: '' }])
  assert.equal(b.tokens.get('K1'), 'GR.TENSE.PAST')
  assert.ok(!b.text.includes('GR.TENSE'), '内部代码不发给模型')
  assert.notEqual(kpSig({ code: 'a', name: 'x', plain: '', exampleEn: '', hintWords: '' }), kpSig({ code: 'a', name: 'y', plain: '', exampleEn: '', hintWords: '' }))
  const batches = batchKps([...Array.from({ length: 70 }, (_, i) => ({ code: `GR.K${i}` })), { code: 'PH.X' }], 30)
  assert.deepEqual(batches.map(x => x.length), [30, 30, 10, 1], '先按一级大类分组，每批不超过 30 个')
  assert.deepEqual(chunkLines(['aaaa', 'bbbb', 'cccc'], 9).map(c => c.length), [2, 1])
  assert.equal(chunkLines([]).length, 1)
  const merged = mergeEntries([[{ code: 'A', none: true, maps: [] }, { code: 'B', none: false, maps: [{ lessonId: 1, confidence: 'low', quote: '', reason: '', quoteOk: false }] }], [{ code: 'A', none: false, maps: [{ lessonId: 2, confidence: 'high', quote: 'q', reason: '', quoteOk: true }] }, { code: 'B', none: false, maps: [{ lessonId: 3, confidence: 'high', quote: 'q', reason: '', quoteOk: true }] }]])
  assert.deepEqual(merged.find(e => e.code === 'B').maps.map(m => m.lessonId), [3, 1], '分段结果合并后按把握排序')
  assert.equal(merged.find(e => e.code === 'A').none, false)
}

// ── 落库：重新匹配后锁定保留、被否决不加回、user_none 不被覆盖、匹配状态 ──
{
  const { db } = newDb()
  useTree(db, [['GR', null, '语法', 1], ['GR.A', 'GR', '甲', 2], ['GR.B', 'GR', '乙', 2], ['GR.B.X', 'GR.B', '乙下', 3]])
  addPaper(db, { questions: [{ kp: 'GR.A' }, { kp: 'GR.B' }, { kp: 'GR.B.X' }] })
  addPaper(db, { questions: [{ kp: 'GR' }] })   // 一级知识点不匹配
  const kps = targetKps(db)
  assert.deepEqual(kps.map(k => k.code), ['GR.A', 'GR.B', 'GR.B.X'], '只匹配二、三级且有题标注过的知识点')
  const id = createOutline(db, {
    name: '示例体系 A', scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active',
    levels: [{ name: '基础级', lessons: [1, 2, 3].map(n => ({ seq: n, noLabel: String(n), title: `L${n}`, theme: '', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: `w${n}` }], raw: {} })) }]
  })
  const ids = db.prepare('SELECT id FROM course_lessons ORDER BY seq').all().map(r => r.id)
  assert.equal(matchState(db, id).state, 'none')
  const sigs = new Map(kps.map(k => [k.code, k.sig]))
  const meta = { rev: 1, model: 'm', promptVersion: 'v', sigs }
  const E = (code, ...ls) => ({ code, none: !ls.length, maps: ls.map(([lessonId, confidence]) => ({ lessonId, confidence, quote: 'q', reason: 'r', quoteOk: true })) })
  applyMatchBatch(db, id, [E('GR.A', [ids[0], 'high'], [ids[1], 'medium']), E('GR.B', [ids[2], 'high']), E('GR.B.X')], meta)
  assert.equal(matchState(db, id).state, 'done')
  assert.equal(db.prepare("SELECT result FROM course_kp_check WHERE kp_code = 'GR.B.X'").get().result, 'none')
  // 老师：确认 A→1，否决 A→2，B 手工加 1，GR.B.X 标「其实没有」
  assert.equal(editMap(db, { op: 'confirm', kp: 'GR.A', lessonId: ids[0] }), true)
  assert.equal(editMap(db, { op: 'reject', kp: 'GR.A', lessonId: ids[1] }), true)
  assert.equal(editMap(db, { op: 'add', outlineId: id, kp: 'GR.B', lessonId: ids[0] }), true)
  assert.equal(editMap(db, { op: 'none', outlineId: id, kp: 'GR.B.X' }), true)
  assert.equal(editMap(db, { op: 'add', outlineId: id, kp: 'GR.B', lessonId: 99999 }), false, '不属于这个体系的课次不能加')
  // 重新匹配：AI 这次把 A→2 又给了一遍、B 换成别的课、B.X 给了对应
  applyMatchBatch(db, id, [E('GR.A', [ids[1], 'high'], [ids[2], 'medium']), E('GR.B', [ids[1], 'high']), E('GR.B.X', [ids[2], 'high'])], meta)
  const maps = mapRows(db, id)
  const key = m => `${m.kp}:${ids.indexOf(m.lessonId)}:${m.state}:${m.source}`
  assert.deepEqual(maps.map(key).sort(), ['GR.A:0:confirmed:ai', 'GR.A:1:rejected:ai', 'GR.A:2:suggested:ai', 'GR.B:0:confirmed:manual', 'GR.B:1:suggested:ai'].sort(),
    '确认的保留、否决的不再加回（也不被覆盖成 suggested）、人工添加的保留、旧的 AI 建议被新结果替换；标了“其实没有”的 GR.B.X 不被 AI 加回')
  assert.equal(db.prepare("SELECT result FROM course_kp_check WHERE kp_code = 'GR.B.X'").get().result, 'user_none')
  // reset：取消一次人工操作
  assert.equal(editMap(db, { op: 'reset', kp: 'GR.A', lessonId: ids[1] }), true)
  assert.equal(existingMaps(db, id, 'GR.A').length, 2)
  // 老师在“不是匹配对象”的二级考点（GR 下的 GR.A 不是，但这里换成一级 GR 当例子）上手工指定课：它的检查记录不影响匹配状态
  assert.equal(editMap(db, { op: 'add', outlineId: id, kp: 'GR', lessonId: ids[2] }), true)
  assert.equal(matchState(db, id).state, 'done')
  db.prepare('UPDATE course_outlines SET rev = 2').run()
  applyMatchBatch(db, id, [E('GR.A', [ids[1], 'high']), E('GR.B', [ids[1], 'high']), E('GR.B.X')], { ...meta, rev: 2 })
  assert.equal(matchState(db, id).state, 'done', '重新匹配之后，旧版本号的手工检查记录不会让状态一直停在“需要重新匹配”')
  db.prepare('UPDATE course_outlines SET rev = 1').run()
  db.prepare('UPDATE course_kp_check SET outline_rev = 1').run()
  // 新增知识点 → 部分已匹配；体系更新（rev+1）→ 需要重新匹配
  addPaper(db, { questions: [{ kp: 'GR.B.X' }] })
  db.exec("INSERT INTO kps (code, parent_code, name, level, sort) VALUES ('GR.C', 'GR', '丙', 2, 99)")
  addPaper(db, { questions: [{ kp: 'GR.C' }] })
  assert.deepEqual([matchState(db, id).state, matchState(db, id).checked, matchState(db, id).total], ['partial', 3, 4])
  db.prepare('UPDATE course_outlines SET rev = rev + 1').run()
  assert.equal(matchState(db, id).state, 'stale')
  // 知识点释义改了（kp_sig 变）→ 那一个要补
  db.prepare('UPDATE course_outlines SET rev = 1').run()
  db.prepare("UPDATE kps SET plain = '换了释义' WHERE code = 'GR.A'").run()
  assert.equal(matchState(db, id).state, 'partial')
  // 删除体系：级联带走课次和对应
  db.prepare('DELETE FROM course_outlines WHERE id = ?').run(id)
  for (const t of ['course_levels', 'course_lessons', 'course_kp_check', 'course_kp_map']) assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t)
  assert.equal(getOutline(db, id), null)
}

console.log('course-match-validate.test ✓')
