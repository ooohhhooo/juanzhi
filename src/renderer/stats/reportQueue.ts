/**
 * 报告生成的排队调度（纯逻辑，不碰界面和 IPC，方便单元测试）：
 * 最多同时跑 max 份，多的排队；同样的请求（key 相同）在排队 / 生成中不会重复启动。
 */
export const MAX_CONCURRENT_REPORTS = 3

/** 同一筛选 + 读者 + 选项 = 同一份报告；对象键顺序不影响结果 */
export function reportKey(filter: unknown, reader: string, options: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k]
        if (x !== undefined) o[k] = norm(x)
      }
      return o
    }
    return v
  }
  return JSON.stringify([norm(filter ?? {}), reader, norm(options ?? {})])
}

export interface RunnerJob { requestId: string; key: string }
export type SubmitResult = 'started' | 'queued' | 'duplicate'

export function createRunner<T extends RunnerJob>(o: { max: number; start: (job: T) => Promise<unknown>; onStart?: (job: T) => void }) {
  const active = new Map<string, T>()
  const queue: T[] = []
  const hasKey = (key: string) => queue.some(j => j.key === key) || [...active.values()].some(j => j.key === key)
  const pump = (): void => {
    while (active.size < o.max && queue.length > 0) {
      const job = queue.shift()!
      active.set(job.requestId, job)
      o.onStart?.(job)
      Promise.resolve().then(() => o.start(job)).catch(() => { /* 失败由 start 自己记录 */ }).finally(() => { active.delete(job.requestId); pump() })
    }
  }
  return {
    submit(job: T): SubmitResult {
      if (hasKey(job.key)) return 'duplicate'
      queue.push(job)
      const startsNow = active.size < o.max
      pump()
      return startsNow ? 'started' : 'queued'
    },
    /** 只取消还在排队的；返回是否真的取消了 */
    cancelQueued(requestId: string): boolean {
      const i = queue.findIndex(j => j.requestId === requestId)
      if (i < 0) return false
      queue.splice(i, 1)
      return true
    },
    isActive: (id: string) => active.has(id),
    isQueued: (id: string) => queue.some(j => j.requestId === id),
    counts: () => ({ active: active.size, queued: queue.length })
  }
}
