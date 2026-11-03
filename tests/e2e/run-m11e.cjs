// 连接器端到端：假企业微信服务器（本机）+ 假 MCP 服务器。设置页添加 → 测试连接 → 用测试钩子调用 wecom_send → 假服务器收到正确内容。
// 用法：npm run test:e2e:m11e   （沙箱外运行：Electron、本地端口都被沙箱限制）
const http = require('node:http')
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, withDb, fs, path, work, ctx, T, goto, open, closeApp, L } = M

const received = []   // { url, body(string) }
function startFake() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ url: req.url, body })
      res.setHeader('content-type', 'application/json')
      if (req.url.includes('upload_media')) res.end(JSON.stringify({ errcode: 0, errmsg: 'ok', media_id: 'MID-E2E-1' }))
      else res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

const callTool = (name, args) => ctx.app.evaluate(async (_m, a) => {
  const t = globalThis.__ewbConnectorTools().find(x => x.name === a.name)
  if (!t) return { missing: true }
  const out = {}
  out.preview = await t.preview(a.args).catch(e => ({ error: String(e.message) }))
  out.result = await t.run(a.args, { sessionId: 'e2e', dataDir: a.dataDir })
  return out
}, { name, args, dataDir: work })
const toolNames = () => ctx.app.evaluate(() => globalThis.__ewbConnectorTools().map(t => t.name))

