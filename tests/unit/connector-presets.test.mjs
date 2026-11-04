import assert from 'node:assert/strict'
import { MCP_PRESETS, getPreset, validatePresetValues, buildPresetConfig, validateCustom, buildCustomConfig, parsePairs, isHttpUrl } from '../../src/shared/connector-presets.ts'
import { McpConfigSchema, mcpSummary } from '../../src/main/connectors/mcp-config.ts'

// 目录本身：编号唯一、有说明和文档链接、字段齐全
assert.ok(MCP_PRESETS.length >= 6)
assert.equal(new Set(MCP_PRESETS.map(p => p.id)).size, MCP_PRESETS.length)
for (const p of MCP_PRESETS) {
  assert.ok(p.name && p.desc && p.icon, p.id)
  assert.match(p.docs, /^https:\/\//, p.id + ' 文档链接')
  assert.ok(['official', 'confirm'].includes(p.confidence))
  if (p.transport.kind === 'stdio') { assert.ok(p.transport.command && p.transport.args.length >= 0) }
  // 凡标了 secret 的字段只能落到加密保存的位置
  for (const f of p.fields) if (f.secret) assert.ok(['env', 'header', 'secretArg', 'url'].includes(f.target), `${p.id}.${f.key} 密钥字段落点`)
}
assert.ok(getPreset('feishu') && getPreset('github') && getPreset('nope') === undefined)

// 飞书：App ID 明文参数，App Secret 进 secretArgs
const feishu = getPreset('feishu')
assert.deepEqual(validatePresetValues(feishu, { appId: 'cli_a', appSecret: '' }), { ok: false, error: '请填写「App Secret」', field: 'appSecret' })
assert.equal(validatePresetValues(feishu, { appId: 'cli_a1', appSecret: 'sec123456' }).ok, true)
const fc = buildPresetConfig(feishu, { appId: ' cli_a1 ', appSecret: 'sec123456' })
assert.deepEqual(fc.args, ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_a1'])
assert.deepEqual(fc.secretArgs, ['-s', 'sec123456'])
assert.ok(!fc.args.includes('sec123456'), '密钥不在明文参数里')
assert.equal(fc.command, 'npx'); assert.equal(fc.preset, 'feishu')
assert.ok(buildPresetConfig(getPreset('lark'), { appId: 'a', appSecret: 'b' }).args.includes('https://open.larksuite.com'))

// GitHub：网址固定，令牌进 Authorization 请求头
const gh = getPreset('github')
const gc = buildPresetConfig(gh, { token: 'ghp_abcdef' })
assert.equal(gc.transport, 'http'); assert.equal(gc.url, 'https://api.githubcopilot.com/mcp/')
assert.deepEqual(gc.headers, { Authorization: 'Bearer ghp_abcdef' })
assert.equal(validatePresetValues(gh, {}).ok, false)
assert.equal(validatePresetValues(gh, { token: 'a\nb' }).ok, false, '请求头值不能换行')

// 钉钉：整条网址是密钥
const dt = getPreset('dingtalk')
assert.equal(validatePresetValues(dt, { url: 'not a url' }).ok, false)
assert.equal(validatePresetValues(dt, { url: 'ftp://x.y/z' }).ok, false)
assert.equal(buildPresetConfig(dt, { url: 'https://mcp.example.com/server?key=abc' }).url, 'https://mcp.example.com/server?key=abc')

// 文件夹：要完整路径；不能伪装成命令行参数
const fs_ = getPreset('filesystem')
assert.equal(validatePresetValues(fs_, { folder: 'Documents' }).ok, false)
assert.equal(validatePresetValues(fs_, { folder: '--root' }).ok, false)
assert.equal(validatePresetValues(fs_, { folder: '/Users/a/试卷' }).ok, true)
assert.equal(validatePresetValues(fs_, { folder: 'D:\\试卷' }).ok, true)
assert.deepEqual(buildPresetConfig(fs_, { folder: '/Users/a/试卷' }).args.slice(-1), ['/Users/a/试卷'])
// Notion：令牌进环境变量；无字段的预设（网页抓取）直接可用
assert.deepEqual(buildPresetConfig(getPreset('notion'), { token: 'ntn_x1234' }).env, { NOTION_TOKEN: 'ntn_x1234' })
assert.equal(validatePresetValues(getPreset('fetch'), {}).ok, true)
assert.equal(buildPresetConfig(getPreset('fetch'), {}).command, 'uvx')

// 所有预设生成的配置都能通过主进程的配置校验，且摘要里没有密钥
const samples = { appId: 'cli_a1', appSecret: 'SECRETVALUE1', token: 'TOKENVALUE1', url: 'https://mcp.example.com/s?key=URLSECRET1', folder: '/Users/a/b' }
for (const p of MCP_PRESETS) {
  assert.equal(validatePresetValues(p, samples).ok, true, p.id)
  const parsed = McpConfigSchema.safeParse(buildPresetConfig(p, samples))
  assert.ok(parsed.success, p.id + ' ' + (parsed.error && parsed.error.issues[0].message))
  const sum = mcpSummary(parsed.data)
  assert.ok(!/SECRETVALUE1|TOKENVALUE1|URLSECRET1/.test(sum), `${p.id} 摘要不含密钥：${sum}`)
}

// 自定义：本地命令 / 网址
assert.deepEqual(parsePairs('A=1\n bad line\nB = x=y \n=3', '='), { A: '1', B: 'x=y' })
assert.deepEqual(parsePairs('Authorization: Bearer abc\nX-Api-Key:k1', ':'), { Authorization: 'Bearer abc', 'X-Api-Key': 'k1' })
const base = { mode: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' }
assert.equal(validateCustom(base).ok, false)
assert.deepEqual(buildCustomConfig({ ...base, command: ' npx ', argsText: '-y\n\n pkg ', envText: 'K=v' }), { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } })
assert.equal(validateCustom({ ...base, mode: 'http', url: '' }).ok, false)
assert.equal(validateCustom({ ...base, mode: 'http', url: 'example.com/mcp' }).ok, false)
assert.equal(validateCustom({ ...base, mode: 'http', url: 'https://example.com/mcp', headersText: 'oops' }).ok, false)
assert.equal(validateCustom({ ...base, mode: 'http', url: 'https://example.com/mcp', headersText: 'Authorization: Bearer x' }).ok, true)
assert.deepEqual(buildCustomConfig({ ...base, mode: 'http', url: ' https://example.com/mcp ', headersText: 'Authorization: Bearer x' }), { transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } })
assert.ok(isHttpUrl('http://localhost:3000/x') && !isHttpUrl('javascript:alert(1)'))

// 主进程配置校验：旧配置（无 transport）仍是本地命令；网址方式必须是 http(s)；请求头不能注入换行
assert.equal(McpConfigSchema.parse({ command: 'npx', args: ['-y', 'x'] }).transport, 'stdio')
assert.equal(McpConfigSchema.safeParse({ transport: 'stdio' }).success, false)
assert.equal(McpConfigSchema.safeParse({ transport: 'http', url: 'file:///etc/passwd' }).success, false)
assert.equal(McpConfigSchema.safeParse({ transport: 'http', url: 'https://a.example/mcp', headers: { 'X\r\nEvil': 'v' } }).success, false)
assert.equal(McpConfigSchema.safeParse({ transport: 'http', url: 'https://a.example/mcp', headers: { A: 'v\r\nEvil: 1' } }).success, false)
assert.equal(mcpSummary({ transport: 'http', url: 'https://a.example/path/secret?k=1' }), 'https://a.example/…')

console.log('connector-presets.test ✓')
