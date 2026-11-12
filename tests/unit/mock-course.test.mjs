// mock 的课程对照应答自检：用真实的提示词资源文件和生产代码的拼装函数造输入，mock 的回答必须能通过生产代码的校验；故障注入的各种坏回答要被程序拦住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readXlsx, buildXlsx } from '../../src/main/course/table-read.ts'
import { sampleSheets } from '../../src/main/course/template.ts'
import { sheetPreview, parseColsResponse } from '../../src/main/course/cols-ai.ts'
import { buildOutline } from '../../src/main/course/map.ts'
import { outlineLine, kpBatchBlock, parseLessonResponse, lessonSearchText } from '../../src/main/course/match.ts'
import { finishAdvice } from '../../src/main/course/advice-post.ts'
import { buildAdviceInputs } from '../../src/main/course/report-section.ts'
import { fillTemplate } from '../../src/main/stats/p2.ts'

const require = createRequire(import.meta.url)
const course = require('../mock-ai/course.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prompt = (id, part) => fs.readFileSync(path.join(root, 'src/main/ai/prompts', `${id}.${part}.txt`), 'utf8').replace(/\s+$/, '')

// 提示词能被 mock 认出来（也只认课程对照的四个）
for (const [id, kind] of [['p5_course_cols', 'cols'], ['p5_course_match', 'match'], ['p5_course_advice', 'advice'], ['p5_course_hint', 'hint']]) assert.equal(course.kindOf(prompt(id, 'system')), kind, id)
assert.equal(course.kindOf(prompt('p2_kp', 'system')), null)
assert.equal(course.kindOf(prompt('p3_parent', 'system')), null)

// ── 认列 ──
const read = await readXlsx(await buildXlsx(sampleSheets()))
const sheet = read.sheets[0]
const colsUser = fillTemplate(prompt('p5_course_cols', 'user'), { SHEET_NAME: sheet.name, SHEET_PREVIEW: sheetPreview(sheet) })
const colsOut = course.build('cols', colsUser)
const parsed = parseColsResponse(colsOut, sheet)
assert.equal(parsed.ok, true, parsed.problems.join(';'))
assert.equal(parsed.mapping.headerRows, 1)
assert.deepEqual(parsed.mapping.columns.map(c => c.field), ['seq', 'level', 'theme', 'title', 'phonics', 'word', 'pattern', 'expression', 'textbook_ref', 'skill', 'note'])
assert.equal(parseColsResponse(course.build('cols', colsUser, { colsBad: true }), sheet).ok, false)
assert.equal(parseColsResponse(course.build('cols', colsUser, { colsNoSeq: true }), sheet).ok, false)
const mappings = Object.fromEntries(read.sheets.map(s => [s.name, parseColsResponse(course.build('cols', fillTemplate(prompt('p5_course_cols', 'user'), { SHEET_NAME: s.name, SHEET_PREVIEW: sheetPreview(s) })), s).mapping]))
const outline = buildOutline(read.sheets, mappings)
assert.deepEqual(outline.levels.map(l => [l.name, l.lessons.length]), [['基础级', 5], ['进阶级', 5]])

// ── 匹配 ──
const lessons = outline.levels.flatMap((l, li) => l.lessons.map((x, i) => ({ id: 100 + li * 10 + i, levelName: l.name, seq: x.seq, noLabel: x.noLabel, title: x.title, theme: x.theme, textbookRef: x.textbookRef, points: x.points })))
const lessonMap = new Map(lessons.map(l => [l.id, { searchText: lessonSearchText(l) }]))
const kps = [
  { code: 'GR.TENSE.PAST', name: '一般过去时', plain: '', exampleEn: '', hintWords: 'played / watched' },
  { code: 'GR.ADJ.COMP', name: '比较级', plain: '', exampleEn: '', hintWords: 'taller' },
  { code: 'RD.X', name: '阅读推断', plain: '', exampleEn: '', hintWords: '' }
]
const blk = kpBatchBlock(kps)
const matchUser = fillTemplate(prompt('p5_course_match', 'user'), { OUTLINE_LINES: lessons.map(outlineLine).join('\n'), KP_BATCH: blk.text })
{
  const out = course.build('match', matchUser)
  const p = parseLessonResponse(out, { tokens: blk.tokens, lessons: lessonMap })
  const by = Object.fromEntries(p.entries.map(e => [e.lessonId, e]))
  assert.equal(p.dropped, 0)
  assert.deepEqual(by[112].maps.map(m => [m.code, m.confidence, m.quoteOk]), [['GR.TENSE.PAST', 'high', true]], '例词 played / watched 都在“第 3 课 Last weekend”里')
  assert.deepEqual(by[113].maps.map(m => m.code), ['GR.ADJ.COMP'])
  assert.ok(p.entries.every(e => e.maps.every(m => m.code !== 'RD.X')), '没有例词的考点谁也不挂')
  assert.ok(p.entries.every(e => e.maps.length <= 3), '每节课最多 3 个')
  // 故障：quote 不在课次里 → 降级；不存在的课次 → 丢弃；不是 JSON → 没有条目
  const q = parseLessonResponse(course.build('match', matchUser, { matchBadQuote: true }), { tokens: blk.tokens, lessons: lessonMap })
  assert.equal(q.entries.find(e => e.lessonId === 113).maps[0].confidence, 'low')
  const l = parseLessonResponse(course.build('match', matchUser, { matchBadLesson: true }), { tokens: blk.tokens, lessons: lessonMap })
  assert.ok(l.dropped >= 1)
  assert.equal(parseLessonResponse(course.build('match', matchUser, { matchBadJson: true }), { tokens: blk.tokens, lessons: lessonMap }).entries.length, 0)
  // 规则已经认出的考点不重复给
  const known = course.build('match', matchUser.replace(/(#112 [^\n]*)/, '$1 | 已认出:K1'))
  assert.ok(!parseLessonResponse(known, { tokens: blk.tokens, lessons: lessonMap }).entries.find(e => e.lessonId === 112)?.maps.length)
}

// ── 话术 ──
const L = (id, title) => ({ lessonId: id, outlineName: '示例体系 A', levelName: '进阶级', noLabel: '3', seq: 3, title, textbookRef: '', confidence: 'high', confirmed: false })
const rows = [{ code: 'GR.TENSE.PAST', name: '一般过去时', papers: 3, paperTotal: 4, errorCount: 2, lessons: [L(132, 'Last weekend'), L(133, 'Who is taller?')] }]
const inp = buildAdviceInputs(rows, { scene: 'org', filterDesc: '全部', sampleWarning: '', evidenceText: '（无）' })
const adviceUser = fillTemplate(prompt('p5_course_advice', 'user'), inp.placeholders)
{
  const ok = finishAdvice(course.build('advice', adviceUser), inp.labels)
  assert.equal(ok.ok, true, ok.failReason ?? '')
  assert.equal(ok.warnings.length, 0, ok.warnings.join(';'))
  assert.ok(ok.text.includes('示例体系 A · 进阶级 · 第 3 课《Last weekend》'))
  const price = finishAdvice(course.build('advice', adviceUser, { advicePrice: true }), inp.labels)
  assert.ok(!/优惠|99|保证/.test(price.text) && price.removedSentences >= 1)
  assert.equal(finishAdvice(course.build('advice', adviceUser, { adviceShort: true }), inp.labels).ok, false)
  assert.ok(finishAdvice(course.build('advice', adviceUser, { adviceLong: true }), inp.labels).warnings.some(w => /建议 150–200 字/.test(w)))
  assert.equal(finishAdvice(course.build('advice', adviceUser, { adviceBadToken: true }), inp.labels).unknownTokens, 1)
  const rule = finishAdvice(course.build('advice', adviceUser, { adviceRule: true }), inp.labels, { statements: ['time to + 动词原形'] })
  assert.ok(rule.text.length > 0)
}
{
  const hintUser = fillTemplate(prompt('p5_course_hint', 'user'), inp.placeholders)
  const h = finishAdvice(course.build('hint', hintUser), inp.labels, { range: null, minChars: 8 })
  assert.equal(h.ok, true)
  assert.ok(h.text.includes('示例体系 A'))
}

console.log('mock-course.test ✓')
