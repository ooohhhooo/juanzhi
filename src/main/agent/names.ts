/**
 * 代号 ↔ 真名：发给 AI 的内容一律是代号（学员A001、手机号代号……）；显示给用户、导出到本机、发往企业微信时还原成真名。
 * 一个会话用到哪些数据集：用户选的 + 工具参数里出现过的，记在 <数据目录>/agent-session-datasets/<会话>.json（重启后还在）。
 * 没记录时（老会话）退回「全部数据集」。纯 node:fs + 数据集仓库，不依赖 electron。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getStore } from '../analysis/datasets/index.ts'
import type { DatasetStore } from '../analysis/datasets/store.ts'

let dirProvider: (() => string) | null = null
let storeProvider: (() => DatasetStore) | null = null
/** 主进程启动时注册数据目录；单测可同时注入仓库 */
export function initNames(dataDir: () => string, store?: () => DatasetStore): void { dirProvider = dataDir; storeProvider = store ?? null }

const cache = new Map<string, Set<string>>()
const store = (): DatasetStore => (storeProvider ? storeProvider() : getStore())
const fileOf = (sid: string): string | null => (dirProvider && /^[A-Za-z0-9_-]{1,64}$/.test(sid) ? path.join(dirProvider(), 'agent-session-datasets', `${sid}.json`) : null)

function load(sid: string): Set<string> {
  const hit = cache.get(sid)
  if (hit) return hit
  let s = new Set<string>()
  const f = fileOf(sid)
  if (f) { try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(a)) s = new Set(a.filter((x: unknown) => typeof x === 'string')) } catch { /* 没有记录 */ } }
  cache.set(sid, s)
  return s
}

export function noteDatasets(sid: string, ids: string[]): void {
  const s = load(sid)
  let changed = false
  for (const id of ids) if (typeof id === 'string' && id && !s.has(id)) { s.add(id); changed = true }
  const f = fileOf(sid)
  if (changed && f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify([...s])) } catch { /* 记不上不影响使用 */ } }
}

/** 从工具参数里找出数据集编号并登记 */
export function noteArgs(sid: string, args: unknown): void {
  if (!args || typeof args !== 'object') return
  const a = args as Record<string, unknown>
  const ids: string[] = []
  for (const k of ['datasets', 'datasetIds']) if (Array.isArray(a[k])) ids.push(...(a[k] as unknown[]).filter((x): x is string => typeof x === 'string'))
  for (const k of ['datasetId', 'dataset']) if (typeof a[k] === 'string') ids.push(a[k] as string)
  if (ids.length) noteDatasets(sid, ids)
}

export function sessionDatasetIds(sid: string): string[] {
  const known = [...load(sid)]
  try {
    const st = store()
    const alive = known.filter(id => st.find(id))
    return alive.length ? alive : st.list().map(d => d.id)
  } catch { return [] }
}

export function restoreNames(sid: string, text: string): string {
  if (!text || typeof text !== 'string') return text
  try { const ids = sessionDatasetIds(sid); return ids.length ? store().fromModel(ids, text) : text } catch { return text }
}

/** 递归还原对象 / 数组里的所有字符串值 */
export function restoreDeep<T>(sid: string, value: T): T {
  const ids = (() => { try { return sessionDatasetIds(sid) } catch { return [] } })()
  if (!ids.length) return value
  const st = store()
  const one = (s: string): string => { try { return st.fromModel(ids, s) } catch { return s } }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length < 2 ? v : one(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}
