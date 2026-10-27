/**
 * 题目截图的裁切框（B10）：界面（CropImage）、报告抽屉、导出 Markdown / PDF / Word 用同一个算法，各处裁出来一样。纯函数，单测直接加载。
 *
 *  - 留白已经在框里了（locate 给的 + parse/ink.ts 按页面墨迹修准：贴着本题文字留 3–4 像素白边、不越过两行之间空白的一半），所以这里不再额外加——
 *    以前这里再加 0.4% / 0.8%，行距小的页面上就把上一行 / 下一行的字脚（逗号、下划线）和邻题的题号带进来（第 20、31、33 题）；
 *  - 同一页上，同一行里在它右边紧挨着的下一道题：本题的右边必须停在它前面（repairNeighborEdges），旧数据也靠它修。
 */
export const PAD_X = 0
export const PAD_Y = 0
/** 同一行里下一道题的框，和本题右边之间至少留这么宽的缝（归一化） */
export const NEIGHBOR_SEAM = 0.008

export type Box4 = [number, number, number, number]

/** 归一化 bbox → 加了留白的裁切框（仍是归一化，限制在 0–1 内）；bbox 不合法返回 null */
export function padBox(b: number[] | null | undefined): Box4 | null {
  if (!b || b.length !== 4 || !(b[2] > 0) || !(b[3] > 0)) return null
  const x0 = Math.max(0, b[0] - PAD_X)
  const y0 = Math.max(0, b[1] - PAD_Y)
  const x1 = Math.min(1, b[0] + b[2] + PAD_X)
  const y1 = Math.min(1, b[1] + b[3] + PAD_Y)
  if (x1 <= x0 || y1 <= y0) return null
  return [x0, y0, x1 - x0, y1 - y0]
}

/** 加了留白的裁切框 → 像素（取整，限制在图内），宽高至少 1 */
export function cropPixels(b: number[] | null | undefined, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  const p = padBox(b)
  if (!p || width <= 0 || height <= 0) return null
  const x = Math.min(width - 1, Math.max(0, Math.floor(p[0] * width)))
  const y = Math.min(height - 1, Math.max(0, Math.floor(p[1] * height)))
  const w = Math.max(1, Math.min(width - x, Math.ceil(p[2] * width)))
  const h = Math.max(1, Math.min(height - y, Math.ceil(p[3] * height)))
  return { x, y, width: w, height: h }
}

export interface BoxRow { id: string; page: number; bbox: number[] | null; source?: string | null }

/**
 * 同一页、同一行（纵向重叠过半）里，本题右边已经伸进（或贴着）右边紧挨着的下一道题的框时，把本题的右边缩回到它前面。
 * 返回要改的题和新的 bbox；手工画的框（source = manual）不动。旧版本定位出来的框就是这个毛病（「16. … 17」）。
 */
export function repairNeighborEdges(rows: BoxRow[]): Array<{ id: string; bbox: Box4 }> {
  const out: Array<{ id: string; bbox: Box4 }> = []
  const byPage = new Map<number, BoxRow[]>()
  for (const r of rows) if (r.bbox && r.bbox.length === 4 && r.bbox[2] > 0 && r.bbox[3] > 0) {
    if (!byPage.has(r.page)) byPage.set(r.page, [])
    byPage.get(r.page)!.push(r)
  }
  for (const list of byPage.values()) {
    for (const a of list) {
      if (a.source === 'manual') continue
      const [ax, ay, aw, ah] = a.bbox as number[]
      let right = ax + aw
      for (const b of list) {
        if (b === a) continue
        const [bx, by, , bh] = b.bbox as number[]
        const overlap = Math.min(ay + ah, by + bh) - Math.max(ay, by)
        // 同一行：纵向重叠超过较矮那个的一半；并且 b 在 a 的右边（b 的左边在 a 的左边之后、a 的右边之前或紧贴）
        if (overlap < Math.min(ah, bh) * 0.5) continue
        if (bx <= ax + 0.02 || bx >= right + 0.02) continue
        right = Math.min(right, bx - NEIGHBOR_SEAM)
      }
      if (right < ax + aw - 1e-6 && right > ax + 0.02) {
        out.push({ id: a.id, bbox: [ax, ay, Math.round((right - ax) * 1000) / 1000, ah] })
      }
    }
  }
  return out
}
