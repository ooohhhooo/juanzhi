// 课 ↔ 知识点：标志词规则、匹配分与阈值、每课最多 3 个主知识点、否决不回流、教材桥、试卷占分、课 ↔ 单元 / 原题的防瞎匹配、对照表整合。内存库 + 虚构夹具。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import { KP_RULES } from '../../src/main/seed/course-kp-rules.ts'
import { KP_SEEDS_V1 } from '../../src/main/seed/taxonomy.ts'
import { MA_KP_SEEDS_V1 } from '../../src/main/seed/taxonomy-math.ts'
import { CN_KP_SEEDS_V1 } from '../../src/main/seed/taxonomy-chinese.ts'
import { matchLessonRules, ruleScore, ruleScoreFromQuote, hintWordsOf } from '../../src/main/course/rules.ts'
import { scoreOf, classifyMaps, selectMain, isMainMap, MATCH_THRESHOLD, MAX_MAIN_PER_LESSON, evidenceOf } from '../../src/main/course/score.ts'
import { parseRef, resolveBridge } from '../../src/main/course/bridge.ts'
import { CATALOG } from '../../src/main/course/catalog.ts'
import { ruleCandidates, mergeCandidates, candidateScore, lessonsNeedingAi, bridgeCandidates } from '../../src/main/course/match.ts'
import { computeRulePass, applyRulePass } from '../../src/main/course/match-rules.ts'
import { createOutline, editMap, mapRows, targetKps, mainMapRows } from '../../src/main/course/store.ts'
import { kpImportance, importanceOf, importanceText } from '../../src/main/course/importance.ts'
import { matchUnit, pickUnits, matchExample, isUnverifiedNote } from '../../src/main/course/lesson-match.ts'
import { researchTable, withGradeScope } from '../../src/main/course/research-table.ts'
import { researchSheetRows } from '../../src/main/course/research-xlsx.ts'

// ── 规则数据：引用的代码都存在于三科的知识点树里 ──
{
  const all = new Set([...KP_SEEDS_V1, ...MA_KP_SEEDS_V1, ...CN_KP_SEEDS_V1].map(k => k[0]))
  const missing = Object.keys(KP_RULES).filter(c => !all.has(c))
  assert.deepEqual(missing, [], '规则里的知识点代码必须在知识点树里')
  for (const [prefix, n] of [['GR.', 20], ['MA.', 40], ['CN.', 40]]) assert.ok(Object.keys(KP_RULES).filter(c => c.startsWith(prefix)).length >= n, `${prefix} 规则太少`)
  assert.ok(hintWordsOf('CN.SENT.RHET.SIMILE').includes('比喻'), '语文 / 数学的例词由规则补上')
}

// ── 规则命中：命中词作依据；强词单个 ≥ 70；弱词要好几个一起 ──
{
  const hit = (text, code) => matchLessonRules(text, [code])[0]
  const past = hit('Last weekend: I was happy. We visited the zoo yesterday.', 'GR.TENSE.PAST')
  assert.ok(past.score >= 72, '一般过去时：was / yesterday 等强标志词')
  assert.ok(past.hits.some(h => h.word === 'was' && h.strong) && past.hits.some(h => h.word === 'yesterday'), '要记下命中了哪个词')
  assert.equal(hit('She wasn’t there', 'GR.TENSE.PAST'), undefined, 'wasn’t 不是 was（按单词边界）')
  assert.ok(hit('今天学习竖式 + 笔算', 'MA.CALC.ADD.MULTI').score < MATCH_THRESHOLD, '竖式只是弱词：单个不够')
  assert.ok(hit('认识平均数，移多补少', 'MA.STAT.AVG').score >= 72)
  assert.ok(hit('求长方形的周长', 'MA.GEO.PERI.RECT').score >= 72)
  assert.ok(hit('用比喻句写景，学习拟人', 'CN.SENT.RHET.SIMILE').score >= 72)
  assert.ok(hit('多音字：长 cháng / zhǎng', 'CN.CHAR.SOUND.POLY').score >= 72)
  assert.ok(hit('two apples', 'GR.NOUN.PLURAL.REG') === undefined || hit('two apples', 'GR.NOUN.PLURAL.REG').score < MATCH_THRESHOLD, '数词 + 名词复数只是弱词')
  assert.ok(hit('visited, played, watched', 'GR.TENSE.PAST.REG').score >= MATCH_THRESHOLD, '三个不同的 -ed 动词一起出现才够线')
  assert.ok(!hit('played', 'GR.TENSE.PAST.REG') || hit('played', 'GR.TENSE.PAST.REG').score < MATCH_THRESHOLD, '单个 -ed 动词不够')
  // 太泛的词不用：「句子」「数」不会命中任何知识点
  assert.deepEqual(matchLessonRules('学习句子和数', undefined).filter(m => m.score >= MATCH_THRESHOLD), [])
  assert.equal(ruleScore(1, 0), 72); assert.equal(ruleScore(2, 0), 80); assert.equal(ruleScore(0, 1), 35); assert.equal(ruleScore(0, 3), 62)
  // 老数据 / 打开时补算：由命中词还原强弱
  assert.equal(ruleScoreFromQuote('GR.TENSE.PAST', 'was、yesterday'), ruleScore(2, 0))
  assert.equal(ruleScoreFromQuote('GR.TENSE.PAST', 'went'), ruleScore(0, 1))
}

