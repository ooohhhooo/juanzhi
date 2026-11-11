/**
 * Word / PDF / 图片版课程表：取出文字（需要 electron：PDF 渲染、OCR 都在主进程）。
 * 全部复用试卷导入用的那套：PDF 文本层 + 扫描页 OCR（pipeline/pdf-renderer、ocr、textquality），
 * 图片的 EXIF 方向 / HEIC 转换（normalizeImage、convertImageToPngMac），Word 的文字（mammoth + extract.ts 的 htmlToText）。
 * PDF 由渲染窗口按需分块读（不整本进内存）；教材整本书的全文在后台整理任务里逐页读（可取消、有进度）。
 * 日志只记页数 / 行数，不记内容和文件名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../log'
import { convertImageToPngMac, isOcrAvailable, ocrImage, OcrError } from '../pipeline/ocr'
import { PdfCancelledError, PdfPageLimitError, countPdfPages, normalizeImage, renderPdfPages } from '../pipeline/pdf-renderer'
import { judgeTextLayer } from '../pipeline/textquality'
import { htmlToText } from '../pipeline/extract'
import { CourseFileError } from './table-read'
import type { TableRead } from './table-read'
import { KIND_LABEL, MAX_PAGES, MAX_SOURCE_CHARS, numberLines, readDocxTables } from './doc-extract'
import type { RichKind } from './doc-extract'
import { TEXTBOOK_MAX_PAGES, parsePageRange, tooManyPagesMessage } from '../../shared/file-limits'
import { TOC_SCAN_PAGES, blockTitle, buildUnit, estimateOcrPages, fallbackRanges, findPageOffset, parseToc, splitByHeadings, unitPageRanges } from './textbook'
import type { TextLine, TocResult, UnitPlan, UnitSource } from './textbook'
import { detectEdition } from './textbook-edition'
import type { EditionInfo } from './textbook-edition'

export interface RichRead {
  /** 有真表格（Word）：直接当工作表用 */
  table?: TableRead
  /** 没有表格：带行号的文字 + 原始行，交给 AI 整理 */
  text?: { numbered: string; lines: string[]; pages: number }
}

export interface ReadOpts {
  /** 课程表 / 教材课本；不传 = 自动（PDF 超过课程表页数上限时会请用户确认是不是教材） */
  kind?: 'course' | 'textbook'
  /** 页码范围文字，如 "1-60"；空 = 全部 */
  pageRange?: string
}

const noOcr = () => new CourseFileError('这台电脑上没有可用的文字识别（OCR），读不了图片和扫描件；可以改传文字版的 PDF / Word，或 Excel')
const ocrFail = (e: unknown) => new CourseFileError(e instanceof OcrError ? e.message : `文字识别没有成功：${(e as Error).message}`)

/** 页数超过课程表的上限、又没选类型：请界面问用户是不是教材（消息里带固定标记，界面认得） */
export class TextbookSuggest extends CourseFileError {
  constructor(public pages: number, public file: string) {
    super(`TEXTBOOK_SUGGEST|${pages}|${file}|这份 PDF 有 ${pages} 页，比课程表长得多，像是一整本教材。可以按「教材课本」整理（按单元分块，每块单独交给 AI）`)
  }
}

async function wordText(file: string): Promise<string[]> {
  const m: any = await import('mammoth')
  const mammoth = m.default ?? m
  // 图片不需要（课程表只要文字），给个占位避免把图片内容读进内存
  const html = await mammoth.convertToHtml({ path: file }, { convertImage: mammoth.images.imgElement(async () => ({ src: 'ewb-unsupported' })) })
  return htmlToText(html.value).replace(/\[图[^\]]*\]/g, '').split('\n')
}

/** 页码范围文字不合法 / 超出总页数时报给用户 */
function pagesOf(range: string | undefined, total: number): number[] | null {
  try { return parsePageRange(range ?? '', total) } catch (e) { throw new CourseFileError((e as Error).message) }
}

