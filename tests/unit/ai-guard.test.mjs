// 服务地址/密钥守卫的纯函数、测试图生成
import assert from 'node:assert/strict'
import { originOf, isHttpUrl, sameServer, isPlainHttpRemote, redact } from '../../src/main/ai/guard.ts'
import { makeSolidPng } from '../../src/main/ai/png.ts'

assert.equal(originOf('https://api.deepseek.com/v1/x'), 'https://api.deepseek.com')
assert.equal(originOf('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080')
assert.equal(originOf('ftp://x'), null)
assert.equal(originOf(''), null)
assert.equal(originOf('not a url'), null)
assert.equal(isHttpUrl('https://a.com'), true)
assert.equal(isHttpUrl('javascript:alert(1)'), false)

// 同一服务：origin 相同（路径可不同）；任何一边为空/非法都不算同一服务——「已存地址为空」不能成为绕过守卫的缝（审核 P1-5）
assert.equal(sameServer('https://api.deepseek.com', 'https://api.deepseek.com/v1'), true)
assert.equal(sameServer('https://api.deepseek.com', 'https://evil.example.com'), false)
assert.equal(sameServer('https://a.com', 'http://a.com'), false, '协议不同')
assert.equal(sameServer('https://a.com', 'https://a.com:8443'), false, '端口不同')
assert.equal(sameServer('', 'https://evil.example.com'), false, '已存地址为空 → 不放行')
assert.equal(sameServer('https://a.com', ''), false)
assert.equal(sameServer('', ''), false)
assert.equal(sameServer('garbage', 'garbage'), false)

assert.equal(isPlainHttpRemote('http://api.example.com/v1'), true)
assert.equal(isPlainHttpRemote('http://localhost:11434/v1'), false)
assert.equal(isPlainHttpRemote('http://127.0.0.1:18080/v1'), false)
assert.equal(isPlainHttpRemote('https://api.example.com'), false)

// 脱敏：已知密钥、sk- 前缀、Bearer
const secret = 'my-secret-key-123456'
assert.ok(!redact(`bad key ${secret} here`, [secret]).includes(secret))
assert.ok(!redact('Incorrect API key provided: sk-abcdef1234567890abcd.').includes('sk-abcdef'))
assert.ok(!redact('Authorization: Bearer abcdefghijklmnop12345').includes('abcdefghijklmnop'))
assert.equal(redact('普通错误信息：模型不存在'), '普通错误信息：模型不存在')

// 测试图：合法 PNG，尺寸 128×128（1×1 会被部分服务商拒收）
const png = makeSolidPng(128, 128)
assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
assert.equal(png.readUInt32BE(16), 128)
assert.equal(png.readUInt32BE(20), 128)
assert.ok(png.length < 2000, `体积小：${png.length}`)

// 复审 N2：豆包的推理接入点 ID（ep-…）是模型名，不是密钥，脱敏不能把它藏起来
assert.equal(redact('The model `ep-20250101123456-abcde` does not exist'), 'The model `ep-20250101123456-abcde` does not exist')
// 先脱敏再截断的前提：长文本里的密钥整段被替换（截断由调用方在脱敏之后做）
const longBody = 'x'.repeat(289) + ' sk-' + 'a1b2c3d4e5f6'.repeat(3) + ' tail'
const red = redact(longBody)
assert.ok(!/sk-a1b2/.test(red) && !red.includes('a1b2c3d4e5f6'))
assert.ok(!red.slice(0, 300).includes('a1b2'), '在第 300 个字符处截断后也看不到密钥的任何一段')

console.log('ai-guard.test ✓')
