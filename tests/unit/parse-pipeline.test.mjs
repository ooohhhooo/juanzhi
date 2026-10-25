// P1 解析流水线的纯函数单测：行重排、校验、跨批合并、批次、定位。直接加载 TS 源文件。
import assert from 'node:assert/strict'
import { normalizeText, buildRows, rowsFromPlainText, formatRows, squash, approxFind } from '../../src/main/parse/lines.ts'
import { TextOutputSchema, VisionOutputSchema, formatZodError, extractJson } from '../../src/main/parse/schema.ts'
import { normalizeKps, normalizeQtype, nearestAncestor, scoreConfidence, metaToPaperFields, pickPrefill, knownMetaText } from '../../src/main/parse/validate.ts'
import { newMergeState, mergeBatch, buildPrevContext } from '../../src/main/parse/merge.ts'
import { planBatches, halveBatch, fillTemplate, unknownPlaceholders, batchInfoText, pageListText } from '../../src/main/parse/batch.ts'
import { locateAll } from '../../src/main/parse/locate.ts'

// ───────── normalizeText / buildRows ─────────
assert.equal(normalizeText('2025-2026学年第⼆学期  四年级'), '2025-2026学年第二学期 四年级', '康熙部首归一，空白折叠')
assert.equal(normalizeText('⼀、选出画线部分读⾳不同的⼀项'), '一、选出画线部分读音不同的一项')
assert.equal(normalizeText('Is it?'), 'Is it?', '普通文本不变')

// 取自 g4-2025-page1.png 的真实 OCR：同一行被切成几段，且 [1-27] 顺序错乱（它属于第 10 题那一行）
const L = (text, x, y, w, h) => ({ text, x, y, w, h })
const ocr = [
  L('9. These', 0.132, 0.448, 0.078, 0.012), L('my pants. A. is B.am C. are', 0.278, 0.448, 0.251, 0.013),
  L('10. Can l wear my T-shirt today？ —No, you _', 0.132, 0.477, 0.401, 0.015),
  L('11. How much', 0.130, 0.503, 0.123, 0.015), L('this skirt? A. is B. are C. be', 0.321, 0.503, 0.249, 0.015),
  L('_. It\'s cold. A. can B. can\'t C. don\'t', 0.572, 0.474, 0.315, 0.016),   // 乱序到后面
  L('二、单项选择。', 0.115, 0.331, 0.126, 0.022), L('（每题2分，共20分）', 0.237, 0.333, 0.185, 0.018)
]
const rows = buildRows(ocr)
assert.deepEqual(rows.map(r => r.idx), [1, 2, 3, 4], '重排后行号连续')
assert.equal(rows[0].text, '二、单项选择。（每题2分，共20分）', '中文碎片直接相接')
assert.equal(rows[1].text, '9. These my pants. A. is B.am C. are')
assert.equal(rows[2].text, "10. Can l wear my T-shirt today？ —No, you _ _. It's cold. A. can B. can't C. don't", '乱序碎片被并回第 10 题那一行')
assert.equal(rows[3].text, '11. How much this skirt? A. is B. are C. be')
assert.ok(rows.every(r => r.hasCoords))
assert.ok(rows[2].parts.length === 2 && rows[2].parts[1].x === 0.572)
assert.equal(formatRows(1, rows).split('\n')[0], '[1-01]二、单项选择。（每题2分，共20分）')

const plain = rowsFromPlainText('How are you?\n\n[图1]\nWhat is this?')
assert.equal(plain.length, 3)
assert.ok(plain.every(r => !r.hasCoords))

// squash / approxFind
const sq = squash('10. Can  I wear')
assert.equal(sq.str, '10.cani wear'.replace(' ', ''))
assert.equal(approxFind('abcdefghij', 'cdexgh', 1)?.edits, 1)
assert.equal(approxFind('abcdefghij', 'zzzzzz', 1), null)

