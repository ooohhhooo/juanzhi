// 报告里的课程对照三段（M9 §1.9）：谁在什么条件下跑、位置、家长版 300 字门槛、缓存键（有 / 没有选项）、课程指纹。全部是虚构的示例体系。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  COURSE_PART_METAS, COURSE_TEACHER_ID, COURSE_FULL_ID, COURSE_HINT_ID, ADVICE_HEADING,
  courseEnabled, courseOutlineIds, courseSkipReason, composeTeacherCourse, extractCourseAdvice, composeParentHint, cacheOptionsOf
} from '../../src/main/report/course-part-logic.ts'
import { CORE_PART_METAS, assembleReport } from '../../src/main/report/parts.ts'
import { courseSig } from '../../src/main/course/report-sig.ts'
import { cacheKeys } from '../../src/main/stats/p2.ts'

const L = (id, seq, title, confidence = 'high') => ({ lessonId: id, outlineName: '示例体系 A', levelName: '基础级', noLabel: String(seq), seq, title, textbookRef: '', confidence, confirmed: false })
const rows = [{ code: 'GR.PAST', name: '一般过去时', papers: 3, paperTotal: 4, errorCount: 2, lessons: [L(12, 5, 'Animals')] }]
const opts = (ids = ['o1'], extra = {}) => ({ course: { outlineIds: ids }, ...extra })

// ── enabled：没勾 / 空数组都不跑；老板版永远不跑；家长版要 parentHint
{
  for (const id of [COURSE_TEACHER_ID, COURSE_FULL_ID, COURSE_HINT_ID]) {
    assert.equal(courseEnabled(id, 'teacher', undefined), false)
    assert.equal(courseEnabled(id, 'teacher', {}), false)
    assert.equal(courseEnabled(id, 'teacher', opts([])), false)
    assert.equal(courseEnabled(id, 'boss', opts(['o1'], { parentHint: true })), false, '老板版不加')
  }
  assert.equal(courseEnabled(COURSE_TEACHER_ID, 'teacher', opts()), true)
  assert.equal(courseEnabled(COURSE_TEACHER_ID, 'full', opts()), false)
  assert.equal(courseEnabled(COURSE_FULL_ID, 'full', opts()), true)
  assert.equal(courseEnabled(COURSE_FULL_ID, 'parent', opts()), false)
  assert.equal(courseEnabled(COURSE_HINT_ID, 'parent', opts()), false, '家长版没有 parentHint 不加一句话')
  assert.equal(courseEnabled(COURSE_HINT_ID, 'parent', opts(['o1'], { parentHint: true })), true)
  assert.deepEqual(courseOutlineIds(opts(['b', 'a', 'a', ''])), ['b', 'a'])
}

// ── skip：停用 / 没匹配完 / 没有对应 / 没有可写的考点 各有白话原因；正常返回 null
{
  assert.match(courseSkipReason({ ready: true, outlineCount: 0, rows }), /停用或删除/)
  assert.match(courseSkipReason({ ready: false, outlineCount: 1, rows }), /还没有匹配完/)
  assert.match(courseSkipReason({ ready: true, outlineCount: 1, rows: [] }), /没有对应到高、中把握的课/)
  assert.match(courseSkipReason({ ready: true, outlineCount: 1, rows, eligible: 0 }), /写不出课程建议/)
  assert.equal(courseSkipReason({ ready: true, outlineCount: 1, rows, eligible: 2 }), null)
  assert.equal(courseSkipReason({ ready: true, outlineCount: 1, rows }), null)
}

