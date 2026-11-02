// M9 D1：HTTP 403 与 401 分开；测试结果的白话解释；视觉测试图与判定；设置里模型拆分的迁移；拆题模型建议规则。直接加载 TS 源文件。
import assert from 'node:assert/strict'
import { AiError, chat, statusError, FORBIDDEN_STEPS } from '../../src/main/ai/client.ts'
import { friendlyAiError } from '../../src/main/ai/friendly.ts'
import { explainTestError, judgeVisionAnswer } from '../../src/main/ai/test-rules.ts'
import { makeTextPng } from '../../src/main/ai/png.ts'
import { AiConfigSchema, DEFAULT_AI_CONFIG, parseModelOf } from '../../src/main/ai/types.ts'
import { judgeModelHint, median } from '../../src/main/parse/model-hint.ts'

// ───────── 403：不再和 401 混成一句 ─────────
{
  const e403 = statusError(403, '{"error":{"message":"no access to model deepseek-flash"}}', 'sk-secret-123456', 'deepseek-flash')
  assert.equal(e403.code, 'forbidden')
  assert.equal(e403.status, 403)
  assert.match(e403.message, /这个密钥没有权限使用这个模型（deepseek-flash）/)
  const e401 = statusError(401, 'bad key', 'sk-secret-123456', 'm')
  assert.equal(e401.code, 'auth')
  assert.match(e401.message, /API Key 无效/)
  assert.ok(!/没有权限/.test(e401.message), '401 不说权限')
  // 服务商把密钥回显进 403 的响应里：展示给用户 / 写库的详情要脱敏
  const echo = statusError(403, 'denied for key sk-secret-123456 on model x', 'sk-secret-123456', 'x')
  assert.ok(!echo.detail.includes('sk-secret-123456'), '详情里没有密钥')
}
// 走真实的 chat：403 不重试，抛 forbidden
{
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response('{"error":"forbidden"}', { status: 403 }) }
  await assert.rejects(chat({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'vision-x', messages: [{ role: 'user', content: 'hi' }], fetchImpl, maxRetries: 3, backoffMs: 1 }),
    e => e instanceof AiError && e.code === 'forbidden' && /vision-x/.test(e.message))
  assert.equal(calls, 1, '403 不该重试')
}
// 白话解释：403 有「怎么办」几步；404 / 401 / 429 各有各的话；429 区分额度和太快
{
  const x = explainTestError(new AiError('forbidden', 'x', 403, 'raw body'), 'qwen3-vl-plus')
  assert.equal(x.message, '这个密钥没有权限使用这个模型（qwen3-vl-plus）')
  assert.deepEqual(x.steps, FORBIDDEN_STEPS)
  assert.ok(x.steps.length >= 3 && x.steps.some(s => /开通/.test(s)) && x.steps.some(s => /换/.test(s)))
  assert.equal(x.detail, 'raw body')
  assert.match(explainTestError(new AiError('not_found', 'x', 404, ''), 'm1').message, /找不到这个模型（m1）/)
  assert.match(explainTestError(new AiError('auth', 'x', 401, ''), 'm1').message, /API Key 无效/)
  assert.match(explainTestError(new AiError('rate_limit', 'x', 429, 'insufficient balance'), 'm').message, /额度/)
  assert.match(explainTestError(new AiError('rate_limit', 'x', 429, 'too many requests per minute'), 'm').message, /太频繁/)
  const both = explainTestError(new AiError('rate_limit', 'x', 429, 'something'), 'm').message
  assert.ok(/限流/.test(both) && /额度/.test(both), '判断不了就两种都说')
}
// 白话报错里 forbidden 不出现技术词
{
  const m = friendlyAiError(new AiError('forbidden', '内部原因 HTTP 403 token', 403, 'raw')).message
  assert.match(m, /没有权限/)
  assert.ok(!/token|tokens|HTTP|\d{3}/i.test(m), m)
}

