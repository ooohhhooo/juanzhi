/**
 * 读课程表：xlsx（用 jszip 自己解 zip + XML，不新增依赖）、csv / 粘贴的制表符文本。纯函数模块（不依赖 electron），单测直接加载。
 * 只负责把文件变成「若干张二维文字表」：合并单元格向下 / 向右填充，隐藏的 sheet 默认跳过并提示，日期按文本。
 * 不理解内容——哪一列是什么由 map.ts 决定。
 */
import JSZip from 'jszip'

export interface Sheet {
  name: string
  hidden: boolean
  /** 二维文字表，每行长度一致（补空串） */
  rows: string[][]
  /** 发生过合并单元格填充（预览时提示一句） */
  mergedFilled: boolean
}

export interface TableRead {
  sheets: Sheet[]
  warnings: string[]
}

/** 白话错误（文件本身有问题）：message 可以直接给用户看 */
export class CourseFileError extends Error {}

export const LIMITS = { sheets: 20, rows: 5000, cols: 60, cellChars: 2000 } as const
/** xlsx 本质是 zip：先看目录里声明的大小，解压时再按实际大小计数，防「压缩炸弹」 */
export const ZIP_LIMITS = { entries: 1000, entryBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, sharedStrings: 300_000, sharedChars: 30_000_000 } as const
const BOMB_MSG = '这个文件解压后太大，不像正常的课程表（可能已损坏或不安全），已拒绝读取'

// ───────────────────────── 文字清理 ─────────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decodeXml(s: string): string {
  return s
    .replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-z]+));/g, (m, hex, dec, name) => {
      if (name) return ENTITY[name] ?? m
      const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10)
      try { return String.fromCodePoint(cp) } catch { return '' }
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

/** 单元格文字：去控制字符、统一换行、首尾空白，限长 */
export function cleanCell(s: unknown): string {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​﻿]/g, '').trim().slice(0, LIMITS.cellChars)
}

// ───────────────────────── xlsx ─────────────────────────

const colIndex = (letters: string): number => {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const parseRef = (ref: string): { r: number; c: number } | null => {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref.trim())
  return m ? { c: colIndex(m[1]), r: parseInt(m[2], 10) - 1 } : null
}
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|[\\s])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)
  return m ? decodeXml(m[2] ?? m[3] ?? '') : undefined
}

/**
 * 线性扫描：依次给出 <name …> 元素的属性串和内容。找不到结束标签就停下（不回头重扫——
 * 恶意文件里成千上万个没闭合的 <c r=…> 不会造成二次方的耗时）。<cellXfs> 这类前缀相同的标签靠「下一个字符」区分。
 */
export function* scanElements(xml: string, name: string): Generator<{ attrs: string; body: string }> {
  const open = `<${name}`
  const close = `</${name}>`
  let pos = 0
  for (;;) {
    const i = xml.indexOf(open, pos)
    if (i < 0) return
    const c = xml.charCodeAt(i + open.length)
    if (!(c === 32 || c === 62 || c === 47 || c === 9 || c === 10 || c === 13)) { pos = i + open.length; continue }
    const gt = xml.indexOf('>', i)
    if (gt < 0) return
    if (xml.charCodeAt(gt - 1) === 47) { yield { attrs: xml.slice(i + open.length, gt - 1), body: '' }; pos = gt + 1; continue }
    const end = xml.indexOf(close, gt + 1)
    if (end < 0) return
    yield { attrs: xml.slice(i + open.length, gt), body: xml.slice(gt + 1, end) }
    pos = end + close.length
  }
}

/** 去掉 <rPh>…</rPh>（注音）。线性，找不到结束就保留剩下的 */
function stripElement(xml: string, name: string): string {
  let out = '', pos = 0
  for (;;) {
    const i = xml.indexOf(`<${name}`, pos)
    if (i < 0) break
    const end = xml.indexOf(`</${name}>`, i)
    if (end < 0) break
    out += xml.slice(pos, i)
    pos = end + name.length + 3
  }
  return out + xml.slice(pos)
}

