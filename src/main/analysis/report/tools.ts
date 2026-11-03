/**
 * 给 Agent 内核用的看板工具定义：{ name, description, params(zod), level, run(args, ctx) }。
 * 看板草稿按会话（ctx.sessionId）存内存 Map；ctx.dataDir 给了就同时落盘到 <dataDir>/analysis-boards/<会话>.json（重启后 loadBoard 能读回）。
 * level：'read' 只读 / 'draft' 只改草稿（不需要同意）/ 'write' 写用户文件（需要用户同意）。
 * 集成方把 ctx.exportBoard 接到 ./export-run 的 exportBoardToDialog（弹保存对话框）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { BlockSchema, BoardSpecSchema, FindingSchema, checkBlock, type BoardSpec } from './spec.ts'

export type ExportFormat = 'xlsx' | 'html' | 'docx'
export const EXPORT_FORMATS = ['xlsx', 'html', 'docx'] as const

export interface BoardToolContext {
  sessionId: string
  /** 数据目录：给了就把草稿落盘到 analysis-boards/ */
  dataDir?: string
  /** 导出实现（弹保存对话框并写文件）；由集成方注入 */
  exportBoard?: (spec: BoardSpec, format: ExportFormat) => Promise<{ saved: boolean; path?: string }>
}
export interface ToolResult { ok: boolean; message: string; data?: unknown }
export type ToolLevel = 'read' | 'draft' | 'write'
export interface BoardTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  params: S
  level: ToolLevel
  run: (args: z.infer<S>, ctx: BoardToolContext) => Promise<ToolResult> | ToolResult
}

const drafts = new Map<string, BoardSpec>()
const safeId = (s: string): string => s.replace(/[^\w.-]/g, '_').slice(0, 80) || 'session'
const fileOf = (ctx: BoardToolContext): string | null => (ctx.dataDir ? path.join(ctx.dataDir, 'analysis-boards', `${safeId(ctx.sessionId)}.json`) : null)

export function getBoard(ctx: BoardToolContext): BoardSpec | null {
  const m = drafts.get(ctx.sessionId)
  if (m) return m
  const f = fileOf(ctx)
  if (f && fs.existsSync(f)) {
    try {
      const spec = BoardSpecSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')))
      drafts.set(ctx.sessionId, spec)
      return spec
    } catch { /* 坏文件当没有 */ }
  }
  return null
}
function save(ctx: BoardToolContext, spec: BoardSpec): void {
  drafts.set(ctx.sessionId, spec)
  const f = fileOf(ctx)
  if (!f) return
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(spec), 'utf8') } catch { /* 落盘失败不影响内存草稿 */ }
}
export function clearBoards(): void { drafts.clear() }

const NO_BOARD: ToolResult = { ok: false, message: '还没有看板。请先调用 board_start(title, subtitle, dataNote)。' }
const fail = (message: string): ToolResult => ({ ok: false, message })

