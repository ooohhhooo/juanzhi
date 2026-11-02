// 报告里的课程内容（纯函数，等报告分段改造合并后接入）：老师版课程小节、完整版课程对照表、话术 / 一句话建议的提示词输入、家长版 300 字门槛。
import assert from 'node:assert/strict'
import { buildTeacherCourseSection, buildFullCourseTable, buildAdviceInputs, buildHintInputs, courseRowsOf, lessonFullName, appendParentHint, COURSE_DISCLAIMER, PARENT_MAX_CHARS } from '../../src/main/course/report-section.ts'
import { finishAdvice, FORBIDDEN_RE } from '../../src/main/course/advice-post.ts'
import { fillTemplate } from '../../src/main/stats/p2.ts'
import fs from 'node:fs'

const L = (id, seq, title, confidence = 'high', extra = {}) => ({ lessonId: id, outlineName: '示例体系 A', levelName: '基础级', noLabel: String(seq), seq, title, textbookRef: '示例教材 三上 Unit 2', confidence, confirmed: false, ...extra })
const rows = [
  { code: 'GR.PAST', name: '一般过去时', papers: 3, paperTotal: 4, errorCount: 2, plain: '说过去发生的事', exampleEn: 'I played football yesterday.', exampleZh: '我昨天踢了足球。', lessons: [L(12, 5, 'Animals'), L(15, 8, 'Family', 'medium'), L(16, 9, 'Food'), L(17, 10, 'Toys', 'medium')] },
  { code: 'GR.COMP', name: '比较级', papers: 2, paperTotal: 4, errorCount: 0, lessons: [L(21, 2, 'Compare', 'medium')] },
  { code: 'RD.X', name: '没有对应课的', papers: 4, paperTotal: 4, errorCount: 9, lessons: [] }
]

