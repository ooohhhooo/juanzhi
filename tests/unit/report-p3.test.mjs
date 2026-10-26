// P3 报告：输入构造（占位符 = 手算）、SAMPLE_WARNING 判定、引用校验、样本提示兜底、mock P3 应答、Markdown（表格 / 代码围栏 / 粗体里的引用）、
// 导出计划（Markdown 的同名文件夹 + 图片链接）、PDF 用的 HTML（转义 + 跨平台中文字体回退链）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import * as P2 from '../../src/main/stats/p2.ts'
import { collectP3Source } from '../../src/main/stats/p3-collect.ts'
import * as P3 from '../../src/main/stats/p3.ts'
import { CITATION_RE, stripUnknownCitations } from '../../src/shared/citation.ts'
import { parseBlocks, parseInline, splitRow } from '../../src/shared/markdown.ts'
import { markdownToHtml, reportHtmlPage, CJK_FONT_STACK, esc } from '../../src/shared/mdhtml.ts'
import { planMarkdownExport, safeStem, uniqueRefs, neutralizeHtml } from '../../src/main/report/export-plan.ts'
const require = createRequire(import.meta.url)
const mock = require('../mock-ai/p3.cjs')
const mockP2 = require('../mock-ai/p2.cjs')

const sys = fs.readFileSync('src/main/ai/prompts/p3_report.system.txt', 'utf8').replace(/\s+$/, '')
const userTpl = fs.readFileSync('src/main/ai/prompts/p3_report.user.txt', 'utf8').replace(/\s+$/, '')
const p2sys = fs.readFileSync('src/main/ai/prompts/p2_yoy.system.txt', 'utf8')

const TREE = [['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.2', 'A', '甲二', 2], ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2], ['D', null, '丁', 1], ['D.1', 'D', '丁一', 2]]
const { db } = newDb()
useTree(db, TREE)
db.exec("INSERT OR IGNORE INTO qtypes (code, name, \"group\", note, sort, builtin) VALUES ('MC', '单项选择', 'written', '', 1, 1)")
const mk = (year, qs, extra = {}) => addPaper(db, { year, grade: '4', title: `${year}卷${qs.map(q => q.kp).join('')}`, questions: qs, ...extra })
const q = (kp, score, diff, err, reason, qtype = 'MC') => ({ kp, score, difficulty: diff, err, reason, qtype })
// 2024：两份；2025：三份（共 5 份，足够大）
mk(2024, [q('A.1', 2, 2), q('B.1', 2, 3, true, '易混淆')])
mk(2024, [q('A.1', 2, 3), q('A.2', 3, 4)])
mk(2025, [q('A.1', 2, 3, true, '时态混用'), q('D.1', 2, 4)])
mk(2025, [q('A.1', 2, 2), q('B.1', 2, 3, true, '易混淆')])
mk(2025, [q('A.1', 2, 5, true, '时态混用'), q('A.2', null, 1)])

const f = {}
const dist = S.distribution(db, f)
const hot = S.hot(db, f, 2, 30, undefined, false)
const cmp = S.compare(db, f, 2025, { lt: 2025 }, 2, 0, true)
const base = { filter: f, dist, hot, cmp, years: [2024, 2025], distinctGrades: 1, distinctExamTypes: 1 }
const inp = P3.buildP3Input(base)
const ph = inp.placeholders
const cols = l => l.split(' | ')

