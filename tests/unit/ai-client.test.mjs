// AI 客户端：流式/非流式、429/5xx 指数退避、空内容重试、超时、截断、鉴权失败、response_format 回退。
// 用注入的假 fetch 在进程内模拟服务端（不占端口，沙箱里也能跑）；真正走 HTTP 的链路由 E2E 里的 mock 服务覆盖。
import assert from 'node:assert/strict'
import { chat, AiError, chatUrl } from '../../src/main/ai/client.ts'

const ok = (content, extra = {}) => ({
  status: 200, json: { model: 'm1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: extra.finish ?? 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: extra.cached ?? 0 } }
})

/** script: 依次消费的响应；返回 { fetch, calls } */
function fakeFetch(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, auth: init.headers.Authorization, body })
    const step = script.shift() ?? ok('{"ok":true}')
    if (step.hang) {
      await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }
    if (step.throw) throw new Error(step.throw)
    if (step.sse) {
      const enc = new TextEncoder()
      const stream = new ReadableStream({ start(c) { for (const s of step.sse) c.enqueue(enc.encode(s)); c.close() } })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(step.text ?? JSON.stringify(step.json), { status: step.status, headers: step.headers ?? {} })
  }
  return { fetchImpl, calls }
}
const fail = async (p) => { try { await p; return null } catch (e) { return e } }
const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-unit', model: 'm1', messages: [{ role: 'user', content: '请只回复 JSON' }], backoffMs: 5, timeoutMs: 2000 }

