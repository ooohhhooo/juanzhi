// AIMD 自适应降速：遇到 429 减半 + 冷却，冷却后连续成功逐步恢复，上下限
import assert from 'node:assert/strict'
import { AimdThrottle, MAX_CONCURRENCY } from '../../src/main/ai/throttle.ts'

let t = 0
const th = new AimdThrottle({ cooldownMs: 1000, successesToRaise: 2, now: () => t })

assert.equal(th.effective(8), 8, '没限速时跟随上限')
assert.equal(th.state(8).throttled, false)
assert.equal(th.effective(99), MAX_CONCURRENCY, '上限不超过 16')
assert.equal(th.effective(0), 1, '最少 1')

// 429：减半（以最近一次问过的上限为准）
th.effective(8)
assert.equal(th.onRateLimit(), true)
assert.equal(th.effective(8), 4)
assert.deepEqual(th.state(8), { throttled: true, effective: 4, configured: 8 })
// 同一个冷却窗口里的多个 429 只减一次
t = 100; assert.equal(th.onRateLimit(), false); assert.equal(th.effective(8), 4)
// 冷却期内成功不恢复
t = 500; assert.equal(th.onSuccess(), false); assert.equal(th.onSuccess(), false); assert.equal(th.effective(8), 4)
// 冷却过后：连续 2 次成功 +1
t = 1200
assert.equal(th.onSuccess(), false)
assert.equal(th.onSuccess(), true); assert.equal(th.effective(8), 5)
th.onSuccess(); th.onSuccess(); assert.equal(th.effective(8), 6)
th.onSuccess(); th.onSuccess(); th.onSuccess(); th.onSuccess()
assert.equal(th.effective(8), 8)
assert.equal(th.state(8).throttled, false, '恢复到上限后不再显示放慢')

// 再次 429 又能降；降到 1 为止
t = 5000
th.onRateLimit(); assert.equal(th.effective(8), 4)
t = 7000; th.onRateLimit(); assert.equal(th.effective(8), 2)
t = 9000; th.onRateLimit(); assert.equal(th.effective(8), 1)
t = 11000; th.onRateLimit(); assert.equal(th.effective(8), 1, '最少 1')

// Retry-After 比冷却长：冷却顺延
{
  let n = 0
  const x = new AimdThrottle({ cooldownMs: 1000, successesToRaise: 1, now: () => n })
  x.effective(4)
  x.onRateLimit(5000)
  n = 3000; assert.equal(x.onSuccess(), false, 'Retry-After 5 秒内不恢复')
  n = 5100; assert.equal(x.onSuccess(), true)
}
// 用户把上限调到比当前有效值还低：以上限为准
{
  const y = new AimdThrottle({ cooldownMs: 1, now: () => 0 })
  y.effective(4); y.onRateLimit(); assert.equal(y.effective(2), 2, '上限降到 2：已经等于上限，不再算被压低')
  assert.equal(y.effective(1), 1)
}
// 上限 1 时被限速也不会卡死，也不显示「放慢」
{
  const z = new AimdThrottle({ now: () => 0 }); z.effective(1); z.onRateLimit(); assert.equal(z.effective(1), 1); assert.equal(z.state(1).throttled, false)
}
// 很久没有任何消息（队列早就空了）：放慢状态自动解除
{
  let n = 0
  const d = new AimdThrottle({ cooldownMs: 1000, now: () => n })
  d.effective(8); d.onRateLimit(); assert.equal(d.effective(8), 4)
  n = 3000; assert.equal(d.effective(8), 4)
  n = 4500; assert.equal(d.effective(8), 8); assert.equal(d.state(8).throttled, false)
}
console.log('throttle.test ✓')