/** 当前规格的摘要（给模型看，不含大块数据） */
export function summarize(spec: BoardSpec): string {
  const lines = [`标题：${spec.title}${spec.subtitle ? `（${spec.subtitle}）` : ''}`, `数据范围：${spec.dataNote || '（未填）'}`, `核心发现 ${spec.findings.length} 条：`]
  spec.findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f.title}`))
  lines.push(`章节 ${spec.sections.length} 个：`)
  for (const s of spec.sections) {
    const kinds = s.blocks.map(b => (b.type === 'chart' ? `图(${b.chart.kind})` : b.type === 'table' ? `表(${b.rows.length}行)` : b.type === 'kpi' ? `指标(${b.items.length})` : '文字'))
    lines.push(`  [${s.id}] ${s.title}：${kinds.join('、') || '（还没有内容块）'}`)
  }
  lines.push(`口径说明 ${spec.caliber.length} 条`)
  const todo: string[] = []
  if (!spec.findings.length) todo.push('还没有核心发现')
  if (!spec.sections.length) todo.push('还没有章节')
  if (!spec.caliber.length) todo.push('还没有口径说明')
  for (const s of spec.sections) if (!s.blocks.length) todo.push(`章节「${s.title}」是空的`)
  if (todo.length) lines.push(`待补：${todo.join('；')}`)
  return lines.join('\n')
}

const startTool: BoardTool = {
  name: 'board_start',
  description: '新建（或清空重来）本次分析的看板草稿。分析做完、要整理成成果时先调用它，再用 board_add_finding / board_add_section / board_add_block 一节一节往里加。title 是看板标题；subtitle 一句话说明；dataNote 写数据范围（哪个学期、哪些班、多少人等）。',
  params: z.object({ title: z.string().min(1).max(80), subtitle: z.string().max(160).default(''), dataNote: z.string().max(300).default('') }).strict(),
  level: 'draft',
  run: (a, ctx) => {
    const spec = BoardSpecSchema.parse({ title: a.title, subtitle: a.subtitle, dataNote: a.dataNote })
    save(ctx, spec)
    return { ok: true, message: `已新建看板「${spec.title}」。接下来添加核心发现和章节。` }
  }
}

const findingTool: BoardTool = {
  name: 'board_add_finding',
  description: '添加一条「核心发现」，显示在看板最顶部。title 是一句话标题（如「高年级阅读失分最集中」）；body 是一段带关键数字的结论（1–3 句）。数字必须来自你已经跑过的查询结果，不要编造或心算估计。建议 3–6 条，按重要程度排序。',
  params: FindingSchema,
  level: 'draft',
  run: (a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    if (spec.findings.length >= 12) return fail('核心发现最多 12 条')
    save(ctx, { ...spec, findings: [...spec.findings, a] })
    return { ok: true, message: `已添加第 ${spec.findings.length + 1} 条核心发现。` }
  }
}

const sectionTool: BoardTool = {
  name: 'board_add_section',
  description: '添加一个章节。id 是章节的短标识（字母数字或中文，如 overview、by-grade），之后 board_add_block 用它指定放进哪一章；不填会自动编号。title 是章节标题；intro 是 1–3 句解读，说清这一章回答什么问题、结论是什么。章节按添加顺序排列。',
  params: z.object({ id: z.string().min(1).max(40).regex(/^[\w一-龥-]+$/).optional(), title: z.string().min(1).max(60), intro: z.string().max(1200).default('') }).strict(),
  level: 'draft',
  run: (a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    const id = a.id ?? `s${spec.sections.length + 1}`
    if (spec.sections.some(s => s.id === id)) return fail(`章节标识「${id}」已存在，换一个。`)
    if (spec.sections.length >= 30) return fail('章节最多 30 个')
    save(ctx, { ...spec, sections: [...spec.sections, { id, title: a.title, intro: a.intro, blocks: [] }] })
    return { ok: true, message: `已添加章节 [${id}] ${a.title}。`, data: { sectionId: id } }
  }
}

const blockTool: BoardTool = {
  name: 'board_add_block',
  description: [
    '往指定章节末尾添加一个内容块（图、表、文字或指标卡）。block 是以下四种之一：',
    '1) 图表 {type:"chart", chart:{kind, title, categories, series:[{name, values, unit?}], valueFormat, notes?}, source?:{queryId}}。kind 可选 bar(柱)/barH(横向条形，类别名长时用)/stackedBar(堆叠)/groupedBar(分组)/line(折线，看趋势)/pie(饼，只用第一个系列，类别不超过 8 个)/scatter(散点：series[0]=x 值、series[1]=y 值，categories 是每个点的名字)/heatRow(热力行：categories 是列，每个 series 是一行)。每个 series.values 的个数必须等于 categories 的个数。valueFormat：percent（values 写 0–1 的小数，0.253 显示 25.3%）/ number / score（一位小数）。',
    '2) 表格 {type:"table", title?, columns:[{key,label,format?}], rows:[{key:值}], highlight?:{rowKeys?:[第一列的值], rule?:{key,op,value}}, source?}。format 可选 text/percent/number/score，百分比同样写小数。',
    '3) 文字 {type:"text", markdown}，用于补充解读。',
    '4) 指标卡 {type:"kpi", items:[{label, value, delta?, deltaGood?:"up"|"down"}]}，value 是已格式化的文字（如「1,284 人」）。',
    '数字必须来自你跑过的查询结果；把该查询的 id 填进 source.queryId，用户可以点开看出处。一章里通常是「图 + 表 + 一段文字」，图表不要塞太多类别（柱/条 ≤ 20）。',
    '规格不合法时会返回具体原因，按原因改好后重发。'
  ].join('\n'),
  params: z.object({ sectionId: z.string().min(1).max(40), block: BlockSchema }).strict(),
  level: 'draft',
  run: (a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    const sec = spec.sections.find(s => s.id === a.sectionId)
    if (!sec) return fail(`没有章节「${a.sectionId}」。现有章节：${spec.sections.map(s => s.id).join('、') || '（无）'}。先用 board_add_section 添加。`)
    if (sec.blocks.length >= 40) return fail('一章最多 40 个块')
    const problems = checkBlock(a.block)
    if (problems.length) return fail(`这个块有问题：${problems.join('；')}`)
    save(ctx, { ...spec, sections: spec.sections.map(s => (s.id === sec.id ? { ...s, blocks: [...s.blocks, a.block] } : s)) })
    return { ok: true, message: `已加入章节 [${sec.id}]（现有 ${sec.blocks.length + 1} 个块）。` }
  }
}

const caliberTool: BoardTool = {
  name: 'board_set_caliber',
  description: '设置「口径说明」（替换之前的）。items 是若干条文字，说明数据范围、指标定义、剔除了什么、哪些数是估计的。例如「得分率 = 实际得分 / 满分，缺考不计入」。看板最后一章显示，Excel 里是最后一张表。',
  params: z.object({ items: z.array(z.string().min(1).max(400)).min(1).max(40) }).strict(),
  level: 'draft',
  run: (a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    save(ctx, { ...spec, caliber: a.items })
    return { ok: true, message: `已设置 ${a.items.length} 条口径说明。` }
  }
}

const previewTool: BoardTool = {
  name: 'board_preview',
  description: '查看当前看板草稿的摘要（标题、核心发现标题、每章有哪些块、还缺什么）。导出前调用一次，确认核心发现、章节、口径说明都齐了。',
  params: z.object({}).strict(),
  level: 'read',
  run: (_a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    return { ok: true, message: summarize(spec), data: { sections: spec.sections.length, findings: spec.findings.length } }
  }
}

const exportTool: BoardTool = {
  name: 'board_export',
  description: '把当前看板导出成文件，会弹出保存对话框，需要用户同意。format：xlsx（Excel：核心发现 + 每章一张表 + 口径说明）、html（单个网页文件，离线可打开，适合发给别人看）、docx（Word 简版汇报）。导出前先 board_preview 确认内容齐全。',
  params: z.object({ format: z.enum(EXPORT_FORMATS) }).strict(),
  level: 'write',
  run: async (a, ctx) => {
    const spec = getBoard(ctx); if (!spec) return NO_BOARD
    if (!ctx.exportBoard) return fail('当前环境不支持导出。')
    const r = await ctx.exportBoard(spec, a.format)
    return r.saved ? { ok: true, message: `已导出：${r.path}`, data: r } : { ok: true, message: '用户取消了保存。', data: r }
  }
}

export const boardTools = { board_start: startTool, board_add_finding: findingTool, board_add_section: sectionTool, board_add_block: blockTool, board_set_caliber: caliberTool, board_preview: previewTool, board_export: exportTool } as const
export const boardToolList: BoardTool[] = Object.values(boardTools)
