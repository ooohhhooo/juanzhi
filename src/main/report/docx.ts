/**
 * 报告导出 Word（.docx）：用现有依赖 jszip 直接写 OOXML，不引入新依赖。纯函数模块（不依赖 electron），单测用 mammoth 反读校验。
 * 支持：标题、段落、粗体、有序 / 无序列表（用文字前缀，不依赖编号定义，任何 Word / WPS / Pages 都能打开）、引用块、表格、代码、
 * 引用的题目截图（嵌在引用后面）。中文字体用 eastAsia 回退（微软雅黑 → 苹方 / 思源），Windows 和 Mac 都能显示。
 */
import JSZip from 'jszip'
import { parseBlocks, parseInline, splitLatin, trickFields } from '../../shared/markdown.ts'
import { CARD_AMBER, CARD_PAPER } from '../../shared/card-style.ts'
import type { Block, Inline } from '../../shared/markdown.ts'

export interface DocxImage { png: Buffer; width: number; height: number }

export interface DocxOptions {
  title: string
  markdown: string
  /** 引用 token → 截图（没有就当普通文字） */
  images?: Map<string, DocxImage>
  footer?: string
}

/** XML 1.0 不允许的字符：除 \t \n \r 外的控制字符、U+FFFE / U+FFFF、孤立的代理项。OCR 乱码或模型异常输出里偶尔有，写进去整个文件就打不开 */
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
export const xmlText = (s: string): string => s.replace(ILLEGAL_XML, '')
const esc = (s: string): string => xmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const EMU_PER_CM = 360000
const MAX_IMG_CM = 9

const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei" w:cs="Arial"/>'

interface Rels { items: Array<{ id: string; file: string }>; next: number }

