/**
 * 分析看板规格（Agent 用工具一节一节「搭」出来的结构化 JSON）。
 * 纯模块：不依赖 electron / node，渲染端、导出、工具定义共用。
 *
 * 数值约定：valueFormat 为 percent 时，values 是 0–1 的小数（0.253 显示 25.3%）；score 保留一位小数；number 按千分位，过万用「万」。
 */
import { z } from 'zod'

export const CHART_KINDS = ['bar', 'barH', 'stackedBar', 'groupedBar', 'line', 'pie', 'scatter', 'heatRow'] as const
export type ChartKind = (typeof CHART_KINDS)[number]
export const VALUE_FORMATS = ['percent', 'number', 'score'] as const
export type ValueFormat = (typeof VALUE_FORMATS)[number]

const text = (max: number) => z.string().max(max)
const SourceSchema = z.object({ queryId: z.string().min(1).max(80) }).strict()

export const SeriesSchema = z.object({
  name: text(60),
  values: z.array(z.number().finite().nullable()).max(500),
  unit: text(12).optional()
}).strict()

export const ChartSchema = z.object({
  kind: z.enum(CHART_KINDS),
  title: text(80),
  /** 分类轴标签（scatter：每个点的名字；heatRow：列名） */
  categories: z.array(text(60)).max(500),
  /** scatter：series[0] 是 x 值、series[1] 是 y 值；pie：只用 series[0]；heatRow：每个 series 是一行 */
  series: z.array(SeriesSchema).min(1).max(12),
  valueFormat: z.enum(VALUE_FORMATS),
  notes: text(300).optional()
}).strict()
export type Chart = z.infer<typeof ChartSchema>

const CellSchema = z.union([z.string().max(500), z.number().finite(), z.null()])
export const ColumnSchema = z.object({
  key: z.string().min(1).max(40),
  label: text(40),
  format: z.enum(['text', 'percent', 'number', 'score']).optional()
}).strict()
export type Column = z.infer<typeof ColumnSchema>
export type Cell = z.infer<typeof CellSchema>

export const HighlightSchema = z.object({
  /** 第一列的值等于其中之一的行高亮 */
  rowKeys: z.array(text(80)).max(100).optional(),
  /** 按规则高亮：某列 op 某值 */
  rule: z.object({ key: z.string().max(40), op: z.enum(['>', '>=', '<', '<=', '=']), value: z.number().finite() }).strict().optional()
}).strict()
export type Highlight = z.infer<typeof HighlightSchema>

export const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chart'), chart: ChartSchema, source: SourceSchema.optional() }).strict(),
  z.object({
    type: z.literal('table'),
    title: text(80).optional(),
    columns: z.array(ColumnSchema).min(1).max(30),
    rows: z.array(z.record(CellSchema)).max(2000),
    highlight: HighlightSchema.optional(),
    source: SourceSchema.optional()
  }).strict(),
  z.object({ type: z.literal('text'), markdown: text(6000) }).strict(),
  z.object({
    type: z.literal('kpi'),
    items: z.array(z.object({
      label: text(40), value: text(40), delta: text(40).optional(), deltaGood: z.enum(['up', 'down']).optional()
    }).strict()).min(1).max(8),
    source: SourceSchema.optional()
  }).strict()
])
export type Block = z.infer<typeof BlockSchema>
export type TableBlock = Extract<Block, { type: 'table' }>

export const FindingSchema = z.object({ title: text(60), body: text(600) }).strict()
export const SectionSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[\w一-龥-]+$/),
  title: text(60),
  intro: text(1200),
  blocks: z.array(BlockSchema).max(40)
}).strict()
export type Section = z.infer<typeof SectionSchema>

export const BoardSpecSchema = z.object({
  title: text(80),
  subtitle: text(160).default(''),
  /** 数据范围一句话 */
  dataNote: text(300).default(''),
  findings: z.array(FindingSchema).max(12).default([]),
  sections: z.array(SectionSchema).max(30).default([]),
  caliber: z.array(text(400)).max(40).default([])
}).strict()
export type BoardSpec = z.infer<typeof BoardSpecSchema>