/** <si> 里的文字：所有 <t> 拼起来，注音（rPh）不要 */
function siText(si: string): string {
  const parts: string[] = []
  for (const t of scanElements(stripElement(si, 'rPh'), 't')) parts.push(decodeXml(t.body))
  return parts.join('')
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').replace(/_./g, '')
  return /[ymdhs]/i.test(stripped) && !/^general$/i.test(code.trim())
}
function dateStyles(stylesXml: string | null): Set<number> {
  const out = new Set<number>()
  if (!stylesXml) return out
  const custom = new Map<number, string>()
  for (const m of scanElements(stylesXml, 'numFmt')) {
    const id = parseInt(attr(m.attrs, 'numFmtId') ?? '', 10)
    const code = attr(m.attrs, 'formatCode')
    if (Number.isFinite(id) && code) custom.set(id, code)
  }
  const cellXfs = scanElements(stylesXml, 'cellXfs').next().value?.body ?? ''
  let i = 0
  for (const m of scanElements(cellXfs, 'xf')) {
    const id = parseInt(attr(m.attrs, 'numFmtId') ?? '0', 10)
    if (BUILTIN_DATE_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i)
    i++
  }
  return out
}
const pad2 = (n: number) => String(n).padStart(2, '0')
function serialToText(v: number): string {
  const ms = Math.round(v * 86400000)
  const d = new Date(Date.UTC(1899, 11, 30) + ms)
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  const hasTime = Math.abs(v - Math.floor(v)) > 1e-9
  return hasTime ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day
}
function numberText(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toPrecision(15)))
}

export interface Budget { used: number }

/** 解压一个条目并按「实际解压出的字节数」计数，超过上限立刻停（目录里声明的大小可以是假的） */
export function readText(zip: JSZip, p: string, budget: Budget): Promise<string | null> {
  const f = zip.file(p) ?? zip.file(p.replace(/^\//, ''))
  if (!f) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let n = 0, done = false
    const h = (f as unknown as { internalStream(t: string): { on(e: string, cb: (x: never) => void): unknown; pause(): void; resume(): void } }).internalStream('uint8array')
    const fail = (e: Error) => { if (done) return; done = true; try { h.pause() } catch { /* 已结束 */ } reject(e) }
    h.on('data', ((d: Uint8Array) => {
      n += d.length; budget.used += d.length
      if (n > ZIP_LIMITS.entryBytes || budget.used > ZIP_LIMITS.totalBytes) fail(new CourseFileError(BOMB_MSG))
      else chunks.push(d)
    }) as (x: never) => void)
    h.on('error', () => fail(new CourseFileError('这个文件打不开，可能已损坏')))
    h.on('end', () => { if (done) return; done = true; resolve(new TextDecoder('utf-8').decode(Buffer.concat(chunks))) })
    h.resume()
  })
}