{
  assert.equal(lessonFullName(L(12, 5, 'Animals')), '示例体系 A · 基础级 · 第 5 课《Animals》')
  const md = buildTeacherCourseSection(rows)
  assert.match(md, /^## 课程对照与选课建议/)
  assert.ok(md.includes(COURSE_DISCLAIMER))
  assert.match(md, /\*\*一般过去时\*\*（AI 估计易错题 2 道）：可以复习/)
  assert.ok(md.includes('示例体系 A · 基础级 · 第 5 课《Animals》；教材对标：示例教材 三上 Unit 2'))
  assert.ok(md.includes('第 8 课《Family》（可能）'), 'medium 带“可能”字样（靠文字不靠颜色）')
  assert.ok(!md.includes('Toys'), '每个考点最多列 3 课')
  assert.match(md, /另有 1 课也涉及/)
  assert.ok(!md.includes('没有对应课的'), '没有对应课的考点不出现')
  assert.ok(!md.includes('GR.PAST'), '内部代码不出现')
  assert.ok(!FORBIDDEN_RE.test(md.replace(COURSE_DISCLAIMER, '')), '程序拼的文字里没有价格 / 营销 / 夸大的词')
  assert.equal(buildTeacherCourseSection([rows[2]]), '', '没有任何对应就不出现这一节')
  assert.match(buildTeacherCourseSection(rows, { heading: '给家长看的课程' }), /^## 给家长看的课程/)
}
{
  const t = buildFullCourseTable(rows)
  const lines = t.split('\n')
  assert.ok(lines.includes('| 知识点 | 出现份数 | AI 估计易错题数 | 对应课程（最多 3 课） | 把握 |'))
  assert.ok(lines.some(l => l.startsWith('| 一般过去时 | 3/4 | 2 | 示例体系 A · 基础级 · 第 5 课《Animals》；') && l.endsWith('| 高、高、中 |')))
  assert.ok(lines.some(l => l.includes('另 1 课')))
  assert.ok(!t.includes('没有对应课的'))
  assert.equal(lines.filter(l => l.startsWith('| ') ).length, 3, '表头 + 2 行数据（分隔行以 |--- 开头）')
  // 表格里的竖线 / 换行不破坏表格
  const nasty = buildFullCourseTable([{ ...rows[0], name: 'a|b\nc', lessons: [L(1, 1, 'x|y')] }])
  assert.ok(nasty.split('\n').filter(l => l.startsWith('| a b c')).length === 1)
  assert.equal(buildFullCourseTable([]), '')
}
{
  const o = { scene: 'org', filterDesc: '全部 · 4 份', sampleWarning: '', evidenceText: '一般过去时 | 说过去的事 | I played. | —' }
  const a = buildAdviceInputs(rows, o)
  assert.deepEqual(a.used.map(r => r.code), ['GR.PAST', 'GR.COMP'], '易错题多的优先，没有对应课的不进')
  assert.match(a.placeholders.COURSE_MATCH, /^一般过去时 → \[课#12\] 示例体系 A · 基础级 · 第 5 课《Animals》；\[课#16\] /)
  assert.ok(!a.placeholders.COURSE_MATCH.includes('[课#15]'), '话术里每个考点最多放 2 课，高把握的优先')
  assert.equal(a.labels.get(12), '示例体系 A · 基础级 · 第 5 课《Animals》')
  assert.equal(a.labels.size, 3)
  assert.equal(a.placeholders.SAMPLE_WARNING, '无')
  assert.match(a.placeholders.LOST_POINTS, /^一般过去时 \| 说过去发生的事 \| I played football yesterday\. 我昨天踢了足球。/m)
  assert.match(a.placeholders.SCENE, /培训机构/)
  assert.match(buildAdviceInputs(rows, { ...o, scene: 'family' }).placeholders.SCENE, /家长自己用/)
  const h = buildHintInputs(rows, o)
  assert.equal(h.used.length, 1)
  // 占位符与两个提示词资源文件对得上，能被填满
  const read = f => fs.readFileSync(new URL(`../../src/main/ai/prompts/${f}`, import.meta.url), 'utf8')
  for (const id of ['p5_course_advice', 'p5_course_hint']) {
    const filled = fillTemplate(read(`${id}.user.txt`), a.placeholders)
    assert.ok(!filled.includes('{{'))
    assert.ok(filled.includes('[课#12]'))
  }
  // 整条链：提示词输入 → （假装 AI 写了）→ 收尾
  const fin = finishAdvice('这类试卷里常见的易错点是动词过去式，孩子在家可以每天说三句昨天做过的事，家长听一听动词有没有变形就行。如果想系统地复习，可以看看 [课#12]，也可以翻翻 [课#99]。', a.labels, { range: null, minChars: 20 })
  assert.equal(fin.ok, true)
  assert.equal(fin.unknownTokens, 1)
  assert.deepEqual(fin.usedLessonIds, [12])
}
{
  // 看板结果 → 报告用的行：低把握不进；老师确认过的按高算
  const dash = { rows: [{ code: 'A', name: 'A', papers: 1, paperTotal: 2, errorCount: 1, score: 0, tags: [], checked: true, maybe: [],
    main: [{ lessonId: 1, outlineName: 'O', levelName: 'L', noLabel: '1', seq: 1, title: 't', textbookRef: '', confidence: 'low', state: 'confirmed' }, { lessonId: 2, outlineName: 'O', levelName: 'L', noLabel: '2', seq: 2, title: 'u', textbookRef: '', confidence: 'medium', state: 'suggested' }] },
  { code: 'B', name: 'B', papers: 1, paperTotal: 2, errorCount: 0, score: 0, tags: [], checked: true, maybe: [{ lessonId: 3 }], main: [] }] }
  const r = courseRowsOf(dash, new Map([['A', { plain: '说明' }]]))
  assert.equal(r.length, 1)
  assert.deepEqual(r[0].lessons.map(l => [l.lessonId, l.confidence, l.confirmed]), [[1, 'high', true], [2, 'medium', false]])
  assert.equal(r[0].plain, '说明')
}
{
  const base = '短'.repeat(PARENT_MAX_CHARS - 20)
  assert.equal(appendParentHint(base, '可以复习第 5 课。').warning, null)
  assert.ok(appendParentHint(base, '可以复习第 5 课。').text.endsWith('可以复习第 5 课。'))
  const over = appendParentHint(base, '这是一句比较长的课程建议，会让整份家长版超过三百字的门槛。')
  assert.equal(over.text, base, '超过 300 字就不加')
  assert.equal(over.warning, '加上课程建议会超过 300 字，已省略')
  assert.equal(appendParentHint(base, '  ').text, base)
}

console.log('course-report-section.test ✓')
