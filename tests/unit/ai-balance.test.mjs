// 余额查询：服务商识别、各家响应解析、中转平台（one-api / LiteLLM）、自定义查询。全部用伪造响应，不发真实请求。
import assert from 'node:assert/strict'
import { detectProvider, parseDeepSeek, parseMoonshot, parseSiliconFlow, parseOpenRouter, parseRelay, parseLiteLlm, parseCustom, pickPath, fetchBalance, fetchCustomBalance, balanceUrls, relayRoot, fmtAmount } from '../../src/main/ai/balance.ts'

assert.equal(detectProvider('https://api.deepseek.com').id, 'deepseek')
assert.equal(detectProvider('https://api.deepseek.com').consoleUrl, 'https://platform.deepseek.com/top_up')
assert.equal(detectProvider('https://api.moonshot.cn/v1').id, 'moonshot')
assert.equal(detectProvider('https://api.siliconflow.cn/v1').id, 'siliconflow')
assert.equal(detectProvider('https://openrouter.ai/api/v1').id, 'openrouter')
assert.equal(detectProvider('https://dashscope.aliyuncs.com/compatible-mode/v1').id, 'nobalance')
assert.equal(detectProvider('https://llm.corp.example.com/v1').id, 'relay')
assert.equal(detectProvider('https://llm.corp.example.com/v1').name, '中转平台（OpenAI 兼容）')
assert.equal(detectProvider('http://127.0.0.1:18080/v1').id, 'relay')
assert.equal(detectProvider('not a url'), null)
assert.equal(detectProvider('https://evil-deepseek.com.attacker.io').id, 'relay', '主机名后缀才算')

// DeepSeek
let p = parseDeepSeek({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00' }, { currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }] })
assert.deepEqual([p.amount, p.currency, p.available], [12.34, 'CNY', true])
assert.equal(parseDeepSeek({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }).available, false)
assert.equal(parseDeepSeek({ nope: 1 }), null)
// Moonshot
p = parseMoonshot({ code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 }, status: true })
assert.deepEqual([p.amount, p.currency], [49.58, 'CNY'])
assert.equal(parseMoonshot({ data: { available_balance: -1 } }).available, false)
assert.equal(parseMoonshot({}), null)
// SiliconFlow
assert.equal(parseSiliconFlow({ data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } }).amount, 88.88)
assert.equal(parseSiliconFlow({ data: { balance: '1', chargeBalance: '2' } }).amount, 3)
// OpenRouter
p = parseOpenRouter({ data: { total_credits: 10, total_usage: 2.5 } })
assert.deepEqual([p.amount, p.currency], [7.5, 'USD'])
// one-api 风格
p = parseRelay({ hard_limit_usd: 100, soft_limit_usd: 100 }, { total_usage: 2500 })
assert.deepEqual([p.amount, p.currency, p.available], [75, 'USD', true])
p = parseRelay({ hard_limit_usd: 5 }, { total_usage: 600 })
assert.equal(p.amount, -1); assert.equal(p.available, false)
p = parseRelay({ hard_limit_usd: 100000000 }, { total_usage: 123 })
assert.equal(p.unlimited, true); assert.equal(p.amount, null)
assert.equal(parseRelay({ error: 1 }, { total_usage: 1 }), null)
// LiteLLM
assert.equal(parseLiteLlm({ key: 'x', info: { spend: 2.5, max_budget: 10 } }).amount, 7.5)
assert.equal(parseLiteLlm({ info: { spend: 2.5, max_budget: null } }).unlimited, true)
assert.equal(parseLiteLlm({ detail: 'x' }), null)
// 自定义字段路径
assert.equal(pickPath({ data: { items: [{ left: '5.5' }] } }, 'data.items.0.left'), 5.5)
assert.equal(pickPath({ data: { balance: 'abc' } }, 'data.balance'), null)
assert.equal(pickPath({ data: {} }, 'data.__proto__.x'), null)
const cu = { url: 'https://gw.corp.example.com/me/quota', balancePath: 'data.left', totalPath: 'data.total', unit: '点' }
assert.deepEqual([parseCustom({ data: { left: 30, total: 100 } }, cu).amount, parseCustom({ data: { left: 30, total: 100 } }, cu).total], [30, 100])
assert.equal(parseCustom({ data: {} }, cu), null)

assert.equal(relayRoot('https://gw.example.com/v1/'), 'https://gw.example.com')
assert.equal(fmtAmount(12.345, 'CNY'), '¥12.35')

