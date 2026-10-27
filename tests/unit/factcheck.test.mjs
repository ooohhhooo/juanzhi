// A3 事实核对：AI 文本里的「规则句」要能对上证据（已审核题目的易错说明 + 知识点白话释义），对不上标「未核实」，说反了标「矛盾」。
// 回归用例：真实 AI 把 time for / time to 写反了（It's time for 后接动词），而同一份报告的另一处是对的。
import assert from 'node:assert/strict'
import { checkRules, isRuleSentence, markFindings, removeSentence, splitSentences, relationsOf, stripMarks, MARK_CONFLICT, MARK_UNVERIFIED } from '../../src/shared/factcheck.ts'

const EVIDENCE = [
  'time for + 名词，time to + 动词；It\'s time for breakfast.',
  'tomato 的复数加 -es；sheep 单复数同形，易误加 -s',
  '表示“谁的”：This is my book.'
]

// ── 关系抽取 ──
assert.deepEqual(relationsOf('time for + 名词，time to + 动词'), [{ e: 'time for', c: 'noun' }, { e: 'time to', c: 'verb' }])
assert.deepEqual(relationsOf("It's time for 后接动词，It's time to 后接名词"), [{ e: 'time for', c: 'verb' }, { e: 'time to', c: 'noun' }])
assert.deepEqual(relationsOf('time to 后面跟动词原形'), [{ e: 'time to', c: 'verb' }])

// ── 回归：time for / time to 写反 → 矛盾；写对 → 通过 ──
const wrong = checkRules("It's time for 后接动词，It's time to 后接名词。", EVIDENCE)
assert.equal(wrong.length, 1, '逗号连着的是一整句，整句标一次')
assert.equal(wrong[0].kind, 'conflict')
{
  const w = checkRules("- 介词搭配：It's time for 后接动词，It's time to 后接名词。", EVIDENCE)
  assert.equal(w.length, 1); assert.equal(w[0].kind, 'conflict'); assert.match(w[0].reason, /time for/)
  const ok = checkRules('- 介词搭配：time for + 名词，time to + 动词。', EVIDENCE)
  assert.deepEqual(ok, [], '写对的不报')
  const ok2 = checkRules('time to 后面接动词原形，time for 后面接名词。', EVIDENCE)
  assert.deepEqual(ok2, [])
}
// 同一次生成里两处互相矛盾：对的那处通过，错的那处被标
{
  const both = checkRules('## 易错点\n- time for + 名词，time to + 动词\n## 同比\n- 注意：It\'s time for 后接动词', EVIDENCE)
  assert.equal(both.length, 1); assert.equal(both[0].kind, 'conflict'); assert.match(both[0].sentence, /后接动词$/)
}

// ── 证据里没有的规则 → 未核实 ──
{
  const f = checkRules('- be good at 后接名词或动名词，不能接动词原形。', EVIDENCE)
  assert.equal(f.length, 1); assert.equal(f[0].kind, 'unverified'); assert.match(f[0].reason, /good|找不到/)
}
// 证据里有的 → 通过（复述换了说法）
assert.deepEqual(checkRules('tomato 的复数要加 es，不是加 s。', EVIDENCE), [])
assert.deepEqual(checkRules('sheep 的单数和复数一样，不能加 s。', EVIDENCE), [])
// 不是规则句：只有数据 / 没有英文 / 没有规则口气
assert.equal(isRuleSentence('名词复数在 3/3 份卷子里都出现，分值占比 12%'), false)
assert.equal(isRuleSentence('这一类题要多练'), false)
assert.equal(isRuleSentence('tomato 是常见词'), false)
assert.equal(isRuleSentence('tomato 的复数加 -es'), true)
// 样本题引用和 ** 不影响判断
assert.deepEqual(checkRules('**易错**：time to + 动词 [2025卷 · 7]（单项选择：It\'s time ____ breakfast）。', EVIDENCE), [])

// ── 切句 ──
assert.deepEqual(splitSentences('## 标题\n第一句话。第二句话；第三句话\n|a|b|\n|---|---|\n|time to|后接动词|'), ['第一句话', '第二句话', '第三句话', 'time to', '后接动词'])

// ── 写回标记 ──
{
  const md = '- 介词搭配：It\'s time for 后接动词，It\'s time to 后接名词。\n- 别的话。'
  const f = checkRules(md, EVIDENCE)
  const m = markFindings(md, f)
  assert.equal(m.marked, 1)
  assert.ok(m.text.includes(`后接名词${MARK_CONFLICT}`) || m.text.includes(MARK_CONFLICT))
  assert.equal(stripMarks(m.text), md.replace(/。/, '。'), '去掉标记后与原文一致')
  assert.equal(markFindings(md, []).text, md)
  const md2 = '- **time for 后接动词**：这是规则。'
  const f2 = [{ sentence: 'time for 后接动词', kind: 'unverified', reason: 'x' }]
  assert.ok(markFindings(md2, f2).text.includes(MARK_UNVERIFIED), '句子在粗体里也能标上')
}

