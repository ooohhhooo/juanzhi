// 报告卡片 → 新分享卡片的内容映射：口诀卡 → 口诀版式，答题卡 → 小练习版式，家长版 → 绘本来信（整句取舍，不截半句）。
import assert from 'node:assert/strict'
import { answercardToCard, parentTextToBrief, splitMnemonic, trickToCard } from '../../src/main/report/share-card-content.ts'
import { parseCardContent } from '../../src/main/cards/schema.ts'

// 口诀卡
const MD = ['::: trick 口诀大招', '**一句话**：名词复数别马虎，sheep 不加 s。', '**例**：Look at the **sheep**. 看那些羊。 [卷A · 3]', '**出自考点**：名词复数', ':::', '',
  '::: answercard 答题卡', '1. Mia has two pens. These are my ____. {choice: pen | pens | a pen | pen\'s}', '2. Mum ____ (c) dinner. {blank: 1}', '3. Write about your day. {lines: 3}', ':::'].join('\n')
const t = trickToCard(MD, 0)
assert.equal(t.kind, 'mnemonic')
assert.deepEqual(t.content.lines.map(l => l.text), ['名词复数别马虎', 'sheep 不加 s'])
assert.equal(t.content.examples[0].text, 'Look at the sheep. 看那些羊。', '粗体记号和引用被去掉')
assert.equal(t.content.examples.length, 2)
assert.ok(parseCardContent('mnemonic', t.content).ok, '能通过卡片 schema')
assert.equal(trickToCard(MD, 1), null)

// 一句没有标点的口诀也能切成 ≥ 2 行；很长的口诀不超过 6 行
assert.equal(splitMnemonic('abcdef').length, 2)
assert.ok(splitMnemonic('一，二，三，四，五，六，七，八，九').length <= 6)
assert.ok(splitMnemonic('甲'.repeat(60)).every(l => l.length <= 24))

// 答题卡
const a = answercardToCard(MD, 0)
assert.equal(a.kind, 'practice')
assert.deepEqual(a.content.questions[0].options, ['A. pen', 'B. pens', 'C. a pen', "D. pen's"])
assert.ok(/填空/.test(a.content.questions[1].q) && !a.content.questions[1].options)
assert.ok(parseCardContent('practice', a.content).ok)
const many = '::: answercard 答题卡\n' + [1, 2, 3, 4, 5].map(n => `${n}. Q${n} ____ {blank: 1}`).join('\n') + '\n:::'
assert.equal(answercardToCard(many, 0).content.questions.length, 4)
assert.ok(/最多放 4 道/.test(answercardToCard(many, 0).notes[0]))
assert.throws(() => answercardToCard('::: answercard 答题卡\n1. Q ____ {blank: 1}\n:::', 0), /至少要有 2 道题/)

// 家长版
const S1 = '本周孩子在名词复数上进步明显。'
const long = '这是一句特别特别长的话，'.repeat(8) + '结束了。'
const PARENT = ['家长您好：', '', `1. 学得好：${S1}课堂上能主动举手。`, '', `2. 要加强：${long}`, '', '3. 在家这样做：每天读一遍口诀。再用口诀造一个句子。', '', '加油！'].join('\n')
const p = parentTextToBrief(PARENT)
assert.equal(p.kind, 'brief')
assert.deepEqual(p.content.sections.map(s => s.heading), ['学得好', '在家这样做'], '过长的第 2 条整条不放；第 3 条有标签就用标签')
assert.ok(p.content.sections.every(s => /[。！？]$/.test(s.body) && [...s.body].length <= 80), '每段都以完整句结尾')
assert.ok(p.notes.length === 1 && /前 \d+ 句完整的话/.test(p.notes[0]))
assert.ok(parseCardContent('brief', p.content).ok)
// 每条都放得下时没有提示
const short = parentTextToBrief('您好：\n\n1. 进步：写得更整齐了。\n\n2. 建议：每天读五分钟。\n')
assert.deepEqual(short.notes, [])
assert.equal(short.content.sections.length, 2)
// 一条里句子放不下的部分整句去掉
const cut = parentTextToBrief(`您好：\n\n1. 要点：${'甲'.repeat(40)}。${'乙'.repeat(30)}。${'丙'.repeat(30)}。\n\n2. 建议：好。\n`)
assert.equal(cut.content.sections[0].body, '甲'.repeat(40) + '。' + '乙'.repeat(30) + '。')
// 超过 4 条只取前 4 条
const five = parentTextToBrief('您好\n\n' + [1, 2, 3, 4, 5].map(n => `${n}. 第${n}条内容。`).join('\n\n'))
assert.equal(five.content.sections.length, 4)
assert.ok(five.notes.length === 1)
// 全是超长句：报错而不是出空卡
assert.throws(() => parentTextToBrief(`您好\n\n1. ${'甲'.repeat(120)}。\n\n2. ${'乙'.repeat(120)}。`), /太长/)
console.log('report-share-card ok')
