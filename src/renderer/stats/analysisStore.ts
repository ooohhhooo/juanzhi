/**
 * P2 生成状态放在界面之外的模块级仓库里：抽屉关掉、切换标签页，正在进行的生成都不会丢状态，
 * 回来看到的还是同一份流式文字。每个同比范围一条记录，按 ai:chunk 事件里的请求号归位。
 */
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'

export interface Entry {
  requestId: string
  status: 'running' | 'error' | 'cancelled'
  text: string
  refs: CitationRef[]
  message?: string
  code?: string
}

const entries = new Map<string, Entry>()
const byId = new Map<string, string>()
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const set = (key: string, e: Entry | null) => { if (e) entries.set(key, e); else entries.delete(key); emit() }

export const scopeKeyOf = (s: CompareScope) => JSON.stringify([s.filter, s.target, s.base, s.level])

export function useAnalysisEntry(scope: CompareScope): Entry | undefined {
  const key = scopeKeyOf(scope)
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => entries.get(key))
}

let qc: QueryClient | null = null
let unsub: (() => void) | null = null

/** 在 App 里调用一次：订阅 ai:chunk（主进程只会把它发给发起请求的这个窗口） */
/** 成功收尾：先让缓存查询拿到新结果，再清掉进行中的记录，界面不会闪回「还没有分析」 */
function finishOk(key: string, id: string): void {
  byId.delete(id)
  Promise.resolve(qc?.invalidateQueries({ queryKey: ['stats', 'analysis'] })).finally(() => { if (entries.get(key)?.requestId === id) set(key, null) })
}

export function installChunkListener(queryClient: QueryClient): () => void {
  qc = queryClient
  unsub?.()
  unsub = window.api.on('ai:chunk', (ev: ChunkEvent) => {
    const key = byId.get(ev.id)
    if (!key) return                       // 不是本界面发起的请求（或早已结束）：忽略
    const cur = entries.get(key)
    if (!cur || cur.requestId !== ev.id) return
    if (ev.type === 'start') set(key, { ...cur, refs: ev.refs })
    else if (ev.type === 'delta') set(key, { ...cur, text: cur.text + ev.text })
    else if (ev.type === 'reset') set(key, { ...cur, text: '' })
    else if (ev.type === 'cancelled') { byId.delete(ev.id); set(key, { ...cur, status: 'cancelled', text: ev.partial }) }
    else if (ev.type === 'error') { byId.delete(ev.id); set(key, { ...cur, status: 'error', text: ev.partial, message: ev.message, code: ev.code }) }
    else if (ev.type === 'done') finishOk(key, ev.id)
  })
  return () => { unsub?.(); unsub = null }
}

export async function startAnalysis(scope: CompareScope): Promise<void> {
  const key = scopeKeyOf(scope)
  if (entries.get(key)?.status === 'running') return
  const requestId = crypto.randomUUID()
  byId.set(requestId, key)
  set(key, { requestId, status: 'running', text: '', refs: [] })
  try {
    // 流式事件（ai:chunk）与这次调用的返回值走的是两条通道，谁先到不一定：两边都能把状态收尾，而且收尾是幂等的
    // （最终失败/取消时的「已收到的部分内容」也带在返回值里，不会因为事件晚到而丢）
    const r = await window.api.ai.analyzeCompare(scope, requestId)
    const cur = entries.get(key)
    if (!cur || cur.requestId !== requestId) return
    if (r.ok) { finishOk(key, requestId); return }
    byId.delete(requestId)
    if (cur.status !== 'running') return          // 事件已经先到并处理过了
    if (r.cancelled) set(key, { ...cur, status: 'cancelled', text: r.partial ?? cur.text })
    else set(key, { ...cur, status: 'error', text: r.partial ?? cur.text, message: r.message ?? '生成失败', code: r.code })
  } catch (e) {
    const cur = entries.get(key)
    byId.delete(requestId)
    if (cur?.requestId === requestId) set(key, { ...cur, status: 'error', message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

export function cancelAnalysis(scope: CompareScope): void {
  const cur = entries.get(scopeKeyOf(scope))
  if (cur?.status === 'running') window.api.ai.cancel(cur.requestId).catch(() => { /* 已结束 */ })
}

export function dismissAnalysis(scope: CompareScope): void {
  const key = scopeKeyOf(scope)
  if (entries.get(key)?.status !== 'running') set(key, null)
}
