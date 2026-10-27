/**
 * 用页面图片的「墨迹」把题目截图的框修准（M6 验收返工 R4：第 20、31、33 题仍有残字、带出邻题题号、右边被切）。
 * 纯函数（输入是灰度像素），不依赖 electron，单测直接加载。
 *
 * 为什么需要：框是按 OCR 行的位置和「字符数比例」估出来的——同一行里挤着两道题时，前一题的右边、后一题的左边只能估在邻题题号附近，
 * 差一个字就带出邻题的题号或切掉自己的最后一个字；上下留白又是按固定比例加的，行距小的页面上会把上一行 / 下一行的字脚（逗号、下划线）带进来。
 * 做法：在估计的边附近找「真正的空白」——一小段连续没有墨迹的行 / 列——把边放到空白里：
 *  · 上、下边：贴着本题文字留 3–4 像素白边，不越过两行之间空白的一半，所以不会再带上相邻行的字脚；
 *  · 右边（有右邻题时）：放到本题最后一个字和邻题题号之间的空白里；左边同理；
 *  · 没有邻题时：只保证边不落在字的中间（落在字上就往外扩到空白）。
 */

export type Box4 = [number, number, number, number]
export interface Gray { w: number; h: number; data: Uint8Array }
export interface InkBox { id: string; bbox: number[]; source?: string | null }

/** 比这个值暗的像素算墨迹 */
export const INK = 150
const MARGIN = 4
/** 词与词之间的空白一般 ≥ 8 像素，字母之间的缝只有 2–4 像素：只把 ≥ 7 像素的空白当作「词间空白」 */
const MIN_COL_GAP = 7
const MIN_ROW_GAP = 2

/** BGRA（Electron nativeImage.toBitmap 的格式，macOS / Windows 都是 BGRA）→ 灰度 */
export function grayFromBgra(bgra: Uint8Array, w: number, h: number): Gray {
  const data = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const a = bgra[j + 3]
    const lum = (bgra[j] * 29 + bgra[j + 1] * 150 + bgra[j + 2] * 77) >> 8
    data[i] = a === 255 ? lum : (lum * a + 255 * (255 - a)) / 255   // 透明当白底
  }
  return { w, h, data }
}

const px = (g: Gray, x: number, y: number) => g.data[y * g.w + x]
const rowInk = (g: Gray, y: number, x0: number, x1: number): number => {
  if (y < 0 || y >= g.h) return 0
  let n = 0
  for (let x = Math.max(0, x0); x < Math.min(g.w, x1); x++) if (px(g, x, y) < INK) n++
  return n
}
const colInk = (g: Gray, x: number, y0: number, y1: number): number => {
  if (x < 0 || x >= g.w) return 0
  let n = 0
  for (let y = Math.max(0, y0); y < Math.min(g.h, y1); y++) if (px(g, x, y) < INK) n++
  return n
}

/** 在 [lo, hi) 里找「连续空白」的区间（空白 = ink(i) === 0），长度 ≥ minLen */
function blankRuns(ink: (i: number) => number, lo: number, hi: number, minLen: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let s = -1
  for (let i = lo; i <= hi; i++) {
    const blank = i < hi && ink(i) === 0
    if (blank && s < 0) s = i
    if (!blank && s >= 0) { if (i - s >= minLen) out.push([s, i]); s = -1 }
  }
  return out
}

/** 离 want 最近的空白区间（区间包含 want 时距离为 0）；距离差不多时选更宽的（宽的才是真正的词间空白） */
function nearest(runs: Array<[number, number]>, target: number, want?: number): [number, number] | null {
  let best: [number, number] | null = null, bs = Infinity
  const t = want ?? target
  for (const r of runs) {
    const d = t < r[0] ? r[0] - t : t >= r[1] ? t - (r[1] - 1) : 0
    const score = d - (r[1] - r[0]) * 1.2
    if (score < bs) { bs = score; best = r }
  }
  return best
}

/**
 * 修一页里所有题的框。boxes 里 source === 'manual'（老师手画的）不动。返回有变化的框（归一化坐标，四舍五入到千分位）。
 */
