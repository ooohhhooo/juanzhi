// 语文 / 数学的学科内容与 AI：提示词按学科取、解析的题型兜底、事实核对对非英语生效、家长版问候、课程对照按学科、数学符号校正
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newDb, addPaper } from './helpers/db.mjs'
import { isPromptKey, promptProblem, splitPromptKey, splitPromptRef, promptRefOf, SUBJECT_PROMPT_IDS } from '../../src/main/ai/prompt-rules.ts'
import { MA_KP_SEEDS_V1, MA_QTYPE_SEEDS_V1 } from '../../src/main/seed/taxonomy-math.ts'
import { CN_KP_SEEDS_V1, CN_QTYPE_SEEDS_V1 } from '../../src/main/seed/taxonomy-chinese.ts'
import { normalizeQtype, fixMathText } from '../../src/main/parse/validate.ts'
import { checkRulesFor, ruleTalk, isRuleSentenceFor } from '../../src/shared/factcheck.ts'
import { parentGreeting, fixParent } from '../../src/shared/parent-fix.ts'
import { finishReport, verifyWarning, refreshVerifyWarnings } from '../../src/main/report/finish.ts'
import { reportTitle } from '../../src/shared/report-post.ts'
import { targetKps, listOutlines, createOutline } from '../../src/main/course/store.ts'
import { outlineLine, quoteLongEnough, quoteTouchesKp } from '../../src/main/course/match.ts'
import { guessField, fieldLabelsOf } from '../../src/main/course/map.ts'
import { templateHeadersOf, templateRows, sampleSheets } from '../../src/main/course/template.ts'
import { exampleOf } from '../../src/main/report/teacher-sections.ts'
import { validateVariants } from '../../src/main/report/variants-check.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = path.join(root, 'src/main/ai/prompts')
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
const phs = t => [...new Set([...t.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))].sort()

// ───── 1. 提示词：key 规则、60 个文件齐全且合格、固定措辞保留、不夹带英语内容 ─────
assert.deepEqual(splitPromptKey('math:p1_text.system'), { subject: 'math', base: 'p1_text.system' })
assert.deepEqual(splitPromptKey('p1_text.system'), { subject: 'english', base: 'p1_text.system' })
assert.deepEqual(splitPromptRef('chinese:p3_parent'), { subject: 'chinese', id: 'p3_parent' })
assert.equal(promptRefOf('p3_parent', 'math'), 'math:p3_parent')
assert.equal(promptRefOf('p3_parent', 'english'), 'p3_parent')
assert.ok(isPromptKey('p1_text.system') && isPromptKey('math:p1_text.system') && isPromptKey('chinese:p5_course_hint.user'))
assert.ok(!isPromptKey('math:p6_classify_propose.system') && !isPromptKey('math:p7_role_draft.user') && !isPromptKey('french:p1_text.system'), '没有学科版本的提示词不认学科前缀')
assert.ok(promptProblem('math:p1_text.system', '没有那个词'), 'P1 的 system 必须有 JSON：带学科前缀也要查')
assert.ok(promptProblem('math:p1_text.user', '缺占位符'), '带学科前缀也要查必需占位符')
assert.equal(SUBJECT_PROMPT_IDS.length, 15)

