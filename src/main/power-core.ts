/**
 * 「处理期间防止电脑睡眠」的开关状态机（不依赖 electron，单测直接加载）。
 * 有任务在跑 / 排队时 start 一次，空闲时 stop 一次；重复通知不会重复 start / stop。
 */
export interface PowerDeps {
  start: () => number
  stop: (id: number) => void
}

export function createPowerGuard(deps: PowerDeps) {
  let id: number | null = null
  return {
    /** active = 现在有没有提取 / 解析任务在跑或在排队（暂停中的队列不算） */
    update(active: boolean): void {
      if (active && id === null) id = deps.start()
      else if (!active && id !== null) { const old = id; id = null; deps.stop(old) }
    },
    isBlocking: (): boolean => id !== null,
    id: (): number | null => id
  }
}
