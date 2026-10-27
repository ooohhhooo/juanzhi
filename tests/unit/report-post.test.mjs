// M6 报告程序侧收尾：去代码、修反引号、家长版净化、复制到微信的纯文本、标题。
import assert from 'node:assert/strict'
import { stripInternalCodes, fixBackticks, sanitizeParent, markdownToWechat, reportTitle, parentBodyLength, confirmBlockReason, unacknowledgedSentences, PARENT_MIN_CHARS, READER_LABEL } from '../../src/shared/report-post.ts'
import * as RP from '../../src/shared/report-post.ts'

// ── 去代码 ──
{
  const md = [
    '## 知识点分布', '| 层级 | 代码 | 名称 | 出现份数/总份数 |', '|---|---|---|---|', '| 一级 | GR | 语法 | 3/3 |', '| 二级 | GR.NOUN.PLURAL | 名词复数 | 3/3 |', '',
    '### GR.NOUN.PLURAL｜名词复数', '- GR.PREP.COLLOC｜介词固定搭配：time for + 名词（PH_DIFF）', '常见题型：词汇分类（VO_CLASS）与 `GR.NOUN` 有关。'
  ].join('\n')
  const out = stripInternalCodes(md, ['GR', 'FN', 'RD'])
  assert.ok(!/GR\.|PH_DIFF|VO_CLASS|\bGR\b/.test(out), `代码要去干净：\n${out}`)
  assert.ok(out.includes('| 层级 | 名称 | 出现份数/总份数 |'), '「代码」列整列删除')
  assert.ok(out.includes('| 二级 | 名词复数 | 3/3 |') && out.includes('| 一级 | 语法 | 3/3 |'))
  assert.ok(out.includes('### 名词复数') && out.includes('- 介词固定搭配：time for + 名词'), out)
  assert.ok(!out.includes('（）') && !out.includes('``'), '去掉代码后不留空括号 / 空反引号')
  assert.equal(stripInternalCodes('没有代码的一段话。'), '没有代码的一段话。')
  assert.equal(stripInternalCodes('FN 和 FNX 都是词', ['FN']).trim(), '和 FNX 都是词', '单段代码只认已知表、只认整词')
  // 题型代码和正常的大写英文单词长得一样：裸写的不删（题干摘录里的 MATCH / ORDER），括号 / 反引号 / 代码｜名称 里的才删
  const kn = ['GR', 'MATCH', 'ORDER', 'FILL', 'WRITE', 'OTHER', 'MC']
  assert.equal(stripInternalCodes('题干摘录：MATCH the words. ORDER 很重要，WRITE it down.', kn), '题干摘录：MATCH the words. ORDER 很重要，WRITE it down.')
  assert.equal(stripInternalCodes('连线题（MATCH）和连词成句（ORDER）要多练，`FILL` 也是。', kn), '连线题和连词成句要多练， 也是。')
  assert.equal(stripInternalCodes('### MATCH｜连线与匹配', kn).trim(), '### 连线与匹配')
}
// ── 反引号 ──
assert.equal(fixBackticks('重点题：`[2025卷 · 16]` ![图](a/b.png)`'), '重点题：[2025卷 · 16] ![图](a/b.png)')
assert.equal(fixBackticks('```\n`留着`\n```\n`去掉`'), '```\n`留着`\n```\n去掉')
// ── 家长版净化 ──
{
  const md = ['# 孩子要练什么', '> 提示', '1. 名词复数：sheep 单复数一样，不能加 s。这类题 100% 的卷子都考。', '2. 出现率很高的固定搭配。time for breakfast（该吃早饭了）。', '3. 在家每天读 5 分钟。'].join('\n')
  const r = sanitizeParent(md)
  assert.equal(r.removed, 2)
  assert.ok(r.text.includes('sheep 单复数一样，不能加 s。') && r.text.includes('time for breakfast') && r.text.includes('3. 在家每天读 5 分钟。'))
  assert.ok(!/%|出现率/.test(r.text))
  assert.ok(parentBodyLength('# 标题\n1. 一二三四五六七八九十。\n2. 十个字十个字十个字') > 10)
}
// ── 复制到微信 ──
{
  const md = ['# 给家长的话', '> 这是一份 AI 草稿〔未核实〕', '## 要练什么', '- **名词复数**：sheep 单复数同形。〔未核实〕', '- time for breakfast（该吃早饭了）', '', '1. 在家每天读一读', '![图](x/y.png) [2025卷 · 3]', '正文**加粗**与`代码`。'].join('\n')
  const w = markdownToWechat(md)
  assert.ok(!/[#*>|`〔〕]|!\[|\]\(/.test(w), `纯文本里不能有 Markdown 符号：\n${w}`)
  assert.ok(w.includes('1. 名词复数：sheep 单复数同形。') && w.includes('2. time for breakfast（该吃早饭了）'), w)
  assert.ok(w.includes('给家长的话\n') && w.includes('要练什么\n'), '标题单独一行')
  assert.ok(!w.includes('AI 草稿'), '引用块（给老师看的说明）不进复制的文字')
  assert.ok(w.endsWith('\n') && !w.includes('\n\n\n'))
}
// ── 标题 ──
{
  const base = { grades: ['4'], semesters: ['下'], examTypes: ['期末'], years: [2024, 2025], reader: 'boss', date: '2026-10-26', filter: {} }
  assert.equal(reportTitle(base), '四年级 下学期 2024–2026学年 期末 考情分析报告（老板版）· 2026-10-26')
  assert.equal(reportTitle({ ...base, grades: ['4', '5'], semesters: ['上', '下'], examTypes: ['期中', '期末'], years: [2025], reader: 'parent' }), '四、五年级 2025-2026学年 考情分析报告（家长版）· 2026-10-26')
  assert.ok(!reportTitle({ ...base, grades: ['4'], filter: {} }).includes('全部年级'))
  assert.equal(reportTitle({ ...base, grades: ['1', '2', '3', '4', '5', '6'], reader: 'full', filter: { sample: true } }).startsWith('示例数据 全部年级'), true)
  assert.equal(reportTitle({ ...base, grades: [], filter: { grade: '4', semester: '上', exam_type: '期中' } }), '四年级 上学期 2024–2026学年 期中 考情分析报告（老板版）· 2026-10-26')
  assert.deepEqual(Object.values(READER_LABEL), ['老板版', '家长版', '老师版', '完整数据版'])
}
// ── 能不能核对 / 复制 / 导出（P2-1）──
{
  const body = '1. ' + '孩子每天练一练，慢慢来。'.repeat(4) + '\n\n2. ' + '孩子每天练一练，慢慢来。'.repeat(4)
  assert.equal(confirmBlockReason({ reader: 'parent', markdown: `# 标题\n\n${body}`, unverified: [] }), null)
  assert.match(confirmBlockReason({ reader: 'parent', markdown: '# 标题\n\n', unverified: [] }), /只剩 0 条/)
  // 只剩 1 条要点 + 程序补的问候和结尾：字数够 40 也不能核对（问候和结尾不算）
  const shell = '各位家长好，这次期末英语有这几个小地方孩子容易错，在家几分钟就能帮上：\n\n1. tomato 一个其他多个。\n\n整体不用太担心，孩子基础不错，继续保持就好。\n'
  assert.match(confirmBlockReason({ reader: 'parent', markdown: shell, unverified: [] }), /只剩 1 条要点/)
  assert.ok(parentBodyLength(shell) < 40, '统计字数不含问候和结尾')
  assert.match(confirmBlockReason({ reader: 'parent', markdown: `${body}\n\n3. ${'很长的话。'.repeat(80)}`, unverified: [] }), /超过了 300 字/)
  assert.match(confirmBlockReason({ reader: 'parent', markdown: `# 标题\n\n${body}`, unverified: [{ kind: 'conflict' }] }), /矛盾/)
  assert.equal(confirmBlockReason({ reader: 'parent', markdown: `# 标题\n\n${body}`, unverified: [{ kind: 'unverified' }] }), null, '只是未核实：老师确认后可以用')
  assert.equal(confirmBlockReason({ reader: 'teacher', markdown: '# 标题', unverified: [{ kind: 'conflict' }] }), null, '其他版本不拦')
  assert.ok(PARENT_MIN_CHARS >= 20)
}
// ── 标记的取舍：家长版（核对后）去掉，其他版本保留（复制到微信与导出口径一致）──
{
  const md = '# 标题\n\n1. tomato 的复数加 -es〔未核实〕。\n2. 另一句。'
  assert.ok(!markdownToWechat(md).includes('〔'), '默认（家长版）去掉标记')
  assert.ok(markdownToWechat(md, { keepMarks: true }).includes('〔未核实〕'), '老师版 / 老板版 / 完整版保留标记')
}

// ── 家长版「我已核对」：每句「未核实」的话要么已删掉，要么在老师确认的列表里 ──
{
  const un = [{ sentence: 'a 句', kind: 'unverified' }, { sentence: 'b 句', kind: 'unverified' }, { sentence: 'c 矛盾', kind: 'conflict' }]
  assert.deepEqual(unacknowledgedSentences({ reader: 'parent', unverified: un }, []), ['a 句', 'b 句'], '矛盾的不在这里管（有矛盾本来就不能确认）')
  assert.deepEqual(unacknowledgedSentences({ reader: 'parent', unverified: un }, ['a 句']), ['b 句'])
  assert.deepEqual(unacknowledgedSentences({ reader: 'parent', unverified: un }, ['a 句', 'b 句']), [])
  assert.deepEqual(unacknowledgedSentences({ reader: 'parent', unverified: [] }, []), [], '没有未核实的句子：不用确认')
  assert.deepEqual(unacknowledgedSentences({ reader: 'teacher', unverified: un }, []), [], '其他版本不要求逐句确认')
  assert.deepEqual(unacknowledgedSentences({ reader: 'parent', unverified: un }, ['随便一句']), ['a 句', 'b 句'], '列表里不是清单里的句子不算数')
}

// ── R3 复制到微信：嵌套列表的小标题不编号，子项各自从 1 起（真实老板版的写法）──
{
  const boss = ['## 教研重点与课程卖点', '- **教研重点**：', ' - **名词复数**：两份卷子都考。', ' - **介词固定搭配**：重点记 time for。', '- **课程卖点**：', ' - 课程可以做小陷阱短练。', ' - 课程可以串起连词成句。', '', '## 风险提示', '- 样本只有 2 份。', '- 易错点是 AI 估计。'].join('\n')
  const w = markdownToWechat(boss)
  assert.ok(!/^1\. 教研重点/m.test(w) && /^教研重点：$/m.test(w) && /^课程卖点：$/m.test(w), w)
  assert.ok(/教研重点：\n\n1\. 名词复数：两份卷子都考。\n2\. 介词固定搭配/.test(w), w)
  assert.ok(/课程卖点：\n\n1\. 课程可以做小陷阱短练。\n2\. 课程可以串起连词成句。/.test(w), '子项重新从 1 编')
  assert.ok(/风险提示\n\n1\. 样本只有 2 份。\n2\. 易错点是 AI 估计。/.test(w), '没有嵌套的列表照常编号')
  assert.ok(markdownToWechat('1. 甲\n2. 乙', { spaced: true }).includes('1. 甲\n\n2. 乙'))
}


// ── 老板版：「还没核对」统一一行 / 分值最高的大类要有交代 ──
{
  const md = '# 标题\n\n> 基于 2 份卷子。\n\n## 三句话结论\n1. 先投名词复数、介词固定搭配、购物交际三块，其他先不动。\n2. 这三块两份卷子都考了。\n3. 还要补卷子。\n\n## 教研重点\n- 写作占三成。\n'
  const a = RP.setBossReviewLine(md, 2)
  assert.ok(a.includes('> 有 2 处说法还没经老师核对'))
  assert.ok(a.indexOf('还没经老师核对') < a.indexOf('## 教研重点') && a.indexOf('还没经老师核对') > a.indexOf('3. 还要补卷子'))
  assert.equal((RP.setBossReviewLine(a, 1).match(/还没经老师核对/g) || []).length, 1, '改数字不重复')
  assert.ok(RP.setBossReviewLine(a, 1).includes('有 1 处'))
  assert.equal(RP.setBossReviewLine(a, 0), md.replace(/\n+$/, '\n'), '清零就恢复原样')
  assert.ok(RP.hasBossReviewLine(a) && !RP.hasBossReviewLine(md))
  assert.deepEqual(RP.bossPicked(md), ['名词复数', '介词固定搭配', '购物交际'])
  assert.deepEqual(RP.bossPicked('## 三句话结论\n1. 基于 2 份卷子，建议优先投入名词复数、介词固定搭配两块，其他不动。'), ['名词复数', '介词固定搭配两块'], '换个说法也认得出；“两块”粘在名称后面由包含判断兜住')
  assert.equal(RP.topScoreGapWarning('## 三句话结论\n1. 建议优先投入写作与书面表达、名词复数两块，其他不动。\n2. 理由。', { name: '写作与书面表达', share: 0.3 }), null)
  // 写作占三成，三块里没有、三句话结论里也没提 → 提示（真实输出：写作只在教研重点里出现）
  const w = RP.topScoreGapWarning(md, { name: '写作与书面表达', share: 0.3 })
  assert.ok(w && /写作与书面表达/.test(w) && /30%/.test(w), String(w))
  // 结论里用半句话交代了 → 不提示
  const ok = md.replace('2. 这三块两份卷子都考了。', '2. 这三块两份卷子都考了；写作分值最高，但题型一样、AI 没估出集中易错点，先维持现有课程。')
  assert.equal(RP.topScoreGapWarning(ok, { name: '写作与书面表达', share: 0.3 }), null)
  // 它本身就在三块里 / 占比不大 / 没数据 → 不提示
  assert.equal(RP.topScoreGapWarning(md, { name: '名词复数', share: 0.3 }), null)
  assert.equal(RP.topScoreGapWarning(md, { name: '写作与书面表达', share: 0.08 }), null)
  assert.equal(RP.topScoreGapWarning(md, null), null)
}

console.log('report-post.test ✓')