const ROUTE = {
  p1_text: [['system', 'JSON'], ['user', '知识点树']], p1_vision: [['system', 'JSON'], ['user', '知识点树']],
  p2_yoy: [['system', '年度变化分析'], ['user', '【新增知识点】']], p2_kp: [['system', '只围绕输入里给出的这一个考点'], ['user', '【这一个考点】']],
  p3_report: [['system', '考情分析报告'], ['user', '【知识点分布】']], p3_boss: [['system', '【读者：老板】'], ['system', '考情分析报告']],
  p3_parent: [['system', '【读者：家长】']], p3_teacher: [['system', '【读者：辅导老师】'], ['system', '考情分析报告']],
  p3_tricks: [['system', '【任务：口诀大招】']], p4_variant_gen: [['system', '【任务：同类变形题】']], p4_variant_check: [['system', '【任务：独立解答】']],
  p5_course_cols: [['system', '请只判断「哪几行是表头']], p5_course_match: [['system', '请以课为单位判断每节课主要讲了哪些考点']],
  p5_course_advice: [['system', '要写一段能直接发给家长的话（150–200 字']], p5_course_hint: [['system', '要给家长版报告写结尾处的一句课程建议']]
}
let nFiles = 0
for (const s of ['chinese', 'math']) {
  const word = s === 'math' ? '数学' : '语文'
  for (const id of SUBJECT_PROMPT_IDS) {
    for (const part of ['system', 'user']) {
      const t = read(`${id}.${s}.${part}.txt`)
      nFiles++
      assert.equal(promptProblem(`${s}:${id}.${part}`, t), null, `${s}:${id}.${part} 不合格：${promptProblem(`${s}:${id}.${part}`, t)}`)
      if (part === 'user') assert.deepEqual(phs(t), phs(read(`${id}.${part}.txt`)), `${s}:${id}.user 的占位符要和英语版一致`)
      assert.ok(!/sheep|tomato|time for|farm|PH_DIFF|GR\.|Look!/.test(t), `${s}:${id}.${part} 里夹着英语示例`)
      if (part === 'system' && id !== 'p5_course_cols') assert.ok(!/讲英语|英语老师|英语教研员/.test(t), `${s}:${id}.system 里还有英语措辞`)
    }
    for (const [part, phrase] of ROUTE[id]) assert.ok(read(`${id}.${s}.${part}.txt`).includes(phrase), `${s}:${id}.${part} 缺少固定措辞：${phrase}`)
  }
  // 学科名出现在角色里
  for (const id of ['p1_text', 'p1_vision', 'p3_report', 'p3_parent', 'p4_variant_gen']) assert.ok(read(`${id}.${s}.system.txt`).includes(`小学${word}`), `${id} 的角色要写小学${word}`)
}
assert.equal(nFiles, 60)

// 识别提示词按调研里的难点来写
{
  const m = read('p1_text.math.system.txt'), mv = read('p1_vision.math.system.txt')
  for (const w of ['MA_ORAL', '竖式', '分数', 'cm²', 'needs_image', '一个大题只记一条', '【旧教材】']) assert.ok(m.includes(w), `数学文本版缺少：${w}`)
  for (const w of ['MA_ORAL', '竖式', '分数', 'needs_image']) assert.ok(mv.includes(w), `数学视觉版缺少：${w}`)
  const c = read('p1_text.chinese.system.txt'), cv = read('p1_vision.chinese.system.txt')
  for (const w of ['声调', '加点字', 'underline_lost', '田字格', '古诗', '习作', 'CN_ESSAY', 'poem']) assert.ok(c.includes(w), `语文文本版缺少：${w}`)
  for (const w of ['声调', '加点字', '<u>', '田字格', '竖排']) assert.ok(cv.includes(w), `语文视觉版缺少：${w}`)
  assert.ok(m.includes('"MA_OTHER"') && !m.includes('"OTHER"') && c.includes('"CN_OTHER"') && !c.includes('"OTHER"'), 'OTHER 兜底要换成本学科的')
}

// 示例里的知识点、题型代码都在本学科的种子里
for (const [s, kpSeeds, qtSeeds] of [['math', MA_KP_SEEDS_V1, MA_QTYPE_SEEDS_V1], ['chinese', CN_KP_SEEDS_V1, CN_QTYPE_SEEDS_V1]]) {
  const kps = new Set(kpSeeds.map(k => k[0])), qts = new Set(qtSeeds.map(q => q[0]))
  const text = read(`p1_text.${s}.system.txt`) + '\n' + read(`p1_vision.${s}.system.txt`)
  const usedKp = [...text.matchAll(/"kp_(?:main|secondary)":\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])).filter(Boolean)
  const usedQt = [...text.matchAll(/"qtype":"([^"]+)"/g)].map(m => m[1])
  assert.ok(usedKp.length >= 4 && usedQt.length >= 4, `${s}：应能从示例里取到代码`)
  for (const c of usedKp) assert.ok(kps.has(c), `${s} 示例里的知识点代码 ${c} 不在种子里`)
  for (const c of usedQt) assert.ok(qts.has(c), `${s} 示例里的题型代码 ${c} 不在种子里`)
  // 文字里提到的 MA_ / CN_ 题型代码也都存在
  const prefix = s === 'math' ? 'MA_' : 'CN_'
  for (const c of new Set([...text.matchAll(new RegExp(`\\b${prefix}[A-Z_]+\\b`, 'g'))].map(m => m[0]))) assert.ok(qts.has(c), `${s} 提示词里提到的题型代码 ${c} 不存在`)
}

