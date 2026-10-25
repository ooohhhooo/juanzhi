import type { JobProgress } from './types'
import { getMainWindow } from './window'

const pendingChanges = new Set<string>()
let changeTimer: ReturnType<typeof setTimeout> | null = null

const pendingProgress = new Map<string, JobProgress>()
let progressTimer: ReturnType<typeof setTimeout> | null = null

const THROTTLE_MS = 500

/** 数据变化通知：合并 500ms 内的多次通知，只发给主窗口 */
export function notifyDataChanged(...entityTypes: string[]): void {
  for (const t of entityTypes) pendingChanges.add(t)
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    const types = Array.from(pendingChanges)
    pendingChanges.clear()
    changeTimer = null
    getMainWindow()?.webContents.send('data:changed', types)
  }, THROTTLE_MS)
}

/** 任务进度：同一试卷 500ms 内只保留最后一条 */
export function sendProgress(progress: JobProgress): void {
  pendingProgress.set(progress.paperId, progress)
  if (progressTimer) return
  progressTimer = setTimeout(() => {
    const items = Array.from(pendingProgress.values())
    pendingProgress.clear()
    progressTimer = null
    const win = getMainWindow()
    if (win) for (const p of items) win.webContents.send('job:progress', p)
  }, THROTTLE_MS)
}
