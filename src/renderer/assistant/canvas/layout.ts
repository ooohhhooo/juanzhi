/**
 * 画布的树形自动排版（纯函数，单测直接跑）。
 * 自上而下：父节点在上、子节点在下横向排开；子树按宽度互不重叠，父节点居中在子节点上方。
 * 折叠的节点不显示后代；「只看结论」隐藏 plan / step-group / ask，它们的子节点接到最近的可见祖先上。
 */
import type { CanvasNode, CanvasNodeKind } from '../types.ts'

export const NODE_W = 220
export const GAP_X = 56
export const GAP_Y = 64
/** 产出卡片在回答右边竖着排，间距小一点 */
export const GAP_SIDE = 16
const HIDDEN_IN_CONCLUSION: ReadonlySet<CanvasNodeKind> = new Set<CanvasNodeKind>(['plan', 'step-group', 'ask'])

export interface Box { x: number; y: number; w: number; h: number }
export interface LayoutResult {
  boxes: Map<string, Box>
  /** side = 产出这类旁边的卡片：从父节点右侧接出，不挤在子节点那一排里 */
  edges: Array<{ from: string; to: string; side?: boolean }>
  /** 整个内容的包围盒 */
  bounds: { x: number; y: number; w: number; h: number }
  /** 每个节点在原始数据里的直接子节点数（用来画折叠按钮） */
  childCount: Map<string, number>
  /** 每个可见节点的深度（根 = 1） */
  depth: Map<string, number>
  /** 可见节点按绘制顺序（先序） */
  order: string[]
  /** 可见节点的父节点（接线用，可能已跳过被隐藏的祖先） */
  parentOf: Map<string, string | null>
}

export interface LayoutOptions {
  mode?: 'all' | 'conclusions'
  /** 被折叠的节点 id（它们的后代不显示） */
  collapsed?: ReadonlySet<string>
}

/** 按内容估算节点高度（宽度固定，中文按每行约 15 个字估） */
export function estimateHeight(n: CanvasNode): number {
  const lines = (t: string, per: number, max: number) => Math.min(max, Math.max(1, Math.ceil([...t].length / per)))
  let h = 16 + 18 // 内边距 + 种类标签行
  h += lines(n.title, 14, 3) * 19
  if (n.body) h += lines(n.body, 16, 3) * 18 + 2
  if (n.refs?.length) h += 24
  if (n.mini) h += 44
  if (n.kind === 'finding' || n.kind === 'answer') h += 54 // 操作按钮两行
  else if (n.kind !== 'step-group' && n.kind !== 'output') h += 4
  return Math.max(h, 58)
}

