/**
 * Agent 工具的统一类型（分析模块的适配层用它；将来内核若有同名文件，以内核为准，保持这个形状即可）。
 * 纯类型，不依赖 electron。
 */
import type { ZodType } from 'zod'
import type { BoardSpec } from '../analysis/report/spec.ts'
import type { ExportFormat } from '../analysis/report/tools.ts'
import type { ClassifyAi, ClassifyPrompts } from '../analysis/stats/classify.ts'

/** read=只读；draft=只改草稿（不需要同意）；write=写用户的文件 / 数据（需要同意）；external=把数据发到外部服务（需要同意） */
export type AgentToolLevel = 'read' | 'draft' | 'write' | 'external'

export interface AgentQueryResult {
  /** 对象数组，键是结果列名；敏感值已代号化 */
  rows: Record<string, unknown>[]
  columns: string[]
  truncated: boolean
  /** 符合条件的总行数（截断时大于 rows.length） */
  total: number
}

export interface AgentToolContext {
  sessionId: string
  /** 数据目录（看板草稿、用户剧本都放在这下面） */
  dataDir: string
  signal?: AbortSignal
  /** 测试注入：数据集仓库；缺省用主进程注册的默认仓库 */
  store?: unknown
  /** 给统计 / 归类取明细行：行数上限比 run_query 的 500 行高得多，结果已代号化 */
  runQuery(sql: string, datasetIds: string[]): Promise<AgentQueryResult>
  /** 把归类结果写回成派生列 */
  addDerivedColumn(opts: { datasetId: string; table: string; columnName: string; rows: Array<{ rowid: number; value: string | null }>; note?: string }): Promise<{ columnName: string }>
  classifyAi: ClassifyAi
  classifyPrompts: ClassifyPrompts
  /** 导出看板（弹保存对话框）；没有就表示当前环境不能导出 */
  exportBoard?: (spec: BoardSpec, format: ExportFormat) => Promise<{ saved: boolean; path?: string }>
  onProgress?: (done: number, total: number) => void
}

/** 对外发送类工具（external）的预览：发到哪里 + 完整内容；含个人信息时带提示 */
export interface ToolPreviewInfo { target: string; content: string; privacyWarning?: string }

export interface AgentTool<A = any> {
  name: string
  description: string
  params: ZodType<A>
  level: AgentToolLevel
  run(args: A, ctx: AgentToolContext): Promise<unknown>
  /** 需要用户同意的工具（write / external）：说明“这一步会做什么”，给同意对话框用。external 必须有；对外发送的给 ToolPreviewInfo */
  preview?(args: A): string | ToolPreviewInfo | Promise<string | ToolPreviewInfo>
}
