// 画布树形排版、只看结论过滤、折叠、键盘移动、缩放
import assert from 'node:assert/strict'
import { layoutTree, neighbor, zoomAt, fitView, NODE_W, GAP_X } from '../../src/renderer/assistant/canvas/layout.ts'

let t = 0
const n = (id, parentId, kind = 'finding', over = {}) => ({ id, parentId, kind, title: id, branchId: 'main', createdAt: ++t, ...over })
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const noOverlap = L => { const bs = [...L.boxes.values()]; for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) assert.ok(!overlap(bs[i], bs[j]), `重叠 ${i} ${j}`) }

// 基本树：根 → 3 个孩子，中间的孩子再有 2 个
const nodes = [n('q', null, 'question'), n('a', 'q'), n('b', 'q'), n('c', 'q'), n('b1', 'b'), n('b2', 'b')]
const L = layoutTree(nodes)
noOverlap(L)
assert.equal(L.boxes.size, 6)
assert.equal(L.edges.length, 5)
const bx = id => L.boxes.get(id)
assert.ok(bx('q').y < bx('a').y && bx('a').y === bx('b').y && bx('b').y < bx('b1').y, '自上而下')
assert.ok(bx('a').x < bx('b').x && bx('b').x < bx('c').x, '兄弟按时间从左到右')
// 父节点居中在子节点上方
const mid = ids => { const xs = ids.map(i => bx(i).x + NODE_W / 2); return (Math.min(...xs) + Math.max(...xs)) / 2 }
assert.ok(Math.abs(bx('q').x + NODE_W / 2 - mid(['a', 'c'])) < 1e-6)
assert.ok(Math.abs(bx('b').x + NODE_W / 2 - mid(['b1', 'b2'])) < 1e-6)
// 子树宽度：b 的两个孩子撑开 b 的子树，孩子之间至少隔一个间距
assert.ok(bx('b1').x + NODE_W + GAP_X <= bx('b2').x + 1e-6)
assert.equal(L.depth.get('b1'), 3)
assert.equal(L.childCount.get('q'), 3)
// 子树宽度：a 的子树只有自己宽，b 的子树 = 两个孩子 + 间距，所以 b 与 a 的中心距 >= (NODE_W + 2*NODE_W+GAP_X)/2 + GAP_X 的一半以上
const subB = 2 * NODE_W + GAP_X
assert.ok(bx('b').x + NODE_W / 2 - (bx('a').x + NODE_W / 2) >= NODE_W / 2 + GAP_X + subB / 2 - 1e-6)

// 折叠：折叠 b 后 b1 b2 不再出现，b 仍在，childCount 保留
const C = layoutTree(nodes, { collapsed: new Set(['b']) })
assert.ok(C.boxes.has('b') && !C.boxes.has('b1') && !C.boxes.has('b2'))
assert.equal(C.childCount.get('b'), 2)
noOverlap(C)

// 只看结论：plan / step-group / ask 隐藏，孩子接到最近的可见祖先
const tree = [n('q', null, 'question'), n('p', 'q', 'plan'), n('sg', 'p', 'step-group'), n('f1', 'p', 'finding'), n('f2', 'p', 'finding'), n('k', 'f1', 'ask'), n('fu', 'k', 'followup'), n('o', 'f2', 'output')]
assert.equal(layoutTree(tree).boxes.size, 8)
const only = layoutTree(tree, { mode: 'conclusions' })
for (const id of ['p', 'sg', 'k']) assert.ok(!only.boxes.has(id), id + ' 应隐藏')
for (const id of ['q', 'f1', 'f2', 'fu', 'o']) assert.ok(only.boxes.has(id), id + ' 应保留')
assert.equal(only.parentOf.get('f1'), 'q')
assert.equal(only.parentOf.get('fu'), 'f1')
assert.ok(only.edges.some(e => e.from === 'q' && e.to === 'f1'))
noOverlap(only)

// 多个根、孤儿（父节点不存在）按根处理、环不死循环
const odd = layoutTree([n('r1', null), n('r2', null), n('x', 'missing'), n('c1', 'c2'), n('c2', 'c1')])
assert.ok(odd.boxes.has('r1') && odd.boxes.has('r2') && odd.boxes.has('x'))
noOverlap(odd)
assert.equal(layoutTree([]).boxes.size, 0)

// 200 个节点：不重叠、很快
const big = [n('s0', null, 'question')]
for (let i = 1; i < 200; i++) big.push(n('s' + i, 's' + Math.floor((i - 1) / 3), i % 5 === 0 ? 'step-group' : 'finding', { body: 'x'.repeat(i % 40) }))
const t0 = performance.now()
const LB = layoutTree(big)
const ms = performance.now() - t0
assert.equal(LB.boxes.size, 200)
noOverlap(LB)
assert.ok(ms < 100, `200 节点排版 ${ms.toFixed(1)}ms`)
// 很深的链
const chain = Array.from({ length: 1500 }, (_, i) => n('c' + i, i ? 'c' + (i - 1) : null))
assert.equal(layoutTree(chain).boxes.size, 1500)

// 键盘移动
assert.equal(neighbor(L, 'q', 'down'), 'a')
assert.equal(neighbor(L, 'a', 'up'), 'q')
assert.equal(neighbor(L, 'a', 'right'), 'b')
assert.equal(neighbor(L, 'b', 'left'), 'a')
assert.equal(neighbor(L, 'a', 'left'), null)
assert.equal(neighbor(L, 'q', 'up'), null)

// 缩放以鼠标为中心：鼠标下的世界坐标不变
const v = { x: 30, y: 50, k: 1 }
const z = zoomAt(v, 1.5, 200, 120)
assert.ok(Math.abs((200 - v.x) / v.k - (200 - z.x) / z.k) < 1e-9 && Math.abs((120 - v.y) / v.k - (120 - z.y) / z.k) < 1e-9)
assert.ok(zoomAt(v, 100, 0, 0).k <= 2.5 && zoomAt(v, 0.0001, 0, 0).k >= 0.015)
// 适应窗口：内容完整落在容器里
const f = fitView(LB.bounds, 800, 500)
assert.ok(LB.bounds.w * f.k <= 800 && LB.bounds.h * f.k <= 500)
// 产出卡片竖排在回答右边（不挤进子节点那一排），连线标记为 side；连线不超出父节点子树范围
{
  const ns = [n('q2', null, 'question'), n('ans', 'q2', 'answer'), n('f1', 'ans'), n('f2', 'ans'), n('o1', 'ans', 'output'), n('o2', 'ans', 'output')]
  const S = layoutTree(ns)
  noOverlap(S)
  const b = id => S.boxes.get(id)
  assert.ok(b('o1').x > b('f2').x + NODE_W && b('o1').x === b('o2').x && b('o1').y < b('o2').y, '产出竖排在右侧')
  assert.equal(S.edges.filter(e => e.side).length, 2)
  assert.ok(Math.abs(b('ans').x + NODE_W / 2 - (b('f1').x + b('f2').x + NODE_W) / 2) < 1e-6, '回答只在 finding 上方居中')
}
// 适应窗口给右下角留白
{
  const f2 = fitView(LB.bounds, 800, 500, 48, { right: 200, bottom: 80 })
  assert.ok(LB.bounds.w * f2.k + f2.x <= 600 + 1e-6 && LB.bounds.h * f2.k + f2.y <= 420 + 1e-6)
}
console.log('assistant-canvas-layout.test ✓')