async function pdfText(file: string, opts: ReadOpts): Promise<{ lines: string[]; pages: number }> {
  const total = await countPdfPages(file).catch(e => { throw new CourseFileError((e as Error).message) })
  const sel = pagesOf(opts.pageRange, total)
  const count = sel?.length ?? total
  if (count > MAX_PAGES) {
    if (!opts.kind && !opts.pageRange) throw new TextbookSuggest(total, file)
    throw new CourseFileError(tooManyPagesMessage(count, MAX_PAGES, total))
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    let pages
    // 文字够用的页不出图（不跑画布、不写 PNG）；没文字层的页才出图，后面做 OCR
    try { pages = await renderPdfPages(file, dir, { pages: sel ?? undefined, maxPages: MAX_PAGES, needImage: t => !judgeTextLayer(t).usable }) } catch (e) {
      if (e instanceof PdfPageLimitError) throw new CourseFileError(tooManyPagesMessage(e.pages, e.max, e.total))
      throw e
    }
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

// ───────────────────────── 教材 / 整本书 ─────────────────────────

export interface TextbookPlan {
  fileKind: 'pdf' | 'docx'
  file: string
  /** 要处理的页（PDF）；Word 没有页 */
  pageList: number[]
  totalPages: number
  /** 抽样看有没有文字层：扫描版只 OCR 目录页和每单元前 2 页，仍然比较慢 */
  scanned: boolean
  /** Word：文字已经读出来了（按行） */
  docLines?: string[]
  /** 从封面 / 版权页 / 文件名认出的版本、年级、学期 */
  edition: EditionInfo | null
}

const toTextLines = (page: number, lines: Array<{ text: string; h?: number }>): TextLine[] => lines.filter(l => l.text.trim()).map(l => ({ page, text: l.text, h: l.h }))

/** 打开教材：数页数、套页码范围、检查上限、抽样判断是不是扫描版、认版本。不读全文（在后台整理任务里读，可取消、有进度） */
export async function planTextbook(file: string, kind: RichKind, opts: ReadOpts, fileName = ''): Promise<TextbookPlan> {
  if (kind === 'docx') {
    let lines: string[]
    try { lines = await wordText(file) } catch { throw new CourseFileError('这个 Word 文档打不开，可能已损坏，或者不是 .docx') }
    if (!lines.some(l => l.trim())) throw new CourseFileError('Word 里没有读到文字（可能整份是图片），请换一个文件')
    return { fileKind: 'docx', file, pageList: [], totalPages: 0, scanned: false, docLines: lines, edition: detectEdition(`${fileName}\n${lines.slice(0, 60).join('\n')}`) }
  }
  if (kind !== 'pdf') throw new CourseFileError('教材课本只支持 PDF 和 Word 文件')
  const total = await countPdfPages(file).catch(e => { throw new CourseFileError((e as Error).message) })
  const sel = pagesOf(opts.pageRange, total) ?? Array.from({ length: total }, (_, i) => i + 1)
  if (sel.length > TEXTBOOK_MAX_PAGES) throw new CourseFileError(tooManyPagesMessage(sel.length, TEXTBOOK_MAX_PAGES, total))
  // 抽样：均匀 5 页看文字层（半数以上没有就当扫描版），再加开头 3 页、结尾 1 页认版本
  const spread = [0, 0.25, 0.5, 0.75, 1].map(f => sel[Math.min(sel.length - 1, Math.round(f * (sel.length - 1)))])
  const picks = [...new Set([...spread, ...sel.slice(0, 3), sel[sel.length - 1]])].sort((a, b) => a - b)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    const sample = await renderPdfPages(file, dir, { pages: picks, needImage: () => false })
    const spreadSet = new Set(spread)
    const judged = sample.filter(p => spreadSet.has(p.index))
    const bad = judged.filter(p => !judgeTextLayer(p.text).usable).length
    const edition = detectEdition(`${fileName}\n${sample.map(p => p.text).join('\n')}`)
    return { fileKind: 'pdf', file, pageList: sel, totalPages: total, scanned: bad * 2 >= Math.max(1, judged.length), edition }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface TextbookRead { units: UnitPlan[]; via: UnitSource; tocPages: number[] }

/**
 * 读教材、切成单元：先找目录（不用 AI），没有目录按正文标题切，再没有按页数均分。
 * 有文字层的页不 OCR；扫描版只 OCR 目录页和每个单元的前 2 页。有进度、可取消。
 */
export async function readTextbookUnits(plan: TextbookPlan, onProgress: (done: number, total: number, unit: string) => void, signal: AbortSignal): Promise<TextbookRead> {
  if (plan.docLines) {
    // Word 没有页：每 40 行当一页（只用来在没有单元标题时均分）
    const all: TextLine[] = plan.docLines.map(t => t.trim()).filter(Boolean).map((text, i) => ({ page: Math.floor(i / 40) + 1, text }))
    const byPage = new Map<number, string[]>()
    for (const l of all) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l.text])
    const toc = parseToc([...byPage].map(([page, lines]) => ({ page, lines })))
    const units = splitByHeadings(all, toc.tocPages)
    if (units) return { units, via: 'heading', tocPages: toc.tocPages }
    const pages = [...byPage.keys()]
    return { units: fallbackRanges(pages).map((r, i) => buildUnit(i + 1, `block:${i + 1}`, blockTitle(r.start, r.end), r.start, r.end, all.filter(l => l.page >= r.start && l.page <= r.end))), via: 'blocks', tocPages: [] }
  }

  const sel = plan.pageList
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    // 第 1 遍：全部页只读文字层（不出图、不 OCR），很快；没有可用文字的页记为 null
    const text = new Map<number, TextLine[] | null>()
    try {
      const pages = await renderPdfPages(plan.file, dir, { pages: sel, signal, needImage: () => false, onPage: (d, t) => onProgress(d, t, '页') })
      for (const p of pages) text.set(p.index, judgeTextLayer(p.text).usable ? toTextLines(p.index, p.lines.length ? p.lines.map(l => ({ text: l.text, h: l.h })) : p.text.split('\n').map(t => ({ text: t }))) : null)
    } catch (e) {
      if (e instanceof PdfCancelledError) throw new CourseFileError('已取消')
      throw e
    }
    const ocrTotal = estimateOcrPages(sel.length)
    let ocrDone = 0
    const ocrCache = new Map<number, TextLine[]>()
    /** 一页的行：有文字层直接取，没有就 OCR（缓存；只在需要时才会调到） */
    const pageLines = async (page: number): Promise<TextLine[]> => {
      const t = text.get(page)
      if (t) return t
      if (!text.has(page)) return []
      const hit = ocrCache.get(page)
      if (hit) return hit
      if (signal.aborted) throw new CourseFileError('已取消')
      if (!isOcrAvailable()) throw noOcr()
      const rp = await renderPdfPages(plan.file, dir, { pages: [page], signal, needImage: () => true })
      const png = path.join(dir, `page-${rp[0]?.index ?? page}.png`)
      let lines: TextLine[]
      try { lines = toTextLines(page, (await ocrImage(png)).lines.map(l => ({ text: l.text, h: l.h }))) } catch (e) { throw ocrFail(e) }
      fs.rmSync(png, { force: true })
      ocrCache.set(page, lines)
      onProgress(Math.min(++ocrDone, ocrTotal), ocrTotal, '页（文字识别）')
      return lines
    }
    const textual = [...text.values()].filter(Boolean).length / Math.max(1, sel.length)

    // 第 2 步：找目录（前 15 页）
    const head: Array<{ page: number; lines: string[] }> = []
    let toc: TocResult = { tocPages: [], entries: [] }
    for (const p of sel.slice(0, TOC_SCAN_PAGES)) {
      head.push({ page: p, lines: (await pageLines(p)).map(l => l.text) })
      toc = parseToc(head)
      if (toc.tocPages.length && !toc.tocPages.includes(p)) break   // 目录已经过去了
    }

    // 第 3 步：用目录切单元：先找印的页码和 PDF 页的偏移，再取每个单元的页
    const unitItems = async (start: number, end: number): Promise<TextLine[]> => {
      const out: TextLine[] = []
      for (let p = start; p <= end; p++) {
        if (!text.get(p) && p > start + 1) continue   // 没文字层的页：只取单元的前 2 页
        out.push(...await pageLines(p))
      }
      return out
    }
    if (toc.entries.length >= 2) {
      const off = await findPageOffset(toc.entries, sel, new Set(toc.tocPages), async pg => (await pageLines(pg)).map(l => l.text), textual >= 0.6 ? 60 : 12)
      if (off != null) {
        const ranges = unitPageRanges(toc.entries, off, sel)
        if (ranges.length >= 2) {
          const units: UnitPlan[] = []
          for (const [i, r] of ranges.entries()) units.push(buildUnit(i + 1, r.entry.key, r.entry.title, r.start, r.end, await unitItems(r.start, r.end)))
          return { units, via: 'toc', tocPages: toc.tocPages }
        }
      }
    }

    // 第 4 步：没有目录（或对不上）：有文字层的书按正文里的「第 X 单元 / Unit X」标题切
    if (textual >= 0.6) {
      const all: TextLine[] = sel.flatMap(p => text.get(p) ?? [])
      const units = splitByHeadings(all, toc.tocPages)
      if (units) return { units, via: 'heading', tocPages: toc.tocPages }
    }
    // 第 5 步：都认不出：按页数均分，每块只看前 2 页（扫描版 OCR 也只做这几页）
    const ranges = fallbackRanges(sel)
    const units: UnitPlan[] = []
    for (const [i, r] of ranges.entries()) units.push(buildUnit(i + 1, `block:${i + 1}`, blockTitle(r.start, r.end), r.start, r.end, await unitItems(r.start, r.end)))
    return { units, via: 'blocks', tocPages: toc.tocPages }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 取某一页的文字和缩略图（核对界面看原书用）：文字版取文字层，扫描版没有文字就只给图 */
export async function textbookPagePreview(plan: TextbookPlan, page: number): Promise<{ text: string; image: string | null }> {
  if (plan.fileKind !== 'pdf' || !plan.pageList.includes(page)) return { text: '', image: null }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-course-'))
  try {
    const rp = await renderPdfPages(plan.file, dir, { pages: [page], needImage: () => true })
    const png = path.join(dir, `page-${page}.png`)
    const image = fs.existsSync(png) ? `data:image/png;base64,${fs.readFileSync(png).toString('base64')}` : null
    return { text: (rp[0]?.text ?? '').slice(0, 3000), image }
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

/** buf：Word 才需要（读表格）；PDF 不读进内存，传 null */
export async function readRichFile(file: string, buf: Buffer | null, kind: RichKind, opts: ReadOpts = {}): Promise<RichRead> {
  const ext = path.extname(file).toLowerCase()
  let lines: string[]
  let pages = 1
  if (kind === 'docx') {
    const table = await readDocxTables(buf!)
    if (table) { log.info('course', '读取 Word 表格', { sheets: table.sheets.length }); return { table } }
    try { lines = await wordText(file) } catch (e) {
      if (e instanceof CourseFileError) throw e
      throw new CourseFileError('这个 Word 文档打不开，可能已损坏，或者不是 .docx')
    }
  } else if (kind === 'pdf') {
    const r = await pdfText(file, opts)
    lines = r.lines; pages = r.pages
  } else lines = await imageText(file, ext)
  const n = numberLines(lines)
  if (!n.lines.length) throw new CourseFileError(`${KIND_LABEL[kind]}里没有读到文字${kind === 'docx' ? '（可能整份是图片）' : ''}，请换一个文件，或改传 Excel`)
  if (n.text.length > MAX_SOURCE_CHARS) throw new CourseFileError(`${KIND_LABEL[kind]}里的文字太多了（超过 ${MAX_SOURCE_CHARS / 10000} 万字），不像一份课程表。如果这是一本教材，请选「教材课本」；否则请截取课程表的部分再上传`)
  log.info('course', '读取文档文字', { kind, lines: n.lines.length, pages })
  return { text: { numbered: n.text, lines: n.lines, pages } }
}
