// 文字归类的单测：AI 用假实现，数据全部虚构。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyTexts, proposeCategories, scrubPII, parseJsonObject, normalizeCategories, sampleEvenly, ClassifyError } from '../../src/main/analysis/stats/classify.ts'
import { textClassifyTool } from '../../src/main/analysis/stats/classify-tool.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = f => fs.readFileSync(path.join(root, 'src/main/ai/prompts', f), 'utf8').replace(/\s+$/, '')
const prompts = { proposeSystem: read('p6_classify_propose.system.txt'), proposeUser: read('p6_classify_propose.user.txt'), assignSystem: read('p6_classify_assign.system.txt'), assignUser: read('p6_classify_assign.user.txt') }

// ───── scrubPII ─────
assert.equal(scrubPII('电话13812345678请联系'), '电话【手机号】请联系')
assert.equal(scrubPII('手机 138-1234-5678 或 +86 139 8765 4321'), '手机 【手机号】 或 【手机号】')
assert.equal(scrubPII('身份证110101199003071234办理'), '身份证【身份证号】办理')
assert.equal(scrubPII('尾号X：11010119900307123X'), '尾号X：【身份证号】')
assert.equal(scrubPII('写信到 teacher.li+a@example.com 谢谢'), '写信到 【邮箱】 谢谢')
assert.equal(scrubPII('座机 010-12345678'), '座机 【电话】')
assert.equal(scrubPII('卡号6222021234567890123'), '卡号【长数字】')
assert.equal(scrubPII('加微信：abc_12345 吧'), '加【联系方式】 吧')
assert.equal(scrubPII('QQ 12345678'), '【联系方式】')
assert.equal(scrubPII('孩子上 3 年级，每周 2 次课，费用 1200 元'), '孩子上 3 年级，每周 2 次课，费用 1200 元')   // 普通数字不动
assert.equal(scrubPII(null), '')

// ───── 小工具 ─────
assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 })
assert.equal(parseJsonObject('没有 json'), null)
assert.deepEqual(normalizeCategories([{ name: '价格', definition: '嫌贵' }, { name: '价格' }, { name: '其他' }, { name: '' }, { name: '时间', definition: '没空', examples: ['电话13812345678'] }]).map(c => c.name), ['价格', '时间'])
assert.ok(!JSON.stringify(normalizeCategories([{ name: 'a', examples: ['电话13812345678'] }])).includes('13812345678'))
assert.equal(sampleEvenly([1, 2, 3, 4], 2).length, 2)
assert.equal(sampleEvenly(Array.from({ length: 1000 }, (_, i) => i), 200).length, 200)

// ───── 假 AI ─────
const KEYWORDS = { 价格: ['贵', '价格'], 时间: ['没空', '时间'], 效果: ['没效果', '效果'] }
function fakeAi(log = [], opts = {}) {
  let active = 0, maxActive = 0
  const fn = async o => {
    log.push(o)
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(r => setTimeout(r, 5))
    active--
    if (o.system === prompts.proposeSystem) {
      if (opts.badPropose) return { content: '我不知道' }
      return { content: JSON.stringify({ categories: Object.keys(KEYWORDS).map(name => ({ name, definition: name + '相关', examples: [] })) }) }
    }
    const lines = o.user.split('【要归类的文字】\n')[1].split('\n').filter(l => /^\d+\. /.test(l))
    const items = lines.map(l => {
      const [, id, text] = /^(\d+)\. (.*)$/.exec(l)
      const cs = Object.entries(KEYWORDS).filter(([, ks]) => ks.some(k => text.includes(k))).map(([n]) => n)
      return { id: Number(id), categories: cs.length ? cs : ['其他'] }
    })
    if (opts.dropFirstOnce && !fn.dropped) { fn.dropped = true; items.shift() }
    if (opts.alien) items[0].categories = ['瞎编的类']
    return { content: JSON.stringify({ items }) }
  }
  fn.maxActive = () => maxActive
  return fn
}

// ───── 提出类别 ─────
{
  const log = []
  const cats = await proposeCategories(['太贵了', '没空来', ...Array.from({ length: 300 }, (_, i) => `想法${i}号 13812345678`)], { ai: fakeAi(log), prompts, fieldName: '退费原因' })
  assert.deepEqual(cats.map(c => c.name), ['价格', '时间', '效果'])
  assert.equal(log.length, 1); assert.equal(log[0].kind, 'analysis-classify')
  assert.ok(log[0].user.includes('退费原因')); assert.ok(log[0].user.includes('共有 302 条'))
  assert.ok(log[0].user.includes('抽取了其中 200 条'), '抽样最多 200 条')
  assert.ok(!log[0].user.includes('13812345678'), '手机号不能发给 AI'); assert.ok(log[0].user.includes('【手机号】'))
  await assert.rejects(() => proposeCategories(['x'], { ai: fakeAi([], { badPropose: true }), prompts }), ClassifyError)
  await assert.rejects(() => proposeCategories(['', '  '], { ai: fakeAi(), prompts }), /空/)
}

