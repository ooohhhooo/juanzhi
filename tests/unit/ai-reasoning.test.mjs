// A1：推理模型（deepseek-v4-pro）的思考内容也占输出额度。客户端要：读 reasoning_content（不计入正文、只报进度）、
// 写不完（finish_reason=length）时把上限翻倍重试一次（不超过模型天花板）、仍不行就带着已写出的部分报 truncated；报错一律白话。
import assert from 'node:assert/strict'
import { chat, AiError } from '../../src/main/ai/client.ts'
import { friendlyAiError, RETRY_HINT } from '../../src/main/ai/friendly.ts'
import { modelProfile, effectiveMaxTokens, PROVIDER_PRESETS } from '../../src/main/ai/providers.ts'

const ev = o => `data: ${JSON.stringify(o)}\n\n`
const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-unit', model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], backoffMs: 5, timeoutMs: 2000, stream: true }
function fakeFetch(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body))
    const step = script.shift()
    if (step.status && step.status !== 200) return new Response(step.text, { status: step.status })
    const enc = new TextEncoder()
    return new Response(new ReadableStream({ start(c) { for (const s of step.sse) c.enqueue(enc.encode(s)); c.close() } }), { status: 200 })
  }
  return { fetchImpl, calls }
}
const sseOk = (think, text, finish = 'stop', usage = { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } }) => ({
  sse: [...(think ? [ev({ choices: [{ delta: { reasoning_content: think.slice(0, 5) } }] }), ev({ choices: [{ delta: { reasoning_content: think.slice(5) } }] })] : []),
    ev({ choices: [{ delta: { content: text }, finish_reason: finish }] }), ev({ choices: [], usage }), 'data: [DONE]\n\n']
})
const fail = async p => { try { await p; return null } catch (e) { return e } }

// ── reasoning_content：不计入正文，只报进度；用量里带思考 token ──
{
  const { fetchImpl } = fakeFetch([sseOk('思考思考思考思考思考', '正文')])
  const deltas = [], think = []
  const r = await chat({ ...base, fetchImpl, maxTokens: 1000, onDelta: d => deltas.push(d), onThinking: i => think.push(i) })
  assert.equal(r.content, '正文'); assert.deepEqual(deltas, ['正文'], '思考内容不进正文')
  assert.equal(r.reasoningChars, 10); assert.ok(think.length >= 1 && think[0].chars >= 5 && think[0].ms >= 0)
  assert.equal(r.usage.reasoningTokens, 20); assert.equal(r.escalated, false); assert.equal(r.maxTokensUsed, 1000)
}
// 非流式也能读到思考字数
{
  const calls = []
  const fetchImpl = async (u, init) => { calls.push(1); return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'ok', reasoning_content: '想了想' }, finish_reason: 'stop' }], usage: { completion_tokens_details: { reasoning_tokens: 3 } } }), { status: 200 }) }
  const r = await chat({ ...base, stream: false, fetchImpl })
  assert.equal(r.reasoningChars, 3); assert.equal(r.usage.reasoningTokens, 3)
}

// ── 写不完：先 length，加倍上限后成功 ──
{
  const { fetchImpl, calls } = fakeFetch([sseOk('想', '半截', 'length'), sseOk('想', '完整的正文')])
  const retries = []
  const r = await chat({ ...base, fetchImpl, maxTokens: 8192, escalateOnLength: { ceiling: 65536 }, onRetry: i => retries.push(i) })
  assert.equal(r.content, '完整的正文'); assert.equal(r.escalated, true); assert.equal(r.maxTokensUsed, 16384)
  assert.deepEqual(calls.map(c => c.max_tokens), [8192, 16384]); assert.deepEqual(retries, [{ reason: 'length', maxTokens: 16384, previousMaxTokens: 8192 }])
}
// 翻倍不超过天花板
{
  const { fetchImpl, calls } = fakeFetch([sseOk('', 'a', 'length'), sseOk('', '好')])
  await chat({ ...base, fetchImpl, maxTokens: 40000, escalateOnLength: { ceiling: 65536 } })
  assert.deepEqual(calls.map(c => c.max_tokens), [40000, 65536])
}
// 已经到天花板：不重试，直接 truncated，带着已写出的部分
{
  const { fetchImpl, calls } = fakeFetch([sseOk('想想', '写了一半', 'length')])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 65536, escalateOnLength: { ceiling: 65536 } }))
  assert.ok(e instanceof AiError && e.code === 'truncated'); assert.equal(e.partial, '写了一半'); assert.equal(calls.length, 1)
  assert.match(e.detail, /finish_reason=length/); assert.match(e.detail, /思考 2 字/)
}
// 两次都写不完：只重试一次，最终 truncated 带最后一次的内容
{
  const { fetchImpl, calls } = fakeFetch([sseOk('', '第一次', 'length'), sseOk('', '第二次更长一点', 'length'), sseOk('', '不会有第三次')])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 8192, escalateOnLength: { ceiling: 65536 } }))
  assert.equal(e.code, 'truncated'); assert.equal(e.partial, '第二次更长一点'); assert.equal(calls.length, 2)
  assert.match(e.detail, /已自动加大上限重试过/)
}
// 没开 escalateOnLength（旧用法）：和以前一样，不重试
{
  const { fetchImpl, calls } = fakeFetch([sseOk('', 'x', 'length')])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 100 }))
  assert.equal(e.code, 'truncated'); assert.equal(calls.length, 1)
}
// 加大上限后服务商直接拒绝（它的上限比我们以为的小）：回到「写不完」，不报 400
{
  const { fetchImpl } = fakeFetch([sseOk('', '半截', 'length'), { status: 400, text: '{"error":{"message":"max_tokens must be <= 8192"}}' }])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 8192, escalateOnLength: { ceiling: 65536 }, maxRetries: 0 }))
  assert.equal(e.code, 'truncated'); assert.match(e.detail, /被服务商拒绝/); assert.equal(e.partial, '半截')
}

