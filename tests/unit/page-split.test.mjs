// 单页写不完：加大上限后仍被截断时，把这一页拆成上下两半（图片按高度切、留约 8% 重叠；文字页按行对半），分别识别再合并。
import assert from 'node:assert/strict'
import { splitPageBatch, remapAnchor, ocrTextFor, batchInfoText, halveBatch, SPLIT_OVERLAP } from '../../src/main/parse/batch.ts'
import { newMergeState, mergeBatch } from '../../src/main/parse/merge.ts'

const rows = n => Array.from({ length: n }, (_, i) => ({ idx: i + 1, text: `行${i + 1}`, x: 0, y: i / n, w: 1, h: 0.01, parts: [], hasCoords: true }))
const input = (n, mode = 'text') => ({ idx: 2, mode, rows: rows(n), chars: n * 3, imageRel: 'p2.png' })

// 多页批次不在这里拆（走原来的对半拆页）；已经是半页的不再拆
assert.equal(splitPageBatch({ mode: 'text', pages: [1, 2] }, input(10)), null)
assert.ok(halveBatch({ mode: 'text', pages: [1, 2] }))
const [t1, t2] = splitPageBatch({ mode: 'text', pages: [2] }, input(40))
assert.equal(splitPageBatch(t1, input(40)), null, '半页不再拆第二次')

// 文字页：按行对半，两半有重叠，合起来覆盖全部行，行号不变
assert.equal(t1.part.kind, 'rows'); assert.equal(t1.part.from, 0)
assert.equal(t2.part.to, 40)
assert.ok(t1.part.to > 20 && t2.part.from < 20, '两半在中间重叠')
assert.ok(t1.part.to - t2.part.from >= 1 && (t1.part.to - t2.part.from) / 40 <= SPLIT_OVERLAP + 0.03, '重叠约 8%')
const up = ocrTextFor([input(40)], [2], t1.part)
const down = ocrTextFor([input(40)], [2], t2.part)
assert.ok(up.startsWith('[2-01]行1') && down.includes('[2-40]行40') && !up.includes('[2-40]'))
const all = new Set([...up.split('\n'), ...down.split('\n')])
assert.equal(all.size, 40, '合起来覆盖整页')
assert.equal(ocrTextFor([input(40)], [2]).split('\n').length, 40, '没有 part 时给整页')
// 太短的文字页拆不动
assert.equal(splitPageBatch({ mode: 'text', pages: [2] }, input(1)), null)

// 视觉页：按高度裁，约 8% 重叠；位置框从裁剪图换算回整页
const [v1, v2] = splitPageBatch({ mode: 'vision', pages: [2] }, input(5, 'vision'))
assert.equal(v1.part.y0, 0); assert.equal(v2.part.y1, 1)
assert.ok(Math.abs((v1.part.y1 - v2.part.y0) - SPLIT_OVERLAP) < 1e-9)
const a = remapAnchor([0.1, 0.5, 0.8, 0.1], v2.part)
assert.ok(Math.abs(a[1] - (v2.part.y0 + 0.5 * (1 - v2.part.y0))) < 1e-9 && a[0] === 0.1 && a[2] === 0.8)
assert.ok(a[3] < 0.1 && a[3] > 0.04, '高度按裁剪比例缩小')
assert.deepEqual(remapAnchor([0.1, 0.2, 0.3, 0.4], undefined), [0.1, 0.2, 0.3, 0.4])
assert.deepEqual(remapAnchor([0.1, 0.2, 0.3, 0.4], t1.part), [0.1, 0.2, 0.3, 0.4], '文字半页不换算')

// 给模型的批次说明里带「上半部分 / 下半部分」
assert.match(batchInfoText({ seq: 3, total: null, pages: [2], pageCount: 4, part: t1.part }), /上半部分/)
assert.match(batchInfoText({ seq: 3, total: null, pages: [2], pageCount: 4, part: v2.part }), /下半部分.*裁切/)
assert.doesNotMatch(batchInfoText({ seq: 1, total: 2, pages: [2], pageCount: 4 }), /上半|下半/)

// 合并：重叠处两半都识别到的题按（大题, 题号）去重；跨半页被切断的题按续写合并
const q = (no, stem, extra = {}) => ({ no, section: '一', stem, options: [], answer: '', score: 2, page: 2, anchor: '', anchor_ref: '', qtype: 'X', kp_main: '', kp_secondary: [], kp_suggestion: '', difficulty: 3, error_prone: false, error_reason: '', continued_from_prev: false, continues_next: false, flags: [], material_id: null, ...extra })
const out = questions => ({ meta: { title: null, grade: null, semester: null, school_year: null, exam_type: null, textbook: null, total_score: null }, sections: [{ no: '一', title: '选择', qtype: 'X', score_each: 2, total_score: null, continued_from_prev: false }], materials: [], questions, notes: [] })
{
  const st = newMergeState()
  mergeBatch(st, out([q('1', '第一题'), q('2', '第二题'), q('3', '第三题上半', { continues_next: true })]), { batch: 1, mode: 'text' })
  mergeBatch(st, out([q('2', '第二题'), q('3', '第三题完整', { continued_from_prev: true }), q('4', '第四题')]), { batch: 2, mode: 'text' })
  assert.deepEqual(st.questions.map(x => x.no), ['1', '2', '3', '4'], '重叠的第 2 题不重复')
  assert.equal(st.questions[2].stem, '第三题完整', '被切断的第 3 题用完整版')
}
// 同号但题干明显不同：不丢，改名保留并记 notes；同一题的两次识别（被切断 / 多几个字）仍去重
{
  const st = newMergeState()
  mergeBatch(st, out([q('5', 'The cat is sleeping on the sofa now.')]), { batch: 1, mode: 'text' })
  mergeBatch(st, out([q('5', 'The cat is sleeping on the sofa'), q('6', 'Tom 昨天去了哪里？')]), { batch: 2, mode: 'text' })
  assert.deepEqual(st.questions.map(x => x.no), ['5', '6'], '相似的算重复')
  mergeBatch(st, out([q('5', '我们班有四十五名学生，其中女生占五分之二。')]), { batch: 3, mode: 'text' })
  assert.deepEqual(st.questions.map(x => x.no), ['5', '6', '5-2'], '不同的题改名保留')
  assert.ok(st.notes.some(n => n.includes('5-2') && n.includes('核对')))
}
console.log('page-split.test ✓')