// ── 匹配分与阈值 ──
{
  const base = { kp_code: 'GR.TENSE.PAST', lesson_id: 1 }
  assert.equal(scoreOf({ ...base, state: 'confirmed', confidence: 'low', source: 'ai' }), 100)
  assert.equal(scoreOf({ ...base, state: 'rejected', confidence: 'high', source: 'rule', quote: 'was' }), 0)
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'high', source: 'rule', quote: 'was' }), 72)
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'high', source: 'ai', quote: 'x y' }), 65, 'AI 核对通过且相关 = 中等分')
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'medium', source: 'ai', quote: 'x y' }), 50, '关联不明显：不够线')
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'low', source: 'ai', quote: '' }), 25, '核对不上 = 低分')
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'high', source: 'ai', quote: 'x y', reason: 'r｜教材桥：人教PEP 四年级上册 第1单元' }), 80, '教材桥 +15')
  assert.equal(scoreOf({ ...base, state: 'suggested', confidence: 'medium', source: 'bridge', reason: '教材桥：x' }), 70)
  assert.equal(MATCH_THRESHOLD, 60)
  assert.equal(isMainMap({ ...base, state: 'suggested', confidence: 'medium', source: 'ai', quote: 'x y' }), false)
  assert.match(evidenceOf({ source: 'rule', quote: 'was、yesterday', state: 'suggested' }), /命中词：was、yesterday/)
  assert.match(evidenceOf({ source: 'ai', quote: 'cat dog', state: 'suggested' }), /原文：“cat dog”/)
  assert.match(evidenceOf({ source: 'bridge', reason: '教材桥：人教PEP 四年级上册 第1单元', state: 'suggested' }), /对标教材：人教PEP/)
}

// ── 每节课最多 3 个主知识点，其余是「顺带」；教材单元不限 ──
{
  const row = (code, q, lesson = 1, kind) => ({ kp_code: code, lesson_id: lesson, state: 'suggested', confidence: 'high', source: 'rule', quote: q, kind })
  const rows = [row('GR.TENSE.PAST', 'was、yesterday'), row('GR.TENSE.PAST.REG', '规则动词过去式'), row('GR.TENSE.FUT', 'tomorrow'), row('GR.TENSE.FUT.WILL', 'will'), row('GR.SENT.NEG', '否定句'), row('GR.TENSE.PRES', 'every day')]
  const c = classifyMaps(rows)
  const mains = c.filter(r => r.role === 'main')
  assert.equal(mains.length, MAX_MAIN_PER_LESSON, '每节课最多 3 个')
  assert.equal(mains[0].kp_code, 'GR.TENSE.PAST', '分数最高的（两个强词）排第一')
  assert.equal(c.filter(r => r.role === 'side').length, 2, '过线但排在前 3 之后的是「顺带」')
  assert.ok(c.find(r => r.kp_code === 'GR.TENSE.PRES').role === 'weak', '弱词不够线：把握不高')
  assert.ok(mains[0].score >= mains[2].score, '按分数从高到低')
  assert.equal(selectMain(rows).length, 3)
  // 老师确认的不受上限限制，且占名额
  const withConfirmed = classifyMaps([...rows, { ...row('GR.NUM.CARD', ''), state: 'confirmed' }, { ...row('GR.NUM.ORD', ''), state: 'confirmed' }])
  assert.equal(withConfirmed.filter(r => r.role === 'main').length, 3, '2 个确认 + 1 个自动 = 3')
  assert.equal(classifyMaps(rows.map(r => ({ ...r, kind: 'textbook' }))).filter(r => r.role === 'main').length, 5, '教材单元不限个数（弱词那条不够线）')
}