// ── P2-5：「自动」上限猜错（首个请求就被拒绝）→ 降到安全值重试一次；手填值永远不翻倍 ──
{
  const { fetchImpl, calls } = fakeFetch([{ status: 400, text: '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"}}' }, sseOk('', '好了')])
  const r = await chat({ ...base, fetchImpl, maxTokens: 32768, maxTokensFallback: 8192, escalateOnLength: { ceiling: 65536 }, maxRetries: 0 })
  assert.equal(r.content, '好了'); assert.equal(r.fellBackTo, 8192); assert.equal(r.maxTokensUsed, 8192)
  assert.deepEqual(calls.map(c => c.max_tokens), [32768, 8192], '先用自动值，被拒绝后降到 8192，只试一次')
}
{
  // 降级后还是被拒绝：不再降，报「请求被拒绝」
  const { fetchImpl, calls } = fakeFetch([{ status: 400, text: 'max_tokens too large' }, { status: 400, text: 'max_tokens too large' }])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 32768, maxTokensFallback: 8192, maxRetries: 0 }))
  assert.equal(e.code, 'bad_request'); assert.equal(calls.length, 2)
}
{
  // 没给 maxTokensFallback（手动模式）：被拒绝就是被拒绝，不悄悄改管理员填的数
  const { fetchImpl, calls } = fakeFetch([{ status: 400, text: 'max_tokens too large' }])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: 32768, maxRetries: 0 }))
  assert.equal(e.code, 'bad_request'); assert.equal(calls.length, 1)
}
{
  // 手填值 + 写不完：ceiling = 手填值，不翻倍（和 stream.ts / run.ts 的用法一致）
  const lim = effectiveMaxTokens({ max_tokens: 8192, max_tokens_auto: false }, 'deepseek-v4-pro')
  const { fetchImpl, calls } = fakeFetch([sseOk('', '半截', 'length')])
  const e = await fail(chat({ ...base, fetchImpl, maxTokens: lim.maxTokens, escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback }))
  assert.equal(e.code, 'truncated'); assert.equal(calls.length, 1, '手填值不翻倍')
}
// ── P2-5：一次调用的总时限（模型断断续续一直写也不能无限等）──
{
  const enc = new TextEncoder()
  const slow = async (url, init) => new Response(new ReadableStream({
    async start(c) {
      init.signal.addEventListener('abort', () => { try { c.error(new Error('aborted')) } catch { /* 已关 */ } })
      for (let i = 0; i < 50 && !init.signal.aborted; i++) { await new Promise(r => setTimeout(r, 30)); try { c.enqueue(enc.encode(ev({ choices: [{ delta: { reasoning_content: '想' } }] }))) } catch { return } }
    }
  }), { status: 200 })
  const t0 = Date.now()
  const e = await fail(chat({ ...base, fetchImpl: slow, timeoutMs: 5000, maxTotalMs: 200, maxRetries: 3 }))
  assert.equal(e.code, 'timeout'); assert.match(e.message, /写了太久/); assert.equal(e.detail, 'total-timeout')
  assert.ok(Date.now() - t0 < 1500, '总时限到了不重试')
}

