// 现场生成「各种格式的课程表」测试文件（全部虚构、通用课名，不进仓库）：xlsx / csv / 带表格的 docx / 没有表格的 docx /
// 文字版 PDF / 扫描版 PDF（只有图片）/ png 截图 / 手机拍照式 jpg（带 EXIF 方向）/ heic（用系统 sips 转，没有就跳过）。
// 图片用 Electron 页面里的 canvas 画字（拿到 page 才能画），其余只用 jszip 和字符串拼接。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const JSZip = require('jszip')

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const p = t => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`

async function zipTo(file, files) {
  const zip = new JSZip()
  for (const [k, v] of Object.entries(files)) zip.file(k, v)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return file
}

const DOCX_BASE = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
}
const docxOf = body => ({ ...DOCX_BASE, 'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>` })

/** 带真表格的 Word：标题段落 + 表（表头 + 每课一行）+ 一段无关文字 */
const makeDocxTable = (file, header, rows) => zipTo(file, docxOf(
  p('课程安排（虚构示例）') +
  `<w:tbl><w:tblPr/>${[header, ...rows].map(r => `<w:tr>${r.map(c => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` +
  p('以上安排以实际通知为准')))

/** 没有表格的 Word：每课一段，后面跟词汇行 */
const makeDocxText = (file, lines) => zipTo(file, docxOf(lines.map(l => p(l)).join('')))

// ── PDF ──
/** 按对象数组拼 PDF（对象从 1 开始编号；stream 对象传 Buffer 数组 [字典前半, 数据]），自动算 xref */
function buildPdf(objs) {
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offs = []
  let len = parts[0].length
  objs.forEach((o, i) => {
    offs.push(len)
    const b = Array.isArray(o)
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o[0].replace('LEN', String(o[1].length))}\nstream\n`), o[1], Buffer.from('\nendstream\nendobj\n')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)
    parts.push(b); len += b.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`
  return Buffer.concat([...parts, Buffer.from(xref)])
}

/** 文字版 PDF（Helvetica，只能写 ASCII）：有文本层，不需要 OCR */
function makeTextPdf(file, lines) {
  const body = 'BT /F1 16 Tf 20 TL 60 780 Td\n' + lines.map(l => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join('\n') + '\nET'
  fs.writeFileSync(file, buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ['<< /Length LEN >>', Buffer.from(body)], '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]))
  return file
}

/** 扫描版 PDF：页面里只有一张 JPEG，没有文本层，只能 OCR */
function makeImagePdf(file, jpg, w, h) {
  const pw = 595, ph = Math.round(595 * h / w)
  fs.writeFileSync(file, buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    ['<< /Length LEN >>', Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`)],
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length LEN >>`, jpg]
  ]))
  return file
}

// ── xlsx / csv ──
async function makeXlsx(file, sheetName, rows) {
  const colName = c => String.fromCharCode(65 + c)
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')
  return zipTo(file, {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  })
}

// ── 图片：在 Electron 页面里用 canvas 画字 ──
/** 画一张白底黑字的图（每行一句，大字号方便 OCR）。返回 { png, jpg, w, h, rotatedJpg }：rotatedJpg = 内容逆时针转了 90°、再用 EXIF 方向 6 标成「顺时针转 90° 显示」，模拟手机竖拍 */
async function drawImages(page, lines, opts = {}) {
  const r = await page.evaluate(([ls, o]) => {
    const w = o.w || 1100, h = o.h || (140 + ls.length * 110)
    const draw = () => {
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'
      g.font = '52px "PingFang SC", "Helvetica Neue", Arial, sans-serif'; g.textBaseline = 'top'
      ls.forEach((l, i) => g.fillText(l, 60, 70 + i * 110))
      return c
    }
    const up = draw()
    const rot = document.createElement('canvas'); rot.width = h; rot.height = w
    const rg = rot.getContext('2d'); rg.translate(0, w); rg.rotate(-Math.PI / 2); rg.drawImage(up, 0, 0)
    return { w, h, png: up.toDataURL('image/png').split(',')[1], jpg: up.toDataURL('image/jpeg', 0.92).split(',')[1], rotJpg: rot.toDataURL('image/jpeg', 0.92).split(',')[1] }
  }, [lines, opts])
  return { w: r.w, h: r.h, png: Buffer.from(r.png, 'base64'), jpg: Buffer.from(r.jpg, 'base64'), rotatedJpg: withExifOrientation(Buffer.from(r.rotJpg, 'base64'), 6) }
}

/** 在 JPEG 开头插入一个只含「方向」的 EXIF 段 */
function withExifOrientation(jpg, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload])
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)])
}

/** png → heic（macOS 系统自带的 sips）；失败返回 null */
function makeHeic(pngFile, heicFile) {
  try { execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', pngFile, '--out', heicFile], { stdio: 'ignore' }); return fs.existsSync(heicFile) && fs.statSync(heicFile).size > 100 ? heicFile : null } catch { return null }
}

module.exports = { makeXlsx, makeDocxTable, makeDocxText, makeTextPdf, makeImagePdf, drawImages, makeHeic, withExifOrientation, path }
