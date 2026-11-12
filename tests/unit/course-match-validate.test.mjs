// 课 → 知识点 匹配的校验与落库：令牌不存在、quote 不在课次原文里降级、每课最多 3 个、锁定不被覆盖、被否决不再加回、重新匹配后锁定保留。
import assert from 'node:assert/strict'
import { newDb, useTree } from './helpers/db.mjs'
import { quoteLongEnough, quoteTouchesKp, parseLessonResponse, planLessonMerge, outlineLine, kpBatchBlock, kpSig, chunkLines, isMainMap, lessonSearchText } from '../../src/main/course/match.ts'
import { createOutline, applyMatchBatch, editMap, matchState, targetKps, getOutline, mapRows } from '../../src/main/course/store.ts'
import { addPaper } from './helpers/db.mjs'

const lessons = new Map([
  [12, { searchText: lessonSearchText({ levelName: '基础级', noLabel: '5', title: '第 5 课 Animals', theme: '动物', points: [{ text: 'cat, dog, fish' }, { text: "It's a …" }] }) }],
  [13, { searchText: lessonSearchText({ title: '第 6 课 Food', points: [{ text: 'apple, rice' }] }) }]
])
const tokens = new Map([['K1', 'GR.A'], ['K2', 'GR.B'], ['K3', 'GR.C'], ['K4', 'GR.D']])
const resp = r => JSON.stringify({ results: r })

// ── 回答校验（以课为单位） ──
{
  const p = parseLessonResponse(resp([
    { lesson: '#12', kps: [
      { kp: 'K1', confidence: 'high', quote: 'cat,  dog', reason: '词汇里有' },          // quote 忽略空白 → 通过（high）
      { kp: 'K2', confidence: 'high', quote: '这句话课次里根本没有', reason: '主题像' },    // quote 不在原文 → 降为 low
      { kp: 'K9', confidence: 'high', quote: 'cat' },                                  // 知识点令牌不在批里 → 丢弃
      { kp: 'k3', confidence: 'medium', quote: "It's a …" },                           // 小写令牌也认
      { kp: 'K1', confidence: 'medium', quote: 'cat' },                                // 同一对重复 → 忽略
      { kp: 'K4', confidence: 'high', quote: 'fish' }                                  // 超过每课 3 个 → 丢弃
    ] },
    { lesson: '#999', kps: [{ kp: 'K1', confidence: 'high', quote: 'x' }] },           // 课次不存在 → 丢弃
    { lesson: 13, kps: [] }
  ]), { tokens, lessons })
  const by = Object.fromEntries(p.entries.map(e => [e.lessonId, e]))
  assert.deepEqual(by[12].maps.map(m => [m.code, m.confidence, m.quoteOk, m.source]), [['GR.A', 'high', true, 'ai'], ['GR.B', 'low', false, 'ai'], ['GR.C', 'high', true, 'ai']])
  assert.equal(by[12].maps[0].quote, 'cat,  dog')
  assert.match(by[12].maps[1].reason, /^仅凭主题推测：主题像/, '降级的条目要标「仅凭主题推测」')
  assert.equal(by[12].maps[1].quote, '', '没有依据的 quote 不保存')
  assert.deepEqual(by[13].maps, [])
  assert.equal(p.dropped, 3)
  assert.ok(p.problems[0].includes('3 条'))
  // 不是 JSON
  assert.equal(parseLessonResponse('抱歉', { tokens, lessons }).entries.length, 0)
  assert.ok(parseLessonResponse('抱歉', { tokens, lessons }).problems.length)
  // 每节课最多 3 个：最多留 3 个
  const four = parseLessonResponse(resp([{ lesson: '#12', kps: ['K1', 'K2', 'K3', 'K4'].map(kp => ({ kp, confidence: 'low' })) }]), { tokens, lessons })
  assert.equal(four.entries[0].maps.length, 3)
  // 单条口径：过线才算主要匹配
  assert.equal(isMainMap({ kp_code: 'GR.A', lesson_id: 1, state: 'suggested', confidence: 'high', source: 'ai', quote: 'cat dog' }), true)
  assert.equal(isMainMap({ kp_code: 'GR.A', lesson_id: 1, state: 'suggested', confidence: 'medium', source: 'ai', quote: 'cat dog' }), false, 'AI 的 medium（关联不明显）不再算主要匹配')
  assert.equal(isMainMap({ kp_code: 'GR.A', lesson_id: 1, state: 'suggested', confidence: 'low', source: 'ai' }), false)
  assert.equal(isMainMap({ kp_code: 'GR.A', lesson_id: 1, state: 'confirmed', confidence: 'low', source: 'ai' }), true, '老师确认过的按主要对应算')
  assert.equal(isMainMap({ kp_code: 'GR.A', lesson_id: 1, state: 'rejected', confidence: 'high', source: 'ai' }), false)
}

