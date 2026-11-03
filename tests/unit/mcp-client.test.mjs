import assert from 'node:assert/strict'
import path from 'node:path'
import { McpClient, withMcp, decodeLines, encodeMessage, buildEnv, mcpToolName, closeAllMcp } from '../../src/main/connectors/mcp-client.ts'

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

await assert.rejects(withMcp({ command: '/no/such/cmd-xyz' }, c => c.listTools()), /没能启动|已退出/)
await assert.rejects(withMcp({ command: process.execPath, args: ['-e', 'process.exit(3)'] }, c => c.listTools()), /已退出/)

// 应用退出时关闭
const c = new McpClient(spec)
await c.start()
const pid2 = c.proc.pid
closeAllMcp()
await sleep(500)
assert.equal(alive(pid2), false)
console.log('mcp-client.test ✓')
