import assert from 'node:assert/strict'
import { diagnose, isBalanceRelated, diagnosisText } from '../../src/main/ai/diagnose.ts'
import { statusError } from '../../src/main/ai/client.ts'

const E = (code, status, detail = '', message = '') => ({ code, status, detail, message })
const has = (g, re) => g.reasons.some(r => re.test(r.text + r.fix))

// 余额不足：402 / body 关键词 / 刚查余额为 0
let g = diagnose(E('bad_request', 402, '{"error":{"message":"Insufficient Balance"}}'))
assert.match(g.cause, /余额|额度/); assert.ok(g.balanceRelated); assert.match(g.raw, /HTTP 402 · 服务商原话：.*Insufficient Balance/)
g = diagnose(E('balance', 402, ''), { balance: { amount: 0, currency: 'CNY', text: '¥0.00' } })
assert.match(g.cause, /¥0\.00/); assert.match(g.reasons[0].text, /¥0\.00/)
g = diagnose(E('bad_request', 400, '余额不足，请充值'))
assert.ok(g.balanceRelated); assert.match(g.cause, /余额/)
g = diagnose(E('server', 500, 'x'), { balance: { amount: 0, currency: 'CNY', text: '¥0.00' } })
assert.ok(g.balanceRelated, '刚查余额 ≤ 0')
// 401 / 403 / 404
g = diagnose(E('auth', 401, 'invalid api key')); assert.match(g.cause, /Key/); assert.ok(g.reasons.length >= 2)
g = diagnose(E('forbidden', 403, 'no access'), { model: 'm1' }); assert.match(g.cause, /权限.*m1/)
g = diagnose(E('not_found', 404, 'model not found')); assert.match(g.cause, /模型|接口/); assert.ok(has(g, /Base URL/))
// 429 三种
g = diagnose(E('rate_limit', 429, 'Rate limit reached for requests')); assert.match(g.cause, /频繁|拥堵/); assert.ok(has(g, /额度用完/), '中转站 429 也列额度')
g = diagnose(E('rate_limit', 429, 'too many concurrent requests')); assert.match(g.cause, /并发/)
g = diagnose(E('rate_limit', 429, 'quota exceeded, insufficient quota')); assert.match(g.cause, /额度/); assert.ok(g.balanceRelated)
g = diagnose(E('rate_limit', 429, '')); assert.ok(g.reasons.length >= 2 && g.reasons.length <= 4)
// 5xx
g = diagnose(E('server', 503, 'The engine is currently overloaded')); assert.match(g.cause, /过载|繁忙/)
g = diagnose(E('server', 502, 'bad gateway')); assert.match(g.cause, /故障/); assert.ok(has(g, /网关/))
// 网络 / 超时 / 截断
g = diagnose(E('network', null, 'fetch failed')); assert.match(g.cause, /网络/); assert.ok(has(g, /代理/)); assert.match(g.raw, /错误类型 network/)
g = diagnose(E('timeout', null), { reasoning: true, model: 'deepseek-v4-pro' }); assert.match(g.cause, /思考/); assert.ok(has(g, /换一个速度快/))
g = diagnose(E('timeout', null), { reasoning: false }); assert.match(g.cause, /没有回应/)
g = diagnose(E('truncated', null)); assert.ok(has(g, /一次最多写多长/))
// 审核 / 格式 / 400
g = diagnose(E('bad_request', 400, 'content_filter triggered')); assert.match(g.cause, /审核/)
g = diagnose(E('empty', null, 'sensitive content')); assert.ok(has(g, /审核/))
g = diagnose({ message: 'AI 返回的 JSON 解析失败' }); assert.match(g.cause, /格式/)
g = diagnose(E('bad_output', null, 'x')); assert.match(g.cause, /格式/); assert.ok(g.reasons.length >= 2)
g = diagnose(E('bad_request', 400, 'unsupported parameter foo')); assert.match(g.cause, /拒绝/); assert.match(g.raw, /unsupported parameter foo/)
g = diagnose(E('bad_request', 400, 'maximum context length is 65536 tokens')); assert.match(g.cause, /太长/)
g = diagnose({ message: 'who knows' }); assert.match(g.cause, /没有成功/)
// 原因 1–4 条；原话里的密钥被抹掉；文本不含密钥
for (const x of [E('auth', 401), E('rate_limit', 429, 'a'), E('server', 500), E('network', null), E('timeout', null), E('bad_request', 400, 'x'), E('forbidden', 403, 'quota')]) {
  const r = diagnose(x, { reasoning: true }).reasons.length; assert.ok(r >= 1 && r <= 4, `${x.code} ${r}`)
}
g = diagnose(E('bad_request', 400, 'bad key sk-abcdef1234567890 Bearer abcdef1234567890xyz'))
assert.ok(!/abcdef1234567890/.test(g.raw)); assert.ok(!/abcdef1234567890/.test(diagnosisText(g)))
assert.equal(isBalanceRelated(E('rate_limit', 429, 'rate limit exceeded')), false)
// 与真实 statusError 对接（含脱敏）
assert.equal(statusError(402, 'x').code, 'balance')
const se = statusError(402, '{"error":{"message":"Insufficient Balance sk-secretsecret123"}}', 'sk-secretsecret123', 'm')
g = diagnose(se); assert.ok(g.balanceRelated); assert.ok(!g.raw.includes('secretsecret123'))
g = diagnose(statusError(429, 'rate limit', '', 'm')); assert.ok(g.reasons.length >= 2)
console.log('ai-diagnose ok')
