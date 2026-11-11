import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { OcrLine } from '../types'
import { withTimeout } from './util'
import { registerPdfSource, releasePdfSource } from './pdf-source'

export interface RenderedPage {
  index: number
  text: string
  /** 来自 PDF 文本层的行，坐标为真实坐标（0-1，左上角原点） */
  lines: OcrLine[]
  width: number
  height: number
}

const PAGE_TIMEOUT_MS = 90_000
const MAX_CANVAS_DIM = 8192
const INIT_TIMEOUT_MS = 60_000

let win: BrowserWindow | null = null
let initPromise: Promise<BrowserWindow> | null = null
let renderLock: Promise<unknown> = Promise.resolve()

function getPdfjsDir(): string {
  return path.dirname(require.resolve('pdfjs-dist/package.json'))
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win
  if (initPromise) return initPromise

  initPromise = withTimeout((async () => {
    const w = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      skipTaskbar: true,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true }
    })

    // 只清理「自己」：旧窗口的 closed 事件可能晚于新窗口创建
    w.on('closed', () => {
      if (win === w) { win = null; initPromise = null }
    })
    w.webContents.on('render-process-gone', () => {
      if (!w.isDestroyed()) w.destroy()
    })

    try {
      // 从 ewb://pdfjs 同源加载，pdf.js 才能取到 CMap / 标准字体
      await w.loadURL('ewb://pdfjs/host.html')

      const pdfjsDir = getPdfjsDir()
      const pdfjsCode = fs.readFileSync(path.join(pdfjsDir, 'legacy/build/pdf.mjs'), 'utf-8')
      const workerCode = fs.readFileSync(path.join(pdfjsDir, 'legacy/build/pdf.worker.mjs'), 'utf-8')

      await w.webContents.executeJavaScript(`
        (async () => {
          const pdfjsUrl = URL.createObjectURL(new Blob([${JSON.stringify(pdfjsCode)}], {type:'text/javascript'}));
          const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}], {type:'text/javascript'}));
          const mod = await import(pdfjsUrl);
          mod.GlobalWorkerOptions.workerSrc = workerUrl;
          window.__pdfjs = mod;
        })()
      `)
    } catch (e) {
      if (!w.isDestroyed()) w.destroy()   // 初始化失败不能留下隐藏窗口，否则 Windows 上 window-all-closed 永不触发
      throw e
    }

    win = w
    return w
  })(), INIT_TIMEOUT_MS, 'PDF 渲染组件初始化超时', () => destroyPdfRenderer())

  initPromise.catch(() => { initPromise = null })
  return initPromise
}

/** 渲染与规范化共用同一个画布，必须串行 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = renderLock.then(task, task)
  renderLock = run.catch(() => undefined)
  return run
}

function translatePdfError(raw: string): string {
  if (/password/i.test(raw)) return 'PDF 已加密，无法读取（请先去除密码保护）'
  if (/invalid pdf|missing pdf|unexpected server response|formaterror/i.test(raw)) {
    return '不是有效的 PDF 文件，或文件已损坏'
  }
  return `PDF 渲染失败：${raw}`
}

/**
 * 逐页渲染：每渲染完一页立即把 PNG 落盘并释放，避免整本文档的 base64 一次性回传。
 */
export class PdfPageLimitError extends Error {
  /** @param pages 要处理的页数（选了页码范围就是选中的页数）；total = 文件总页数 */
  constructor(public pages: number, public max: number, public total: number = pages) { super(`PDF 有 ${pages} 页，超过 ${max} 页的上限`) }
}
export class PdfCancelledError extends Error {
  constructor() { super('已取消') }
}

export interface RenderOptions {
  /** 要处理的页数超限就立刻抛 PdfPageLimitError，不渲染（考卷导入不传 = 不限） */
  maxPages?: number
  /** 只处理这些页（1 起，已排序去重）；不传 = 全部 */
  pages?: number[]
  /** 取消：每页之前检查，已渲染的页保留在磁盘上由调用方清理 */
  signal?: AbortSignal
  /** 每处理完一页回调（done / total） */
  onPage?: (done: number, total: number) => void
  /**
   * 只读文字、不出图：文本层可用（返回 false = 不需要图）的页跳过画布渲染和 PNG 落盘，速度和内存都小得多。
   * 不传 = 每页都出图（考卷导入要展示页面图）
   */
  needImage?: (pageText: string) => boolean
}