function run(text: string, o: { bold?: boolean; italic?: boolean; color?: string; mono?: boolean; size?: number } = {}): string {
  const props = `${o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>' : FONT}${o.bold ? '<w:b/>' : ''}${o.italic ? '<w:i/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.size ? `<w:sz w:val="${o.size}"/>` : ''}`
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

function imageRun(rels: Rels, files: Array<{ name: string; data: Buffer }>, img: DocxImage, alt: string, seq: number): string {
  const name = `image${files.length + 1}.png`
  files.push({ name, data: img.png })
  const id = `rId${rels.next++}`
  rels.items.push({ id, file: `media/${name}` })
  const cmW = Math.min(MAX_IMG_CM, Math.max(2, img.width / 96 * 2.54 * 0.6))
  const cx = Math.round(cmW * EMU_PER_CM)
  const cy = Math.round(cx * (img.height / Math.max(1, img.width)))
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${seq}" name="${esc(name)}" descr="${esc(alt)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${seq}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

const hex = (c: string): string => c.replace('#', '').toUpperCase()
type Edge = 'single' | 'dashed' | 'nil'
interface CellOpts { span?: number; fill?: string; top?: Edge; left?: Edge; bottom?: Edge; right?: Edge; color?: string; vAlign?: 'center' | 'top' }
/** 卡片用的单元格：每条边单独指定线型（单线 / 虚线 / 无），颜色统一；圆形徽标在 WPS 里用「形状」不稳，退而用带底色的窄单元格 */
function cardCell(w: number, inner: string, o: CellOpts = {}): string {
  const edge = (name: string, v: Edge = 'nil') => (v === 'nil' ? `<w:${name} w:val="nil"/>` : `<w:${name} w:val="${v}" w:sz="${v === 'dashed' ? 8 : 6}" w:space="0" w:color="${o.color ?? hex(CARD_PAPER.lineStrong)}"/>`)
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ''}<w:tcBorders>${edge('top', o.top)}${edge('left', o.left)}${edge('bottom', o.bottom)}${edge('right', o.right)}</w:tcBorders>${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ''}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tcMar>${o.vAlign ? `<w:vAlign w:val="${o.vAlign}"/>` : ''}</w:tcPr>${inner}</w:tc>`
}
const cardTable = (grid: number[], rows: string[]): string =>
  `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid.map(g => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
const cardRow = (cells: string[], height?: number): string => `<w:tr>${height ? `<w:trPr><w:cantSplit/><w:trHeight w:val="${height}" w:hRule="atLeast"/></w:trPr>` : '<w:trPr><w:cantSplit/></w:trPr>'}${cells.join('')}</w:tr>`

export async function buildDocx(o: DocxOptions): Promise<Buffer> {
  const rels: Rels = { items: [], next: 1 }
  const files: Array<{ name: string; data: Buffer }> = []
  let seq = 1
  let pending: string[] = []
  const inline = (items: Inline[], base: { bold?: boolean; italic?: boolean; color?: string; size?: number } = {}): string => items.map(it => {
    if (it.type === 'text') return run(it.text, base)
    if (it.type === 'bold') return run(it.text, { ...base, bold: true })
    const img = o.images?.get(it.token)
    if (!img) return run(it.token, base)
    // 截图放在这一段的后面（不插在句子中间）：先记下，段落写完后再单独成段
    pending.push(imageRun(rels, files, img, it.token, seq++))
    return run(it.token, { ...base, color: '1D39C4' })
  }).join('')
  const para = (inner: string, o2: { style?: string; shade?: string; border?: boolean; indent?: number } = {}) =>
    `<w:p><w:pPr>${o2.style ? `<w:pStyle w:val="${o2.style}"/>` : ''}${o2.border ? '<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="FAAD14"/></w:pBdr>' : ''}${o2.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${o2.shade}"/>` : ''}<w:spacing w:before="60" w:after="60"/>${o2.indent ? `<w:ind w:left="${o2.indent}"/>` : ''}</w:pPr>${inner}</w:p>`

  const body: string[] = []
  const flush = () => { for (const r of pending) body.push(para(r)); pending = [] }
  body.push(para(run(o.title, { bold: true, size: 40, color: '1E2952' }), { style: 'Title' }))
  const blocks: Block[] = parseBlocks(o.markdown)
  let skippedTitle = false
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        // 报告正文第一行是和标题一样的一级标题：文档标题已经写过，不重复
        if (!skippedTitle && b.level === 1) { skippedTitle = true; break }
        body.push(para(run(b.text, { bold: true, size: b.level <= 2 ? 30 : 26, color: '1E2952' }), { style: `Heading${Math.min(3, Math.max(1, b.level))}` }))
        break
      case 'ul': for (const it of b.items) { body.push(para(run('•  ') + inline(it), { indent: 360 })); flush() } break
      case 'ol': b.items.forEach((it, i) => { body.push(para(run(`${i + 1}.  `) + inline(it), { indent: 360 })); flush() }); break
      case 'quote': for (const l of b.lines) { body.push(para(inline(l, { color: '614700' }), { shade: 'FFFBE6', border: true })); flush() } break
      case 'hr': body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="DDDDDD"/></w:pBdr></w:pPr></w:p>'); break
      case 'code': for (const l of b.text.split('\n')) body.push(para(run(l, { mono: true, size: 18 }), { shade: 'F6F6F6' })); break
      case 'card': {
        // 卡片和界面 / PDF 同一套颜色（shared/card-style.ts）：口诀卡 = 单列表格（淡琥珀横幅 + 白底正文，深琥珀边框）；答题卡 = 徽标列 + 内容列，作答区是虚线框
        const W = 9638
        // 例句：英文斜体，中文正体
        const egRuns = (t: string): string => parseInline(t).map(it => (it.type === 'text' ? splitLatin(it.text).map(s => run(s.text, { italic: s.latin, size: 26 })).join('') : inline([it], { size: 26 }))).join('')
        const a = CARD_AMBER.light
        const P = CARD_PAPER
        if (b.kind === 'trick') {
          const f = trickFields(b.raw)
          const edges = { color: hex(a.line), left: 'single' as Edge, right: 'single' as Edge }
          const rows = [
            cardRow([cardCell(W, para(run(b.title || '口诀大招', { bold: true, color: hex(a.ink), size: 24 })), { ...edges, span: 2, top: 'single', fill: hex(a.band) })]),
            cardRow([cardCell(W, para(inline(parseInline(f.main), { bold: true, size: 36 })) + (f.example ? para(egRuns(f.example)) : '') + f.rest.map(l => para(egRuns(l))).join('') + (f.from ? para(run(`出自考点：${f.from}`, { color: hex(P.ink2), size: 20 })) : ''), { ...edges, span: 2, bottom: 'single' })])
          ]
          // 两列的网格（和答题卡同一个结构）：有的渲染器对单列表格会按内容收窄，两列 + 合并单元格时宽度和答题卡一致
          body.push(cardTable([640, W - 640], rows), para(''))
          break
        }
        const NO = 640, MAIN = W - NO
        const edge = { color: hex(P.lineStrong) }
        const rows: string[] = []
        rows.push(cardRow([cardCell(W, para(run(`${b.title || '答题卡'}${b.extra ? ` · ${b.extra}` : ''}`, { bold: true, size: 26 }) + run('　　AI 出题', { color: hex(P.ink2), size: 20 })), { span: 2, ...edge, top: 'single', left: 'single', right: 'single', bottom: 'single' })]))
        rows.push(cardRow([cardCell(W, para(run('姓名 ____________________　　日期 ____________________', { size: 24 })), { span: 2, ...edge, left: 'single', right: 'single' })]))
        b.items.forEach((it, idx) => {
          const last = idx === b.items.length - 1
          const ans = it.answer
          const opts = ans?.type === 'choice' ? para(run(ans.options.map((x, i) => `○ ${'ABCDEFGH'[i] ?? i + 1}. ${x}`).join('　　'), { size: 24 })) : ''
          const boxN = ans?.type === 'blank' || ans?.type === 'lines' ? ans.count : 0
          // 题号徽标：深色底白字的窄单元格
          rows.push(cardRow([
            cardCell(NO, para(run(String(it.n), { bold: true, color: hex(P.onBadge), size: 26 })), { ...edge, left: 'single', top: 'single', bottom: boxN ? 'nil' : (last ? 'single' : 'single'), right: 'nil', fill: hex(P.badge), vAlign: 'center' }),
            cardCell(MAIN, para(inline(it.stem, { size: 26 })) + opts, { ...edge, right: 'single', top: 'single', bottom: boxN ? 'nil' : 'single' })
          ]))
          for (let k = 0; k < boxN; k++) {
            const lastBox = k === boxN - 1
            rows.push(cardRow([
              cardCell(NO, para(''), { ...edge, left: 'single', top: 'nil', bottom: lastBox ? 'single' : 'nil', right: 'nil', fill: hex(P.badge) }),
              cardCell(MAIN, para(run(' ', { size: 24 })), { ...edge, right: 'single', top: 'dashed', left: 'dashed', bottom: 'dashed' })
            ], 620))
          }
        })
        rows.push(cardRow([cardCell(W, para(run('本题由 AI 根据原卷考点改编，已由程序和第二次 AI 解答核对；使用前请老师先做一遍', { color: hex(P.ink2), size: 18 })), { span: 2, ...edge, left: 'single', right: 'single', bottom: 'single' })]))
        body.push(cardTable([NO, MAIN], rows), para(''))
        break
      }
      case 'table': {
        // 列宽：页面可用宽度（11906 - 2×1134 = 9638 twips）平分；tblGrid 是必需的，每个单元格带 tcW，Word 才不会当成坏文件
        const cols = Math.max(1, b.header.length)
        const colW = Math.floor(9638 / cols)
        const cell = (c: Inline[], head: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tcBorders>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F2F8"/>' : ''}</w:tcPr>${para(inline(c, head ? { bold: true } : {}))}</w:tc>`
        const rows = [`<w:tr>${b.header.map(c => cell(c, true)).join('')}</w:tr>`, ...b.rows.map(r => `<w:tr>${b.header.map((_, i) => cell(r[i] ?? [], false)).join('')}</w:tr>`)]
        body.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`, para(''))
        break
      }
      default: body.push(para(inline(b.inline)))
    }
    flush()
  }
  if (o.footer) body.push(para(run(o.footer, { color: '8C8C8C', size: 17 })))

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/></w:pPr></w:style>
</w:styles>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  const relXml = [`<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    ...rels.items.map(r => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.file}"/>`)].join('')
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relXml}</Relationships>`)
  zip.file('word/document.xml', doc)
  zip.file('word/styles.xml', styles)
  for (const f of files) zip.file(`word/media/${f.name}`, f.data)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
