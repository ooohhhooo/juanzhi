/**
 * 目录改名 / 删除的有限次重试：Windows 上杀毒软件、索引器会短暂占着刚写好的文件，改名时报 EBUSY / EPERM / EACCES，
 * 过一会儿就好了。同步等待（这些操作发生在导入的同步区间里），最多 5 次、每次 200ms；其它错误（比如目标已存在）立刻抛出。
 */
import fs from 'node:fs'

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES'])
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

export function withRetry<T>(fn: () => T, tries = 5, waitMs = 200): T {
  for (let i = 1; ; i++) {
    try { return fn() } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= tries || !code || !TRANSIENT.has(code)) throw e
      sleepSync(waitMs)
    }
  }
}

export const renameRetry = (from: string, to: string, tries?: number, waitMs?: number): void => withRetry(() => fs.renameSync(from, to), tries, waitMs)
