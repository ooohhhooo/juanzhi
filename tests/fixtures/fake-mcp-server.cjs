#!/usr/bin/env node
// 测试用假 MCP 服务器（stdio，按行 JSON-RPC）。环境变量 FAKE_MCP_MODE=hang 时 tools/call 永不回应。
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = m => process.stdout.write(JSON.stringify(m) + '\n')
const TOOLS = [
  { name: 'echo', description: '原样返回文字', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
]
process.stderr.write('fake-mcp started\n')
rl.on('line', line => {
  let m; try { m = JSON.parse(line) } catch { process.stdout.write('not json log line\n'); return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } })
  else if (m.method === 'tools/list') {
    if (m.params && m.params.cursor === 'p2') send({ jsonrpc: '2.0', id: m.id, result: { tools: [TOOLS[1]] } })
    else send({ jsonrpc: '2.0', id: m.id, result: { tools: [TOOLS[0]], nextCursor: 'p2' } })
  } else if (m.method === 'tools/call') {
    if (process.env.FAKE_MCP_MODE === 'hang') return
    const a = m.params.arguments || {}
    if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + a.text + ':' + (process.env.FAKE_SECRET || '') }] } })
    else if (m.params.name === 'add') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } })
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } })
  } else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } })
})
rl.on('close', () => process.exit(0))
