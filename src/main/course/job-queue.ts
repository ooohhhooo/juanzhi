/**
 * 课程大纲「后台整理」队列（纯逻辑，不依赖 electron，单测直接加载）：
 * 向导点“开始整理”后，每个文件一个任务，在主进程内存里排队 / 并发执行（默认并发 2）；关掉向导、切到别的页面都不影响。
 * 任务只放内存（重启后丢失）：queued → running → ready（整理好，待核对）/ failed（简短原因，可重试）。取消 = 直接移除。
 */
export type JobStatus = 'queued' | 'running' | 'ready' | 'failed'

export interface JobInput {
  sessionId: string
  fileName: string
  mode: 'ai' | 'manual'
  /** 向导第 1 步填的（多文件时名称各取文件名） */
  name: string
  scene: string
  termNote: string
  replaceId?: string
  /** 学科（缺省英语）：认列用对应学科的提示词和表头规则 */
  subject?: string
}
export interface JobProgress { done: number; total: number; unit: string; /** 补充说明，如“共 12 个单元，约 12 次 AI 调用” */ note?: string }
export interface Job<R> extends JobInput {
  id: string
  status: JobStatus
  error?: string
  result?: R
  /** 整理进度（整理中才有；例如 3/7 张表） */
  progress?: JobProgress
  createdAt: number
}

export interface JobQueueOptions<R> {
  /** 真正干活；signal 被取消时应尽快停下（已被移除的任务结果会被忽略） */
  run: (job: Job<R>, signal: AbortSignal, report: (done: number, total: number, unit: string, note?: string) => void) => Promise<R>
  concurrency?: number
  onChange?: () => void
  /** 任务被移除（取消 / 用户移除 / 保存完）时调用，用来释放读取会话 */
  onRemoved?: (job: Job<R>) => void
  /** 把错误变成给用户看的简短原因 */
  describeError?: (e: unknown) => string
  newId?: () => string
}

export function createJobQueue<R>(o: JobQueueOptions<R>) {
  const concurrency = Math.max(1, o.concurrency ?? 2)
  const jobs = new Map<string, Job<R>>()
  const ctls = new Map<string, AbortController>()
  let seq = 0
  const newId = o.newId ?? (() => `job-${++seq}`)
  const changed = () => { try { o.onChange?.() } catch { /* 通知失败不影响队列 */ } }
  const running = () => [...jobs.values()].filter(j => j.status === 'running').length

  const start = async (j: Job<R>, ctl: AbortController): Promise<void> => {
    try {
      const report = (done: number, total: number, unit: string, note?: string) => {
        if (jobs.get(j.id) !== j || ctls.get(j.id) !== ctl || j.status !== 'running') return
        j.progress = { done, total, unit, ...(note ? { note } : {}) }; changed()
      }
      const r = await o.run(j, ctl.signal, report)
      if (jobs.get(j.id) !== j || ctls.get(j.id) !== ctl) return   // 已被取消 / 移除 / 重试覆盖
      j.status = 'ready'; j.result = r; j.error = undefined; j.progress = undefined
    } catch (e) {
      if (jobs.get(j.id) !== j || ctls.get(j.id) !== ctl) return
      j.status = 'failed'; j.progress = undefined; j.error = (o.describeError ?? (x => (x instanceof Error ? x.message : String(x))))(e)
    }
    ctls.delete(j.id)
    changed()
    pump()
  }
  function pump(): void {
    for (const j of jobs.values()) {
      if (running() >= concurrency) break
      if (j.status !== 'queued') continue
      j.status = 'running'
      const ctl = new AbortController()
      ctls.set(j.id, ctl)
      void start(j, ctl)
    }
  }

  return {
    add(input: JobInput): Job<R> {
      const j: Job<R> = { ...input, id: newId(), status: 'queued', createdAt: Date.now() }
      jobs.set(j.id, j)
      pump(); changed()
      return j
    },
    list(): Array<Job<R>> { return [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt) },
    get(id: string): Job<R> | undefined { return jobs.get(id) },
    /** 取消（排队 / 整理中）或移除（待核对 / 失败）：都是把任务拿掉 */
    remove(id: string): boolean {
      const j = jobs.get(id)
      if (!j) return false
      jobs.delete(id)
      ctls.get(id)?.abort(); ctls.delete(id)
      try { o.onRemoved?.(j) } catch { /* 释放失败不影响 */ }
      pump(); changed()
      return true
    },
    retry(id: string): boolean {
      const j = jobs.get(id)
      if (!j || j.status !== 'failed') return false
      j.status = 'queued'; j.error = undefined; j.progress = undefined; j.createdAt = Date.now()
      pump(); changed()
      return true
    },
    /** 是否还有排队 / 整理中的任务 */
    busy(): boolean { return [...jobs.values()].some(j => j.status === 'queued' || j.status === 'running') },
    /** 取消并清空全部任务（窗口关闭 / 换数据目录） */
    clear(): void {
      for (const id of [...jobs.keys()]) {
        const j = jobs.get(id)!
        jobs.delete(id)
        ctls.get(id)?.abort(); ctls.delete(id)
        try { o.onRemoved?.(j) } catch { /* 释放失败不影响 */ }
      }
      changed()
    },
    count(status: JobStatus): number { return [...jobs.values()].filter(j => j.status === status).length }
  }
}
