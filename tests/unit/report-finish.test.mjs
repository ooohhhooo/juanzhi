// M6：模型输出 → 最终报告。去代码、去反引号、程序写标题、补样本提示、事实核对（time for / time to 回归）、家长版净化。
import assert from 'node:assert/strict'
import { finishReport, dropLeadingH1, dropReportSentence, refreshVerifyWarnings } from '../../src/main/report/finish.ts'
import { MARK_UNVERIFIED, MARK_CONFLICT } from '../../src/shared/factcheck.ts'

const EVIDENCE = ['time for + 名词 / time to + 动词', 'tomato 的复数加 -es', 'sheep 单复数同形，易误加 -s', '表示“谁的”：This is my book.']
const T = '四年级 下学期 2024–2026学年 期末 考情分析报告（完整数据版）· 2026-10-26'
const base = { title: T, knownRefs: new Set(['[2025卷 · 7]']), knownCodes: ['GR', 'RD', 'PH_DIFF', 'GR.NOUN.PLURAL'], sampleWarning: '无', evidence: EVIDENCE, usedDefaultPrompt: true, reader: 'full' }

// 标题由程序写：模型自己的一级标题去掉；「全部年级」这类不会出现
assert.equal(dropLeadingH1('\n# 全部年级 考情分析报告\n> 说明\n正文'), '> 说明\n正文')
{
  const r = finishReport({ ...base, raw: '# 全部年级 考情分析报告\n> 说明：难度与易错点为 AI 估计。\n\n## 教学建议\n1. 多练。' })
  assert.ok(r.text.startsWith(`# ${T}\n\n> 说明`)); assert.ok(!r.text.includes('全部年级'))
  assert.equal(r.warnings.length, 0)
}
// 内部代码、代码列、反引号都去掉；不认识的引用移除并提示
{
  const raw = ['> 说明：AI 估计。', '## 知识点分布', '| 层级 | 代码 | 名称 | 份数 |', '|---|---|---|---|', '| 二级 | GR.NOUN.PLURAL | 名词复数 | 3/3 |', '', '## 易错点预警',
    '- GR.NOUN.PLURAL｜名词复数：tomato 的复数加 -es。样本：`[2025卷 · 7]` 和 `[不存在的卷 · 9]`', '- 题型 PH_DIFF 要多练。', '## 教学建议', '1. 练。'].join('\n')
  const r = finishReport({ ...base, raw })
  assert.ok(!/GR\.NOUN|PH_DIFF|`|代码/.test(r.text), r.text)
  assert.ok(r.text.includes('| 层级 | 名称 | 份数 |') && r.text.includes('[2025卷 · 7]') && !r.text.includes('不存在的卷'))
  assert.ok(r.warnings.some(w => /已移除 1 处无法核对的引用/.test(w)))
}
// 样本提示：模型没转述就由程序补
{
  const r = finishReport({ ...base, sampleWarning: '样本偏小：当前范围内只有 2 份卷子（不足 5 份）。', raw: '> 说明：AI 估计。\n\n## 教学建议\n1. x' })
  assert.ok(r.text.includes('样本提示：')); assert.ok(!r.warnings.some(w => /补在报告开头|样本提示/.test(w)), '补了样本提示不再另放一条说明')
}
// 缺最后一节 → 提示；自定义提示词不检查
assert.ok(finishReport({ ...base, raw: '## 样本概览\n…' }).warnings.some(w => /最后一节「教学建议」/.test(w)))
assert.equal(finishReport({ ...base, usedDefaultPrompt: false, raw: '## 样本概览\n…' }).warnings.length, 0)
assert.ok(finishReport({ ...base, reader: 'boss', raw: '## 三句话结论\n1. x' }).warnings.some(w => /「风险提示」/.test(w)))

// ── 事实核对：time for / time to 写反 → 矛盾；写对的不报；证据里没有的规则 → 未核实 ──
{
  const raw = ["## 易错点预警", "- 介词搭配：time for + 名词，time to + 动词。", "## 年度变化", "- 注意：It's time for 后接动词，It's time to 后接名词。", "- be good at 后接名词或动名词，不能接动词原形。", "## 教学建议", "1. 练。"].join('\n')
  const r = finishReport({ ...base, raw })
  assert.equal(r.unverified.length, 2)
  assert.deepEqual(r.unverified.map(u => u.kind).sort(), ['conflict', 'unverified'])
  assert.ok(r.text.includes(`后接名词${MARK_CONFLICT}`) || r.text.includes(MARK_CONFLICT)); assert.ok(r.text.includes(MARK_UNVERIFIED))
  assert.ok(!r.text.includes('time for + 名词，time to + 动词。〔'), '写对的那句不带标记')
  assert.ok(!r.warnings.some(w => /句讲英语规则的话在审核过的题目解释里找不到依据/.test(w)), '「有 N 句没核实」不再写进 warnings（界面按清单实时计数，不会同一条黄条出现两次）')
}

// ── 家长版：矛盾句直接删；统计词句子删；过长提示 ──
{
  const P = { ...base, reader: 'parent', usedDefaultPrompt: true }
  const raw = ['# 给家长的话', '', "1. **介词搭配**：It's time for 后接动词。例句：It's time for lunch.（该吃午饭了）", '2. **名词复数**：这类题 100% 的卷子都考。tomato 的复数加 -es。例句：Look at the tomatoes.（看那些番茄）', '', '孩子慢慢来。'].join('\n')
  const r = finishReport({ ...P, raw })
  assert.ok(!r.text.includes('后接动词') && !r.text.includes('100%'))
  assert.ok(r.text.includes('tomato 的复数加 es') && r.text.includes('孩子慢慢来'), '「-es」改成了「es」：' + r.text)
  assert.ok(r.warnings.some(w => /和审核过的题目解释矛盾，已从家长版里删掉/.test(w)) && r.warnings.some(w => /统计词或百分比/.test(w)))
  assert.ok(!/^# /m.test(r.text) && r.text.startsWith('各位家长好'), '家长版不写标题，老师口吻开头')
  assert.ok(!r.text.includes('样本提示：'), '家长版不补样本提示（那是给老师看的）')
  const long = finishReport({ ...P, raw: '1. ' + '孩子每天要练一练，慢慢来。'.repeat(20) + '\n2. ' + '孩子每天要练一练，慢慢来。'.repeat(20) })
  assert.ok(long.warnings.some(w => /超过了 300 字/.test(w)))
}
// ── P1-3：家长版矛盾句夹着引用 / 粗体也要能删；提示要和实际结果一致 ──
{
  const P = { ...base, reader: 'parent', knownRefs: new Set(['[2025卷 · 7]']) }
  const raw = ["1. 练习 It's time for 后接[2025卷 · 7]动词原形，孩子容易错。tomato 的复数加 -es，多读几遍这个词。", '2. **time for** 后接**动词**，要注意。例句：It\'s time for lunch.（该吃午饭了）', '3. 孩子慢慢来，每天抽五分钟，比一次练很久更有用。'].join('\n')
  const r = finishReport({ ...P, raw })
  assert.ok(!/后接/.test(r.text), `矛盾句要删干净：\n${r.text}`)
  assert.ok(r.text.includes('tomato 的复数加 es') && r.text.includes('孩子慢慢来'))
  assert.ok(!r.text.includes('例句：It\'s time for lunch'), '删掉矛盾句之后只剩一个例句的那条不是完整的话，整条去掉（不留半句话）')
  assert.ok(r.warnings.some(w => /和审核过的题目解释矛盾，已从家长版里删掉/.test(w)), r.warnings.join('|'))
  assert.equal(r.unverified.filter(u => u.kind === 'conflict').length, 0)
}
// 删不掉的（这里用不可能删掉的构造：证据 / 句子都存在但正文里没有可定位的文字）不会写「已删掉」：由 removeSentence 单测 + 这里的实际结果保证
// ── P2-1：家长版被净化到几乎只剩标题 → 提示不能核对；「难点」这类词不再被当成统计词 ──
{
  const P = { ...base, reader: 'parent' }
  const gone = finishReport({ ...P, raw: '这是孩子的统计结果，样本较少。同比下降 30%。' })
  assert.ok(gone.warnings.some(w => /内容太少.*不能核对通过/.test(w)))
  const keep = finishReport({ ...P, raw: '1. 这是孩子的难点：tomato 变成两个时要加 -es，每天口头说三遍。\n2. 重点是 sheep 单复数一样，别加 s。' })
  assert.ok(keep.text.includes('难点') && keep.text.includes('重点'), '「难点」「重点」不再被删')
}

// ── 核对时删掉清单里的一句（连标记一起删；只能删清单里的）──
{
  const r = finishReport({ ...base, raw: "## 易错点\n- 介词：It's time for 后接动词，孩子容易错。\n- be good at 后接名词，不能接动词原形。\n- 别的话。\n## 教学建议\n1. 练。" })
  assert.equal(r.unverified.length, 2)
  const out = dropReportSentence(r.text, r.unverified, r.unverified[0].sentence)
  assert.ok(out && !out.markdown.includes(r.unverified[0].sentence) && !out.markdown.includes(MARK_CONFLICT) && out.markdown.includes('别的话'), out && out.markdown)
  assert.equal(out.unverified.length, 1)
  assert.equal(dropReportSentence(r.text, r.unverified, '别的话'), null, '不在清单里的句子不能借这个接口删')
  assert.equal(dropReportSentence(r.text, [{ sentence: '正文里没有的句子', kind: 'unverified', reason: 'x' }], '正文里没有的句子'), null)
}

// ── 删句后：孤立的引用 / 多余的句号一起清掉；提示里的数字同步 ──
{
  const REF = '[2025卷 · 7]'
  const md = `# 标题\n\n1. **练习 It's time for 后接动词，孩子容易错** ${REF}。另一个要点：tomato 的复数加 -es。\n2. 保留这一条。`
  const items = [{ sentence: "练习 It's time for 后接动词，孩子容易错", kind: 'conflict', reason: 'x' }]
  const out = dropReportSentence(md, items, items[0].sentence)
  assert.ok(out, '要能删')
  assert.ok(!out.markdown.includes(REF) && !out.markdown.includes('time for') && !/\*\*/.test(out.markdown.split('\n')[2]), out.markdown)
  assert.ok(out.markdown.includes('1. 另一个要点：tomato 的复数加 -es。') && !/(^|\n)1\.\s+[。.]/.test(out.markdown) && out.markdown.includes('2. 保留这一条。'), out.markdown)
  // 提示重算
  const w0 = ['已移除 1 处无法核对的引用', '有 2 句讲英语规则的话在审核过的题目解释里找不到依据，已标「未核实」，请老师核对后再用（其中有和题目解释矛盾的）', '有 1 句讲英语规则的话和审核过的题目解释矛盾，已从家长版里删掉']
  const two = [{ sentence: 'a', kind: 'conflict', reason: '' }, { sentence: 'b', kind: 'unverified', reason: '' }]
  const w1 = refreshVerifyWarnings(w0, [two[1]])
  assert.ok(w1.some(w => /有 1 句讲英语规则的话在审核过的题目解释里找不到依据/.test(w)) && !w1.some(w => /有 2 句/.test(w)) && !w1.some(w => /其中有和题目解释矛盾的/.test(w)))
  assert.ok(w1.includes('已移除 1 处无法核对的引用') && w1.some(w => /已从家长版里删掉/.test(w)), '其他提示（含生成时删句的记录）原样保留')
  assert.deepEqual(refreshVerifyWarnings(w0, []).filter(w => /找不到依据/.test(w)), [], '清单空了就不留这一条')
}


// ── 老板版：不逐句挂「未核实」，统一在三句话结论后面一行；删句后数量跟着变，清零就去掉；确认后去掉 ──
{
  const B = { ...base, reader: 'boss', bossLine: '基于 2 份卷子（2024–2025、2025–2026 学年），仅作方向参考。' }
  const raw = ['## 三句话结论', '1. 基于 2 份卷子，下学期教研先投名词复数、介词搭配、购物三块，其他先不动。', '2. 这三块两份卷子都考了。', '3. 还要补卷子。', '',
    '## 教研重点与课程卖点', '- **教研重点**：名词复数（tomatoes）：tomato 的复数加 es；sheep 的复数要加 s。', '- **课程卖点**：做专项练习（现在能说）。', '', '## 风险提示', '1. 补卷子。', '2. 校对。', '3. 先不宣传。'].join('\n')
  const r = finishReport({ ...B, raw })
  assert.ok(r.unverified.length >= 1, '清单仍在（核对框要用）：' + JSON.stringify(r.unverified))
  assert.ok(!r.text.includes('〔未核实〕') && !r.text.includes('〔与题目解释矛盾'), '老板版正文不逐句挂标记：\n' + r.text)
  const line = `> 有 ${r.unverified.length} 处说法还没经老师核对`
  assert.ok(r.text.includes(line), r.text)
  const lines = r.text.split('\n')
  const at = lines.indexOf(line), h2 = lines.findIndex(l => /^## 教研重点/.test(l))
  assert.ok(at > lines.findIndex(l => /^## 三句话结论/.test(l)) && at < h2, '放在三句话结论这一节的末尾')
  assert.equal(lines.filter(l => l.includes('还没经老师核对')).length, 1)
  // 老师版 / 完整版照旧逐句标注
  const t = finishReport({ ...base, reader: 'teacher', raw: '## 易错点\n- tomato 的复数加 es；sheep 的复数要加 s。\n\n## 备课建议\n1. 练。' })
  assert.ok(/〔(未核实|与题目解释矛盾)/.test(t.text) && !t.text.includes('还没经老师核对'))
  // 删掉一句 → 数量跟着变；全部删完 → 这一行去掉
  const u0 = r.unverified[0]
  const d = dropReportSentence(r.text, r.unverified, u0.sentence)
  assert.ok(d, '能删')
  if (d.unverified.length) assert.ok(d.markdown.includes(`有 ${d.unverified.length} 处说法还没经老师核对`))
  else assert.ok(!d.markdown.includes('还没经老师核对'), '清单空了就没有这一行')
}

// 老板版：分值最高的大类没进重点、结论里也没提 → warnings 里提示一句
{
  const raw = '## 三句话结论\n1. 下学期教研先投名词复数、介词搭配、购物三块，其他先不动。\n2. 这三块两份卷子都考了。\n3. 还要补卷子。\n\n## 风险提示\n1. a\n2. b\n3. c'
  const B = { ...base, reader: 'boss', bossLine: '基于 2 份卷子。' }
  assert.ok(finishReport({ ...B, raw, topScore: { name: '写作与书面表达', share: 0.3 } }).warnings.some(w => /分值最高的「写作与书面表达」/.test(w)))
  assert.ok(!finishReport({ ...B, raw }).warnings.some(w => /分值最高/.test(w)))
}
console.log('report-finish.test ✓')
