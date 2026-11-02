/**
 * 「认列」提示词（p5_course_cols）的输入输出处理。纯函数模块。
 * 输入：一张 sheet 的名字 + 前 12 行 + 均匀抽样的 3 行 + 最后 3 行（每个格子截到 60 字）。
 * 输出：表头行数、级别名、各列类型、要跳过的标记字样、拿不准的地方。程序校验后交给 map.ts 套用到全表。
 */
import { COL_FIELDS, FIELD_LABEL, cellForAi } from './map.ts'
import type { ColField, SheetMapping } from './map.ts'
import type { Sheet } from './table-read.ts'

const HEAD_ROWS = 12
const SAMPLE_ROWS = 3
const TAIL_ROWS = 3

/** 一行写成「行3: 1=第1课 | 3=Hello」：只列有字的格子，列号从 1 开始 */
function rowLine(sheet: Sheet, r: number): string {
  const cells = sheet.rows[r].map((v, c) => [c + 1, cellForAi(v)] as const).filter(([, v]) => v)
  return `行${r + 1}: ${cells.length ? cells.map(([c, v]) => `${c}=${v}`).join(' | ') : '（空行）'}`
}

export function sheetPreview(sheet: Sheet): string {
  const n = sheet.rows.length
  const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const picked = new Set<number>()
  for (let i = 0; i < Math.min(HEAD_ROWS, n); i++) picked.add(i)
  if (n > HEAD_ROWS) {
    const mid0 = HEAD_ROWS, mid1 = n - TAIL_ROWS - 1
    for (let k = 1; k <= SAMPLE_ROWS && mid1 >= mid0; k++) picked.add(mid0 + Math.floor(((mid1 - mid0) * k) / (SAMPLE_ROWS + 1)))
    for (let i = Math.max(HEAD_ROWS, n - TAIL_ROWS); i < n; i++) picked.add(i)
  }
  const idx = [...picked].sort((a, b) => a - b)
  const lines: string[] = [`共 ${n} 行、${cols} 列（列号从 1 开始，只列出有内容的格子；中间的行只抽样几行）`]
  let prev = -1
  for (const r of idx) {
    if (prev >= 0 && r > prev + 1) lines.push(`…（省略 ${r - prev - 1} 行）`)
    lines.push(rowLine(sheet, r))
    prev = r
  }
  return lines.join('\n')
}

export interface ColsParse { ok: boolean; mapping: SheetMapping | null; problems: string[] }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

/** 校验 AI 的回答（JSON 文本）：列号越界、类型不认识的丢掉并记问题；没有课次 / 标题列算失败 */
export function parseColsResponse(text: string, sheet: Sheet): ColsParse {
  let j: any
  try { j = JSON.parse(stripFence(text)) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    try { j = m ? JSON.parse(m[0]) : null } catch { j = null }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, mapping: null, problems: ['AI 的回答不是有效的 JSON'] }
  const problems: string[] = []
  const nCols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  let headerRows = Number.isInteger(j.header_rows) ? j.header_rows : 1
  if (headerRows < 0 || headerRows > Math.min(10, Math.max(0, sheet.rows.length - 1))) { problems.push('表头行数不合理，已改为 1'); headerRows = 1 }
  const columns: SheetMapping['columns'] = []
  const used = new Set<number>()
  const allowed = new Set<string>(COL_FIELDS)
  for (const c of Array.isArray(j.columns) ? j.columns : []) {
    const col = Number.isInteger(c?.col) ? c.col - 1 : -1
    if (col < 0 || col >= nCols) { problems.push(`有一列的列号（${String(c?.col)}）不在表里，已忽略`); continue }
    if (used.has(col)) continue
    if (!allowed.has(c?.field)) { problems.push(`第 ${col + 1} 列的类型 AI 没说清，已忽略`); continue }
    used.add(col)
    columns.push({ col, field: c.field as ColField })
  }
  const skipMarkers = (Array.isArray(j.skip_markers) ? j.skip_markers : []).filter((s: unknown) => typeof s === 'string' && s.trim() && s.length <= 20).slice(0, 20).map((s: string) => s.trim())
  const uncertain = (Array.isArray(j.uncertain) ? j.uncertain : []).filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 8).map((s: string) => s.trim().slice(0, 80))
  const levelName = typeof j.level_name === 'string' ? j.level_name.trim().slice(0, 40) : ''
  const hasKey = columns.some(c => c.field === 'seq' || c.field === 'title')
  if (!hasKey) problems.push(`没有认出「${FIELD_LABEL.seq}」或「${FIELD_LABEL.title}」那一列`)
  return { ok: hasKey, mapping: { headerRows, levelName, columns, skipMarkers, uncertain }, problems }
}