// ───── 2. 解析：用对应学科的树、OTHER 兜底按学科 ─────
{
  const { db } = newDb()
  const treeOf = s => new Set(db.prepare('SELECT code FROM kps WHERE subject = ? AND deprecated = 0').all(s).map(r => r.code))
  const qtOf = s => new Set(db.prepare('SELECT code FROM qtypes WHERE subject = ?').all(s).map(r => r.code))
  assert.ok(treeOf('math').has('MA.CALC.FRAC.DIV') && !treeOf('math').has('GR.NOUN.PLURAL.IRR') && !treeOf('math').has('CN.PY'))
  assert.ok(qtOf('chinese').has('CN_OTHER') && !qtOf('chinese').has('OTHER') && qtOf('english').has('OTHER'))
  const src = fs.readFileSync(path.join(root, 'src/main/parse/run.ts'), 'utf8')
  assert.ok(/loadTaxonomy\(subject\)/.test(src) && /SUBJECTS\[subject\]\.otherQtype/.test(src) && /default_textbook\.\$\{paperSubject\}/.test(src), 'run.ts 要按卷子的学科取树 / 兜底 / 默认教材')
  assert.ok(/promptText\('p1_text', 'system', subject\)/.test(src) && /promptVersionFor\('p1_vision', subject\)/.test(src))
}
assert.deepEqual(normalizeQtype('MA_FILL', new Set(['MA_FILL', 'MA_OTHER']), 'MA_OTHER'), { qtype: 'MA_FILL', invalid: false })
assert.deepEqual(normalizeQtype('CHOICE', new Set(['MA_FILL', 'MA_OTHER']), 'MA_OTHER'), { qtype: 'MA_OTHER', invalid: true })
assert.deepEqual(normalizeQtype('OTHER', new Set(['CN_CHOICE', 'CN_OTHER']), 'CN_OTHER'), { qtype: 'CN_OTHER', invalid: false }, '沿用英语兜底代码 = 没填，不算无效')
assert.deepEqual(normalizeQtype('XX', new Set(['MC', 'OTHER'])), { qtype: 'OTHER', invalid: true }, '英语行为不变')

// ───── 3. 数学符号校正 ─────
assert.equal(fixMathText('3.5 m2 = （ ）dm2'), '3.5 m² = （ ）dm²')
assert.equal(fixMathText('体积 12 cm3，面积 8 cm2。'), '体积 12 cm³，面积 8 cm²。')
assert.equal(fixMathText('0.5 x 8 = ； 12X3 ； 4*5'), '0.5×8 = ； 12×3 ； 4×5')
assert.equal(fixMathText('2x+3=7，x=2'), '2x+3=7，x=2', '字母 x 作未知数不动')
assert.equal(fixMathText('item2 和 cm25 和 m2x'), 'item2 和 cm25 和 m2x', '前后挨着字母数字的不动')
assert.equal(fixMathText('km2'), 'km²')

