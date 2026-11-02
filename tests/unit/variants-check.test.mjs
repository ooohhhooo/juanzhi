// AI 变形题的程序侧校验（M9 §2.5）：结构、抄袭（Jaccard ≥ 0.8）、超纲词只提示、答案位置不全相同、
// 价格 / 夸大说法、第二次独立解答的比对（不一致 → 答案有争议）。
import assert from 'node:assert/strict'
import { COPY_THRESHOLD, jaccard, outOfVocab, parseCheckAnswers, sameAnswer, tokensOf, validateVariants } from '../../src/main/report/variants-check.ts'

const q = (o = {}) => ({ kp: 1, qtype: 'choice', stem: 'Mia has two pens. These are my ____.', options: ['pen', 'pens', 'a pen', "pen's"], answer: 'B', explanation: '看数量。', changed: '换了场景', ...o })
const run = (qs, ctx = {}) => validateVariants(JSON.stringify({ questions: qs }), { kpCodes: ['GR.NOUN.PLURAL', 'GR.VERB.3S'], originals: [], vocab: new Set(), ...ctx })

// 正常的三道题
const ok = run([q(), q({ kp: 2, stem: 'Ben ____ to school by bike.', options: ['go', 'goes', 'going', 'gone'], answer: 'B' }), q({ qtype: 'blank', kp: 2, stem: 'Mum ____ (c) dinner every evening.', options: [], answer: 'cooks' })])
assert.equal(ok.error, null)
assert.deepEqual(ok.variants.map(v => v.problems.length), [0, 0, 0])
assert.deepEqual(ok.variants.map(v => v.seq), [1, 2, 3])
assert.deepEqual(ok.variants.map(v => v.kp_code), ['GR.NOUN.PLURAL', 'GR.VERB.3S', 'GR.VERB.3S'], 'kp 序号映射回考点代码')
// 两道选择题答案都是 B → 程序把后一道的选项循环移位，让答案位置不全相同（内容不变，答案跟着走）
assert.notEqual(ok.variants[0].answer, ok.variants[1].answer)
assert.deepEqual([...ok.variants[1].options].sort(), ['going', 'go', 'gone', 'goes'].sort())
assert.equal(ok.variants[1].options['ABCD'.indexOf(ok.variants[1].answer)], 'goes', '答案字母指向的还是原来的正确选项')
assert.ok(ok.variants[1].hints.some(h => /调整了选项顺序|已调整选项顺序/.test(h)))

// 结构错误：被剔除（problems 非空），但仍然保留在结果里（界面写明剔除原因）
const bad = run([
  q({ options: ['a', 'b', 'c'] }),                    // 3 个选项
  q({ options: ['a', 'A', 'c', 'd'] }),               // 选项重复
  q({ answer: 'E' }),                                  // 答案不是 A–D
  q({ stem: '' }),                                     // 空题干
  q({ qtype: 'blank', stem: 'No blank here.', options: [], answer: 'x' })   // 填空没有空格
])
assert.ok(bad.variants.every(v => v.problems.length > 0), bad.variants.map(v => v.problems.join('/')).join(' | '))
const letter = run([q({ qtype: 'blank', stem: 'Mum ____ (c) dinner.', options: [], answer: 'bakes' })])   // 首字母对不上
assert.ok(/4 个选项/.test(bad.variants[0].problems[0]) && /重复/.test(bad.variants[1].problems[0]) && /A–D/.test(bad.variants[2].problems[0]))
assert.ok(letter.variants[0].problems.some(p => /首字母/.test(p)))
// 答案可以写成 “B. pens”
assert.equal(run([q({ answer: 'B. pens' })]).variants[0].answer, 'B')
// 选项自带 “A. ” 前缀会被去掉
assert.deepEqual(run([q({ options: ['A. pen', 'B. pens', 'C. a pen', 'D. pen\'s'] })]).variants[0].options, ['pen', 'pens', 'a pen', "pen's"])

// 抄原卷：词集相似度 ≥ 0.8 剔除；换了人名物品（相似度低）通过
const orig = 'Mia has two pens. These are my ____. pen pens a pen pen\'s'
const copied = run([q()], { originals: [orig] })
assert.ok(copied.variants[0].problems.some(p => /照抄/.test(p)), '几乎一样的题被判抄袭')
const changed = run([q({ stem: 'Tom has three apples. They are his ____.', options: ['apple', 'apples', 'an apple', "apple's"] })], { originals: [orig] })
assert.deepEqual(changed.variants[0].problems, [])
assert.equal(COPY_THRESHOLD, 0.8)
assert.equal(jaccard(tokensOf('a b c d e'), tokensOf('a b c d f')), 4 / 6)
assert.equal(jaccard(new Set(), new Set()), 1)
assert.ok(tokensOf('你好 abc').has('好') && tokensOf('你好 abc').has('abc'), '中文按单字、英文按词')

