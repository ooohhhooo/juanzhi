/**
 * 把示例卷的文字画成「原卷页面」的 PNG（A4 比例，1240×1754），同时得到每道题的定位框。
 * 在一个隐藏窗口里用 canvas 画：字体用跨平台的回退链（苹方 / 微软雅黑 / 思源黑体 / 无衬线），Windows 上也能显示中文标题。
 * 这样示例数据里的「题目截图」是真的从页面图里裁出来的，和真实试卷走同一套显示 / 导出代码。
 */
import { BrowserWindow } from 'electron'
import type { RenderedSamplePaper, SampleRenderInput } from './load'

const script = `(async (papers) => {
  const W = 1240, H = 1754, M = 96
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif'
  const out = []
  const wrap = (ctx, text, maxW) => {
    const lines = []
    for (const para of String(text).split('\\n')) {
      let cur = ''
      // 先按「空白 / 非空白」切；一个词比一行还宽（比如没有空格的中文标题）就拆成单个字
      const toks = []
      for (const t of (para.match(/\\s+|\\S+/g) || [''])) {
        if (ctx.measureText(t).width > maxW) toks.push(...Array.from(t)); else toks.push(t)
      }
      for (const t of toks) {
        if (ctx.measureText(cur + t).width > maxW && cur.trim()) { lines.push(cur.trimEnd()); cur = t.trimStart() } else cur += t
      }
      lines.push(cur.trimEnd())
    }
    return lines
  }
  for (const p of papers) {
    const pages = []
    let cv, ctx, y
    const newPage = (first) => {
      cv = document.createElement('canvas'); cv.width = W; cv.height = H
      ctx = cv.getContext('2d')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#111111'; ctx.textBaseline = 'top'
      y = M
      if (first) {
        ctx.font = 'bold 44px ' + FONT
        for (const l of wrap(ctx, p.title, W - 2 * M)) { ctx.fillText(l, M, y); y += 60 }
        ctx.font = '26px ' + FONT; ctx.fillStyle = '#555555'
        ctx.fillText(p.header, M, y); y += 44
        ctx.fillStyle = '#111111'
        ctx.fillRect(M, y, W - 2 * M, 2); y += 34
      }
      pages.push({ cv, text: [] })
    }
    newPage(true)
    const boxes = []
    for (const q of p.questions) {
      ctx.font = '30px ' + FONT
      const lines = []
      q.lines.forEach((t, k) => { for (const l of wrap(ctx, (k === 0 ? q.no + '.  ' : '     ') + t, W - 2 * M - 10)) lines.push(l) })
      const h = lines.length * 46 + 22
      if (y + h > H - M) newPage(false)
      ctx.font = '30px ' + FONT; ctx.fillStyle = '#111111'
      const top = y
      for (const l of lines) { ctx.fillText(l, M, y + 8); y += 46 }
      const pg = pages[pages.length - 1]
      pg.text.push(lines.join(' '))
      boxes.push({ page: pages.length, bbox: [(M - 16) / W, (top - 4) / H, (W - 2 * M + 32) / W, (h - 6) / H] })
      y += 22
    }
    out.push({
      pages: pages.map(pg => ({ pngBase64: pg.cv.toDataURL('image/png').split(',')[1], width: W, height: H, text: pg.text.join('\\n') })),
      boxes
    })
  }
  return out
})`

export async function renderSamplePapers(papers: SampleRenderInput[]): Promise<RenderedSamplePaper[]> {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, skipTaskbar: true, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } })
  try {
    await win.loadURL('about:blank')
    const raw = await win.webContents.executeJavaScript(`(${script})(${JSON.stringify(papers)})`) as Array<{ pages: Array<{ pngBase64: string; width: number; height: number; text: string }>; boxes: RenderedSamplePaper['boxes'] }>
    return raw.map(r => ({
      pages: r.pages.map(pg => ({ png: Buffer.from(pg.pngBase64, 'base64'), width: pg.width, height: pg.height, text: pg.text })),
      boxes: r.boxes.map(b => ({ page: b.page, bbox: b.bbox.map(v => Math.round(v * 10000) / 10000) as [number, number, number, number] }))
    }))
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
