import assert from 'node:assert/strict'
import { estimateCost, tokensToMoney, parsePrices, parsePriceMap, modelForKind, configModels, migrateLegacyPrices, summarizeUsage, mayBeShort, createSpendTracker, spendFrom, kindLabel, NO_PRICES } from '../../src/main/ai/cost.ts'

assert.equal(tokensToMoney(1_000_000, 1_000_000, { inPer1M: 2, outPer1M: 8 }), 10)
assert.equal(tokensToMoney(1000, 1000, NO_PRICES), null)
assert.equal(tokensToMoney(1000, 1000, { inPer1M: 2, outPer1M: null }), null)
assert.deepEqual(parsePrices({ inPer1M: 2, outPer1M: -1 }), { inPer1M: 2, outPer1M: null, cachedInPer1M: null })
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

// ── 多模型价格 ──
const cfg = { model: 'main', parse_model: 'parser', vision_model: 'vis' }
assert.equal(modelForKind(cfg, 'parse-text'), 'parser'); assert.equal(modelForKind(cfg, 'parse'), 'parser')
assert.equal(modelForKind(cfg, 'parse-vision'), 'vis'); assert.equal(modelForKind(cfg, 'test-vision'), 'vis')
assert.equal(modelForKind(cfg, 'p3_report'), 'main'); assert.equal(modelForKind(cfg, 'course-match'), 'main')
assert.equal(modelForKind({ model: 'main', parse_model: '', vision_model: '' }, 'parse-text'), 'main', '没设拆题模型用主模型')
assert.equal(modelForKind({ model: 'main', parse_model: '', vision_model: '' }, 'parse-vision'), 'main', '没设视觉模型退回主模型')
assert.deepEqual(configModels(cfg), [{ model: 'main', roles: ['写报告'] }, { model: 'parser', roles: ['拆题'] }, { model: 'vis', roles: ['读图'] }])
assert.deepEqual(configModels({ model: 'a', parse_model: 'a', vision_model: '' }), [{ model: 'a', roles: ['写报告', '拆题'] }], '去重合并用途')
// 缓存价：1M 输入里 0.5M 命中缓存
const dp = { inPer1M: 2, outPer1M: 8, cachedInPer1M: 0.2 }
assert.ok(Math.abs(tokensToMoney(1_000_000, 1_000_000, dp, 500_000) - (0.5 * 2 + 0.5 * 0.2 + 8)) < 1e-9)
assert.equal(tokensToMoney(1_000_000, 0, { inPer1M: 2, outPer1M: 8 }, 500_000), 2, '没填缓存价按输入价')
assert.equal(tokensToMoney(100, 0, dp, 999), 100 * 0.2 / 1e6, '缓存不超过输入')
assert.equal(tokensToMoney(1000, 1000, undefined), null)
// 估算带缓存
e = estimateCost(2, { calls: 3, avgIn: 1_000_000, avgOut: 0, avgCached: 500_000 }, 0, dp)
assert.ok(Math.abs(e.low - (2 * (0.5 * 2 + 0.5 * 0.2)) * 0.8) < 1e-9)
// 旧版单组价格迁移
assert.deepEqual(migrateLegacyPrices({ inPer1M: 2, outPer1M: 8 }, null, cfg), { main: { inPer1M: 2, outPer1M: 8, cachedInPer1M: null } })
assert.equal(migrateLegacyPrices({ inPer1M: 2, outPer1M: 8 }, {}, cfg), null, '已有新价格表不迁移')
assert.equal(migrateLegacyPrices(null, null, cfg), null); assert.equal(migrateLegacyPrices({ inPer1M: null, outPer1M: null }, null, cfg), null)
assert.equal(migrateLegacyPrices({ inPer1M: 2, outPer1M: 8 }, null, { ...cfg, model: '' }), null)
assert.deepEqual(parsePriceMap({ a: { inPer1M: 1, outPer1M: 2 }, ' ': { inPer1M: 1 } }), { a: { inPer1M: 1, outPer1M: 2, cachedInPer1M: null } })
assert.equal(parsePriceMap(null), null); assert.equal(parsePriceMap([1]), null)
// 本月用量：按模型各自换算，合计只含填了价格的
const rows = [
  { kind: 'p3_report', model: 'main', calls: 2, prompt: 1_000_000, completion: 500_000, cached: 0 },
  { kind: 'parse-text', model: 'parser', calls: 5, prompt: 2_000_000, completion: 1_000_000, cached: 1_000_000 },
  { kind: 'parse-vision', model: 'vis', calls: 1, prompt: 1000, completion: 1000, cached: 0 }
]
let sm = summarizeUsage(rows, { main: { inPer1M: 2, outPer1M: 8 }, parser: dp })
assert.ok(Math.abs(sm.rows[0].money - 6) < 1e-9); assert.ok(Math.abs(sm.rows[1].money - (1 * 2 + 1 * 0.2 + 8)) < 1e-9)
assert.equal(sm.rows[2].money, null); assert.equal(sm.unpriced, true); assert.ok(Math.abs(sm.total - 16.2) < 1e-9)
sm = summarizeUsage(rows.slice(0, 2), { main: { inPer1M: 2, outPer1M: 8 }, parser: dp })
assert.equal(sm.unpriced, false)
sm = summarizeUsage(rows, {}); assert.equal(sm.total, 0); assert.ok(sm.rows.every(r => r.money === null))
console.log('ai-cost ok')
