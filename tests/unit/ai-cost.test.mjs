import assert from 'node:assert/strict'
import { estimateCost, tokensToMoney, parsePrices, mayBeShort, createSpendTracker, spendFrom, kindLabel, NO_PRICES } from '../../src/main/ai/cost.ts'

assert.equal(tokensToMoney(1_000_000, 1_000_000, { inPer1M: 2, outPer1M: 8 }), 10)
assert.equal(tokensToMoney(1000, 1000, NO_PRICES), null)
assert.equal(tokensToMoney(1000, 1000, { inPer1M: 2, outPer1M: null }), null)
assert.deepEqual(parsePrices({ inPer1M: 2, outPer1M: -1 }), { inPer1M: 2, outPer1M: null })
assert.deepEqual(parsePrices(null), NO_PRICES)

// 历史：course-match 输入约 2.4 万、输出约 1 万；4 次请求
const hist = { calls: 5, avgIn: 24000, avgOut: 10000 }
let e = estimateCost(4, hist, 50000, { inPer1M: 2, outPer1M: 8 })
assert.equal(e.fromHistory, true); assert.equal(e.tokensIn, 96000); assert.equal(e.tokensOut, 40000)
const mid = (96000 * 2 + 40000 * 8) / 1e6
assert.ok(Math.abs(e.low - mid * 0.8) < 1e-9 && Math.abs(e.high - mid * 1.3) < 1e-9)
// 没价格只有 token
e = estimateCost(4, hist, 0, NO_PRICES)
assert.equal(e.low, null); assert.equal(e.tokens, 136000)
// 无历史：用现有估算，范围更宽
e = estimateCost(3, null, 30000, { inPer1M: 1, outPer1M: 1 })
assert.equal(e.fromHistory, false); assert.equal(e.tokens, 30000)
assert.ok(e.high / e.low > 4)
// 余额比较
assert.equal(mayBeShort({ high: 5 }, 3, 'CNY'), true)
assert.equal(mayBeShort({ high: 5 }, 30, 'CNY'), false)
assert.equal(mayBeShort({ high: 5 }, 3, 'USD'), false, '币种不同不比较')
assert.equal(mayBeShort({ high: null }, 3, 'CNY'), false)
assert.equal(mayBeShort({ high: 5 }, null, 'CNY'), false)
// 实际花费
assert.deepEqual(spendFrom({ amount: 12.34, currency: 'CNY' }, { amount: 11.1, currency: 'CNY' }), { amount: 1.24, currency: 'CNY' })
assert.equal(spendFrom({ amount: 1, currency: 'CNY' }, { amount: 5, currency: 'CNY' }), null, '变多了（充值）')
assert.equal(spendFrom({ amount: 1, currency: 'CNY' }, { amount: 0, currency: 'USD' }), null)
assert.equal(spendFrom(null, { amount: 0, currency: 'CNY' }), null)
assert.equal(spendFrom({ amount: null, currency: 'USD' }, { amount: null, currency: 'USD' }), null)
// 并发任务不记录
const t = createSpendTracker()
const a = t.begin(); const b = t.begin()
assert.equal(t.end(a), false); assert.equal(t.end(b), false)
const c = t.begin(); assert.equal(t.end(c), true)
assert.equal(kindLabel('course-match'), '课程匹配'); assert.equal(kindLabel('zzz'), 'zzz')
console.log('ai-cost ok')