// ── 审核报告里的绕过用例：换个说法也必须被标出来（P1-2）──
{
  const mustConflict = [
    'time for 后接动词',
    'time for 后面要接动词，孩子容易错',
    'time for 加动词',
    'time for 要接动词',
    'time for 之后要用动词原形',
    'time for 的后面应该跟 doing',
    "It's time for 后面必须跟动词原形",
    '- 练习：time for 后面可以接动词原形',
    'time to 后接名词，如 time to lunch',
    'time to 加名词',
    'time to 之后要用名词',
    '动词前面用 time for，名词前面用 time to',
    'time for 后面不能接名词',
    'time for 后面跟动作',
    'time for 和 time to 的固定说法：for 后面跟动作，to 后面跟东西',
    'tomato 的复数加 -s',
    'tomato 的复数加 s',
    'tomato 变复数要加 s，不是加 es',
    'sheep 的复数要加 s'
  ]
  for (const t of mustConflict) {
    const f = checkRules(t, EVIDENCE)
    assert.equal(f.length, 1, `应被标出：${t}`)
    assert.equal(f[0].kind, 'conflict', `应标矛盾：${t} → ${JSON.stringify(f)}`)
  }
  // 写对的（各种说法）不能被误标
  const mustPass = [
    'time for 后面要接名词，孩子容易错',
    'time for 加名词',
    'time to 之后要用动词原形',
    'time for 后面不能接动词',
    'time to 不能接名词',
    'time for 的后面应该跟名词',
    '名词前面用 time for，动词前面用 time to',
    'time for 和 time to 的固定说法：for 后面跟东西，to 后面跟动作',
    'tomato 的复数加 -es',
    'tomato 变复数要加 es，不是加 s',
    'sheep 单复数同形，不能加 s'
  ]
  for (const t of mustPass) assert.deepEqual(checkRules(t, EVIDENCE), [], `不应被标：${t}`)
}
// 证据里没有出现过的英文词语：只要规则句里夹着一个证据里没有的词，就标「未核实」（不再靠 60% 覆盖率放行）
{
  const f = checkRules('potato 和 tomato 的复数都加 -es', EVIDENCE)
  assert.equal(f.length, 1); assert.equal(f[0].kind, 'unverified'); assert.match(f[0].reason, /potato/)
  assert.equal(checkRules('time for 之后的单词读作 tomato', EVIDENCE).length, 1, '证据里没有的规则（读作）')
}

// ── 标记 / 删除：句子中间夹着引用、粗体也要能定位（P1-3）──
{
  const REF = '[2025卷 · 7]'
  const line = `1. 练习 It's time for 后接${REF}动词原形，孩子容易错。第二句。`
  const f = checkRules(line, EVIDENCE)
  assert.equal(f.length, 1); assert.equal(f[0].kind, 'conflict')
  const m = markFindings(line, f)
  assert.equal(m.marked, 1); assert.equal(m.missed.length, 0)
  assert.ok(m.text.includes(MARK_CONFLICT), m.text)
  assert.ok(m.text.includes(REF), '引用还在')
  const r = removeSentence(line, f[0].sentence)
  assert.ok(!r.includes('time for') && !r.includes(REF) && r.includes('第二句'), r)
  assert.deepEqual(checkRules(r, EVIDENCE), [], '删完再核对，不再有矛盾')
  // 粗体 + 引用 + 句末标点
  const l2 = `- **time for** 后接${REF}（单项选择：It's time ____ ...）动词**，**要注意。\n- 保留这一行。`
  const f2 = checkRules(l2, EVIDENCE)
  assert.equal(f2.length, 1)
  const r2 = removeSentence(l2, f2[0].sentence)
  assert.ok(r2.includes('保留这一行') && !r2.includes('time for'), r2)
  assert.equal((r2.match(/\*\*/g) ?? []).length % 2, 0, '粗体记号不成单')
  assert.equal(markFindings(l2, f2).missed.length, 0)
}

