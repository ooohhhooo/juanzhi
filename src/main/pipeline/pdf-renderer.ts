import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { OcrLine } from '../types'
import { withTimeout } from './util'

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
export function renderPdfPages(pdfPath: string, outputDir: string): Promise<RenderedPage[]> {
  return serialized(async () => {
    const w = await ensureWindow()
    const b64 = fs.readFileSync(pdfPath).toString('base64')
    const timeoutKill = () => destroyPdfRenderer()

    let numPages: number
    try {
      numPages = await withTimeout(
        w.webContents.executeJavaScript(`
          (async () => {
            const raw = atob(${JSON.stringify(b64)});
            const data = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
            window.__doc = await window.__pdfjs.getDocument({
              data,
              cMapUrl: 'ewb://pdfjs/cmaps/',
              cMapPacked: true,
              standardFontDataUrl: 'ewb://pdfjs/standard_fonts/',
              useSystemFonts: true,
              isEvalSupported: false
            }).promise;
            return window.__doc.numPages;
          })()
        `),
        PAGE_TIMEOUT_MS, 'PDF 打开超时', timeoutKill
      )
    } catch (e) {
      throw new Error(translatePdfError((e as Error).message))
    }

    const results: RenderedPage[] = []
    try {
      for (let i = 1; i <= numPages; i++) {
        const page = await withTimeout(
          w.webContents.executeJavaScript(`(${renderPageScript})(${i}, ${MAX_CANVAS_DIM})`),
          PAGE_TIMEOUT_MS, `渲染第 ${i} 页超时`, timeoutKill
        ).catch((e: Error) => { throw new Error(translatePdfError(e.message)) }) as RenderedPage & { pngBase64: string }

        fs.writeFileSync(path.join(outputDir, `page-${page.index}.png`), Buffer.from(page.pngBase64, 'base64'))
        const { pngBase64: _drop, ...rest } = page
        results.push(rest)
      }
    } finally {
      if (win && !win.isDestroyed()) {
        await win.webContents.executeJavaScript('if(window.__doc){window.__doc.destroy();window.__doc=null;}').catch(() => {})
      }
    }
    return results
  })
}

// 在隐藏窗口里执行的页面脚本。用 String.raw 保持反斜杠原样；脚本内不得使用模板字符串。
const renderPageScript = String.raw`async function (pageNo, maxDim) {
  const pdfjs = window.__pdfjs;
  const doc = window.__doc;
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxDim / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale: scale });

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  const blob = await new Promise(function (r) { canvas.toBlob(r, 'image/png'); });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let j = 0; j < bytes.length; j += 8192) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(j, Math.min(j + 8192, bytes.length))));
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
    width: canvas.width,
    height: canvas.height
  };
}`

/**
 * 图片规范化：让 Chromium 按 EXIF 方向解码，再统一重新编码为 PNG。
 * 这样展示图、OCR 输入与叠加坐标都在同一个朝向下。
 */
export function normalizeImage(srcPath: string, destPngPath: string): Promise<{ width: number; height: number }> {
  return serialized(async () => {
    const w = await ensureWindow()
    const b64 = fs.readFileSync(srcPath).toString('base64')
    let out: { pngBase64: string; width: number; height: number }
    try {
      out = await withTimeout(
        w.webContents.executeJavaScript(`
          (async () => {
            const raw = atob(${JSON.stringify(b64)});
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
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
