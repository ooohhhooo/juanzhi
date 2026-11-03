/**
 * 表头识别、列名清洗、类型推断（含多选）。纯函数，不依赖 electron。
 * 输入全是「文字单元格」（读表层已把 Excel 日期转成文字），空串 = 空单元格。
 */
import type { ColumnType } from '../types.ts'

// ───────────────────────── 列名 ─────────────────────────

/** 清洗成安全的 SQL 标识片段：小写，只留字母 / 数字 / 汉字 / 下划线，限长 */
export function sanitizeIdent(s: string, max = 24): string {
  const t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return [...t].slice(0, max).join('') || 'col'
}

/** 内部列名：c01_用户id（序号保证唯一，也保持与原表同序） */
export function internalColumnName(index: number, label: string): string {
  return `c${String(index + 1).padStart(2, '0')}_${sanitizeIdent(label)}`
}

/** 表名：清洗后加前缀避免以数字开头，重名加序号 */
export function internalTableName(sheet: string, used: Set<string>): string {
  let base = sanitizeIdent(sheet, 30)
  if (/^\d/.test(base)) base = 't_' + base
  let n = base, i = 2
  while (used.has(n.toLowerCase())) n = `${base}_${i++}`
  used.add(n.toLowerCase())
  return n
}

// ───────────────────────── 表头 ─────────────────────────

const NUMERIC_LIKE = /^[+-]?[\d,]*\.?\d+(?:[eE][+-]?\d+)?%?$/
const isNumericLike = (s: string) => NUMERIC_LIKE.test(s)

/**
 * 找表头行（下标，从 0 数）。前 15 行里第一行满足：非空格子够多（≥ 最宽行的 60%）、绝大多数不是数字、互不相同、不太长。
 * 标题行（只有 1 个格子，或合并后全是同一个字）、空行都会被跳过。找不到返回 -1（表示没有表头）。
 */
export function detectHeader(rows: string[][]): number {
  const scan = rows.slice(0, 15)
  const counts = scan.map(r => r.filter(c => c !== '').length)
  const maxN = Math.max(0, ...counts)
  if (maxN === 0) return -1
  const need = maxN === 1 ? 1 : Math.max(2, Math.ceil(maxN * 0.6))
  for (let i = 0; i < scan.length; i++) {
    const cells = scan[i].filter(c => c !== '')
    if (cells.length < need) continue
    if (cells.some(c => c.length > 60)) continue
    if (cells.filter(c => !isNumericLike(c)).length / cells.length < 0.8) continue
    if (new Set(cells).size < cells.length * 0.6) continue
    // 下面还有数据：下一个非空行要有内容
    return i
  }
  // 找不到文字表头时，再看有没有「全是数字」的表头行：评分列 1 2 3 4 5、年份列 2021 2022 2023……
  for (let i = 0; i < scan.length; i++) {
    const cells = scan[i].filter(c => c !== '')
    if (cells.length < need || cells.length < 2) continue
    if (isNumericHeader(cells, scan.slice(i + 1).find(r => r.some(c => c !== '')))) return i
  }
  return -1
}

/**
 * 全是数字的表头行：格子互不相同的整数，且是「连续递增的一串」（1–5 评分）或「都像年份」（1900–2200）；
 * 下一行要是数据（格子数相近，且不是接着上一行往下数——否则 1 2 3 / 4 5 6 只是一块数字，没有表头）。
 */
function isNumericHeader(cells: string[], next: string[] | undefined): boolean {
  if (!next) return false
  if (!cells.every(c => /^\d{1,4}$/.test(c.trim()))) return false
  const nums = cells.map(c => Number(c.trim()))
  if (new Set(nums).size !== nums.length) return false
  const run = nums.every((n, k) => k === 0 || n === nums[k - 1] + 1)
  const years = nums.every(n => n >= 1900 && n <= 2200)
  if (!run && !years) return false
  const nextCells = next.filter(c => c !== '')
  if (nextCells.length < Math.ceil(cells.length * 0.6)) return false
  const first = Number(nextCells[0])
  if (nextCells.every(c => /^\d{1,4}$/.test(c.trim())) && run && first === nums[nums.length - 1] + 1) return false   // 接着数下去：同一块数字
  return true
}

// ───────────────────────── 日期 / 数值 ─────────────────────────

const DATE_RE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const p2 = (n: number | string) => String(n).padStart(2, '0')

/** 规范成 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS；不是日期返回 null */
export function normalizeDate(s: string): { text: string; hasTime: boolean } | null {
  const m = DATE_RE.exec(s.trim())
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const day = `${m[1]}-${p2(mo)}-${p2(d)}`
  if (m[4] === undefined) return { text: day, hasTime: false }
  const h = +m[4], mi = +m[5], se = m[6] === undefined ? 0 : +m[6]
  if (h > 23 || mi > 59 || se > 59) return null
  return { text: `${day} ${p2(h)}:${p2(mi)}:${p2(se)}`, hasTime: true }
}

const BOOL_TRUE = new Set(['true', 't', 'yes', 'y', '是', '有'])
const BOOL_FALSE = new Set(['false', 'f', 'no', 'n', '否', '无', '没有'])
export function parseBool(s: string): 0 | 1 | null {
  const k = s.trim().toLowerCase()
  if (BOOL_TRUE.has(k)) return 1
  if (BOOL_FALSE.has(k)) return 0
  return null
}

