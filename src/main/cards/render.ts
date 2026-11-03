/**
 * 卡片渲染（需要 electron）：隐藏窗口加载「底图 + 版式 HTML」，字号自适应后截图成 PNG（和底图同尺寸，默认 1086×1448）。
 * 隐私 / 安全：独立的一次性会话，拦截所有非 data: 请求；页面带 CSP（没有脚本、不能联网）；窗口禁止跳转和弹新窗口、拒绝权限请求。
 * 页面是 about:blank + document.write 灌进去的，不写临时文件。
 */
import { BrowserWindow, nativeImage, session } from 'electron'
import { buildCardPage } from './templates.ts'
import type { CardTemplate } from './templates.ts'
import type { CardKind } from './schema.ts'

/** 字号缩放下限：再小就看不清了，宁可让 Agent 精简内容 */
export const MIN_SCALE = 0.8
/** 内容少时最多放大到这个倍数 */
export const MAX_SCALE = 1.25
const STEP = 0.03
const TIMEOUT_MS = 30_000

export class CardTooMuchError extends Error {
  constructor() { super('卡片内容太多，排不下。请精简文字（少几条要点、句子写短一些）后重新生成。') }
}

let sess: Electron.Session | null = null
function getSession(): Electron.Session {
  if (!sess) {
    sess = session.fromPartition('share-card-render', { cache: false })
    sess.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith('data:') || d.url.startsWith('about:')) }))
    sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  }
  return sess
}

const FIT_JS = `(()=>{const e=document.getElementById("zc");return e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1})()`

export async function renderCardPng(t: CardTemplate, kind: CardKind, data: Record<string, any>): Promise<{ png: Buffer; width: number; height: number; scale: number }> {
  const win = new BrowserWindow({
    show: false, width: t.width, height: t.height, useContentSize: true, paintWhenInitiallyHidden: true, backgroundColor: '#FFFFFF',
    webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', e => e.preventDefault())
  const timer = setTimeout(() => { if (!win.isDestroyed()) win.destroy() }, TIMEOUT_MS)
  try {
    win.setContentSize(t.width, t.height)
    const html = buildCardPage(t, kind, data, 1)
    await win.loadURL('about:blank')
    await wc.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();true`)
    await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
    await wc.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)')
    let scale = 1
    // 内容少时适当放大填满纸面（最多 1.25 倍）
    if (!(await wc.executeJavaScript(FIT_JS))) {
      while (scale < MAX_SCALE) {
        const next = Math.round((scale + 0.05) * 100) / 100
        await wc.executeJavaScript(`document.body.style.setProperty('--s','${next}');true`)
        if (await wc.executeJavaScript(FIT_JS)) { await wc.executeJavaScript(`document.body.style.setProperty('--s','${scale}');true`); break }
        scale = next
      }
    }
    while (await wc.executeJavaScript(FIT_JS)) {
      scale = Math.round((scale - STEP) * 100) / 100
      if (scale < MIN_SCALE) throw new CardTooMuchError()
      await wc.executeJavaScript(`document.body.style.setProperty('--s','${scale}');true`)
    }
    await new Promise(r => setTimeout(r, 120))
    let img = await wc.capturePage({ x: 0, y: 0, width: t.width, height: t.height })
    const sz = img.getSize()
    if (sz.width !== t.width || sz.height !== t.height) img = nativeImage.createFromBuffer(img.toPNG()).resize({ width: t.width, height: t.height, quality: 'best' })
    const png = img.toPNG()
    if (png.length < 2000) throw new Error('卡片截图是空的，请重试')
    return { png, width: t.width, height: t.height, scale }
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}
