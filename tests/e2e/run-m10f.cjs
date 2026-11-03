// 余额 / 价格 / 用量 / 出错原因 端到端：mock 服务扮演「中转平台」（one-api 风格的额度接口，按密钥返回）。
// 用法：npm run test:e2e:m10f   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { DatabaseSync } = require('node:sqlite')
const { seed } = require('./fixtures-m3.cjs')
const { check, sleep, waitFor, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M

const writeDb = (ud, fn) => { const d = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite')); d.exec('PRAGMA busy_timeout=5000'); try { return fn(d) } finally { d.close() } }

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM10f')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  // 预置一条历史调用：课程匹配 输入 2.4 万 / 输出 1 万
  writeDb(ud, d => d.prepare("INSERT INTO ai_usage (paper_id, kind, model, prompt_tokens, completion_tokens, cached_tokens, ok) VALUES (NULL, 'course-match', 'm', 24000, 10000, 0, 1)").run())
  await open(ud)
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // ── 1. 设置页：中转平台的额度（按这把密钥） ──
  mock.billing = { limitUsd: 50, usageCents: 1000 }
  await goto('#/settings?admin=1'); await T('ai-settings').waitFor()
  check('余额', '设置 → AI 服务显示「额度 $40.00」，并注明单位以平台为准', await waitFor(async () => /额度 \$40\.00/.test(await txt('ai-balance-text')) && /单位以平台为准/.test(await txt('ai-balance-panel')), 10000), await txt('ai-balance-panel'))
  check('余额', '服务商显示「中转平台（OpenAI 兼容）」', /中转平台（OpenAI 兼容）/.test(await txt('ai-balance-panel')))
  check('余额', '查询带的是当前密钥', mock.balanceRequests.length >= 2 && mock.balanceRequests.every(r => r.auth === `Bearer ${SECRET}`))
  mock.billing = { limitUsd: 50, usageCents: 2000 }
  await T('ai-balance-refresh').click()
  check('余额', '点「刷新」后更新为 $30.00', await waitFor(async () => /\$30\.00/.test(await txt('ai-balance-text')), 8000))
  mock.billing = { limitUsd: 1e9, usageCents: 5 }
  await T('ai-balance-refresh').click()
  check('余额', '无限额度显示「不限额度」', await waitFor(async () => /不限额度/.test(await txt('ai-balance-text')), 8000))
  mock.billing = null
  await T('ai-balance-refresh').click()
  check('余额', '查不到时显示「不支持在软件里查余额」', await waitFor(async () => /不支持在软件里查余额/.test(await txt('ai-balance-msg')), 8000))

  // ── 2. 价格与本月用量 ──
  check('用量', '本月用量里有「课程匹配」1 次，没填价格时提示可填价格换算', await waitFor(async () => /课程匹配/.test(await txt('ai-usage-month')) && /填写上面的价格/.test(await txt('ai-usage-month')), 8000))
  await T('ai-price-in').fill('2'); await T('ai-price-out').fill('8')
  await T('ai-price-save').click()
  check('价格', '保存价格后，本月用量多出「约合」一列（2.4 万×2 + 1 万×8 = ¥0.13）', await waitFor(async () => /约合/.test(await txt('ai-usage-month')) && /¥0\.13/.test(await txt('ai-usage-month')), 8000), await txt('ai-usage-month'))
  const pr = await ctx.page.evaluate(() => window.api.ai.getPrices())
  check('价格', '价格存下来了', pr.inPer1M === 2 && pr.outPer1M === 8)

  // ── 3. 费用估算（接口层）：1 次课程匹配 = 历史平均 ──
  const est = await ctx.page.evaluate(() => window.api.ai.costEstimate({ task: 'course-match', calls: 2, fallbackTokens: 1000 }))
  check('估算', '有历史时按历史平均估算：2 次 = 4.8 万输入 + 2 万输出', est.fromHistory && est.tokensIn === 48000 && est.tokensOut === 20000 && Math.abs(est.low - 0.256 * 0.8) < 1e-6, JSON.stringify(est))

  // ── 4. 自定义余额查询优先 ──
  await ctx.page.evaluate(b => window.api.ai.setCustomBalance(b), { url: mock.baseUrl + '/dashboard/billing/subscription', balancePath: 'hard_limit_usd', totalPath: '', unit: '点' })
  mock.billing = { limitUsd: 77, usageCents: 0 }
  await ctx.page.reload(); await T('ai-settings').waitFor()
  check('自定义', '填了自定义查询后显示「77.00 点」', await waitFor(async () => /77\.00 点/.test(await txt('ai-balance-text')), 10000), await txt('ai-balance-panel'))
  await ctx.page.evaluate(() => window.api.ai.setCustomBalance({ url: '', balancePath: '', totalPath: '', unit: '' }))

  // ── 5. 出错原因：测试连接遇到 429 ──
  mock.script([{ type: '429', times: 6, retryAfter: 1 }])
  await T('ai-test').click()
  check('出错原因', '测试连接失败时，除了原有说明，还给出主因和「可能的原因」列表', await waitFor(async () => (await T('ai-error-explain').count()) > 0, 30000) && /频繁|拥堵|额度/.test(await txt('ai-error-cause')) && (await ctx.page.locator('[data-testid=ai-error-reasons] li').count()) >= 2)
  check('出错原因', '可展开服务商原话，且不含密钥', /HTTP 429/.test(await ctx.page.locator("[data-testid=ai-error-raw]").first().textContent()) && !(await ctx.page.locator('body').innerHTML()).includes(SECRET), await ctx.page.locator("[data-testid=ai-error-raw]").first().textContent())
  mock.clearScript()

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m10f.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m10f.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