const SOURCE_CHUNK = 1 << 20

/** 登记文件 → 在窗口里用 Range 分块读（pdf.js 的 PDFDataRangeTransport），返回页数；窗口里不出现整本文件 */
async function openDoc(w: BrowserWindow, token: string, size: number): Promise<number> {
  try {
    return await withTimeout(
      w.webContents.executeJavaScript(`
        (async () => {
          const url = 'ewb://pdfsrc/${token}';
          const size = ${size};
          const get = async (b, e) => new Uint8Array(await (await fetch(url, { headers: { Range: 'bytes=' + b + '-' + (e - 1) } })).arrayBuffer());
          const tr = new window.__pdfjs.PDFDataRangeTransport(size, await get(0, Math.min(size, 65536)));
          tr.requestDataRange = (b, e) => { get(b, Math.min(e, size)).then(c => tr.onDataRange(b, c), () => {}); };
          window.__doc = await window.__pdfjs.getDocument({
            range: tr,
            length: size,
            rangeChunkSize: ${SOURCE_CHUNK},
            disableAutoFetch: true,
            disableStream: true,
            cMapUrl: 'ewb://pdfjs/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'ewb://pdfjs/standard_fonts/',
            useSystemFonts: true,
            isEvalSupported: false
          }).promise;
          return window.__doc.numPages;
        })()
      `),
      PAGE_TIMEOUT_MS, 'PDF 打开超时', () => destroyPdfRenderer()
    )
  } catch (e) {
    throw new Error(translatePdfError((e as Error).message))
  }
}

async function closeDoc(): Promise<void> {
  if (win && !win.isDestroyed()) {
    await win.webContents.executeJavaScript('if(window.__doc){window.__doc.destroy();window.__doc=null;}').catch(() => {})
  }
}

/** 只数页数（不渲染） */
export function countPdfPages(pdfPath: string): Promise<number> {
  return serialized(async () => {
    const w = await ensureWindow()
    const token = registerPdfSource(pdfPath)
    try {
      return await openDoc(w, token, fs.statSync(pdfPath).size)
    } finally {
      releasePdfSource(token)
      await closeDoc()
    }
  })
}

/** @param opts 数字 = maxPages（旧用法）；也可传 RenderOptions */
export function renderPdfPages(pdfPath: string, outputDir: string, opts?: number | RenderOptions): Promise<RenderedPage[]> {
  const o: RenderOptions = typeof opts === 'number' ? { maxPages: opts } : opts ?? {}
  return serialized(async () => {
    const w = await ensureWindow()
    const timeoutKill = () => destroyPdfRenderer()
    const token = registerPdfSource(pdfPath)
    const results: RenderedPage[] = []
    try {
      const numPages = await openDoc(w, token, fs.statSync(pdfPath).size)
      const todo = o.pages ? o.pages.filter(n => n >= 1 && n <= numPages) : Array.from({ length: numPages }, (_, i) => i + 1)
      if (o.maxPages != null && todo.length > o.maxPages) throw new PdfPageLimitError(todo.length, o.maxPages, numPages)
      for (const [k, i] of todo.entries()) {
        if (o.signal?.aborted) throw new PdfCancelledError()
        const run = (withImage: boolean) => withTimeout(
          w.webContents.executeJavaScript(`(${renderPageScript})(${i}, ${MAX_CANVAS_DIM}, ${withImage})`),
          PAGE_TIMEOUT_MS, `渲染第 ${i} 页超时`, timeoutKill
        ).catch((e: Error) => { throw new Error(translatePdfError(e.message)) }) as Promise<RenderedPage & { pngBase64: string }>
        let page = await run(!o.needImage)
        if (o.needImage && o.needImage(page.text)) page = await run(true)   // 第一遍只读文字；文字不可用才再出图（OCR 用）
        if (page.pngBase64) fs.writeFileSync(path.join(outputDir, `page-${page.index}.png`), Buffer.from(page.pngBase64, 'base64'))
        const { pngBase64: _drop, ...rest } = page
        results.push(rest)
        o.onPage?.(k + 1, todo.length)
      }
    } finally {
      releasePdfSource(token)
      await closeDoc()
    }
    return results
  })
}

