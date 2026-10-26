/**
 * P3 报告的生成状态放在界面之外的模块级仓库里：切换页面、关掉详情，正在进行的生成都不会丢状态，
 * 回来看到的还是同一份流式文字。按 ai:chunk 事件里的请求号归位（P2 的 analysisStore 同一个思路，两个仓库互不干扰：
 * 各自只认自己发起的请求号）。同一时间只有一份报告在生成。
 *
 * 流式事件（ai:chunk）与这次调用的返回值走两条通道，谁先到不一定：两边都能把状态收尾，而且收尾是幂等的
 * （最终失败 / 取消时「已收到的部分内容」也带在返回值里，不会因为事件晚到而丢）。
 */
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'

export interface ReportEntry {
  requestId: string
  status: 'running' | 'error' | 'cancelled'
  text: string
  refs: CitationRef[]
  message?: string
  code?: string
  filterDesc: string
}

let entry: ReportEntry | null = null
let lastDone: { id: string; at: number } | null = null
let activeId: string | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const setEntry = (e: ReportEntry | null) => { entry = e; emit() }
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

export const useReportEntry = (): ReportEntry | null => useSyncExternalStore(subscribe, () => entry)
/** 最近一次生成成功的报告 id（页面据此自动选中新报告） */
export const useLastDone = (): { id: string; at: number } | null => useSyncExternalStore(subscribe, () => lastDone)

let qc: QueryClient | null = null
let unsub: (() => void) | null = null

function finishOk(id: string, reportId: string | undefined): void {
  activeId = null
  Promise.resolve(qc?.invalidateQueries({ queryKey: ['reports'] })).finally(() => {
    if (reportId) lastDone = { id: reportId, at: Date.now() }
    if (entry?.requestId === id) setEntry(null)
    else emit()
  })
}

export function installReportChunkListener(queryClient: QueryClient): () => void {
  qc = queryClient
  unsub?.()
  unsub = window.api.on('ai:chunk', (ev: ChunkEvent) => {
    if (!activeId || ev.id !== activeId || !entry || entry.requestId !== ev.id) return   // 不是报告的请求（比如 P2 的）：忽略
    if (ev.type === 'start') setEntry({ ...entry, refs: ev.refs })
    else if (ev.type === 'delta') setEntry({ ...entry, text: entry.text + ev.text })
    else if (ev.type === 'reset') setEntry({ ...entry, text: '' })
    else if (ev.type === 'cancelled') { activeId = null; setEntry({ ...entry, status: 'cancelled', text: ev.partial }) }
    else if (ev.type === 'error') { activeId = null; setEntry({ ...entry, status: 'error', text: ev.partial, message: ev.message, code: ev.code }) }
    else if (ev.type === 'done') finishOk(ev.id, ev.reportId)
  })
  return () => { unsub?.(); unsub = null }
}

export async function startReport(filter: StatsFilter, filterDesc: string): Promise<void> {
  if (entry?.status === 'running') return
  const requestId = crypto.randomUUID()
  activeId = requestId
  setEntry({ requestId, status: 'running', text: '', refs: [], filterDesc })
  try {
    const r = await window.api.report.generate(filter, requestId)
    const cur = entry as ReportEntry | null
    if (!cur || cur.requestId !== requestId) return
    if (r.ok) { finishOk(requestId, r.reportId); return }
    activeId = null
    if (cur.status !== 'running') return          // 事件已经先到并处理过了
    if (r.cancelled) setEntry({ ...cur, status: 'cancelled', text: r.partial ?? cur.text })
    else setEntry({ ...cur, status: 'error', text: r.partial ?? cur.text, message: r.message ?? '生成失败', code: r.code })
  } catch (e) {
    const cur = entry as ReportEntry | null
    activeId = null
    if (cur?.requestId === requestId) setEntry({ ...cur, status: 'error', message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

export function cancelReport(): void {
  if (entry?.status === 'running') window.api.ai.cancel(entry.requestId).catch(() => { /* 已结束 */ })
}

export function dismissReportEntry(): void {
  if (entry && entry.status !== 'running') setEntry(null)
}
