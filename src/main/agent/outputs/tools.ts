/**
 * 产出相关的 Agent 工具定义（给内核用）：{ name, description, params(zod), level, run(args, ctx) }。
 * level：'auto' = 只写本会话自己的产出目录，不需要用户同意；'write' = 会在会话目录外产生新文件，需要用户同意。
 * ctx 由集成方提供：sessionId 和 dataDir（单测用假的）。
 */
import path from 'node:path'
import { z } from 'zod'
import { listOutputs, readDoc, createDoc, writeSection, saveTable, cleanMarks, sessionDir } from './store.ts'
import { exportOutput } from './export.ts'
import type { OutputExportFormat } from '../../../shared/agent-outputs.ts'

export interface OutputToolCtx { sessionId: string; dataDir: string }
export interface OutputTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  params: S
  level: 'auto' | 'write'
  run: (args: z.infer<S>, ctx: OutputToolCtx) => Promise<unknown> | unknown
}
const tool = <S extends z.ZodTypeAny>(t: OutputTool<S>): OutputTool<S> => t

const sc = (c: OutputToolCtx) => ({ dataDir: c.dataDir, sessionId: c.sessionId })

export const docCreate = tool({
  name: 'doc_create',
  description: '新建一份汇报文档（Markdown），返回 docId。同名文档已存在时直接返回它。先建文档，再用 doc_write_section 一节一节写。sections 可选：计划写的各节标题，用户会看到「正在写 第 x/y 节」。kind=note 表示口径说明之类的备忘。',
  params: z.object({ name: z.string().min(1).max(80), sections: z.array(z.string().max(60)).max(30).optional(), kind: z.enum(['md', 'note']).optional() }),
  level: 'auto',
  run: (a, c) => { const e = createDoc(sc(c), a.name, a.kind ?? 'md', a.sections); return { docId: e.id, name: e.name, file: e.file } }
})

export const docWriteSection = tool({
  name: 'doc_write_section',
  description: '写入（覆盖）文档的某一节。sectionId 是你自己定的短编号（如 s1），同一个 sectionId 再写就是改这一节，新的 sectionId 追加在最后。title 是小节标题（不含 #），markdown 是正文。建议先写「一、结论」（三句话以内），再补细节。汇报里每个数字必须来自查询结果，并在句末用 [[query:查询编号]] 标注出处（样本题用 [[q:ID]]，课程用 [[lesson:ID]]，学员用 [[stu:ID]]），没有出处的数字不要写。数据说不清的地方要单独写一节「这份数据说不清的地方」。写最后一节时 last 填 true。',
  params: z.object({ docId: z.string().max(20), sectionId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), title: z.string().max(80), markdown: z.string().max(40_000), last: z.boolean().optional() }),
  level: 'auto',
  run: (a, c) => { const e = writeSection(sc(c), a.docId, a.sectionId, a.title, a.markdown, a.last); return { docId: e.id, written: e.written, total: e.total ?? null, status: e.status } }
})

export const docRead = tool({
  name: 'doc_read',
  description: '读取文档当前内容和各节编号 / 标题，写之前先看看已经写了什么，避免重复。',
  params: z.object({ docId: z.string().max(20) }),
  level: 'auto',
  run: (a, c) => { const d = readDoc(sc(c), a.docId); return { name: d.entry.name, status: d.entry.status, sections: d.sections, markdown: cleanMarks(d.markdown) } }
})

export const tableSave = tool({
  name: 'table_save',
  description: '把名单 / 明细存成表格（.csv，Excel 可直接打开），可再用 output_export 导出 xlsx。columns 是列名，rows 是每行的单元格（与列一一对应）。同名表格会被覆盖。名单里只放用户任务需要的字段，不要放无关的个人信息。',
  params: z.object({ name: z.string().min(1).max(80), columns: z.array(z.string().max(60)).min(1).max(100), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(100_000) }),
  level: 'auto',
  run: (a, c) => { const e = saveTable(sc(c), a.name, a.columns, a.rows); return { tableId: e.id, name: e.name, rows: a.rows.length } }
})

export const outputsList = tool({
  name: 'outputs_list',
  description: '列出本次任务已有的产出（文档、看板、表格、说明）：编号、类型、名称、状态。',
  params: z.object({}),
  level: 'auto',
  run: (_a, c) => listOutputs(sc(c)).map(e => ({ id: e.id, type: e.type, name: e.name, status: e.status, updatedAt: e.updatedAt, ...(e.type === 'image' && e.file ? { path: path.join(sessionDir(sc(c)), e.file) } : {}) }))
})

export const outputExport = tool({
  name: 'output_export',
  description: '把一份产出导出成文件：文档可导出 docx（Word）/ pdf / md，表格可导出 xlsx / csv。文件放在本次任务的 exports 文件夹里，需要用户同意。',
  params: z.object({ id: z.string().max(20), format: z.enum(['docx', 'pdf', 'xlsx', 'csv', 'md']) }),
  level: 'write',
  run: async (a, c) => { const r = await exportOutput(sc(c), a.id, a.format as OutputExportFormat); return { path: r.path, format: r.format, bytes: r.bytes, note: r.fellBackTo ? '暂时导出为 csv' : undefined } }
})

export const OUTPUT_TOOLS = [docCreate, docWriteSection, docRead, tableSave, outputsList, outputExport]
