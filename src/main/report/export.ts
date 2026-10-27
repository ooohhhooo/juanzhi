/**
 * 报告导出（需要 electron：裁图用 nativeImage，PDF 用隐藏窗口的 printToPDF）。
 *  - Markdown：写 `<名字>.md`，引用的题目截图写成同名文件夹 `<名字>/q-001.png` 里的真实裁切图（主进程 nativeImage.crop，不是整页缩略图）；
 *  - PDF：生成一页只有静态 HTML 的页面（没有脚本），隐藏窗口 printToPDF；中文字体用跨平台回退链（见 shared/mdhtml.ts），Windows 上不依赖 Mac 独有字体；
 *  - Word：.docx（report/docx.ts，jszip 直接写 OOXML）。
 * 三种格式的截图用同一个裁切算法（shared/crop.ts：上下留半行白、右边不带出同一行的下一题）。
 * macOS 往外置盘 / exFAT / NTFS 上写文件，系统会顺手生成 `._名字` 的元数据文件：导出后清掉我们自己写出的文件对应的那些。
 * 导出路径由调用方（IPC）用系统「另存为」对话框取得。
 */
import { BrowserWindow, nativeImage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { getFilesDir } from '../db'
import type { CitationRef } from '../../shared/citation'
import { cropPixels } from '../../shared/crop'
import { esc, markdownToHtml, reportHtmlPage } from '../../shared/mdhtml'
import { exportTitle, footerNote, mdHeader, neutralizeHtml, planMarkdownExport, uniqueRefs } from './export-plan'
import { buildDocx } from './docx'
import type { DocxImage } from './docx'
import type { ReportDetail } from './service'

const MAX_FULL_PAGE_WIDTH = 900

/** 按引用的定位框从页面图里裁出这道题；没有定位框就用整页缩小到 900 宽。拿不到图返回 null */
export function cropForRef(ref: CitationRef): { png: Buffer; width: number; height: number } | null {
  if (!ref.pageRel) return null
  // pageRel 来自库里的 pages.image_rel，已在导入 / 写入时校验过格式；这里仍然只接受固定格式，不让路径穿出文件目录
  if (!/^page-\d{1,4}\.png$/.test(ref.pageRel) || !/^[0-9a-f-]{36}$/.test(ref.paperId)) return null
  const file = path.resolve(getFilesDir(), ref.paperId, ref.pageRel)
  if (!file.startsWith(path.resolve(getFilesDir()) + path.sep)) return null
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const r = cropPixels(ref.bbox, width, height)
  if (r) { const c = img.crop(r); return { png: c.toPNG(), width: r.width, height: r.height } }
  const out = width > MAX_FULL_PAGE_WIDTH ? img.resize({ width: MAX_FULL_PAGE_WIDTH }) : img
  const sz = out.getSize()
  return { png: out.toPNG(), width: sz.width, height: sz.height }
}

/**
 * 删掉 macOS 在非 HFS/APFS 卷上为我们刚写出的文件生成的 `._名字` 元数据文件（只删这几个名字对应的，不碰目录里别的东西）。
 * 系统有时在写完后稍晚才补，所以立刻清一次、稍后再清一次。返回立刻清掉的个数。
 */
export function cleanAppleDouble(dir: string, names: string[]): number {
  const once = (): number => {
    let n = 0
    for (const name of names) {
      const f = path.join(dir, `._${name}`)
      try { if (fs.existsSync(f) && fs.statSync(f).isFile()) { fs.rmSync(f, { force: true }); n++ } } catch { /* 清理失败不影响导出 */ }
    }
    return n
  }
  const n = once()
  const t = setTimeout(once, 1500)
  t.unref?.()
  return n
}

export interface MdExportResult { mdPath: string; dir: string | null; images: number; missingImages: number }

export function exportMarkdown(report: ReportDetail, mdPath: string, dataNote = ''): MdExportResult {
  const stem = path.basename(mdPath).replace(/\.md$/i, '')
  const dir = path.join(path.dirname(mdPath), stem)
  const plan = planMarkdownExport(neutralizeHtml(report.markdown), report.refs, stem)
  let written = 0
  let missing = 0
  const failed = new Set<string>()
  const wrote: string[] = []
  if (plan.images.length) {
    fs.mkdirSync(dir, { recursive: true })
    // 先清掉上次导出留下的 q-xxx.png，免得旧图混在里面
    for (const f of fs.readdirSync(dir)) if (/^q-\d{3}\.png$/.test(f)) fs.rmSync(path.join(dir, f), { force: true })
    for (const im of plan.images) {
      const c = cropForRef(im.ref)
      if (!c) { missing++; failed.add(im.file); continue }
      fs.writeFileSync(path.join(dir, im.file), c.png)
      wrote.push(im.file)
      written++
    }
  }
  // 裁不出图的引用不留一个指向不存在文件的图片链接
  let md = plan.markdown
  for (const f of failed) md = md.replace(new RegExp(` !\\[[^\\]]*\\]\\([^)]*/${f.replace('.', '\\.')}\\)`, 'g'), '')
  const header = mdHeader(report, stem, written, dataNote)
  fs.writeFileSync(mdPath, header + md, 'utf8')
  cleanAppleDouble(path.dirname(mdPath), [path.basename(mdPath), stem])
  if (plan.images.length) cleanAppleDouble(dir, wrote)
  return { mdPath, dir: plan.images.length ? dir : null, images: written, missingImages: missing }
}

export async function exportPdf(report: ReportDetail, pdfPath: string, dataNote = ''): Promise<{ pdfPath: string; bytes: number; images: number }> {
  const refs = uniqueRefs(report.markdown, report.refs)
  const crops = new Map<string, string>()
  for (const r of refs) {
    const c = cropForRef(r)
    if (c) crops.set(r.token, `data:image/png;base64,${c.png.toString('base64')}`)
  }
  const body = markdownToHtml(report.markdown, {
    citeAfter: (token) => {
      const uri = crops.get(token)
      if (!uri) return null
      return `<span class="cite"><div class="cap">${esc(token.slice(1, -1))}</div><img src="${uri}" alt=""></span>`
    }
  })
  const html = reportHtmlPage({ title: exportTitle(report), bodyHtml: body, footer: footerNote(report, dataNote || '数据来源：本地校考卷') })
  const tmp = path.join(os.tmpdir(), `ewb-report-${crypto.randomBytes(6).toString('hex')}.html`)
  fs.writeFileSync(tmp, html, 'utf8')
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, javascript: false, offscreen: false } })
  try {
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font-size:8px;color:#888;text-align:center;font-family:\'PingFang SC\',\'Microsoft YaHei\',\'Noto Sans CJK SC\',sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    })
    fs.writeFileSync(pdfPath, pdf)
    cleanAppleDouble(path.dirname(pdfPath), [path.basename(pdfPath)])
    return { pdfPath, bytes: pdf.length, images: crops.size }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
}

export async function exportDocx(report: ReportDetail, docxPath: string, dataNote = ''): Promise<{ docxPath: string; bytes: number; images: number }> {
  const images = new Map<string, DocxImage>()
  for (const r of uniqueRefs(report.markdown, report.refs)) {
    const c = cropForRef(r)
    if (c) images.set(r.token, { png: c.png, width: c.width, height: c.height })
  }
  const buf = await buildDocx({ title: exportTitle(report), markdown: report.markdown, images, footer: footerNote(report, dataNote || '数据来源：本地校考卷') })
  fs.writeFileSync(docxPath, buf)
  cleanAppleDouble(path.dirname(docxPath), [path.basename(docxPath)])
  return { docxPath, bytes: buf.length, images: images.size }
}
