/**
 * 数据分析模块的共用类型（数据集 / 统计 / 看板 / Agent 内核共用）。
 * 纯类型，不依赖 electron，可被单测直接导入。改动前请和其他模块的负责人对齐。
 *
 * 约定：
 *  - 「内部名」(name) 是写进 SQLite 的安全标识，形如 c01_用户id；「显示名」(label) 是用户表格里的原列名。
 *  - 每张数据表都有一个隐藏主键列 _row：从 1 开始的数据行号（不含表头，跳过全空行）。派生列、多选拆分视图都靠它关联。
 *  - 发给模型的任何数据都必须先过 Codebook.toModel（敏感列换成代号）；界面显示用原值或 fromModel。
 */
import type { ZodTypeAny } from 'zod'

/** 列类型：select = 低基数文本（单选 / 分组维度）；multi = 单元格里有多个选项（按分隔符拆开） */
export type ColumnType = 'integer' | 'real' | 'date' | 'datetime' | 'boolean' | 'text' | 'select' | 'multi'

/** 敏感值种类，决定代号前缀：person=人员A017，id=编号0231，phone=手机0012 …… */
export type SensitiveKind = 'person' | 'id' | 'phone' | 'idcard' | 'email' | 'address' | 'other'

export interface TopValue { value: string; count: number; share: number }

/** 单列概况（导入时算好，存在 catalog.json 里） */
export interface ColumnProfile {
  /** 非空单元格数 */
  nonNull: number
  /** 空值率 0–1 */
  nullRate: number
  /** 不同取值数（多选列：不同选项数） */
  distinct: number
  /** 数值列 / 日期列 */
  min?: number | string
  max?: number | string
  mean?: number
  p25?: number
  p50?: number
  p75?: number
  /** 前 10 个取值及占比（文本 / 选项 / 多选 / 布尔 / 低基数数值）；占比 = 次数 / 非空单元格数 */
  top?: TopValue[]
  /** 示例值（原值；输出给模型前必须过 toModel，敏感列不输出示例） */
  examples: string[]
  /** 「可能的用途」提示：像 ID、像分数（0–10）、像日期、像分组维度、像自由文本…… */
  hints: string[]
  /** 多选列：识别出的分隔符和选项数 */
  multi?: { separators: string[]; optionCount: number }
  /** 平均文本长度（文本列） */
  avgLen?: number
}

export interface ColumnInfo {
  /** 内部名（SQL 标识） */
  name: string
  /** 显示名（原列名） */
  label: string
  type: ColumnType
  sqlType: 'INTEGER' | 'REAL' | 'TEXT'
  sensitive: boolean
  sensitiveKind?: SensitiveKind
  /** 敏感标记是自动识别的（用户改过就置 false） */
  sensitiveAuto: boolean
  /** 派生列（addDerivedColumn 写入，存在 <表>__derived 里，视图 <表>__all 把它们并进来） */
  derived?: boolean
  profile: ColumnProfile
}

export interface TableInfo {
  /** SQLite 表名 */
  name: string
  /** 原工作表名 / 文件名 */
  sheet: string
  rows: number
  /** 表头在原表里的行号（从 1 数；0 = 没有表头，列名是自动生成的） */
  headerRow: number
  columns: ColumnInfo[]
  /** 多选列的「长表」视图：每个选项一行 (_row, 选项) */
  views: Array<{ column: string; view: string }>
  /** 有派生列时，派生表名与合并视图名 */
  derivedTable?: string
  derivedView?: string
  /** 导入时的提示（白话），如「前 2 行是标题，已跳过」 */
  notes: string[]
}

export interface DatasetMeta {
  id: string
  name: string
  sourceFile: string
  importedAt: string
  note: string
  sizeBytes: number
  tables: TableInfo[]
  /** 学科：三个学科之一或 general（通用）；缺省 = 通用 */
  subject?: 'english' | 'chinese' | 'math' | 'general'
}

/** 导入进度事件 */
export interface ImportProgress {
  /** 'read' 读文件；'write' 写库；'done' 完成 */
  phase: 'read' | 'write' | 'done'
  fileName: string
  sheet?: string
  done: number
  total: number
  message: string
}

export interface QueryResult {
  ok: boolean
  columns: string[]
  rows: unknown[][]
  /** 实际返回行数（<= 500） */
  returned: number
  /** 总行数；countCapped=true 时是「至少」这么多 */
  totalRows: number
  countCapped?: boolean
  truncated: boolean
  /** 白话说明（截断、超时、错误） */
  message?: string
  /** SQLite 原始错误（失败时） */
  rawError?: string
  /** 给模型看的原始错误关键片段（已代号化、去个人信息）；rawError 本身不会外传 */
  detail?: string
  elapsedMs: number
}

/** Agent 工具运行环境。store 缺省时用 datasets/index.ts 里的默认仓库（主进程注册）。 */
export interface ToolContext {
  store?: unknown
  signal?: AbortSignal
  /** 会话学科：只给「该学科 + 通用」的数据集和文档；不写 = 不过滤 */
  subject?: string
}

/** Agent 内核注册用的工具形状（level 'read' = 只读，不改任何数据） */
export interface ToolDef<A = any> {
  name: string
  description: string
  params: ZodTypeAny
  level: 'read'
  run(args: A, ctx: ToolContext): Promise<unknown>
}