// ── quote 核对更严：太短不算、级别名 / 课次标签不算、和知识点无关的只能到 medium ──
{
  assert.equal(quoteLongEnough('cat'), false); assert.equal(quoteLongEnough('cat dog'), true); assert.equal(quoteLongEnough('visited'), true); assert.equal(quoteLongEnough('动物'), false); assert.equal(quoteLongEnough('过去式'), true)
  const ls = new Map([[12, { searchText: '基础级 5 第 5 课 Animals 动物 cat, dog, fish', quoteText: 'Animals 动物 cat, dog, fish' }]])
  const tk = new Map([['K1', 'GR.A']])
  const kps = new Map([['GR.A', { name: '宠物名词', hintWords: 'dog / puppy', exampleEn: '' }]])
  const r = (quote, k = kps) => parseLessonResponse(resp([{ lesson: '#12', kps: [{ kp: 'K1', confidence: 'high', quote }] }]), { tokens: tk, lessons: ls, kps: k }).entries[0].maps[0]
  assert.equal(r('基础级 5').confidence, 'low', '级别名 / 课次编号不在可核对的文字里')
  assert.equal(r('第 5 课').confidence, 'low')
  assert.equal(r('cat').confidence, 'low', '3 个字母的单个单词太短')
  assert.deepEqual([r('cat, dog').confidence, r('cat, dog').quoteOk], ['high', true], '含知识点例词 dog')
  assert.equal(r('Animals 动物').confidence, 'medium', '依据和知识点没有重叠：最高 medium')
  assert.equal(r('Animals 动物', new Map()).confidence, 'high', '没有知识点信息就不卡')
  assert.equal(quoteTouchesKp('宠物店', { name: '宠物名词' }), true)
}

// ── 合并计划（以课为单位）：锁定 / 确认 / 否决的不动，被否决不加回，范围外的不动 ──
{
  const cand = (code, c = 'high') => ({ lessonId: 1, code, source: 'rule', confidence: c, quote: 'q', reason: 'r' })
  const plan = planLessonMerge([
    { kp: 'GR.A', locked: false, state: 'suggested', source: 'ai' },    // 旧的自动结果 → 删掉后换成新的
    { kp: 'GR.B', locked: true, state: 'rejected', source: 'ai' },      // 被否决 → 不再加回
    { kp: 'GR.C', locked: true, state: 'confirmed', source: 'manual' }, // 人工确认 → 保留
    { kp: 'GR.Z', locked: false, state: 'suggested', source: 'ai' }     // 不在本次范围 → 不动
  ], [cand('GR.A'), cand('GR.B'), cand('GR.C'), cand('GR.D')], new Set(['GR.A', 'GR.B', 'GR.C', 'GR.D']))
  assert.deepEqual(plan.deleteKps, ['GR.A'])
  assert.deepEqual(plan.insert.map(c => c.code), ['GR.A', 'GR.D'])
}

// ── 拼装 ──
{
  const line = outlineLine({ id: 12, levelName: '基础级', seq: 5, noLabel: '5', title: 'Animals', theme: '动物', textbookRef: '示例教材 三上 Unit 2', points: [{ kind: 'word', label: '词汇', text: 'cat, dog' }, { kind: 'pattern', label: '句型', text: "It's a …" }] })
  assert.equal(line, "#12 | 基础级 | 第 5 课《Animals》 | 动物 | 词:cat, dog | 句:It's a … | 对标:示例教材 三上 Unit 2")
  const b = kpBatchBlock([{ code: 'GR.TENSE.PAST', name: '一般过去时', plain: '过去发生的事', exampleEn: 'I played.', hintWords: 'played' }, { code: 'GR.B', name: 'B', plain: '', exampleEn: '', hintWords: '' }])
  assert.equal(b.tokens.get('K1'), 'GR.TENSE.PAST')
  assert.ok(!b.text.includes('GR.TENSE'), '内部代码不发给模型')
  assert.notEqual(kpSig({ code: 'a', name: 'x', plain: '', exampleEn: '', hintWords: '' }), kpSig({ code: 'a', name: 'y', plain: '', exampleEn: '', hintWords: '' }))
  assert.deepEqual(chunkLines(['aaaa', 'bbbb', 'cccc'], 9).map(c => c.length), [2, 1])
  assert.equal(chunkLines([]).length, 1)
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
  assert.equal(db.prepare("SELECT COUNT(*) c FROM course_kp_map WHERE kp_code = 'GR.A'").get().c, 2)
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