// ── 占位符 = 手算（5 份卷子、10 道题；总分 19：A.1×5=10、A.2 只有一道有分值=3、B.1=4、D.1=2） ──
assert.equal(ph.FILTER_DESC, '全部年级')
assert.equal(ph.PAPER_COUNT, '5'); assert.equal(ph.QUESTION_COUNT, '10')
assert.equal(ph.YEARS, '2024-2025学年、2025-2026学年')
assert.equal(ph.SAMPLE_WARNING, '年度变化的样本偏小：目标学年只有 3 份，基线学年只有 2 份（不足 5 份）。', '卷子 5 份、同年级同类型、分值覆盖 9/10 刚好 90% → 只有年度变化两侧不足 5 份的警示')
assert.deepEqual(ph.KP_DIST.split('\n'), [
  '一级 | A | 甲 | 5/5 | 7 | 68.4% | 2.86 | 2', '一级 | B | 乙 | 2/5 | 2 | 21.1% | 3 | 2', '一级 | D | 丁 | 1/5 | 1 | 10.5% | 4 | 0',
  '二级 | A.1 | 甲一 | 5/5 | 5 | 52.6% | 3 | 2', '二级 | A.2 | 甲二 | 2/5 | 2 | 15.8% | 2.5 | 0', '二级 | B.1 | 乙一 | 2/5 | 2 | 21.1% | 3 | 2', '二级 | D.1 | 丁一 | 1/5 | 1 | 10.5% | 4 | 0'])
assert.equal(ph.QTYPE_DIST, '单项选择 | 10 | 19 | 100% | 3')
assert.deepEqual(ph.DIFF_DIST.split('\n'), ['1 | 1 | 10%', '2 | 2 | 20%', '3 | 4 | 40%', '4 | 2 | 20%', '5 | 1 | 10%'])
const err = ph.ERROR_PRONE.split('\n').map(cols)
assert.deepEqual(err.map(r => r.slice(0, 3)), [['A.1', '甲一', '时态混用'], ['B.1', '乙一', '易混淆']], '易错点按易错题数、综合得分排序；只列有易错题的')
assert.equal(err[0][3], '[2025卷A.1A.2 · 1]（单项选择：题干1）；[2025卷A.1D.1 · 1]（单项选择：题干1）', '样本题：易错的优先，难度高的在前，每个知识点最多 2 道')
assert.equal(err[1][3], '[2025卷A.1B.1 · 2]（单项选择：题干2）；[2024卷A.1B.1 · 2]（单项选择：题干2）')
assert.equal(ph.YEAR_DIFF, ['对比口径：目标 2025-2026学年 3 份，基线 2024-2025学年 2 份；学期范围：目标 上学期，基线已按学期对齐，只取 上学期',
  '新增（基线学年从未出现）：丁一（目标 1/3 份）', '消失（目标学年未出现）：无', '明显上升：无', '明显下降：无'].join('\n'))
// 占位符齐全，模板填得进去，没有残留
assert.deepEqual(Object.keys(ph), [...P3.P3_PLACEHOLDERS])
const user = P2.fillTemplate(userTpl, ph)
assert.ok(!user.includes('{{') && !user.includes('}}'))
// token 索引与占位符里出现的一一对应
const used = new Set([...ph.ERROR_PRONE.matchAll(CITATION_RE)].map(m => m[0]))
assert.deepEqual([...used].sort(), inp.refs.map(r => r.token).sort())
assert.match(inp.fingerprint, /^[0-9a-f]{64}$/)
assert.equal(P3.buildP3Input(base).fingerprint, inp.fingerprint, '同样的数据同样的指纹')
assert.notEqual(P3.buildP3Input({ ...base, filter: { grade: '4' } }).fingerprint, inp.fingerprint, '筛选描述变了指纹就变')

