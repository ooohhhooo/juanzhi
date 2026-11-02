// M9 补充 3：Word 试卷渲染成页面图后，行的位置写进 lines_json，locate.ts 和图片 / PDF 走同一套定位。
// 这里测：分页（不从一行 / 一个表格行中间切开）、按页归一化、用 Word 的行定位每道题。直接加载 TS 源文件。
import assert from 'node:assert/strict'
import { paginate, A4_HEIGHT, A4_WIDTH, PAGE_MARGIN } from '../../src/main/pipeline/docx-paginate.ts'
import { buildRows } from '../../src/main/parse/lines.ts'
import { locateAll } from '../../src/main/parse/locate.ts'
import { decidePage } from '../../src/main/pipeline/ocr-quality.ts'

// ───────── 分页 ─────────
{
  // 40 行，每行 30px 高、间隔 40px：总高 1600，A4 页高 1123 → 两页
  const frags = Array.from({ length: 40 }, (_, i) => ({ text: `line ${i + 1}`, x: 64, y: 56 + i * 40, w: 200, h: 30 }))
  const m = { height: 56 + 39 * 40 + 30, frags, blocks: [] }
  const pages = paginate(m)
  assert.equal(pages.length, 2)
  assert.equal(pages[0].top, 0)
  // 分页线不穿过任何一行：每个片段完整落在某一页里
  const total = pages.reduce((s, p) => s + p.lines.length, 0)
  assert.equal(total, 40, '每一行恰好属于一页')
  for (const p of pages) for (const l of p.lines) assert.ok(l.y >= 0 && l.y + l.h <= 1.0001, `行没有跨出本页：y=${l.y} h=${l.h}`)
  assert.ok(pages[0].height <= A4_HEIGHT && pages[0].height > A4_HEIGHT * 0.8, `第一页高度合理：${pages[0].height}`)
  // 第二页的第一行是接着第一页的最后一行
  assert.equal(pages[1].lines[0].text, `line ${pages[0].lines.length + 1}`)
  // 归一化：宽按 794
  assert.ok(Math.abs(pages[0].lines[0].x - 64 / A4_WIDTH) < 1e-3)
}
{
  // 分页线正好穿过一行（y=1100..1130 跨过 1123）→ 提到这一行上边
  const frags = [{ text: 'a', x: 64, y: 100, w: 50, h: 20 }, { text: 'cut me', x: 64, y: 1100, w: 50, h: 30 }, { text: 'b', x: 64, y: 1200, w: 50, h: 20 }]
  const pages = paginate({ height: 1220, frags, blocks: [] })
  assert.equal(pages.length, 2)
  assert.ok(pages[0].height < 1100 + 1, '第一页在被穿过的那一行上方结束')
  assert.deepEqual(pages[0].lines.map(l => l.text), ['a'])
  assert.deepEqual(pages[1].lines.map(l => l.text), ['cut me', 'b'])
}
{
  // 表格行（block）也不能被切开：块 1050..1180 跨过分页线，里面有两段文字
  const frags = [{ text: 'row-a', x: 70, y: 1070, w: 50, h: 20 }, { text: 'row-b', x: 400, y: 1070, w: 50, h: 20 }, { text: 'x', x: 70, y: 100, w: 20, h: 20 }]
  const pages = paginate({ height: 1200, frags, blocks: [{ y: 1050, h: 130 }] })
  assert.equal(pages.length, 2)
  assert.deepEqual(pages[0].lines.map(l => l.text), ['x'])
  assert.deepEqual(pages[1].lines.map(l => l.text).sort(), ['row-a', 'row-b'])
}
{
  // 一页放得下：只有一页；空文档不崩
  assert.equal(paginate({ height: 500, frags: [{ text: 'hi', x: 64, y: 56, w: 20, h: 20 }], blocks: [] }).length, 1)
  assert.equal(paginate({ height: 0, frags: [], blocks: [] }).length, 1)
  assert.ok(PAGE_MARGIN > 0)
}

{
  // 图片占位是最后才加进片段表的：输出的行要按位置排回阅读顺序
  const frags = [{ text: 'before', x: 64, y: 100, w: 50, h: 20 }, { text: 'after', x: 64, y: 300, w: 50, h: 20 }, { text: '[图1]', x: 64, y: 200, w: 40, h: 18 }]
  assert.deepEqual(paginate({ height: 320, frags, blocks: [] })[0].lines.map(l => l.text), ['before', '[图1]', 'after'])
}

