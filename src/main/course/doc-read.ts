/**
 * Word / PDF / 图片版课程表：取出文字（需要 electron：PDF 渲染、OCR 都在主进程）。
 * 全部复用试卷导入用的那套：PDF 文本层 + 扫描页 OCR（pipeline/pdf-renderer、ocr、textquality），
 * 图片的 EXIF 方向 / HEIC 转换（normalizeImage、convertImageToPngMac），Word 的文字（mammoth + extract.ts 的 htmlToText）。
 * 日志只记页数 / 行数，不记内容和文件名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../log'
import { convertImageToPngMac, isOcrAvailable, ocrImage, OcrError } from '../pipeline/ocr'
import { PdfPageLimitError, normalizeImage, renderPdfPages } from '../pipeline/pdf-renderer'
import { judgeTextLayer } from '../pipeline/textquality'
import { htmlToText } from '../pipeline/extract'
import { CourseFileError } from './table-read'
import type { TableRead } from './table-read'
import { KIND_LABEL, MAX_PAGES, MAX_SOURCE_CHARS, numberLines, readDocxTables } from './doc-extract'
import type { RichKind } from './doc-extract'

export interface RichRead {
  /** 有真表格（Word）：直接当工作表用 */
  table?: TableRead
  /** 没有表格：带行号的文字 + 原始行，交给 AI 整理 */
  text?: { numbered: string; lines: string[]; pages: number }
}

const noOcr = () => new CourseFileError('这台电脑上没有可用的文字识别（OCR），读不了图片和扫描件；可以改传文字版的 PDF / Word，或 Excel')
const ocrFail = (e: unknown) => new CourseFileError(e instanceof OcrError ? e.message : `文字识别没有成功：${(e as Error).message}`)

async function wordText(file: string): Promise<string[]> {
  const m: any = await import('mammoth')
  const mammoth = m.default ?? m
  // 图片不需要（课程表只要文字），给个占位避免把图片内容读进内存
  const html = await mammoth.convertToHtml({ path: file }, { convertImage: mammoth.images.imgElement(async () => ({ src: 'ewb-unsupported' })) })
  return htmlToText(html.value).replace(/\[图[^\]]*\]/g, '').split('\n')
}

/** 粗略数 PDF 页数，只用来在渲染前挡住明显过长的文件；精确页数以渲染结果为准 */
function roughPdfPages(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

async function pdfText(file: string, buf: Buffer): Promise<{ lines: string[]; pages: number }> {
  if (roughPdfPages(buf) > MAX_PAGES * 3) throw new CourseFileError(`这份 PDF 页数太多（超过 ${MAX_PAGES} 页），课程表一般没有这么长。请截取课程表的部分再上传`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    let pages
    try { pages = await renderPdfPages(file, dir, MAX_PAGES) } catch (e) {
      if (e instanceof PdfPageLimitError) throw new CourseFileError(`这份 PDF 有 ${e.pages} 页，超过了 ${MAX_PAGES} 页的上限。请截取课程表的部分再上传`)
      throw e
    }
    if (pages.length > MAX_PAGES) throw new CourseFileError(`这份 PDF 有 ${pages.length} 页，超过了 ${MAX_PAGES} 页的上限。请截取课程表的部分再上传`)
    const lines: string[] = []
    for (const p of pages) {
      if (judgeTextLayer(p.text).usable) { lines.push(...(p.lines.length ? p.lines.map(l => l.text) : p.text.split('\n'))); continue }
      if (!isOcrAvailable()) throw noOcr()
      try { lines.push(...(await ocrImage(path.join(dir, `page-${p.index}.png`))).lines.map(l => l.text)) } catch (e) { throw ocrFail(e) }
    }
    return { lines, pages: pages.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function imageText(file: string, ext: string): Promise<string[]> {
  if (!isOcrAvailable()) throw noOcr()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    const dest = path.join(dir, 'page-1.png')
    if (ext === '.png') fs.copyFileSync(file, dest)
    else if (ext === '.heic' && process.platform === 'darwin') await convertImageToPngMac(file, dest)   // 系统 ImageIO：HEIC 解码 + EXIF 方向
    else {
      try { await normalizeImage(file, dest) } catch (e) {
        throw new CourseFileError(ext === '.heic' ? '无法解码 HEIC 图片：Windows 需要安装「HEIF 图像扩展」，或先转成 JPG / PNG' : (e as Error).message)
      }
    }
    try { return (await ocrImage(dest)).lines.map(l => l.text) } catch (e) { throw ocrFail(e) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function readRichFile(file: string, buf: Buffer, kind: RichKind): Promise<RichRead> {
  const ext = path.extname(file).toLowerCase()
  let lines: string[]
  let pages = 1
  if (kind === 'docx') {
    const table = await readDocxTables(buf)
    if (table) { log.info('course', '读取 Word 表格', { sheets: table.sheets.length }); return { table } }
    try { lines = await wordText(file) } catch (e) {
      if (e instanceof CourseFileError) throw e
      throw new CourseFileError('这个 Word 文档打不开，可能已损坏，或者不是 .docx')
    }
  } else if (kind === 'pdf') {
    const r = await pdfText(file, buf)
    lines = r.lines; pages = r.pages
  } else lines = await imageText(file, ext)
  const n = numberLines(lines)
  if (!n.lines.length) throw new CourseFileError(`${KIND_LABEL[kind]}里没有读到文字${kind === 'docx' ? '（可能整份是图片）' : ''}，请换一个文件，或改传 Excel`)
  if (n.text.length > MAX_SOURCE_CHARS) throw new CourseFileError(`${KIND_LABEL[kind]}里的文字太多了（超过 ${MAX_SOURCE_CHARS / 10000} 万字），不像一份课程表。请截取课程表的部分再上传`)
  log.info('course', '读取文档文字', { kind, lines: n.lines.length, pages })
  return { text: { numbered: n.text, lines: n.lines, pages } }
}
