import { refreshPower } from '../power'

/** 处理队列的暂停开关（提取队列与解析队列共用），以及恢复时要唤醒谁 */
let paused = false
const resumeHooks = new Set<() => void>()

export function isQueuePaused(): boolean {
  return paused
}

export function onResume(fn: () => void): void {
  resumeHooks.add(fn)
}

export function setQueuePaused(v: boolean): void {
  if (paused === v) return
  paused = v
  refreshPower()   // 暂停时不再阻止睡眠，继续时按队列状态恢复
  if (!v) for (const fn of resumeHooks) fn()
}
