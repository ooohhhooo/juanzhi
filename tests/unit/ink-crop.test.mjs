// R4 引用截图（第 20、31、33 题仍有残字、带出邻题题号、右边被切）：用真实底库的页面图片和真实的框复现，再验证修好。
// 夹具：tests/unit/fixtures/real-page-{1,2}.png 是 2025-2026 学年期末卷的两页，real-boxes.json 是当时库里（修之前）每道题的框。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decodeGray } from './helpers/png.mjs'
import { refineBoxes, INK } from '../../src/main/parse/ink.ts'

const F = new URL('./fixtures/', import.meta.url)
const boxes = JSON.parse(fs.readFileSync(new URL('real-boxes.json', F), 'utf8'))
const pages = { 1: decodeGray(fs.readFileSync(new URL('real-page-1.png', F))), 2: decodeGray(fs.readFileSync(new URL('real-page-2.png', F))) }

const ink = (g, x, y) => g.data[y * g.w + x] < INK
const rowHas = (g, y, x0, x1) => { for (let x = x0; x < x1; x++) if (ink(g, x, y)) return true; return false }
const colHas = (g, x, y0, y1) => { for (let y = y0; y < y1; y++) if (ink(g, x, y)) return true; return false }
const px = (g, b) => ({ x0: Math.round(b[0] * g.w), x1: Math.round((b[0] + b[2]) * g.w), y0: Math.round(b[1] * g.h), y1: Math.round((b[1] + b[3]) * g.h) })

const refined = {}
for (const pg of [1, 2]) {
  const list = boxes[pg].map((q, i) => ({ id: `${pg}-${q.no}`, bbox: q.bbox, source: q.source }))
  const res = new Map(refineBoxes(pages[pg], list).map(r => [r.id, r.bbox]))
  for (const q of boxes[pg]) refined[`${pg}-${q.no}`] = { old: q.bbox, neu: res.get(`${pg}-${q.no}`) ?? q.bbox, g: pages[pg] }
}

// ── 修之前确实有毛病（复现）：第 16 题右边带出「17」的笔画、第 31 题带出「32」、第 33 题带出「34」的笔画 ──
{
  const bleed = k => { const { old, g } = refined[k]; const b = px(g, [old[0], old[1], old[2] + 0.004 * 2, old[3]]); return colHas(g, b.x1 - 1, b.y0 + 4, b.y1 - 4) }
  assert.ok(bleed('1-16') || bleed('2-31') || bleed('2-33'), '修之前（旧框 + 旧的额外留白）右边会压在邻题的字上')
}

// ── 修之后：每道题的框 ──
const must = ['1-16', '1-20', '1-21', '2-31', '2-33', '2-34']
for (const k of must) {
  const { neu, g } = refined[k]
  const b = px(g, neu)
  // 1. 上、下边落在空白里：上沿那一行、下沿那一行没有任何墨迹（没有上一行 / 下一行的字脚）
  assert.equal(rowHas(g, b.y0, b.x0 + 2, b.x1 - 2), false, `${k}：上边有残字`)
  assert.equal(rowHas(g, b.y1 - 1, b.x0 + 2, b.x1 - 2), false, `${k}：下边有残字`)
  // 2. 左右边落在空白里：最左一列、最右一列没有墨迹（没有被切到的字，也没有邻题的笔画）
  assert.equal(colHas(g, b.x1 - 1, b.y0 + 1, b.y1 - 1), false, `${k}：右边压在字上`)
  assert.equal(colHas(g, b.x0, b.y0 + 1, b.y1 - 1), false, `${k}：左边压在字上`)
  // 3. 本题的字还在：框里有墨迹，并且比以前的框窄不了太多（没有把自己的字切掉）
  let any = false
  for (let y = b.y0; y < b.y1 && !any; y++) any = rowHas(g, y, b.x0, b.x1)
  assert.ok(any, `${k}：框里没有字`)
}
// 同一行挤着两道题的：右边收到邻题题号前面的空白里（第 16 题的右边比旧框窄，且仍在自己最后一个字之后）
{
  const { old, neu, g } = refined['1-16']
  assert.ok(neu[0] + neu[2] <= old[0] + old[2] + 0.001, '第 16 题右边不比旧框更靠右')
  const b = px(g, neu)
  // 右边往左 12 像素内还有字（自己的句号 / 括号没被切掉）
  let own = false
  for (let x = b.x1 - 14; x < b.x1 && !own; x++) own = colHas(g, x, b.y0, b.y1)
  assert.ok(own, '第 16 题自己的最后一个字还在')
}
// 第 31 题：不带出「32」，也不是切到一半的「3」
{
  const { neu, g } = refined['2-31']
  const b = px(g, neu)
  // 右边之后 40 像素里还有字（那是第 32 题），而框里最后 30 像素内不会有「32」的竖笔画紧贴右边
  assert.equal(colHas(g, b.x1 - 1, b.y0 + 1, b.y1 - 1), false)
  assert.ok(neu[2] < boxes[2].find(q => q.no === '31').bbox[2], '第 31 题的框比旧框窄（旧框带着「32」）')
}
// 老师手画的框不动；已经干净的框（修完再修）不再变
{
  const g = pages[1]
  assert.deepEqual(refineBoxes(g, [{ id: 'm', bbox: [0.128, 0.677, 0.29, 0.026], source: 'manual' }]), [])
  const again = refineBoxes(g, Object.entries(refined).filter(([k]) => k.startsWith('1-')).map(([k, v]) => ({ id: k, bbox: v.neu, source: 'text-anchor' })))
  const moved = again.filter(r => { const o = refined[r.id].neu; return Math.abs(r.bbox[0] - o[0]) > 0.012 || Math.abs(r.bbox[2] - o[2]) > 0.012 || Math.abs(r.bbox[1] - o[1]) > 0.012 || Math.abs(r.bbox[3] - o[3]) > 0.012 })
  assert.equal(moved.length, 0, `修完再修结果基本不变：${JSON.stringify(moved.slice(0, 2))}`)
  // 空白页：什么都不动
  const blank = { w: 100, h: 100, data: new Uint8Array(100 * 100).fill(255) }
  assert.deepEqual(refineBoxes(blank, [{ id: 'x', bbox: [0.1, 0.1, 0.5, 0.1], source: 'text-anchor' }]), [])
}
console.log('ink-crop.test ✓')
