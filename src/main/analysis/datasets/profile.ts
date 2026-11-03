/**
 * 列概况：从内存里的列值算统计、给「可能的用途」提示、压缩成适合发给模型的短文本。纯函数。
 * 注意：profileLine / tableProfileText 输出前，敏感列只给「敏感列（已代号化）」和代号化后的取值，不给示例。
 */
import type { ColumnInfo, ColumnProfile, ColumnType, TableInfo, TopValue } from '../types.ts'
import { splitMulti } from './infer.ts'

type Cell = string | number | null | undefined

const r4 = (n: number) => Math.round(n * 10000) / 10000
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function buildProfile(label: string, type: ColumnType, values: Cell[], multi?: { separators: string[]; optionCount: number }): ColumnProfile {
  const total = values.length
  const present = values.filter(v => v !== null && v !== undefined && v !== '') as Array<string | number>
  const nonNull = present.length
  const p: ColumnProfile = { nonNull, nullRate: total ? r4(1 - nonNull / total) : 0, distinct: 0, examples: [], hints: [] }
  const counts = new Map<string, number>()
  if (type === 'multi' && multi) {
    for (const v of present) for (const o of new Set(splitMulti(String(v), multi.separators))) counts.set(o, (counts.get(o) ?? 0) + 1)
    p.multi = multi
  } else {
    for (const v of present) { const k = String(v); counts.set(k, (counts.get(k) ?? 0) + 1) }
  }
  p.distinct = counts.size
  const numeric = type === 'integer' || type === 'real' || type === 'boolean'
  const nums = numeric ? present.filter((v): v is number => typeof v === 'number') : []
  if (nums.length) {
    const sorted = nums.slice().sort((a, b) => a - b)
    let sum = 0
    for (const x of sorted) sum += x
    p.min = sorted[0]; p.max = sorted[sorted.length - 1]
    p.mean = r4(sum / sorted.length)
    p.p25 = r4(quantile(sorted, 0.25)); p.p50 = r4(quantile(sorted, 0.5)); p.p75 = r4(quantile(sorted, 0.75))
  }
  if ((type === 'date' || type === 'datetime') && present.length) {
    let mn = String(present[0]), mx = mn
    for (const v of present) { const s = String(v); if (s < mn) mn = s; if (s > mx) mx = s }
    p.min = mn; p.max = mx
  }
  const wantTop = !numeric || type === 'boolean' || p.distinct <= 15
  if (wantTop && type !== 'date' && type !== 'datetime' && nonNull) {
    const topN: TopValue[] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10)
      .map(([value, count]) => ({ value, count, share: r4(count / nonNull) }))
    p.top = topN
  }
  const seen = new Set<string>()
  for (const v of present) { const s = String(v); if (!seen.has(s)) { seen.add(s); p.examples.push(s.length > 30 ? s.slice(0, 30) + '…' : s); if (p.examples.length >= 3) break } }
  if (type === 'text' || type === 'select' || type === 'multi') {
    let len = 0
    for (const v of present) len += String(v).length
    p.avgLen = nonNull ? Math.round((len / nonNull) * 10) / 10 : 0
  }
  p.hints = hintsFor(label, type, p, total)
  return p
}

const ID_NAME = /(^|[^a-z])(id|uid)([^a-z]|$)|编号|编码|工号|学号|序号|单号|流水/i
const AMOUNT_NAME = /金额|费用|学费|价格|实付|退费|收入|课时费|元$/
const TEXT_NAME = /意见|建议|原因说明|反馈|备注|评价|留言|描述|内容/

