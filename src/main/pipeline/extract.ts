import fs from 'node:fs'
import path from 'node:path'
import { getDb, getFilesDir } from '../db'
import { ocrImage, isOcrAvailable, convertImageToPngMac } from './ocr'
import { renderPdfPages, normalizeImage } from './pdf-renderer'
import { withTimeout } from './util'
import type { OcrLine, JobProgress } from '../types'

export type ProgressCallback = (p: JobProgress) => void

interface PageRow {
  idx: number
  imageRel: string
  width: number
  height: number
  textSource: string
  lines: OcrLine[]
  text: string | null
  ocrConf: number | null
}

const OCR_TIMEOUT_MS = 60_000
const MIN_TEXT_LAYER_CHARS = 50

export function findOriginal(paperDir: string): string | null {
  if (!fs.existsSync(paperDir)) return null
  const name = fs.readdirSync(paperDir).find(f => f.startsWith('original.'))
  return name ? path.join(paperDir, name) : null
}

export function removePageImages(paperDir: string): void {
  if (!fs.existsSync(paperDir)) return
  for (const f of fs.readdirSync(paperDir)) {
    if (/^page-\d+\.png$/.test(f)) fs.rmSync(path.join(paperDir, f), { force: true })
  }
}

/**
 * 提取一份已登记的试卷：先在内存里收集所有页，成功后在一个事务里一次写入，
 * 失败则不留下任何半截 pages 数据。
 */