// ── 教材桥 ──
{
  assert.deepEqual(parseRef('人教PEP 四年级上册 Unit 1'), { grade: 4, semester: '上', unit: 1 })
  assert.deepEqual(parseRef('PEP 四上 第1单元'), { grade: 4, semester: '上', unit: 1 })
  assert.equal(parseRef('人教PEP 四年级'), null, '认不全不桥')
  const hit = resolveBridge('人教PEP 四年级上册 Unit 1', 'english', CATALOG)
  assert.ok(hit && hit.kps.length > 0 && hit.kps.includes('GR.VERB.MODAL.CAN'), '能对上内置教材单元，沿用该单元的知识点')
  assert.equal(resolveBridge('某某出版社 四年级上册 Unit 1', 'english', CATALOG), null, '版本认不出就不桥')
  assert.equal(resolveBridge('人教PEP 四年级上册 Unit 99', 'english', CATALOG), null)
  const lesson = { id: 7, levelName: 'L', seq: 1, noLabel: '1', title: 'Helping', theme: '', textbookRef: '人教PEP 四年级上册 Unit 1', points: [{ kind: 'pattern', label: '句型', text: 'I can sweep the floor. Can you help me?' }] }
  const codes = new Set(['GR.VERB.MODAL.CAN', 'GR.SENT.WH.WHAT', 'FN.PLAN'])
  const cands = mergeCandidates([...ruleCandidates(lesson, codes), ...bridgeCandidates(lesson, 'english', CATALOG, codes)])
  const can = cands.find(c => c.code === 'GR.VERB.MODAL.CAN')
  assert.ok(can.reason.includes('教材桥') && can.source === 'rule', '规则 + 教材桥合并为一条，依据都写着')
  assert.equal(candidateScore(can), ruleScore(0, 2) + 15, '两个弱词 50 分 + 教材桥 15 分，过线')
  assert.ok(candidateScore(can) >= MATCH_THRESHOLD)
  const bridgeOnly = cands.find(c => c.code === 'GR.SENT.WH.WHAT')
  assert.equal(bridgeOnly.source, 'bridge'); assert.equal(candidateScore(bridgeOnly), 70)
  assert.deepEqual(lessonsNeedingAi([7, 8], cands), [8], '认得够多的课不用问 AI；什么都没认出的课才问')
}

