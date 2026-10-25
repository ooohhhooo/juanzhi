import fs from 'node:fs'
import path from 'node:path'
import { getDb, getFilesDir } from '../db'
import { ocrImage, isOcrAvailable, convertImageToPngMac, OcrError } from './ocr'
import { renderPdfPages, normalizeImage } from './pdf-renderer'
import { judgeTextLayer } from './textquality'
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
  ocrError: string | null
  textLayerChars: number | null
}

interface AssetRow {
  pageIdx: number
  seq: number
  relPath: string
  mime: string
  bytes: number
}

interface Extracted {
  pages: PageRow[]
  assets: AssetRow[]
  /** 与具体页面无关的提示，会并入试卷的 warning */
  notes: string[]
}

export function findOriginal(paperDir: string): string | null {
  if (!fs.existsSync(paperDir)) return null
  const name = fs.readdirSync(paperDir).find(f => f.startsWith('original.'))
  return name ? path.join(paperDir, name) : null
}

export function removeDerivedFiles(paperDir: string): void {
  if (!fs.existsSync(paperDir)) return
  for (const f of fs.readdirSync(paperDir)) {
    if (/^page-\d+\.png$/.test(f)) fs.rmSync(path.join(paperDir, f), { force: true })
  }
  fs.rmSync(path.join(paperDir, 'media'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function summarizeWarning(pages: PageRow[], notes: string[]): string | null {
  const parts: string[] = []
  const failed = pages.filter(p => p.textSource === 'ocr_failed')
  const needs = pages.filter(p => p.textSource === 'needs_ocr')
  const blank = pages.filter(p => p.textSource === 'none')
  if (failed.length) parts.push(`有 ${failed.length} 页 OCR 没有成功：${failed[0].ocrError ?? '原因未知'}`)
  if (needs.length) parts.push(`有 ${needs.length} 页没有文字：当前平台暂不支持 OCR`)
  if (blank.length) parts.push(`有 ${blank.length} 页 OCR 已运行但没有识别出文字（可能是空白页或纯图）`)
  parts.push(...notes)
  return parts.length ? parts.join('；') : null
}

/**
 * 提取一份已登记的试卷：先在内存里收集所有页，成功后在一个事务里一次写入，
 * 失败则不留下任何半截 pages 数据。完成后状态为 extracted（解析是 M2 的事）。
 */
export async function extractPaper(paperId: string, onProgress: ProgressCallback): Promise<void> {
  const db = getDb()
  const paperDir = path.join(getFilesDir(), paperId)
  const original = findOriginal(paperDir)
  if (!original) throw new Error('找不到原始文件，请删除后重新导入')
  const ext = path.extname(original).toLowerCase()

  db.prepare("UPDATE papers SET status = 'extracting', error = NULL, warning = NULL WHERE id = ?").run(paperId)
  onProgress({ paperId, stage: 'extracting', progress: 0, message: '开始提取…' })

  try {
    let result: Extracted
    if (ext === '.pdf') result = await extractPdf(paperId, original, paperDir, onProgress)
    else if (ext === '.docx') result = await extractDocx(paperId, original, paperDir, onProgress)
    else result = await extractImage(paperId, original, ext, paperDir, onProgress)

    const warning = summarizeWarning(result.pages, result.notes)

    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM pages WHERE paper_id = ?').run(paperId)
      db.prepare('DELETE FROM paper_assets WHERE paper_id = ?').run(paperId)
      const insPage = db.prepare(`
        INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text, ocr_conf, ocr_error, text_layer_chars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const p of result.pages) {
        insPage.run(paperId, p.idx, p.imageRel, p.width, p.height, p.textSource, JSON.stringify(p.lines),
          p.text, p.ocrConf, p.ocrError, p.textLayerChars)
      }
      const insAsset = db.prepare(
        'INSERT INTO paper_assets (paper_id, page_idx, seq, rel_path, mime, bytes) VALUES (?, ?, ?, ?, ?, ?)')
      for (const a of result.assets) insAsset.run(paperId, a.pageIdx, a.seq, a.relPath, a.mime, a.bytes)
      db.prepare(`
        UPDATE papers SET status = 'extracted', error = NULL, warning = ?, page_count = ?,
          extracted_at = datetime('now','localtime')
        WHERE id = ?
      `).run(warning, result.pages.length, paperId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    onProgress({ paperId, stage: 'extracted', progress: 100, message: '提取完成' })
  } catch (err) {
    removeDerivedFiles(paperDir)
    const msg = (err as Error).message
    db.prepare("UPDATE papers SET status = 'failed', error = ? WHERE id = ?").run(msg, paperId)
    onProgress({ paperId, stage: 'failed', progress: 0, message: msg })
    throw err
  }
}

type OcrOutcome =
  | { ok: true; lines: OcrLine[]; conf: number | null; width: number; height: number; lang?: string }
  | { ok: false; reason: string }

/** 区分「OCR 跑成功但没字」与「OCR 没跑成」：失败时把原因带出来，而不是吞掉 */
async function runOcr(imagePath: string): Promise<OcrOutcome> {
  try {
    const r = await ocrImage(imagePath)
    const conf = r.lines.length > 0 ? r.lines.reduce((s, l) => s + l.conf, 0) / r.lines.length : null
    return { ok: true, lines: r.lines, conf, width: r.width, height: r.height, lang: r.lang }
  } catch (e) {
    const reason = e instanceof OcrError ? e.message : `OCR 失败：${(e as Error).message}`
    console.warn('[extract] OCR 失败:', reason)
    return { ok: false, reason }
  }
}

function noteLang(notes: string[], lang: string | undefined): void {
  if (lang && !/^zh/i.test(lang) && !notes.some(n => n.startsWith('OCR 使用'))) {
    notes.push(`OCR 使用 ${lang} 引擎，中文可能识别不全（请在系统里添加中文（简体）OCR 语言包）`)
  }
}

async function extractPdf(
  paperId: string, pdfPath: string, paperDir: string, onProgress: ProgressCallback
): Promise<Extracted> {
  onProgress({ paperId, stage: 'extracting', progress: 5, message: '渲染 PDF 页面…' })
  const rendered = await renderPdfPages(pdfPath, paperDir)
  const pages: PageRow[] = []
  const notes: string[] = []

  for (let i = 0; i < rendered.length; i++) {
    const rp = rendered[i]
    const progress = 10 + Math.floor(((i + 1) / rendered.length) * 85)
    const base = { idx: rp.index, imageRel: `page-${rp.index}.png`, width: rp.width, height: rp.height }
    const verdict = judgeTextLayer(rp.text)

    // 文本层优先：可信就直接用 PDF 自带文本和坐标，不跑 OCR
    if (verdict.usable) {
      pages.push({ ...base, textSource: 'pdf-text', lines: rp.lines, text: rp.text, ocrConf: null, ocrError: null, textLayerChars: verdict.chars })
      onProgress({ paperId, stage: 'extracting', progress, message: `第 ${rp.index}/${rendered.length} 页：使用 PDF 文本层` })
      continue
    }

    const layerText = rp.text.trim() || null
    if (!isOcrAvailable()) {
      pages.push({ ...base, textSource: 'needs_ocr', lines: [], text: layerText, ocrConf: null, ocrError: null, textLayerChars: verdict.chars })
      continue
    }

    onProgress({ paperId, stage: 'extracting', progress, message: `OCR 识别第 ${rp.index}/${rendered.length} 页（${verdict.reason}）…` })
    const ocr = await runOcr(path.join(paperDir, base.imageRel))
    if (!ocr.ok) {
      pages.push({ ...base, textSource: 'ocr_failed', lines: [], text: layerText, ocrConf: null, ocrError: ocr.reason, textLayerChars: verdict.chars })
    } else if (ocr.lines.length === 0) {
      pages.push({ ...base, textSource: 'none', lines: [], text: layerText, ocrConf: null, ocrError: null, textLayerChars: verdict.chars })
    } else {
      noteLang(notes, ocr.lang)
      pages.push({
        ...base, textSource: 'ocr', lines: ocr.lines, text: ocr.lines.map(l => l.text).join('\n'),
        ocrConf: ocr.conf, ocrError: null, textLayerChars: verdict.chars
      })
    }
  }
  return { pages, assets: [], notes }
}

/** 直接读 PNG 头里的宽高，OCR 不可用/失败时也能记录尺寸 */
function readPngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(24)
    fs.readSync(fd, buf, 0, 24, 0)
    if (buf.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } finally {
    fs.closeSync(fd)
  }
}

async function extractImage(
  paperId: string, imagePath: string, ext: string, paperDir: string, onProgress: ProgressCallback
): Promise<Extracted> {
  const dest = path.join(paperDir, 'page-1.png')
  onProgress({ paperId, stage: 'extracting', progress: 10, message: '处理图片…' })

  if (ext === '.png') {
    fs.copyFileSync(imagePath, dest)
  } else if (ext === '.heic' && process.platform === 'darwin') {
    // Chromium 对 HEIC 的解码和 EXIF 方向支持不可靠，macOS 直接用系统 ImageIO
    await convertImageToPngMac(imagePath, dest)
  } else {
    try {
      await normalizeImage(imagePath, dest)
    } catch (e) {
      if (ext === '.heic') {
        throw new Error('无法解码 HEIC 图片：Windows 需要安装「HEIF 图像扩展」，或先转成 JPG/PNG')
      }
      throw e
    }
  }
  let { width, height } = readPngSize(dest)

  const notes: string[] = []
  const base = { idx: 1, imageRel: 'page-1.png', textLayerChars: null }
  if (!isOcrAvailable()) {
    return { pages: [{ ...base, width, height, textSource: 'needs_ocr', lines: [], text: null, ocrConf: null, ocrError: null }], assets: [], notes }
  }

  onProgress({ paperId, stage: 'extracting', progress: 40, message: 'OCR 识别中…' })
  const ocr = await runOcr(dest)
  if (!ocr.ok) {
    return { pages: [{ ...base, width, height, textSource: 'ocr_failed', lines: [], text: null, ocrConf: null, ocrError: ocr.reason }], assets: [], notes }
  }
  width = ocr.width || width
  height = ocr.height || height
  noteLang(notes, ocr.lang)
  const hasText = ocr.lines.length > 0
  return {
    pages: [{
      ...base, width, height, textSource: hasText ? 'ocr' : 'none', lines: ocr.lines,
      text: hasText ? ocr.lines.map(l => l.text).join('\n') : null, ocrConf: ocr.conf, ocrError: null
    }],
    assets: [], notes
  }
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif' }

function htmlToText(html: string): string {
  return html
    .replace(/<img[^>]*src="ewb-asset-(\d+)"[^>]*\/?>/g, (_m, n) => `\n[图${n}]\n`)
    .replace(/<img[^>]*\/?>/g, '\n[图（格式不支持，未提取）]\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|table|ul|ol)>/g, '\n')
    .replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
}

async function extractDocx(
  paperId: string, docxPath: string, paperDir: string, onProgress: ProgressCallback
): Promise<Extracted> {
  const m: any = await import('mammoth')
  const mammoth = m.default ?? m
  onProgress({ paperId, stage: 'extracting', progress: 20, message: '提取 Word 文本与图片…' })

  const mediaDir = path.join(paperDir, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  const assets: AssetRow[] = []
  let unsupported = 0

  // 图片按文档顺序落盘成 media/<n>.<ext>，文本里用 [图n] 占位保持相对位置
  const converted = await mammoth.convertToHtml({ path: docxPath }, {
    convertImage: mammoth.images.imgElement(async (image: any) => {
      const ext = IMAGE_EXT[String(image.contentType).toLowerCase()]
      if (!ext) { unsupported++; return { src: 'ewb-unsupported' } }
      const buf: Buffer = await image.read()
      const seq = assets.length + 1
      const rel = `media/${seq}.${ext}`
      fs.writeFileSync(path.join(paperDir, rel), buf)
      assets.push({ pageIdx: 1, seq, relPath: rel, mime: String(image.contentType), bytes: buf.length })
      return { src: `ewb-asset-${seq}` }
    })
  })
  const text = htmlToText(converted.value)
  const notes: string[] = []
  if (unsupported > 0) notes.push(`有 ${unsupported} 张图片格式不支持（如 EMF/WMF），未提取`)

  // mammoth 不处理文本框，文本框里的文字会丢，必须告诉用户
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(fs.readFileSync(docxPath))
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
    if (xml.includes('<w:txbxContent')) notes.push('文档含文本框，其中的文字没有被提取')
  } catch {
    // 只是附加的体检，读不了不影响主流程
  }

  const plain = text.replace(/\[图[^\]]*\]/g, '').replace(/\s/g, '')
  let textSource = 'docx'
  if (plain.length === 0 && assets.length === 0) {
    textSource = 'none'
    notes.push('Word 文档里没有可提取的文字或图片')
  } else if (plain.length < 10 && assets.length > 0) {
    notes.push('文档主要是图片，文字内容需要视觉模型识别（M2）')
  }

  return {
    pages: [{
      idx: 1, imageRel: '', width: 0, height: 0, textSource, lines: [], text: text || null,
      ocrConf: null, ocrError: null, textLayerChars: plain.length
    }],
    assets, notes
  }
}
