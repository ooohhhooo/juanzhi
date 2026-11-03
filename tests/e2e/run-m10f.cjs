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
  // 再一条：主模型的报告调用，输入 10 万（其中缓存命中 2 万）/ 输出 5 万
  writeDb(ud, d => d.prepare("INSERT INTO ai_usage (paper_id, kind, model, prompt_tokens, completion_tokens, cached_tokens, ok) VALUES (NULL, 'p3_report', 'mock-text-model', 100000, 50000, 20000, 1)").run())
  // 旧版单组价格（输入 2 / 输出 8）：升级后应自动成为当前主模型的价格
  writeDb(ud, d => d.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('ai_prices', ?)").run(JSON.stringify({ inPer1M: 2, outPer1M: 8 })))
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

  // ── 2. 价格（按模型）与本月用量 ──
  const pr0 = await ctx.page.evaluate(() => window.api.ai.getPrices())
  const pm = pr0.models.find(m => m.model === 'mock-text-model')
  check('价格', '旧版单组价格自动迁移成当前主模型的价格；未配置价格的模型为空', !!pm && pm.inPer1M === 2 && pm.outPer1M === 8 && pr0.models.find(m => m.model === 'm').inPer1M === null && pr0.models.find(m => m.model === 'm').other === true, JSON.stringify(pr0))
  await ctx.page.reload(); await T('ai-settings').waitFor()
  check('用量', '本月用量按任务 + 模型分行；没填价格的模型显示「未填价格」，合计注明不含', await waitFor(async () => { const t = await txt('ai-usage-month'); return /课程匹配/.test(t) && /报告（完整数据版）/.test(t) && /未填价格/.test(t) && /不含未填价格的模型/.test(t) }, 8000), await txt('ai-usage-month'))
  check('用量', '迁移价格的主模型报告行：8 万×2 + 2 万×2 + 5 万×8 = ¥0.60（缓存价没填按输入价）', /¥0\.60/.test(await txt('ai-usage-month')), await txt('ai-usage-month'))
  await T('ai-price-in-m').fill('2'); await T('ai-price-out-m').fill('8')
  await T('ai-price-in-mock-text-model').fill('1'); await T('ai-price-out-mock-text-model').fill('4'); await T('ai-price-cached-mock-text-model').fill('0.1')
  await T('ai-price-save').click()
  check('价格', '两个模型各填价格后，本月用量按模型显示金额：m 课程匹配 ¥0.13，主模型报告 ¥0.28（8 万×1 + 2 万×0.1 + 5 万×4），合计 ¥0.41，不再有「不含」注记', await waitFor(async () => { const t = await txt('ai-usage-month'); return /¥0\.13/.test(t) && /¥0\.28/.test(t) && /合计约 ¥0\.41/.test(t) && !/不含未填价格/.test(t) && !/未填价格/.test(t) }, 8000), await txt('ai-usage-month'))
  const pr = await ctx.page.evaluate(() => window.api.ai.getPrices())
  const g = n => pr.models.find(m => m.model === n)
  check('价格', '价格按模型存下来了（含缓存价）', g('m').inPer1M === 2 && g('m').outPer1M === 8 && g('mock-text-model').inPer1M === 1 && g('mock-text-model').outPer1M === 4 && g('mock-text-model').cachedInPer1M === 0.1, JSON.stringify(pr))

  // ── 3. 费用估算（接口层）：课程匹配没有主模型的历史，沿用最近用过的模型 m 的历史平均和价格 ──
  const est = await ctx.page.evaluate(() => window.api.ai.costEstimate({ task: 'course-match', calls: 2, fallbackTokens: 1000 }))
  check('估算', '有历史时按历史平均估算：2 次 = 4.8 万输入 + 2 万输出，按模型 m 的价格', est.fromHistory && est.tokensIn === 48000 && est.tokensOut === 20000 && Math.abs(est.low - 0.256 * 0.8) < 1e-6, JSON.stringify(est))
  const est2 = await ctx.page.evaluate(() => window.api.ai.costEstimate({ task: 'report', calls: 1, fallbackTokens: 0 }))
  check('估算', '报告走主模型的历史：1 次 = 10 万输入（2 万缓存）+ 5 万输出，约 ¥0.28', est2.fromHistory && est2.tokensIn === 100000 && Math.abs(est2.low - 0.282 * 0.8) < 1e-6, JSON.stringify(est2))

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
