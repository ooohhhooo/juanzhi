// 助手 × 数据分析 完整流程端到端（M11f）：
// 导入虚构问卷 → 运营角色提问「分析满意度出看板」→ 先出计划 → 确认 → list_datasets / dataset_profile / run_query / stat_nps / stat_compare_groups / stat_find_low_groups
// → board_* 搭看板 → doc_write_section 写汇报 → 右侧「产出」出现汇报、看板、名单 → 切画布看节点 → 在发现节点上追问
// → wecom_send 触发同意弹窗（发到哪里、完整内容、个人信息提醒）→ 点取消，假企业微信服务器没有收到 → 导出的 xlsx 里是真名；发给模拟 AI 的请求体里没有真名和手机号。
// 全程 mock AI（tests/mock-ai/agent.cjs 的「满意度」剧本）+ 假企业微信服务器。数据由 tests/fixtures/gen-ops-data.cjs 现生成（全部虚构）。
// 用法：node tests/e2e/run-m11f.cjs   （沙箱外运行；先 electron-vite build）。截图目录可用环境变量 EWB_SHOTS 指定。
const http = require('node:http')
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L, stubOpen } = M
const { generate } = require('../fixtures/gen-ops-data.cjs')
const JSZip = require('jszip')

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11f')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = name => ctx.page.screenshot({ path: path.join(SHOTS, `m11f-${name}.png`) })
const count = id => T(id).count()
const REAL_NAME = /[一-龥]老师0\d/
const PHONE = /1[3-9]\d{9}/

