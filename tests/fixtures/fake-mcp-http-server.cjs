// 测试用假 MCP 服务器（网址方式）。require 后调用 startFakeMcpHttp({ mode, token })。
// mode: 'json'（POST 直接回 JSON，带 Mcp-Session-Id）| 'sse'（POST 回 text/event-stream）| 'legacy'（旧版 GET /sse + POST /messages）
// token：要求请求头 Authorization: Bearer <token>，不对返回 401。requests 记录收到的每个请求（供断言请求头）。
const http = require('node:http')

const TOOLS = [
  { name: 'echo', description: '原样返回文字', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'post_message', description: '发消息到外部', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
]

function reply(m) {
  if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '0' } } }
  if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } }
  if (m.method === 'tools/call') {
    const a = (m.params && m.params.arguments) || {}
    if (m.params.name === 'echo') return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + a.text }] } }
    if (m.params.name === 'add') return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } }
    if (m.params.name === 'post_message') return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'posted:' + a.text }] } }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } }
  }
  return m.id != null ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } } : null
}

function startFakeMcpHttp({ mode = 'json', token = '' } = {}) {
  const requests = []
  const legacyStreams = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('unauthorized: bad token'); return }
      if (mode === 'legacy') {
        if (req.method === 'GET' && req.url.startsWith('/sse')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write('event: endpoint\ndata: /messages?session=abc\n\n')
          legacyStreams.push(res)
          return
        }
        if (req.method === 'POST' && req.url.startsWith('/messages')) {
          const m = JSON.parse(body)
          const r = reply(m)
          res.statusCode = 202; res.end('Accepted')
          if (r) for (const s of legacyStreams) s.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`)
          return
        }
        res.statusCode = 404; res.end('not found'); return
      }
      if (req.method === 'DELETE') { res.statusCode = 200; res.end(); return }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      const m = JSON.parse(body)
      const r = reply(m)
      if (!r) { res.statusCode = 202; res.end(); return }
      const headers = { 'mcp-session-id': 'sess-fake-1' }
      if (mode === 'sse') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' })
        res.write(': keepalive\n\n')
        res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`)
        res.end()
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' })
        res.end(JSON.stringify(r))
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({
      server, port, requests, url: `http://127.0.0.1:${port}/mcp`, legacyUrl: `http://127.0.0.1:${port}/sse`,
      close: () => new Promise(r => { for (const s of legacyStreams) s.end(); server.closeAllConnections?.(); server.close(() => r()) })
    })
  }))
}

module.exports = { startFakeMcpHttp }
if (require.main === module) startFakeMcpHttp({ mode: process.env.FAKE_MCP_MODE || 'json', token: process.env.FAKE_MCP_TOKEN || '' }).then(f => console.log(f.url))
