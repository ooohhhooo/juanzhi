// 连接目录端到端（M11k）：添加连接的目录（预设 / 自定义 / 石墨提示）→ 网址方式 MCP（假 HTTP 服务器，JSON 与 SSE 两种回复）
// → 测试连接显示状态和工具数 → 只选读取类 → 助手调用外部 MCP 工具时必须弹窗确认（取消则服务器没收到，同意才发）。
// 用法：node tests/e2e/run-m11k.cjs   （沙箱外运行；先 electron-vite build）。截图目录可用环境变量 EWB_SHOTS 指定。
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M
const { startFakeMcpHttp } = require('../fixtures/fake-mcp-http-server.cjs')

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11k')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = async name => { await sleep(700); return ctx.page.screenshot({ path: path.join(SHOTS, `m11k-${name}.png`) }) }
const count = id => T(id).count()
const toolList = () => ctx.app.evaluate(() => globalThis.__ewbConnectorTools().map(t => ({ name: t.name, level: t.level })))
const posted = f => f.requests.filter(r => r.method === 'POST' && r.body.includes('post_message') && r.body.includes('tools/call'))

async function main() {
  const urlSecret = 'urlsecret9876'
  const token = 'tok-e2e-12345678'
  const fJson = await startFakeMcpHttp({ mode: 'json' })
  const fSse = await startFakeMcpHttp({ mode: 'sse', token })
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM11k')
  await open(ud, { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // ── 1. 页面文案 + 目录 ──
  await goto('#/settings?tab=connectors'); await T('connectors-panel').waitFor({ timeout: 20000 })
  const lead = await ctx.page.innerText('body')
  check('文案', '页面首句说明可连接企业微信、飞书等外部工具；面板里提示每次对外发送先给你看', lead.includes('连接企业微信、飞书等外部工具，助手就能把结果发出去或读取那边的资料。') && /每次对外发送，都会先给你看完整内容/.test(await txt('connectors-panel')), lead.slice(0, 160))
  check('文案', '不再有单独的石墨文档卡片（只在目录里）', (await count('shimo-panel')) === 0 && !/把结果发到企业微信群，或放进石墨文档/.test(lead))
  await T('connector-add').click(); await T('connector-picker').waitFor()
  const picker = await txt('connector-picker')
  check('目录', '目录有企业微信群机器人、飞书、钉钉、Notion、GitHub、本机文件夹、网页抓取、自定义 MCP', ['企业微信群机器人', '飞书', '钉钉', 'Notion', 'GitHub', '本机文件夹', '网页抓取', '自定义 MCP'].every(n => picker.includes(n)), picker.slice(0, 200))
  check('目录', '钉钉标「需要自行确认」', /钉钉[\s\S]{0,12}需要自行确认/.test(picker))
  check('目录', '「导出后导入」里有石墨文档提示', picker.includes('导出后导入') && (await count('shimo-open')) === 1)
  await shot('01-picker')

  // ── 2. 预设：校验 + 添加（钉钉的预设就是「一个带密钥的网址」，指向本机假服务器）──
  await T('connector-pick-dingtalk').click(); await T('connector-form').waitFor()
  await shot('02-preset-form')
  check('预设', '预设表单只有名称和它要的字段（MCP 地址），带说明文档按钮', (await count('connector-field-url')) === 1 && (await count('connector-docs')) === 1 && (await count('connector-form-command')) === 0)
  await T('connector-save').click()
  check('预设', '什么都不填：提示「请填写」，不保存', await waitFor(async () => /请填写「MCP 地址」/.test(await txt('connector-form-error')), 5000))
  await T('connector-field-url').fill('not a url')
  await T('connector-save').click()
  check('预设', '网址格式不对：提示要以 http 开头', await waitFor(async () => /http/.test(await txt('connector-form-error')), 5000))
  await T('connector-form-name').fill('钉钉测试')
  await T('connector-field-url').fill(`${fJson.url}?key=${urlSecret}`)
  await T('connector-save').click()
  await T('connector-钉钉测试').waitFor({ timeout: 10000 })
  const card1 = 'connector-钉钉测试'
  check('测试连接', '添加后自动测试：状态「已连接」，3 个工具', await waitFor(async () => /已连接/.test(await txt(card1)) && /3 个工具/.test(await txt(card1)), 20000), await txt(card1))
  check('密钥', '摘要只显示域名，网址里的密钥不出现在页面上', !(await ctx.page.innerText('body')).includes(urlSecret) && /127\.0\.0\.1/.test(await T(card1).locator('[data-testid=connector-summary]').innerText()))
  check('测试连接', '服务器收到了初始化和工具列表请求', fJson.requests.some(r => r.body.includes('initialize')) && fJson.requests.some(r => r.body.includes('tools/list')))

  // ── 3. 自定义 MCP · 网址（带 Authorization 请求头，服务器要求令牌）──
  await T('connector-add').click(); await T('connector-pick-custom').click(); await T('connector-form').waitFor()
  await T('connector-form-name').fill('远程笔记')
  await ctx.page.locator('[data-testid=connector-form-mode] .ant-segmented-item', { hasText: '网址' }).click()
  await T('connector-form-url').fill(fSse.url)
  await T('connector-form-headers').fill(`Authorization: Bearer ${token}`)
  await shot('03-custom-http')
  await T('connector-save').click()
  await T('connector-远程笔记').waitFor({ timeout: 10000 })
  const card2 = 'connector-远程笔记'
  check('远程 MCP', '带令牌连上（服务器用 SSE 回复）：已连接，工具 echo / add / post_message 都列出', await waitFor(async () => /已连接/.test(await txt(card2)) && (await count('mcp-tool-echo')) >= 1, 20000)
    && (await T(card2).locator('[data-testid=mcp-tool-post_message]').count()) === 1, await txt(card2))
  check('远程 MCP', '请求都带了 Authorization 头', fSse.requests.length > 0 && fSse.requests.every(r => r.headers.authorization === `Bearer ${token}`))
  check('密钥', '请求头的值不显示，只显示名称 Authorization', !(await ctx.page.innerText('body')).includes(token) && /Authorization/.test(await T(card2).locator('[data-testid=connector-summary]').innerText()))

  // ── 4. 令牌不对 → 出错 + 原因，不含令牌 ──
  await T('connector-add').click(); await T('connector-pick-custom').click(); await T('connector-form').waitFor()
  await T('connector-form-name').fill('令牌错误')
  await ctx.page.locator('[data-testid=connector-form-mode] .ant-segmented-item', { hasText: '网址' }).click()
  await T('connector-form-url').fill(fSse.url)
  await T('connector-form-headers').fill('Authorization: Bearer wrong-token-0000')
  await T('connector-save').click()
  await T('connector-令牌错误').waitFor({ timeout: 10000 })
  check('出错', '令牌不对：状态「出错」，原因写明 401 和认证问题，不含令牌', await waitFor(async () => /出错/.test(await txt('connector-令牌错误')) && /401/.test(await txt('connector-令牌错误')), 20000) && !(await txt('connector-令牌错误')).includes('wrong-token-0000'), await txt('connector-令牌错误'))
  await shot('04-connected-and-error')
  // 关闭后重新进入页面，最近一次测试结果仍在
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await goto('#/settings?tab=connectors'); await T('connectors-panel').waitFor()
  check('状态保留', '重新打开设置页，状态仍显示（已连接 / 出错）', await waitFor(async () => /已连接/.test(await txt(card2)) && /出错/.test(await txt('connector-令牌错误')), 8000))

  // ── 5. 本地命令的密钥参数（相当于飞书的 App Secret）不明文落盘 ──
  const fakeStdio = path.resolve(__dirname, '../fixtures/fake-mcp-server.cjs')
  await ctx.page.evaluate(([cmd, f]) => window.api.connectors.save({ type: 'mcp', name: '密钥参数', config: { transport: 'stdio', command: cmd, args: [f, '-a', 'cli_pub1'], secretArgs: ['-s', 'feishusecret55'], preset: 'feishu' } }), [process.execPath, fakeStdio])
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await goto('#/settings?tab=connectors'); await T('connector-密钥参数').waitFor()
  await T('connector-密钥参数').locator('[data-testid=connector-test]').click()
  check('密钥', '本地命令测试连接成功，摘要写明有参数已隐藏', await waitFor(async () => /已连接/.test(await txt('connector-密钥参数')), 20000) && /另有 2 个参数已隐藏/.test(await txt('connector-密钥参数')) && !(await txt('connector-密钥参数')).includes('feishusecret55'), await txt('connector-密钥参数'))
  const rows = withDb(ud, d => d.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'connectors%'").all())
  const dump = JSON.stringify(rows)
  check('密钥', '数据库里没有网址密钥、令牌、参数密钥的明文', rows.length >= 2 && !dump.includes(urlSecret) && !dump.includes(token) && !dump.includes('feishusecret55') && !dump.includes('wrong-token-0000'))

  // ── 6. 只选读取类 + 外部级别 ──
  check('只读', '没勾选前，Agent 工具里没有这些 MCP 工具', !(await toolList()).some(t => t.name.startsWith('mcp_')))
  await T(card2).locator('[data-testid=mcp-readonly-only]').click()
  check('只读', '点「只选读取类」：只有声明只读的 echo 被允许，post_message 不在工具里', await waitFor(async () => (await toolList()).some(t => /_echo$/.test(t.name)), 8000) && !(await toolList()).some(t => /_post_message$/.test(t.name)) && !(await toolList()).some(t => /_add$/.test(t.name)))
  await T(card2).locator('[data-testid=mcp-tool-post_message]').click()
  check('外部级别', '勾选 post_message 后出现，所有 MCP 工具都是 external（每次要确认）', await waitFor(async () => (await toolList()).some(t => /_post_message$/.test(t.name)), 8000) && (await toolList()).filter(t => t.name.startsWith('mcp_')).every(t => t.level === 'external'))
  await shot('05-tools')

  // ── 7. 助手调用外部 MCP 工具：必须弹窗，取消则不发，同意才发 ──
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()   // 直接做，不先出计划
  await T('assistant-input').fill('请把提醒发到外部')
  await T('assistant-send').click()
  check('助手确认', '助手调用外部 MCP 工具时弹出同意框', await waitFor(async () => (await count('assistant-approval')) === 1, 60000))
  const target = await txt('assistant-approval-target'), content = await txt('assistant-approval-content')
  check('助手确认', '预览写明发到哪个外部服务器、完整参数内容', /外部 MCP 服务器：远程笔记 · post_message/.test(target) && content.includes('本周提醒：请跟进三年级'), target + ' | ' + content)
  check('助手确认', '同意之前服务器没收到发送请求', posted(fSse).length === 0)
  await shot('06-assistant-approval')
  await T('assistant-reject').click()
  await waitFor(async () => (await count('assistant-stop')) === 0 && (await count('assistant-approval')) === 0, 60000)
  await sleep(500)
  check('助手确认', '点「取消，不发送」后服务器仍然没收到', posted(fSse).length === 0)
  await T('assistant-input').fill('请再把提醒发到外部')
  await T('assistant-send').click()
  check('助手确认', '再来一次，弹出同意框', await waitFor(async () => (await count('assistant-approval')) === 1, 60000))
  await T('assistant-approve').click()
  check('助手确认', '点「发送」后服务器收到一次，带着令牌', await waitFor(async () => posted(fSse).length === 1, 30000) && posted(fSse)[0].headers.authorization === `Bearer ${token}`)
  await waitFor(async () => (await count('assistant-stop')) === 0, 60000)

  // ── 8. 日志、控制台 ──
  const leaked = L.procOutput.join('\n')
  check('日志', '主进程输出里没有网址密钥、令牌、参数密钥', !leaked.includes(urlSecret) && !leaked.includes(token) && !leaked.includes('feishusecret55') && !leaked.includes('wrong-token-0000'))
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill|ResizeObserver/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
  await sleep(1500)
  await fJson.close(); await fSse.close()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11k.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11k.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
