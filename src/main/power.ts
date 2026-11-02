/**
 * 提取 / 解析队列有任务时，阻止系统因空闲而挂起应用（powerSaveBlocker 'prevent-app-suspension'：屏幕可以关，程序不被冻结）。
 * 注意：合上笔记本盖子系统仍会睡眠，界面文案要说清楚。
 * 各队列在模块加载时登记「我现在忙不忙」，状态变化时调用 refreshPower()。
 */
import { powerSaveBlocker } from 'electron'
import { createPowerGuard } from './power-core'

const guard = createPowerGuard({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: id => { try { powerSaveBlocker.stop(id) } catch { /* 已经停了 */ } }
})

const sources: Array<() => boolean> = []
export function registerBusySource(fn: () => boolean): void { sources.push(fn) }
export function refreshPower(): void { guard.update(sources.some(fn => { try { return fn() } catch { return false } })) }

/** 真实状态：以 electron 的 isStarted 为准 */
export function isPowerBlocking(): boolean {
  const id = guard.id()
  return id !== null && powerSaveBlocker.isStarted(id)
}
