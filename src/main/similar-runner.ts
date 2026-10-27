/**
 * 整库「检查重复试卷」的后台任务（单例）：升级后自动跑一次、设置页的按钮手动跑。
 * 扫描本身是 parse/similar.ts 的 scanSimilarAsync（内存里比对、每 12 毫秒让出一次事件循环），所以不会挡住窗口弹出和别的 IPC。
 * 进度走 `similar:progress` 事件（只发给主窗口）：{ running, done, total, suspects? }，结束时 running = false 且带 suspects；
 * 同时有一个扫描在跑时再调用，返回的是同一个 Promise（不会并发扫两遍）。
 */
import { getDb } from './db'
import { scanSimilarAsync } from './parse/similar'
import type { ScanResult } from './parse/similar'
import { getMainWindow } from './window'
import { notifyDataChanged } from './events'

export interface SimilarScanStatus { running: boolean; done: number; total: number; suspects: number | null }

let status: SimilarScanStatus = { running: false, done: 0, total: 0, suspects: null }
let current: Promise<ScanResult> | null = null

const send = () => getMainWindow()?.webContents.send('similar:progress', { ...status })

export const similarScanStatus = (): SimilarScanStatus => ({ ...status })

export function startSimilarScan(): Promise<ScanResult> {
  if (current) return current
  status = { running: true, done: 0, total: 0, suspects: null }
  send()
  let lastSent = 0
  current = scanSimilarAsync(getDb(), p => {
    status = { running: true, done: p.done, total: p.total, suspects: null }
    const now = Date.now()
    if (now - lastSent >= 200) { lastSent = now; send() }
  }).then(r => {
    status = { running: false, done: r.checked, total: r.checked, suspects: r.suspects }
    send()
    notifyDataChanged('papers')
    return r
  }, e => {
    status = { running: false, done: status.done, total: status.total, suspects: null }
    send()
    throw e
  }).finally(() => { current = null })
  return current
}
