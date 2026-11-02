/**
 * Word 试卷渲染成页面图时的分页，以及把量出来的文字片段换算成「按页归一化」的行（M9 补充 3）。
 * 纯函数，不依赖 electron，单测直接加载（locate.ts 对 Word 行的定位也用同一份数据格式）。
 *
 * 输入的坐标都是 CSS 像素（相对整篇文档左上角，A4 宽 794px）。分页尽量不从一行文字、一张图或一个表格行中间切开：
 * 候选分页线是 pageTop + pageH；如果它正好穿过某个文字行 / 图片 / 表格行，就把分页线提到那个元素的上边。
 */
export interface Frag { text: string; x: number; y: number; w: number; h: number }
export interface Block { y: number; h: number }
export interface Measured { height: number; frags: Frag[]; blocks: Block[] }

export const A4_WIDTH = 794
export const A4_HEIGHT = 1123
/** 页面上下留白（CSS 像素）：第一页顶部和最后一页底部各留一点，截出来的图不贴边 */
export const PAGE_MARGIN = 24

export interface PageSlice {
  idx: number
  /** 本页在整篇文档里的上边（CSS 像素）和高度 */
  top: number
  height: number
  /** 归一化到本页图（宽 0–1、高 0–1）的行，格式同 OCR 行；conf 恒为 1（文字是直接读出来的，不是识别的） */
  lines: Array<{ text: string; x: number; y: number; w: number; h: number; conf: number }>
}

const round4 = (v: number) => Math.round(v * 10000) / 10000

export function paginate(m: Measured, pageH = A4_HEIGHT, width = A4_WIDTH): PageSlice[] {
  const items = [...m.frags.map(f => ({ y: f.y, h: f.h })), ...m.blocks].sort((a, b) => a.y - b.y)
  const total = Math.max(m.height + PAGE_MARGIN, 1)
  const cuts: number[] = [0]
  let top = 0
  while (top + pageH < total) {
    let cut = top + pageH
    // 被切到的元素：上边在分页线之前、下边在分页线之后。多个元素叠在一起（表格行里的文字）时反复上提直到没有为止
    for (let guard = 0; guard < 50; guard++) {
      const hit = items.find(it => it.y < cut - 0.5 && it.y + it.h > cut + 0.5 && it.y > top + 1)
      if (!hit) break
      cut = hit.y - Math.min(8, Math.max(0, hit.y - top) / 2)
    }
    // 整页都是一个切不开的大块（比如超高的图）：只好硬切
    if (cut <= top + pageH * 0.2) cut = top + pageH
    cuts.push(Math.floor(cut))
    top = Math.floor(cut)
  }
  cuts.push(Math.ceil(total))
  const pages: PageSlice[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const t = cuts[i], h = Math.max(1, cuts[i + 1] - t)
    const lines = m.frags
      .filter(f => f.y + f.h / 2 >= t && f.y + f.h / 2 < t + h)
      .sort((a, b) => { const dy = (a.y + a.h / 2) - (b.y + b.h / 2); return Math.abs(dy) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : dy })   // 图片的 [图n] 占位是最后才量出来的：按位置排回原来的阅读顺序
      .map(f => ({
        text: f.text.replace(/\s+$/, ''),
        x: round4(Math.min(1, Math.max(0, f.x / width))), y: round4(Math.min(1, Math.max(0, (f.y - t) / h))),
        w: round4(Math.min(1, f.w / width)), h: round4(Math.min(1, f.h / h)), conf: 1
      }))
      .filter(l => l.text.trim() && l.w > 0 && l.h > 0)
    pages.push({ idx: i + 1, top: t, height: h, lines })
  }
  return pages
}
