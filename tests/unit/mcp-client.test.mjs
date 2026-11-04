import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { McpClient, McpHttpClient, parseSseEvents, withMcp, decodeLines, encodeMessage, buildEnv, mcpToolName, closeAllMcp } from '../../src/main/connectors/mcp-client.ts'

assert.equal(encodeMessage({ a: 1 }), '{"a":1}\n')
const d = decodeLines('{"id":1}\nlog line\n{"id":2}\n{"id"')
assert.deepEqual(d.messages, [{ id: 1 }, { id: 2 }])
assert.equal(d.rest, '{"id"')
assert.equal(buildEnv({ A: '1' }, { PATH: '/bin', SECRET_TOKEN: 'x' }).SECRET_TOKEN, undefined)
assert.equal(buildEnv({ A: '1' }, { PATH: '/bin' }).A, '1')
assert.equal(mcpToolName('我的笔记', 'do-it', 's1ab'), 'mcp_s1ab_do_it')
assert.equal(mcpToolName('Notes Tool', 'add', 'x'), 'mcp_notes_tool_add')

const fake = path.resolve('tests/fixtures/fake-mcp-server.cjs')
const spec = { command: process.execPath, args: [fake], env: { FAKE_SECRET: 'topsecret99' } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const tools = await withMcp(spec, c => c.listTools())
assert.deepEqual(tools.map(t => t.name), ['echo', 'add'], '分页拿全')
const r = await withMcp(spec, async c => ({ e: await c.callTool('echo', { text: 'hi' }), a: await c.callTool('add', { a: 2, b: 3 }) }))
assert.equal(r.e.text, 'echo:hi:topsecret99')
assert.equal(r.a.text, '5')

await assert.rejects(withMcp(spec, c => c.callTool('nope', {})), /unknown tool/)

// 超时 + 清理
let pid
const t0 = Date.now()
await assert.rejects(withMcp({ ...spec, env: { FAKE_MCP_MODE: 'hang' } }, async c => { pid = c.proc.pid; return c.callTool('echo', {}, 400) }), /超时/)
assert.ok(Date.now() - t0 < 5000)
await sleep(500)
assert.equal(alive(pid), false, '超时后子进程已被清理')

await assert.rejects(withMcp({ command: '/no/such/cmd-xyz' }, c => c.listTools()), /没能启动|已退出|找不到命令/)
await assert.rejects(withMcp({ command: process.execPath, args: ['-e', 'process.exit(3)'] }, c => c.listTools()), /已退出/)

// 应用退出时关闭
const c = new McpClient(spec)
await c.start()
const pid2 = c.proc.pid
closeAllMcp()
await sleep(500)
assert.equal(alive(pid2), false)
// slug 后重名：加连接 id 前几位，再重就加序号
{
  const { uniqueToolName } = await import('../../src/main/connectors/mcp-client.ts')
  assert.equal(mcpToolName('a-b', 'x', 's'), mcpToolName('a_b', 'x', 's'), '前提：两个不同的服务器名 slug 后撞名')
  const used = new Set()
  const n1 = uniqueToolName(mcpToolName('a-b', 'x', 's'), 'aaaa1111', used)
  const n2 = uniqueToolName(mcpToolName('a_b', 'x', 's'), 'bbbb2222', used)
  const n3 = uniqueToolName(mcpToolName('a b', 'x', 's'), 'bbbb2222', used)
  assert.equal(new Set([n1, n2, n3]).size, 3, [n1, n2, n3].join(','))
  assert.equal(n1, 'mcp_a_b_x'); assert.equal(n2, 'mcp_a_b_x_bbbb'); assert.equal(n3, 'mcp_a_b_x_2')
}

// ── 网址方式：Streamable HTTP（JSON / SSE 回复）+ 旧版 HTTP+SSE 回退 ──
{
  const { startFakeMcpHttp } = createRequire(import.meta.url)('../fixtures/fake-mcp-http-server.cjs')
  // SSE 解析
  const ev = parseSseEvents(': ping\r\n\r\nevent: endpoint\r\ndata: /m?x=1\r\n\r\ndata: {"a":1}\ndata: {"b":2}\n\nevent: half')
  assert.deepEqual(ev.events, [{ event: 'endpoint', data: '/m?x=1' }, { event: 'message', data: '{"a":1}\n{"b":2}' }])
  assert.equal(ev.rest, 'event: half')

  for (const mode of ['json', 'sse']) {
    const f = await startFakeMcpHttp({ mode, token: 'tok-secret-123' })
    const hspec = { url: f.url, headers: { Authorization: 'Bearer tok-secret-123' } }
    const hTools = await withMcp(hspec, c => c.listTools())
    assert.deepEqual(hTools.map(t => t.name), ['echo', 'add', 'post_message'], mode)
    assert.equal(hTools[0].readOnly, true, 'readOnlyHint 被读到'); assert.equal(hTools[1].readOnly, undefined)
    const out = await withMcp(hspec, async c => ({ e: await c.callTool('echo', { text: 'hi' }), a: await c.callTool('add', { a: 2, b: 5 }) }))
    assert.equal(out.e.text, 'echo:hi'); assert.equal(out.a.text, '7')
    assert.ok(f.requests.every(r => r.headers.authorization === 'Bearer tok-secret-123'), '每个请求都带 Authorization')
    const post2 = f.requests.filter(r => r.method === 'POST' && r.body.includes('tools/list'))[0]
    assert.equal(post2.headers['mcp-session-id'], 'sess-fake-1', '初始化之后带上会话 id')
    assert.equal(post2.headers['mcp-protocol-version'], '2025-06-18')
    await sleep(100)
    assert.ok(f.requests.some(r => r.method === 'DELETE'), '关闭时通知服务器结束会话')

    // 令牌不对：401，提示认证问题，错误里没有令牌
    let err
    try { await withMcp({ url: f.url, headers: { Authorization: 'Bearer wrong-token-999' } }, c => c.listTools()) } catch (e) { err = e }
    assert.ok(err && /401/.test(err.message) && !/wrong-token-999/.test(err.message), err && err.message)
    // 工具调用报错
    await assert.rejects(withMcp(hspec, c => c.callTool('nope', {})), /unknown tool/)
    await f.close()
  }
  {
    const f = await startFakeMcpHttp({ mode: 'legacy' })
    const lt = await withMcp({ url: f.legacyUrl }, async c => ({ t: await c.listTools(), r: await c.callTool('add', { a: 1, b: 1 }) }))
    assert.equal(lt.t.length, 3); assert.equal(lt.r.text, '2', '旧版 SSE 回退可用')
    await f.close()
  }
  // 连不上：给出域名，不是一串堆栈；网址里的密钥不外泄
  await assert.rejects(withMcp({ url: 'http://127.0.0.1:1/mcp?key=urlsecret-77' }, c => c.listTools()), e => /连不上 127\.0\.0\.1:1/.test(e.message) && !/urlsecret-77/.test(e.message))
  await assert.rejects(withMcp({ url: 'ftp://x.example/mcp' }, c => c.listTools()), /http/)
  // 超时：服务器不回
  {
    const hang = (await import('node:http')).createServer(() => { /* 永不回应 */ })
    await new Promise(r => hang.listen(0, '127.0.0.1', r))
    const t0 = Date.now()
    await assert.rejects(withMcp({ url: `http://127.0.0.1:${hang.address().port}/mcp` }, c => c.listTools(), 400), /超时/)
    assert.ok(Date.now() - t0 < 3000)
    hang.closeAllConnections(); hang.close()
  }
  // stdio 的 secretArgs 拼在 args 后面，并在报错里被遮蔽
  const sa = await withMcp({ command: process.execPath, args: [fake], secretArgs: ['--x', 'argsecret88'] }, c => c.listTools())
  assert.equal(sa.length, 2)
  await assert.rejects(withMcp({ command: process.execPath, args: ['-e', 'console.error("boom argsecret88");process.exit(2)'], secretArgs: ['argsecret88'] }, c => c.listTools()), e => /已退出/.test(e.message) && !/argsecret88/.test(e.message))
}

console.log('mcp-client.test ✓')


// ── 补全 PATH 与「找不到命令」的白话 ──
{
  const { augmentPath, missingCommandHint } = await import('../../src/main/connectors/mcp-client.ts')
  const have = new Set(['/Users/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  const p = augmentPath('/usr/bin:/bin', 'darwin', '/Users/u', d => have.has(d), '/Users/u/.nvm/bin:/usr/bin')
  const parts = p.split(':')
  assert.deepEqual(parts.slice(0, 2), ['/usr/bin', '/bin'], '原来的 PATH 排在前面')
  for (const d of ['/Users/u/.nvm/bin', '/Users/u/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']) assert.ok(parts.includes(d), d)
  assert.ok(!parts.includes('/Users/u/.cargo/bin'), '不存在的目录不加')
  assert.equal(new Set(parts).size, parts.length, '不重复')
  assert.match(missingCommandHint('uvx'), /uv/)
  assert.match(missingCommandHint('npx.cmd'), /Node\.js/)
  assert.match(missingCommandHint('/x/foo'), /找不到命令「\/x\/foo」/)
  // 真的找不到命令：报白话，不是 spawn ENOENT
  const StdioMcpClient = McpClient
  if (StdioMcpClient) {
    const c = new StdioMcpClient({ command: 'uvx-definitely-missing-ewb', args: [] })
    await assert.rejects(() => c.start(3000), /找不到命令/)
  }
  console.log('mcp-client PATH / 缺命令提示 ✓')
}
