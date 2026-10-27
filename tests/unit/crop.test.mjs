// B10：引用截图。真实复现：2025-2026 卷第 16 题的截图带出了「17」——同一行里挤着两道题
// （OCR 把 "16. Look at the ______ (sheep). 17. Those are ______ (tomato)." 当成一整行），旧算法的右边伸进了第 17 题的题号。
// 夹具：这一行的真实 OCR 坐标（页宽 1224 px）；从页面图量得「17」的第一笔在 x≈506 px，第 16 题最后一个字符「.」在 x≈495 px 结束。
import assert from 'node:assert/strict'
import { buildRows, charWidth, xAtOffset } from '../../src/main/parse/lines.ts'
import { locateAll } from '../../src/main/parse/locate.ts'
import { padBox, cropPixels, repairNeighborEdges, PAD_X, PAD_Y } from '../../src/shared/crop.ts'

const W = 1224, H = 1584
const LINE = { text: '16. Look at the ______ (sheep). 17. Those are ______ (tomato).', x: 0.1323529356617647, y: 0.6808711837515783, w: 0.5489924613142227, h: 0.01775568107836171 }
const rows = buildRows([LINE])
const pages = new Map([[1, { idx: 1, rows }]])
const q = (no, anchor) => ({ mode: 'text', no, section: '三', inst: 0, anchor, anchor_ref: '1-01', page: 1, qtype: 'FORM', stem: '', options: [], answer: '', score: 2, material_id: null, kp_main: '', kp_secondary: [], kp_suggestion: '', difficulty: 3, error_prone: false, error_reason: '', continued_from_prev: false, continues_next: false, flags: [] })
const res = locateAll([q('16', '16. Look at the'), q('17', '17. Those are')], [{ no: '三', title: 'x', qtype: 'FORM', score_each: 2, total_score: null, continued_from_prev: false, inst: 0 }], pages)

// 字符宽度：窄字符窄、宽字符宽、汉字两倍
assert.ok(charWidth('i') < charWidth('a') && charWidth('a') < charWidth('m') && charWidth('中') > charWidth('M'))
// 第 17 题的起点估计：真实在 506 px，误差要在一两个字符以内（旧算法按字符个数平均，约 +2 px 偏差；新算法按字宽）
const at17 = LINE.text.indexOf('17.')
assert.ok(Math.abs(xAtOffset(rows[0], at17) * W - 506) < 9, `第 17 题起点估计 ${xAtOffset(rows[0], at17) * W}`)

const [b16, b17] = res.map(r => r.bbox)
assert.ok(b16 && b17)
// 第 16 题裁出来的右边（加了留白之后）必须落在「第 16 题最后一个字符 495 px」和「17 的第一笔 506 px」之间的空隙里——不带出 17，也不切掉句号
const c16 = cropPixels(b16, W, H)
const right16 = c16.x + c16.width
assert.ok(right16 >= 495 && right16 < 506, `第 16 题截图右边 ${right16} px 应在 495–506 之间`)
// 第 17 题从自己的题号开始，不带上第 16 题的字
const c17 = cropPixels(b17, W, H)
assert.ok(c17.x >= 495 && c17.x <= 506, `第 17 题截图左边 ${c17.x} px`)
// 上下：框本身带着留白（locate 的 PAD + parse/ink.ts 按墨迹修准），裁切不再额外加——整行字都在里面，但不比框多
assert.ok(c16.y <= LINE.y * H && c16.y + c16.height >= (LINE.y + LINE.h) * H, '整行字都在截图里')

// ── 留白算法 ──
{
  const p = padBox([0.1, 0.5, 0.3, 0.02])
  assert.ok(Math.abs(p[0] - (0.1 - PAD_X)) < 1e-9 && Math.abs(p[1] - (0.5 - PAD_Y)) < 1e-9 && Math.abs(p[2] - (0.3 + 2 * PAD_X)) < 1e-9 && Math.abs(p[3] - (0.02 + 2 * PAD_Y)) < 1e-9)
  const edge = padBox([0, 0, 1, 1]); assert.deepEqual(edge, [0, 0, 1, 1], '贴边的框不越界')
  assert.equal(padBox(null), null); assert.equal(padBox([0.1, 0.1, 0, 0.1]), null); assert.equal(cropPixels([0.1, 0.1, 0.2, 0.1], 0, 0), null)
  const px = cropPixels([0.999, 0.999, 0.001, 0.001], 100, 100); assert.ok(px.x >= 0 && px.x + px.width <= 100 && px.width >= 1)
}

// ── 旧数据修复（迁移 v10 用）：库里已有的框，右边伸进右边紧挨着的下一题时缩回去；手工框、不同行、不同页的不动 ──
{
  const rs = [
    { id: 'a', page: 1, bbox: [0.128, 0.677, 0.291, 0.026], source: 'text-anchor' },   // 真实数据：第 16 题 [0.128,0.677,0.291,0.026]
    { id: 'b', page: 1, bbox: [0.412, 0.677, 0.274, 0.026], source: 'text-anchor' },   // 第 17 题
    { id: 'c', page: 1, bbox: [0.128, 0.70, 0.5, 0.026], source: 'text-anchor' },      // 下一行：不受影响
    { id: 'm', page: 1, bbox: [0.05, 0.677, 0.4, 0.026], source: 'manual' },           // 手工画的框不动
    { id: 'p', page: 2, bbox: [0.128, 0.677, 0.5, 0.026], source: 'text-anchor' }      // 别的页
  ]
  const fixed = repairNeighborEdges(rs)
  const a = fixed.find(f => f.id === 'a'); assert.ok(a)
  assert.ok(Math.abs(a.bbox[0] + a.bbox[2] - (0.412 - 0.008)) < 0.0011, `第 16 题右边缩到 ${a.bbox[0] + a.bbox[2]}`)
  const c = cropPixels(a.bbox, W, H); assert.ok(c.x + c.width >= 493 && c.x + c.width < 506, `修复后的真实数据（不再额外加留白，最后一个字的边缘由 ink.ts 按墨迹再修准）：右边 ${c.x + c.width} px`)
  assert.deepEqual(fixed.map(f => f.id), ['a'], '只修第 16 题（b 在最右、c 不同行、m 手工、p 不同页）')
  assert.deepEqual(repairNeighborEdges(fixed.map(f => ({ id: f.id, page: 1, bbox: f.bbox, source: 'text-anchor' }))), [], '幂等')
}
console.log('crop.test ✓')
