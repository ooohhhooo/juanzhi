/**
 * text_classify 工具：把某张表某一列的自由文字让 AI 归类，结果写回成新的派生列，并返回类别计数。
 * 需要集成方在 ctx 里提供 runQuery、addDerivedColumn、classifyAi、classifyPrompts。
 */
import { z } from 'zod'
import { classifyTexts, ClassifyError } from './classify.ts'
import type { ClassifyAi, ClassifyPrompts } from './classify.ts'
import type { Row } from './core.ts'
import type { StatTool } from './tools.ts'

export interface ClassifyToolContext {
  runQuery(sql: string, datasets: string[]): Promise<Row[] | { rows: Row[]; truncated?: boolean; total?: number }>
  /** 数据集模块提供：给某张表加一列派生列。rows 里 rowid 是原表行的 rowid，value 是这一行的取值（null=留空）。返回最终的列名（重名时可能被改） */
  addDerivedColumn(o: { datasetId: string; table: string; columnName: string; rows: Array<{ rowid: number; value: string | null }>; note?: string }): Promise<{ columnName: string }>
  classifyAi: ClassifyAi
  classifyPrompts: ClassifyPrompts
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`

/** 读出这一列的全部行。结果被截断（truncated）时按 rowid 往后分页取全；取不全就明确报错，绝不把超出的行静默当成空 */
export async function readAllRows(ctx: Pick<ClassifyToolContext, 'runQuery'>, a: { datasetId: string; table: string; column: string }): Promise<Row[]> {
  const all: Row[] = []
  let last = 0
  for (let page = 0; page < 2000; page++) {
    const where = page === 0 ? '' : ` WHERE rowid > ${last}`
    const res = await ctx.runQuery(`SELECT rowid AS __rowid, ${quote(a.column)} AS __text FROM ${quote(a.table)}${where} ORDER BY rowid`, [a.datasetId])
    const rows = Array.isArray(res) ? res : res.rows
    const truncated = !Array.isArray(res) && !!res.truncated
    if (rows.length && !('__rowid' in rows[0])) { if (page === 0) return rows; throw new ClassifyError('读取这一列时出错，请重试') }
    all.push(...rows)
    if (!truncated) return all
    if (!rows.length) throw new ClassifyError('这一列太大，没能完整读出来，没有做归类。请先用 SQL 筛选出一部分再归类')
    last = Number(rows[rows.length - 1].__rowid)
    if (!Number.isFinite(last)) throw new ClassifyError('读取这一列时出错，请重试')
  }
  throw new ClassifyError('这一列行数太多，没能完整读出来，没有做归类。请先用 SQL 筛选出一部分再归类')
}

export const textClassifyTool: StatTool<z.ZodObject<{
  datasetId: z.ZodString; table: z.ZodString; column: z.ZodString
  categories: z.ZodOptional<z.ZodArray<z.ZodObject<{ name: z.ZodString; definition: z.ZodOptional<z.ZodString> }>>>
  newColumn: z.ZodOptional<z.ZodString>
}>, ClassifyToolContext> = {
  name: 'text_classify',
  level: 'read',
  description: '把一列自由文字（退费原因、问卷意见、跟进备注等）按意思归类并计数。先抽样让 AI 提出 5–10 个类别，再把全部文字分批归类（一条可属于多个类别，归不进的记“其他”）；归类结果写回成该表的一个新列（多个类别用“；”隔开），之后可以用 SQL 按这一列统计、交叉、与分数关联。传 datasetId、table、column；想自己定类别或修改上次的类别，传 categories（name + definition）再重跑；newColumn 可指定新列名（默认“原列名_归类”）。返回：类别列表、每类条数和占比、新列名、白话说明 text。文字发给 AI 前已自动去掉手机号、身份证号、邮箱。AI 归类可能有个别误判，引用前建议抽查。',
  params: z.object({
    datasetId: z.string().describe('数据集 id'),
    table: z.string().describe('表名'),
    column: z.string().describe('文字所在的列名'),
    categories: z.array(z.object({ name: z.string(), definition: z.string().optional() })).optional().describe('可选：指定类别；不传则由 AI 先提出'),
    newColumn: z.string().optional()
  }),
  async run(a, ctx) {
    try {
      const rows = await readAllRows(ctx, a)
      if (!rows.length) return { ok: false, error: '这张表没有数据，或这一列不存在' }
      if (!('__text' in rows[0])) return { ok: false, error: `表里没有「${a.column}」这一列` }
      const texts = rows.map(r => (r.__text === null || r.__text === undefined ? '' : String(r.__text)))
      const r = await classifyTexts(texts, {
        ai: ctx.classifyAi, prompts: ctx.classifyPrompts, fieldName: a.column, signal: ctx.signal, onProgress: ctx.onProgress,
        categories: a.categories?.map(c => ({ name: c.name, definition: c.definition ?? '' }))
      })
      const wanted = a.newColumn?.trim() || `${a.column}_归类`
      const out = await ctx.addDerivedColumn({
        datasetId: a.datasetId, table: a.table, columnName: wanted,
        rows: rows.map((row, i) => ({ rowid: Number(row.__rowid), value: r.labels[i].length ? r.labels[i].join('；') : null })),
        note: 'AI 归类'
      })
      return { ok: true, newColumn: out.columnName, categories: r.categories, counts: r.counts, answered: r.answered, blank: r.blank, fallbackToOther: r.fallbackToOther, text: r.text, notes: r.notes }
    } catch (e) {
      if (e instanceof ClassifyError) return { ok: false, error: e.message }
      throw e
    }
  }
}