// ───── 4. 事实核对对语文 / 数学生效：规则句没有证据就标「未核实」 ─────
assert.equal(ruleTalk('math'), '讲数学规则'); assert.equal(ruleTalk('chinese'), '讲语文规则'); assert.equal(ruleTalk(undefined), '讲英语规则')
const MA_MD = '## 教学建议\n异分母分数相加要先通分，再把分子相加。\n圆的面积等于圆周率乘半径的平方。\n3 份卷子里有 2 份考了这个知识点，占比 20%。'
const none = checkRulesFor('math', MA_MD, [])
assert.equal(none.length, 2, '没有证据：两条规则句都未核实，数据句不算：' + JSON.stringify(none.map(f => f.sentence)))
assert.ok(none.every(f => f.kind === 'unverified'))
assert.ok(isRuleSentenceFor('math', '1 m² = 100 dm²') && !isRuleSentenceFor('math', '这份卷子有 3 份。'))
const withEv = checkRulesFor('math', MA_MD, ['异分母分数相加要先通分，再把分子相加；孩子容易直接把分母相加'])
assert.deepEqual(withEv.map(f => f.sentence), ['圆的面积等于圆周率乘半径的平方'], '有证据的放行，没证据的仍标')
const tokenMiss = checkRulesFor('math', '1 m² = 100 dm² 要记牢。', ['面积单位要换算'])
assert.equal(tokenMiss.length, 1, '句子里的数字证据里没有 → 未核实')
const CN_MD = '“重”在“重量”里读 zhòng。\n比喻句要用“像”“好像”这类词。'
assert.equal(checkRulesFor('chinese', CN_MD, []).length, 2)
assert.equal(checkRulesFor('chinese', CN_MD, ['“重”在“重量”里读 zhòng，在“重复”里读 chóng；比喻句要用“像”“好像”这类词']).length, 0)
assert.ok(checkRulesFor('english', 'time for 后接动词。', ['time for 后接名词']).some(f => f.kind === 'conflict'), '英语仍走原来的冲突判断')

// 整份报告：finishReport 对数学标「未核实」，警告文案跟学科
{
  const mk = (subject, raw, evidence = []) => finishReport({ raw, reader: 'full', title: '测试', knownRefs: new Set(), knownCodes: [], sampleWarning: '无', evidence, usedDefaultPrompt: false, subject })
  const r = mk('math', '## 教学建议\n异分母分数相加要先通分。')
  assert.equal(r.unverified.length, 1); assert.ok(r.text.includes('〔未核实〕'))
  assert.equal(mk('math', '## 教学建议\n异分母分数相加要先通分。', ['异分母分数相加要先通分']).unverified.length, 0)
  assert.equal(mk('chinese', '多音字要看词语来定读音。').unverified.length, 1)
  const w = verifyWarning(r.unverified, 0, 'math')
  assert.ok(w.includes('讲数学规则的话') && !w.includes('英语'))
  assert.ok(verifyWarning(r.unverified).includes('讲英语规则的话'), '缺省仍是英语')
  assert.deepEqual(refreshVerifyWarnings([w, '别的提示'], [], 'math'), ['别的提示'], '数学的那条提示也能被识别并重算')
  assert.deepEqual(refreshVerifyWarnings([verifyWarning(r.unverified, 0, 'chinese'), '别的提示'], r.unverified, 'chinese').length, 2)
  // 家长版：问候语按学科
  const parent = '各位家长好，这次期末数学有 3 个小地方孩子容易错：\n\n1. 孩子容易直接把异分母分数的分母相加。在家做：让孩子算 1/2+1/3。标准答案：算出 5/6 就对了。【考点：异分母分数加减】\n\n整体不用太担心。'
  const pr = mk('math', parent.replace('各位家长好，这次期末数学有 3 个小地方孩子容易错：\n\n', ''))
  const pp = finishReport({ raw: parent.replace('各位家长好，这次期末数学有 3 个小地方孩子容易错：\n\n', ''), reader: 'parent', title: 't', knownRefs: new Set(), knownCodes: [], sampleWarning: '无', evidence: [], usedDefaultPrompt: false, subject: 'math', examLabel: '期末', evidenceKps: [] })
  assert.ok(pp.text.startsWith('各位家长好，这次期末数学'), '家长版问候写数学：' + pp.text.slice(0, 30))
  assert.ok(!pp.text.includes('英语'))
  assert.ok(pr.text.length > 0)
}
assert.equal(parentGreeting('期末'), '各位家长好，这次期末英语有这几个小地方孩子容易错，在家几分钟就能帮上：', '英语问候不变')
assert.ok(parentGreeting('期中', 'chinese').includes('期中语文') && parentGreeting(null, 'math').includes('数学考试'))
{
  const md = '1. 孩子容易分不清多音字“重”的读音。在家做：让孩子读“重量”。标准答案：读成 zhòng liàng 就对了。例：这件行李很重。\n\n2. 孩子容易把“的”“地”用混。在家做：让孩子说一句话。标准答案：说对一句就好。\n\n3. 孩子容易写错别字。在家做：让孩子写“朋友”。标准答案：写对两个字就好。\n\n整体不用太担心。'
  const kps = [{ name: '多音字', plain: '', example_en: '', example_zh: '这件行李很重。' }]
  const f = fixParent(md, kps, m => m.length, 300, '期末', 'chinese')
  assert.ok(f.text.startsWith('各位家长好，这次期末语文'), f.text.slice(0, 40))
  assert.equal(f.replaced, 0); assert.equal(f.dropped, 0)
  assert.ok(f.text.includes('例：这件行李很重。'), '语文的「例：」不会被英文例句校对改掉')
}