// 价格 / 营销 / 夸大
assert.ok(run([q({ explanation: '报名后保证提分。' })]).variants[0].problems.some(p => /价格|夸大/.test(p)))
// 选项和 changed 里的营销说法也要查；购物题里的价格、日常说法不误伤
assert.ok(run([q({ options: ['pen', 'pens', '报名立减 50 元', "pen's"] })]).variants[0].problems.some(p => /价格|夸大/.test(p)))
assert.ok(run([q({ changed: '保证提分' })]).variants[0].problems.some(p => /价格|夸大/.test(p)))
assert.deepEqual(run([q({ stem: 'How much is the pen? It is 3 ____ (y).', options: ['yuan', 'yuans', 'a yuan', 'yuan s'], answer: 'A', explanation: '最好的朋友也要用 yuan。' })]).variants[0].problems, [])
// 重复的题只留第一道
const dup = run([q(), q()])
assert.equal(dup.variants[0].problems.length, 0); assert.ok(dup.variants[1].problems.some(p => /重复/.test(p)))
// 最多 max 道有效题（被剔除的也保留以便说明）
const many = run([q(), q({ stem: 'Ben ____ to school.', options: ['go', 'goes', 'going', 'gone'], answer: 'C' }), q({ stem: 'Amy ____ milk.', options: ['drink', 'drinks', 'drinking', 'drunk'], answer: 'D' }), q({ stem: 'Jim ____ a song.', options: ['sing', 'sings', 'sang', 'sung'], answer: 'B' })], { max: 3 })
assert.equal(many.variants.filter(v => v.problems.length === 0).length, 3)

// 超纲词：只提示，不阻断
const vocab = new Set(['mia', 'has', 'two', 'pen', 'pens', 'these', 'are', 'my'])
assert.deepEqual(outOfVocab(['Mia has two pens', 'extraordinary pens'], vocab, 1), ['extraordinary'])
assert.deepEqual(outOfVocab(['extraordinary pens'], vocab), [], '白名单太小（库里试卷太少）时不检查，免得满屏误报')
assert.deepEqual(outOfVocab(['anything goes'], new Set()), [], '白名单为空时不检查')
const bigVocab = new Set([...vocab, ...Array.from({ length: 100 }, (_, i) => `filler${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`)])
const oov = run([q({ stem: 'Mia has two spectacular pens. These are my ____.' })], { vocab: bigVocab })
assert.deepEqual(oov.variants[0].problems, [], '超纲词不阻断')
assert.ok(oov.variants[0].hints.some(h => /超出范围的词.*spectacular/.test(h)))

// 不是 JSON / 空
assert.ok(validateVariants('这不是 JSON', { kpCodes: [], originals: [], vocab: new Set() }).error)
assert.ok(validateVariants('```json\n{"questions":[]}\n```', { kpCodes: [], originals: [], vocab: new Set() }).error)
// 带代码围栏的 JSON 也能读
assert.equal(validateVariants('```json\n' + JSON.stringify({ questions: [q()] }) + '\n```', { kpCodes: ['K'], originals: [], vocab: new Set() }).variants.length, 1)

// 第二次独立解答的比对
const second = parseCheckAnswers(JSON.stringify({ answers: [{ i: 1, answer: 'B', reason: 'x' }, { i: 2, answer: 'c.', reason: 'y' }, { i: 3, answer: 'Cooks!', reason: 'z' }, { i: 4, answer: '' }] }))
assert.deepEqual([...second.keys()], [1, 2, 3], '空答案不算')
assert.ok(sameAnswer({ qtype: 'choice', answer: 'B' }, second.get(1)))
assert.ok(!sameAnswer({ qtype: 'choice', answer: 'B' }, second.get(2)), '答案不一致 → 该题标「答案有争议」')
assert.ok(sameAnswer({ qtype: 'blank', answer: 'cooks' }, second.get(3)), '填空忽略大小写和标点')
assert.ok(!sameAnswer({ qtype: 'blank', answer: 'cooks' }, undefined), '没有作答 = 不一致')
assert.ok(!sameAnswer({ qtype: 'choice', answer: 'B' }, '无法确定'), '“无法确定” = 不一致')

console.log('variants-check.test ✓')
