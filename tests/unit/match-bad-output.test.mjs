// 匹配回答解析失败：独立错误码 bad_output 的白话 + 解析器对无效回答给出 problems（runMatch 据此自动重试一次）
import assert from 'node:assert/strict'
import { AiError } from '../../src/main/ai/client.ts'
import { friendlyAiError } from '../../src/main/ai/friendly.ts'
import { parseLessonResponse as parseMatchResponse } from '../../src/main/course/match.ts'

const e = new AiError('bad_output', 'AI 的回答解析失败', null, '解析问题：AI 的回答不是有效的 JSON')
const f = friendlyAiError(e)
assert.match(f.message, /回答格式不对/); assert.doesNotMatch(f.message, /拒绝/)
assert.match(f.detail, /bad_output/); assert.match(f.detail, /不是有效的 JSON/)
assert.match(friendlyAiError(new AiError('bad_request', 'x')).message, /拒绝/, 'bad_request 仍是原文案')

const ctx = { tokens: new Map([['K1', 'GR.A']]), lessons: new Map([[1, { searchText: 'abc' }]]) }
const bad = parseMatchResponse('抱歉，我无法完成', ctx)
assert.equal(bad.entries.length, 0); assert.ok(bad.problems.length > 0, '无效回答要给 problems（触发重试）')
const ok = parseMatchResponse('{"results":[{"lesson":"#1","kps":[]}]}', ctx)
assert.equal(ok.entries.length, 1); assert.equal(ok.problems.length, 0)

// 重试语义（与 runMatch 内循环一致）：第一次无效、第二次有效 → 采用第二次；两次都无效 → 失败
const run = replies => { let p; let calls = 0; for (let a = 1; a <= 2; a++) { p = parseMatchResponse(replies[calls++], ctx); if (p.entries.length || !p.problems.length) break } return { p, calls } }
assert.equal(run(['乱码', '{"results":[{"lesson":"#1","kps":[]}]}']).calls, 2)
assert.equal(run(['乱码', '{"results":[{"lesson":"#1","kps":[]}]}']).p.entries.length, 1)
const both = run(['乱码', '还是乱码']); assert.equal(both.calls, 2); assert.equal(both.p.entries.length, 0)
console.log('match-bad-output ok')

// 402 / 余额不足：独立 code balance，白话文案，不自动重试
{
  const { statusError } = await import('../../src/main/ai/client.ts')
  const { explainTestError } = await import('../../src/main/ai/test-rules.ts')
  const e402 = statusError(402, '{"error":{"message":"Insufficient Balance"}}')
  assert.equal(e402.code, 'balance')
  assert.match(friendlyAiError(e402).message, /余额不足.*充值/); assert.doesNotMatch(friendlyAiError(e402).message, /拒绝/)
  assert.equal(statusError(400, '{"error":"insufficient balance"}').code, 'balance')
  assert.equal(statusError(400, '账户余额不足').code, 'balance')
  assert.equal(statusError(400, '{"error":"bad param"}').code, 'bad_request')
  assert.match(explainTestError(e402, 'm').message, /余额不足/)
}
console.log('balance ok')
