/**
 * 分析工具的适配层：把数据集 / 统计 / 文字归类 / 看板四组工具包装成统一的 AgentTool。
 * 纯逻辑（不依赖 electron）；electron 相关的接线（默认仓库、AI、保存对话框）在 ./tools-runtime.ts。
 *
 * 敏感信息：统计和归类的数据都经 store.runQuery 取回，那一步已经把敏感值换成代号；
 * 这里再对统计 / 归类的返回值做一遍兜底代号化（分组名、类别名里万一带了原值），保证交给模型的内容里没有原值。
 */
import type { z } from 'zod'
import type { AgentQueryResult, AgentTool, AgentToolContext } from '../agent/tool-types.ts'
import { boardToolList } from './report/tools.ts'
import { textClassifyTool } from './stats/classify-tool.ts'
import { statTools } from './stats/tools.ts'
import { DATASET_TOOLS } from './datasets/tools.ts'
import { storeOf } from './datasets/index.ts'
import type { DatasetStore } from './datasets/store.ts'

/** 给统计 / 归类取明细时的行数上限（run_query 给模型看的上限是 500 行，统计需要全部明细） */
export const STAT_QUERY_MAX_ROWS = 100_000

class QueryFailed extends Error {}

export interface ContextDeps {
  sessionId: string
  dataDir: string
  signal?: AbortSignal
  /** 测试注入；缺省用主进程注册的默认仓库 */
  store?: unknown
  classifyAi: AgentToolContext['classifyAi']
  classifyPrompts: AgentToolContext['classifyPrompts']
  exportBoard?: AgentToolContext['exportBoard']
  onProgress?: AgentToolContext['onProgress']
}

/** 组一个完整的 AgentToolContext：runQuery / addDerivedColumn 接到数据集仓库 */
export function createAnalysisContext(d: ContextDeps): AgentToolContext {
  const store = (): DatasetStore => storeOf({ store: d.store })
  return {
    sessionId: d.sessionId,
    dataDir: d.dataDir,
    signal: d.signal,
    store: d.store,
    classifyAi: d.classifyAi,
    classifyPrompts: d.classifyPrompts,
    exportBoard: d.exportBoard,
    onProgress: d.onProgress,
    async runQuery(sql, datasetIds): Promise<AgentQueryResult> {
      const r = await store().runQuery(sql, datasetIds, { signal: d.signal, maxRows: STAT_QUERY_MAX_ROWS })
      if (!r.ok) throw new QueryFailed(r.message ?? '查询失败')
      return { rows: toObjects(r.columns, r.rows), columns: r.columns, truncated: r.truncated, total: r.total ?? r.totalRows }
    },
    async addDerivedColumn(o) {
      const r = store().addDerivedRows(o)
      return { columnName: r.columnName }
    }
  }
}

/** 二维数组 → 对象数组（重名列后面的加 _2、_3） */
export function toObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  const keys: string[] = []
  const seen = new Map<string, number>()
  for (const c of columns) {
    const n = (seen.get(c) ?? 0) + 1
    seen.set(c, n)
    keys.push(n === 1 ? c : `${c}_${n}`)
  }
  return rows.map(r => { const o: Record<string, unknown> = {}; keys.forEach((k, i) => { o[k] = r[i] }); return o })
}

/** 兜底代号化：递归处理返回值里的字符串（含对象键以外的所有字符串值） */
export function scrub(store: DatasetStore, datasetIds: string[], value: unknown): unknown {
  const ids = datasetIds.filter(id => { try { store.get(id); return true } catch { return false } })
  if (!ids.length) return value
  const one = (s: string): string => (s.length < 2 || /^[\d.\-+%\s]*$/.test(s) ? s : String(store.toModel(ids, ['x'], [[s]])[0][0]))
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return one(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

const failure = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

function datasetTools(): AgentTool[] {
  return DATASET_TOOLS.map(t => ({
    name: t.name, description: t.description, params: t.params as z.ZodType<any>, level: 'read' as const,
    run: (args, ctx) => t.run(args, { store: ctx.store, signal: ctx.signal })
  }))
}

function statAgentTools(): AgentTool[] {
  return statTools.map(t => ({
    name: t.name, description: t.description, params: t.params as z.ZodType<any>, level: 'read' as const,
    async run(args: any, ctx: AgentToolContext) {
      try {
        const out = await t.run(args, { runQuery: (sql, ds) => ctx.runQuery(sql, ds) })
        return scrub(storeOf({ store: ctx.store }), args.datasets ?? [], out)
      } catch (e) { return failure(e) }
    }
  }))
}

function classifyAgentTool(): AgentTool {
  const t = textClassifyTool
  return {
    name: t.name, description: t.description, params: t.params as z.ZodType<any>,
    // 文字会发给外部 AI 服务，并往用户的数据集里写一个派生列
    level: 'external',
    preview: (a: any) => `把数据集里「${a.table}」表「${a.column}」列的文字发给 AI 服务归类（已去掉手机号、身份证号、邮箱，人名换成代号），并把结果写成该表的一个新列${a.newColumn ? `「${a.newColumn}」` : ''}`,
    async run(args: any, ctx: AgentToolContext) {
      try {
        const out = await t.run(args, {
          runQuery: (sql, ds) => ctx.runQuery(sql, ds),
          addDerivedColumn: o => ctx.addDerivedColumn(o),
          classifyAi: ctx.classifyAi, classifyPrompts: ctx.classifyPrompts, signal: ctx.signal, onProgress: ctx.onProgress
        })
        return scrub(storeOf({ store: ctx.store }), [args.datasetId], out)
      } catch (e) { return failure(e) }
    }
  }
}

function boardAgentTools(): AgentTool[] {
  return boardToolList.map(t => ({
    name: t.name, description: t.description, params: t.params as z.ZodType<any>, level: t.level,
    preview: t.name === 'board_export' ? (a: any) => `把当前看板导出成 ${a.format} 文件（会弹出保存对话框，选位置后才写文件）` : undefined,
    async run(args: any, ctx: AgentToolContext) {
      try { return await t.run(args, { sessionId: ctx.sessionId, dataDir: ctx.dataDir, exportBoard: ctx.exportBoard }) } catch (e) { return failure(e) }
    }
  }))
}

/** 分析模块的全部工具：数据集 4 + 统计 10 + 文字归类 1 + 看板 7 */
export function analysisTools(): AgentTool[] {
  return [...datasetTools(), ...statAgentTools(), classifyAgentTool(), ...boardAgentTools()]
}