// ───── 全流程：分批、并发上限、计数 ─────
{
  const log = []
  const ai = fakeAi(log)
  const base = ['太贵了', '没空来上课', '一点效果没有', '价格贵而且没空', '搬家了']
  const texts = Array.from({ length: 250 }, (_, i) => base[i % 5] + (i === 7 ? ' 手机13912345678' : '')).concat(['', '  '])
  const prog = []
  const r = await classifyTexts(texts, { ai, prompts, fieldName: '退费原因', batchSize: 50, onProgress: (d, t) => prog.push([d, t]) })
  // 提类别 1 次 + 250/50 = 5 批
  assert.equal(log.length, 6); assert.ok(ai.maxActive() <= 3, '并发最多 3 批')
  assert.equal(r.answered, 250); assert.equal(r.blank, 2); assert.equal(r.labels.length, 252)
  assert.deepEqual(r.labels[250], []); assert.deepEqual(r.labels[3], ['价格', '时间'])
  const c = Object.fromEntries(r.counts.map(x => [x.name, x.count]))
  assert.deepEqual(c, { 价格: 100, 时间: 100, 效果: 50, 其他: 50 })
  assert.equal(r.counts.at(-1).name, '其他'); assert.equal(r.counts[0].rate, 40)
  assert.ok(r.categories.some(x => x.name === '其他'))
  assert.ok(log.every(o => !o.user.includes('13912345678')))
  assert.deepEqual(prog.at(-1), [250, 250]); assert.match(r.text, /250 条文字归为 4 类/)
  assert.ok(r.notes.some(n => n.includes('超过 100%'))); assert.ok(r.notes.some(n => n.includes('空白')))
  // 批大小被限制在 100 以内
  const log2 = []
  await classifyTexts(Array.from({ length: 230 }, () => '太贵'), { ai: fakeAi(log2), prompts, batchSize: 5000 })
  assert.equal(log2.length, 1 + 3)
}

// ───── 指定类别 / 漏答重试 / 乱编类别 / 失败兜底 ─────
{
  const log = []
  const mine = [{ name: '价格', definition: '嫌贵' }, { name: '时间', definition: '没空' }]
  const r = await classifyTexts(['太贵', '没空', '都不是'], { ai: fakeAi(log), prompts, categories: mine })
  assert.equal(log.length, 1, '指定类别就不再提类别')
  assert.deepEqual(r.labels, [['价格'], ['时间'], ['其他']])
  assert.ok(log[0].user.includes('价格：嫌贵'))
  // 漏答一条：第二轮补上
  const log2 = []
  const r2 = await classifyTexts(['太贵', '没空', '没效果'], { ai: fakeAi(log2, { dropFirstOnce: true }), prompts })
  assert.equal(log2.length, 3); assert.deepEqual(r2.labels, [['价格'], ['时间'], ['效果']]); assert.equal(r2.fallbackToOther, 0)
  // 乱编类别 → 其他
  const r3 = await classifyTexts(['太贵', '没空'], { ai: fakeAi([], { alien: true }), prompts, categories: mine })
  assert.deepEqual(r3.labels[0], ['其他'])
  // AI 总是失败 → 其他，并说明
  let calls = 0
  const r4 = await classifyTexts(['a', 'b'], { ai: async () => { calls++; throw new Error('网络断了') }, prompts, categories: mine })
  assert.deepEqual(r4.labels, [['其他'], ['其他']]); assert.equal(r4.fallbackToOther, 2); assert.equal(calls, 2); assert.ok(r4.notes.some(n => n.includes('2 条')))
  // 取消
  const ctl = new AbortController(); ctl.abort()
  await assert.rejects(() => classifyTexts(['a'], { ai: fakeAi(), prompts, categories: mine, signal: ctl.signal }), /取消/)
  await assert.rejects(() => classifyTexts(['', ' '], { ai: fakeAi(), prompts }), ClassifyError)
}

// ───── text_classify 工具 ─────
{
  const table = [{ rowid: 1, why: '太贵' }, { rowid: 2, why: '' }, { rowid: 5, why: '没空' }, { rowid: 9, why: '太贵,没空' }]
  const written = []
  const queries = []
  const ctx = {
    runQuery: async (sql, ds) => { queries.push([sql, ds]); return table.map(r => ({ __rowid: r.rowid, __text: r.why })) },
    addDerivedColumn: async o => { written.push(o); return { columnName: o.columnName } },
    classifyAi: fakeAi(), classifyPrompts: prompts
  }
  assert.equal(textClassifyTool.name, 'text_classify'); assert.equal(textClassifyTool.level, 'read')
  const args = textClassifyTool.params.parse({ datasetId: 'd1', table: '退费', column: 'why' })
  const out = await textClassifyTool.run(args, ctx)
  assert.equal(out.ok, true); assert.equal(out.newColumn, 'why_归类')
  assert.deepEqual(queries[0][1], ['d1']); assert.ok(queries[0][0].includes('"退费"') && queries[0][0].includes('"why"'))
  assert.deepEqual(written[0].rows, [{ rowid: 1, value: '价格' }, { rowid: 2, value: null }, { rowid: 5, value: '时间' }, { rowid: 9, value: '价格；时间' }])
  assert.deepEqual(Object.fromEntries(out.counts.map(c => [c.name, c.count])), { 价格: 2, 时间: 2 })
  // 空表 / 缺列
  assert.equal((await textClassifyTool.run(args, { ...ctx, runQuery: async () => [] })).ok, false)
  assert.equal((await textClassifyTool.run(args, { ...ctx, runQuery: async () => [{ x: 1 }] })).ok, false)
  // 传入自己的类别
  const o2 = await textClassifyTool.run(textClassifyTool.params.parse({ datasetId: 'd1', table: '退费', column: 'why', categories: [{ name: '价格' }], newColumn: '分类' }), ctx)
  assert.equal(o2.newColumn, '分类')
}

// ───── 提示词文件 ─────
for (const f of ['p6_classify_propose', 'p6_classify_assign']) {
  assert.match(read(f + '.system.txt'), /JSON/)
}
assert.ok(prompts.assignUser.includes('{{CATEGORIES}}') && prompts.assignUser.includes('{{TEXT_LINES}}'))

console.log('analysis-classify.test ✓')
