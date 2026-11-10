// 全局拖放的导入汇总：按 importAuto 的返回拼提示。纯函数，期望值手写。
import assert from 'node:assert/strict'
import { summarizeAuto, hintOf, asDataSubject, dataSubjectName } from '../../src/renderer/subject/autoRoute.ts'

const r = {
  papers: [
    { file: 'a.pdf', paperId: '1', subject: 'math' }, { file: 'b.pdf', paperId: '2', subject: 'math' }, { file: 'c.pdf', paperId: '3', subject: 'math' },
    { file: 'd.pdf', paperId: '4', subject: 'english' },
    { file: 'e.pdf', code: 'duplicate', error: '内容相同', subject: 'english' },
    { file: 'f.pdf', error: '读不出', subject: 'english' }
  ],
  datasets: [{ file: 't.xlsx', id: 'x' }],
  documents: [{ file: 'n.docx', id: 'y', subject: 'general' }],
  notes: ['看起来是课程表，可到课程大纲导入']
}
const s = summarizeAuto(r, 'english')
assert.equal(s.text, '1 份英语卷、3 份数学卷进了试卷库；1 张表、1 份文档进了数据')
assert.deepEqual(s.others, [{ subject: 'math', count: 3 }])
assert.deepEqual(s.duplicates, ['e.pdf'])
assert.deepEqual(s.errors, ['f.pdf：读不出'], '重复不算错误')
assert.deepEqual(s.notes, ['看起来是课程表，可到课程大纲导入'])
assert.equal(s.empty, false)

const h = summarizeAuto({ papers: [{ file: 'a.pdf', paperId: '1', subject: 'english', hinted: 'math' }], datasets: [], documents: [], notes: [] }, 'english')
assert.equal(h.hinted, 1); assert.deepEqual(h.others, [])
assert.equal(summarizeAuto({ papers: [], datasets: [], documents: [], notes: [] }, 'math').empty, true)

assert.equal(hintOf({ subject_hint: 'math' }), 'math'); assert.equal(hintOf({ subject_hint: null }), null); assert.equal(hintOf({ subject_hint: 'x' }), null); assert.equal(hintOf({}), null)
assert.equal(asDataSubject(undefined), 'general'); assert.equal(asDataSubject('chinese'), 'chinese')
assert.equal(dataSubjectName('general'), '通用'); assert.equal(dataSubjectName('math'), '数学')
console.log('auto-route-summary ok')
