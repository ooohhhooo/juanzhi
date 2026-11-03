/**
 * P3 报告的生成状态放在界面之外的模块级仓库里：切换页面、关掉详情，正在进行的生成都不会丢状态，
 * 回来看到的还是同一份流式文字。按 ai:chunk 事件里的请求号归位（P2 的 analysisStore 同一个思路，两个仓库互不干扰：
 * 各自只认自己发起的请求号）。
 *
 * 可以同时生成多份（最多 MAX_CONCURRENT_REPORTS 份，多的排队；排队逻辑见 reportQueue.ts）。
 * 流式事件（ai:chunk）与这次调用的返回值走两条通道，谁先到不一定：两边都能把状态收尾，而且收尾是幂等的
 * （最终失败 / 取消时「已收到的部分内容」也带在返回值里，不会因为事件晚到而丢）。
 */
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { MAX_CONCURRENT_REPORTS, createRunner, reportKey, type SubmitResult } from './reportQueue'

export interface ReportEntry {
  requestId: string
  status: 'queued' | 'running' | 'error' | 'cancelled'
  text: string
  refs: CitationRef[]
  message?: string
  /** 技术详情（给管理员看，收在「查看详情」里） */
  detail?: string
  code?: string
  filterDesc: string
  reader: ReportReader
  startedAt: number
  thinking?: boolean
  retried?: boolean
  /** 分段生成进度：主文写完后正在跑第几个附加段 */
  step?: { label: string; index: number; total: number }
  /** 用于重试 / 去重 */
  filter: StatsFilter
  options?: ReportOptions
  key: string
}

export interface ReportDone { requestId: string; reportId?: string; reader: ReportReader; filterDesc: string }

let jobs: ReportEntry[] = []
const listeners = new Set<() => void>()
const doneListeners = new Set<(d: ReportDone) => void>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
const get = (id: string) => jobs.find(j => j.requestId === id)
const patch = (id: string, p: Partial<ReportEntry>) => { jobs = jobs.map(j => (j.requestId === id ? { ...j, ...p } : j)); emit() }
/** 任务收尾为 error / cancelled：更新状态并立刻释放 runner 槽位 */
const settle = (id: string, p: Partial<ReportEntry>) => { patch(id, p); runner.release(id) }
const remove = (id: string) => { jobs = jobs.filter(j => j.requestId !== id); emit() }

/** 所有排队 / 生成中 / 失败 / 已取消的任务（成功的会变成历史报告，不在这里），按开始顺序 */
export const useReportJobs = (): ReportEntry[] => useSyncExternalStore(subscribe, () => jobs)
/** 某份报告生成成功时通知（页面据此决定自动打开还是只提示） */
export function onReportDone(cb: (d: ReportDone) => void): () => void { doneListeners.add(cb); return () => { doneListeners.delete(cb) } }

let pendingDone: ReportDone | null = null
/** 报告页回来时取走「页面不在时完成的最近一份」 */
export function takePendingDone(): ReportDone | null { const d = pendingDone; pendingDone = null; return d }

let qc: QueryClient | null = null
let unsub: (() => void) | null = null

function finishOk(id: string, reportId: string | undefined): void {
  if (!get(id)) return
  runner.release(id)
  Promise.resolve(qc?.invalidateQueries({ queryKey: ['reports'] })).finally(() => {
    const cur = get(id)
    if (!cur) return
    remove(id)
    const d: ReportDone = { requestId: id, reportId, reader: cur.reader, filterDesc: cur.filterDesc }
    if (doneListeners.size === 0 && reportId) pendingDone = d   // 页面没挂载：留着，回到报告页时自动打开
    for (const l of doneListeners) l({ requestId: id, reportId, reader: cur.reader, filterDesc: cur.filterDesc })
  })
}