// ── P2-5：剩余总时限不够跑完一次加长重试就不开始，保留已写出的部分，报一句白话 ──
{
  const enc = new TextEncoder()
  const calls = []
  const slowLength = async (url, init) => {
    calls.push(JSON.parse(init.body))
    await new Promise(r => setTimeout(r, 120))   // 第一次写了 120 毫秒，被截断
    return new Response(new ReadableStream({ start(c) { for (const s of sseOk('', '写了一半', 'length').sse) c.enqueue(enc.encode(s)); c.close() } }), { status: 200 })
  }
  // 总时限 300 毫秒：剩下约 180 毫秒 < 上一次用时的 2 倍（240）→ 不开始
  const e = await fail(chat({ ...base, fetchImpl: slowLength, maxTokens: 8192, escalateOnLength: { ceiling: 65536 }, maxTotalMs: 300, maxRetries: 0 }))
  assert.equal(e.code, 'truncated'); assert.equal(calls.length, 1, '没有开始加长重试'); assert.equal(e.partial, '写了一半', '已写出的部分保留')
  assert.match(e.detail, /不够再加长重试/)
  assert.match(friendlyAiError(e).message, /剩下的时间也不够再自动加长重试/)
  // 时间充裕：照常加长重试
  const calls2 = []
  const ok = async (url, init) => { calls2.push(JSON.parse(init.body)); const sse = calls2.length === 1 ? sseOk('', '半截', 'length').sse : sseOk('', '完整').sse; return new Response(new ReadableStream({ start(c) { for (const s of sse) c.enqueue(enc.encode(s)); c.close() } }), { status: 200 }) }
  const r = await chat({ ...base, fetchImpl: ok, maxTokens: 8192, escalateOnLength: { ceiling: 65536 }, maxTotalMs: 60_000 })
  assert.equal(r.content, '完整'); assert.equal(r.escalated, true)
}

// ── 模型档案 / 默认输出上限 ──
assert.deepEqual(modelProfile('deepseek-v4-pro'), { reasoning: true, defaultMaxTokens: 32768, ceiling: 65536 })
assert.equal(modelProfile('DeepSeek-Reasoner').reasoning, true, '名字里有 reason 的按推理模型')
assert.equal(modelProfile('my-r1-distill').reasoning, true)
assert.deepEqual(modelProfile('qwen-plus'), { reasoning: false, defaultMaxTokens: 8192, ceiling: 8192 })
assert.deepEqual(modelProfile('some-unknown-model'), { reasoning: false, defaultMaxTokens: 8192, ceiling: 8192 }, '没见过的模型保持 8192，不乱加大')
assert.deepEqual(effectiveMaxTokens({ max_tokens: 8192, max_tokens_auto: true }, 'deepseek-v4-pro'), { maxTokens: 32768, ceiling: 65536, auto: true, fallback: 8192 })
assert.deepEqual(effectiveMaxTokens({ max_tokens: 8192 }, 'deepseek-v4-pro').maxTokens, 32768, '没有 max_tokens_auto 字段 = 自动')
assert.deepEqual(effectiveMaxTokens({ max_tokens: 16384, max_tokens_auto: false }, 'deepseek-v4-pro'), { maxTokens: 16384, ceiling: 16384, auto: false, fallback: undefined }, '手填的照用，永远不翻倍、不降级（ceiling = 手填值）')
assert.deepEqual(effectiveMaxTokens({ max_tokens: 100000, max_tokens_auto: false }, 'qwen-plus'), { maxTokens: 100000, ceiling: 100000, auto: false, fallback: undefined }, '管理员手填超过天花板，以手填为准')
assert.equal(effectiveMaxTokens({ max_tokens: 8192, max_tokens_auto: true }, 'qwen-plus').fallback, undefined, '本来就是 8192 的模型没有更小的安全值可降')
for (const p of PROVIDER_PRESETS) for (const m of p.models) { const pr = modelProfile(m); assert.ok(pr.defaultMaxTokens <= pr.ceiling, `${m}：默认值不超过天花板`) }

// ── 白话报错：不出现 token / 输出上限 / HTTP 之类的词，技术细节在 detail ──
{
  const t = new AiError('truncated', '模型输出被长度上限截断（内容太多）', null, 'finish_reason=length；max_tokens=32768')
  const f = friendlyAiError(t)
  assert.equal(f.message, `AI 这次没写完，已经自动重试过；${RETRY_HINT}`)
  assert.match(f.message, /AI 这次没写完，已经自动重试过；可以点「重试」，多次失败请联系管理员/)
  assert.match(f.detail, /max_tokens=32768/)
  for (const code of ['truncated', 'empty', 'timeout', 'network', 'server', 'rate_limit', 'auth', 'not_found', 'bad_request']) {
    const m = friendlyAiError(new AiError(code, '内部原因 HTTP 429 token', 429, 'raw')).message
    assert.ok(!/token|tokens|输出上限|输出长度|HTTP|\d{3}/i.test(m), `${code}：白话报错里不能出现技术词：${m}`)
  }
  assert.equal(friendlyAiError(new Error('boom')).detail, 'boom')
}
console.log('ai-reasoning.test ✓')
