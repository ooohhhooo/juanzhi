/**
 * 「拆题模型反复写不完」的检测（M9 D3）。纯函数，不依赖 electron，单测直接加载。
 * 只提示、不自动切换模型（已拍板）：同一个拆题模型最近 10 个批次里，有 ≥ 3 个发生「被长度截断 / 加长重试」，
 * 或单批耗时的中位数 > 90 秒，就建议老师换一个更快的模型。
 */
export interface BatchStat { truncated: number; escalated: number; ms: number | null }

export const HINT_WINDOW = 10
export const HINT_MIN_RETRIED = 3
export const HINT_SLOW_MS = 90_000

export interface ModelHintVerdict {
  suggest: boolean
  /** 窗口里的批次数 */
  total: number
  /** 其中被截断 / 加长重试过的批次数 */
  retried: number
  medianMs: number | null
  reason: 'retries' | 'slow' | null
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** rows：这个拆题模型最近的批次，新的在前；不足 10 个批次不下结论 */
export function judgeModelHint(rows: BatchStat[]): ModelHintVerdict {
  const win = rows.slice(0, HINT_WINDOW)
  const retried = win.filter(r => r.truncated || r.escalated).length
  const medianMs = median(win.map(r => r.ms).filter((x): x is number => typeof x === 'number'))
  if (win.length < HINT_WINDOW) return { suggest: false, total: win.length, retried, medianMs, reason: null }
  if (retried >= HINT_MIN_RETRIED) return { suggest: true, total: win.length, retried, medianMs, reason: 'retries' }
  if (medianMs !== null && medianMs > HINT_SLOW_MS) return { suggest: true, total: win.length, retried, medianMs, reason: 'slow' }
  return { suggest: false, total: win.length, retried, medianMs, reason: null }
}
