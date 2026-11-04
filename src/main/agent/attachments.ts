/**
 * 助手的附件：用户拖入 / 粘贴 / 选择的图片、Word、PDF、文本文件。
 * 只取出文字（图片和扫描页走本机 OCR），先放在内存里，提问时按编号取出，跟问题一起发给 AI；
 * 表格（Excel / CSV）不走这里，走数据集导入（能查询、学员名脱敏）。
 * 发给 AI 前去掉手机号、身份证号等（scrubPII）。日志只记类型和字数，不记内容和文件名。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../log'
import { convertImageToPngMac, isOcrAvailable, ocrImage, OcrError } from '../pipeline/ocr'
import { PdfPageLimitError, normalizeImage, renderPdfPages } from '../pipeline/pdf-renderer'
import { judgeTextLayer } from '../pipeline/textquality'
import { htmlToText } from '../pipeline/extract'
import { scrubPII } from '../analysis/scrub'

export type AttachKind = 'image' | 'pdf' | 'docx' | 'text'
export interface AttachInfo { id: string; name: string; kind: AttachKind; chars: number; truncated: boolean }

/** 一个附件最多带给 AI 的字数；一次提问所有附件合计的上限 */
export const ATTACH_MAX_CHARS = 20_000
export const ATTACH_TOTAL_MAX = 40_000
const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 30

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.heic', '.webp', '.bmp', '.gif']
const TEXT_EXT = ['.txt', '.md', '.markdown', '.json', '.log', '.html', '.htm']
export const ATTACH_EXTENSIONS = [...IMAGE_EXT, '.pdf', '.docx', ...TEXT_EXT].map(e => e.slice(1))

export class AttachError extends Error {}

export function attachKindOf(file: string): AttachKind | null {
  const ext = path.extname(file).toLowerCase()
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (TEXT_EXT.includes(ext)) return 'text'
  return null
}

const store = new Map<string, { info: AttachInfo; text: string; at: number }>()
const TTL_MS = 6 * 60 * 60 * 1000
function prune(): void {
  const now = Date.now()
  for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k)
}

const noOcr = () => new AttachError('这台电脑上没有可用的文字识别（OCR），读不了图片和扫描件')
const ocrFail = (e: unknown) => new AttachError(e instanceof OcrError ? e.message : `文字识别没有成功：${(e as Error).message}`)

async function ocrPng(png: string): Promise<string> {
  if (!isOcrAvailable()) throw noOcr()
  try { return (await ocrImage(png)).lines.map(l => l.text).join('\n') } catch (e) { throw ocrFail(e) }
}

async function imageText(file: string, dir: string): Promise<string> {
  const ext = path.extname(file).toLowerCase()
  const dest = path.join(dir, 'page-1.png')
  if (ext === '.png') fs.copyFileSync(file, dest)
  else if (ext === '.heic' && process.platform === 'darwin') await convertImageToPngMac(file, dest)
  else {
    try { await normalizeImage(file, dest) } catch (e) {
      throw new AttachError(ext === '.heic' ? '无法解码 HEIC 图片：Windows 需要安装「HEIF 图像扩展」，或先转成 JPG / PNG' : `这张图片打不开：${(e as Error).message}`)
    }
  }
  return ocrPng(dest)
}

async function pdfText(file: string, dir: string): Promise<string> {
  let pages
  try { pages = await renderPdfPages(file, dir, MAX_PDF_PAGES) } catch (e) {
    if (e instanceof PdfPageLimitError) throw new AttachError(`这份 PDF 有 ${e.pages} 页，超过了 ${MAX_PDF_PAGES} 页的上限。请截取需要的部分再添加`)
    throw new AttachError('这份 PDF 打不开，可能已损坏或加了密码')
  }
  const out: string[] = []
  for (const p of pages) {
    if (judgeTextLayer(p.text).usable) out.push(p.lines.length ? p.lines.map(l => l.text).join('\n') : p.text)
    else out.push(await ocrPng(path.join(dir, `page-${p.index}.png`)))
  }
  return out.join('\n\n')
}