// URL
const urls = balanceUrls(detectProvider('https://gw.example.com/v1'), 'https://gw.example.com/v1', new Date('2026-11-03T08:00:00'))
assert.equal(urls[0], 'https://gw.example.com/v1/dashboard/billing/subscription')
assert.equal(urls[1], 'https://gw.example.com/v1/dashboard/billing/usage?start_date=2026-07-27&end_date=2026-11-04')
assert.deepEqual(balanceUrls(detectProvider('https://api.deepseek.com'), 'https://api.deepseek.com'), ['https://api.deepseek.com/user/balance'])
assert.deepEqual(balanceUrls(detectProvider('https://api.moonshot.cn/v1'), 'https://api.moonshot.cn/v1'), ['https://api.moonshot.cn/v1/users/me/balance'])

// fetchBalance（伪造 fetch）
const mk = routes => async (url, init) => {
  assert.ok(init.headers.Authorization.startsWith('Bearer '))
  const hit = Object.entries(routes).find(([k]) => url.includes(k))
  if (!hit) return { ok: false, status: 404, text: async () => 'nf' }
  const [, v] = hit
  return typeof v === 'number' ? { ok: false, status: v, text: async () => '{}' } : { ok: true, status: 200, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) }
}
let r = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: mk({ '/user/balance': { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] } }) })
assert.equal(r.status, 'ok'); assert.equal(r.text, '¥12.34')
r = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: mk({ '/user/balance': 401 }) })
assert.equal(r.status, 'error'); assert.match(r.message, /API Key/)
r = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: null, fetchImpl: mk({}) })
assert.equal(r.status, 'nokey')
r = await fetchBalance({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'k', fetchImpl: mk({}) })
assert.equal(r.status, 'unsupported'); assert.match(r.message, /不支持在软件里查余额/); assert.ok(r.consoleUrl)
// one-api 中转
r = await fetchBalance({ baseUrl: 'https://gw.example.com/v1', apiKey: 'k', fetchImpl: mk({ '/billing/subscription': { hard_limit_usd: 50 }, '/billing/usage': { total_usage: 1000 } }) })
assert.equal(r.status, 'ok'); assert.equal(r.text, '额度 $40.00'); assert.equal(r.note, '中转平台的额度单位以平台为准')
r = await fetchBalance({ baseUrl: 'https://gw.example.com/v1', apiKey: 'k', fetchImpl: mk({ '/billing/subscription': { hard_limit_usd: 1e9 }, '/billing/usage': { total_usage: 1 } }) })
assert.equal(r.text, '不限额度')
// LiteLLM 兜底
r = await fetchBalance({ baseUrl: 'https://gw.example.com', apiKey: 'k', fetchImpl: mk({ '/key/info': { info: { spend: 1, max_budget: 5 } } }) })
assert.equal(r.status, 'ok'); assert.equal(r.text, '额度 $4.00')
// 都不行 → unsupported
r = await fetchBalance({ baseUrl: 'https://gw.example.com/v1', apiKey: 'k', fetchImpl: mk({ '/billing/subscription': '<html>', '/billing/usage': '<html>' }) })
assert.equal(r.status, 'unsupported')
r = await fetchBalance({ baseUrl: 'https://gw.example.com/v1', apiKey: 'k', fetchImpl: mk({}) })
assert.equal(r.status, 'unsupported')
// 超时
const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
r = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: hang, timeoutMs: 30 })
assert.equal(r.status, 'error'); assert.match(r.message, /超时/)

// 自定义查询
r = await fetchCustomBalance(cu, 'k', 'https://gw.corp.example.com/v1', mk({ '/me/quota': { data: { left: 30, total: 100 } } }))
assert.equal(r.status, 'ok'); assert.equal(r.text, '30.00 / 100.0 点')
r = await fetchCustomBalance(cu, 'k', 'https://other.example.com/v1', mk({}))
assert.equal(r.status, 'error'); assert.match(r.message, /同一个主机/)
r = await fetchCustomBalance({ ...cu, url: 'file:///etc/passwd' }, 'k', 'https://gw.corp.example.com', mk({}))
assert.equal(r.status, 'error')
r = await fetchCustomBalance(cu, 'k', 'https://gw.corp.example.com', mk({ '/me/quota': { data: {} } }))
assert.match(r.message, /data\.left/)
console.log('ai-balance ok')