export function layoutTree(nodes: readonly CanvasNode[], opts: LayoutOptions = {}): LayoutResult {
  const mode = opts.mode ?? 'all'
  const collapsed = opts.collapsed ?? new Set<string>()
  const byId = new Map(nodes.map(n => [n.id, n]))
  const rawChildren = new Map<string, CanvasNode[]>()
  const roots: CanvasNode[] = []
  for (const n of nodes) {
    if (n.parentId && n.parentId !== n.id && byId.has(n.parentId)) {
      const a = rawChildren.get(n.parentId) ?? []
      a.push(n); rawChildren.set(n.parentId, a)
    } else roots.push(n)
  }
  const byTime = (a: CanvasNode, b: CanvasNode) => a.createdAt - b.createdAt
  roots.sort(byTime)
  for (const a of rawChildren.values()) a.sort(byTime)
  const childCount = new Map<string, number>()
  for (const [k, v] of rawChildren) childCount.set(k, v.length)

  const hidden = (n: CanvasNode) => mode === 'conclusions' && HIDDEN_IN_CONCLUSION.has(n.kind)
  const seen = new Set<string>()
  // 可见子节点：隐藏的节点被「穿透」，它的子节点接到上一级；折叠的节点不展开
  const visibleChildren = (n: CanvasNode): CanvasNode[] => {
    if (collapsed.has(n.id)) return []
    const out: CanvasNode[] = []
    const walk = (c: CanvasNode) => {
      if (hidden(c)) { if (!collapsed.has(c.id)) for (const g of rawChildren.get(c.id) ?? []) walk(g) } else out.push(c)
    }
    for (const c of rawChildren.get(n.id) ?? []) walk(c)
    return out.sort(byTime)
  }
  const visibleRoots: CanvasNode[] = []
  const collect = (c: CanvasNode) => { if (hidden(c)) { for (const g of rawChildren.get(c.id) ?? []) collect(g) } else visibleRoots.push(c) }
  for (const r of roots) collect(r)
  visibleRoots.sort(byTime)

  const heights = new Map<string, number>()
  const subW = new Map<string, number>()
  const kids = new Map<string, CanvasNode[]>()
  const side = new Map<string, CanvasNode[]>()   // 产出：竖排在子节点右侧
  // 子树宽度：自底向上（用显式栈，避免很深的链爆栈）
  const post: CanvasNode[] = []
  const stack: Array<{ n: CanvasNode; i: number }> = []
  const push = (n: CanvasNode) => { if (seen.has(n.id)) return; seen.add(n.id); kids.set(n.id, visibleChildren(n).filter(c => !seen.has(c.id))); stack.push({ n, i: 0 }) }
  for (const r of visibleRoots) {
    push(r)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const ks = kids.get(top.n.id)!
      if (top.i < ks.length) { push(ks[top.i++]) } else { stack.pop(); post.push(top.n) }
    }
  }
  for (const n of post) {
    heights.set(n.id, estimateHeight(n))
    const all = (kids.get(n.id) ?? []).filter(k => subW.has(k.id))
    const sd = all.filter(k => k.kind === 'output' && !(kids.get(k.id)?.length))
    const ks = all.filter(k => !sd.includes(k))
    kids.set(n.id, ks); side.set(n.id, sd)
    const inner = ks.length ? ks.reduce((s, k) => s + subW.get(k.id)!, 0) + GAP_X * (ks.length - 1) : 0
    subW.set(n.id, Math.max(NODE_W, inner) + (sd.length ? GAP_X + NODE_W : 0))
  }

  const boxes = new Map<string, Box>()
  const edges: LayoutResult['edges'] = []
  const depth = new Map<string, number>()
  const order: string[] = []
  const parentOf = new Map<string, string | null>()
  const place = (n: CanvasNode, left: number, top: number, d: number, parent: string | null) => {
    const sd = side.get(n.id) ?? []
    const w = subW.get(n.id)! - (sd.length ? GAP_X + NODE_W : 0), h = heights.get(n.id)!
    boxes.set(n.id, { x: left + (w - NODE_W) / 2, y: top, w: NODE_W, h })
    depth.set(n.id, d); order.push(n.id); parentOf.set(n.id, parent)
    if (parent) edges.push({ from: parent, to: n.id })
    const ks = kids.get(n.id) ?? []
    const inner = ks.length ? ks.reduce((s, k) => s + subW.get(k.id)!, 0) + GAP_X * (ks.length - 1) : 0
    let x = left + (w - inner) / 2
    for (const k of ks) { place(k, x, top + h + GAP_Y, d + 1, n.id); x += subW.get(k.id)! + GAP_X }
    let sy = top + h + GAP_Y
    for (const k of sd) {
      const kh = heights.get(k.id)!
      boxes.set(k.id, { x: left + w + GAP_X, y: sy, w: NODE_W, h: kh })
      depth.set(k.id, d + 1); order.push(k.id); parentOf.set(k.id, n.id); edges.push({ from: n.id, to: k.id, side: true })
      sy += kh + GAP_SIDE
    }
  }
  let x0 = 0
  for (const r of visibleRoots) if (subW.has(r.id)) { place(r, x0, 0, 1, null); x0 += subW.get(r.id)! + GAP_X * 2 }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of boxes.values()) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h) }
  const bounds = boxes.size ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 }
  return { boxes, edges, bounds, childCount, depth, order, parentOf }
}

/** 键盘移动：dir 方向上的下一个节点（找不到返回 null） */
export function neighbor(l: LayoutResult, id: string, dir: 'up' | 'down' | 'left' | 'right'): string | null {
  const b = l.boxes.get(id)
  if (!b) return null
  if (dir === 'up') return l.parentOf.get(id) ?? null
  if (dir === 'down') return l.order.find(o => l.parentOf.get(o) === id) ?? null
  const same = l.order.filter(o => l.depth.get(o) === l.depth.get(id)).sort((p, q) => l.boxes.get(p)!.x - l.boxes.get(q)!.x)
  const i = same.indexOf(id)
  const j = dir === 'left' ? i - 1 : i + 1
  return same[j] ?? null
}

export interface View { x: number; y: number; k: number }
export const MIN_K = 0.015
export const MAX_K = 2.5

/** 以屏幕点 (px, py)（容器坐标）为中心缩放 */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
  const r = k / v.k
  return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
}

/** 让内容包围盒完整落在容器里并居中 */
export function fitView(bounds: LayoutResult['bounds'], cw: number, ch: number, pad = 48, extra: { right?: number; bottom?: number } = {}): View {
  if (!bounds.w || !bounds.h || cw <= 0 || ch <= 0) return { x: cw / 2, y: 40, k: 1 }
  const er = extra.right ?? 0, eb = extra.bottom ?? 0
  const aw = Math.max(1, cw - er), ah = Math.max(1, ch - eb)   // 内容放在去掉右下留白后的区域里
  const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((aw - pad * 2) / bounds.w, (ah - pad * 2) / bounds.h, 1.1)))
  return { k, x: (aw - bounds.w * k) / 2 - bounds.x * k, y: (ah - bounds.h * k) / 2 - bounds.y * k }
}