// ───────── schema ─────────
const goodQ = (over = {}) => ({
  no: '1', section: '一', qtype: 'PH_DIFF', material_id: null, stem: '', options: ['A. farm', 'B. car', 'C. warm'], answer: '', score: 2,
  kp_main: 'PH.PHONICS.COMBO', kp_secondary: [], kp_suggestion: '', difficulty: 3, error_prone: false, error_reason: '', page: 1,
  anchor: '1. A. farm', anchor_ref: '1-04', continued_from_prev: false, continues_next: false, flags: [], ...over
})
const out = { meta: { title: 't', grade: 4, semester: '下', school_year: '2025-2026', exam_type: '期末', textbook: null, total_score: 100 }, sections: [], materials: [], questions: [goodQ()], notes: [] }
assert.ok(TextOutputSchema.safeParse(out).success)
// 漏掉辅助字段给默认值；数字题号转字符串
const lenient = TextOutputSchema.parse({ questions: [{ no: 3, kp_main: 'X', difficulty: 2, page: 1, anchor: 'a b' }] })
assert.equal(lenient.questions[0].no, '3')
assert.deepEqual(lenient.questions[0].flags, [])
assert.deepEqual(lenient.sections, [])
// 不合格的几种
for (const [name, bad] of [
  ['questions 不是数组', { ...out, questions: 'x' }],
  ['缺难度', { ...out, questions: [{ ...goodQ(), difficulty: undefined }] }],
  ['难度越界', { ...out, questions: [{ ...goodQ(), difficulty: 9 }] }],
  ['页码为 0', { ...out, questions: [{ ...goodQ(), page: 0 }] }],
  ['缺 kp_main', { ...out, questions: [{ ...goodQ(), kp_main: undefined }] }],
  ['学期非法', { ...out, meta: { ...out.meta, semester: '春' } }]
]) {
  const r = TextOutputSchema.safeParse(bad)
  assert.equal(r.success, false, name)
  assert.ok(formatZodError(r.error).length > 0)
}
const err = TextOutputSchema.safeParse({ ...out, questions: [{ ...goodQ(), difficulty: 9 }] })
assert.match(formatZodError(err.error), /questions\[0\]\.difficulty/)
assert.match(formatZodError(err.error), /不能大于 5/)
assert.doesNotMatch(formatZodError(err.error), /Number must|Expected|Required|Invalid/, 'zod 的英文说明不外泄')
// 视觉版 anchor：四个 0–1 的数或 null
assert.ok(VisionOutputSchema.safeParse({ ...out, questions: [{ ...goodQ(), anchor: [0.1, 0.2, 0.5, 0.03], anchor_ref: undefined }] }).success)
assert.ok(VisionOutputSchema.safeParse({ ...out, questions: [{ ...goodQ(), anchor: null }] }).success)
assert.equal(VisionOutputSchema.safeParse({ ...out, questions: [{ ...goodQ(), anchor: [120, 300, 400, 20] }] }).success, false, '像素坐标不合格')
// extractJson
assert.equal(extractJson('```json\n{"a":1}\n```').ok, true)
assert.equal(extractJson('好的，结果如下：{"a":1} 以上').ok, true)
assert.equal(extractJson('{"a":').ok, false)

// ───────── 知识点 / 题型校验 ─────────
const kps = new Set(['GR.TENSE', 'GR.TENSE.PAST', 'GR.TENSE.PAST.IRREG', 'PH', 'PH.PHONICS'])
assert.equal(nearestAncestor('GR.TENSE.PAST.XYZ', kps), 'GR.TENSE.PAST')
assert.equal(nearestAncestor('ZZ.A.B', kps), null)
const k1 = normalizeKps({ kp_main: 'GR.TENSE.PAST.IRREG', kp_secondary: ['PH.PHONICS', 'PH.PHONICS', 'BAD.CODE'], kp_suggestion: '', flags: [] }, kps)
assert.equal(k1.kp_main, 'GR.TENSE.PAST.IRREG')
assert.deepEqual(k1.kp_secondary, ['PH.PHONICS'], '重复与不存在的次知识点被丢弃')
assert.equal(k1.kp_suggestion, '待归类：BAD.CODE', '不存在的代码变成待归类建议')
assert.ok(k1.flags.includes('kp_invalid'))
const k2 = normalizeKps({ kp_main: 'GR.TENSE.PAST.MADEUP', kp_secondary: [], kp_suggestion: '过去时的新用法', flags: ['kp_uncertain'] }, kps)
assert.equal(k2.kp_main, 'GR.TENSE.PAST', '编造的代码退到最近的真实祖先')
assert.equal(k2.kp_suggestion, '过去时的新用法', '模型给的建议优先保留')
const k3 = normalizeKps({ kp_main: 'NOPE', kp_secondary: [], kp_suggestion: '', flags: [] }, kps)
assert.equal(k3.kp_main, '')
assert.deepEqual(normalizeQtype('MC', new Set(['MC', 'OTHER'])), { qtype: 'MC', invalid: false })
assert.deepEqual(normalizeQtype('CHOICE', new Set(['MC', 'OTHER'])), { qtype: 'OTHER', invalid: true })
assert.ok(scoreConfidence([], { hasBbox: true, hasStem: true }) === 1)
assert.ok(scoreConfidence(['kp_uncertain', 'locate_failed'], { hasBbox: false, hasStem: true }) < 0.7)