const INT_RE = /^[+-]?(0|[1-9]\d{0,14})$/
const REAL_RE0 = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/
/** 小数 / 科学计数；纯数字太长（身份证号一类）或带前导 0 不算数值，免得丢精度 */
const REAL_RE = { test: (v: string) => REAL_RE0.test(v) && !/^[+-]?\d{16,}$/.test(v) && !/^[+-]?0\d/.test(v) }

// ───────────────────────── 多选 ─────────────────────────

/** 候选分隔符（按优先级）；┋ 是常见问卷系统导出的多选分隔符 */
export const MULTI_SEPARATORS = ['┋', '|', '；', ';', '、', '，', ',', '\n', '/'] as const

export function splitMulti(s: string, seps: readonly string[]): string[] {
  if (!seps.length) return [s.trim()].filter(Boolean)
  const re = new RegExp('[' + seps.map(x => (x === '\n' ? '\\n' : x.replace(/[\\\]^-]/g, '\\$&'))).join('') + ']')
  return s.split(re).map(x => x.trim()).filter(Boolean)
}

/**
 * 判断一列文本是不是多选：某些分隔符出现在不少单元格里，且拆出来的选项数量有限、反复出现、都比较短。
 * 自由文本（意见）里的逗号拆出来选项又多又长，不会误判。
 */
export function detectMulti(values: string[]): { separators: string[]; optionCount: number } | null {
  if (values.length < 3) return null
  const cands: Array<{ sep: string; share: number }> = []
  for (const sep of MULTI_SEPARATORS) {
    let hit = 0
    for (const v of values) if (v.includes(sep)) hit++
    const share = hit / values.length
    if (share >= 0.05) cands.push({ sep, share })
  }
  if (!cands.length) return null
  // 从最常见的分隔符开始逐个并入，取效果最好的一组
  cands.sort((a, b) => b.share - a.share)
  for (let k = 1; k <= Math.min(cands.length, 3); k++) {
    const seps = cands.slice(0, k).map(c => c.sep)
    const opts = new Map<string, number>()
    let pieces = 0, longPieces = 0
    for (const v of values) for (const p of splitMulti(v, seps)) { pieces++; opts.set(p, (opts.get(p) ?? 0) + 1); if (p.length > 24) longPieces++ }
    if (!opts.size) continue
    const wholeDistinct = new Set(values).size
    const ok = opts.size <= 60 && opts.size <= wholeDistinct && pieces / opts.size >= 3 && longPieces / pieces < 0.1
    if (ok) return { separators: seps, optionCount: opts.size }
  }
  return null
}

// ───────────────────────── 类型推断 ─────────────────────────

export interface Inferred {
  type: ColumnType
  multi?: { separators: string[]; optionCount: number }
}

/** 低基数文本 → select 的判定 */
function isSelect(distinct: number, n: number): boolean {
  return distinct <= 30 && (distinct <= n * 0.2 || (n < 40 && distinct <= Math.max(2, n / 2)))
}

/** 根据一列的所有非空单元格推断类型。允许 3% 以内的杂质（杂质原样当文本存，SQLite 列是弱类型） */
export function inferType(nonEmpty: string[]): Inferred {
  const n = nonEmpty.length
  if (n === 0) return { type: 'text' }
  const tol = n >= 30 ? Math.floor(n * 0.03) : 0
  let bool = 0, int = 0, real = 0, date = 0, dtime = 0
  const sample = nonEmpty.length > 200000 ? nonEmpty.filter((_, i) => i % Math.ceil(nonEmpty.length / 200000) === 0) : nonEmpty
  const sn = sample.length, stol = sn >= 30 ? Math.floor(sn * 0.03) : 0
  for (const v of sample) {
    if (parseBool(v) !== null) bool++
    if (INT_RE.test(v)) int++
    if (REAL_RE.test(v) && v.length <= 24) real++
    const d = normalizeDate(v)
    if (d) { if (d.hasTime) dtime++; else date++ }
  }
  void tol
  const distinct = new Set(sample).size
  if (bool === sn && distinct <= 2) return { type: 'boolean' }
  if (int >= sn - stol && int > 0) return { type: 'integer' }
  if (real >= sn - stol && real > 0) return { type: 'real' }
  if (date + dtime >= sn - stol && date + dtime > 0) return { type: dtime > 0 ? 'datetime' : 'date' }
  const multi = detectMulti(nonEmpty)
  if (multi) return { type: 'multi', multi }
  const allDistinct = new Set(nonEmpty).size
  if (isSelect(allDistinct, n)) return { type: 'select' }
  return { type: 'text' }
}

/** 单元格文字 → 写库的值（按列类型；转不了的原样当文本） */
export function convertCell(type: ColumnType, s: string): string | number | null {
  if (s === '') return null
  switch (type) {
    case 'integer': return INT_RE.test(s) ? Number(s) : s
    case 'real': return REAL_RE.test(s) ? Number(s) : s
    case 'boolean': { const b = parseBool(s); return b === null ? s : b }
    case 'date':
    case 'datetime': return normalizeDate(s)?.text ?? s
    default: return s
  }
}

export function sqlTypeOf(t: ColumnType): 'INTEGER' | 'REAL' | 'TEXT' {
  return t === 'integer' || t === 'boolean' ? 'INTEGER' : t === 'real' ? 'REAL' : 'TEXT'
}