// ───────── 视觉测试：点阵图 + 判定 ─────────
{
  const png = makeTextPng('7K', 64, 5)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64)
  assert.ok(png.length > 100, '不是空图')
  assert.notDeepEqual(makeTextPng('7K'), makeTextPng('7'), '字不同图就不同')
  assert.deepEqual(makeTextPng('7K'), makeTextPng('7K'), '同样的字图是稳定的')
  assert.ok(judgeVisionAnswer('{"text":"7K"}').sees)
  assert.ok(judgeVisionAnswer('{"text":"7 k"}').sees, '大小写、空格不挑')
  assert.ok(judgeVisionAnswer('图上是 7 和 K').sees, '模型没按 JSON 回也认')
  assert.equal(judgeVisionAnswer('{"ok":true}').sees, false, '只回连通成功不算会看图')
  assert.equal(judgeVisionAnswer('{"text":"hello"}').sees, false)
}

// ───────── 模型拆分：旧配置（只有一个 model）原样可用，两个模型默认相同 ─────────
{
  const old = { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-pro', vision_model: 'deepseek-flash', concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 32768, max_tokens_auto: true }
  const r = AiConfigSchema.safeParse({ ...DEFAULT_AI_CONFIG, ...old })
  assert.ok(r.success)
  assert.equal(r.data.parse_model, '', '旧配置没有拆题模型：空 = 和写报告的模型一样')
  assert.equal(parseModelOf(r.data), 'deepseek-v4-pro', '拆题用的就是原来那个模型，行为和 1.2.1 完全一致')
  assert.equal(r.data.vision_policy, 'auto'); assert.equal(r.data.vision_base_url, '')
  // 没有任何新字段的原始旧 JSON（不套默认值）也能读
  const bare = AiConfigSchema.safeParse(old)
  assert.ok(bare.success, '旧 JSON 缺新字段也通过校验（字段都有默认值）')
  assert.equal(parseModelOf({ model: 'a', parse_model: '  ' }), 'a')
  assert.equal(parseModelOf({ model: 'a', parse_model: 'b' }), 'b')
  // 同时解析的试卷数上限从 4 提到 16
  assert.ok(AiConfigSchema.safeParse({ ...r.data, concurrency: 16 }).success)
  assert.ok(!AiConfigSchema.safeParse({ ...r.data, concurrency: 17 }).success)
  assert.ok(!AiConfigSchema.safeParse({ ...r.data, concurrency: 0 }).success)
  assert.ok(!AiConfigSchema.safeParse({ ...r.data, vision_policy: 'sometimes' }).success)
}

// ───────── 拆题模型反复写不完：只提示、不自动切换 ─────────
{
  const b = (truncated, ms = 40_000) => ({ truncated, escalated: 0, ms })
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null)
  // 9 批不触发（哪怕全是截断）
  assert.equal(judgeModelHint(Array.from({ length: 9 }, () => b(1))).suggest, false)
  // 10 批里 2 个不触发，3 个触发
  assert.equal(judgeModelHint([b(1), b(1), ...Array.from({ length: 8 }, () => b(0))]).suggest, false)
  const three = judgeModelHint([b(1), b(0), b(1), b(0), b(0), b(1), b(0), b(0), b(0), b(0)])
  assert.ok(three.suggest && three.reason === 'retries' && three.retried === 3 && three.total === 10)
  // 加长重试也算
  assert.ok(judgeModelHint([{ truncated: 0, escalated: 1, ms: 1 }, { truncated: 0, escalated: 1, ms: 1 }, { truncated: 0, escalated: 1, ms: 1 }, ...Array.from({ length: 7 }, () => b(0, 1))]).suggest)
  // 只看最近 10 批：更早的截断不算
  assert.equal(judgeModelHint([...Array.from({ length: 10 }, () => b(0)), b(1), b(1), b(1)]).suggest, false)
  // 慢：耗时中位数 > 90 秒
  const slow = judgeModelHint(Array.from({ length: 10 }, () => b(0, 120_000)))
  assert.ok(slow.suggest && slow.reason === 'slow')
  assert.equal(judgeModelHint(Array.from({ length: 10 }, () => b(0, 60_000))).suggest, false)
}
console.log('ai-forbidden.test ✓')
