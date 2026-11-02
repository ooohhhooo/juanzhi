// 报告分段的拼装（M9 §2.8–2.9）：各段按 placement 插进主文；失败 / 生成中的段留占位说明；跳过的段不占位；
// 主文结构不对（自定义提示词）时每一段仍然有地方放；以及程序拼的易错题集 / 口诀卡 / 变形题答题卡。
import assert from 'node:assert/strict'
import { CORE_PART_METAS, assembleReport, placeholderFor, splitSections } from '../../src/main/report/parts.ts'
import { buildErrorsSection, buildTricksSection, buildVariantsSection, hasOverclaim, inCard, parseJsonLoose } from '../../src/main/report/teacher-sections.ts'
import { parseBlocks } from '../../src/shared/markdown.ts'

const MAIN = ['# 四年级 考情分析报告（老师版）', '', '> 说明：难度与易错点为 AI 估计。', '', '## 做题方法', '### 1. 名词复数', '- **怎么审题**：先读题。', '', '## 学习进步建议', '1. 每天读一点。'].join('\n')
const parts = [
  { id: 'errors', status: 'ok', markdown: '## 易错题集（AI 估计）\n\n### 1. 名词复数' },
  { id: 'tricks', status: 'ok', markdown: '::: trick 口诀大招\n**一句话**：别马虎。\n:::' },
  { id: 'variants', status: 'ok', markdown: '## 3 道同类变形题\n\n::: answercard 答题卡\n1. q {blank: 1}\n:::' }
]
const heads = md => md.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3))

// ── 正常拼装：易错题集在说明之后、做题方法之前；口诀卡在做题方法末尾；变形题在学习进步建议之前 ──
const md = assembleReport(MAIN, parts, CORE_PART_METAS)
assert.deepEqual(heads(md), ['易错题集（AI 估计）', '做题方法', '3 道同类变形题', '学习进步建议'])
assert.ok(md.indexOf('> 说明') < md.indexOf('## 易错题集') && md.indexOf('## 易错题集') < md.indexOf('## 做题方法'))
assert.ok(md.indexOf('::: trick') > md.indexOf('先读题') && md.indexOf('::: trick') < md.indexOf('## 3 道同类变形题'), '口诀卡接在做题方法这一节的末尾')
assert.ok(md.startsWith('# 四年级'), '标题还在最前面')
assert.deepEqual(parseBlocks(md).filter(b => b.type === 'card').map(b => b.kind), ['trick', 'answercard'])
assert.equal(assembleReport(MAIN, parts, CORE_PART_METAS), md, '同样的输入拼出同样的结果')
assert.ok(!/\n{3,}/.test(md) && md.endsWith('\n'))

// ── 段的顺序按 order，不按传入顺序 ──
assert.equal(assembleReport(MAIN, [...parts].reverse(), CORE_PART_METAS), md)

// ── 失败 / 生成中：留占位说明，其余段照常 ──
const failed = assembleReport(MAIN, parts.map(p => (p.id === 'tricks' ? { ...p, status: 'failed' } : p)), CORE_PART_METAS)
assert.ok(failed.includes(placeholderFor('口诀大招', 'failed')) && failed.includes('点「重试这一部分」'))
assert.ok(!failed.includes('::: trick') && failed.includes('::: answercard'), '失败的段不影响别的段')
assert.ok(assembleReport(MAIN, parts.map(p => (p.id === 'variants' ? { ...p, status: 'running' } : p)), CORE_PART_METAS).includes('正在生成'))
// 跳过的段（比如没有易错点）不占位
const skipped = assembleReport(MAIN, parts.map(p => (p.id === 'tricks' ? { ...p, status: 'skipped' } : p)), CORE_PART_METAS)
assert.ok(!skipped.includes('口诀大招') && !skipped.includes('::: trick'))
// ok 但是内容为空（变形题还没有可用的题）也给占位，不留白
assert.ok(assembleReport(MAIN, parts.map(p => (p.id === 'tricks' ? { ...p, markdown: '  ' } : p)), CORE_PART_METAS).includes('没有生成'))
// 没登记的段（元数据里没有）忽略；将来登记的新段按自己的 placement / order 插入
assert.equal(assembleReport(MAIN, [{ id: 'unknown', status: 'ok', markdown: '## 不该出现' }], CORE_PART_METAS).includes('不该出现'), false)
const course = { id: 'course', label: '课程对照', placement: 'tail', order: 50, readers: ['teacher'], ai: true }
const withCourse = assembleReport(MAIN, [...parts, { id: 'course', status: 'ok', markdown: '## 课程对照与选课建议\n\n示例' }], [...CORE_PART_METAS, course])
assert.deepEqual(heads(withCourse), ['易错题集（AI 估计）', '做题方法', '3 道同类变形题', '学习进步建议', '课程对照与选课建议'], '后来接入的段（课程对照）排在文末')
assert.ok(assembleReport(MAIN, [{ id: 'course', status: 'failed', markdown: '' }], [course]).includes('「课程对照」这一部分没有生成'))