// ── 真实 AI 输出里的写法（P2 / 老师版 / 家长版各一份）：描述错误的句子、栏目标签「错在哪」不能被当成矛盾 ──
{
  const EV2 = [...EVIDENCE, 'How much + is / are：单数用 is，复数用 are；be 动词随主语变化', "It's 后面用形容词表示天气：It's rainy."]
  const fine = [
    '典型错误：tomato 变复数不加 -es，或给 sheep 加 -s',
    '错在哪：tomato 的复数要加 -es',
    '错在哪：time for 后面接名词，time to 后面接动词原形',
    '典型错误：for 和 to 记混，或 time to 后动词加了其他形式',
    '错在哪：shoes 是复数，be 动词用 are',
    "错在哪：It's 后面要用形容词 rainy",
    '典型错误：没有先判断主语是单数还是复数，就选 be 动词',
    '提醒：time for 之后的东西是名词，time to 之后的是动作',
    '练 time for 和 time to 的固定说法：for 后面跟东西，to 后面跟动作',
    '孩子容易忘 tomato 变成两个时要加 -es，sheep 则不用变'
  ]
  for (const t of fine) assert.deepEqual(checkRules(t, EV2).filter(f => f.kind === 'conflict'), [], `不该报矛盾：${t}`)
  // 「be 动词」这种英文名词紧跟词类名的，不是「be 后接动词」的关系
  assert.deepEqual(relationsOf('be 动词随主语变化'), [])
  // 写反的错误描述仍要被抓：典型错误里把对的说成错的，不在这里判断；但直接断言写反必须报
  assert.equal(checkRules('典型错误：很多孩子不会写。time for 后接动词', EV2).filter(f => f.kind === 'conflict').length, 1)
}

// ── 验收（R3）：真实输出里出现过的坏句子直接做夹具 ──
{
  const EV3 = [...EVIDENCE, 'shoes 是复数，be 动词用 are；this skirt 是单数，用 is', 'I see two dogs. 我看到两只狗。', 'two 后面的名词要变复数']
  const noConflict = f => f.filter(x => x.kind === 'conflict')
  // 误报 1：「容易给 sheep 加 -s」说的是学生会怎么写错，不是断言
  assert.deepEqual(noConflict(checkRules('- **错在哪**：tomato 的复数加 -es；sheep 单复数同形，孩子容易给 sheep 加 -s。', EV3)), [])
  // 误报 2：「一般加 -s」说的是别的词，「sheep 不加 -s」是对的；引号里的句号不能把句子切断
  const long = '- **讲解要点**：先看句子里的数量词，two 后面要变复数；拿“I see two dogs. 我看到两只狗。”讲一般加 -s，再单独记 tomato 加 -es、sheep 不加 -s。'
  assert.deepEqual(noConflict(checkRules(long, EV3)), [])
  const sents = splitSentences(long)
  assert.ok(sents.every(x => !/^[”」）)]/.test(x)), `不能有以收尾引号开头的断句：${JSON.stringify(sents)}`)
  assert.ok(sents.some(x => x.includes('拿“I see two dogs. 我看到两只狗。”讲一般加 -s，再单独记 tomato 加 -es、sheep 不加 -s')), '引号里的句号不切')
  // 真矛盾仍然报：把 tomato 的 -es 说成 -s、把 sheep 说成加 s
  assert.equal(noConflict(checkRules('再单独记 tomato 加 -s、sheep 加 -s', EV3)).length, 1)
  assert.equal(noConflict(checkRules('tomato、potato 变复数都加 -s', EV3)).length, 1, '并列的词共用后面的说法')
  // 断句：引用夹在句子里，去掉引用后不剩孤零零的顿号 / 多余空格
  const REFS = '[2025-2026学年第二学期四年级英语期末试卷 · 11]、[2024-2025学年第二学期四年级英语期末试卷 · 11]'
  const withRef = checkRules(`把“购物”和“特殊疑问句”合并复习 How much 句型：结合 ${REFS} 做对比练习。`, EV3)
  for (const f of withRef) assert.ok(!/、\s*、|结合\s+、|\s{2,}/.test(f.sentence), `核对条里的句子不能是断的：「${f.sentence}」`)
  assert.ok(splitSentences(`结合 ${REFS} 做对比练习`).every(x => !/、\s*做|\s、/.test(x)))
  // 口径一致：「用 are / 用 is」这种说法在每个版本里都算规则句（以前没有「规则的口气」词，老板版里同一说法没被核对）
  assert.equal(isRuleSentence('都容易在 shoes 用 are、this skirt 用 is 上丢分'), true)
  assert.equal(checkRules('都容易在 shoes 用 are、this skirt 用 is 上丢分', ['别的证据 time for + 名词']).length, 1, '证据里没有这条 → 标未核实（和老师版同一个结论）')
  assert.deepEqual(checkRules('都容易在 shoes 用 are、this skirt 用 is 上丢分', EV3), [])
}

console.log('factcheck.test ✓')