// ── SAMPLE_WARNING 由程序判定 ──
{
  const w = (dist2, over = {}) => P3.p3SampleWarning({ dist: dist2, cmp: null, distinctGrades: 1, distinctExamTypes: 1, ...over })
  assert.equal(w({ ...dist, papers: 4 }), '样本偏小：当前范围内只有 4 份卷子（不足 5 份），出现率等比例可能只是一两份卷子的差别。')
  assert.equal(w(dist), '无')
  assert.equal(w(dist, { distinctGrades: 2 }), '范围内混入了不同年级的试卷，结论只能作粗略参考。')
  assert.equal(w(dist, { distinctGrades: 3, distinctExamTypes: 2 }), '范围内混入了不同年级、不同考试类型的试卷，结论只能作粗略参考。')
  assert.match(w({ ...dist, coverage: { scored: 5, questions: 10, tagged: 10 } }), /有 5 道题没有填写分值（分值覆盖 5\/10 题）/)
  assert.equal(w({ ...dist, coverage: { scored: 9, questions: 10, tagged: 10 } }), '无', '刚好 90% 不警示')
  const two = w({ ...dist, papers: 3 }, { distinctGrades: 2 })
  assert.ok(two.startsWith('样本偏小') && two.includes('；范围内混入了') && two.endsWith('。'), '多条警示用分号连起来')
}
// 只有一个学年 → 年度变化为（无）
{
  const one = P3.buildP3Input({ ...base, filter: { school_year_start: 2025 }, cmp: null, years: [2025] })
  assert.equal(one.placeholders.YEAR_DIFF, '（无）'); assert.equal(one.placeholders.YEARS, '2025-2026学年')
  assert.match(one.placeholders.FILTER_DESC, /^全部年级$/)
}
// 没有易错题 → ERROR_PRONE（无）；没有任何卷子 → empty
{
  const { db: d2 } = newDb(); useTree(d2, TREE)
  addPaper(d2, { year: 2025, title: 'x', questions: [{ kp: 'A.1', score: 2, difficulty: 2 }] })
  const x = P3.buildP3Input({ ...base, dist: S.distribution(d2, {}), hot: S.hot(d2, {}, 2, 30, undefined, false), cmp: null, years: [2025] })
  assert.equal(x.placeholders.ERROR_PRONE, '（无）'); assert.equal(x.empty, false)
  const none = P3.buildP3Input({ ...base, dist: S.distribution(d2, { grade: '6' }), hot: S.hot(d2, { grade: '6' }, 2, 30, undefined, false), cmp: null, years: [] })
  assert.equal(none.empty, true); assert.equal(none.placeholders.KP_DIST, '（无）'); assert.match(none.placeholders.YEARS, /未填写学年/)
}
// 二级知识点超过 30 个：只列前 30，表尾说明另有几个
{
  const fakeNodes = Array.from({ length: 35 }, (_, i) => ({ code: `K.${i}`, name: `点${i}`, level: 2, papers: 35 - i, questions: 1, scoreShare: 0.01, avgDifficulty: 3, errorCount: 0 }))
  const x = P3.buildP3Input({ ...base, dist: { ...dist, nodes: fakeNodes } })
  const rows = x.placeholders.KP_DIST.split('\n')
  assert.equal(rows.filter(r => r.startsWith('二级')).length, 30); assert.match(rows[rows.length - 1], /二级知识点另有 5 个/)
}
// 示例数据：筛选描述里明写，免得报告被当成真实考情
assert.match(P2.describeFilter({ sample: true }, 0), /^示例数据（合成的演示卷，不是真实考情） · 全部年级$/)

// ── 引用校验：不在索引里的删除 ──
{
  const known = new Set(inp.refs.map(r => r.token))
  const t = `正文 ${[...known][0]} 与自造的 [不存在的卷 · 99]、[2025卷A.1A.2 · 7] 。`
  const r = stripUnknownCitations(t, known)
  assert.deepEqual(r.removed.sort(), ['[2025卷A.1A.2 · 7]', '[不存在的卷 · 99]'].sort())
  assert.ok(r.text.includes([...known][0]) && !r.text.includes('不存在的卷'))
}