/** 「可能的用途」提示，只做提示不下结论 */
export function hintsFor(label: string, type: ColumnType, p: ColumnProfile, total: number): string[] {
  const h: string[] = []
  const nn = p.nonNull
  if (!nn) return ['全是空值']
  const unique = p.distinct >= nn * 0.98 && nn >= 10
  if (ID_NAME.test(label) && (unique || p.distinct > 30 || type === 'text')) h.push('像 ID / 编号（用来区分个体，不适合直接统计）')
  else if (unique && (type === 'integer' || type === 'text') && total >= 20) h.push('每行都不同，像 ID / 编号')
  if ((type === 'integer' || type === 'real') && typeof p.min === 'number' && typeof p.max === 'number') {
    const { min, max } = p
    if (min >= 0 && max <= 10 && type === 'integer') h.push(min >= 1 && max <= 5 ? '像评分（1–5）' : '像评分（0–10）')
    else if (min >= 1 && max <= 5) h.push('像评分（1–5）')
    else if (min >= 0 && max <= 100 && p.distinct > 8) h.push('像百分制分数 / 比例（0–100）')
    if (AMOUNT_NAME.test(label)) h.push('像金额')
  }
  if (type === 'date' || type === 'datetime') h.push('日期 / 时间，可按天、周、月汇总')
  if (type === 'boolean') h.push('是 / 否 标志')
  if (type === 'select') h.push('像分组维度（可用来分组对比）')
  if (type === 'multi') h.push('多选题（可用「长表」视图按选项统计）')
  if (type === 'text') {
    if ((p.avgLen ?? 0) >= 12 || TEXT_NAME.test(label)) h.push('像自由文本（适合文字归类 / 看原话）')
    else if (p.distinct <= 60) h.push('取值不多，也可当分组维度')
  }
  return h
}

// ───────────────────────── 压缩成给模型的文本 ─────────────────────────

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`

/** 取值转换：给模型看的版本（敏感列代号化）。由调用方传入；缺省原样 */
export type ValueMapper = (col: ColumnInfo, value: string) => string

const typeName: Record<ColumnType, string> = { integer: '整数', real: '小数', date: '日期', datetime: '日期时间', boolean: '是否', text: '文本', select: '选项', multi: '多选' }

/** 每列一行。toModel 用于把敏感列的取值换成代号 */
export function profileLine(c: ColumnInfo, map?: ValueMapper): string {
  const p = c.profile
  const parts: string[] = [`${c.name}（${c.label}）`, typeName[c.type]]
  if (c.sensitive) parts.push('敏感列，取值已代号化')
  parts.push(`空${pct(p.nullRate)}`, `${p.distinct}种取值`)
  if (c.sensitive) { /* 敏感列不给范围 / 均值 */ } else if (typeof p.min === 'number' && typeof p.max === 'number') {
    parts.push(`范围${p.min}–${p.max}`, `均值${p.mean}`, `中位${p.p50}`, `四分位${p.p25}/${p.p75}`)
  } else if (p.min !== undefined) parts.push(`${p.min} 至 ${p.max}`)
  if (p.top && p.top.length && (!c.sensitive || map)) {
    const m = map ?? ((_c, v) => v)
    const shown = p.top.slice(0, c.type === 'text' ? 5 : 10)
    parts.push('常见：' + shown.map(t => `${m(c, t.value).slice(0, 24)} ${pct(t.share)}`).join('、'))
  } else if (!c.sensitive && p.examples.length) parts.push('例：' + p.examples.map(e => e.slice(0, 20)).join(' | '))
  if (p.multi) parts.push(`多选，分隔符「${p.multi.separators.map(s => (s === '\n' ? '换行' : s)).join('')}」`)
  if (p.hints.length) parts.push('提示：' + p.hints.join('；'))
  return parts.join('；')
}

export function tableProfileText(t: TableInfo, map?: ValueMapper): string {
  const lines = [`表 ${t.name}（来自「${t.sheet}」，${t.rows} 行）`]
  for (const c of t.columns) lines.push('  ' + profileLine(c, map))
  for (const v of t.views) lines.push(`  视图 ${v.view}：把 ${v.column} 拆成长表（_row, 选项）`)
  if (t.derivedView) lines.push(`  视图 ${t.derivedView}：原表 + 派生列`)
  for (const n of t.notes) lines.push('  注：' + n)
  return lines.join('\n')
}