export function installReportChunkListener(queryClient: QueryClient): () => void {
  qc = queryClient
  unsub?.()
  unsub = window.api.on('ai:chunk', (ev: ChunkEvent) => {
    const j = get(ev.id)
    if (!j || j.status !== 'running') return   // 不是报告的请求（比如 P2 的），或这份已经收尾
    if (ev.type === 'start') patch(j.requestId, { refs: ev.refs })
    else if (ev.type === 'delta') patch(j.requestId, { text: j.text + ev.text })
    else if (ev.type === 'reset') patch(j.requestId, { text: '' })
    else if (ev.type === 'thinking') patch(j.requestId, { thinking: true })
    else if (ev.type === 'retry') patch(j.requestId, { retried: true })
    else if (ev.type === 'part') { if (ev.state === 'start') patch(j.requestId, { step: { label: ev.label, index: ev.index, total: ev.total } }) }
    else if (ev.type === 'cancelled') { if (ev.reportId) { finishOk(ev.id, ev.reportId); return } settle(j.requestId, { status: 'cancelled', text: ev.partial }) }
    else if (ev.type === 'error') settle(j.requestId, { status: 'error', text: ev.partial, message: ev.message, detail: ev.detail, code: ev.code })
    else if (ev.type === 'done') finishOk(ev.id, ev.reportId)
  })
  return () => { unsub?.(); unsub = null }
}

async function runJob(job: ReportEntry): Promise<void> {
  const requestId = job.requestId
  try {
    const r = await window.api.report.generate(job.filter, requestId, job.reader, job.options)
    const cur = get(requestId)
    if (!cur) return
    if (r.ok || (r.cancelled && r.reportId)) { finishOk(requestId, r.reportId); return }
    if (cur.status !== 'running') return          // 事件已经先到并处理过了
    if (r.cancelled) settle(requestId, { status: 'cancelled', text: r.partial ?? cur.text })
    else settle(requestId, { status: 'error', text: r.partial ?? cur.text, message: r.message ?? '生成失败', detail: r.detail, code: r.code })
  } catch (e) {
    const cur = get(requestId)
    if (cur && cur.status === 'running') settle(requestId, { status: 'error', message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

const runner = createRunner<ReportEntry>({
  max: MAX_CONCURRENT_REPORTS,
  start: runJob,
  onStart: j => patch(j.requestId, { status: 'running', startedAt: Date.now() })
})

export interface StartResult { result: SubmitResult; requestId: string }

/** 开始（或排队）一份报告；同样的筛选 + 读者 + 选项正在生成 / 排队时不重复启动，返回 duplicate 和那份的请求号 */
export function startReport(filter: StatsFilter, filterDesc: string, reader: ReportReader = 'full', options?: ReportOptions): StartResult {
  const key = reportKey(filter, reader, options)
  const dup = jobs.find(j => j.key === key && (j.status === 'queued' || j.status === 'running'))
  if (dup) return { result: 'duplicate', requestId: dup.requestId }
  const requestId = crypto.randomUUID()
  const job: ReportEntry = { requestId, status: 'queued', text: '', refs: [], filterDesc, reader, startedAt: Date.now(), filter, options, key }
  jobs = [...jobs, job]
  emit()
  const result = runner.submit(job)
  if (result === 'duplicate') {
    remove(requestId)
    const ex = jobs.find(j => j.key === key && (j.status === 'queued' || j.status === 'running'))
    return { result, requestId: ex?.requestId ?? requestId }
  }
  return { result, requestId }
}

/** 取消：排队中的直接移除；生成中的通知主进程中止（收尾走正常的取消事件） */
export function cancelReport(requestId: string): void {
  if (runner.cancelQueued(requestId)) { remove(requestId); return }
  const j = get(requestId)
  if (j?.status === 'running') window.api.ai.cancel(requestId).catch(() => { /* 已结束 */ })
}

/** 失败 / 已取消的任务用同样的参数重来 */
export function retryReportJob(requestId: string): StartResult | null {
  const j = get(requestId)
  if (!j || (j.status !== 'error' && j.status !== 'cancelled')) return null
  remove(requestId)
  return startReport(j.filter, j.filterDesc, j.reader, j.options)
}

export function dismissReportEntry(requestId: string): void {
  const j = get(requestId)
  if (j && (j.status === 'error' || j.status === 'cancelled')) remove(requestId)
}