// ───────── 用 Word 的行定位每道题（和 tests/e2e/make-docx.cjs 生成的小试卷对应） ─────────
const F = (text, x, y, w = 0.2) => ({ text, x, y, w, h: 0.026, conf: 1 })
const lines = [
  F('小学四年级英语期末测试卷', 0.08, 0.072), F('一、单项选择（每题2分）', 0.08, 0.112),
  F("1. What's your name?", 0.116, 0.152), F('A. Tom B. Tom is C. I Tom', 0.08, 0.192),
  F('2. Is this a pen?', 0.116, 0.232), F('A. Yes, it is. B. Yes, this is. C. No, I am not.', 0.08, 0.272),
  F('3. How many apples are there?', 0.116, 0.312), F('A. Two apple B. Two apples C. Second apple', 0.08, 0.352),
  F('二、用所给词的适当形式填空（每题2分）', 0.08, 0.631),
  F('7. I', 0.08, 0.671, 0.034), F('________', 0.115, 0.671, 0.053), F(' (like) apples very much.', 0.168, 0.671, 0.22),
  F('8. Look at the', 0.08, 0.711, 0.135), F('________', 0.216, 0.711, 0.053), F(' (sheep) on the farm.', 0.269, 0.711, 0.19),
  F('三、补全对话（每题3分）', 0.08, 0.831),
  F('11. —How much is this dress?', 0.092, 0.877, 0.27), F('—It is fifty yuan.', 0.454, 0.877, 0.15),
  F('12. —What is the weather like today?', 0.092, 0.928, 0.34), F('—It is sunny and warm.', 0.454, 0.928, 0.21)
]
const rows = buildRows(lines)
assert.ok(rows.every(r => r.hasCoords), 'Word 的行有真实坐标（不再是 hasCoords=false 的纯文本行）')
// 碎片被并回一行
assert.ok(rows.some(r => r.text === '7. I ________ (like) apples very much.'), rows.map(r => r.text).join('|'))
const geoms = new Map([[1, { idx: 1, rows }]])
const sections = [
  { no: '一', title: '单项选择', qtype: 'MC', score_each: 2, total_score: 6, continued_from_prev: false, inst: 0 },
  { no: '二', title: '用所给词的适当形式填空', qtype: 'FORM', score_each: 2, total_score: 4, continued_from_prev: false, inst: 0 },
  { no: '三', title: '补全对话', qtype: 'DIALOG', score_each: 3, total_score: 6, continued_from_prev: false, inst: 0 }
]
const tq = (no, section, anchor) => ({ mode: 'text', batch: 1, inst: 0, no, section, anchor, anchor_ref: '', page: 1, stem: '', options: [], continues_next: false, continued_from_prev: false })
const qs = [
  tq('1', '一', "1. What's your name?"), tq('2', '一', '2. Is this a pen?'), tq('3', '一', '3. How many apples are there?'),
  tq('7', '二', '7. I'), tq('8', '二', '8. Look at the'),
  tq('11', '三', '11. —How much is this dress?'), tq('12', '三', '12. —What is the weather like today?')
]
const res = locateAll(qs, sections, geoms)
assert.ok(res.every(r => r.bbox), '7 道题都定位到了框：' + JSON.stringify(res.map(r => r.source)))
assert.ok(res.every(r => r.source === 'text-anchor'))
// 第 1 题的框含它的选项行，不含第 2 题；第 3 题只到下一个大题标题之前
assert.ok(res[0].bbox[1] < 0.152 && res[0].bbox[1] + res[0].bbox[3] > 0.192 + 0.02 && res[0].bbox[1] + res[0].bbox[3] < 0.232, `Q1 ${res[0].bbox}`)
assert.ok(res[2].bbox[1] + res[2].bbox[3] < 0.631, `Q3 不吞掉「二、…」标题：${res[2].bbox}`)
// 表格里的第 11、12 题：各自占自己的行
assert.ok(res[5].bbox[1] + res[5].bbox[3] <= res[6].bbox[1] + 0.01, 'Q11 在 Q12 之上')
assert.ok(res[5].bbox[2] > 0.3, '表格行的框含两个单元格的宽度')
// 没有任何坐标的 Word（渲染失败退回的纯文本）：定位不出来，不崩，也不给假框
const plainGeoms = new Map([[1, { idx: 1, rows: buildRows([]) }]])
assert.ok(locateAll(qs, sections, plainGeoms).every(r => r.bbox === null))

// 题号回退：模型给的开头里带着本机识别丢掉的填空横线，整段对不上时，认「行首就是本题题号」的那一行（标成模糊定位）
{
  const rr = buildRows([F('7. I like it.', 0.08, 0.1, 0.3), F('8.', 0.08, 0.2, 0.03), F('are these? They are carrots.', 0.12, 0.2, 0.4), F('9. These', 0.08, 0.3, 0.1), F('my pants.', 0.2, 0.3, 0.1)])
  const g = new Map([[1, { idx: 1, rows: rr }]])
  const r = locateAll([tq('7', '一', '7. I like it.'), tq('8', '一', '8. ______ are these?'), tq('9', '一', '9. These ______ my pants.')], [], g)
  assert.ok(r.every(x => x.bbox), '横线让整段对不上，也能靠题号找到：' + JSON.stringify(r.map(x => x.source)))
  assert.deepEqual(r.map(x => x.flags.includes('locate_fuzzy')), [false, true, true], '回退找到的标成模糊定位，让老师抽查')
  assert.ok(r[1].bbox[1] < 0.2 + 0.001 && r[1].bbox[1] + r[1].bbox[3] > 0.2, '8 题的框在第 8 题那一行')
  // 题号不在上一题之后的行（比如更靠前的同号行）不认
  const r2 = locateAll([tq('9', '一', '9. These ______ my pants.'), tq('8', '一', '8. ______ are these?')], [], g)
  assert.equal(r2[1].bbox, null, '游标之后找不到本题题号就老实说没找到，不往回找')
}

// Word 页的识别决定：直接用文字（不经过识别，也不因为 images_always 改走读图）
assert.equal(decidePage({ textSource: 'docx', hasImage: true, rowTexts: rows.map(r => r.text), lang: null, conf: null }, { policy: 'images_always', visionReady: true, expectsCjk: true }).mode, 'text')
console.log('docx-locate.test ✓')