// ───── 5. 老师版 / 变形题：例子标签、数字也算词 ─────
assert.deepEqual(exampleOf({ example_en: 'I went.', example_zh: '我去了' }, 'english'), { label: '例句', text: 'I went. 我去了' })
assert.deepEqual(exampleOf({ example_en: '', example_zh: '1/2+1/3=5/6' }, 'math'), { label: '例子', text: '1/2+1/3=5/6' })
{
  const raw = JSON.stringify({ questions: [{ kp: 1, qtype: 'blank', stem: '计算 4+6=____', options: [], answer: '10', explanation: '相加', changed: '换数' }] })
  const ctx = { kpCodes: ['MA.CALC.ADD.WITHIN20'], originals: ['计算 3+5=____'], vocab: new Set() }
  assert.ok(validateVariants(raw, ctx).variants[0].problems.some(p => /照抄/.test(p)), '英语算法不带数字：只差数字会被当成照抄（原行为）')
  assert.equal(validateVariants(raw, { ...ctx, subject: 'math' }).variants[0].problems.length, 0, '数学：数字不同就是另一道题')
}

// ───── 6. 课程对照：按学科 ─────
{
  const { db } = newDb()
  const en = addPaper(db, { title: '英语卷', questions: [{ kp: 'GR.NOUN.PLURAL.IRR' }] })
  const ma = addPaper(db, { title: '数学卷', questions: [{ kp: 'MA.CALC.FRAC.ADDSUB' }, { kp: 'MA.GEO.AREA.RECT' }] })
  const cn = addPaper(db, { title: '语文卷', questions: [{ kp: 'CN.CHAR.SOUND.POLY' }] })
  db.prepare("UPDATE papers SET subject = 'math' WHERE id = ?").run(ma)
  db.prepare("UPDATE papers SET subject = 'chinese' WHERE id = ?").run(cn)
  const codes = s => targetKps(db, s).map(k => k.code)
  assert.deepEqual(codes('math').sort(), ['MA.CALC.FRAC.ADDSUB', 'MA.GEO.AREA.RECT'])
  assert.deepEqual(codes('chinese'), ['CN.CHAR.SOUND.POLY'])
  assert.deepEqual(codes('english'), ['GR.NOUN.PLURAL.IRR'])
  assert.deepEqual(codes(undefined), ['GR.NOUN.PLURAL.IRR'], '缺省 = 英语')
  void en
  const mk = (name, subject) => createOutline(db, { name, scene: 'org', termNote: '', sourceName: '', sourceHash: name, mapping: null, warnings: [], aiModel: '', status: 'active', subject, levels: [{ name: 'L1', lessons: [{ seq: 1, noLabel: '1', title: '课', theme: '', textbookRef: '', points: [{ kind: 'word', label: '知识点', text: '通分' }], raw: {} }] }] })
  const a = mk('英语体系'), b = mk('数学体系', 'math'), c = mk('语文体系', 'chinese')
  assert.deepEqual(listOutlines(db).map(o => o.id), [a]); assert.deepEqual(listOutlines(db, 'math').map(o => o.id), [b]); assert.deepEqual(listOutlines(db, 'chinese').map(o => o.id), [c])
  assert.equal(db.prepare('SELECT subject FROM course_outlines WHERE id = ?').get(b).subject, 'math')
  // 课次行的内容列字母
  const lesson = { id: 1, levelName: 'L1', seq: 1, noLabel: '1', title: '课', theme: '', textbookRef: '', points: [{ kind: 'word', label: '', text: '通分' }, { kind: 'pattern', label: '', text: '1/2+1/3' }] }
  assert.ok(outlineLine(lesson, 'math').includes('点:通分') && outlineLine(lesson, 'math').includes('例:1/2+1/3'))
  assert.ok(outlineLine(lesson).includes('词:通分') && outlineLine(lesson).includes('句:1/2+1/3'), '英语不变')
  assert.ok(outlineLine({ ...lesson, points: [{ kind: 'pattern', label: '', text: '短文' }] }, 'chinese').includes('读:短文'))
}
assert.equal(fieldLabelsOf('math').word, '知识点'); assert.equal(fieldLabelsOf('chinese').pattern, '阅读'); assert.equal(fieldLabelsOf().word, '词汇')
assert.equal(guessField('知识点', 'math'), 'word'); assert.equal(guessField('例题', 'math'), 'pattern'); assert.equal(guessField('方法', 'math'), 'expression')
assert.equal(guessField('识字与写字', 'chinese'), 'phonics'); assert.equal(guessField('阅读', 'chinese'), 'pattern'); assert.equal(guessField('写作', 'chinese'), 'expression')
assert.equal(guessField('词汇'), 'word'); assert.equal(guessField('知识点'), null, '英语表头规则不变')
assert.ok(templateHeadersOf('math').includes('知识点') && templateHeadersOf('chinese').includes('识字与写字') && templateHeadersOf().includes('字母与语音'))
assert.equal(templateRows('math')[0].length, templateRows()[0].length)
assert.equal(sampleSheets('math')[0].rows[1].length, templateRows('math')[0].length); assert.equal(sampleSheets('chinese')[0].rows.length, 4)
// 引用证明力：语文 / 数学放宽
assert.equal(quoteLongEnough('口算'), false); assert.equal(quoteLongEnough('口算', 'math'), true); assert.equal(quoteLongEnough('1/2+1/3', 'math'), true)
assert.equal(quoteTouchesKp('先通分再相加', { name: '异分母分数加减', hintWords: '通分', exampleEn: '1/2+1/3=5/6' }, 'math'), true)
assert.equal(quoteTouchesKp('认识图形', { name: '异分母分数加减', hintWords: '通分', exampleEn: '1/2+1/3=5/6' }, 'math'), false)
assert.equal(quoteTouchesKp('朗读课文', { name: '多音字', hintWords: '重量、重复', exampleEn: '' }, 'chinese'), false)
assert.equal(quoteTouchesKp('认读重量', { name: '多音字', hintWords: '重量、重复', exampleEn: '' }, 'chinese'), true)

