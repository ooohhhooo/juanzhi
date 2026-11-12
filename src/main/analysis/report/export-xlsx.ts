/**
 * Excel 导出：用 jszip 拼标准 xlsx（共享字符串 + 样式表）。纯模块，不依赖 electron。
 * - exportBoardXlsx(spec)：第一张「核心发现」、每章一张、最后「口径说明」；图表块输出其数据表；
 * - exportTableXlsx(columns, rows, sheetName)：通用表格（如跟进名单）。
 * 样式：表头加粗 + 底色 + 边框；百分比 0.0%；千分位；高亮行淡黄底；列宽按内容估算。
 */
import JSZip from 'jszip'
import { chartToTable, isHighlighted, type BoardSpec, type Cell, type Column } from './spec.ts'
import { escXml, textWidth } from './chart-svg.ts'

type NumFmt = 'pct' | 'int' | 'num' | 'score'
export interface Style { numFmt?: NumFmt; bold?: boolean; fill?: string; wrap?: boolean; border?: boolean; size?: number; color?: string }
export interface XCell { v: string | number | null; s?: Style }
export interface XRow { cells: XCell[]; ht?: number }
/** freeze：冻结首行 */
export interface XSheet { name: string; rows: XRow[]; widths?: number[]; merges?: string[]; freeze?: boolean }

const NUMFMT_ID: Record<NumFmt, number> = { pct: 164, int: 165, num: 166, score: 167 }
const NUMFMT_CODE: Record<NumFmt, string> = { pct: '0.0%', int: '#,##0', num: '#,##0.00', score: '0.0' }
const HEAD_FILL = 'E4E3F8'
const HI_FILL = 'FFF2CC'

