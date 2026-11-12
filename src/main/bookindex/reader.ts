/**
 * 书库：从 PDF 取逐页文字（需要 electron：渲染窗口读文字层，扫描页走系统文字识别）。
 * 复用试卷导入 / 教材上传用的那一套（pipeline/pdf-renderer、ocr），这里只做“整本书逐页取字”。
 * 日志只记页数，不记内容和文件名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isOcrAvailable, ocrImage } from '../pipeline/ocr'
import { PdfCancelledError, renderPdfPages } from '../pipeline/pdf-renderer'

/** 全书的文字层：每页一个行数组（没有文字层的页是空数组）。只读文字、不出图，很快 */
export async function readTextLayer(file: string, signal: AbortSignal | undefined, onPage: (done: number, total: number) => void): Promise<string[][]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-book-'))
  try {
    let pages
    try { pages = await renderPdfPages(file, dir, { signal, needImage: () => false, onPage }) } catch (e) {
      if (e instanceof PdfCancelledError) throw new Error('已取消')
      throw e
    }
    const out: string[][] = []
    for (const p of pages.sort((a, b) => a.index - b.index)) out[p.index - 1] = p.lines.length ? p.lines.map(l => l.text) : p.text.split('\n')
    for (let i = 0; i < out.length; i++) out[i] ??= []
    return out
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export const ocrAvailable = (): boolean => isOcrAvailable()

/** 文字识别某一页（渲染成图再识别）；返回识别出的行 */
export function makeOcr(file: string, signal?: AbortSignal): { run: (page: number) => Promise<string[]>; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-book-ocr-'))
  return {
    run: async page => {
      const rp = await renderPdfPages(file, dir, { pages: [page], signal, needImage: () => true })
      const png = path.join(dir, `page-${rp[0]?.index ?? page}.png`)
      try { return (await ocrImage(png)).lines.map(l => l.text) } finally { fs.rmSync(png, { force: true }) }
    },
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}
