// treemap 布局：面积与值成正比、格子互不重叠、不越界、顺序稳定
import assert from 'node:assert/strict'
import { squarify } from '../../src/shared/treemap.ts'

const area = r => r.w * r.h
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-9 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-9

for (const aspect of [1, 2, 0.5, 1.6]) {
  const items = [{ id: 'a', value: 6 }, { id: 'b', value: 6 }, { id: 'c', value: 4 }, { id: 'd', value: 3 }, { id: 'e', value: 2 }, { id: 'f', value: 2 }, { id: 'g', value: 1 }]
  const rects = squarify(items, aspect)
  assert.equal(rects.length, 7)
  const total = 24
  for (const r of rects) {
    const v = items.find(i => i.id === r.id).value
    assert.ok(Math.abs(area(r) - v / total) < 1e-9, `${r.id} 面积应为 ${v}/24（aspect ${aspect}）`)
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, '不越界')
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]), `${rects[i].id} 与 ${rects[j].id} 重叠`)
  assert.ok(Math.abs(rects.reduce((s, r) => s + area(r), 0) - 1) < 1e-9, '铺满')
}
assert.deepEqual(squarify([{ id: 'x', value: 5 }]), [{ id: 'x', x: 0, y: 0, w: 1, h: 1 }])
assert.deepEqual(squarify([]), [])
assert.deepEqual(squarify([{ id: 'z', value: 0 }, { id: 'n', value: -1 }]), [], '零值与负值不出格子')
assert.equal(squarify([{ id: 'z', value: 0 }, { id: 'y', value: 2 }]).length, 1)
// 相同输入顺序无关（值相同按 id 排）
const a = squarify([{ id: 'b', value: 1 }, { id: 'a', value: 1 }, { id: 'c', value: 2 }])
const b = squarify([{ id: 'c', value: 2 }, { id: 'a', value: 1 }, { id: 'b', value: 1 }])
assert.deepEqual(a, b)
console.log('treemap.test ✓')