// ───────── 元数据预填：只填用户留空的 ─────────
const guess = metaToPaperFields({ title: '2025-2026学年第二学期四年级英语期末试卷', grade: 4, semester: '下', school_year: '2025-2026', exam_type: '单元', textbook: '人教PEP', total_score: 100 })
assert.deepEqual(guess, { title: '2025-2026学年第二学期四年级英语期末试卷', grade: '4', semester: '下', school_year_start: 2025, exam_type: '单元测试', textbook: '人教PEP', total_score: 100 })
assert.equal(metaToPaperFields({ title: null, grade: 9, semester: null, school_year: '2025-2028', exam_type: '随堂', textbook: null, total_score: 99.5 }).grade, undefined)
assert.deepEqual(metaToPaperFields({ title: null, grade: null, semester: null, school_year: '2025-26', exam_type: null, textbook: null, total_score: null }), { school_year_start: 2025 })
const paper = { title: 'g4-2026', file_name: 'g4-2026.pdf', grade: null, semester: '上', school_year_start: null, exam_type: null, textbook: '我填的教材', total_score: null }
const pre = pickPrefill(paper, guess, [])
assert.equal(pre.fields.semester, undefined, '用户已填的学期不被覆盖')
assert.equal(pre.fields.textbook, undefined, '用户已填的教材不被覆盖')
assert.equal(pre.fields.grade, '4')
assert.equal(pre.fields.title, guess.title, '标题还是文件名生成的默认值时可以预填')
assert.ok(pre.aiFields.includes('grade') && !pre.aiFields.includes('semester'))
assert.equal(pickPrefill({ ...paper, title: '我改过的标题' }, guess, []).fields.title, undefined)
assert.equal(knownMetaText({ ...paper, grade: '4' }, []), '年级=4；学期=上；教材=我填的教材')
assert.equal(knownMetaText({ ...paper, grade: '4' }, ['grade']), '学期=上；教材=我填的教材', 'AI 填的字段不当作用户已填')
assert.equal(knownMetaText({ ...paper, semester: null, textbook: null }, []), '（无）')

// ───────── 批次 ─────────
const pg = (idx, mode, chars) => ({ idx, mode, rows: [], chars, imageRel: '' })
assert.deepEqual(planBatches([pg(1, 'text', 900), pg(2, 'text', 900)], { maxPages: 3, maxChars: 3000, maxVisionPages: 3 }), [{ mode: 'text', pages: [1, 2] }])
assert.deepEqual(planBatches([pg(1, 'text', 1800), pg(2, 'text', 1800), pg(3, 'text', 100)], { maxPages: 3, maxChars: 3000, maxVisionPages: 3 }).map(b => b.pages), [[1], [2, 3]], '字数上限切批')
assert.deepEqual(planBatches([1, 2, 3, 4, 5].map(i => pg(i, 'text', 10)), { maxPages: 2, maxChars: 3000, maxVisionPages: 3 }).map(b => b.pages), [[1, 2], [3, 4], [5]], '页数上限切批')
assert.deepEqual(planBatches([pg(1, 'text', 100), pg(2, 'vision', 0), pg(3, 'skip', 0), pg(4, 'text', 100)]).map(b => `${b.mode}:${b.pages}`), ['text:1', 'vision:2', 'text:4'], '模式变化切批，空白页跳过')
assert.deepEqual(halveBatch({ mode: 'text', pages: [1, 2, 3] }), [{ mode: 'text', pages: [1, 2] }, { mode: 'text', pages: [3] }])
assert.equal(halveBatch({ mode: 'text', pages: [1] }), null)
assert.equal(batchInfoText({ seq: 2, total: 3, pages: [4, 5, 6], pageCount: 9 }), '第 2/3 批，本批为试卷第 4–6 页（全卷共 9 页）')
assert.equal(batchInfoText({ seq: 1, total: 1, pages: [1], pageCount: 4 }), '第 1/1 批，本批为试卷第 1 页（全卷共 4 页）')
assert.match(batchInfoText({ seq: 5, total: null, pages: [2], pageCount: 4 }), /已拆小/)
assert.equal(pageListText([4, 5, 6]), '共 3 张图，依次为试卷第 4、第 5、第 6 页')
// 模板
assert.equal(fillTemplate('a {{X}} b {{X}} {{Y}} c$&', { X: '$1' }), 'a $1 b $1 {{Y}} c$&', '值里的 $ 不被当作替换语法，未知占位符原样保留')
assert.deepEqual(unknownPlaceholders('{{A}} {{B}} {{C}}', ['A']), ['B', 'C'])

