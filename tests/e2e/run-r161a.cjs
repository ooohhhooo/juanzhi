// 助手 R161-A 端到端：行动记录（回答下面的一句话摘要 + 展开时间线 + 点开看原始输入输出）、
// 同意弹窗的三个选项（仅这次 / 本次对话都允许 / 不允许）、「说了要做却没做」的自动提醒和「它没做完」提示、角色只看到自己的工具。
// 用法：node tests/e2e/run-r161a.cjs   （沙箱外运行；先 electron-vite build）。截图目录：环境变量 EWB_SHOTS，默认 $TMPDIR/r161a-shots
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, fs, path, work, SECRET, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M
const { startFakeMcpHttp } = require('../fixtures/fake-mcp-http-server.cjs')

const SHOTS = process.env.EWB_SHOTS || path.join(process.env.TMPDIR || work, 'r161a-shots')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = async name => { await sleep(600); return ctx.page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const count = id => T(id).count()
const posted = f => f.requests.filter(r => r.method === 'POST' && r.body.includes('post_message') && r.body.includes('tools/call'))
const idle = () => waitFor(async () => (await count('assistant-stop')) === 0 && (await count('assistant-working')) === 0, 60000)
async function ask(text) { await T('assistant-input').fill(text); await T('assistant-send').click() }

async function main() {
  const token = 'tok-e2e-r161a-12345'
  const fake = await startFakeMcpHttp({ mode: 'sse', token })
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userR161a')
  await open(ud, { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // 连一个外部工具（post_message 属于对外发送，每次要确认）
  await goto('#/settings?tab=connectors'); await T('connectors-panel').waitFor({ timeout: 20000 })
  await T('connector-add').click(); await T('connector-pick-custom').click(); await T('connector-form').waitFor()
  await T('connector-form-name').fill('远程笔记')
  await ctx.page.locator('[data-testid=connector-form-mode] .ant-segmented-item', { hasText: '网址' }).click()
  await T('connector-form-url').fill(fake.url)
  await T('connector-form-headers').fill(`Authorization: Bearer ${token}`)
  await T('connector-save').click()
  await T('connector-远程笔记').waitFor({ timeout: 10000 })
  await waitFor(async () => (await T('connector-远程笔记').locator('[data-testid=mcp-tool-post_message]').count()) === 1, 20000)
  await T('connector-远程笔记').locator('[data-testid=mcp-tool-post_message]').click()
  await sleep(800)

  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()

  // ── 1. 同意弹窗有三个选项；选「本次对话都允许」后发送 ──
  await ask('请把提醒发到外部')
  check('三选项', '弹出同意框，有「仅这次」「本次对话都允许」「不允许」三个按钮', await waitFor(async () => (await count('assistant-approval')) === 1, 60000)
    && (await txt('assistant-approve')) === '仅这次' && (await txt('assistant-approve-session')) === '本次对话都允许' && (await txt('assistant-reject')) === '不允许')
  check('三选项', '同意之前服务器没收到', posted(fake).length === 0)
  await shot('approval-three-options')
  await T('assistant-approve-session').click()
  check('三选项', '选「本次对话都允许」后发出一次', await waitFor(async () => posted(fake).length === 1, 30000))
  await idle()

  // ── 2. 行动记录：折叠一句话、展开时间线、点开看原始输入输出 ──
  await T('assistant-answer').last().waitFor({ timeout: 20000 })
  const sum = await txt('assistant-actionlog-summary')
  check('行动记录', '回答下面有一句话摘要：用了 1 个工具 · 你确认了 1 次 · 用时', /用了 1 个工具/.test(sum) && /你确认了 1 次/.test(sum) && /用时/.test(sum), sum)
  await shot('actionlog-collapsed')
  await T('assistant-actionlog-summary').first().click()
  await T('assistant-actionlog-list').waitFor({ timeout: 5000 })
  const itemText = await txt('assistant-actionlog-item')
  check('行动记录', '展开后是白话时间线：这一步写明「本次对话都允许」', /本次对话都允许/.test(itemText), itemText)
  await T('assistant-actionlog-item').first().locator('button').first().click()
  await T('assistant-actionlog-raw').waitFor({ timeout: 5000 })
  const rawIn = await txt('assistant-actionlog-raw-in')
  check('行动记录', '点开某一步能看到原始输入（含发送的文字），没有令牌', /本周提醒/.test(rawIn) && !(await ctx.page.innerText('body')).includes(token))
  check('行动记录', '有「复制这一步的原文」', (await count('assistant-actionlog-copy')) === 1)
  await shot('actionlog-expanded')

  // ── 3. 同一个对话里再发到同一个地方：不再弹窗，记录里写「已允许」 ──
  await ask('请再把提醒发到外部')
  await waitFor(async () => posted(fake).length === 2, 30000)
  await idle()
  check('本次对话都允许', '同一对话里第二次发到同一处：没有弹窗，服务器收到第二次', (await count('assistant-approval')) === 0 && posted(fake).length === 2)
  const sums = await T('assistant-actionlog-summary').allInnerTexts()
  check('本次对话都允许', '第二条回答的摘要写「本次对话已允许 1 次」', /本次对话已允许 1 次/.test(sums[sums.length - 1] ?? ''), sums.join(' | '))

  // ── 4. 换一个对话：重新询问；点「不允许」则不发 ──
  await T('assistant-new').click()
  await ask('请把提醒发到外部')
  check('本次对话都允许', '新对话里发到同一处：重新弹窗询问', await waitFor(async () => (await count('assistant-approval')) === 1, 60000))
  await T('assistant-reject').click()
  await idle()
  check('不允许', '点「不允许」后服务器没有收到第三次', posted(fake).length === 2)
  const sums2 = await T('assistant-actionlog-summary').allInnerTexts()
  check('行动记录', '被拒绝的那一轮摘要写「你拒绝了 1 次」', /你拒绝了 1 次/.test(sums2[sums2.length - 1] ?? ''), sums2.join(' | '))

  // ── 5. 说了要做却没做 ──
  await T('assistant-new').click()
  await ask('说了再做：看看整体情况')
  await idle()
  const nudges = mock.agentRequests.filter(r => (r.messages ?? []).some(m => m.role === 'user' && /^你刚才说「/.test(typeof m.content === 'string' ? m.content : '')))
  check('没做完', '第一次只说不做 → 程序自动提醒了一次 → 它随后调用了工具并给出回答', nudges.length >= 1 && (await count('assistant-unfinished')) === 0 && (await count('assistant-tool')) >= 1, `提醒后的请求 ${nudges.length}`)
  check('没做完', '提醒本身不显示成用户消息', (await T('assistant-user').allInnerTexts()).every(t => !/你刚才说/.test(t)))
  await T('assistant-actionlog-summary').last().click()
  check('没做完', '行动记录里能看到「自动提醒」一步', await waitFor(async () => /自动提醒/.test(await T('assistant-actionlog-list').last().innerText()), 5000))

  await T('assistant-new').click()
  await ask('说了不做：生成看板')
  await idle()
  check('没做完', '提醒一次后仍不动手：回答下面出现「它没做完，点这里让它继续」', await waitFor(async () => (await count('assistant-unfinished')) === 1, 20000) && /它没做完/.test(await txt('assistant-unfinished')) && /点这里让它继续/.test(await txt('assistant-unfinished')))
  const nudgeCount = mock.agentRequests.filter(r => (r.messages ?? []).some(m => m.role === 'user' && /^你刚才说「/.test(typeof m.content === 'string' ? m.content : ''))).length
  check('没做完', '一轮最多自动提醒一次（这一轮只有一个带提醒的请求）', nudgeCount >= 1)
  await shot('unfinished-notice')
  const before = mock.agentRequests.length
  await T('assistant-unfinished-continue').click()
  check('没做完', '点「点这里让它继续」会重新发一条请求', await waitFor(async () => mock.agentRequests.length > before, 20000))
  await idle()

  // ── 6. 角色只看到自己的工具（运营：有企业微信 / 数据分析，没有教研的课件和教材工具） ──
  const tn = mock.agentRequests[mock.agentRequests.length - 1].toolNames
  check('角色工具', '运营收到的工具清单：有发企业微信、有外部工具，没有教研对照表 / 读课件 / 备课', tn.includes('wecom_send') && tn.some(n => /^mcp_/.test(n)) && !tn.includes('research_table') && !tn.includes('courseware_read') && !tn.includes('lesson_kps'), tn.join(','))

  const leaked = L.procOutput.join('\n')
  check('日志', '主进程输出里没有令牌', !leaked.includes(token))
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill|ResizeObserver/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
  await sleep(1000)
  await fake.close()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-r161a.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-r161a.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