// ── 主文结构不对（用户自定义过 p3_teacher，没有“做题方法”“学习进步建议”）──
const OLD = ['# 标题', '> 说明', '', '## 易错点（按重要程度排序）', '### 1. 甲', '- **错在哪**：x', '', '## 备课建议', '1. 练。'].join('\n')
const old = assembleReport(OLD, parts, CORE_PART_METAS)
assert.deepEqual(heads(old), ['易错题集（AI 估计）', '易错点（按重要程度排序）', '3 道同类变形题', '备课建议'], '旧版“备课建议”也认；没有“做题方法”时口诀卡并入变形题之前')
assert.ok(old.includes('::: trick'))
const bare = assembleReport('# 标题\n\n只有一段话', parts, CORE_PART_METAS)
assert.ok(bare.includes('::: trick') && bare.includes('::: answercard') && bare.startsWith('# 标题'), '连小节都没有时，各段接在文末，一段都不丢')
assert.equal(splitSections('# t\n\n## a\nx\n\n```\n## 围栏里的不算\n```\n## b\ny').sections.length, 2)
assert.ok(assembleReport('', [], CORE_PART_METAS).trim() === '')

// ── 易错题集 + 易错知识点（程序拼） ──
const items = [
  { code: 'GR.NOUN.PLURAL', name: '名词复数', reasons: 'sheep 单复数同形', papers: '2/3', qtypes: ['单选题'], questions: [{ token: '[卷A · 3]', questionId: 'q1', qtypeName: '单选题' }, { token: '[卷B · 5]', questionId: 'q2', qtypeName: '单选题' }] },
  { code: 'X', name: '无题的考点', reasons: '', papers: '1/3', qtypes: [], questions: [] }
]
const kps = [{ code: 'GR.NOUN.PLURAL', name: '名词复数', plain: '一个以上用复数', example_en: 'Look at the sheep.', example_zh: '看那些羊。', hint_words: 'sheep / fish' }]
const err = buildErrorsSection(items, kps, { answerOf: id => (id === 'q1' ? 'B' : null) })
assert.deepEqual(heads(err), ['易错题集（AI 估计）', '易错知识点'])
assert.ok(err.includes('### 1. 名词复数') && err.includes('**易错原因（AI 估计）**：sheep 单复数同形'))
assert.ok(err.includes('**原卷例题**：[卷A · 3]；[卷B · 5]') && err.includes('**题型**：单选题'))
assert.ok(err.includes('卷A · 3 答案 B') && !err.includes('卷B · 5 答案'), '只有审核过的题才给参考答案')
assert.ok(err.includes('**白话**：一个以上用复数') && err.includes('**例句**：Look at the sheep. 看那些羊。') && err.includes('**例词**：sheep / fish') && err.includes('**出现**：2/3 份卷子'))
assert.ok(err.includes('AI 估计') && err.includes('不是学生的真实成绩'))
assert.ok(buildErrorsSection([], []).includes('没有 AI 估计的易错题'))

// ── 口诀卡：例句由程序取自证据；价格 / 夸大 / 引用 / 过长的口诀去掉 ──
const t = buildTricksSection(JSON.stringify({ tricks: [{ n: 1, trick: '看到数量，想想复数。' }, { n: 2, trick: '报名立减 50 元' }, { n: 3, trick: '越界序号' }, { n: 1, trick: '重复序号' }] }), items, kps)
assert.equal(t.cards, 1); assert.deepEqual(t.dropped, ['报名立减 50 元'])
assert.ok(t.markdown.includes('**一句话**：看到数量，想想复数。') && t.markdown.includes('**例**：Look at the sheep. 看那些羊。') && t.markdown.includes('**出自考点**：名词复数'))
assert.equal(buildTricksSection('不是 JSON', items, kps).cards, 0)
assert.equal(buildTricksSection('```json\n{"tricks":[{"n":2,"trick":"没有证据的考点也能写口诀。"}]}\n```', items, kps).markdown.includes('**例**'), false, '没有例句的考点不放“例”')
assert.ok(hasOverclaim('保证提高 20 分') && hasOverclaim('限时优惠') && hasOverclaim('100%') && !hasOverclaim('每天读一点英语'))
assert.deepEqual(parseJsonLoose('前言 {"a":1} 后话'), { a: 1 })

