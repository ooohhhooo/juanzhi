/**
 * Squarified treemap 布局（Bruls 等，2000）。输入一组正值，输出单位正方形 [0,1]×[0,1] 里的矩形，
 * 面积与值成正比。纯函数；界面把比例换成百分比定位，所以缩放窗口不用重算。
 */
export interface TreemapItem { id: string; value: number }
export interface TreemapRect { id: string; x: number; y: number; w: number; h: number }

export function squarify(items: TreemapItem[], aspect = 1): TreemapRect[] {
  // aspect = 容器宽/高：把单位方形里的比例按真实长宽比折算，才能让格子在真实容器里尽量接近正方形
  const list = items.filter(i => i.value > 0 && Number.isFinite(i.value)).sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1))
  const total = list.reduce((s, i) => s + i.value, 0)
  if (list.length === 0 || total <= 0) return []
  const out: TreemapRect[] = []
  // 在 W×H 的真实尺寸下布局（W = aspect, H = 1），最后再除回单位方形
  let x = 0, y = 0, w = aspect, h = 1
  const scale = (w * h) / total
  let row: Array<{ id: string; area: number }> = []
  const worst = (r: Array<{ area: number }>, side: number) => {
    const s = r.reduce((a, b) => a + b.area, 0)
    const mx = Math.max(...r.map(i => i.area)), mn = Math.min(...r.map(i => i.area))
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
  }
  const place = (r: Array<{ id: string; area: number }>) => {
    const s = r.reduce((a, b) => a + b.area, 0)
    if (w >= h) {   // 沿短边（高）竖着放一列
      const colW = s / h
      let cy = y
      for (const i of r) { const ih = i.area / colW; out.push({ id: i.id, x, y: cy, w: colW, h: ih }); cy += ih }
      x += colW; w -= colW
    } else {
      const rowH = s / w
      let cx = x
      for (const i of r) { const iw = i.area / rowH; out.push({ id: i.id, x: cx, y, w: iw, h: rowH }); cx += iw }
      y += rowH; h -= rowH
    }
  }
  for (const it of list) {
    const next = { id: it.id, area: it.value * scale }
    const side = Math.min(w, h)
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) row.push(next)
    else { place(row); row = [next] }
  }
  if (row.length) place(row)
  return out.map(r => ({ id: r.id, x: r.x / aspect, y: r.y, w: r.w / aspect, h: r.h }))
}