export function parseBoardSpec(raw: unknown): BoardSpec { return BoardSpecSchema.parse(raw) }

/** 图表自身的一致性检查（zod 之外）：返回问题列表，空数组 = 通过 */
export function checkChart(c: Chart): string[] {
  const errs: string[] = []
  const n = c.categories.length
  if (c.kind === 'scatter') {
    if (c.series.length < 2) errs.push('散点图需要两个系列：第一个是 x 值，第二个是 y 值')
    else if (c.series[0].values.length !== c.series[1].values.length) errs.push('散点图 x、y 的个数要一样')
    return errs
  }
  for (const s of c.series) if (s.values.length !== n) errs.push(`系列「${s.name}」有 ${s.values.length} 个值，分类有 ${n} 个，要一样多`)
  if (c.kind === 'pie' && c.series[0].values.some(v => v !== null && v < 0)) errs.push('饼图的值不能为负')
  if (c.kind === 'stackedBar' && c.series.some(s => s.values.some(v => v !== null && v < 0))) errs.push('堆叠柱图的值不能为负')
  return errs
}

/** 块的一致性检查；工具在添加块时调用，让模型当场改正 */
export function checkBlock(b: Block): string[] {
  if (b.type === 'chart') return checkChart(b.chart)
  if (b.type === 'table') {
    const keys = new Set(b.columns.map(c => c.key))
    if (keys.size !== b.columns.length) return ['表格列的 key 有重复']
    if (b.highlight?.rule && !keys.has(b.highlight.rule.key)) return [`高亮规则的列「${b.highlight.rule.key}」不在表格列里`]
  }
  return []
}

// ───────────── 数值格式化（渲染端、SVG、导出共用） ─────────────

const trim = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
export function formatValue(v: number | null | undefined, f: ValueFormat | 'text' = 'number'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (f === 'percent') return `${trim((v * 100).toFixed(1))}%`
  if (f === 'score') return v.toFixed(1)
  if (Math.abs(v) >= 1e4) return `${trim((v / 1e4).toFixed(1))}万`
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** 表格单元格显示文字 */
export function formatCell(v: Cell | undefined, f: Column['format']): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  return formatValue(v, f && f !== 'text' ? f : 'number')
}

/** 某行是否被高亮 */
export function isHighlighted(row: Record<string, Cell>, columns: Column[], h: Highlight | undefined): boolean {
  if (!h) return false
  if (h.rowKeys && columns[0] && h.rowKeys.includes(String(row[columns[0].key]))) return true
  if (h.rule) {
    const v = row[h.rule.key]
    if (typeof v !== 'number') return false
    const t = h.rule.value
    switch (h.rule.op) { case '>': return v > t; case '>=': return v >= t; case '<': return v < t; case '<=': return v <= t; case '=': return v === t }
  }
  return false
}

/** 图表的数据表（导出 Excel / Word 用）：第一列分类，后面每个系列一列；散点 = 名称 / x / y */
export function chartToTable(c: Chart): { columns: Column[]; rows: Array<Record<string, Cell>> } {
  const f = c.valueFormat
  if (c.kind === 'scatter') {
    const columns: Column[] = [{ key: 'name', label: '名称' }, { key: 'x', label: c.series[0]?.name ?? 'x', format: f }, { key: 'y', label: c.series[1]?.name ?? 'y', format: f }]
    const n = c.series[0]?.values.length ?? 0
    return { columns, rows: Array.from({ length: n }, (_, i) => ({ name: c.categories[i] ?? String(i + 1), x: c.series[0].values[i], y: c.series[1]?.values[i] ?? null })) }
  }
  const columns: Column[] = [{ key: 'c', label: c.title || '分类' }, ...c.series.map((s, i) => ({ key: `s${i}`, label: s.unit ? `${s.name}（${s.unit}）` : s.name, format: f }))]
  const rows = c.categories.map((cat, i) => {
    const r: Record<string, Cell> = { c: cat }
    c.series.forEach((s, j) => { r[`s${j}`] = s.values[i] ?? null })
    return r
  })
  return { columns, rows }
}
