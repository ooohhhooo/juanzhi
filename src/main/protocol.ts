import { protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { getFilesDir } from './db'
import { parseRange, pdfSourcePath } from './pipeline/pdf-source'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PAGE_FILE_RE = /^page-\d+\.png$/
const MEDIA_FILE_RE = /^\d+\.(png|jpg|gif)$/
const MEDIA_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' }

export function registerProtocol(): void {
  protocol.handle('ewb', (request) => {
    const url = new URL(request.url)
    switch (url.hostname) {
      case 'page': return serveFile(request, url, PAGE_FILE_RE, () => 'image/png', false)
      case 'media': return serveFile(request, url, MEDIA_FILE_RE, f => MEDIA_MIME[f.split('.').pop()!], true)
      case 'pdfjs': return handlePdfjsAsset(url)
      case 'pdfsrc': return handlePdfSource(request, url)
      default: return new Response('Not found', { status: 404 })
    }
  })
}

/**
 * ewb://page/<paperId>/page-<n>.png        页面图
 * ewb://media/<paperId>/<n>.<png|jpg|gif>   docx 内嵌图片（存放在 files/<paperId>/media/）
 * 只放行白名单文件名；原件（original.*）永远不可经协议读取。
 */
async function serveFile(
  request: Request, url: URL, fileRe: RegExp, mimeOf: (file: string) => string, inMediaDir: boolean
): Promise<Response> {
  const [paperId = '', fileName = ''] = url.pathname.replace(/^\//, '').split('/')
  if (!UUID_RE.test(paperId)) return new Response('Bad request: invalid paperId', { status: 400 })
  if (!fileRe.test(fileName)) return new Response('Bad request: invalid filename', { status: 400 })

  const filesDir = path.resolve(getFilesDir())
  const resolved = path.resolve(filesDir, paperId, inMediaDir ? 'media' : '', fileName)
  if (!resolved.startsWith(filesDir + path.sep)) return new Response('Forbidden: path traversal', { status: 403 })

  const stat = await fs.promises.stat(resolved).catch(() => null)
  if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 })

  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`
  const headers = new Headers({ 'Content-Type': mimeOf(fileName), 'Cache-Control': 'no-cache', ETag: etag })
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })

  const resp = await net.fetch(pathToFileURL(resolved).href)
  return new Response(resp.body, { status: 200, headers })
}

const PDFJS_DIRS = new Set(['cmaps', 'standard_fonts'])
const PDFJS_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// 隐藏渲染窗口（加载不可信 PDF）的页面：脚本只允许 blob（pdf.js 与 worker），不能联网
const HOST_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src ewb:; img-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'">
</head><body><canvas id="c"></canvas></body></html>`

/**
 * ewb://pdfsrc/<令牌>：隐藏渲染窗口读「正在处理的那一个」PDF / 图片。令牌由主进程登记、用完即废，窗口只能读它；支持 Range（pdf.js 分块读）。
 */
async function handlePdfSource(request: Request, url: URL): Promise<Response> {
  const token = url.pathname.replace(/^\//, '')
  const file = UUID_RE.test(token) ? pdfSourcePath(token) : null
  if (!file) return new Response('Not found', { status: 404 })
  const stat = await fs.promises.stat(file).catch(() => null)
  if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 })
  const size = stat.size
  const base = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'bad') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...base, 'Content-Length': '0' } })
  const [start, end] = range ? [range.start, range.end] : [0, size - 1]
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream
  const headers: Record<string, string> = { ...base, 'Content-Length': String(end - start + 1) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** 供隐藏渲染窗口使用：host 页面、CMap 与标准字体。只开放这两个目录里的文件。 */
async function handlePdfjsAsset(url: URL): Promise<Response> {
  if (url.pathname === '/host.html') {
    return new Response(HOST_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  const [dir, file] = url.pathname.replace(/^\//, '').split('/')
  if (!PDFJS_DIRS.has(dir) || !file || !PDFJS_FILE_RE.test(file)) {
    return new Response('Bad request', { status: 400 })
  }
  const resolved = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), dir, file)
  try {
    // 直接读文件而不是 net.fetch(file://)：打包进 asar 后 fs 才是 asar 感知的
    const data = await fs.promises.readFile(resolved)
    return new Response(data, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
