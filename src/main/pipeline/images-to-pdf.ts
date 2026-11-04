/**
 * 几张图片合成一份 PDF（一张一页，按顺序）：助手把用户贴的多张试卷截图导入成「一份试卷」时用。
 * 用隐藏窗口 + printToPDF，不需要额外依赖；HEIC 先转 PNG，其它格式统一转成 PNG 再嵌入，页面不联网、没有脚本。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, session } from 'electron'
import { convertImageToPngMac } from './ocr'
import { normalizeImage } from './pdf-renderer'

let sess: Electron.Session | null = null
function getSession(): Electron.Session {
  if (!sess) {
    sess = session.fromPartition('images-to-pdf', { cache: false })
    sess.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith('data:') || d.url.startsWith('about:')) }))
    sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  }
  return sess
}

async function toPng(src: string, dir: string, i: number): Promise<string> {
  const ext = path.extname(src).toLowerCase()
  const dest = path.join(dir, `p${i}.png`)
  if (ext === '.png') fs.copyFileSync(src, dest)
  else if (ext === '.heic' && process.platform === 'darwin') await convertImageToPngMac(src, dest)
  else await normalizeImage(src, dest)
  return dest
}

/** 把 images 按顺序合成一份 PDF，写到 outFile */
export async function imagesToPdf(images: string[], outFile: string): Promise<void> {
  if (!images.length) throw new Error('没有图片')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-img2pdf-'))
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } })
  try {
    const pngs: string[] = []
    for (const [i, f] of images.entries()) pngs.push(await toPng(f, dir, i))
    const imgs = pngs.map(p => `<div class="pg"><img src="data:image/png;base64,${fs.readFileSync(p).toString('base64')}"></div>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>@page{size:A4;margin:0}html,body{margin:0;padding:0}.pg{width:210mm;height:297mm;display:flex;align-items:center;justify-content:center;page-break-after:always;overflow:hidden}.pg:last-child{page-break-after:auto}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body>${imgs}</body></html>`
    await win.loadURL('about:blank')
    await win.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();true`)
    await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode ? i.decode().catch(() => {}) : null)).then(() => true)')
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    fs.writeFileSync(outFile, pdf)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
