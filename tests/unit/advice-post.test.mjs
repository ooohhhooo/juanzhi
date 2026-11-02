// 家长沟通话术的程序侧收尾：价格词 / 营销词 / 夸大词整句删除、数字 + 元、未知令牌、字数告警、不足 80 字判失败、事实核对。
import assert from 'node:assert/strict'
import { finishAdvice, FORBIDDEN_RE, countChars, replaceLessonTokens } from '../../src/main/course/advice-post.ts'

const labels = new Map([[12, '示例体系 A · 基础级 · 第 5 课《Animals》'], [15, '示例体系 A · 基础级 · 第 8 课《Family》']])
// 约 170 个汉字的正常话术（含两个课令牌）
const good = '这类试卷里常见的易错点是动词过去式。孩子在家可以这样练：每天说三句昨天做过的事，比如先说“昨天我去了公园”，再请孩子用英语说出来，家长只要听动词有没有变形就能判断对不对。刚开始说错很正常，让孩子多说几遍，慢慢就顺了。' +
  '另外在比较两样东西的时候，也要留意形容词后面加不加字母。如果想系统地复习，可以看看 [课#12]，里面有对应的词汇和句型；想补一补比较的说法，也可以翻翻 [课#15]。练习的时候不用着急，每次十分钟就够，坚持几天再回头看看效果。'

{
  const r = finishAdvice(good, labels, { range: [150, 220] })
  assert.equal(r.ok, true, r.failReason ?? '')
  assert.ok(r.text.includes('「示例体系 A · 基础级 · 第 5 课《Animals》」'), '令牌换成完整课名')
  assert.ok(!r.text.includes('[课#'))
  assert.deepEqual(r.usedLessonIds, [12, 15])
  assert.equal(r.warnings.length, 0)
}

// ── 禁用词：价格、营销、夸大承诺 ──
{
  for (const s of ['每节课只要99元。', '现在报名有优惠。', '限时折扣，名额有限。', '保证孩子一定能提分。', '学完提高20分。', '这是最好的办法。', '包过。', '全国第一的课程。', '总共 5 折哦。', '正确率达到 90%。', '请联系价格咨询。']) {
    assert.ok(FORBIDDEN_RE.test(s), `应命中：${s}`)
  }
  for (const s of ['先请孩子读一读。', '第一步先读题，第二步再选答案。', '可以看看 [课#12]。', '每次十分钟就够。', '孩子在家可以多说几遍。']) {
    assert.ok(!FORBIDDEN_RE.test(s), `不该命中：${s}`)
  }
  const dirty = good.replace('。如果想系统地复习', '。这个课程现在报名有优惠，保证提分。如果想系统地复习')
  const r = finishAdvice(dirty, labels, { range: [150, 220] })
  assert.ok(!/报名|保证|优惠/.test(r.text))
  assert.ok(r.removedSentences >= 1)
  assert.ok(r.warnings.some(w => w.includes('已删除') && w.includes('价格、营销或夸大承诺')))
  assert.equal(r.ok, true)
  // 课名里带「第一」之类的字不能误伤（禁用词检查在令牌替换之前）
  const first = finishAdvice(good, new Map([[12, '甲体系 · 第一级 · 第一课《最好的开始》'], [15, '乙']]), { range: [150, 220] })
  assert.ok(first.text.includes('第一课《最好的开始》') && first.ok)
}

// ── 令牌 ──
{
  const r = replaceLessonTokens('看看 [课#12] 和 [课#99]，还有［课 # 15］。', labels)
  assert.equal(r.unknown, 1)
  assert.deepEqual(r.used, [12, 15])
  assert.ok(r.text.includes('「示例体系 A · 基础级 · 第 8 课《Family》」'), '全角括号、有空格的令牌也认')
  assert.ok(!r.text.includes('99'))
  const f = finishAdvice(good.replace('[课#15]', '[课#77]'), labels, { range: [150, 220] })
  assert.equal(f.unknownTokens, 1)
  assert.ok(f.warnings.some(w => w.includes('无法核对的课程引用')))
}

// ── 字数 ──
{
  assert.equal(countChars('你好，world！ **x**'), 8)
  const short = finishAdvice('孩子可以多练一练动词过去式，每天说三句昨天做过的事，再请家长听一听有没有说错，错了就多说几遍，十分钟就够，坚持几天看看。孩子刚开始说不顺很正常，家长不用急着纠正，先听完再轻轻提醒一下就好，过几天再回头检查一遍有没有进步。', labels, { range: [150, 200] })
  assert.equal(short.ok, true, '不足 150 字只告警，不自动裁剪')
  assert.ok(short.warnings.some(w => /字，建议 150–200 字/.test(w)))
  const tiny = finishAdvice('保证提分。现在报名有优惠。限时折扣。多练就好。', labels)
  assert.equal(tiny.ok, false)
  assert.match(tiny.failReason, /只剩 \d+ 字/)
  // 一句话建议（不检查字数范围，也不要求 80 字）
  const hint = finishAdvice('这类题常见易错，可以复习 [课#12]。', labels, { range: null, minChars: 8 })
  assert.equal(hint.ok, true)
  assert.equal(hint.warnings.length, 0)
}

// ── Markdown 杂质 ──
{
  const r = finishAdvice('## 标题\n```\ncode\n```\n**这类试卷**里常见的易错点是动词过去式。' + good, labels, { range: null })
  assert.ok(!r.text.includes('##') && !r.text.includes('```') && !r.text.includes('**'))
}

// ── 事实核对：规则句对不上证据时标「未核实」 ──
{
  const text = good + '记住：time for 后面接名词，time to 后面接动词原形。'
  const r = finishAdvice(text, labels, { range: null, statements: ['time to + 动词原形：表示“该做某事的时候了”'] })
  assert.ok(Array.isArray(r.findings))
  const none = finishAdvice(text, labels, { range: null })
  assert.deepEqual(none.findings, [], '没给证据就不做核对')
}

console.log('advice-post.test ✓')