/** 解一个 xlsx（Buffer / Uint8Array） */
export async function readXlsx(buf: Uint8Array): Promise<TableRead> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buf) } catch { throw new CourseFileError('这个文件打不开，可能已损坏，或者不是 .xlsx 表格') }
  // 先看目录（这时还没有解压任何东西）：条目数、每个条目声明的解压后大小
  const entries = Object.values(zip.files)
  if (entries.length > ZIP_LIMITS.entries) throw new CourseFileError(BOMB_MSG)
  let declared = 0
  for (const e of entries) {
    const sz = Number((e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)
    if (sz > ZIP_LIMITS.entryBytes) throw new CourseFileError(BOMB_MSG)
    declared += sz
  }
  if (declared > ZIP_LIMITS.totalBytes) throw new CourseFileError(BOMB_MSG)
  const budget: Budget = { used: 0 }
  const wb = await readText(zip, 'xl/workbook.xml', budget)
  if (!wb) throw new CourseFileError('这个文件里没有找到工作表，请用 Excel 或 WPS 重新另存为 .xlsx')
  const relsXml = (await readText(zip, 'xl/_rels/workbook.xml.rels', budget)) ?? ''
  const rels = new Map<string, string>()
  for (const m of scanElements(relsXml, 'Relationship')) {
    const id = attr(m.attrs, 'Id'), target = attr(m.attrs, 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sharedXml = await readText(zip, 'xl/sharedStrings.xml', budget)
  const shared: string[] = []
  let sharedChars = 0
  if (sharedXml) {
    for (const m of scanElements(sharedXml, 'si')) {
      const t = siText(m.body)
      sharedChars += t.length
      if (shared.length >= ZIP_LIMITS.sharedStrings || sharedChars > ZIP_LIMITS.sharedChars) throw new CourseFileError(BOMB_MSG)
      shared.push(t)
    }
  }
  const dateXf = dateStyles(await readText(zip, 'xl/styles.xml', budget))

  const sheetTags = [...scanElements(wb, 'sheet')].map(m => m.attrs)
  const warnings: string[] = []
  const sheets: Sheet[] = []
  let idx = 0
  for (const tag of sheetTags) {
    idx++
    if (sheets.length >= LIMITS.sheets) { warnings.push(`工作表超过 ${LIMITS.sheets} 个，后面的已忽略`); break }
    const name = attr(tag, 'name') ?? `Sheet${idx}`
    const state = attr(tag, 'state')
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id')
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${idx}.xml`
    const xml = await readText(zip, path, budget)
    if (xml == null) continue
    const parsed = parseSheetXml(xml, shared, dateXf)
    if (parsed.truncated) warnings.push(`「${name}」超过 ${LIMITS.rows} 行或 ${LIMITS.cols} 列，多出的部分已忽略`)
    sheets.push({ name, hidden: state === 'hidden' || state === 'veryHidden', rows: parsed.rows, mergedFilled: parsed.merged })
  }
  if (!sheets.length) throw new CourseFileError('这个文件里没有读到任何工作表')
  return { sheets, warnings }
}

function parseSheetXml(xml: string, shared: string[], dateXf: Set<number>): { rows: string[][]; merged: boolean; truncated: boolean } {
  const grid: string[][] = []
  let maxC = 0, truncated = false
  for (const m of scanElements(xml, 'c')) {
    const pos = parseRef(attr(m.attrs, 'r') ?? '')
    if (!pos) continue
    if (pos.r >= LIMITS.rows || pos.c >= LIMITS.cols) { truncated = true; continue }
    const body = m.body
    const t = attr(m.attrs, 't')
    const s = parseInt(attr(m.attrs, 's') ?? '-1', 10)
    let text = ''
    if (t === 'inlineStr') text = siText(scanElements(body, 'is').next().value?.body ?? '')
    else {
      const v = decodeXml(scanElements(body, 'v').next().value?.body ?? '')
      if (t === 's') text = shared[parseInt(v, 10)] ?? ''
      else if (t === 'str') text = v
      else if (t === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''
      else if (t === 'e') text = ''
      else if (v !== '') text = dateXf.has(s) && Number.isFinite(Number(v)) ? serialToText(Number(v)) : numberText(v)
    }
    text = cleanCell(text)
    if (!text) continue
    while (grid.length <= pos.r) grid.push([])
    grid[pos.r][pos.c] = text
    if (pos.c + 1 > maxC) maxC = pos.c + 1
  }
  // 合并单元格：左上角的内容铺满整个区域
  let merged = false
  for (const mm of scanElements(xml, 'mergeCell')) {
    const ref = attr(mm.attrs, 'ref')
    const [a, b] = (ref ?? '').split(':')
    const p1 = a ? parseRef(a) : null, p2 = b ? parseRef(b) : null
    if (!p1 || !p2) continue
    const v = grid[p1.r]?.[p1.c]
    if (!v) continue
    for (let r = p1.r; r <= Math.min(p2.r, LIMITS.rows - 1); r++) {
      for (let c = p1.c; c <= Math.min(p2.c, LIMITS.cols - 1); c++) {
        if (r === p1.r && c === p1.c) continue
        while (grid.length <= r) grid.push([])
        if (!grid[r][c]) { grid[r][c] = v; merged = true; if (c + 1 > maxC) maxC = c + 1 }
      }
    }
  }
  const rows = grid.map(r => Array.from({ length: maxC }, (_, c) => r[c] ?? ''))
  while (rows.length && rows[rows.length - 1].every(x => !x)) rows.pop()
  return { rows, merged, truncated }
}

// ───────────────────────── csv / 粘贴文本 ─────────────────────────

/** 字节 → 文字：先试 UTF-8（带 BOM 也行），失败按 GBK（中文 Windows 的 Excel 另存 csv 常见）。encoding 和 suspicious 给上层提示「可能乱码」 */
export function decodeTextInfo(buf: Uint8Array): { text: string; encoding: 'utf-8' | 'gbk' | 'utf-16le'; suspicious: boolean } {
  let b = buf
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le', suspicious: false }
  let text: string, encoding: 'utf-8' | 'gbk' = 'utf-8'
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(b) } catch {
    encoding = 'gbk'
    try { text = new TextDecoder('gbk').decode(b) } catch { text = new TextDecoder('utf-8').decode(b); encoding = 'utf-8' }
  }
  // 看起来不对：有替换字符、常见的「锟斤拷」、UTF-8 被当 Latin-1 读出来的 Ã/Â/ï»¿，或者 GBK 读出来后几乎没有常用汉字
  const sample = text.slice(0, 20000)
  const bad = (sample.match(/[\ufffd]|锟斤拷|Ã.|Â.|ï»¿/g) ?? []).length
  const suspicious = bad >= 3 || (sample.length > 20 && bad / sample.length > 0.01)
  return { text, encoding, suspicious }
}
export const decodeText = (buf: Uint8Array): string => decodeTextInfo(buf).text

function detectDelimiter(text: string): string {
  const head = text.split('\n').slice(0, 10).join('\n')
  const cands = ['\t', ',', ';']
  const n = (d: string) => head.split(d).length - 1
  const best = cands.map(d => [d, n(d)] as const).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

/** RFC 4180：引号包裹、双引号转义、引号内可含换行与分隔符 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const d = delimiter ?? detectDelimiter(t)
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQ = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++ } else inQ = false } else cell += ch
    } else if (ch === '"' && cell === '') inQ = true
    else if (ch === d) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export function readCsvText(text: string, name: string): TableRead {
  const warnings: string[] = []
  let rows = parseCsv(text).map(r => r.map(cleanCell))
  if (rows.length > LIMITS.rows) { rows = rows.slice(0, LIMITS.rows); warnings.push(`超过 ${LIMITS.rows} 行，多出的部分已忽略`) }
  let maxC = Math.max(0, ...rows.map(r => r.length))
  if (maxC > LIMITS.cols) { maxC = LIMITS.cols; warnings.push(`超过 ${LIMITS.cols} 列，多出的部分已忽略`) }
  rows = rows.map(r => Array.from({ length: maxC }, (_, c) => r[c] ?? ''))
  while (rows.length && rows[rows.length - 1].every(x => !x)) rows.pop()
  if (!rows.length) throw new CourseFileError('这个表里没有读到任何内容')
  return { sheets: [{ name, hidden: false, rows, mergedFilled: false }], warnings }
}

/** 按文件名和文件头判断格式并读取（文件名只用来判断扩展名，不进日志） */
export async function readTable(buf: Uint8Array, fileName: string): Promise<TableRead> {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? '').toLowerCase()
  if (ext === 'xls') throw new CourseFileError('这是旧版 Excel 格式（.xls），请用 Excel 或 WPS 打开后「另存为」.xlsx 再上传')
  if (ext === 'numbers') throw new CourseFileError('这是 Numbers 文件，请在 Numbers 里「导出为」Excel（.xlsx）或 CSV 后再上传')
  if (ext === 'wps' || ext === 'et') throw new CourseFileError('请用 WPS 把文件「另存为」.xlsx 再上传')
  if (ext === 'doc') throw new CourseFileError('这是旧版 Word 格式（.doc），请用 Word 或 WPS 打开后「另存为」.docx 再上传')
  if (['docx', 'pdf', 'png', 'jpg', 'jpeg', 'heic'].includes(ext)) throw new CourseFileError('Word、PDF 和图片需要先转成文字，请从“选择文件”上传')
  const zipMagic = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
  const oleMagic = buf.length > 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
  if (oleMagic) throw new CourseFileError('这是旧版 Excel 格式（.xls），请用 Excel 或 WPS 打开后「另存为」.xlsx 再上传')
  if (ext === 'xlsx' || ext === 'xlsm' || (zipMagic && !ext)) return readXlsx(buf)
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv' || ext === '') {
    const name = fileName.replace(/\.[^.]+$/, '').slice(0, 40) || '课程表'
    const d = decodeTextInfo(buf)
    const r = readCsvText(d.text, name)
    if (d.encoding === 'gbk') r.warnings.push('这个文件不是 UTF-8，已按 GBK 读取；如果下面的文字有乱码，请用 Excel 另存为 UTF-8 的 CSV 或 .xlsx 再上传')
    if (d.suspicious) r.warnings.push('读出来的文字里有疑似乱码，请核对；乱码的话请用 Excel 另存为 .xlsx 再上传')
    return r
  }
  throw new CourseFileError('不认识这种文件，请上传 Excel、CSV、Word、PDF 或图片')
}

// ───────────────────────── 写 xlsx（空白模板 / 虚构示例，运行时生成） ─────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const colName = (c: number): string => { let n = c + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) } return s }

/** 生成一个最小可用的 xlsx（全部按文字存，行内字符串） */
export async function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  sheets.forEach((s, i) => {
    const body = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`)).join('')}</row>`).join('')
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
  })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
