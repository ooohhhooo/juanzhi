/**
 * 运行锁（M7）：图形界面和命令行不能同时使用同一份数据，命令行之间也不能同时跑。
 * 不用 Electron 的单实例锁：第二个实例启动时它会向第一个实例发 `second-instance`（窗口会抢焦点），而命令行不该打扰窗口。
 * 锁是 <userData>/ewb-run.lock 一个文件，内容 {pid, mode, startedAt}，用独占创建（wx）；已有锁时看那个进程还活着没有，死了就当陈旧锁清掉。
 * 不依赖 electron，单测直接加载。
 */
import fs from 'node:fs'
import path from 'node:path'

export type LockMode = 'gui' | 'cli'
export interface LockInfo { pid: number; mode: LockMode; startedAt: string }

export const LOCK_FILE = 'ewb-run.lock'

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }   // EPERM = 活着但不是我们的
}

export function readLock(dir: string): LockInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')) as LockInfo
    return j && Number.isInteger(j.pid) && (j.mode === 'gui' || j.mode === 'cli') ? j : null
  } catch { return null }
}

export type AcquireResult = { ok: true; release: () => void } | { ok: false; holder: LockInfo }

/**
 * 拿锁。已有「活着的别人」持有时返回 { ok:false, holder }；陈旧锁（进程已经没了、或文件损坏）清掉重来。
 * pid = 自己（同一个进程重复拿）视为拿到。
 */
export function acquireRunLock(dir: string, mode: LockMode, pid = process.pid): AcquireResult {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, LOCK_FILE)
  const mine: LockInfo = { pid, mode, startedAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: 'wx' })
      return { ok: true, release: () => releaseRunLock(dir, pid) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const holder = readLock(dir)
    if (holder && holder.pid !== pid && isProcessAlive(holder.pid)) return { ok: false, holder }
    if (holder && holder.pid === pid) { fs.writeFileSync(file, JSON.stringify(mine)); return { ok: true, release: () => releaseRunLock(dir, pid) } }
    // 陈旧 / 损坏：删掉再抢（两个进程同时删同时抢，wx 保证只有一个成功，另一个下一轮会看到对方）
    try { fs.unlinkSync(file) } catch { /* 被别人先删了 */ }
  }
  const holder = readLock(dir)
  return { ok: false, holder: holder ?? { pid: 0, mode: 'cli', startedAt: '' } }
}

/** 只删自己的锁 */
export function releaseRunLock(dir: string, pid = process.pid): void {
  const cur = readLock(dir)
  if (cur && cur.pid === pid) { try { fs.unlinkSync(path.join(dir, LOCK_FILE)) } catch { /* 已经没了 */ } }
}