// ── 落库：规则先认、否决不回流、确认保留、重复运行结果一样 ──
const { db } = newDb()
useTree(db, [
  ['GR', null, '语法', 1], ['GR.TENSE', 'GR', '时态', 2], ['GR.TENSE.PAST', 'GR.TENSE', '一般过去时', 3], ['GR.TENSE.FUT', 'GR.TENSE', '一般将来时', 3],
  ['GR.NOUN', 'GR', '名词', 2], ['GR.NOUN.PLURAL.REG', 'GR.NOUN', '规则复数', 3], ['GR.ADJ', 'GR', '形容词', 2], ['GR.ADJ.COMPARE', 'GR.ADJ', '比较级', 3],
  ['GR.SENT', 'GR', '句型', 2], ['GR.SENT.NEG', 'GR.SENT', '否定句', 3], ['VO', null, '词汇', 1], ['VO.TOPIC', 'VO', '主题词汇', 2], ['VO.TOPIC.FAMILY', 'VO.TOPIC', '家庭', 3]
])
const q = (kp, extra = {}) => ({ kp, score: 5, stem: `题 ${kp}`, ...extra })
const p1 = addPaper(db, { title: '卷一', questions: [q('GR.TENSE.PAST', { stem: 'Yesterday I visited my grandma. (visit)', err: true }), q('GR.TENSE.PAST'), q('GR.NOUN.PLURAL.REG', { score: 2 }), q('GR.ADJ.COMPARE', { score: 3 })] })
addPaper(db, { title: '卷二', questions: [q('GR.TENSE.PAST', { score: 6 }), q('VO.TOPIC.FAMILY', { score: 1, stem: 'Who is your father?' })] })
const lesson = (seq, title, words, patterns, extra = {}) => ({ seq, noLabel: String(seq), title, theme: extra.theme ?? '', textbookRef: extra.ref ?? '', points: [{ kind: 'word', label: '词汇', text: words }, { kind: 'pattern', label: '句型', text: patterns }], raw: {} })
const mk = (name, kind, lessons) => createOutline(db, { name, scene: 'org', termNote: '', sourceName: '', sourceHash: '', mapping: null, warnings: [], aiModel: '', status: 'active', kind, levels: [{ name: '基础级', lessons }] })
const A = mk('机构课程', 'course', [
  lesson(1, 'Last weekend', 'visited, watched, played', 'What did you do yesterday? I was at home.', { theme: '周末' }),
  lesson(2, 'Animals', 'monkey, panda', "It's a panda."),
  lesson(3, 'Family', 'father, mother, sister', 'Who is he? He is my father.', { theme: '家庭' })
])
const kps = targetKps(db)
const meta = { rev: 1, model: 'rules', promptVersion: 'v' }
const mapsOf = () => db.prepare('SELECT kp_code, lesson_id, source, state, confidence, quote FROM course_kp_map WHERE outline_id = ? ORDER BY lesson_id, kp_code').all(A)
{
  assert.deepEqual(kps.map(k => k.code).sort(), ['GR.ADJ.COMPARE', 'GR.NOUN.PLURAL.REG', 'GR.TENSE.PAST', 'VO.TOPIC.FAMILY'], '只匹配有题标过的二三级知识点')
  const pass = computeRulePass(db, A, 'english', kps, CATALOG)
  const w = applyRulePass(db, A, pass, kps, meta)
  const rows = mapsOf()
  const l1 = db.prepare('SELECT id FROM course_lessons WHERE outline_id = ? AND seq = 1').get(A).id
  const l2 = db.prepare('SELECT id FROM course_lessons WHERE outline_id = ? AND seq = 2').get(A).id
  const l3 = db.prepare('SELECT id FROM course_lessons WHERE outline_id = ? AND seq = 3').get(A).id
  assert.ok(rows.some(r => r.lesson_id === l1 && r.kp_code === 'GR.TENSE.PAST' && r.source === 'rule' && /yesterday|was/.test(r.quote)), '规则命中并记下命中词')
  assert.ok(!rows.some(r => r.lesson_id === l2 && scoreOf({ ...r, kp_code: r.kp_code }) >= MATCH_THRESHOLD), '动物课没有任何过线的匹配')
  assert.ok(rows.some(r => r.lesson_id === l3 && r.kp_code === 'VO.TOPIC.FAMILY'), '家庭词汇：多个主题词一起出现')
  assert.ok(w.matched >= 2)
  assert.equal(pass.needAi.includes(l2), true, '规则没认出的课交给 AI 补充')
  // 重复运行：结果完全一样（确定性）
  const before = JSON.stringify(mapsOf())
  applyRulePass(db, A, computeRulePass(db, A, 'english', kps, CATALOG), kps, meta)
  assert.equal(JSON.stringify(mapsOf()), before, '同样的输入同样的结果')
  // 否决：不再被规则加回；确认：保留
  assert.equal(editMap(db, { op: 'reject', kp: 'GR.TENSE.PAST', lessonId: l1 }), true)
  assert.equal(editMap(db, { op: 'confirm', kp: 'VO.TOPIC.FAMILY', lessonId: l3 }), true)
  applyRulePass(db, A, computeRulePass(db, A, 'english', kps, CATALOG), kps, meta)
  const after = mapsOf()
  const rej = after.find(r => r.lesson_id === l1 && r.kp_code === 'GR.TENSE.PAST')
  assert.equal(rej.state, 'rejected', '否决过的不被规则翻回去')
  assert.equal(after.filter(r => r.lesson_id === l1 && r.kp_code === 'GR.TENSE.PAST').length, 1)
  assert.equal(after.find(r => r.lesson_id === l3 && r.kp_code === 'VO.TOPIC.FAMILY').state, 'confirmed')
  // 读出来：老数据没有分数也能算；否决 = 0
  const view = mapRows(db, A)
  assert.equal(view.find(r => r.kp === 'GR.TENSE.PAST' && r.lessonId === l1).score, 0)
  assert.equal(view.find(r => r.kp === 'VO.TOPIC.FAMILY' && r.lessonId === l3).score, 100)
  assert.ok(view.every(r => typeof r.score === 'number' && r.role))
  // 主要匹配（不含否决）
  const main = mainMapRows(db, [A])
  assert.ok(!main.some(m => m.kp_code === 'GR.TENSE.PAST' && m.lesson_id === l1))
  assert.ok(main.some(m => m.kp_code === 'VO.TOPIC.FAMILY'))
  // 改回来方便后面用
  editMap(db, { op: 'reset', kp: 'GR.TENSE.PAST', lessonId: l1 })
  applyRulePass(db, A, computeRulePass(db, A, 'english', kps, CATALOG), kps, meta)
}

