/**
 * 数据集模块入口：默认仓库（数据目录由主进程注册，测试直接 new DatasetStore(临时目录)）。
 */
import { DatasetStore } from './store.ts'
import type { ToolContext } from '../types.ts'

let provider: (() => string) | null = null
let current: { dir: string; store: DatasetStore } | null = null

/** 主进程启动时注册：返回当前数据目录（用户改数据目录后自动跟着变） */
export function setDataDirProvider(fn: () => string): void { provider = fn; current = null }

export function getStore(): DatasetStore {
  if (!provider) throw new Error('数据集模块还没有初始化数据目录')
  const dir = provider()
  if (!current || current.dir !== dir) current = { dir, store: new DatasetStore(dir) }
  return current.store
}

/** 工具运行时取仓库：ctx.store 优先（测试注入），否则默认仓库 */
export function storeOf(ctx?: ToolContext): DatasetStore {
  return (ctx?.store as DatasetStore | undefined) ?? getStore()
}

export { DatasetStore, DatasetError, IMPORT_LIMITS } from './store.ts'
export { checkSql, runReadOnly, QUERY_LIMITS } from './query.ts'
export { Codebook, detectSensitive } from './sensitive.ts'

/** 给其他模块的便捷入口（默认仓库）：统计模块的文字归类按 rowid 写回派生列 */
export function addDerivedColumn(opts: { datasetId: string; table: string; columnName: string; rows: Array<{ rowid: number; value: string | number | boolean | null }>; note?: string }): { columnName: string; label: string } {
  return getStore().addDerivedRows(opts)
}

/** 只读查询（结果已代号化）：{ rows, truncated, total, ... } */
export function runQuery(sql: string, datasetIds: string[]) {
  return getStore().runQuery(sql, datasetIds)
}