// ───── 7. 标题带学科名（英语不变） ─────
{
  const base = { grades: ['5'], semesters: ['上'], examTypes: ['期末'], years: [2025], reader: 'full', date: '2026-11-10' }
  assert.ok(reportTitle({ ...base, filter: { subject: 'math' } }).includes('数学'))
  assert.ok(!/英语|数学|语文/.test(reportTitle({ ...base, filter: {} })), '英语沿用原标题')
}

// ───── 8. mock AI 认得语文 / 数学的 P1 提示词，回的代码都在种子里 ─────
{
  const { createRequire } = await import('node:module')
  const subj = createRequire(import.meta.url)('../mock-ai/subjects.cjs')
  assert.equal(subj.subjectOf(read('p1_text.math.system.txt')), 'math'); assert.equal(subj.subjectOf(read('p1_vision.chinese.system.txt')), 'chinese'); assert.equal(subj.subjectOf(read('p1_text.system.txt')), null)
  for (const [s, kpSeeds, qtSeeds] of [['math', MA_KP_SEEDS_V1, MA_QTYPE_SEEDS_V1], ['chinese', CN_KP_SEEDS_V1, CN_QTYPE_SEEDS_V1]]) {
    const kps = new Set(kpSeeds.map(k => k[0])), qts = new Set(qtSeeds.map(q => q[0]))
    const out = subj.build(s, { mode: 'text', pages: [1], prefix: 'b1' })
    for (const q of out.questions) { assert.ok(kps.has(q.kp_main) && qts.has(q.qtype), `${s} mock 的代码不在种子里：${q.kp_main} ${q.qtype}`); q.kp_secondary.forEach(c => assert.ok(kps.has(c))) }
    assert.equal(subj.build(s, { mode: 'text', pages: [2], prefix: 'b2' }).questions.length, 0)
  }
}