// ── 试卷占分（重要度） ──
{
  const imp = kpImportance(db, {})
  assert.equal(imp.paperTotal, 2); assert.equal(imp.hasScores, true)
  const past = importanceOf(imp, 'GR.TENSE.PAST')
  assert.equal(past.papers, 2)
  assert.equal(past.avgScore, 8, '(5 + 5 + 6) ÷ 2 份卷子 = 每份卷子平均 8 分')
  assert.equal(importanceOf(imp, 'GR.TENSE').avgScore, 8, '子树汇总')
  assert.equal(importanceOf(imp, 'GR.NOUN.PLURAL.REG').avgScore, 1)
  assert.ok(importanceOf(imp, 'GR.TENSE.PAST').errorRate > 0, '易错率')
  assert.equal(importanceOf(imp, 'GR.SENT.NEG').papers, 0)
  assert.match(importanceText(past, true), /校内约占 8 分 · 2\/2 份卷子考过/)
  assert.equal(importanceText(importanceOf(imp, 'GR.SENT.NEG'), true), '范围内没考到')
}

// ── 课 ↔ 单元：防瞎匹配 ──
{
  const near = (a, b) => a === b
  const lt = { title: 'Family', theme: '家庭', points: [{ kind: 'word', text: 'father, mother, sister' }, { kind: 'pattern', text: 'Who is he? He is my father.' }] }
  const unitOK = { id: 1, title: 'Unit 2 My family', lines: ['话题：家庭成员', '核心问题：Who is he? Who is she?'], kps: ['VO.TOPIC.FAMILY'] }
  const m = matchUnit(lt, [{ code: 'VO.TOPIC.FAMILY', name: '家庭' }], unitOK, near)
  assert.ok(m && m.verbatim, '句型原文逐字命中就算数')
  assert.match(m.evidence, /同句型：who is he/i); assert.match(m.evidence, /同话题：.*家庭/); assert.equal(m.byCatalog, false)
  // 只靠一类弱信号：不进表
  assert.equal(matchUnit({ title: 'Zoo', theme: '动物园', points: [] }, [], { id: 2, title: 'Unit 5 动物园之旅', lines: [], kps: [] }, near), null, '只有话题一类')
  assert.equal(matchUnit({ title: 'Zoo', theme: '', points: [] }, [{ code: 'A', name: '甲' }], { id: 3, title: 'Unit 6', lines: [], kps: ['A'] }, near), null, '只有知识点代码一类')
  // 话题 + 知识点两类 → 进表
  const two = matchUnit({ title: 'Zoo animals', theme: '动物园', points: [] }, [{ code: 'A', name: '甲' }], { id: 4, title: 'Unit 5 动物园之旅', lines: [], kps: ['A'] }, near)
  assert.ok(two && !two.verbatim && two.kinds.includes('topic') && two.kinds.includes('kp'))
  // 概括 / 未逐课核对的单元：不参与逐字匹配，只当话题提示，且标「按目录」
  assert.equal(isUnverifiedNote('新版：话题与核心问题取自目录；句型为按单元主题概括，未逐课核对课本原文'), true)
  const sum = { id: 5, title: 'Unit 3 Places', lines: ['话题：社区场所', '句型（概括）：Who is he? He is my father.'], kps: [], unverified: true }
  assert.equal(matchUnit(lt, [], sum, near), null, '概括的句型不能当原文命中')
  const sumKp = matchUnit({ ...lt, title: 'Places 社区', theme: '社区场所' }, [{ code: 'K', name: '甲' }], { ...sum, kps: ['K'] }, near)
  assert.ok(sumKp && sumKp.byCatalog && !sumKp.verbatim && !/同句型|同词汇/.test(sumKp.evidence), '话题 + 知识点两类可以，但只算按目录的弱依据')
  // 每个版本只给最像的 1–2 个
  const picked = pickUnits([{ unitId: 1, score: 90 }, { unitId: 2, score: 80 }, { unitId: 3, score: 50 }].map(x => ({ ...x, evidence: '', kinds: [], verbatim: true, byCatalog: false })))
  assert.deepEqual(picked.map(x => x.unitId), [1, 2])
}