async function wordText(file: string): Promise<string> {
  const m: any = await import('mammoth')
  const mammoth = m.default ?? m
  try {
    const html = await mammoth.convertToHtml({ path: file }, { convertImage: mammoth.images.imgElement(async () => ({ src: 'ewb-unsupported' })) })
    return htmlToText(html.value).replace(/\[图[^\]]*\]/g, '')
  } catch { throw new AttachError('这个 Word 文档打不开，可能已损坏，或者不是 .docx') }
}

function plainText(file: string): string {
  const s = fs.readFileSync(file, 'utf8')
  return /\.html?$/i.test(file) ? htmlToText(s) : s
}

const KIND_LABEL: Record<AttachKind, string> = { image: '图片', pdf: 'PDF', docx: 'Word', text: '文本' }

/** 读一个文件的文字，存进内存，返回编号和概况 */
export async function readAttachment(file: string, displayName?: string): Promise<AttachInfo> {
  prune()
  const name = (displayName || path.basename(file)).slice(0, 120)
  const kind = attachKindOf(file)
  if (!kind) {
    const ext = path.extname(file).toLowerCase()
    throw new AttachError(ext === '.doc' ? '旧版 .doc 请先另存为 .docx 再添加' : `助手读不了 ${ext || '这种'} 文件；可以添加图片、PDF、Word（.docx）、文本，表格请用 Excel / CSV`)
  }
  const st = fs.statSync(file)
  if (st.size > MAX_FILE_BYTES) throw new AttachError('文件太大了（超过 30MB）')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-attach-'))
  let raw: string
  try {
    raw = kind === 'image' ? await imageText(file, dir) : kind === 'pdf' ? await pdfText(file, dir) : kind === 'docx' ? await wordText(file) : plainText(file)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) throw new AttachError(kind === 'image' ? '这张图片里没有认出文字（助手现在只能读图片里的文字，看不懂图本身）' : `${KIND_LABEL[kind]}里没有读到文字`)
  const truncated = text.length > ATTACH_MAX_CHARS
  const info: AttachInfo = { id: crypto.randomUUID(), name, kind, chars: Math.min(text.length, ATTACH_MAX_CHARS), truncated }
  store.set(info.id, { info, text: text.slice(0, ATTACH_MAX_CHARS), at: Date.now() })
  log.info('agent', '读取附件', { kind, chars: text.length })
  return info
}

/** 粘贴进来的截图（没有文件路径）：先写到临时文件再读 */
export async function readPastedImage(name: string, bytes: Uint8Array): Promise<AttachInfo> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new AttachError('图片太大了（超过 30MB）')
  const ext = /\.(png|jpe?g|webp|gif|bmp)$/i.exec(name)?.[0].toLowerCase() ?? '.png'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-paste-'))
  try {
    const f = path.join(dir, `pasted${ext}`)
    fs.writeFileSync(f, bytes)
    return await readAttachment(f, name || `粘贴的图片${ext}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 按编号取出附件，拼成附在问题后面的一段文字（发给 AI 用；界面上只显示文件名）。
 * 合计超过上限的部分截掉并注明。找不到的编号（过期 / 重启过）忽略。
 */
export function takeAttachments(ids: string[]): { infos: AttachInfo[]; block: string } {
  const infos: AttachInfo[] = []
  const parts: string[] = []
  let left = ATTACH_TOTAL_MAX
  for (const id of ids) {
    const a = store.get(id)
    if (!a || left <= 0) continue
    const body = scrubPII(a.text).slice(0, left)
    const cut = a.info.truncated || body.length < a.text.length
    left -= body.length
    infos.push({ ...a.info, chars: body.length, truncated: cut })
    parts.push(`【附件：${a.info.name}（${KIND_LABEL[a.info.kind]}${a.info.kind === 'image' ? '，以下是识别出的文字' : ''}${cut ? '，内容太长，只附了前一部分' : ''}）】\n${body}\n【附件结束】`)
  }
  return { infos, block: parts.length ? `\n\n下面是我附上的文件内容：\n\n${parts.join('\n\n')}` : '' }
}