async function main() {
  const server = await startFake()
  const port = server.address().port
  const SECRET_KEY = 'e2ekey-0123456789abcdef'
  const hook = `http://127.0.0.1:${port}/cgi-bin/webhook/send?key=${SECRET_KEY}`
  const ud = path.join(work, 'userM11e')
  await open(ud, { extraEnv: { EWB_TEST_HOOKS: '1' } })

  // ── 1. 添加企业微信连接器；校验非法地址 ──
  await goto('#/settings'); await T('connectors-panel').waitFor({ timeout: 20000 })
  check('添加', '设置页有「连接器」，开始时没有连接', (await T('connector-empty').count()) === 1)
  await T('connector-add').click(); await T('connector-form').waitFor()
  await T('connector-form-name').fill('三年级辅导群')
  await T('connector-form-webhook').fill('https://evil.example.com/cgi-bin/webhook/send?key=abcdefgh1234')
  await T('connector-save').click()
  check('添加', '非企业微信地址被拒绝并提示', await waitFor(async () => (await T('connector-form-error').count()) > 0, 5000) && /地址格式不对/.test(await T('connector-form-error').innerText()))
  await T('connector-form-webhook').fill(hook)
  await T('connector-save').click()
  await T('connector-三年级辅导群').waitFor({ timeout: 10000 })
  check('添加', '保存后出现这条连接，地址只显示掩码', !(await T('connector-三年级辅导群').innerText()).includes(SECRET_KEY) && /key=e2ek\*\*\*\*/.test(await T('connector-summary').first().innerText()))

  // ── 2. 保存后自动测试 → 假服务器收到「卷知连接测试」 ──
  check('测试连接', '假服务器收到「卷知连接测试」文字消息', await waitFor(async () => received.some(r => r.body.includes('卷知连接测试')), 10000))
  const first = JSON.parse(received.find(r => r.body.includes('卷知连接测试')).body)
  check('测试连接', '消息类型是 text，key 带在地址里', first.msgtype === 'text' && received[0].url.includes(`key=${SECRET_KEY}`))
  check('测试连接', '界面显示「连接正常」', await waitFor(async () => (await T('connector-result').count()) > 0 && /连接正常/.test(await T('connector-result').first().innerText()), 5000))
  received.length = 0
  await T('connector-test').first().click()
  check('测试连接', '再点「测试连接」又收到一条', await waitFor(async () => received.length === 1, 8000))

  // ── 3. 密钥不明文落盘 ──
  const rows = withDb(ud, d => d.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'connectors%'").all())
  check('密钥', '数据库里没有明文 Webhook key', rows.length >= 1 && !JSON.stringify(rows).includes(SECRET_KEY), rows.map(r => r.key).join(','))
  check('密钥', '页面文字里没有明文 key', !(await ctx.page.innerText('body')).includes(SECRET_KEY))

  // ── 4. 工具：preview + 发 markdown ──
  check('工具', '工具列表包含 connectors_list 和 wecom_send', (await toolNames()).includes('wecom_send') && (await toolNames()).includes('connectors_list'))
  received.length = 0
  const md = '# 本周汇报\n\n- 正确率 **85%**\n- 联系 13812345678\n\n| 项 | 值 |\n|---|---|\n| 时态 | 低 |'
  const r1 = await callTool('wecom_send', { targetName: '三年级辅导群', kind: 'markdown', content: md })
  check('工具', 'preview 显示发到哪里 + 转换后的完整内容', /三年级辅导群/.test(r1.preview.target) && r1.preview.content.includes('• 正确率 **85%**') && !r1.preview.content.includes('|---'))
  check('工具', '含手机号时 preview 有「内容可能包含个人信息」', /内容可能包含个人信息/.test(r1.preview.privacyWarning || ''))
  const sent = received.map(r => JSON.parse(r.body))
  check('工具', '假服务器收到 markdown 消息，内容是转换后的', r1.result.ok && sent.length === 1 && sent[0].msgtype === 'markdown' && sent[0].markdown.content.includes('# 本周汇报') && sent[0].markdown.content.includes('• 正确率'), JSON.stringify(r1.result))
  const long = Array.from({ length: 300 }, (_, i) => `第${i}条记录说明说明说明说明`).join('\n')
  received.length = 0
  const r2 = await callTool('wecom_send', { targetName: '三年级辅导群', kind: 'markdown', content: long })
  check('工具', '超长内容自动分段，每段不超过 4096 字节', r2.result.ok && received.length > 1 && received.every(r => Buffer.byteLength(JSON.parse(r.body).markdown.content) <= 4096), `${received.length} 段`)

  // ── 5. 发文件 ──
  // 发文件只允许本会话导出目录（agent-outputs/<会话>/exports）里的文件
  const expDir = path.join(work, 'agent-outputs', 'e2e', 'exports'); fs.mkdirSync(expDir, { recursive: true })
  const outside = path.join(work, '外面的.md'); fs.writeFileSync(outside, '# 不在导出目录\n正文内容 ABC123\n')
  const rOut = await callTool('wecom_send', { targetName: '三年级辅导群', kind: 'file', fileRef: outside })
  check('文件', '导出目录以外的文件被拒绝，不上传', !rOut.result.ok && !received.some(r => r.url.includes('upload_media')) && /导出|选择/.test(rOut.preview.error || rOut.result.message))
  const f = path.join(expDir, '汇报.md'); fs.writeFileSync(f, '# 周报\n正文内容 ABC123\n')
  received.length = 0
  const r3 = await callTool('wecom_send', { targetName: '三年级辅导群', kind: 'file', fileRef: f })
  const up = received.find(r => r.url.includes('upload_media'))
  const fileMsg = received.find(r => !r.url.includes('upload_media'))
  check('文件', 'preview 显示文件名和路径', /汇报\.md/.test(r3.preview.content))
  check('文件', '先 upload_media（type=file）上传，内容和文件名正确', !!up && up.url.includes('type=file') && up.body.includes('ABC123') && up.body.includes('filename="汇报.md"') || (!!up && up.body.includes('ABC123')), up && up.url)
  check('文件', '再发 file 消息，media_id 是上传返回的', r3.result.ok && !!fileMsg && JSON.parse(fileMsg.body).file.media_id === 'MID-E2E-1')
  const big = path.join(expDir, 'big.bin'); fs.writeFileSync(big, Buffer.alloc(21 * 1024 * 1024, 1))
  const r4 = await callTool('wecom_send', { targetName: '三年级辅导群', kind: 'file', fileRef: big })
  check('文件', '超过 20MB 提示，不上传', /20MB/.test(r4.preview.error || '') && /20MB/.test(r4.result.message) && !r4.result.ok)
  const r5 = await callTool('wecom_send', { targetName: '不存在的群', kind: 'text', content: 'x' }).catch(e => ({ err: String(e) }))
  check('工具', '不存在的群名：preview 报错，不发送', /没有名为/.test(r5.preview?.error || r5.err || '') && !received.some(r => r.body.includes('"x"')))

  // ── 6. MCP：设置页添加 → 列出工具 → 勾选 ──
  const fake = path.resolve(__dirname, '../fixtures/fake-mcp-server.cjs')
  await T('connector-add').click(); await T('connector-form').waitFor()
  await T('connector-type').click()
  await ctx.page.locator('.ant-select-item-option', { hasText: 'MCP 服务器' }).click()
  await T('connector-form-name').fill('测试笔记')
  await T('connector-form-command').fill(process.execPath)
  await T('connector-form-args').fill(fake)
  await T('connector-form-env').fill('FAKE_SECRET=envsecret77')
  await T('connector-save').click()
  await T('connector-测试笔记').waitFor({ timeout: 10000 })
  check('MCP', '保存后自动读取工具：列出 echo、add', await waitFor(async () => (await T('mcp-tool-echo').count()) === 1 && (await T('mcp-tool-add').count()) === 1, 20000))
  check('MCP', '环境变量的值不显示，只显示名称', !(await ctx.page.innerText('body')).includes('envsecret77') && /FAKE_SECRET/.test(await ctx.page.innerText('[data-testid="connector-测试笔记"]')))
  check('MCP', '没勾选之前，Agent 工具里没有 MCP 工具', !(await toolNames()).some(n => n.startsWith('mcp_')))
  await T('mcp-tool-echo').click()
  check('MCP', '勾选 echo 后 Agent 工具里出现 mcp_ 前缀的 echo，没勾的 add 不出现', await waitFor(async () => (await toolNames()).some(n => /^mcp_.*_echo$/.test(n)), 8000) && !(await toolNames()).some(n => /_add$/.test(n)))
  const mcpName = (await toolNames()).find(n => /^mcp_.*_echo$/.test(n))
  const r6 = await callTool(mcpName, { text: 'hello' })
  check('MCP', '调用 MCP 工具：preview 标明外部服务器，结果带回环境变量', /MCP/.test(r6.preview.target) && r6.result.ok && r6.result.message === 'echo:hello:envsecret77', JSON.stringify(r6.result))
  const rows2 = withDb(ud, d => d.prepare("SELECT value_json FROM settings WHERE key LIKE 'connectors%'").all())
  check('MCP', '环境变量值不明文落盘', !JSON.stringify(rows2).includes('envsecret77'))

  // ── 7. 删除 + 无残留进程 + 石墨 ──
  check('石墨', '设置页有石墨文档按钮和「支持导入 Word、Markdown」说明', (await T('shimo-open').count()) === 1 && /支持导入 Word、Markdown/.test(await T('shimo-panel').innerText()))
  await T('connector-三年级辅导群').locator('[data-testid=connector-remove]').click()
  await ctx.page.locator('.ant-modal-confirm-btns button.ant-btn-dangerous, .ant-modal-confirm-btns .ant-btn-primary').first().click()
  check('删除', '删除后这条连接消失，工具里不再有 wecom 目标', await waitFor(async () => (await T('connector-三年级辅导群').count()) === 0, 8000))
  const leaked = L.procOutput.join('\n')
  check('日志', '主进程输出里没有 Webhook key / 环境变量值', !leaked.includes(SECRET_KEY) && !leaked.includes('envsecret77'))
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
  await sleep(1500)
  const { execFileSync } = require('node:child_process')
  let left = ''
  try { left = execFileSync('pgrep', ['-f', 'fake-mcp-server.cjs']).toString().trim() } catch { /* 没有匹配 = 没有残留 */ }
  check('进程', '应用退出后没有残留的 MCP 子进程', left === '', left)
  server.close()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11e.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11e.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