// ───── 审核返工：语文 / 数学规则句核对的边界（漏判与误标） ─────
{
  const fc = await import('../../src/shared/factcheck.ts')
  const rp = await import('../../src/shared/report-post.ts')
  const ph = await import('../../src/renderer/subject/placeholder.ts')
  const ev = ['分数加减法：分母相同，分子相加减，分母不变', '平行四边形面积等于底乘高', '多音字「重」在「重量」里读 zhòng']
  const flag = (s, t) => fc.checkRulesFor(s, t, ev).length > 0
  assert.ok(flag('math', '异分母分数相加要先通分，再把分子相加'), '证据里没有「通分」：未核实')
  assert.ok(flag('math', '平行四边形的面积等于底加高'), '「加」对不上证据里的「乘」：未核实')
  assert.ok(flag('math', '把 25% 化成小数是 0.25'), '百分数换算是规则句，数字查不到：未核实')
  assert.ok(flag('chinese', '多音字「重」在「重新」里读 zhòng'), '引号里的「重新」证据里没有：未核实')
  assert.ok(!flag('math', '第 3 题考查分数加减法，孩子一般容易错'), '题号不当规则数字')
  assert.ok(!flag('math', '这次期末卷中应用题一般占 40 分，孩子要重点练'), '分值不当规则数字')
  assert.ok(!flag('math', '同分母分数相加，分母不变，分子相加'), '和证据一致的说法放行')
  assert.ok(!flag('math', '平行四边形的面积等于底乘高'))
  assert.ok(!flag('chinese', '孩子在拼音方面一般比较容易错'), '泛泛的描述不当规则句')
  assert.ok(!flag('chinese', '多音字「重」在「重量」里读 zhòng'))
  // 数学家长版：百分数、统计图是知识点本身，不能整句删
  assert.equal(rp.sanitizeParent('1. 把 25% 化成小数时，小数点向左移两位。', 'math').removed, 0)
  assert.equal(rp.sanitizeParent('1. 统计图要先看清每格代表多少。', 'math').removed, 0)
  assert.equal(rp.sanitizeParent('1. 这类题占 30% 左右。', 'math').removed, 1)
  assert.equal(rp.sanitizeParent('1. 统计图要先看清每格代表多少。').removed, 1, '英语家长版照旧')
  // 切学科时不留上一学科的占位数据
  const keep = ph.keepSameSubject('math')
  assert.equal(keep('旧', { queryKey: ['stats', 'overview', { subject: 'english', grade: '3' }] }), undefined, '上一份是英语，切到数学不留')
  assert.equal(keep('旧', { queryKey: ['stats', 'overview', { subject: 'math', grade: '3' }] }), '旧')
  assert.equal(keep('旧', { queryKey: ['reports', 'list', 'english'] }), undefined)
  assert.equal(keep('旧', { queryKey: ['stats', 'compare', { filter: { subject: 'math' }, target: 2025 }] }), '旧')
}

console.log(`subject-content.test ✓（60 个语文 / 数学提示词合格；示例代码都在种子里；规则句核对、问候语、课程按学科、数学符号校正）`)