// ── 课 ↔ 原题：防瞎匹配 ──
{
  const near = (a, b) => a === b
  const lt = { title: 'Last weekend', theme: '', points: [{ kind: 'word', text: 'visited, watched' }, { kind: 'pattern', text: 'What did you do yesterday?' }] }
  const Q = (stem, kps = []) => ({ id: stem, stem, options: [], errorProne: false, kps })
  assert.ok(matchExample(lt, [], Q('Yesterday I visited my grandma.'), near)?.verbatim, '课里的词在题干里逐字出现')
  assert.ok(matchExample(lt, [], Q('What did you do yesterday? I ____.'), near)?.score >= 30, '句型逐字命中加分更多')
  assert.equal(matchExample(lt, [{ code: 'K', name: '甲', strong: false }], Q('随便一道题', [{ code: 'K', primary: true }]), near), null, '只靠知识点代码一类（课 ↔ 知识点本身没有原文依据）：不进')
  const ok = matchExample(lt, [{ code: 'K', name: '甲', strong: true }], Q('随便一道题', [{ code: 'K', primary: true }]), near)
  assert.ok(ok && ok.kpCode === 'K' && ok.kinds.includes('kp-evidence'), '知识点代码相同 + 课 ↔ 知识点有原文依据 = 两类依据')
}

