/**
 * Word / PDF / 图片版课程表 → 二维表。纯函数模块（不依赖 electron），单测直接加载。
 *  · Word 里有真表格：确定性地按单元格读出来（和 xlsx 的工作表一样走认列），不经 AI；
 *  · 其它（PDF、图片、没有表格的 Word）：文字加行号交给 p5_course_extract，AI 只能逐字复制；
 *    程序再逐条核对「标题是不是原文里真的有」，找不到的整行丢掉并提示。
 */
import JSZip from 'jszip'
import { CourseFileError, LIMITS, ZIP_LIMITS, cleanCell, decodeXml, readText, scanElements } from './table-read.ts'
import type { Sheet, TableRead } from './table-read.ts'
import type { SheetMapping } from './map.ts'
import { COURSE_MAX_PAGES } from '../../shared/file-limits.ts'

/** 发给 AI 的文字上限（字符）；再多就不像一份课程表了 */
export const MAX_SOURCE_CHARS = 60_000
/** PDF / 图片最多处理的页数 */
export const MAX_PAGES = COURSE_MAX_PAGES
/** PDF 由渲染窗口按需分块读取（不进内存），上限同试卷导入；Word / Excel / 图片要整份读进内存，另有较小的上限 */

export type RichKind = 'docx' | 'pdf' | 'image'
export const KIND_LABEL: Record<RichKind, string> = { docx: 'Word', pdf: 'PDF', image: '图片' }

export function richKindOf(ext: string): RichKind | null {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (e === 'docx') return 'docx'
  if (e === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'heic'].includes(e)) return 'image'
  return null
}

// ───────────────────────── Word 里的表格 ─────────────────────────

const attrOf = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|[\\s:])${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? decodeXml(m[1]) : undefined
}

/** 一个单元格里的文字：每个段落的 <w:t> 拼起来，段落之间换行 */
function cellText(body: string): string {
  const paras: string[] = []
  for (const p of scanElements(body, 'w:p')) {
    let s = ''
    for (const t of scanElements(p.body, 'w:t')) s += decodeXml(t.body)
    if (s.trim()) paras.push(s)
  }
  return cleanCell(paras.join('\n'))
}

/** document.xml → 若干张表。横向合并（gridSpan）向右、纵向合并（vMerge）向下填同样的内容；至少 2 行 2 列、有 2 行以上有字才算「可用」的表 */
export function tablesFromDocumentXml(xml: string): Sheet[] {
  const out: Sheet[] = []
  let idx = 0
  for (const tbl of scanElements(xml, 'w:tbl')) {
    idx++
    const grid: string[][] = []
    let merged = false
    for (const tr of scanElements(tbl.body, 'w:tr')) {
      if (grid.length >= LIMITS.rows) break
      const row: string[] = []
      const above = grid[grid.length - 1] ?? []
      for (const tc of scanElements(tr.body, 'w:tc')) {
        const pr = scanElements(tc.body, 'w:tcPr').next().value?.body ?? ''
        const span = Math.max(1, Math.min(LIMITS.cols, parseInt(attrOf(scanElements(pr, 'w:gridSpan').next().value?.attrs ?? '', 'w:val') ?? '1', 10) || 1))
        const vm = scanElements(pr, 'w:vMerge').next().value
        const cont = !!vm && (attrOf(vm.attrs, 'w:val') ?? 'continue') !== 'restart'
        let text = cellText(tc.body)
        if (cont && !text) { text = above[row.length] ?? ''; if (text) merged = true }
        for (let k = 0; k < span && row.length < LIMITS.cols; k++) { row.push(text); if (k > 0 && text) merged = true }
      }
      grid.push(row)
    }
    const nCols = Math.max(0, ...grid.map(r => r.length))
    const rows = grid.map(r => Array.from({ length: nCols }, (_, c) => r[c] ?? ''))
    while (rows.length && rows[rows.length - 1].every(x => !x)) rows.pop()
    const filled = rows.filter(r => r.some(x => x)).length
    if (rows.length >= 2 && nCols >= 2 && filled >= 2) out.push({ name: `表格${idx}`, hidden: false, rows, mergedFilled: merged })
  }
  return out
}

/** 读 .docx 里的表格；没有可用的表格返回 null（调用方改走文字整理）。同样防压缩炸弹 */
export async function readDocxTables(buf: Uint8Array): Promise<TableRead | null> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buf) } catch { throw new CourseFileError('这个文件打不开，可能已损坏，或者不是 .docx 文档') }
  const entries = Object.values(zip.files)
  if (entries.length > ZIP_LIMITS.entries) throw new CourseFileError('这个文件解压后太大，不像正常的课程表（可能已损坏或不安全），已拒绝读取')
  const xml = await readText(zip, 'word/document.xml', { used: 0 })
  if (xml == null) throw new CourseFileError('这个文件不像 Word 文档（.docx），请检查文件')
  const filledOf = (sh: Sheet) => sh.rows.filter(r => r.some(x => x)).length
  const all = tablesFromDocumentXml(xml)
  // 只取最大的那张表；至少 1 行表头 + 3 行有字的数据、2 列，否则（比如只有一张 2x2 的信息表）改走文字整理
  const best = all.reduce<Sheet | null>((a, b) => (!a || filledOf(b) > filledOf(a) ? b : a), null)
  if (!best || filledOf(best) < 4 || (best.rows[0]?.length ?? 0) < 2) return null
  const sheets = [best]
  const warnings: string[] = []
  if (sheets.length > LIMITS.sheets) { sheets.length = LIMITS.sheets; warnings.push(`表格超过 ${LIMITS.sheets} 个，后面的已忽略`) }
  return { sheets, warnings }
}

