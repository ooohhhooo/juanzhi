// Markdown 容器块（M9 §2.4）：口诀卡 / 答题卡的解析、不认识的 kind 退化、没写结束行、卡片里再出现开头行、
// 答题题目的作答方式（choice / blank / lines）、口诀卡三块字段，以及复制到微信的纯文本。
import assert from 'node:assert/strict'
import { parseBlocks, trickFields } from '../../src/shared/markdown.ts'
import { markdownToWechat } from '../../src/shared/report-post.ts'

const TRICK = ['## 做题方法', '', '::: trick 口诀大招', '**一句话**：名词复数别马虎，sheep 不加 s。', '**例**：Look at the sheep. 看那些羊。', '**出自考点**：名词复数', ':::', '', '后面的段落'].join('\n')
const b1 = parseBlocks(TRICK)
assert.deepEqual(b1.map(b => b.type), ['heading', 'card', 'p'], '卡片是一个独立的块，前后的标题和段落不受影响')
const trick = b1[1]
assert.equal(trick.kind, 'trick'); assert.equal(trick.title, '口诀大招'); assert.equal(trick.extra, '')
assert.deepEqual(trickFields(trick.raw), { main: '名词复数别马虎，sheep 不加 s。', example: 'Look at the sheep. 看那些羊。', from: '名词复数', rest: [] })
assert.equal(trick.lines.length, 3)

// 答题卡：标题 | 副标题；三种作答方式；没有题号的行并入上一题
const CARD = ['::: answercard 答题卡 | 同类变形题', '1. Mia has two pens. These are my ____. {choice: pen | pens | a pen | pen\'s}', '2. Mum ____ (c) dinner. {blank: 1}', '继续的半句', '3. Write about your day. {lines: 3}', '4. 没有作答方式的题', ':::'].join('\n')
const card = parseBlocks(CARD)[0]
assert.equal(card.kind, 'answercard'); assert.equal(card.title, '答题卡'); assert.equal(card.extra, '同类变形题')
assert.deepEqual(card.items.map(i => i.n), [1, 2, 3, 4])
assert.deepEqual(card.items[0].answer, { type: 'choice', options: ['pen', 'pens', 'a pen', "pen's"] })
assert.deepEqual(card.items[1].answer, { type: 'blank', count: 1 })
assert.ok(card.items[1].stem.map(x => x.text).join('').includes('继续的半句'), '没有题号的行并入上一题的题干')
assert.deepEqual(card.items[2].answer, { type: 'lines', count: 3 })
assert.equal(card.items[3].answer, null)
// 空格数量夹在 1–8 之间
assert.deepEqual(parseBlocks('::: answercard x\n1. q {blank: 99}\n:::')[0].items[0].answer, { type: 'blank', count: 8 })

// 不认识的 kind：退化成普通引用块（旧版本 / 将来的新卡片读到不会崩）
const unk = parseBlocks('::: banner 新卡片\n内容一行\n:::')
assert.equal(unk.length, 1); assert.equal(unk[0].type, 'quote')
assert.deepEqual(unk[0].lines.map(l => l.map(x => x.text).join('')), ['新卡片', '内容一行'])

// 没写结束行：到下一个标题为止（不吞掉后面的小节）
const open = parseBlocks('::: trick 口诀\n**一句话**：甲\n\n## 下一节\n正文')
assert.deepEqual(open.map(b => b.type), ['card', 'heading', 'p'])
// 没写结束行、到文末
assert.deepEqual(parseBlocks('::: trick 口诀\n**一句话**：甲').map(b => b.type), ['card'])
// 卡片里再出现开头行：上一张当作已结束，不嵌套
const nested = parseBlocks('::: trick 一\n**一句话**：甲\n::: trick 二\n**一句话**：乙\n:::')
assert.deepEqual(nested.map(b => b.type), ['card', 'card'])
assert.equal(trickFields(nested[1].raw).main, '乙')
// 孤立的结束行被忽略；卡片里的内容不会被当成标题 / 列表去解析
assert.deepEqual(parseBlocks(':::\n正文').map(b => b.type), ['p'])
assert.deepEqual(parseBlocks('::: trick 口诀\n- 不是列表\n:::').map(b => b.type), ['card'])
// 空卡片不崩
assert.equal(parseBlocks('::: trick\n:::')[0].title, '')
// 普通文字里的三个冒号不是卡片
assert.equal(parseBlocks('时间：12:30').length, 1)

// 复制到微信：纯文本，不含 Markdown 符号；答题卡不含答案
const wx = markdownToWechat([TRICK, '', CARD].join('\n'))
assert.ok(wx.includes('【口诀大招】名词复数别马虎'), wx)
assert.ok(wx.includes('例：Look at the sheep. 看那些羊。'))
assert.ok(wx.includes('【答题卡】姓名：______  日期：______'))
assert.ok(wx.includes('1. Mia has two pens. These are my ____.  ○A. pen  ○B. pens  ○C. a pen'), wx)
assert.ok(!wx.includes('{choice') && !wx.includes(':::') && !wx.includes('**'), '没有残留的 Markdown 记号')

console.log('markdown-card.test ✓')