// ── 老师版：课程列表 + 「可发给家长的话」；能取回那段话（不含 AI 草稿提示）
{
  const advice = '这类试卷里常见的易错点是一般过去时。孩子在家可以每天说三句昨天做过的事。'
  const md = composeTeacherCourse(rows, advice)
  assert.match(md, /^## 课程对照与选课建议/)
  assert.ok(md.includes(`### ${ADVICE_HEADING}`) && md.includes('示例体系 A · 基础级 · 第 5 课《Animals》'))
  assert.equal(extractCourseAdvice(`# 标题\n\n${md}\n\n## 学习进步建议\n\n别的`), advice)
  assert.equal(extractCourseAdvice('# 没有\n\n## 学习进步建议'), null)
  assert.equal(composeTeacherCourse([], advice), '', '没有对应课就没有这一节')
}

// ── 位置：老师版在「学习进步建议」之前；完整版 / 家长版在末尾；没有对应小节时并入末尾
{
  const meta = [...CORE_PART_METAS, ...COURSE_PART_METAS]
  assert.equal(COURSE_PART_METAS.find(m => m.id === COURSE_TEACHER_ID).placement, 'before_advice')
  assert.equal(COURSE_PART_METAS.find(m => m.id === COURSE_FULL_ID).placement, 'tail')
  const MAIN = '# 标题\n\n## 做题方法\n\n方法\n\n## 学习进步建议\n\n建议'
  const t = assembleReport(MAIN, [{ id: COURSE_TEACHER_ID, status: 'ok', markdown: '## 课程对照与选课建议\n\n列表' }], meta)
  assert.ok(t.indexOf('课程对照与选课建议') < t.indexOf('学习进步建议'))
  const f = assembleReport(MAIN, [{ id: COURSE_FULL_ID, status: 'ok', markdown: '## 课程对照\n\n表' }], meta)
  assert.ok(f.indexOf('学习进步建议') < f.indexOf('## 课程对照'))
  // 家长版一句话被丢弃（内容为空）：不留“没有生成”的占位；失败 / 中止的也不留（界面段列表里看得到）
  const hintMeta = COURSE_PART_METAS.find(m => m.id === COURSE_HINT_ID)
  assert.equal(hintMeta.omitWhenEmpty, true)
  const dropped = assembleReport('# 家长\n\n正文', [{ id: COURSE_HINT_ID, status: 'ok', markdown: '' }], meta)
  assert.ok(!dropped.includes('没有生成'))
  assert.ok(!assembleReport('# 家长\n\n正文', [{ id: COURSE_HINT_ID, status: 'failed', markdown: '' }], meta).includes('没有生成'))
}

// ── 家长版 300 字：够放就追加；超了丢弃并记告警；一句话太长也丢
{
  const measure = md => md.replace(/\s/g, '').length
  const main = '# 家长\n\n' + '字'.repeat(100)
  const ok = composeParentHint(main, '这类题常见易错，可以复习「示例体系 A · 基础级 · 第 5 课《Animals》」。', measure)
  assert.ok(ok.markdown.startsWith('这类题常见易错') && ok.warnings.length === 0)
  const big = '# 家长\n\n' + '字'.repeat(290)
  const drop = composeParentHint(big, '这类题常见易错，可以复习第五课。', measure)
  assert.equal(drop.markdown, '')
  assert.deepEqual(drop.warnings, ['加上课程建议会超过 300 字，已省略'])
  assert.equal(composeParentHint(main, '', measure).markdown, '')
  assert.equal(composeParentHint(main, '字'.repeat(70), measure).markdown, '', '远超 40 字丢弃')
  const soft = composeParentHint(main, '字'.repeat(45), measure)
  assert.ok(soft.markdown && /建议不超过 40 字/.test(soft.warnings[0]), '41–60 字保留但告警')
  // 用“复制到微信”的口径（含换行 / 序号）量：刚好差一点也要丢
  const strict = composeParentHint(main, '一句话建议。', md => measure(md) + 200)
  assert.equal(strict.markdown, '')
}

// ── 缓存键：没有选项时和旧键完全一致；有选项时不同；id 顺序不影响；指纹变了键就变
{
  const base = { kind: 'report', reader: 'teacher', filter: { a: 1 } }
  const k0 = cacheKeys(base, 'sys', 'user').cacheKey
  assert.deepEqual(cacheOptionsOf({}, 'sig'), {}, '没勾课程：选项原样')
  assert.deepEqual(cacheOptionsOf(opts([]), 'sig'), opts([]))
  const k = (o, sig) => cacheKeys({ ...base, options: cacheOptionsOf(o, sig) }, 'sys', 'user').cacheKey
  assert.notEqual(k(opts(['a']), 's1'), k0)
  assert.equal(k(opts(['b', 'a']), 's1'), k(opts(['a', 'b']), 's1'))
  assert.notEqual(k(opts(['a']), 's1'), k(opts(['a']), 's2'))
  assert.notEqual(k(opts(['a']), 's1'), k(opts(['a'], { parentHint: true }), 's1'))
}

// ── 课程指纹：体系 rev、对应的状态 / 把握任何一项变化都会变；没有体系为空串
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE course_outlines (id TEXT PRIMARY KEY, rev INTEGER, status TEXT, active INTEGER);
    CREATE TABLE course_kp_map (outline_id TEXT, kp_code TEXT, lesson_id INTEGER, confidence TEXT, state TEXT);
    INSERT INTO course_outlines VALUES ('o1', 1, 'active', 1);
    INSERT INTO course_kp_map VALUES ('o1', 'GR.PAST', 12, 'high', 'auto');`)
  const s0 = courseSig(db, ['o1'])
  assert.equal(courseSig(db, []), '')
  assert.equal(courseSig(db, ['o1', 'o1']), s0)
  db.exec("UPDATE course_kp_map SET state = 'confirmed'")
  const s1 = courseSig(db, ['o1'])
  assert.notEqual(s1, s0, '老师确认了一条对应')
  db.exec("UPDATE course_outlines SET rev = 2")
  const s2 = courseSig(db, ['o1'])
  assert.notEqual(s2, s1, '大纲内容更新')
  db.exec("UPDATE course_outlines SET active = 0")
  assert.notEqual(courseSig(db, ['o1']), s2, '停用')
  assert.match(courseSig(db, ['nope']), /missing/)
}

console.log('course-report-parts.test ok')