// ── 对照表整合：匹配把握、占分、教材单元、例题、排序 ──
{
  const T = mk('示例教材', 'textbook', [
    { seq: 1, noLabel: '第1单元', title: 'Unit 1 Last weekend', theme: '', textbookRef: '', points: [{ kind: 'other', label: '内容', text: '话题：周末活动、核心问题：What did you do yesterday?' }], raw: {} },
    { seq: 2, noLabel: '第2单元', title: 'Unit 2 My family', theme: '', textbookRef: '', points: [{ kind: 'other', label: '内容', text: '话题：家庭成员' }, { kind: 'other', label: '说明', text: '句型为按单元主题概括，未逐课核对课本原文' }], raw: {} }
  ])
  db.prepare("UPDATE course_kp_map SET state = state WHERE 1=0").run()
  editMap(db, { op: 'add', outlineId: T, kp: 'GR.TENSE.PAST', lessonId: db.prepare('SELECT id FROM course_lessons WHERE outline_id = ? AND seq = 1').get(T).id })
  editMap(db, { op: 'add', outlineId: T, kp: 'VO.TOPIC.FAMILY', lessonId: db.prepare('SELECT id FROM course_lessons WHERE outline_id = ? AND seq = 2').get(T).id })
  db.prepare('INSERT OR REPLACE INTO course_kp_check (outline_id, kp_code, result, outline_rev, kp_sig, model, prompt_version) SELECT ?, code, \'matched\', rev, \'\', \'builtin\', \'\' FROM kps, course_outlines WHERE id = ?').run(T, T)
  const r1 = researchTable(db, {}, { courseId: A, textbookIds: [T] })
  assert.equal(r1.ready, r1.reason || true)
  const r2 = researchTable(db, {}, { courseId: A, textbookIds: [T] })
  assert.equal(JSON.stringify(r1.lessons.map(l => [l.title, l.kps.map(k => k.code), l.units.map(u => u.label)])), JSON.stringify(r2.lessons.map(l => [l.title, l.kps.map(k => k.code), l.units.map(u => u.label)])), '同样的输入每次结果一样')
  const weekend = r1.lessons.find(l => l.title === 'Last weekend')
  const past = weekend.kps.find(k => k.code === 'GR.TENSE.PAST')
  assert.ok(past, '已经被我手动否决再 reset 的又由规则认回来')
  assert.ok(past.matchScore >= 72 && /命中词/.test(past.evidence) && past.matchLabel)
  assert.equal(past.avgScore, 8); assert.ok(past.weight > 0)
  assert.ok(weekend.units.length >= 1 && weekend.units[0].evidence && weekend.units[0].similarity, '教材位置由课直接比出来，带依据')
  assert.match(weekend.units[0].title, /Last weekend/)
  assert.ok(weekend.kps.every(k => k.matchScore >= MATCH_THRESHOLD), '没过线的不进表')
  assert.ok(weekend.kps.length <= MAX_MAIN_PER_LESSON)
  const fam = r1.lessons.find(l => l.title === 'Family')
  const famUnit = fam.units.find(u => /My family/.test(u.title))
  assert.ok(!famUnit || famUnit.byCatalog === true, '说明里写着“未逐课核对”的单元：标按目录')
  assert.ok(weekend.kps.flatMap(k => k.examples).every(e => e.why), '每道例题写明为什么挂在这里')
  assert.ok(weekend.kps.flatMap(k => k.examples).some(e => /Yesterday I visited/.test(e.stem)), '题干里逐字出现课上词汇的原题被挂上')
  assert.ok(weekend.kps.flatMap(k => k.examples).length <= r1.perKp, '每节课只列最相关的几道')
  assert.equal(r1.hasScores, true)
  assert.ok(Number.isInteger(r1.weakCount))
  // Excel：表头用老师看得懂的说法
  const x = researchSheetRows(r1)
  assert.ok(x.header.includes('匹配把握') && x.header.includes('校内约占几分') && x.header.includes('教材位置'))
  assert.ok(!x.header.some(h => /分数|score|0–100/.test(h)))
  assert.ok(x.flat.some(row => row.some(c => /校内约占 8 分/.test(c))))
}

// ── 试卷范围默认 = 和所选教材同年级的全部试卷 ──
{
  assert.deepEqual(withGradeScope(db, {}, ['4']), { grade: '4' })
  assert.deepEqual(withGradeScope(db, { grade: '3' }, ['4']), { grade: '3' }, '老师自己选了年级就听老师的')
  assert.deepEqual(withGradeScope(db, {}, []), {})
  const two = withGradeScope(db, {}, ['3', '4'])
  assert.ok(two.paperIds && two.paperIds.length === 2, '跨年级：取这几个年级的全部试卷（样例卷子都是四年级）')
  const none = researchTable(db, {}, { courseId: A, textbookIds: [], grades: ['6'] })
  assert.equal(none.papers, 0, '同年级一份卷子都没有：范围为空（界面显示“去导入试卷”）')
}

console.log('course-match-score.test ✓')