// ── 样本提示兜底：模型没转述就由程序补在开头 ──
{
  const warn = '样本偏小：当前范围内只有 3 份卷子（不足 5 份）。'
  const withIt = '# 标题\n> 说明：…。样本偏小：当前范围内只有 3 份卷子。结论仅供参考。\n\n## 样本概览\n…'
  assert.deepEqual(P3.ensureSampleWarning(withIt, warn), { text: withIt, inserted: false }, '模型已经转述了就不重复')
  const dropped = '# 标题\n> 说明：难度与易错点为 AI 估计，非学生成绩统计。\n\n## 样本概览\n…'
  const r = P3.ensureSampleWarning(dropped, warn)
  assert.equal(r.inserted, true)
  assert.equal(r.text.split('\n').slice(0, 4).join('|'), `# 标题|> 说明：难度与易错点为 AI 估计，非学生成绩统计。|> 样本提示（程序判定）：${warn}结论仅供参考。|`)
  assert.deepEqual(P3.ensureSampleWarning(dropped, '无'), { text: dropped, inserted: false }, '无警示时不写')
  assert.equal(P3.ensureSampleWarning('没有标题的正文\n## 节', warn).text.split('\n')[0].startsWith('> 样本提示'), true)
  assert.equal(P3.hasFinalSection('## 教学建议\n1. x'), true); assert.equal(P3.hasFinalSection('## 年度变化\n…'), false)
}

// ── mock P3：能识别真实 P3 提示词，数字 / 代码 / token 来自输入 ──
{
  assert.ok(mock.isP3(sys, user)); assert.ok(!mock.isP3(p2sys, user)); assert.ok(!mockP2.isP2(sys, user), 'P2 的 mock 不会接 P3')
  const md = mock.build(user, {})
  for (const h of ['# 全部年级 考情分析报告', '## 样本概览', '## 知识点分布', '## 题型与分值', '## 难度结构', '## 重点与难点', '## 易错点预警', '## 年度变化', '## 教学建议']) assert.ok(md.includes(h), h)
  assert.match(md, /卷子 5 份，题目 10 道；覆盖学年：2024-2025学年、2025-2026学年/)
  assert.match(md, /\| 二级 \| A\.1 \| 甲一 \| 5\/5 \| 5 \| 52\.6% \|/, '表格里的数字逐字抄自输入')
  assert.ok(md.split('\n')[1].startsWith('> 说明：难度与易错点为 AI 估计，非学生成绩统计。年度变化的样本偏小'), '有样本提示就转述')
  const known = new Set(inp.refs.map(r => r.token))
  assert.deepEqual(stripUnknownCitations(md, known).removed, [])
  assert.ok([...md.matchAll(CITATION_RE)].length >= 1)
  assert.deepEqual(stripUnknownCitations(mock.build(user, { badCite: true }), known).removed, ['[不存在的卷 · 99]'])
  assert.ok(!mock.build(user, { dropWarning: true }).includes('样本偏小'))
  assert.ok(!mock.build(user, { noAdvice: true }).includes('## 教学建议'))
  assert.ok(/\*\*\[2025卷A\.1A\.2 · 1\]\*\*/.test(mock.build(user, { boldCite: true })))
  // 没有年度变化 → 整节省略
  const noDiff = P2.fillTemplate(userTpl, { ...ph, YEAR_DIFF: '（无）' })
  assert.ok(!mock.build(noDiff, {}).includes('## 年度变化'))
}

// ── Markdown：表格 / 代码围栏 / 粗体里的引用 ──
{
  const md = ['# T', '', '| 层级 | 代码 | 占比 |', '|:--|:-:|--:|', '| 二级 | A.1 | 52.6% |', '| 二级 | A.2 \\| x | 15.8% |', '', '后面的段落', '', '```', '| 不是 | 表格 |', '```', '', '**[甲卷 · 3]** 与 **加粗**']
  const blocks = parseBlocks(md.join('\n'))
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'table', 'p', 'code', 'p'])
  const tb = blocks[1]
  assert.equal(tb.header.length, 3); assert.equal(tb.rows.length, 2)
  assert.deepEqual(tb.align, ['left', 'center', 'right'])
  assert.deepEqual(tb.rows[1][1], [{ type: 'text', text: 'A.2 | x' }], '\\| 是转义的竖线')
  assert.equal(blocks[3].text, '| 不是 | 表格 |', '围栏里的内容原样保留，不再当表格解析')
  // 引用包在粗体里：得到一个引用 + 粗体，不露出字面的 **
  const inl = blocks[4].inline
  assert.deepEqual(inl.map(x => x.type), ['cite', 'text', 'bold'])
  assert.ok(!JSON.stringify(inl).includes('**'))
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b']); assert.deepEqual(splitRow('a|b|c'), ['a', 'b', 'c'])
  // 没有分隔行就不是表格
  assert.equal(parseBlocks('a | b\nc | d').every(b => b.type === 'p'), true)
  // 普通 P2 文本不受影响
  assert.deepEqual(parseInline('**粗** 和 [卷 · 1]').map(x => x.type), ['bold', 'text', 'cite'])
}

