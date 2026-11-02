/**
 * AI 并发的自适应降速（AIMD）：不依赖 electron，单测直接加载。
 *
 * 用户在设置里定的并发数是「上限」。服务商返回 429（限速）时，有效并发减半（最少 1）并冷却一段时间；
 * 冷却期过后每连续成功 N 次再 +1，慢慢恢复到上限。429 的重试本身仍由 chat() 的退避负责，这里只管「同时放几份试卷进去」。
 * 同一个冷却窗口内的多次 429 只减半一次（并发 8 路同时撞上限速，不能一口气掉到 1）。
 */

export const MAX_CONCURRENCY = 16

export interface ThrottleOptions {
  /** 冷却时间，默认 30 秒（测试可用环境变量 EWB_AIMD_COOLDOWN_MS 缩短） */
  cooldownMs?: number
  /** 连续成功多少次后恢复一路，默认 3 */
  successesToRaise?: number
  now?: () => number
}

export interface ThrottleState {
  /** 正在被限速压低 */
  throttled: boolean
  /** 当前有效并发（不超过用户设定的上限） */
  effective: number
  /** 用户设定的上限 */
  configured: number
}

export class AimdThrottle {
  private cur: number | null = null   // null = 还没被压低过，跟随上限
  private coolUntil = -Infinity
  private streak = 0
  private lastEventAt = 0
  private readonly cooldownMs: number
  private readonly successesToRaise: number
  private readonly now: () => number
  private lastMax = 1

  constructor(o: ThrottleOptions = {}) {
    this.cooldownMs = o.cooldownMs ?? 30_000
    this.successesToRaise = o.successesToRaise ?? 3
    this.now = o.now ?? Date.now
  }

  /** 在用户设定的上限 max 下，现在允许同时跑几路 */
  effective(max: number): number {
    const m = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(max) || 1))
    this.lastMax = m
    if (this.cur === null) return m
    // 限速是暂时的：很久没有任何 429 / 成功的消息（比如队列早就空了），不让「放慢」一直挂着
    if (this.now() - this.lastEventAt > this.cooldownMs * 4) { this.cur = null; this.streak = 0; return m }
    if (this.cur >= m) { this.cur = null; return m }
    return Math.max(1, this.cur)
  }

  /** 遇到 429。retryAfterMs：服务商给的 Retry-After，冷却不短于它。返回是否发生了变化 */
  onRateLimit(retryAfterMs = 0): boolean {
    const t = this.now()
    this.lastEventAt = t
    const base = this.effective(this.lastMax)
    this.streak = 0
    if (t < this.coolUntil) { this.coolUntil = Math.max(this.coolUntil, t + retryAfterMs); return false }
    this.cur = Math.max(1, Math.floor(base / 2))
    this.coolUntil = t + Math.max(this.cooldownMs, retryAfterMs)
    return base !== this.cur
  }

  /** 一次调用成功。冷却期内不恢复；过了冷却期连续成功够数就 +1。返回是否发生了变化 */
  onSuccess(): boolean {
    if (this.cur === null) return false
    this.lastEventAt = this.now()
    if (this.now() < this.coolUntil) return false
    if (++this.streak < this.successesToRaise) return false
    this.streak = 0
    this.cur += 1
    if (this.cur >= this.lastMax) this.cur = null
    return true
  }

  state(max: number): ThrottleState {
    const effective = this.effective(max)
    return { throttled: effective < Math.max(1, Math.min(MAX_CONCURRENCY, max)), effective, configured: Math.max(1, Math.min(MAX_CONCURRENCY, max)) }
  }

  reset(): void { this.cur = null; this.coolUntil = -Infinity; this.streak = 0 }
}

/** 全应用共用一个（解析、报告的 AI 调用都往它报告结果） */
export const aiThrottle = new AimdThrottle({
  cooldownMs: Number(process.env.EWB_AIMD_COOLDOWN_MS) > 0 ? Number(process.env.EWB_AIMD_COOLDOWN_MS) : 30_000
})
