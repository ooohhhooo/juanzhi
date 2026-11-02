/**
 * 「保存图片 / 复制图片」：把报告里的一张卡片（口诀大招 / 答题卡）渲染成 2 倍清晰度的 PNG。
 * 用一个隐藏的离屏窗口渲染与 PDF 同源的静态 HTML（强制浅色白底、固定 720px 宽、CSS zoom: 2），不受当前主题、滚动位置和显示器缩放影响；不引入新依赖。
 * 需要 electron。不写临时文件：窗口先打开 about:blank，主进程用 document.write 写入页面（页面带 CSP meta，没有脚本、不能联网）；
 * 窗口用一次性的内存 session，禁止跳转、禁止弹新窗口、拒绝一切权限请求。
 */
import { BrowserWindow, nativeImage } from 'electron'
import crypto from 'node:crypto'
import { parseBlocks } from '../../shared/markdown'
import { cardImagePage, cardToHtml } from '../../shared/mdhtml'
import { CARD_WIDTH } from '../../shared/card-style'

/** 图片宽度（像素）：(720 + 两侧各 16 的白边) × 2 */
export const CARD_IMAGE_WIDTH = (CARD_WIDTH + 32) * 2

/** 报告里第 index 张某类卡片的 HTML（没有这张卡返回 null） */
export function cardHtmlOf(markdown: string, kind: 'trick' | 'answercard', index: number): string | null {
  const cards = parseBlocks(markdown).filter((b): b is Extract<ReturnType<typeof parseBlocks>[number], { type: 'card' }> => b.type === 'card' && b.kind === kind)
  const c = cards[index]
  return c ? cardToHtml(c) : null
}

export async function renderCardImage(cardHtml: string): Promise<{ png: Buffer; width: number; height: number }> {
  const win = new BrowserWindow({
    show: false, width: CARD_IMAGE_WIDTH, height: 1200, useContentSize: true, backgroundColor: '#FFFFFF',
    // partition 不带 persist: 前缀 = 一次性的内存 session，用完即丢
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, partition: `ewb-card-${crypto.randomBytes(6).toString('hex')}` }
  })
  const wc = win.webContents
  wc.on('will-navigate', e => e.preventDefault())
  wc.on('will-redirect', e => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  try {
    await win.loadURL('about:blank')
    await wc.executeJavaScript(`document.open();document.write(${JSON.stringify(cardImagePage(cardHtml))});document.close();document.fonts.ready.then(() => true)`)
    // 量卡片高度（CSS zoom 下 getBoundingClientRect 的口径随 Chromium 版本不同，取 offsetHeight × zoom 与它的较大者，再用截图后的白边裁剪兜底）
    const h: number = await win.webContents.executeJavaScript(
      '(()=>{const b=document.body;const r=b.getBoundingClientRect().height;return Math.ceil(Math.max(r,b.offsetHeight*2,b.scrollHeight))})()')
    const height = Math.min(8000, Math.max(200, h + 4))
    win.setContentSize(CARD_IMAGE_WIDTH, height)
    // 离屏窗口要等一次重绘才有新尺寸的画面
    await new Promise(r => setTimeout(r, 250))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: CARD_IMAGE_WIDTH, height })
    const size = img.getSize()
    // 去掉底部多余的白边（量高度时偏大的部分）
    const bmp = img.toBitmap()
    let bottom = size.height - 1
    const rowBytes = size.width * 4
    while (bottom > 0) {
      let blank = true
      const off = bottom * rowBytes
      for (let x = 0; x < rowBytes; x += 4) { if (bmp[off + x] !== 255 || bmp[off + x + 1] !== 255 || bmp[off + x + 2] !== 255) { blank = false; break } }
      if (!blank) break
      bottom--
    }
    const keep = Math.min(size.height, bottom + 1 + 32)   // 下方留 16 css px（= 32 像素）的白边，和上方对称
    const out = keep < size.height ? nativeImage.createFromBitmap(bmp.subarray(0, keep * rowBytes), { width: size.width, height: keep }) : img
    const s2 = out.getSize()
    return { png: out.toPNG(), width: s2.width, height: s2.height }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
