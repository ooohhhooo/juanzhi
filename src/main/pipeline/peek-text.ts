/**
 * 便宜地看一眼文件里的文字，给「导入自动分流」判断像不像试卷用（依赖 electron，单测不加载）：
 * pdf 只取文字层（不做 OCR，扫描件返回 null）；docx 取正文。读不出来一律返回 null，由调用方当试卷处理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPdfPages } from './pdf-renderer'
import { judgeTextLayer } from './textquality'
import { wordText } from '../agent/attachments'
import { extOf } from './auto-route'

/** 超过这么多页的 PDF 不看（多半是整本书或大套卷，按试卷处理） */
const PEEK_MAX_PAGES = 30

export async function peekText(file: string): Promise<string | null> {
  const ext = extOf(file)
  try {
    if (ext === '.docx') return (await wordText(file)) || null
    if (ext === '.pdf') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-peek-'))
      try {
        const pages = await renderPdfPages(file, dir, PEEK_MAX_PAGES)
        const usable = pages.filter(p => judgeTextLayer(p.text).usable).map(p => p.text)
        return usable.length ? usable.join('\n') : null
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    }
  } catch { /* 读不出来就当试卷 */ }
  return null
}