// ───────── 跨批合并 + PREV_CONTEXT ─────────
const sec = (over = {}) => ({ no: '四', title: 'Read and choose', qtype: 'RD_MC', score_each: 2, total_score: 10, continued_from_prev: false, ...over })
const mq = (over = {}) => ({ ...goodQ(), section: '四', no: '18', qtype: 'RD_MC', stem: 'What does Tom like?', options: ['A. Apples.'], page: 3, anchor: '18. What does', anchor_ref: '3-41', continues_next: true, material_id: 'b1-m2', ...over })
const mat = (over = {}) => ({ id: 'b1-m2', section: '四', kind: 'passage', text: 'Tom goes to the park every', page: 3, continued_from_prev: false, continues_next: true, ...over })
const st = newMergeState()
assert.equal(buildPrevContext(st, 'text'), '（无，本批是第一批）')
mergeBatch(st, { meta: out.meta, sections: [sec()], materials: [mat()], questions: [goodQ({ section: '四', no: '17', stem: 'ok', continues_next: false }), mq()], notes: ['n1'] }, { batch: 1, mode: 'text' })
const prev = buildPrevContext(st, 'text')
assert.match(prev, /- 最后一个大题：no=四；title=Read and choose；qtype=RD_MC；score_each=2/)
assert.match(prev, /- 未完成的题：section=四；no=18；page=3；anchor="18\. What does"；anchor_ref="3-41"；已识别题干="What does Tom like\?"；已识别选项=\["A\. Apples\."\]/)
assert.match(prev, /- 未完成的材料：id=b1-m2；末尾文字="…Tom goes to the park every"/)
assert.match(buildPrevContext(st, 'vision'), /anchor="18\. What does"/)
// 第二批：续写——题目整条替换，材料追加，大题沿用
mergeBatch(st, {
  meta: { ...out.meta, title: '被忽略（已有）' },
  sections: [sec({ continued_from_prev: true })],
  materials: [mat({ text: 'day after school.', continued_from_prev: true, continues_next: false })],
  questions: [mq({ stem: 'What does Tom like?', options: ['A. Apples.', 'B. Pears.', 'C. Milk.'], continued_from_prev: true, continues_next: false, page: 4, anchor: 'XX', anchor_ref: '4-01' }),
    goodQ({ section: '四', no: '19', stem: 'next' })], notes: ['n1', 'n2']
}, { batch: 2, mode: 'text' })
assert.equal(st.questions.length, 3, '续写替换而不是新增')
const q18 = st.questions.find(q => q.no === '18')
assert.equal(q18.options.length, 3)
assert.equal(q18.page, 3, '页码沿用上一批')
assert.equal(q18.anchor, '18. What does', 'anchor 沿用上一批')
assert.equal(q18.continues_next, false)
assert.equal(st.sections.length, 1, '续写的大题不重复')
assert.equal(st.materials[0].text, 'Tom goes to the park every\nday after school.')
assert.equal(st.meta.title, 't', 'meta 以先出现的为准')
assert.deepEqual(st.notes, ['n1', 'n2'])
assert.match(buildPrevContext(st, 'text'), /^- 最后一个大题/, '没有未完成项时只剩大题那一行')
assert.doesNotMatch(buildPrevContext(st, 'text'), /未完成/)
// 后面批次里同序号的大题重新出现 → 新实例，题号 1 不算重复
const st2 = newMergeState()
mergeBatch(st2, { meta: out.meta, sections: [sec({ no: '一' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 1, mode: 'text' })
mergeBatch(st2, { meta: out.meta, sections: [sec({ no: '一', title: '笔试' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 2, mode: 'text' })
assert.equal(st2.questions.length, 2)
assert.deepEqual(st2.questions.map(q => q.inst), [0, 1])
// 同一大题同一题号非续写地重复 → 保留先出现的并留下说明
mergeBatch(st2, { meta: out.meta, sections: [], materials: [], questions: [goodQ({ section: '一', no: '1', stem: '重复' })], notes: [] }, { batch: 3, mode: 'text' })
assert.equal(st2.questions.length, 2)
assert.ok(st2.notes.some(n => /重复/.test(n)))

// ───────── 定位 ─────────
const R = (...a) => buildRows(a.map(([t, x, y, w]) => L(t, x, y, w, 0.018)))
const page1 = R(
  ['2025-2026学年第二学期四年级英语期末试卷', 0.24, 0.077, 0.5],
  ['一、选出画线部分读音不同的一项。（每题2分，共10分）', 0.114, 0.15, 0.48],
  ['1. A. farm B. car C. warm', 0.132, 0.18, 0.22],
  ['2. A. horse B. work C. fork', 0.132, 0.207, 0.24],
  ['二、单项选择。（每题2分，共20分）', 0.114, 0.33, 0.32],
  ['6. Is this the computer room? —Yes, ______. A. it is B. it isn\'t C. they are', 0.132, 0.362, 0.65],
  ['7. It\'s 7 o\'clock. It\'s time ______ breakfast. A. to B. for C. go', 0.132, 0.389, 0.54],
  ['三、用所给词的适当形式填空。（每题2分，共10分）', 0.114, 0.651, 0.44],
  ['16. Look at the ______ (sheep). 17. Those are ______ (tomato).', 0.132, 0.681, 0.55],
  ['18. My sister ______ (like) music. 19. I\'m ______ (old) than my brother.', 0.132, 0.709, 0.62]
)
const geoms = new Map([[1, { idx: 1, rows: page1 }]])
const sections = [
  { no: '一', title: '选出画线部分读音不同的一项', qtype: 'PH_DIFF', score_each: 2, total_score: 10, continued_from_prev: false, inst: 0 },
  { no: '二', title: '单项选择', qtype: 'MC', score_each: 2, total_score: 20, continued_from_prev: false, inst: 0 },
  { no: '三', title: '用所给词的适当形式填空', qtype: 'FORM', score_each: 2, total_score: 10, continued_from_prev: false, inst: 0 }
]
const tq = (no, section, anchor, ref, page = 1) => ({ ...goodQ({ no, section, anchor, anchor_ref: ref, page }), mode: 'text', batch: 1, inst: 0 })
const qs = [
  tq('1', '一', '1. A. farm', '1-03'), tq('2', '一', '2. A. horse B. work', '1-04'),
  tq('6', '二', '6. Is this the computer room?', '1-06'), tq('7', '二', "7. It's 7 o'clock", '1-07'),
  tq('16', '三', '16. Look at the', '1-09'), tq('17', '三', '17. Those are', '1-09'),
  tq('18', '三', '18. My sister', '1-10'), tq('19', '三', "19. I'm ______ (old)", '1-10')
]
const res = locateAll(qs, sections, geoms)
const near = (a, b, tol = 0.012) => Math.abs(a - b) <= tol
// 第 2 题：只到下一个大题标题之前（"二、单项选择" 那行不属于它）
assert.ok(res[1].bbox && near(res[1].bbox[1], 0.207 - 0.004) && near(res[1].bbox[1] + res[1].bbox[3], 0.207 + 0.018 + 0.004), `Q2 bbox ${res[1].bbox}`)
// 第 6 题：只含自己那一行
assert.ok(near(res[2].bbox[1], 0.362 - 0.004) && near(res[2].bbox[3], 0.018 + 0.008), `Q6 bbox ${res[2].bbox}`)
// 第 7 题：下一个大题标题之前，不吞掉 "三、…"
assert.ok(res[3].bbox[1] + res[3].bbox[3] < 0.651, `Q7 底部 ${res[3].bbox[1] + res[3].bbox[3]}`)
// 同一行两道题：16 取左半，17 取右半，互不重叠
assert.ok(res[4].bbox && res[5].bbox)
assert.ok(res[4].bbox[0] + res[4].bbox[2] <= res[5].bbox[0] + 0.01, `Q16 右边界 ${res[4].bbox[0] + res[4].bbox[2]} ≤ Q17 左边界 ${res[5].bbox[0]}`)
assert.ok(res[5].bbox[0] > 0.132 + 0.1, 'Q17 起点按字符比例折算到行中间')
assert.ok(near(res[4].bbox[1], 0.681 - 0.004) && near(res[5].bbox[1], 0.681 - 0.004))
assert.ok(res.every(r => r.page === 1 && r.source === 'text-anchor'))
// 末尾的题延伸到页面最后一行
assert.ok(near(res[7].bbox[1] + res[7].bbox[3], 0.709 + 0.018 + 0.004))
// anchor_ref 错了也能在页内搜到；anchor 有 OCR 错字时模糊匹配，并打上 locate_fuzzy
const wrongRef = locateAll([tq('7', '二', "7. It's 7 o'clock", '1-02')], sections, geoms)
assert.equal(wrongRef[0].source, 'text-anchor')
assert.ok(near(wrongRef[0].bbox[1], 0.389 - 0.004))
const fuzzy = locateAll([tq('6', '二', '6. Is this the cornputer room?', '1-06')], sections, geoms)
assert.equal(fuzzy[0].source, 'text-anchor')
assert.deepEqual(fuzzy[0].flags, ['locate_fuzzy'])
// 找不到 → 不造 bbox，打 locate_failed
const lost = locateAll([tq('9', '二', 'completely different text here', '1-06')], sections, geoms)
assert.equal(lost[0].bbox, null)
assert.deepEqual(lost[0].flags, ['locate_failed'])
// 全角/半角、空白差异不影响匹配
const fw = locateAll([tq('6', '二', '6.Is this the computer room?', '1-06')], sections, geoms)
assert.deepEqual(fw[0].flags, [])
// docx：没有坐标 → 能确定页码但没有 bbox
const docx = new Map([[1, { idx: 1, rows: rowsFromPlainText('How are you?\nWhat is this?') }]])
const dres = locateAll([tq('1', '一', 'What is this?', '1-02')], sections, docx)
assert.equal(dres[0].bbox, null)
assert.equal(dres[0].page, 1)
assert.deepEqual(dres[0].flags, [], '没有坐标的页面不算定位失败')
// 视觉版：向下延伸到下一题顶部；同行的下一题限制宽度
const vq = (no, anchor, page = 1) => ({ ...goodQ({ no, page, anchor }), anchor_ref: '', mode: 'vision', batch: 1, inst: 0 })
const vres = locateAll([vq('1', [0.12, 0.30, 0.7, 0.03]), vq('2', [0.12, 0.40, 0.7, 0.03]), vq('3', [0.12, 0.5, 0.3, 0.03]), vq('4', [0.55, 0.5, 0.3, 0.03]), vq('5', null)], sections, new Map())
assert.ok(near(vres[0].bbox[1], 0.30 - 0.004, 0.002) && near(vres[0].bbox[1] + vres[0].bbox[3], 0.40 - 0.004, 0.002), `视觉 Q1 ${vres[0].bbox}`)
assert.ok(vres[2].bbox[0] + vres[2].bbox[2] <= 0.55, '同行的下一题限制右边界')
assert.equal(vres[4].bbox, null)
assert.deepEqual(vres[4].flags, ['locate_failed'])
assert.equal(vres[0].source, 'vision')


// ───────── 审核 P1-4：模型漏设 continued_from_prev ─────────
{
  const s0 = newMergeState()
  mergeBatch(s0, { meta: out.meta, sections: [sec()], materials: [mat()], questions: [mq()], notes: [] }, { batch: 1, mode: 'text' })
  // 第 2 批：同键完整记录，但模型没设 continued_from_prev；大题、材料也没设
  mergeBatch(s0, {
    meta: out.meta, sections: [sec({ continued_from_prev: false })],
    materials: [mat({ text: 'day after school.', continued_from_prev: false, continues_next: false })],
    questions: [mq({ options: ['A. Apples.', 'B. Pears.'], continued_from_prev: false, continues_next: false, page: 4, anchor: 'XX', anchor_ref: '4-01' })], notes: []
  }, { batch: 2, mode: 'text' })
  assert.equal(s0.questions.length, 1, '漏设标记也要按续写合并，而不是丢掉完整的后半')
  assert.equal(s0.questions[0].options.length, 2, '保留的是完整记录，不是残缺的前半')
  assert.equal(s0.questions[0].continues_next, false)
  assert.equal(s0.questions[0].page, 3, '页码/anchor 仍沿用上一批')
  assert.equal(s0.sections.length, 1, '同序号、同标题的大题在下一批开头出现 → 同一个大题的续写')
  assert.equal(s0.materials[0].text, 'Tom goes to the park every\nday after school.', '材料同理追加')
  assert.ok(s0.notes.some(n => /没有标注续写/.test(n)), '兜底处理要留下说明供老师核对')
  // 但「完整的题在下一批又出现」仍是重复，不是续写
  const s1 = newMergeState()
  mergeBatch(s1, { meta: out.meta, sections: [sec()], materials: [], questions: [mq({ continues_next: false })], notes: [] }, { batch: 1, mode: 'text' })
  mergeBatch(s1, { meta: out.meta, sections: [], materials: [], questions: [mq({ continues_next: false, stem: '重复的' })], notes: [] }, { batch: 2, mode: 'text' })
  assert.equal(s1.questions[0].stem, 'What does Tom like?')
  assert.ok(s1.notes.some(n => /重复/.test(n)))
  // 同序号但标题不同的大题（听力「一」/笔试「一」）仍是新实例
  const s2 = newMergeState()
  mergeBatch(s2, { meta: out.meta, sections: [sec({ no: '一', title: 'Listen' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 1, mode: 'text' })
  mergeBatch(s2, { meta: out.meta, sections: [sec({ no: '一', title: 'Read' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 2, mode: 'text' })
  assert.equal(s2.questions.length, 2)
}

// ───────── 审核：定位游标被误判带偏后，后面的题不能全部失败 ─────────
{
  const rowsD = R(['1. alpha beta', 0.1, 0.1, 0.3], ['2. gamma delta', 0.1, 0.2, 0.3], ['3. epsilon zeta', 0.1, 0.3, 0.3], ['4. eta theta', 0.1, 0.4, 0.3])
  const g = new Map([[1, { idx: 1, rows: rowsD }]])
  // 第 2 题的 anchor 被模型写成了第 4 行的文字（误判），游标被带到最后；第 3 题的 anchor 在它前面，且没有 anchor_ref
  const qd = [tq('1', '一', '1. alpha beta', ''), tq('2', '一', '4. eta theta', ''), tq('3', '一', '3. epsilon zeta', '')]
  const rd = locateAll(qd, sections, g)
  assert.ok(rd[0].bbox && rd[1].bbox, '前两道照常定位')
  assert.ok(rd[2].bbox, '第 3 题的 anchor 在游标之前也要能找到（回退到从头搜索），不能连锁失败')
  assert.notDeepEqual(rd[2].flags, ['locate_failed'])
  assert.deepEqual(rd[2].flags, ['locate_rescan'], '回退搜索命中的位置要标出来（可能是同文的另一处），进「需关注」')
  assert.deepEqual(rd[0].flags, [], '正常定位的题不受影响')
}

// 复审 N3：两个大题序号相同、标题都没识别出来（空），不能被兜底逻辑误并成同一个大题
{
  const s3 = newMergeState()
  mergeBatch(s3, { meta: out.meta, sections: [sec({ no: '一', title: '' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 1, mode: 'text' })
  mergeBatch(s3, { meta: out.meta, sections: [sec({ no: '一', title: '' })], materials: [], questions: [goodQ({ section: '一', no: '1' })], notes: [] }, { batch: 2, mode: 'text' })
  assert.equal(s3.sections.length, 2, '标题都为空时不能靠「标题相同」判断续写，保持两个大题实例')
  assert.equal(s3.questions.length, 2)
}

console.log('parse-pipeline.test ✓')
