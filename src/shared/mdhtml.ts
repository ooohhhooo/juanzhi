/**
 * 把 parseBlocks 的结果渲染成静态 HTML（导出 PDF 用）。纯函数。
 * 所有文字都做 HTML 转义，模型输出里的 <script> 之类只是字面文字；生成的页面本身也不带任何脚本。
 */
import { parseBlocks } from './markdown.ts'
import type { Block, Inline } from './markdown.ts'

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 跨平台的中文字体回退链：macOS 用苹方，Windows 用微软雅黑，Linux 用思源黑体 / 文泉驿，最后落到系统的无衬线字体。
 * 不依赖任何 Mac 独有的字体——Windows 上也要能把中文显示出来。
 */
export const CJK_FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Hiragino Sans GB", "SimHei", sans-serif'

export interface HtmlOptions {
  /** 引用 token → 要放进页面的 HTML（截图卡片）；返回 null 表示当普通文字 */
  cite?: (token: string) => string | null
  /** 引用 token → 截图卡片，**放在这一段 / 这一条的后面**（句子里只留 token 文字）；给了它就不再用 cite */
  citeAfter?: (token: string) => string | null
}

/** after：citeAfter 模式下，收集这一段里的截图卡片（调用方放在段落后面） */
function inline(items: Inline[], o: HtmlOptions, after?: string[]): string {
  return items.map(it => {
    if (it.type === 'text') return esc(it.text)
    if (it.type === 'bold') return `<b>${esc(it.text)}</b>`
    if (o.citeAfter && after) {
      const card = o.citeAfter(it.token)
      if (card) after.push(card)
      return esc(it.token)
    }
    return o.cite?.(it.token) ?? esc(it.token)
  }).join('')
}
const cites = (after: string[]): string => (after.length ? `<div class="cites">${after.join('')}</div>` : '')
/** 一段 / 一条：文字 + 它后面的截图卡片 */
const withCites = (items: Inline[], o: HtmlOptions): string => { const after: string[] = []; const t = inline(items, o, after); return t + cites(after) }

export function blocksToHtml(blocks: Block[], o: HtmlOptions = {}): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': out.push(`<h${Math.min(b.level, 4)}>${esc(b.text)}</h${Math.min(b.level, 4)}>`); break
      case 'ul': out.push(`<ul>${b.items.map(it => `<li>${withCites(it, o)}</li>`).join('')}</ul>`); break
      case 'ol': out.push(`<ol>${b.items.map(it => `<li>${withCites(it, o)}</li>`).join('')}</ol>`); break
      case 'quote': out.push(`<blockquote>${b.lines.map(l => `<div>${inline(l, o)}</div>`).join('')}</blockquote>`); break
      case 'hr': out.push('<hr>'); break
      case 'code': out.push(`<pre>${esc(b.text)}</pre>`); break
      case 'table': {
        const al = (i: number) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '')
        out.push(`<table><thead><tr>${b.header.map((c, i) => `<th${al(i)}>${inline(c, o)}</th>`).join('')}</tr></thead><tbody>${
          b.rows.map(r => `<tr>${b.header.map((_, i) => `<td${al(i)}>${inline(r[i] ?? [], o)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
        break
      }
      default: { const after: string[] = []; out.push(`<p>${inline(b.inline, o, after)}</p>${cites(after)}`) }
    }
  }
  return out.join('\n')
}

export function markdownToHtml(md: string, o: HtmlOptions = {}): string {
  return blocksToHtml(parseBlocks(md), o)
}

export function reportHtmlPage(opts: { title: string; bodyHtml: string; footer?: string }): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: ${CJK_FONT_STACK}; font-size: 11pt; line-height: 1.75; color: #1f1f1f; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 8pt; color: #1e2952; }
  h2 { font-size: 14.5pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5pt solid #1e2952; color: #1e2952; page-break-after: avoid; }
  h3, h4 { font-size: 12pt; margin: 12pt 0 4pt; page-break-after: avoid; }
  p { margin: 5pt 0; }
  ul, ol { margin: 4pt 0; padding-left: 20pt; }
  blockquote { margin: 8pt 0; padding: 5pt 10pt; border-left: 3pt solid #faad14; background: #fffbe6; color: #614700; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 0.5pt solid #bfbfbf; padding: 3pt 6pt; vertical-align: top; }
  th { background: #f0f2f8; }
  pre { background: #f6f6f6; padding: 8pt; font-size: 9pt; white-space: pre-wrap; word-break: break-all; }
  hr { border: 0; border-top: 0.5pt solid #ddd; }
  .cites { margin: 2pt 0 6pt; }
  .cite { display: inline-block; vertical-align: top; margin: 2pt 4pt 2pt 0; padding: 3pt; border: 0.5pt solid #adc6ff; border-radius: 3pt; background: #f7faff; max-width: 52mm; page-break-inside: avoid; }
  .cite .cap { font-size: 7.5pt; color: #1d39c4; margin-bottom: 2pt; }
  .cite img { width: 100%; display: block; }
  .foot { margin-top: 18pt; font-size: 8.5pt; color: #8c8c8c; border-top: 0.5pt solid #eee; padding-top: 4pt; }
</style></head><body>
${opts.bodyHtml}
${opts.footer ? `<div class="foot">${esc(opts.footer)}</div>` : ''}
</body></html>`
}