export async function extractPaper(paperId: string, onProgress: ProgressCallback): Promise<void> {
  const db = getDb()
  const paperDir = path.join(getFilesDir(), paperId)
  const original = findOriginal(paperDir)
  if (!original) throw new Error('找不到原始文件，请删除后重新导入')
  const ext = path.extname(original).toLowerCase()

  db.prepare("UPDATE papers SET status = 'extracting', error = NULL WHERE id = ?").run(paperId)
  onProgress({ paperId, stage: 'extracting', progress: 0, message: '开始提取…' })

  try {
    let pages: PageRow[]
    if (ext === '.pdf') pages = await extractPdf(paperId, original, paperDir, onProgress)
    else if (ext === '.docx') pages = await extractDocx(paperId, original, onProgress)
    else pages = await extractImage(paperId, original, ext, paperDir, onProgress)

    const noText = pages.filter(p => (p.textSource === 'needs_ocr' || p.textSource === 'none'))
    const warning = noText.length > 0
      ? (isOcrAvailable()
        ? `有 ${noText.length} 页没有识别出文字`
        : `有 ${noText.length} 页没有文字：当前平台暂不支持 OCR`)
      : null

    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM pages WHERE paper_id = ?').run(paperId)
      const ins = db.prepare(`
        INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text, ocr_conf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const p of pages) {
        ins.run(paperId, p.idx, p.imageRel, p.width, p.height, p.textSource, JSON.stringify(p.lines), p.text, p.ocrConf)
      }
      db.prepare(`
        UPDATE papers SET status = 'done', error = ?, page_count = ?, extracted_at = datetime('now','localtime')
        WHERE id = ?
      `).run(warning, pages.length, paperId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    onProgress({ paperId, stage: 'done', progress: 100, message: '提取完成' })
  } catch (err) {
    removePageImages(paperDir)
    const msg = (err as Error).message
    db.prepare("UPDATE papers SET status = 'failed', error = ? WHERE id = ?").run(msg, paperId)
    onProgress({ paperId, stage: 'failed', progress: 0, message: msg })
    throw err
  }
}

async function runOcr(imagePath: string, label: string): Promise<{ lines: OcrLine[]; conf: number | null; width: number; height: number } | null> {
  if (!isOcrAvailable()) return null
  try {
    const r = await withTimeout(ocrImage(imagePath), OCR_TIMEOUT_MS, `${label} OCR 超时`)
    const conf = r.lines.length > 0 ? r.lines.reduce((s, l) => s + l.conf, 0) / r.lines.length : null
    return { lines: r.lines, conf, width: r.width, height: r.height }
  } catch (e) {
    console.warn(`[extract] ${label} OCR 失败:`, (e as Error).message)
    return null
  }
}

async function extractPdf(
  paperId: string, pdfPath: string, paperDir: string, onProgress: ProgressCallback
): Promise<PageRow[]> {
  onProgress({ paperId, stage: 'extracting', progress: 5, message: '渲染 PDF 页面…' })
  const rendered = await renderPdfPages(pdfPath, paperDir)
  const rows: PageRow[] = []

  for (let i = 0; i < rendered.length; i++) {
    const rp = rendered[i]
    const progress = 10 + Math.floor(((i + 1) / rendered.length) * 85)
    const base = { idx: rp.index, imageRel: `page-${rp.index}.png`, width: rp.width, height: rp.height }

    // 文本层优先：文字充足就直接用 PDF 自带文本和坐标，不跑 OCR
    if (rp.text.trim().length >= MIN_TEXT_LAYER_CHARS) {
      rows.push({ ...base, textSource: 'pdf-text', lines: rp.lines, text: rp.text, ocrConf: null })
      onProgress({ paperId, stage: 'extracting', progress, message: `第 ${rp.index}/${rendered.length} 页：使用 PDF 文本层` })
      continue
    }

    onProgress({ paperId, stage: 'extracting', progress, message: `OCR 识别第 ${rp.index}/${rendered.length} 页…` })
    const ocr = await runOcr(path.join(paperDir, base.imageRel), `第 ${rp.index} 页`)
    if (ocr && ocr.lines.length > 0) {
      rows.push({ ...base, textSource: 'ocr', lines: ocr.lines, text: ocr.lines.map(l => l.text).join('\n'), ocrConf: ocr.conf })
    } else {
      rows.push({
        ...base,
        textSource: isOcrAvailable() ? 'none' : 'needs_ocr',
        lines: [],
        text: rp.text.trim() || null,
        ocrConf: null
      })
    }
  }
  return rows
}

async function extractImage(
  paperId: string, imagePath: string, ext: string, paperDir: string, onProgress: ProgressCallback
): Promise<PageRow[]> {
  const dest = path.join(paperDir, 'page-1.png')
  onProgress({ paperId, stage: 'extracting', progress: 10, message: '处理图片…' })

  let width = 0
  let height = 0
  if (ext === '.png') {
    fs.copyFileSync(imagePath, dest)
  } else if (ext === '.heic' && process.platform === 'darwin') {
    // Chromium 对 HEIC 的解码和 EXIF 方向支持不可靠，macOS 直接用系统 ImageIO
    ({ width, height } = await convertImageToPngMac(imagePath, dest))
  } else {
    try {
      ({ width, height } = await normalizeImage(imagePath, dest))
    } catch (e) {
      if (ext === '.heic') {
        throw new Error('无法解码 HEIC 图片：Windows 需要安装「HEIF 图像扩展」，或先转成 JPG/PNG')
      }
      throw e
    }
  }

  onProgress({ paperId, stage: 'extracting', progress: 40, message: 'OCR 识别中…' })
  const ocr = await runOcr(dest, '图片')
  if (ocr) { width = ocr.width || width; height = ocr.height || height }
  const hasText = !!ocr && ocr.lines.length > 0

  return [{
    idx: 1, imageRel: 'page-1.png', width, height,
    textSource: hasText ? 'ocr' : (isOcrAvailable() ? 'none' : 'needs_ocr'),
    lines: ocr?.lines ?? [],
    text: hasText ? ocr!.lines.map(l => l.text).join('\n') : null,
    ocrConf: ocr?.conf ?? null
  }]
}

async function extractDocx(paperId: string, docxPath: string, onProgress: ProgressCallback): Promise<PageRow[]> {
  const mammoth = await import('mammoth')
  onProgress({ paperId, stage: 'extracting', progress: 20, message: '提取 Word 文本…' })
  const result = await mammoth.extractRawText({ path: docxPath })
  // docx 没有页面图片，也没有坐标：lines 留空，详情页直接显示文本
  return [{
    idx: 1, imageRel: '', width: 0, height: 0,
    textSource: 'docx', lines: [], text: result.value, ocrConf: null
  }]
}
