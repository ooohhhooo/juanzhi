/**
 * 带并发上限的 map（纯逻辑）：结果顺序与输入一致；任一项抛错则不再启动新的项，并把第一个错误抛出
 * （已在途的项仍会跑完，由调用方通过 signal 中止）。
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  let firstErr: unknown
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch (e) { if (!failed) { failed = true; firstErr = e } return }
    }
  }
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  await Promise.all(Array.from({ length: n }, worker))
  if (failed) throw firstErr
  return out
}

/** 共享并发闸：所有经它的调用同时在途不超过 n 个（先到先得） */
export function createGate(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  const release = () => { active--; waiting.shift()?.() }
  return async fn => {
    if (active >= Math.max(1, n)) await new Promise<void>(res => waiting.push(res))
    active++
    try { return await fn() } finally { release() }
  }
}
