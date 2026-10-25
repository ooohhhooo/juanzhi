import { protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getFilesDir } from './db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PAGE_FILE_RE = /^page-\d+\.png$/

export function registerProtocol(): void {
  protocol.handle('ewb', (request) => {
    const url = new URL(request.url)
    const host = url.hostname

    if (host === 'page') {
      return handlePageImage(url)
    }
    if (host === 'pdfjs') {
      return handlePdfjsAsset(url)
    }

    return new Response('Not found', { status: 404 })
  })
}

async function handlePageImage(url: URL): Promise<Response> {
  const parts = url.pathname.replace(/^\//, '').split('/')
  const paperId = parts[0] || ''
  const fileName = parts[1] || ''

  if (!UUID_RE.test(paperId)) {
    return new Response('Bad request: invalid paperId', { status: 400 })
  }

  if (!PAGE_FILE_RE.test(fileName)) {
    return new Response('Bad request: invalid filename', { status: 400 })
  }

  const filesDir = getFilesDir()
  const filePath = path.join(filesDir, paperId, fileName)
  const resolved = path.resolve(filePath)
  const base = path.resolve(filesDir) + path.sep

  if (!resolved.startsWith(base)) {
    return new Response('Forbidden: path traversal', { status: 403 })
  }

  if (!fs.existsSync(resolved)) {
    return new Response('Not found', { status: 404 })
  }

  try {
    const stat = fs.statSync(resolved)
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`

    return net.fetch(pathToFileURL(resolved).href).then(resp => {
      const headers = new Headers(resp.headers)
      headers.set('Content-Type', 'image/png')
      headers.set('Cache-Control', 'no-cache')
      headers.set('ETag', etag)
      return new Response(resp.body, { status: 200, headers })
    })
  } catch {
    return new Response('Internal error', { status: 500 })
  }
}

const PDFJS_DIRS = new Set(['cmaps', 'standard_fonts'])
const PDFJS_FILE_RE = /^[A-Za-z0-9_.-]+$/

/** 供隐藏渲染窗口使用：host 页面、CMap 与标准字体。只开放这两个目录里的文件。 */
async function handlePdfjsAsset(url: URL): Promise<Response> {
  if (url.pathname === '/host.html') {
    return new Response(
      '<!DOCTYPE html><html><body><canvas id="c"></canvas></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
  }
  const [dir, file] = url.pathname.replace(/^\//, '').split('/')
  if (!PDFJS_DIRS.has(dir) || !file || !PDFJS_FILE_RE.test(file)) {
    return new Response('Bad request', { status: 400 })
  }
  const resolved = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), dir, file)
  if (!fs.existsSync(resolved)) return new Response('Not found', { status: 404 })
  const resp = await net.fetch(pathToFileURL(resolved).href)
  return new Response(resp.body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
}
