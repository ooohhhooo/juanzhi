/**
 * 报告导出（需要 electron：裁图用 nativeImage，PDF 用隐藏窗口的 printToPDF）。
 *  - Markdown：写 `<名字>.md`，引用的题目截图写成同名文件夹 `<名字>/q-001.png` 里的真实裁切图（主进程 nativeImage.crop，不是整页缩略图）；
 *  - PDF：生成一页只有静态 HTML 的页面（没有脚本），隐藏窗口 printToPDF；中文字体用跨平台回退链（见 shared/mdhtml.ts），Windows 上不依赖 Mac 独有字体。
 * 导出路径由调用方（IPC）用系统「另存为」对话框取得。
 */
import { BrowserWindow, nativeImage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { getFilesDir } from '../db'
import type { CitationRef } from '../../shared/citation'
import { esc, markdownToHtml, reportHtmlPage } from '../../shared/mdhtml'
import { neutralizeHtml, planMarkdownExport, uniqueRefs } from './export-plan'
import type { ReportDetail } from './service'

const PAD = 0.006
const MAX_FULL_PAGE_WIDTH = 900

/** 按引用的定位框从页面图里裁出这道题；没有定位框就用整页缩小到 900 宽。拿不到图返回 null */
export function cropForRef(ref: CitationRef): Buffer | null {
  if (!ref.pageRel) return null
  // pageRel 来自库里的 pages.image_rel，已在导入 / 写入时校验过格式；这里仍然只接受固定格式，不让路径穿出文件目录
  if (!/^page-\d{1,4}\.png$/.test(ref.pageRel) || !/^[0-9a-f-]{36}$/.test(ref.paperId)) return null
  const file = path.resolve(getFilesDir(), ref.paperId, ref.pageRel)
  if (!file.startsWith(path.resolve(getFilesDir()) + path.sep)) return null
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const b = ref.bbox
  if (b && b.length === 4 && b[2] > 0 && b[3] > 0) {
    const x = Math.max(0, Math.floor((b[0] - PAD) * width))
    const y = Math.max(0, Math.floor((b[1] - PAD) * height))
    const w = Math.min(width - x, Math.ceil((b[2] + 2 * PAD) * width))
    const h = Math.min(height - y, Math.ceil((b[3] + 2 * PAD) * height))
    if (w > 0 && h > 0) return img.crop({ x, y, width: w, height: h }).toPNG()
  }
  return (width > MAX_FULL_PAGE_WIDTH ? img.resize({ width: MAX_FULL_PAGE_WIDTH }) : img).toPNG()
}

export interface MdExportResult { mdPath: string; dir: string | null; images: number; missingImages: number }

export function exportMarkdown(report: ReportDetail, mdPath: string): MdExportResult {
  const stem = path.basename(mdPath).replace(/\.md$/i, '')
  const dir = path.join(path.dirname(mdPath), stem)
  const plan = planMarkdownExport(neutralizeHtml(report.markdown), report.refs, stem)
  let written = 0
  let missing = 0
  const failed = new Set<string>()
  if (plan.images.length) {
    fs.mkdirSync(dir, { recursive: true })
    // 先清掉上次导出留下的 q-xxx.png，免得旧图混在里面
    for (const f of fs.readdirSync(dir)) if (/^q-\d{3}\.png$/.test(f)) fs.rmSync(path.join(dir, f), { force: true })
    for (const im of plan.images) {
      const png = cropForRef(im.ref)
      if (!png) { missing++; failed.add(im.file); continue }
      fs.writeFileSync(path.join(dir, im.file), png)
      written++
    }
  }
  // 裁不出图的引用不留一个指向不存在文件的图片链接
  let md = plan.markdown
  for (const f of failed) md = md.replace(new RegExp(` !\\[[^\\]]*\\]\\([^)]*/${f.replace('.', '\\.')}\\)`, 'g'), '')
  const header = `<!-- 由「英语校考分析工作台」导出；引用的题目截图在同名文件夹「${stem}」里 -->\n\n`
  fs.writeFileSync(mdPath, header + md, 'utf8')
  return { mdPath, dir: plan.images.length ? dir : null, images: written, missingImages: missing }
}

export async function exportPdf(report: ReportDetail, pdfPath: string): Promise<{ pdfPath: string; bytes: number; images: number }> {
  const refs = uniqueRefs(report.markdown, report.refs)
  const crops = new Map<string, string>()
  for (const r of refs) {
    const png = cropForRef(r)
    if (png) crops.set(r.token, `data:image/png;base64,${png.toString('base64')}`)
  }
  const body = markdownToHtml(report.markdown, {
    cite: (token) => {
      const uri = crops.get(token)
      if (!uri) return null
      return `<span class="cite"><div class="cap">${esc(token.slice(1, -1))}</div><img src="${uri}" alt=""></span>`
    }
  })
  const html = reportHtmlPage({ title: report.title, bodyHtml: body, footer: `生成时间 ${report.createdAt} · 模型 ${report.model ?? '—'} · 难度与易错点为 AI 估计，非学生成绩统计` })
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
    return { pdfPath, bytes: pdf.length, images: crops.size }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
}