// ───────────────────────── 文字 + 行号 ─────────────────────────

/** 把若干行文字编号：L1: …（空行丢掉）。返回给 AI 的文本和原始行（下标 = 行号 - 1） */
export function numberLines(rawLines: string[]): { text: string; lines: string[] } {
  const lines = rawLines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return { text: lines.map((l, i) => `L${i + 1}: ${l}`).join('\n'), lines }
}

// ───────────────────────── AI 回答的校验 ─────────────────────────

/** 比较用：去掉空白、标点、符号，英文转小写 */
export const normForFind = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 标题是不是原文里真的有（空标题算没有） */
export function titleInSource(title: string, sourceText: string): boolean {
  const t = normForFind(title)
  const minLen = /[\u4e00-\u9fff]/.test(t) ? 2 : 3
  if (t.length < minLen) return false
  // 必须落在同一行里，不能跨行拼出来
  return sourceText.split('\n').some(line => normForFind(line).includes(t))
}

export interface ExtractedLesson { level: string; seq: string; title: string; theme: string; words: string; patterns: string }
export interface ExtractParse { ok: boolean; lessons: ExtractedLesson[]; dropped: string[]; problems: string[] }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** 校验 p5_course_extract 的回答。每条的标题（以及有写的主题、词汇、句型）要能在原文里找到，找不到的整条丢掉并记下标题；原文 = 带行号文字里的各行（不含行号） */
export function parseExtractResponse(text: string, sourceLines: string[]): ExtractParse {
  let j: any
  try { j = JSON.parse(stripFence(text)) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    try { j = m ? JSON.parse(m[0]) : null } catch { j = null }
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.lessons)) return { ok: false, lessons: [], dropped: [], problems: ['AI 的回答不是有效的 JSON'] }
  const source = sourceLines.join('\n')
  const lessons: ExtractedLesson[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const x of j.lessons.slice(0, 5000)) {
    if (!x || typeof x !== 'object') continue
    const title = str(x.title, 300)
    if (!title) continue
    if (!titleInSource(title, source)) { dropped.push(title.slice(0, 40)); continue }
    const dupKey = [x.level, x.seq, title].map(v => normForFind(String(v ?? ''))).join('|')
    if (seen.has(dupKey)) continue
    seen.add(dupKey)
    // 级别、主题、词汇、句型：写了但原文里找不到的，只清空这一项（课本身是真的）
    const keep = (v: unknown, max: number) => { const s = str(v, max); return s.split(/[；;]/).every(p => !p.trim() || titleInSource(p, source)) ? s : '' }
    lessons.push({ level: keep(x.level, 60), seq: str(x.seq, 60), title, theme: keep(x.theme, 300), words: keep(x.words, 2000), patterns: keep(x.patterns, 2000) })
  }
  const problems: string[] = []
  if (dropped.length) problems.push(`有 ${dropped.length} 课在原文里找不到，已去掉：${dropped.slice(0, 3).map(d => `「${d}」`).join('')}${dropped.length > 3 ? '等' : ''}`)
  return { ok: true, lessons, dropped, problems }
}

/** 整理出的课 → 一张表（表头 + 每课一行）和固定的列映射。课次没写时按同一级别里的顺序补数字 */
export const EXTRACT_HEADER = ['课次', '级别', '课程标题', '主题', '词汇', '句型']
export const EXTRACT_MAPPING: SheetMapping = {
  headerRows: 1, levelName: '', skipMarkers: [], uncertain: [],
  columns: [{ col: 0, field: 'seq' }, { col: 1, field: 'level' }, { col: 2, field: 'title' }, { col: 3, field: 'theme' }, { col: 4, field: 'word' }, { col: 5, field: 'pattern' }]
}
export function lessonsToSheet(name: string, lessons: ExtractedLesson[]): Sheet {
  const count = new Map<string, number>()
  const rows = lessons.map(l => {
    const n = (count.get(l.level) ?? 0) + 1
    count.set(l.level, n)
    return [l.seq || String(n), l.level, l.title, l.theme, l.words, l.patterns]
  })
  return { name: name.slice(0, 31) || '课程表', hidden: false, rows: [EXTRACT_HEADER, ...rows], mergedFilled: false }
}
