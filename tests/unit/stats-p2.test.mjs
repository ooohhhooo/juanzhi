// P2 输入构造、引用校验、缓存键、Markdown 解析的单测。数据集与 stats-core.test 的同比数据集相同，期望值手算。
import assert from 'node:assert/strict'
import { newDb, useTree, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import * as P from '../../src/main/stats/p2.ts'
import { paperScope } from '../../src/main/stats/filter.ts'
import { emptyReason } from '../../src/shared/emptyReason.ts'
import { stripUnknownCitations, splitCitations, makeToken, CITATION_RE } from '../../src/shared/citation.ts'
import { parseBlocks, parseInline, sectionFor, headingCodes } from '../../src/shared/markdown.ts'

const TREE = [
  ['A', null, '甲', 1], ['A.1', 'A', '甲一', 2], ['A.1.x', 'A.1', '甲一x', 3], ['A.2', 'A', '甲二', 2],
  ['B', null, '乙', 1], ['B.1', 'B', '乙一', 2], ['C', null, '丙', 1], ['D', null, '丁', 1], ['D.1', 'D', '丁一', 2], ['E', null, '戊', 1], ['E.1', 'E', '戊一', 2]
]
function cmpDb() {
  const { db } = newDb()
  useTree(db, TREE)
  const P_ = (year, kps, extra = {}) => addPaper(db, { year, title: `${year}-${kps.join('')}`, questions: kps.map(k => ({ kp: k, score: 2 })), ...extra })
  P_(2023, ['A.1', 'A.2', 'B.1'], { textbook: '人教PEP' }); P_(2023, ['A.1', 'B.1'], { textbook: '人教PEP' })
  P_(2024, ['A.2', 'E.1'], { textbook: '人教PEP' }); P_(2024, ['E.1'], { textbook: '人教PEP' }); P_(2024, ['E.1'], { textbook: '北师大版' })
  P_(2025, ['A.1.x', 'A.2', 'B.1']); P_(2025, ['A.1', 'B.1']); P_(2025, ['A.1'])
  P_(2025, ['D.1'], { textbook: '外研版' }); P_(2025, ['C'], { textbook: '外研版' })
  return db
}
const cols = line => line.split(' | ')

{
  const db = cmpDb()
  const cmp = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  const hot = S.hot(db, {}, 2, 15, paperScope({}, { in: [2025, 2023, 2024] }))
  const inp = P.buildP2Input(cmp, hot, {})
  const ph = inp.placeholders

  assert.equal(ph.FILTER_DESC, '全部年级 · 按二级知识点统计 · 学期范围：目标学年 上学期；基线已按学期对齐，只取 上学期', 'FILTER_DESC 写明学期范围')
  assert.equal(ph.TARGET_YEAR, '2025-2026学年'); assert.equal(ph.TARGET_PAPERS, '5')
  assert.equal(ph.BASE_YEARS, '2023-2024学年、2024-2025学年'); assert.equal(ph.BASE_PAPERS, '5')
  assert.equal(ph.TARGET_TEXTBOOKS, '人教PEP 3 份、外研版 2 份')
  assert.equal(ph.BASE_TEXTBOOKS, '人教PEP 4 份、北师大版 1 份')
  assert.equal(ph.SAMPLE_WARNING, '无', '两侧都是 5 份、同年级同类型 → 无警示')

  // ADDED：丁一，目标 1/5 份，1 题，分值占比 2/16 = 12.5%，样本题带 token
  const added = ph.ADDED.split('\n'); assert.equal(added.length, 1)
  const a = cols(added[0])
  assert.deepEqual(a.slice(0, 6), ['D.1', '丁一', '3', '1/5', '1', '12.5%'])
  assert.equal(a[6], '[2025-D.1 · 1]（单项选择：题干1）')

  // REMOVED：戊一，基线 3/5 份，3 题。y3 的标题是「2024-A.2E.1」（戊一是它第 2 题），y4、y5 同名「2024-E.1」→ token 自动区分
  const rm = cols(ph.REMOVED)
  assert.deepEqual(rm.slice(0, 5), ['E.1', '戊一', '3', '3/5', '3'])
  assert.equal(rm[5], '[2024-A.2E.1 · 2]（单项选择：题干2）；[2024-E.1 · 1]（单项选择：题干1）；[2024-E.1（2） · 1]（单项选择：题干1）')

  // CHANGED：甲一上升 +20.0、甲二下降 −20.0（恰好 20 个百分点），变化列带符号
  const ch = ph.CHANGED.split('\n').map(cols)
  assert.deepEqual(ch.map(c => c.slice(0, 6)), [['A.1', '甲一', '2/5', '3/5', '+20.0', '上升'], ['A.2', '甲二', '2/5', '1/5', '-20.0', '下降']])

  // HOT：跨年合并 10 份卷子里的二级知识点，按综合得分降序：甲一(0.5×10/34) > 乙一 > 甲二 = 戊一 > 丁一
  const hotRows = ph.HOT.split('\n').map(cols)
  assert.deepEqual(hotRows.map(r => r[0]), ['A.1', 'B.1', 'A.2', 'E.1', 'D.1'])
  assert.deepEqual(hotRows[0].slice(0, 6), ['A.1', '甲一', '5/10', '5', '0', '无'])
  assert.deepEqual(hotRows[3].slice(0, 3), ['E.1', '戊一', '3/10'])

  // 每个样本 token 都在索引里，且索引里没有多余的
  const used = new Set(); for (const k of ['ADDED', 'REMOVED', 'CHANGED', 'HOT']) for (const m of ph[k].matchAll(CITATION_RE)) used.add(m[0])
  assert.deepEqual([...used].sort(), inp.refs.map(r => r.token).sort())
  assert.ok(inp.refs.every(r => r.questionId && r.paperId))
  assert.deepEqual([...inp.codes].sort(), ['A.1', 'A.2', 'B.1', 'D.1', 'E.1'])
  assert.match(inp.fingerprint, /^[0-9a-f]{64}$/)
  // 同样的数据 → 同样的指纹
  const again = P.buildP2Input(S.compare(db, {}, 2025, { lt: 2025 }, 2), hot, {})
  assert.equal(again.fingerprint, inp.fingerprint)

  // 填模板：不留 {{，数字与表一致
  const user = P.fillTemplate('目标 {{TARGET_YEAR}}（{{TARGET_PAPERS}} 份）\n{{ADDED}}', ph)
  assert.ok(!user.includes('{{')); assert.match(user, /目标 2025-2026学年（5 份）\nD\.1 \| 丁一/)
  assert.throws(() => P.fillTemplate('{{NOPE}} {{ADDED}}', ph), /\{\{NOPE\}\}/, '提示词里有无法填充的占位符要报错，不能原样发给模型')

  // 数据变了 → 指纹变（改一道样本题的题干就够）
  db.prepare("UPDATE questions SET stem = '改过的题干' WHERE paper_id IN (SELECT id FROM papers WHERE title = '2025-D.1')").run()
  const changed = P.buildP2Input(S.compare(db, {}, 2025, { lt: 2025 }, 2), hot, {})
  assert.notEqual(changed.fingerprint, inp.fingerprint)
  assert.match(changed.placeholders.ADDED, /改过的题干/)
}

// 空数据：各表写「（无）」；样本偏小时给警示
{
  const { db } = newDb(); useTree(db, TREE)
  addPaper(db, { year: 2024, grade: '4', exam: '期末', questions: [{ kp: 'A.1' }] })
  addPaper(db, { year: 2025, grade: '5', exam: '期中', questions: [{ kp: 'A.1' }] })
  const cmp = S.compare(db, {}, 2025, { lt: 2025 }, 2)
  const inp = P.buildP2Input(cmp, S.hot(db, {}, 2, 15), { grade: '5', includeReviewing: true })
  assert.equal(inp.placeholders.ADDED, '（无）'); assert.equal(inp.placeholders.REMOVED, '（无）'); assert.equal(inp.placeholders.CHANGED, '（无）')
  assert.equal(inp.placeholders.SAMPLE_WARNING, '样本偏小：目标学年只有 1 份卷子，基线学年只有 1 份卷子（不足 5 份），出现率的变化可能只是一两份卷子的差别；两侧混入了不同年级的试卷，混入了不同考试类型的试卷，对比时请注意口径不一致；学期范围：目标学年 上学期；基线已按学期对齐，只取 上学期。', '样本说明里也写清学期范围')
  assert.equal(inp.placeholders.FILTER_DESC, '五年级 · 按二级知识点统计 · 含未确认的 AI 结果 · 学期范围：目标学年 上学期；基线已按学期对齐，只取 上学期')
}

// 学期不齐：不对齐时 SAMPLE_WARNING 与 FILTER_DESC 都写明；对齐时 FILTER_DESC 写明基线只取了哪些学期、另有几份没参与
{
  const { db } = newDb(); useTree(db, TREE)
  for (let i = 0; i < 5; i++) { addPaper(db, { year: 2024, semester: '上', questions: [{ kp: 'A.1' }] }); addPaper(db, { year: 2024, semester: '下', questions: [{ kp: 'B.1' }] }); addPaper(db, { year: 2025, semester: '上', questions: [{ kp: 'A.1' }] }) }
  const off = P.buildP2Input(S.compare(db, {}, 2025, { lt: 2025 }, 2, 3, false), S.hot(db, {}, 2, 15), {})
  assert.match(off.placeholders.SAMPLE_WARNING, /两侧学期构成不一致（目标学年有：上学期；基线有：上学期、下学期）/)
  assert.match(off.placeholders.FILTER_DESC, /学期范围：目标学年 上学期；基线未按学期对齐，含 上学期、下学期/)
  const on = P.buildP2Input(S.compare(db, {}, 2025, { lt: 2025 }, 2), S.hot(db, {}, 2, 15), {})
  assert.equal(on.placeholders.SAMPLE_WARNING, '无')
  assert.match(on.placeholders.FILTER_DESC, /基线已按学期对齐，只取 上学期（另有 5 份其他学期的基线卷子未参与比较）/)
  assert.notEqual(on.fingerprint, off.fingerprint, '对齐与否是不同的输入 → 不同的数据指纹')
}

// token：同一份卷子里题号重复（听力一 / 笔试一 各有第 1 题）要区分；标题里的 [ ] · | 不能破坏格式
{
  const reg = new P.TokenRegistry()
  const q = (id, no, section, ord, title = '卷') => ({ id, paper_id: 'p-' + title, paperTitle: title, no, section, ord, qtype: 'MC', qtypeName: '单选', stem: 's', options: [], page_idx: 1, pageRel: 'page-1.png', pageW: 100, pageH: 100, bbox: null })
  assert.equal(reg.tokenFor(q('1', '1', '一', 1)), '[卷 · 1]')
  assert.equal(reg.tokenFor(q('1', '1', '一', 1)), '[卷 · 1]', '同一道题始终是同一个 token')
  assert.equal(reg.tokenFor(q('2', '1', '二', 7)), '[卷 · 二1]')
  assert.equal(reg.tokenFor(q('3', '1', '二', 9)), '[卷 · 二1#9]')
  assert.equal(reg.tokenFor(q('4', '1', '一', 1, '甲[乙]·丙|丁')), '[甲 乙 丙 丁 · 1]')
  assert.equal(makeToken('', ''), '[未命名试卷 · ?]')
  assert.equal(reg.refs.size, 4)
}

// 引用校验：模型自造 / 改写的引用被移除；合法的保留；普通方括号文字不受影响
{
  const known = new Set(['[2025卷 · 3]', '[2024卷 · 二5]'])
  const md = '见 [2025卷 · 3]，另见 [不存在的卷 · 9] 和 [2025卷 · 4]，还有 [2024卷 · 二5]；数组 [1, 2] 与 [注] 不是引用。'
  const r = stripUnknownCitations(md, known)
  assert.deepEqual(r.removed, ['[不存在的卷 · 9]', '[2025卷 · 4]'])
  assert.equal(r.text, '见 [2025卷 · 3]，另见  和 ，还有 [2024卷 · 二5]；数组 [1, 2] 与 [注] 不是引用。')
  assert.deepEqual(splitCitations('a[x · 1]b').map(p => p.type), ['text', 'cite', 'text'])
}

// 缓存键：范围 + 实际发给模型的提示词文本（审核 P1-5、P1-6）
{
  const scope = { filter: P.normalizeFilter({ grade: '4', includeReviewing: false }), target: 2025, base: { lt: 2025 }, level: 2, align: true }
  assert.deepEqual(P.normalizeFilter({ includeReviewing: false, includeDuplicates: false }), {}, 'false 开关等于没写，避免同一筛选命中不了缓存')
  assert.deepEqual(Object.keys(P.normalizeFilter({ region: 'r', grade: '4' })), ['grade', 'region'])
  const SYS = '系统提示词', USER = '填好数据的用户提示词'
  const k0 = P.cacheKeys(scope, SYS, USER)
  assert.deepEqual(P.cacheKeys(JSON.parse(JSON.stringify(scope)), SYS, USER), k0)
  // 实际发出去的文本任何一个字变了 → 缓存键变、范围键不变（据此显示「已过期」而不是「没有」）；不依赖任何人工维护的版本号
  for (const [name, sys, user] of [['system 变一个字', SYS + '。', USER], ['user（数据）变一个字', SYS, USER.replace('数据', '数椐')], ['两者都变', SYS + '。', USER + '。']]) {
    const k = P.cacheKeys(scope, sys, user)
    assert.equal(k.scopeKey, k0.scopeKey, name); assert.notEqual(k.cacheKey, k0.cacheKey, name)
  }
  // 范围：目标 / 基线 / 层级 / 筛选 / 是否按学期对齐 任一变了都是另一个范围
  for (const other of [{ ...scope, target: 2024 }, { ...scope, base: { eq: 2024 } }, { ...scope, level: 3 }, { ...scope, filter: { grade: '5' } }, { ...scope, align: false }])
    assert.notEqual(P.cacheKeys(other, SYS, USER).scopeKey, k0.scopeKey)
  // 模板签名：只看模板（未填数据），数据变了它不变，提示词变了它变——用来区分过期原因
  assert.equal(P.templateSig(SYS, 'T'), P.templateSig(SYS, 'T')); assert.notEqual(P.templateSig(SYS, 'T'), P.templateSig(SYS, 'T2')); assert.notEqual(P.templateSig(SYS, 'T'), P.templateSig(SYS + '。', 'T'))
}

// Markdown
{
  const md = `> 样本偏小，仅供参考。\n\n## 一、总体变化\n新增 **2 个**知识点，见 [卷 · 3]。\n\n## 二、新增知识点\n### GR.TENSE.FUT｜一般将来时\n- **数据**：3/5 份\n- **教学建议**：练习\n  续行内容\n\n### VO.X|另一个\n1. 第一条\n2. 第二条\n\n## 三、其它\n---\n<script>alert(1)</script>`
  const b = parseBlocks(md)
  assert.deepEqual(b.map(x => x.type), ['quote', 'heading', 'p', 'heading', 'heading', 'ul', 'heading', 'ol', 'heading', 'hr', 'p'])
  assert.deepEqual(b[2].inline.map(i => i.type), ['text', 'bold', 'text', 'cite', 'text'])
  assert.equal(b[5].items.length, 2); assert.equal(b[5].items[1].map(i => i.text ?? i.token).join(''), '教学建议：练习 续行内容')
  assert.equal(b[10].inline[0].text, '<script>alert(1)</script>', '不解析 HTML：作为纯文字交给 React 渲染')
  assert.deepEqual(headingCodes(md), ['GR.TENSE.FUT', 'VO.X'])
  assert.equal(sectionFor(md, 'GR.TENSE.FUT'), '### GR.TENSE.FUT｜一般将来时\n- **数据**：3/5 份\n- **教学建议**：练习\n  续行内容')
  assert.equal(sectionFor(md, 'NOPE'), null)
  // 模型把代码写成 `CODE` 或 **CODE** 时仍能找到小节、校验代码
  const md2 = '### `GR.A`｜甲\n- x\n\n### **GR.B**｜乙\n- y'
  assert.deepEqual(headingCodes(md2), ['GR.A', 'GR.B']); assert.equal(sectionFor(md2, 'GR.A'), '### `GR.A`｜甲\n- x'); assert.equal(sectionFor(md2, 'GR.B'), '### **GR.B**｜乙\n- y')
  assert.deepEqual(parseInline('a **b** c'), [{ type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' c' }])
}

// 缓存核对结论能不能复用：修订号与模板签名都没变才能（复审 P1-A 的「复用」逻辑做成了纯函数，可单测）
{
  const row = { checked_rev: 5, checked_sig: 'S', checked_json: JSON.stringify({ fresh: true, reasons: [], promptError: null, empty: false }) }
  assert.deepEqual(P.reusableCheck(row, 5, 'S'), { fresh: true, reasons: [], promptError: null, empty: false })
  assert.equal(P.reusableCheck(row, 6, 'S'), null, '修订号变了要重新核对')
  assert.equal(P.reusableCheck(row, 5, 'S2'), null, '提示词模板签名变了要重新核对')
  assert.equal(P.reusableCheck({ checked_rev: null, checked_sig: null, checked_json: null }, 0, 'S'), null, '从没核对过要核对')
  assert.equal(P.reusableCheck({ ...row, checked_json: '{坏的' }, 5, 'S'), null, '记录损坏要重新核对，不能抛错')
}

// 同比「没法比」的说明：对齐把基线排光了时要告诉老师去关掉对齐（复审 P2-N3）
{
  const base = { targetLabel: '2025-2026学年', baseLabel: '2025-2026学年之前的全部学年', targetPapers: 5, basePapers: 0, alignOn: true, dropped: 5, targetSemesters: '上学期', where: 'compare' }
  assert.equal(emptyReason({ ...base, basePapers: 3 }), null)
  assert.match(emptyReason(base), /有 5 份卷子，但它们的学期与目标学年（只有上学期的卷子）不一致，按学期对齐时被排除了/)
  assert.match(emptyReason(base), /关掉上面的「按学期对齐」/)
  assert.match(emptyReason({ ...base, where: 'overview' }), /到「分析看板 → 同比」页关掉「按学期对齐」/)
  assert.equal(emptyReason({ ...base, dropped: 0 }), '基线（2025-2026学年之前的全部学年）没有计入统计的试卷', '真的没有试卷时才说没有')
  assert.equal(emptyReason({ ...base, dropped: 0, where: 'overview' }), '没有更早学年的试卷可比')
  assert.equal(emptyReason({ ...base, alignOn: false, dropped: 0 }), '基线（2025-2026学年之前的全部学年）没有计入统计的试卷', '没开对齐时不提对齐')
  assert.equal(emptyReason({ ...base, targetPapers: 0 }), '2025-2026学年没有计入统计的试卷')
}

console.log('stats-p2.test ✓')
