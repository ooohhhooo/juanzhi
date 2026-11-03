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
}
export interface Job<R> extends JobInput {
  id: string
  status: JobStatus
  error?: string
  result?: R
  createdAt: number
}

export interface JobQueueOptions<R> {
  /** 真正干活；signal 被取消时应尽快停下（已被移除的任务结果会被忽略） */
  run: (job: Job<R>, signal: AbortSignal) => Promise<R>
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
      const r = await o.run(j, ctl.signal)
      if (jobs.get(j.id) !== j || ctls.get(j.id) !== ctl) return   // 已被取消 / 移除 / 重试覆盖
      j.status = 'ready'; j.result = r; j.error = undefined
    } catch (e) {
      if (jobs.get(j.id) !== j || ctls.get(j.id) !== ctl) return
      j.status = 'failed'; j.error = (o.describeError ?? (x => (x instanceof Error ? x.message : String(x))))(e)
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
      j.status = 'queued'; j.error = undefined; j.createdAt = Date.now()
      pump(); changed()
      return true
    },
    count(status: JobStatus): number { return [...jobs.values()].filter(j => j.status === status).length }
  }
}
