/**
 * Word 试卷的页面图（M9 补充 3）：用 mammoth 转出的 HTML（保留编号、下划线、表格、图片），在一个看不见的窗口里按 A4 宽度排版，
 * 分页截成页面图，同时用 DOM 量出每一行文字的位置写进 lines_json。之后 Word 试卷和图片、PDF 走同一套定位和截图。
 *
 * 隐私：整个过程在本机，窗口不显示、不联网（独立会话 + 拦截所有非 data: 请求 + 内容安全策略），页面里的脚本只有我们注入的这一段。
 * 失败（窗口建不起来、超时、截图为空）一律返回 null，调用方退回原来只提取文字的做法，不让导入失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
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

/** 渲染一份 Word；失败返回 null（原因写进控制台，不抛出） */
export async function renderDocxPages(docxPath: string): Promise<DocxPage[] | null> {
  let win: BrowserWindow | null = null
  let tmp: string | null = null
  const timer: { id?: NodeJS.Timeout } = {}
  try {
    const html = await toHtml(docxPath)
    const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${PAGE_CSS}</style></head><body>${html}</body></html>`
    tmp = path.join(os.tmpdir(), `ewb-docx-${crypto.randomBytes(6).toString('hex')}.html`)
    fs.writeFileSync(tmp, doc, 'utf8')

    // 独立的一次性会话：不带任何 cookie / 缓存，并拦截一切非 data: 请求（本机文件除外，只放行我们这一个临时 HTML）
    const partition = `docx-render-${crypto.randomBytes(6).toString('hex')}`
    const ses = session.fromPartition(partition, { cache: false })
    const allowFile = pathToFileURL(tmp).href
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(details.url.startsWith('data:') || details.url === allowFile || details.url.startsWith('devtools:')) }))
    win = new BrowserWindow({
      show: false, width: A4_WIDTH, height: A4_HEIGHT, useContentSize: true, paintWhenInitiallyHidden: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, zoomFactor: SCALE, spellcheck: false }
    })
    // 窗口按放大后的像素算：内容宽 794 CSS 像素 × 放大倍数
    win.setContentSize(A4_WIDTH * SCALE, A4_HEIGHT * SCALE)
    const w = win
    const work = (async (): Promise<DocxPage[] | null> => {
      await w.loadFile(tmp!)
      await w.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
      // 内联图片异步解码：等所有图片就绪再量
      await w.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)')
      const measured = JSON.parse(await w.webContents.executeJavaScript(measureScript)) as Measured
      const slices = paginate(measured)
      if (slices.length === 0 || slices.length > MAX_PAGES) return null
      const out: DocxPage[] = []
      for (const s of slices) {
        await w.webContents.executeJavaScript(`window.scrollTo(0, ${s.top}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`)
        await sleep(30)
        const img = await w.webContents.capturePage({ x: 0, y: 0, width: A4_WIDTH * SCALE, height: Math.max(1, Math.round(s.height * SCALE)) })
        if (img.isEmpty()) return null
        const size = img.getSize()
        out.push({ idx: s.idx, png: img.toPNG(), width: size.width, height: size.height, lines: s.lines })
      }
      return out
    })()
    const timeout = new Promise<null>(resolve => { timer.id = setTimeout(() => resolve(null), RENDER_TIMEOUT_MS) })
    const res = await Promise.race([work, timeout])
    if (!res) console.warn('[docx] 页面图渲染没有完成（超时或截图为空），退回只提取文字')
    return res
  } catch (e) {
    console.warn(`[docx] 页面图渲染失败，退回只提取文字：${(e as Error).message}`)
    return null
  } finally {
    if (timer.id) clearTimeout(timer.id)
    try { win?.destroy() } catch { /* 窗口已经没了 */ }
    if (tmp) fs.rmSync(tmp, { force: true })
  }
}
