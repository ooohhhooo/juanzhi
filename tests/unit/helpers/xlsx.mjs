// 单测用：现场生成 xlsx（与 src 里的 buildXlsx 不同——这里故意写成 Excel 常见的样子：共享字符串、合并单元格、隐藏 sheet、数字 / 日期单元格），
// 用来验证读取代码不是只能读自己写出来的文件。全部内容是虚构的。
import JSZip from 'jszip'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const col = c => { let n = c + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) } return s }

/**
 * sheets: [{ name, hidden?, rows: (string|number|{date:serial}|null)[][], merges?: ['A1:B2'] }]
 * 字符串走共享字符串表（带一个故意的注音 rPh 和富文本分段）；{ date: 45000 } 用日期样式的数字单元格。
 */
export async function makeXlsx(sheets) {
  const shared = []
  const sst = s => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1 } return i }
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  // 样式 0 = 常规；样式 1 = yyyy-mm-dd（自定义格式 164）
  zip.file('xl/styles.xml', '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>')
  sheets.forEach((s, si) => {
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v === null || v === undefined || v === '') return ''
      const ref = `${col(ci)}${ri + 1}`
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
      if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`
      return `<c r="${ref}" t="s"><v>${sst(String(v))}</v></c>`
    }).join('')}</row>`).join('')
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''
    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`)
  })
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map(s => {
    // 每隔一个用富文本分段 + 注音，验证拼接和过滤
    const half = Math.ceil(s.length / 2)
    return shared.indexOf(s) % 2 ? `<si><r><t>${esc(s.slice(0, half))}</t></r><r><t>${esc(s.slice(half))}</t></r><rPh sb="0" eb="1"><t>ZZ</t></rPh></si>` : `<si><t xml:space="preserve">${esc(s)}</t></si>`
  }).join('')}</sst>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