// 在隐藏窗口里执行的页面脚本。用 String.raw 保持反斜杠原样；脚本内不得使用模板字符串。
const renderPageScript = String.raw`async function (pageNo, maxDim, withImage) {
  const pdfjs = window.__pdfjs;
  const doc = window.__doc;
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxDim / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale: scale });

  const canvas = document.getElementById('c');
  let bin = '';
  if (withImage) {
    const ctx = canvas.getContext('2d');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const blob = await new Promise(function (r) { canvas.toBlob(r, 'image/png'); });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let j = 0; j < bytes.length; j += 8192) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(j, Math.min(j + 8192, bytes.length))));
    }
  }

  // 文本层 -> 行（按基线分组），坐标来自 PDF 本身
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (!('str' in it) || !it.str) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(t[2], t[3]) || 1;
    const x = t[4];
    const baseY = t[5];
    const w = it.width * vp.scale;
    if (!it.str.trim() && !cur) continue;
    if (cur && Math.abs(baseY - cur.base) <= cur.h * 0.5 && x >= cur.x0 - 1) {
      const gap = x - cur.x1;
      if (gap > h * 0.25 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += it.str;
      cur.x1 = Math.max(cur.x1, x + w);
      cur.y0 = Math.min(cur.y0, baseY - h);
      cur.y1 = Math.max(cur.y1, baseY + h * 0.25);
    } else {
      cur = { text: it.str, x0: x, y0: baseY - h, x1: x + w, y1: baseY + h * 0.25, base: baseY, h: h };
      lines.push(cur);
    }
  }
  const clamp = function (v) { return Math.min(1, Math.max(0, v)); };
  const outLines = lines
    .map(function (l) { return { text: l.text.trim(), x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }; })
    .filter(function (l) { return l.text; })
    .map(function (l) {
      return {
        text: l.text,
        x: clamp(l.x0 / vp.width),
        y: clamp(l.y0 / vp.height),
        w: clamp((l.x1 - l.x0) / vp.width),
        h: clamp((l.y1 - l.y0) / vp.height),
        conf: 1
      };
    });

  page.cleanup();
  return {
    index: pageNo,
    pngBase64: btoa(bin),
    text: outLines.map(function (l) { return l.text; }).join('\n'),
    lines: outLines,
    width: Math.round(vp.width),
    height: Math.round(vp.height)
  };
}`

/**
 * 图片规范化：让 Chromium 按 EXIF 方向解码，再统一重新编码为 PNG。
 * 这样展示图、OCR 输入与叠加坐标都在同一个朝向下。
 */
export function normalizeImage(srcPath: string, destPngPath: string): Promise<{ width: number; height: number }> {
  return serialized(async () => {
    const w = await ensureWindow()
    const token = registerPdfSource(srcPath)   // 图片也经协议读，不再整份 base64 塞进脚本
    let out: { pngBase64: string; width: number; height: number }
    try {
      out = await withTimeout(
        w.webContents.executeJavaScript(`
          (async () => {
            const blob0 = await (await fetch('ewb://pdfsrc/${token}')).blob();
            const bmp = await createImageBitmap(blob0, { imageOrientation: 'from-image' });
            const k = Math.min(1, ${MAX_CANVAS_DIM} / Math.max(bmp.width, bmp.height));
            const canvas = document.getElementById('c');
            canvas.width = Math.round(bmp.width * k);
            canvas.height = Math.round(bmp.height * k);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            bmp.close();
            const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
            const u8 = new Uint8Array(await blob.arrayBuffer());
            let bin = '';
            for (let j = 0; j < u8.length; j += 8192) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(j, Math.min(j + 8192, u8.length))));
            return { pngBase64: btoa(bin), width: canvas.width, height: canvas.height };
          })()
        `),
        PAGE_TIMEOUT_MS, '图片处理超时', () => destroyPdfRenderer()
      )
    } catch (e) {
      throw new Error(`无法解码该图片（${(e as Error).message}）`)
    } finally {
      releasePdfSource(token)
    }
    fs.writeFileSync(destPngPath, Buffer.from(out.pngBase64, 'base64'))
    return { width: out.width, height: out.height }
  })
}

export function destroyPdfRenderer(): void {
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
  win = null
  initPromise = null
}