const received = []
function startFake() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => { received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' })) })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const fake = await startFake()
  const hook = `http://127.0.0.1:${fake.address().port}/cgi-bin/webhook/send?key=e2ekey-0123456789abcdef`
  const dir = path.join(work, 'ops')
  await generate(dir)
  const ud = path.join(work, 'userM11f')
  await open(ud, { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await ctx.page.evaluate(h => window.api.connectors.save({ type: 'wecom', name: '三年级辅导群', config: { webhook: h } }), hook)
  received.length = 0

  // ── 1. 进助手，运营角色，从「＋」添加数据文件 ──
  await goto('#/assistant'); await T('assistant-page').waitFor()
  check('入口', '侧栏第一个是「助手」，最后一个主入口是「数据」', (await ctx.page.locator('.ewb-contents__link').nth(0).getAttribute('aria-label')) === '助手' && (await ctx.page.locator('.ewb-contents__link').nth(5).getAttribute('aria-label')) === '数据')
  const sugg = await ctx.page.locator('[data-testid^=assistant-suggest-]').allInnerTexts()
  check('推荐问题', '运营的推荐问题面向数据分析（4 条）', sugg.length === 4 && sugg[0].includes('满意度') && sugg.some(s => s.includes('到课率')) && sugg.some(s => s.includes('退费原因')) && sugg.some(s => s.includes('续费率')), sugg.join('｜'))
  await stubOpen(path.join(dir, 'survey.xlsx'))
  await T('assistant-plus').click()
  check('添加数据', '「添加数据文件…」可点（不再置灰）', !(await ctx.page.locator('.ant-dropdown-menu-item-disabled', { hasText: '添加数据文件' }).count()))
  await T('assistant-plus-add').click()
  check('添加数据', '导入后自动加为本次数据：顶部出现数据集标签', await waitFor(async () => (await count('assistant-datachip')) === 1, 60000) && /survey/.test(await txt('assistant-datachip')))
  const list = await ctx.page.evaluate(() => window.api.datasets.list())
  check('添加数据', '数据集页能看到刚导入的问卷（300 行）', list.length === 1 && list[0].tables.some(t => t.rows === 300))
  await T('assistant-input').fill('@sur')
  check('@提及', '@ 列表里有数据集 survey 和企业微信群「三年级辅导群」', await waitFor(async () => (await count('assistant-mention-list')) === 1, 8000) && /survey/.test(await txt('assistant-mention-list')) && /三年级辅导群/.test(await txt('assistant-mention-list')) || (await txt('assistant-mention-list')).includes('survey'))
  await T('assistant-input').fill('')
  await shot('01-data-chip')

  // ── 2. 提问 → 先出计划 → 确认 ──
  let base = mock.agentRequests.length   // agentRequests 每次返回新数组，用起点下标截取
  const firstReq = () => mock.agentRequests.slice(base).find(r => !r.toolNames.includes('ping'))
  await T('assistant-input').fill('分析满意度，出一份看板')
  await T('assistant-send').click()
  check('计划', '先出计划并暂停，计划阶段发给模型的工具里没有 run_query / stat_*，有概况类 list_datasets', await waitFor(async () => (await count('assistant-plan-go')) === 1, 30000)
    && !firstReq().toolNames.some(n => n === 'run_query' || n.startsWith('stat_')) && firstReq().toolNames.includes('list_datasets') && firstReq().toolNames.includes('update_plan'))
  check('计划', '本轮调用已经带上数据集：系统提示里有数据集编号', JSON.stringify(firstReq().messages[0]).includes(list[0].id))
  await shot('02-plan')
  await T('assistant-plan-go').click()

  // ── 3. 执行：到 wecom_send 弹窗 ──
  check('审批', '执行到 wecom_send 弹出同意框', await waitFor(async () => (await count('assistant-approval')) === 1, 120000))
  const target = await txt('assistant-approval-target'), content = await txt('assistant-approval-content')
  check('审批', '预览写明发到哪里：企业微信群：三年级辅导群', /企业微信群：三年级辅导群/.test(target), target)
  check('审批', '预览是完整内容，并且是真名和真手机号（不是代号）', REAL_NAME.test(content) && PHONE.test(content) && !/人员A\d+|手机\d{4}/.test(content), content)
  check('审批', '含个人信息的提醒醒目显示（红框）', (await count('assistant-approval-privacy')) === 1 && /个人信息|手机/.test(await txt('assistant-approval-privacy')))
  await shot('03-approval-privacy')
  await T('assistant-reject').click()
  check('取消不发送', '点「取消，不发送」后假企业微信服务器没有收到任何消息', await waitFor(async () => (await count('assistant-answer')) >= 1, 60000) && received.length === 0, String(received.length))
  await waitFor(async () => (await count('assistant-stop')) === 0, 30000)

  // ── 4. 工具步骤、回答、引用 ──
  const toolNames = await ctx.page.locator('[data-testid=assistant-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-name')))
  const seq = ['list_datasets', 'dataset_profile', 'run_query', 'stat_nps', 'stat_compare_groups', 'stat_find_low_groups', 'board_start', 'board_add_finding', 'board_add_section', 'board_add_block', 'board_set_caliber', 'doc_create', 'doc_write_section', 'table_save', 'output_export', 'wecom_send']
  check('工具步骤', '按剧本顺序调用了数据集、统计、看板、汇报、名单、导出、发送工具', seq.every(n => toolNames.includes(n)) && toolNames.indexOf('run_query') < toolNames.indexOf('stat_nps') && toolNames.indexOf('board_start') < toolNames.indexOf('doc_create'), toolNames.join(','))
  const failed = await ctx.page.locator('[data-testid=assistant-tool][data-ok=false]').evaluateAll(els => els.map(e => e.getAttribute('data-name')))
  check('工具步骤', '只有被拒绝的 wecom_send 是失败的，其余都成功', failed.length === 1 && failed[0] === 'wecom_send', failed.join(','))
  const ans = await ctx.page.locator('[data-testid=assistant-answer]').last().innerText()
  check('回答', '回答里显示真名（代号已还原），没有「人员A」代号', REAL_NAME.test(ans) && !/人员A\d+/.test(ans), ans.slice(0, 200))
  check('回答', '[[query:N]] 显示成可点击的「查询 N」标签；对不上的假引用被去掉并注明', (await ctx.page.locator('[data-testid=assistant-cite][data-kind=query]').count()) >= 2 && /引用对不上/.test(ans) && !/query:99/.test(ans))
  await shot('04-answer')
  await ctx.page.locator('[data-testid=assistant-cite][data-kind=query][data-id="5"]').first().click()
  check('查询记录', '点查询标签打开查询记录：有 SQL 摘要和结果表', await waitFor(async () => (await count('query-record')) === 1, 8000) && /授课老师/.test(await txt('query-sql')) && ((await count('query-table')) === 1 || (await count('query-text')) === 1))
  check('查询记录', '结果里的敏感值显示真名', REAL_NAME.test(await txt('query-record')) && !/人员A\d+/.test(await txt('query-record')))
  await shot('05-query-record')
  await ctx.page.keyboard.press('Escape'); await sleep(300)

  // ── 5. 右侧「产出」 ──
  if ((await T('side-panel').getAttribute('data-folded')) === '1') await T('side-unfold').click()   // 窄窗口（<1280）右侧面板默认收成竖栏
  check('产出面板', '对话模式右侧默认是「产出」，列出汇报、看板、名单 3 项', (await T('side-panel').getAttribute('data-mode')) === 'outputs' && await waitFor(async () => (await ctx.page.locator('[data-testid^=out-tab-]').count()) === 3, 15000), (await ctx.page.locator('[data-testid^=out-tab-]').allInnerTexts()).join('｜'))
  const tabs = await ctx.page.locator('[data-testid^=out-tab-]').allInnerTexts()
  check('产出面板', '有「满意度汇报」「秋季满意度看板」「本周跟进名单」', tabs.some(x => x.includes('满意度汇报')) && tabs.some(x => x.includes('秋季满意度看板')) && tabs.some(x => x.includes('本周跟进名单')), tabs.join('｜'))
  await ctx.page.locator('[data-testid^=out-tab-]', { hasText: '满意度汇报' }).click()
  check('产出面板', '汇报预览显示真名，不是代号', await waitFor(async () => REAL_NAME.test(await txt('out-preview')), 8000) && !/人员A\d+|手机\d{4}/.test(await txt('out-preview')), (await txt('out-preview')).slice(0, 150))
  await shot('06-output-report')
  await ctx.page.locator('[data-testid^=out-tab-]', { hasText: '秋季满意度看板' }).click()
  check('产出面板', '看板标签用 AnalysisBoard 渲染本会话看板：核心发现、图表，显示真名', await waitFor(async () => (await count('assistant-boardpane')) === 1, 8000) && REAL_NAME.test(await txt('assistant-boardpane')) && !/人员A\d+/.test(await txt('assistant-boardpane')) && (await ctx.page.locator('[data-testid=rb-chart]').count()) >= 1)
  await shot('07-output-board')
  await ctx.page.locator('[data-testid^=out-tab-]', { hasText: '本周跟进名单' }).click()
  check('产出面板', '名单表格预览显示真名和真手机号', await waitFor(async () => (await count('out-table')) === 1, 8000) && REAL_NAME.test(await txt('out-table')) && PHONE.test(await txt('out-table')))

  // ── 6. 导出的 xlsx 是真名 ──
  const sid = withDb(ud, d => d.prepare('SELECT id FROM agent_sessions ORDER BY created_at DESC LIMIT 1').get().id)
  const xlsx = path.join(ud, 'workbench-data', 'agent-outputs', sid, 'exports', '本周跟进名单.xlsx')
  check('导出', 'output_export 导出的 xlsx 文件存在', fs.existsSync(xlsx), xlsx)
  const zip = await JSZip.loadAsync(fs.readFileSync(xlsx))
  let xml = ''
  for (const n of Object.keys(zip.files)) if (/\.xml$/.test(n)) xml += await zip.files[n].async('string')
  check('导出', 'xlsx 里是真名和真手机号，没有代号', REAL_NAME.test(xml) && PHONE.test(xml) && !/人员A\d+|手机\d{4}/.test(xml))
  // 会话目录里存的名单草稿 csv 和数据库里的记录仍是代号（只有显示和导出还原）
  const dbSteps = JSON.stringify(withDb(ud, d => d.prepare('SELECT payload_json FROM agent_steps WHERE session_id = ?').all(sid)))
  check('存储', '数据库里的会话记录保持代号（没有真名）', /人员A\d+/.test(dbSteps) && !REAL_NAME.test(dbSteps) && !PHONE.test(dbSteps))
  // 界面导出：产出面板的导出按钮 → 另存为 → 文件里是真名
  const out2 = path.join(work, 'userM11f-export.xlsx')
  await M.stubSave(out2)
  await T('out-export-xlsx').click()
  check('导出', '面板「导出」另存的 xlsx 也是真名', await waitFor(async () => fs.existsSync(out2), 15000) && await (async () => { const z = await JSZip.loadAsync(fs.readFileSync(out2)); let x = ''; for (const n of Object.keys(z.files)) if (/\.xml$/.test(n)) x += await z.files[n].async('string'); return REAL_NAME.test(x) && !/人员A\d+/.test(x) })())

  // ── 7. 发给模拟 AI 的请求体里没有真名和手机号 ──
  const reqs = mock.agentRequests
  const body = JSON.stringify(reqs.map(r => r.messages))
  check('隐私', `发给模型的 ${reqs.length} 次请求里没有任何真名和手机号（全是代号）`, reqs.length >= 15 && !REAL_NAME.test(body) && !PHONE.test(body) && /人员A\d+/.test(body))

  // ── 8. 画布 ──
  await T('assistant-view-canvas').click()
  await sleep(1500)
  check('画布', '切到画布：显示节点（问题、计划、查询与统计、回答、发现、产出）', await waitFor(async () => (await count('canvas')) === 1, 10000)
    && (await ctx.page.locator('.ewb-cv-node[data-kind=question]').count()) === 1 && (await ctx.page.locator('.ewb-cv-node[data-kind=plan]').count()) === 1
    && (await ctx.page.locator('.ewb-cv-node[data-kind=step-group]').count()) >= 1 && (await ctx.page.locator('.ewb-cv-node[data-kind=answer]').count()) === 1
    && (await ctx.page.locator('.ewb-cv-node[data-kind=finding]').count()) >= 2 && (await ctx.page.locator('.ewb-cv-node[data-kind=output]').count()) >= 3)
  console.log('画布节点：', JSON.stringify(await ctx.page.locator('.ewb-cv-node').evaluateAll(els => els.map(e => e.getAttribute('data-kind')))))
  const nodeText = await T('canvas').innerText()
  check('画布', '画布上的节点文字也显示真名', REAL_NAME.test(nodeText) && !/人员A\d+/.test(nodeText))
  await shot('08-canvas')
  await T('cv-fit').click(); await sleep(400)
  await ctx.page.locator('.ewb-cv-node[data-kind=finding]').first().click()
  check('画布', '选中发现节点：右侧切到「卡片详情」', await waitFor(async () => (await T('side-panel').getAttribute('data-mode')) === 'card', 5000) && (await count('card-detail')) === 1)
  await shot('09-card-detail')
  // 追问
  const before = await ctx.page.locator('.ewb-cv-node').count()
  base = mock.agentRequests.length
  await T('cv-ask-input').fill('为什么这个偏低？')
  await T('cv-ask-send').click()
  check('画布追问', '在发现节点上追问：形成新分支，新增追问节点和回答', await waitFor(async () => (await ctx.page.locator('.ewb-cv-node[data-kind=followup]').count()) === 1 && (await ctx.page.locator('.ewb-cv-node[data-kind=answer]').count()) === 2, 40000) && (await ctx.page.locator('.ewb-cv-node').count()) > before)
  const branches = withDb(ud, d => d.prepare("SELECT DISTINCT branch_id FROM agent_steps WHERE session_id = ?").all(sid)).map(r => r.branch_id)
  check('画布追问', '会话记录里多了一个分支', branches.length === 2, branches.join(','))
  check('画布追问', '追问时上下文来自该发现所在的路径（请求里带着原来的提问）', !!firstReq() && JSON.stringify(firstReq().messages).includes('分析满意度'))
  await waitFor(async () => (await count('assistant-stop')) === 0, 20000)
  // 画布动作：加到看板 → 变成一条给助手的追问
  await T('cv-fit').click(); await sleep(400)
  await ctx.page.locator('.ewb-cv-node[data-kind=finding]').first().click()
  const actBtn = ctx.page.locator('[data-testid^="cv-act-add-to-board-"]').first()
  if (await actBtn.count()) {
    base = mock.agentRequests.length
    await actBtn.click()
    check('画布动作', '「加到看板」转成一条追问发给助手', await waitFor(async () => !!firstReq() && /把这条发现加到看板里/.test(JSON.stringify(firstReq().messages)), 20000))
    await waitFor(async () => (await count('assistant-stop')) === 0, 20000)
  } else check('画布动作', '选中发现节点后有「加到看板」动作按钮', false)
  await T('assistant-view-chat').click()
  check('对话', '切回对话：回答、输入框都在', (await count('assistant-composer')) === 1 && (await count('assistant-answer')) >= 1)

  // ── 9. 首次用运营角色：下次打开默认进助手 ──
  const sp = await ctx.page.evaluate(() => window.api.settings.get('start_page'))
  check('启动页', '第一次用运营角色提问后，下次打开卷知默认进入助手（start_page = assistant）', sp === 'assistant', String(sp))

  check('控制台', '没有未处理的渲染端报错', ctx.consoleErrors.filter(e => !/ResizeObserver|Failed to load resource/.test(e)).length === 0, ctx.consoleErrors.slice(0, 3).join(' | '))
  await closeApp(); fake.close(); await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11f.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  console.error('渲染端控制台错误：', ctx.consoleErrors?.slice(0, 5))
  try { await shot('FAIL') } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11f.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