export function refineBoxes(g: Gray, boxes: InkBox[]): Array<{ id: string; bbox: Box4 }> {
  const out: Array<{ id: string; bbox: Box4 }> = []
  const valid = boxes.filter(b => b.bbox && b.bbox.length === 4 && b.bbox[2] > 0 && b.bbox[3] > 0)
  for (const a of valid) {
    if (a.source === 'manual') continue
    const [ax, ay, aw, ah] = a.bbox
    let X0 = Math.round(ax * g.w), X1 = Math.round((ax + aw) * g.w)
    let Y0 = Math.round(ay * g.h), Y1 = Math.round((ay + ah) * g.h)
    const sameRow = (b: InkBox) => { const [, by, , bh] = b.bbox; return Math.min(ay + ah, by + bh) - Math.max(ay, by) >= Math.min(ah, bh) * 0.5 }
    const rightN = valid.filter(b => b !== a && sameRow(b) && b.bbox[0] > ax + 0.02 && b.bbox[0] > ax + aw - 0.03 && b.bbox[0] < ax + aw + 0.045).sort((p, q) => p.bbox[0] - q.bbox[0])[0]
    // 本题是同一行里「前一题」、而后一题的框是从行首起的并集（后一题折行了，框是两行的并集，x 从行首开始）：
    // 邻题的起点只知道大致在本题右边之后，用本题当前的右边当估计
    const unionN = valid.some(b => b !== a && Math.abs(b.bbox[1] - ay) < 0.004 && b.bbox[0] <= ax + 0.02 && b.bbox[0] + b.bbox[2] > ax + aw + 0.03 && b.bbox[3] > ah * 1.4)
    const leftN = valid.filter(b => b !== a && sameRow(b) && b.bbox[0] < ax - 0.02 && b.bbox[0] + b.bbox[2] > ax - 0.045 && b.bbox[0] + b.bbox[2] < ax + 0.03).sort((p, q) => q.bbox[0] - p.bbox[0])[0]

    // ── 上、下边：贴着本题文字留白边，不越过两行之间空白的一半 ──
    const vx0 = X0 + 2, vx1 = X1 - 2
    const vr = (y: number) => rowInk(g, y, vx0, vx1)
    {
      const lo = Y0 - 10, hi = Y0 + 8
      const run = nearest(blankRuns(vr, lo, hi + 1, MIN_ROW_GAP), Y0)
      // 空白区间的下沿 = 本题文字的第一行墨迹的上一行：边放在它上面 m 像素（m 不超过空白的一半）
      if (run && run[1] <= hi) Y0 = run[1] - Math.min(MARGIN, Math.floor((run[1] - run[0]) / 2))
    }
    {
      const lo = Y1 - 8, hi = Y1 + 10
      const run = nearest(blankRuns(vr, lo, hi + 1, MIN_ROW_GAP), Y1)
      if (run && run[0] > lo) Y1 = run[0] + Math.min(MARGIN, Math.floor((run[1] - run[0]) / 2))
    }
    Y0 = Math.max(0, Y0); Y1 = Math.min(g.h, Math.max(Y0 + 1, Y1))

    // ── 右边 ──
    const hc = (x: number) => colInk(g, x, Y0 + 1, Y1 - 1)
    if (rightN || unionN) {
      const nx = rightN ? Math.round(rightN.bbox[0] * g.w) : X1
      const runs = blankRuns(hc, Math.max(X0 + 12, nx - 40), Math.min(g.w, nx + 10), MIN_COL_GAP)
      const run = nearest(runs, nx, nx - 8) ?? nearest(blankRuns(hc, Math.max(X0 + 12, nx - 40), Math.min(g.w, nx + 10), 4), nx, nx - 8)
      if (run) X1 = run[0] + Math.min(3, Math.floor((run[1] - run[0]) / 2))
    } else if (hc(X1 - 1) > 0 || hc(X1) > 0) {
      let x = X1
      while (x < Math.min(g.w - 1, X1 + 14) && hc(x) > 0) x++
      X1 = x
    }
    // ── 左边 ──
    if (leftN) {
      const ex = Math.round((leftN.bbox[0] + leftN.bbox[2]) * g.w)
      const runs = blankRuns(hc, Math.max(0, Math.min(X0, ex) - 26), Math.min(X1 - 12, Math.max(X0, ex) + 12), MIN_COL_GAP)
      const run = nearest(runs, X0, X0 - 6) ?? nearest(blankRuns(hc, Math.max(0, Math.min(X0, ex) - 26), Math.min(X1 - 12, Math.max(X0, ex) + 12), 4), X0, X0 - 6)
      if (run) X0 = run[1] - Math.min(3, Math.floor((run[1] - run[0]) / 2))
    } else if (hc(X0) > 0 || hc(X0 + 1) > 0) {
      let x = X0
      while (x > Math.max(0, X0 - 14) && hc(x) > 0) x--
      X0 = x
    }
    X0 = Math.max(0, X0); X1 = Math.min(g.w, Math.max(X0 + 1, X1))
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const nb: Box4 = [r3(X0 / g.w), r3(Y0 / g.h), r3((X1 - X0) / g.w), r3((Y1 - Y0) / g.h)]
    if (Math.abs(nb[0] - ax) > 0.0004 || Math.abs(nb[1] - ay) > 0.0004 || Math.abs(nb[2] - aw) > 0.0004 || Math.abs(nb[3] - ah) > 0.0004) out.push({ id: a.id, bbox: nb })
  }
  return out
}
