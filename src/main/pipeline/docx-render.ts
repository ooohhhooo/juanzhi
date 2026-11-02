/**
 * Word 试卷的页面图（M9 补充 3）：用 mammoth 转出的 HTML（保留编号、下划线、表格、图片），在一个看不见的窗口里按 A4 宽度排版，
 * 分页截成页面图，同时用 DOM 量出每一行文字的位置写进 lines_json。之后 Word 试卷和图片、PDF 走同一套定位和截图。
 *
 * 隐私：整个过程在本机，窗口不显示、不联网（独立会话 + 拦截所有非 data: 请求 + 内容安全策略），页面里的脚本只有我们注入的这一段。
 * 失败（窗口建不起来、超时、截图为空）一律返回 null，调用方退回原来只提取文字的做法，不让导入失败。
 */
import { BrowserWindow, session } from 'electron'
import measureScript from './docx-measure.js.txt?raw'
import { paginate, A4_WIDTH, A4_HEIGHT } from './docx-paginate'
import type { Measured } from './docx-paginate'
import type { OcrLine } from '../types'

export interface DocxPage {
  idx: number
  png: Buffer
  width: number
  height: number
  lines: OcrLine[]
}

const RENDER_TIMEOUT_MS = 60_000
/** 截图放大倍数：页面图按 2 倍清晰度存（A4 宽 794 → 1588 像素），题目截图放大看才不糊 */
const SCALE = 2
/** 一份 Word 最多渲染几页：防止异常大的文档把内存吃光 */
const MAX_PAGES = 40

const PAGE_CSS = `
  html, body { margin: 0; background: #fff; }
  body { width: ${A4_WIDTH}px; box-sizing: border-box; padding: 56px 64px ${A4_HEIGHT}px; color: #000;
    font: 15px/1.75 "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", Arial, sans-serif; word-wrap: break-word; }
  p { margin: 0 0 6px; } h1, h2, h3, h4 { margin: 10px 0 8px; line-height: 1.5; }
  ol, ul { margin: 0 0 6px; padding-left: 28px; } li { margin: 0 0 2px; }
  u { text-decoration: underline; white-space: pre; }
  table { border-collapse: collapse; margin: 6px 0 10px; max-width: 100%; } td, th { border: 1px solid #555; padding: 4px 8px; vertical-align: top; }
  img { max-width: 100%; height: auto; display: block; margin: 6px 0; }
`

/** 图片只保留浏览器能画的几种；mammoth 对 EMF/WMF 等也会输出 data: 地址，画不出来会留一个破图标 */
function cleanImages(html: string): string {
  return html.replace(/<img\b[^>]*src="data:image\/(?!png|jpe?g|gif)[^"]*"[^>]*>/gi, '')
}

async function toHtml(docxPath: string): Promise<string> {
  const m: any = await import('mammoth')
  const mammoth = m.default ?? m
  // 默认的图片转换是内联 data: 地址，渲染用；下划线要显式打开（mammoth 默认丢掉）
  const r = await mammoth.convertToHtml({ path: docxPath }, { styleMap: ['u => u'] })
  return cleanImages(String(r.value))
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface DocxRenderResult { pages: DocxPage[] | null; /** pages 为 null 时给用户看的原因 */ note?: string }

/** 整个应用运行期间共用一个一次性会话（不落盘、不带 cookie），请求拦截只设一次 */
let renderSession: Electron.Session | null = null
function getSession(): Electron.Session {
  if (!renderSession) {
    renderSession = session.fromPartition('docx-render', { cache: false })
    // 一切联网请求都拦掉：页面是用 about:blank + document.write 灌进去的，只需要 about: / data:
    renderSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(details.url.startsWith('data:') || details.url.startsWith('about:')) }))
  }
  return renderSession
}

/** 渲染一份 Word；失败返回 pages=null（原因写进控制台和 note，不抛出） */
export async function renderDocxPages(docxPath: string): Promise<DocxRenderResult> {
  let win: BrowserWindow | null = null
  let aborted = false
  const timer: { id?: NodeJS.Timeout } = {}
  try {
    win = new BrowserWindow({
      show: false, width: A4_WIDTH, height: A4_HEIGHT, useContentSize: true, paintWhenInitiallyHidden: true,
      webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, zoomFactor: SCALE, spellcheck: false }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    // 窗口按放大后的像素算：内容宽 794 CSS 像素 × 放大倍数
    win.setContentSize(A4_WIDTH * SCALE, A4_HEIGHT * SCALE)
    const w = win
    const work = (async (): Promise<DocxRenderResult> => {
      const html = await toHtml(docxPath)   // mammoth 转换也算在总时限里
      const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${PAGE_CSS}</style></head><body>${html}</body></html>`
      await w.loadURL('about:blank')
      await w.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(doc)}); document.close(); true`)
      await w.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
      // 内联图片异步解码：等所有图片就绪再量
      await w.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)')
      // 先看文档有多高：太长就不逐字量了（逐字量很慢）。高度里要扣掉底部为滚动留的一页空白
      const docH = Number(await w.webContents.executeJavaScript('document.documentElement.scrollHeight')) - A4_HEIGHT
      if (docH / A4_HEIGHT > MAX_PAGES) return { pages: null, note: `文档超过 ${MAX_PAGES} 页，没生成页面图` }
      const measured = JSON.parse(await w.webContents.executeJavaScript(measureScript)) as Measured
      const slices = paginate(measured)
      if (slices.length === 0) return { pages: null }
      if (slices.length > MAX_PAGES) return { pages: null, note: `文档超过 ${MAX_PAGES} 页，没生成页面图` }
      const out: DocxPage[] = []
      for (const s of slices) {
        if (aborted || w.isDestroyed()) return { pages: null }
        await w.webContents.executeJavaScript(`window.scrollTo(0, ${s.top}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`)
        await sleep(30)
        let img = await w.webContents.capturePage({ x: 0, y: 0, width: A4_WIDTH * SCALE, height: Math.max(1, Math.round(s.height * SCALE)) })
        if (img.isEmpty()) return { pages: null }
        // 不管显示器的缩放比例，页面图统一成 A4 宽 × SCALE
        const sz = img.getSize()
        if (sz.width !== A4_WIDTH * SCALE) img = img.resize({ width: A4_WIDTH * SCALE, height: Math.max(1, Math.round(sz.height * (A4_WIDTH * SCALE) / sz.width)) })
        const size = img.getSize()
        out.push({ idx: s.idx, png: img.toPNG(), width: size.width, height: size.height, lines: s.lines })
      }
      return { pages: out }
    })()
    work.catch(() => { /* 超时后窗口被销毁，这里的报错不要变成未处理的拒绝 */ })
    const timeout = new Promise<DocxRenderResult>(resolve => { timer.id = setTimeout(() => resolve({ pages: null }), RENDER_TIMEOUT_MS) })
    const res = await Promise.race([work, timeout])
    if (!res.pages) console.warn(`[docx] 页面图渲染没有完成：${res.note ?? '超时或截图为空'}，退回只提取文字`)
    return res
  } catch (e) {
    console.warn(`[docx] 页面图渲染失败，退回只提取文字：${(e as Error).message}`)
    return { pages: null }
  } finally {
    aborted = true
    if (timer.id) clearTimeout(timer.id)
    try { win?.destroy() } catch { /* 窗口已经没了 */ }
  }
}