// ── Markdown 导出计划：同名文件夹 + 图片链接；没有出现在索引里的引用不出图 ──
{
  const refs = [...inp.refs.map(r => ({ ...r, pageRel: 'page-1.png', bbox: [0.1, 0.1, 0.5, 0.1] })), { ...inp.refs[0], token: '[已删的卷 · 1]', missing: true }]
  const md = `# 报告\n依据 ${refs[0].token}，另有 [不存在的卷 · 99] 和 [已删的卷 · 1]。\n\n\`\`\`\n${refs[0].token}\n\`\`\`\n再次 ${refs[0].token}`
  const plan = planMarkdownExport(md, refs, '考情 报告')
  assert.equal(plan.images.length, 1, '同一个引用只出一张图；自造的 / 已删除的 / 代码块里的都不出图')
  assert.equal(plan.images[0].file, 'q-001.png')
  const link = `![题目截图：${refs[0].token.slice(1, -1)}](${encodeURIComponent('考情 报告')}/q-001.png)`
  assert.equal(plan.markdown.split(link).length - 1, 2, '正文里两处引用都接了图片链接，代码块里的没动')
  assert.ok(plan.markdown.includes('[不存在的卷 · 99]') && !plan.markdown.includes('[不存在的卷 · 99] !['))
  assert.deepEqual(uniqueRefs(md, refs).map(r => r.token), [refs[0].token])
  assert.equal(safeStem('a/b:c*?.md'), 'a_b_c__.md'); assert.equal(safeStem('...'), '考情分析报告'); assert.equal(safeStem(' x '), 'x')
}