assert.equal(chatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions')
assert.equal(chatUrl('https://x/v1/'), 'https://x/v1/chat/completions')
assert.equal(chatUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions')

// 非流式：内容、用量（含缓存命中）、请求体
{
  const { fetchImpl, calls } = fakeFetch([ok('{"ok":true}', { cached: 60 })])
  const r = await chat({ ...base, fetchImpl, jsonMode: true, maxTokens: 100, temperature: 0.1 })
  assert.equal(r.content, '{"ok":true}')
  assert.deepEqual(r.usage, { promptTokens: 100, completionTokens: 10, cachedTokens: 60 })
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(calls[0].auth, 'Bearer sk-unit')
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' })
  assert.equal(calls[0].body.max_tokens, 100)
  assert.equal(calls[0].body.stream, false)
}

// 流式：增量拼起来等于完整内容，用量取自末尾 chunk；半截行跨 chunk 也能拼对
{
  const full = '{"ok":true,"msg":"你好"}'
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
  const chunks = [ev({ choices: [{ delta: { content: full.slice(0, 7) } }] }), ev({ choices: [{ delta: { content: full.slice(7, 15) } }] })]
  const tail = ev({ choices: [{ delta: { content: full.slice(15) }, finish_reason: 'stop' }] }) + ev({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 8 } }) + 'data: [DONE]\n\n'
  const sse = [...chunks, tail.slice(0, 20), tail.slice(20)]
  const { fetchImpl, calls } = fakeFetch([{ sse }])
  const deltas = []
  const r = await chat({ ...base, fetchImpl, stream: true, onDelta: d => deltas.push(d) })
  assert.equal(r.content, full)
  assert.equal(deltas.join(''), full)
  assert.ok(deltas.length >= 3)
  assert.equal(r.usage.promptTokens, 50)
  assert.equal(calls[0].body.stream, true)
}

// 流式：连接被「正常关闭」但既没有 finish_reason 也没有 [DONE] = 半截内容，必须当作中断并重试，不能当成完整结果
{
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
  const part = ev({ choices: [{ delta: { content: '## 一、总体变化\n只写了一半' }, finish_reason: null }] })
  const good = ev({ choices: [{ delta: { content: '完整内容' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
  const { fetchImpl, calls } = fakeFetch([{ sse: [part] }, { sse: [good] }])
  const deltas = []
  const r = await chat({ ...base, fetchImpl, stream: true, onDelta: d => deltas.push(d), maxRetries: 2 })
  assert.equal(r.content, '完整内容', '第一次半截的结果被丢弃，重试后拿到完整内容')
  assert.equal(calls.length, 2)
  assert.equal(r.attempts, 2)
  // 一直半截 → 用完重试次数报「数据流意外结束」，不返回半截内容
  const f2 = fakeFetch(Array.from({ length: 5 }, () => ({ sse: [part] })))
  const e = await fail(chat({ ...base, fetchImpl: f2.fetchImpl, stream: true, maxRetries: 1 }))
  assert.ok(e instanceof AiError && e.code === 'network' && /意外结束/.test(e.message), String(e))
  assert.equal(f2.calls.length, 2)
  // 只有 [DONE] 没有 finish_reason（有的服务商这样）、或只有 finish_reason 没有 [DONE]：都算完整
  const onlyDone = fakeFetch([{ sse: [ev({ choices: [{ delta: { content: 'ok1' } }] }) + 'data: [DONE]\n\n'] }])
  assert.equal((await chat({ ...base, fetchImpl: onlyDone.fetchImpl, stream: true })).content, 'ok1')
  const onlyFinish = fakeFetch([{ sse: [ev({ choices: [{ delta: { content: 'ok2' }, finish_reason: 'stop' }] })] }])
  assert.equal((await chat({ ...base, fetchImpl: onlyFinish.fetchImpl, stream: true })).content, 'ok2')
}

// 流式：最后一行没有结尾换行（`data: [DONE]` 或带 finish_reason 的块）——正常结束，不能被当成中断（复审 P2-N1）
{
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
  const a1 = fakeFetch([{ sse: [ev({ choices: [{ delta: { content: '完整' } }] }), 'data: [DONE]'] }])
  const r1 = await chat({ ...base, fetchImpl: a1.fetchImpl, stream: true })
  assert.equal(r1.content, '完整'); assert.equal(a1.calls.length, 1, '没有重试')
  const a2 = fakeFetch([{ sse: [ev({ choices: [{ delta: { content: '内容A' } }] }), `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] })}`] }])
  const r2 = await chat({ ...base, fetchImpl: a2.fetchImpl, stream: true })
  assert.equal(r2.content, '内容AB'); assert.equal(r2.finishReason, 'stop'); assert.equal(a2.calls.length, 1)
  // 最后一行被切成两个网络包也行
  const a3 = fakeFetch([{ sse: [ev({ choices: [{ delta: { content: 'x' } }] }), 'data: [DO', 'NE]'] }])
  assert.equal((await chat({ ...base, fetchImpl: a3.fetchImpl, stream: true })).content, 'x')
  // 残留的不是结束标记、而只是半截内容的 JSON 行：仍然按「没有结束标记」处理
  const a4 = fakeFetch(Array.from({ length: 3 }, () => ({ sse: [ev({ choices: [{ delta: { content: 'y' } }] }), 'data: {"choices":[{"delta":{"content":"z"'] })))
  const e4 = await fail(chat({ ...base, fetchImpl: a4.fetchImpl, stream: true, maxRetries: 1 }))
  assert.ok(e4 instanceof AiError && /意外结束/.test(e4.message))
}

// 429 → 按 Retry-After 退避后成功；5xx 连续两次，指数退避后成功
{
  const { fetchImpl, calls } = fakeFetch([{ status: 429, text: '{}', headers: { 'Retry-After': '0' } }])
  const r = await chat({ ...base, fetchImpl })
  assert.equal(r.attempts, 2)
  assert.equal(calls.length, 2)
}
{
  const { fetchImpl, calls } = fakeFetch([{ status: 503, text: 'busy' }, { status: 502, text: 'bad gateway' }])
  const r = await chat({ ...base, fetchImpl })
  assert.equal(r.attempts, 3)
  assert.equal(calls.length, 3)
}
// 429 一直不好 → 用完重试次数，给出中文原因
{
  const { fetchImpl, calls } = fakeFetch(Array.from({ length: 10 }, () => ({ status: 429, text: '{}', headers: { 'Retry-After': '0' } })))
  const e = await fail(chat({ ...base, fetchImpl, maxRetries: 2 }))
  assert.ok(e instanceof AiError && e.code === 'rate_limit', String(e))
  assert.match(e.message, /429/)
  assert.equal(calls.length, 3, '首次 + 2 次重试')
}
// 每次调用的 onAttempt 都会回调（含失败的），用于记录用量
{
  const { fetchImpl } = fakeFetch([{ status: 500, text: 'x' }, ok('{"ok":true}')])
  const seen = []
  await chat({ ...base, fetchImpl, onAttempt: a => seen.push([a.attempt, a.ok]) })
  assert.deepEqual(seen, [[1, false], [2, true]])
}

// 401 不重试
{
  const { fetchImpl, calls } = fakeFetch([{ status: 401, text: '{"error":{"message":"invalid"}}' }])
  const e = await fail(chat({ ...base, fetchImpl }))
  assert.ok(e instanceof AiError && e.code === 'auth')
  assert.match(e.message, /API Key 无效/)
  assert.equal(calls.length, 1)
}
{
  const { fetchImpl } = fakeFetch([{ status: 404, text: 'no model' }])
  const e = await fail(chat({ ...base, fetchImpl }))
  assert.equal(e.code, 'not_found')
  assert.match(e.message, /Base URL/)
}

// 空 content：重试一次后成功；两次都空则报 empty
{
  const { fetchImpl, calls } = fakeFetch([ok(''), ok('{"ok":true}')])
  const r = await chat({ ...base, fetchImpl })
  assert.equal(r.content, '{"ok":true}')
  assert.equal(calls.length, 2)
}
{
  const { fetchImpl } = fakeFetch([ok(''), ok('   ')])
  const e = await fail(chat({ ...base, fetchImpl }))
  assert.ok(e instanceof AiError && e.code === 'empty')
  assert.match(e.message, /空内容/)
}

// 被长度截断：不重试，交给上层拆批
{
  const { fetchImpl, calls } = fakeFetch([ok('{"meta":', { finish: 'length' })])
  const e = await fail(chat({ ...base, fetchImpl }))
  assert.ok(e instanceof AiError && e.code === 'truncated')
  assert.equal(calls.length, 1)
}

// 超时：每次都挂起 → 重试用尽后报 timeout
{
  const { fetchImpl, calls } = fakeFetch([{ hang: true }, { hang: true }, { hang: true }])
  const e = await fail(chat({ ...base, fetchImpl, timeoutMs: 80, maxRetries: 1 }))
  assert.ok(e instanceof AiError && e.code === 'timeout', String(e))
  assert.match(e.message, /超时/)
  assert.equal(calls.length, 2)
}

// 服务商不支持 response_format：去掉后重试，且不占重试次数
{
  const { fetchImpl, calls } = fakeFetch([{ status: 400, text: "{\"error\":{\"message\":\"'response_format' is not supported\"}}" }, ok('{"ok":true}')])
  const r = await chat({ ...base, fetchImpl, jsonMode: true, maxRetries: 0 })
  assert.equal(r.content, '{"ok":true}')
  assert.deepEqual(calls.map(c => !!c.body.response_format), [true, false])
}
// 其它 400 直接报错，带服务商给的原因
{
  const { fetchImpl } = fakeFetch([{ status: 400, text: '{"error":{"message":"max_tokens too large"}}' }])
  const e = await fail(chat({ ...base, fetchImpl, maxRetries: 0 }))
  assert.equal(e.code, 'bad_request')
  assert.match(e.message, /max_tokens too large/)
}

// 取消
{
  const { fetchImpl } = fakeFetch([{ hang: true }])
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 50)
  const e = await fail(chat({ ...base, fetchImpl, signal: ctl.signal, timeoutMs: 4000 }))
  assert.ok(e instanceof AiError && e.code === 'aborted', String(e))
}

// 连不上：network，且给出可操作的提示
{
  const { fetchImpl } = fakeFetch([{ throw: 'fetch failed' }])
  const e = await fail(chat({ ...base, fetchImpl, maxRetries: 0 }))
  assert.ok(e instanceof AiError && e.code === 'network')
  assert.match(e.message, /无法连接/)
}


// 不跟随重定向：init.redirect 必须是 'error'（密钥不能被 3xx 带到别处）
{
  let seenInit = null
  const f = async (url, init) => { seenInit = init; return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {} }), { status: 200 }) }
  await chat({ ...base, fetchImpl: f })
  assert.equal(seenInit.redirect, 'error')
}
// 5xx 带 Retry-After 也按它退避（审核 P2-3）；退避起点故意设很大，若没按 Retry-After 走就会超时
{
  const { fetchImpl, calls } = fakeFetch([{ status: 503, text: 'busy', headers: { 'Retry-After': '1' } }])
  const t0 = Date.now()
  const r = await chat({ ...base, fetchImpl, backoffMs: 20000 })
  assert.equal(r.attempts, 2)
  assert.ok(Date.now() - t0 >= 900 && Date.now() - t0 < 5000, `按 Retry-After=1s 等待，实际 ${Date.now() - t0}ms`)
  assert.equal(calls.length, 2)
}
// temperature 被拒（部分思考模型只接受默认值）：去掉后重试，且不占重试次数（审核 P2-4）
{
  const { fetchImpl, calls } = fakeFetch([{ status: 400, text: '{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}' }, ok('{"ok":true}')])
  const r = await chat({ ...base, fetchImpl, temperature: 0.1, maxRetries: 0 })
  assert.equal(r.content, '{"ok":true}')
  assert.deepEqual(calls.map(c => c.body.temperature), [0.1, undefined])
}
// 错误片段脱敏：服务商在 400 里回显密钥时，展示给用户/写库的文本里不能有它（审核 P2-2）
{
  const { fetchImpl } = fakeFetch([{ status: 400, text: '{"error":{"message":"Incorrect API key: sk-unit used for model m1"}}' }])
  const e = await fail(chat({ ...base, fetchImpl, maxRetries: 0 }))
  assert.equal(e.code, 'bad_request')
  assert.ok(!e.message.includes('sk-unit') && !e.detail.includes('sk-unit'), e.message)
  assert.match(e.message, /已隐藏/)
}

// 复审 N2：密钥正好跨在第 300 个字符上，也不能漏出一段前缀
{
  const pad = 'y'.repeat(285)
  const { fetchImpl } = fakeFetch([{ status: 400, text: JSON.stringify({ error: { message: pad + ' key=sk-unit tail' } }) }])
  const e = await fail(chat({ ...base, fetchImpl, maxRetries: 0 }))
  assert.ok(!e.message.includes('sk-un') && !e.detail.includes('sk-un'), '截断点附近的密钥前缀也不能出现：' + e.detail.slice(-40))
}

console.log('ai-client.test ✓')