// ── 变形题 + 答题卡：只放老师勾过「我核对过」的题；答案和讲解在下面的教师用一节，不在卡里 ──
const row = (o) => ({ id: 'v' + o.seq, seq: 1, kp_code: 'GR.NOUN.PLURAL', qtype: 'choice', stem: 'Mia has two pens. These are my ____.', options: ['pen', 'pens', 'a pen', "pen's"], answer: 'B', explanation: '看数量。', changed: '', status: 'checked', teacher_ok: false, ...o })
const rows = [row({ seq: 1, teacher_ok: true }), row({ seq: 2, status: 'flagged', teacher_ok: false, stem: 'Ben ____ to school.', options: ['go', 'goes', 'going', 'gone'], answer: 'B' }), row({ seq: 3, qtype: 'blank', stem: 'Mum ____ (c) dinner.', options: [], answer: 'cooks', teacher_ok: true }), row({ seq: 4, status: 'dropped', teacher_ok: true })]
const name = c => (c === 'GR.NOUN.PLURAL' ? '名词复数' : '')
const v = buildVariantsSection(rows, name)
const card = parseBlocks(v).find(b => b.type === 'card')
assert.equal(card.items.length, 2, '勾了的 2 道进答题卡；没勾的、被程序剔除的不进（即使剔除的被标了 teacher_ok）')
assert.deepEqual(card.items.map(i => i.n), [1, 2], '答题卡里的题号重新从 1 排')
assert.deepEqual(card.items[0].answer, { type: 'choice', options: ['pen', 'pens', 'a pen', "pen's"] })
assert.deepEqual(card.items[1].answer, { type: 'blank', count: 1 })
const cardPart = v.slice(v.indexOf('::: answercard'), v.indexOf(':::\n') + 3)
assert.ok(!cardPart.includes('答案') && !cardPart.includes('看数量'), '答题卡里没有答案和讲解')
assert.ok(v.includes('### 参考答案与讲解（教师用）') && v.includes('1. **答案**：B。看数量。（考点：名词复数）') && v.includes('2. **答案**：cooks。'))
assert.ok(/另有 1 道变形题没有放进答题卡/.test(v), '没进卡的题数交代清楚')
assert.ok(buildVariantsSection(rows.slice(0, 2), name).startsWith('## 同类变形题'), '不是正好 3 道可用的题时标题不写“3 道”')
assert.ok(buildVariantsSection(rows.slice(0, 3), name).startsWith('## 3 道同类变形题'))
// 争议题勾了“仍然使用”：进卡，并在教师用的讲解里留痕
const flaggedUsed = buildVariantsSection([row({ seq: 1, status: 'flagged', teacher_ok: true })], name)
assert.ok(flaggedUsed.includes('第二次解答与出题答案不一致，老师确认后仍使用'))
// 一道都没勾：不放答题卡，说明还差几题
const none = buildVariantsSection([row({ seq: 1 }), row({ seq: 2 })], name)
assert.ok(!none.includes('::: answercard') && none.includes('2 道变形题都还没有核对'))
assert.ok(buildVariantsSection([], name).includes('没有可用的变形题'))
assert.ok(inCard({ status: 'checked', teacher_ok: true }) && !inCard({ status: 'checked', teacher_ok: false }) && !inCard({ status: 'dropped', teacher_ok: true }))
// 题干里的 { } | 不会弄坏卡片语法
const odd = buildVariantsSection([row({ seq: 1, teacher_ok: true, stem: 'Say {hello} | bye ____', options: ['a|b', 'c', 'd', 'e'] })], name)
assert.equal(parseBlocks(odd).find(b => b.type === 'card').items[0].answer.options.length, 4)

console.log('assemble.test ✓')