// ── PDF 用的 HTML：转义 + 跨平台中文字体回退链 ──
{
  const html = markdownToHtml('# <script>alert(1)</script>\n\n| a | b |\n|--|--|\n| <img src=x onerror=1> | **粗** |', { cite: () => null })
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'), '模型输出里的标签只是字面文字')
  assert.ok(html.includes('&lt;script&gt;') && html.includes('<table>') && html.includes('<b>粗</b>'))
  const page = reportHtmlPage({ title: '标题 <b>', bodyHtml: html, footer: '脚注' })
  assert.ok(/<title>标题 &lt;b&gt;<\/title>/.test(page) && !/<script/i.test(page.replace(/&lt;script/g, '')), '页面本身不带脚本')
  for (const f of ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC']) assert.ok(page.includes(`"${f}"`), `字体回退链含 ${f}`)
  assert.ok(CJK_FONT_STACK.trim().endsWith('sans-serif'))
  assert.equal(esc('<&">'), '&lt;&amp;&quot;&gt;')
  const withCite = markdownToHtml('见 [卷 · 1]', { cite: t => `<span class="cite">${esc(t)}</span>` })
  assert.ok(withCite.includes('class="cite"'))
}

// ── 审核 P1-4：易错点不能被「综合得分前 30 名」截掉 ──
{
  const { db: d } = newDb()
  const nodes = [['T', null, '时态', 1]]
  for (let i = 0; i < 35; i++) nodes.push([`T.H${i}`, 'T', `高频${i}`, 2])
  nodes.push(['T.X', 'T', '偏门但易错', 2])
  useTree(d, nodes)
  // 5 份卷子，每份都考 35 个高频二级节点（无易错题）；只有第 1 份里有 1 道偏门节点的题，且是易错题 ×2（同一份卷子两道）
  for (let p = 0; p < 5; p++) addPaper(d, { year: 2025, title: `卷${p}`, questions: [...Array.from({ length: 35 }, (_, i) => ({ kp: `T.H${i}`, score: 2, difficulty: 2 })), ...(p === 0 ? [{ kp: 'T.X', score: 1, difficulty: 5, err: true, reason: '偏门易错' }, { kp: 'T.X', score: 1, difficulty: 5, err: true, reason: '偏门易错' }] : [])] })
  const dist2 = S.distribution(d, {})
  assert.equal(dist2.nodes.find(n => n.code === 'T.X').errorCount, 2, '看板（全量）里偏门节点有 2 道易错题')
  const cut = S.hot(d, {}, 2, 30, undefined, false)
  assert.ok(!cut.rows.some(r => r.code === 'T.X'), '截到 30 个时它确实掉出去了（这是修复前的行为）')
  assert.ok(P3.P3_HOT_LIMIT >= 67 + 100, 'P3 取的行数上限远大于内置二级节点数（67）')
  const full = S.hot(d, {}, 2, P3.P3_HOT_LIMIT, undefined, false)
  // 真正的调用点：report/service.ts 用的就是这个函数；它若把行数改回 30，下面这条要失败
  const real = P3.buildP3Input(collectP3Source(d, {}))
  assert.ok(real.placeholders.ERROR_PRONE.startsWith('T.X | 偏门但易错 | 偏门易错 | '), 'collectP3Source（service 的取数入口）也带着这条易错点：' + real.placeholders.ERROR_PRONE.slice(0, 80))
  assert.ok(collectP3Source(d, {}).hot.rows.length > 30, 'service 取数入口取的是全量，不是前 30')
  const inp3 = P3.buildP3Input({ filter: {}, dist: dist2, hot: full, cmp: null, years: [2025], distinctGrades: 1, distinctExamTypes: 1 })
  assert.ok(inp3.placeholders.ERROR_PRONE.startsWith('T.X | 偏门但易错 | 偏门易错 | '), '易错点表里有它：' + inp3.placeholders.ERROR_PRONE.slice(0, 80))
  // 知识点名里有 | 或换行：表格不能错列
  const weird = { ...dist2, nodes: [{ code: 'A', name: '甲|乙\n丙', level: 1, papers: 1, questions: 1, scoreShare: 0.5, avgDifficulty: 3, errorCount: 0 }] }
  const wi = P3.buildP3Input({ filter: {}, dist: weird, hot: full, cmp: null, years: [2025], distinctGrades: 1, distinctExamTypes: 1 })
  assert.equal(wi.placeholders.KP_DIST, '一级 | A | 甲／乙 丙 | 1/5 | 1 | 50% | 3 | 0', '名称里的 | 换成全角、换行压成空格')
}
// ── 审核 P2-9：导出的 .md 里模型输出的 HTML 要中和（代码围栏里的不动，我们生成的图片链接不受影响）──
{
  const md = '正文 <script>alert(1)</script> 和 <img src=x onerror=1>\n```\n<b>围栏里</b>\n```\n3 < 5 [卷 · 1]'
  const out = neutralizeHtml(md)
  assert.ok(!/<script|<img/i.test(out.split('```')[0]), '围栏外的标签被转义')
  assert.ok(out.includes('&lt;script&gt;') || out.includes('&lt;script>'))
  assert.ok(out.includes('<b>围栏里</b>'), '围栏里原样')
  const plan = planMarkdownExport(neutralizeHtml('见 [卷 · 1] <b>x</b>'), [{ token: '[卷 · 1]', questionId: 'q', paperId: 'p', paperTitle: '卷', no: '1', qtypeName: 'x', page_idx: 1, pageRel: 'page-1.png', pageW: 1, pageH: 1, bbox: [0, 0, 1, 1] }], 'd')
  assert.ok(plan.markdown.includes('![题目截图：卷 · 1](d/q-001.png)') && plan.markdown.includes('&lt;b>x'), '图片链接仍在')
}
console.log('report-p3.test ✓')