export function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** 工作表名：去掉 []:*?/\ 和首尾引号，≤31 字符，空名给默认，重名（不分大小写）加序号 */
export function sheetName(raw: string, used: Set<string>): string {
  let base = [...raw.replace(/[\[\]:*?/\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '')].slice(0, 31).join('').trim() || '工作表'
  let name = base, k = 2
  while (used.has(name.toLowerCase())) {
    const suf = `(${k++})`
    name = [...base].slice(0, 31 - suf.length).join('') + suf
  }
  used.add(name.toLowerCase())
  return name
}

class Styles {
  private xfs: string[] = []
  private keys = new Map<string, number>()
  private fonts: string[] = ['<font><sz val="11"/><name val="Arial"/></font>']
  private fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  constructor() { this.index({}) }
  private font(s: Style): number {
    const x = `<font>${s.bold ? '<b/>' : ''}<sz val="${s.size ?? 11}"/>${s.color ? `<color rgb="FF${s.color}"/>` : ''}<name val="Arial"/></font>`
    let i = this.fonts.indexOf(x); if (i < 0) { i = this.fonts.length; this.fonts.push(x) }
    return i
  }
  private fill(c?: string): number {
    if (!c) return 0
    const x = `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`
    let i = this.fills.indexOf(x); if (i < 0) { i = this.fills.length; this.fills.push(x) }
    return i
  }
  index(s: Style | undefined): number {
    const st = s ?? {}
    const key = JSON.stringify([st.numFmt, st.bold, st.fill, st.wrap, st.border, st.size, st.color])
    const got = this.keys.get(key); if (got !== undefined) return got
    const i = this.xfs.length
    const nf = st.numFmt ? NUMFMT_ID[st.numFmt] : 0
    this.xfs.push(`<xf numFmtId="${nf}" fontId="${this.font(st)}" fillId="${this.fill(st.fill)}" borderId="${st.border ? 1 : 0}" xfId="0"${nf ? ' applyNumberFormat="1"' : ''} applyFont="1"${st.fill ? ' applyFill="1"' : ''}${st.border ? ' applyBorder="1"' : ''}${st.wrap ? ' applyAlignment="1"' : ''}>${st.wrap ? '<alignment vertical="top" wrapText="1"/>' : '<alignment vertical="center"/>'}</xf>`)
    this.keys.set(key, i)
    return i
  }
  xml(): string {
    const nf = (Object.keys(NUMFMT_ID) as NumFmt[]).map(k => `<numFmt numFmtId="${NUMFMT_ID[k]}" formatCode="${NUMFMT_CODE[k]}"/>`).join('')
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4">${nf}</numFmts>` +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts><fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9C9D6"/></left><right style="thin"><color rgb="FFC9C9D6"/></right><top style="thin"><color rgb="FFC9C9D6"/></top><bottom style="thin"><color rgb="FFC9C9D6"/></bottom><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  }
}

export async function buildXlsx(sheets: XSheet[]): Promise<Buffer> {
  const zip = new JSZip()
  const styles = new Styles()
  const sst: string[] = []
  const sstIdx = new Map<string, number>()
  const str = (s: string): number => { let i = sstIdx.get(s); if (i === undefined) { i = sst.length; sst.push(s); sstIdx.set(s, i) } return i }
  const names = new Set<string>()
  const finalNames = sheets.map(s => sheetName(s.name, names))
  sheets.forEach((sh, si) => {
    const rows = sh.rows.map((row, ri) => {
      const cs = row.cells.map((c, ci) => {
        if (c.v === null || c.v === undefined || c.v === '') return c.s ? `<c r="${colName(ci)}${ri + 1}" s="${styles.index(c.s)}"/>` : ''
        const ref = `${colName(ci)}${ri + 1}`, s = styles.index(c.s)
        return typeof c.v === 'number' && Number.isFinite(c.v) ? `<c r="${ref}" s="${s}"><v>${c.v}</v></c>` : `<c r="${ref}" s="${s}" t="s"><v>${str(String(c.v))}</v></c>`
      }).join('')
      return `<row r="${ri + 1}"${row.ht ? ` ht="${row.ht}" customHeight="1"` : ''}>${cs}</row>`
    }).join('')
    const cols = sh.widths?.length ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''
    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews>${sh.freeze ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>' : '<sheetView workbookViewId="0"/>'}</sheetViews><sheetFormatPr defaultRowHeight="16"/>${cols}<sheetData>${rows}</sheetData>${merges}</worksheet>`)
  })
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${finalNames.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`)
  zip.file('xl/styles.xml', styles.xml())
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(s => `<si><t xml:space="preserve">${escXml(s).replace(/"/g, '&quot;')}</t></si>`).join('')}</sst>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ───────────── 表格 → 行 ─────────────
function colFmt(col: Column, rows: Array<Record<string, Cell>>): NumFmt {
  if (col.format === 'percent') return 'pct'
  if (col.format === 'score') return 'score'
  const vals = rows.map(r => r[col.key]).filter((v): v is number => typeof v === 'number')
  return vals.every(Number.isInteger) ? 'int' : 'num'
}

function tableRows(columns: Column[], rows: Array<Record<string, Cell>>, highlight?: Parameters<typeof isHighlighted>[2]): XRow[] {
  const fm = columns.map(c => colFmt(c, rows))
  const out: XRow[] = [{ cells: columns.map(c => ({ v: c.label, s: { bold: true, fill: HEAD_FILL, border: true, wrap: true } })) }]
  for (const r of rows) {
    const hi = isHighlighted(r, columns, highlight)
    out.push({ cells: columns.map((c, i) => {
      const v = r[c.key]
      const s: Style = { border: true, fill: hi ? HI_FILL : undefined }
      if (typeof v === 'number') return { v, s: { ...s, numFmt: fm[i] } }
      return { v: v === null || v === undefined ? '' : String(v), s }
    }) })
  }
  return out
}

const visual = (s: string): number => Math.ceil(textWidth(s, 11) / 6.2)
function widthsOf(rows: XRow[], skip: Set<number>, min = 8, max = 60): number[] {
  const n = Math.max(0, ...rows.map(r => r.cells.length))
  const w = Array.from({ length: n }, () => min)
  rows.forEach((r, ri) => {
    if (skip.has(ri)) return
    r.cells.forEach((c, i) => {
      if (c.v === null || c.v === '') return
      const t = typeof c.v === 'number' ? 12 : visual(String(c.v)) + 2
      w[i] = Math.min(max, Math.max(w[i], t))
    })
  })
  return w
}

/** 长文本行：合并 A..lastCol，自动折行，按字数估算行高 */
function textRow(text: string, cols: number, totalWidth: number, s: Style = {}): { row: XRow; long: boolean } {
  const lines = Math.max(1, Math.ceil(visual(text) / Math.max(20, totalWidth)))
  return { row: { cells: [{ v: text, s: { wrap: true, ...s } }], ht: Math.max(18, lines * 16 + 4) }, long: cols > 1 }
}

export async function exportTableXlsx(columns: Column[], rows: Array<Record<string, Cell>>, name = '名单'): Promise<Buffer> {
  const xr = tableRows(columns, rows)
  return buildXlsx([{ name, rows: xr, widths: widthsOf(xr, new Set()) }])
}

export async function exportBoardXlsx(spec: BoardSpec): Promise<Buffer> {
  const sheets: XSheet[] = []
  // 核心发现
  {
    const rows: XRow[] = [{ cells: [{ v: spec.title, s: { bold: true, size: 16 } }] }]
    if (spec.subtitle) rows.push({ cells: [{ v: spec.subtitle }] })
    if (spec.dataNote) rows.push({ cells: [{ v: `数据范围：${spec.dataNote}`, s: { color: '5E5D75' } }] })
    rows.push({ cells: [] })
    const headAt = rows.length
    rows.push({ cells: ['序号', '核心发现', '结论'].map(v => ({ v, s: { bold: true, fill: HEAD_FILL, border: true } })) })
    spec.findings.forEach((f, i) => rows.push({ cells: [{ v: i + 1, s: { border: true, numFmt: 'int' } }, { v: f.title, s: { border: true, wrap: true, bold: true } }, { v: f.body, s: { border: true, wrap: true } }], ht: Math.max(20, Math.ceil(visual(f.body) / 88) * 16 + 6) }))
    void headAt
    sheets.push({ name: '核心发现', rows, widths: [8, 28, 90] })
  }
  for (const sec of spec.sections) {
    const rows: XRow[] = []
    const merges: string[] = []
    const mergedRows = new Set<number>()
    // 先收集所有块的表，得到总列数
    const blocksRows: XRow[][] = []
    let maxCols = 4
    for (const b of sec.blocks) {
      const rs: XRow[] = []
      if (b.type === 'chart') {
        rs.push({ cells: [{ v: b.chart.title, s: { bold: true } }] })
        const t = chartToTable(b.chart)
        rs.push(...tableRows(t.columns, t.rows))
        if (b.chart.notes) rs.push({ cells: [{ v: `注：${b.chart.notes}`, s: { color: '5E5D75' } }] })
        maxCols = Math.max(maxCols, t.columns.length)
      } else if (b.type === 'table') {
        if (b.title) rs.push({ cells: [{ v: b.title, s: { bold: true } }] })
        rs.push(...tableRows(b.columns, b.rows, b.highlight))
        maxCols = Math.max(maxCols, b.columns.length)
      } else if (b.type === 'kpi') {
        rs.push({ cells: ['指标', '数值', '变化'].map(v => ({ v, s: { bold: true, fill: HEAD_FILL, border: true } })) })
        for (const it of b.items) rs.push({ cells: [{ v: it.label, s: { border: true } }, { v: it.value, s: { border: true } }, { v: it.delta ?? '', s: { border: true } }] })
      } else {
        rs.push({ cells: [{ v: b.markdown.replace(/\*\*/g, '').replace(/^#+\s*/gm, ''), s: { wrap: true } }] })
      }
      if ('source' in b && b.source) rs.push({ cells: [{ v: `出处：${b.source.queryId}`, s: { color: '8A89A0', size: 9 } }] })
      blocksRows.push(rs)
    }
    rows.push({ cells: [{ v: sec.title, s: { bold: true, size: 14 } }] })
    const textStart: Array<[number, XRow]> = []
    if (sec.intro) textStart.push([rows.length, textRow(sec.intro, maxCols, 100, { wrap: true }).row])
    if (sec.intro) rows.push(textStart[0][1])
    rows.push({ cells: [] })
    sec.blocks.forEach((b, bi) => {
      for (const r of blocksRows[bi]) {
        if (b.type === 'text' || (r.cells.length === 1 && r.cells[0].s?.wrap)) {
          const t = textRow(String(r.cells[0].v), maxCols, 100, { wrap: true })
          mergedRows.add(rows.length); rows.push(t.row)
        } else rows.push(r)
      }
      rows.push({ cells: [] })
    })
    if (sec.intro) mergedRows.add(1)
    const widths = widthsOf(rows, new Set([...mergedRows, ...rows.map((r, i) => (r.cells.length === 1 && !r.cells[0].s?.border && r.cells[0].s?.bold ? i : -1)).filter(i => i >= 0), ...rows.map((r, i) => (r.cells.length === 1 ? i : -1)).filter(i => i >= 0)]))
    while (widths.length < maxCols) widths.push(12)
    // 文字行合并到最后一列
    for (const i of mergedRows) merges.push(`A${i + 1}:${colName(Math.max(1, widths.length - 1))}${i + 1}`)
    // 合并后的总宽用于行高估算：这里按宽度重算
    const total = widths.reduce((a, b) => a + b, 0)
    for (const i of mergedRows) {
      const c = rows[i].cells[0]
      rows[i].ht = Math.max(18, Math.ceil(visual(String(c.v)) / Math.max(20, total)) * 16 + 4)
    }
    sheets.push({ name: sec.title, rows, widths, merges })
  }
  {
    const rows: XRow[] = [{ cells: [{ v: '口径说明', s: { bold: true, size: 14 } }] }, { cells: [] }]
    spec.caliber.forEach((t, i) => rows.push({ cells: [{ v: i + 1, s: { border: true, numFmt: 'int' } }, { v: t, s: { border: true, wrap: true } }], ht: Math.max(18, Math.ceil(visual(t) / 100) * 16 + 4) }))
    if (!spec.caliber.length) rows.push({ cells: [{ v: '（暂无口径说明）' }] })
    sheets.push({ name: '口径说明', rows, widths: [8, 100] })
  }
  return buildXlsx(sheets)
}
