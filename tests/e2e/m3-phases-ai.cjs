// M3 端到端（第二部分）：P2 同比 AI 分析（流式、取消、故障、缓存与过期）、重难点、实时更新、IPC 参数校验。
const U = require('./m3-phases-ui.cjs')
const L = require('./lib.cjs')
const { ctx, T, txt, goto, pickOpt, clearSel, waitStat, near, check, sleep, waitFor, work, shots, shot, SECRET, cfgFor, saveCfg, clean, naive, p2mock, SPEC, setFilter } = U
const { docsPrompt, withDb, dropFiles, waitStatus, root, fs, path } = L

const CARD = '[data-testid=analysis-card]'
const aiBtn = id => ctx.page.locator(`${CARD} [data-testid=${id}]`)
const mockReqs = () => ctx.mock.p2Requests
const dbAnalyses = () => withDb(ctx.ud, d => d.prepare('SELECT * FROM ai_analyses').all())
const aiStatus = async () => ctx.page.locator(`${CARD} [data-testid=ai-panel]`).getAttribute('data-status')

async function openCompare(filter = { grade: '4' }) {
  await setFilter(filter, '#/dashboard')
  await ctx.page.getByRole('tab', { name: '同比' }).click()
  await T('col-added').waitFor()
  await waitFor(async () => (await T('col-added').getAttribute('data-count')) === '1', 10000)
  await T('ai-panel').first().waitFor()
}
/** 点「生成 / 重新生成」；已有结果时会弹出费用确认 */
async function runAi(scope = CARD) {
  await ctx.page.locator(`${scope} [data-testid=ai-run]`).click()
  await sleep(300)
  const ok = ctx.page.locator('.ant-popconfirm:visible .ant-btn-primary, .ant-popover:visible .ant-btn-primary')
  if (await ok.count()) await ok.first().click()
}
const waitAi = (status, ms = 40000) => waitFor(async () => (await aiStatus().catch(() => null)) === status, ms)
const mdText = () => ctx.page.locator(`${CARD} [data-testid=ai-text]`).innerText()

/** 把收到的 user 提示词按 docs 里的模板拆回 12 个占位符的值（拆不回去 = 模板骨架被改了） */
function parseUser(user) {
  const tpl = docsPrompt('p2_yoy', 'user')
  const names = [...tpl.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])
  const parts = tpl.split(/\{\{[A-Z_]+\}\}/)
  const vals = {}
  let pos = 0
  if (!user.startsWith(parts[0])) return null
  pos = parts[0].length
  for (let i = 0; i < names.length; i++) {
    const next = parts[i + 1]
    const end = i + 1 < names.length || next.length ? user.indexOf(next, pos) : user.length
    if (end < 0) return null
    vals[names[i]] = user.slice(pos, end)
    pos = end + next.length
  }
  return pos === user.length ? vals : null
}

// ───────── P2：没配 AI → 引导；配好后流式生成 ─────────
async function phaseP2Basic() {
  const { page, mock } = ctx
  await openCompare()
  const guide = await waitFor(async () => (await T('ai-guide').count()) > 0, 10000)
  check('P2 无 AI', '没配 AI：统计照常显示（四栏有数据），AI 区给出引导而不是报错', guide && (await T('col-added').getAttribute('data-count')) === '1' && /还没有配置 AI 服务/.test(await txt('ai-guide')) && (await aiBtn('ai-run').count()) === 0, await txt('ai-guide'))
  await shot('13-ai-guide')
  await T('ai-guide-link').click()
  check('P2 无 AI', '引导里的链接直接去「设置」', await waitFor(async () => (await page.evaluate(() => location.hash)) === '#/settings', 5000))
  // 配好 AI（同时验证：在设置里保存后回到看板，不用重载就能看到「生成」按钮）
  await goto('#/dashboard')
  await page.getByRole('tab', { name: '同比' }).click()   // 回到看板默认是「分布」页签
  await T('col-added').waitFor()
  await saveCfg(cfgFor(mock), SECRET)
  check('P2 无 AI', '配好 AI 后，看板自动刷新：引导消失，出现「生成 AI 分析」', await waitFor(async () => (await aiBtn('ai-run').count()) > 0 && (await T('ai-guide').count()) === 0, 10000))

  // 第一次生成：慢速流式，观察文字一点点长出来
  mock.p2DelayMs = 120
  mock.resetStats()
  await runAi()
  const running = await waitFor(async () => (await aiBtn('ai-running').count()) > 0, 10000)
  await sleep(700)
  const len1 = (await mdText()).length
  await shot('14-ai-streaming')
  await sleep(900)
  const len2 = (await mdText()).length
  check('P2 流式', '生成中：显示「正在生成…」和取消按钮，文字随流式增量越来越长（不是最后一次性出现）', running && (await aiBtn('ai-cancel').count()) === 1 && len1 > 0 && len2 > len1, `${len1} → ${len2}`)
  const done = await waitAi('fresh', 60000) || await waitFor(async () => (await aiBtn('ai-cached').count()) > 0, 60000)
  check('P2 流式', '生成完成后状态变为「已缓存」，取消按钮消失', done && (await aiBtn('ai-cancel').count()) === 0 && (await aiBtn('ai-cached').count()) === 1, await aiStatus())
  await shot('15-ai-done')
  mock.p2DelayMs = 0

  // ── 发给模型的提示词：占位符都由本地统计填入 ──
  const req = mockReqs()[0]
  check('P2 提示词', '只发了 1 次请求，流式（stream=true），模型名与配置一致，带正确的鉴权', mockReqs().length === 1 && req.stream === true && req.model === 'mock-text-model' && req.auth === `Bearer ${SECRET}`, `${mockReqs().length} 次`)
  check('P2 提示词', 'system 提示词与 docs/prompts/v1-sonnet改写.md 里的 P2 system 逐字一致', req.system === docsPrompt('p2_yoy', 'system'))
  const v = parseUser(req.user)
  check('P2 提示词', 'user 提示词的骨架与 docs 里的 P2 user 模板逐字一致，12 个占位符一个不缺（拆得回去）', !!v && Object.keys(v).length === 12, v ? Object.keys(v).join(',') : '拆不回去')
  check('P2 提示词', '没有残留的 {{ }} 占位符', !req.user.includes('{{') && !req.user.includes('}}') && !req.system.includes('{{'))
  const db = withDb(ctx.ud, d => ({ intro: Object.fromEntries(d.prepare('SELECT code, intro_grade FROM kps').all().map(k => [k.code, String(k.intro_grade)])) }))
  const cols = line => line.split(' | ')
  // 手算（见 fixtures-m3.cjs 头部）：目标 2025 四年级 5 份（总分 10+9+7+9+9=44），基线 2023+2024 四年级 6 份
  check('P2 提示词', '头部占位符 = 手算：四年级 · 按二级知识点统计，并写明学期范围（目标上、下学期，基线已按学期对齐）；目标 2025-2026学年 5 份；基线 2023-2024学年、2024-2025学年 6 份', v && v.FILTER_DESC === '四年级 · 按二级知识点统计 · 学期范围：目标学年 上学期、下学期；基线已按学期对齐，只取 上学期、下学期' && v.TARGET_YEAR === '2025-2026学年' && v.TARGET_PAPERS === '5' && v.BASE_YEARS === '2023-2024学年、2024-2025学年' && v.BASE_PAPERS === '6', v && [v.FILTER_DESC, v.TARGET_YEAR, v.TARGET_PAPERS, v.BASE_YEARS, v.BASE_PAPERS].join(' / '))
  check('P2 提示词', '教材版本分布 = 手算：目标 人教PEP 3 份、外研版 2 份；基线 人教PEP 6 份', v && v.TARGET_TEXTBOOKS === '人教PEP 3 份、外研版 2 份' && v.BASE_TEXTBOOKS === '人教PEP 6 份', v && `${v.TARGET_TEXTBOOKS} | ${v.BASE_TEXTBOOKS}`)
  check('P2 提示词', '样本提示由程序判定（两侧都 ≥5 份，但基线混入了期中和期末）→ 只提示口径不一致，不是「样本偏小」', v && v.SAMPLE_WARNING === '两侧混入了不同考试类型的试卷，对比时请注意口径不一致；学期范围：目标学年 上学期、下学期；基线已按学期对齐，只取 上学期、下学期。', v && v.SAMPLE_WARNING)
  const added = v ? cols(v.ADDED.split('\n')[0]) : []
  check('P2 提示词', '新增表 = 手算：一般将来时 | 目标 2/5 份 | 2 题 | 分值占比 9.1%（4 分 ÷ 目标总分 44）；样本题 token 带题型和题干摘要', v && v.ADDED.split('\n').length === 1 && added[0] === 'GR.TENSE.FUT' && added[1] === '一般将来时' && added[2] === db.intro['GR.TENSE.FUT'] && added[3] === '2/5' && added[4] === '2' && added[5] === '9.1%' && /^\[2025学年四年级下期末卷C2 · 1\]（单项选择：3\. A\. skirt B\. dress C\. cold）；\[2025学年四年级上期中卷C5 · 1\]（用所给词的适当形式填空：C5-1 题干）$/.test(added[6]), added.join(' | '))
  const removed = v ? cols(v.REMOVED.split('\n')[0]) : []
  check('P2 提示词', '消失表 = 手算：字母与字母组合发音 | 基线 3/6 份 | 3 题；样本题取自基线（A1/A2/A3 的第 1 题）', v && removed[0] === 'PH.PHONICS' && removed[3] === '3/6' && removed[4] === '3' && /\[2023学年四年级下期末卷A1 · 1\].*\[2023学年四年级下期末卷A2 · 1\].*\[2023学年四年级上期中卷A3 · 1\]/.test(removed[5]), removed.join(' | '))
  const changed = v ? v.CHANGED.split('\n').map(cols) : []
  check('P2 提示词', '升降表 = 手算：购物 1/6→3/5 +43.3 上升（C4 把它标成次知识点）；一般过去时 3/6→4/5 +30.0 上升；名词复数 6/6→1/5 -80.0 下降', JSON.stringify(changed.map(c => c.slice(0, 6))) === JSON.stringify([['FN.SHOP', '购物', '1/6', '3/5', '+43.3', '上升'], ['GR.TENSE.PAST', '一般过去时', '3/6', '4/5', '+30.0', '上升'], ['GR.NOUN.PLURAL', '名词复数', '6/6', '1/5', '-80.0', '下降']]), changed.map(c => c.slice(0, 6).join('/')).join(' ; '))
  // 高频表 = 把目标与基线合起来（grade 4 的 11 份）按综合得分排序的前 15 个二级知识点
  const union = naive.counted({ grade: '4' })
  const wantHot = naive.hot(ctx.tree, union, 2).slice(0, 15).map(r => [r.code, `${r.papers}/${union.length}`])
  const gotHot = v ? v.HOT.split('\n').map(cols).map(c => [c[0], c[2]]) : []
  check('P2 提示词', '跨年高频考点 Top15 = 逐条循环重算（按出现率×分值占比×易错）的次序，份数是「出现/11」', JSON.stringify(gotHot) === JSON.stringify(wantHot), JSON.stringify(gotHot.slice(0, 3)))
  const pastRow = v ? v.HOT.split('\n').map(cols).find(c => c[0] === 'GR.TENSE.PAST') : null
  check('P2 提示词', '高频表里「一般过去时」：7/11 份、8 题（7 道主知识点 + C1 第 4 题把它标成次知识点）、AI 估计易错题 2 道、易错原因「规则变化加-ed」（手算：A1Q3、C1Q1）', pastRow && pastRow[2] === '7/11' && pastRow[3] === '8' && pastRow[4] === '2' && pastRow[5] === '规则变化加-ed', pastRow && pastRow.join(' | ').slice(0, 120))
  // 提示词里出现的 token 与界面上渲染出的引用卡片一一对应
  const tokens = new Set([...req.user.matchAll(/\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/g)].map(m => m[0]))
  const cards = await page.locator(`${CARD} [data-testid=cite-card]`).evaluateAll(els => els.map(e => ({ token: e.dataset.token, qid: e.dataset.qid })))
  check('P2 引用', '输出里的 [试卷标题 · 题号] 引用被渲染成可点击的截图卡片，且每一个都来自提示词里给出的样本题', cards.length >= 1 && cards.every(c => tokens.has(c.token)), `${cards.length} 张`)
  const md = await mdText()
  check('P2 输出', '输出的数字就是本地统计：新增小节写着「2/5 份卷子出现，2 题，分值占比 9.1%」，且结构是 一～五 五个固定章节', /GR\.TENSE\.FUT｜一般将来时/.test(md) && /2\/5 份卷子出现，2 题，分值占比 9\.1%/.test(md) && ['一、总体变化', '二、新增知识点', '三、消失与下降的知识点', '四、高频考点与易错预警', '五、下学期教学与复习建议'].every(h => md.includes(h)) && !/\[不存在/.test(md), md.slice(0, 80).replace(/\n/g, ' '))
  // 点引用卡片 → 整页原卷 + 高亮对应的题
  const c2card = page.locator(`${CARD} [data-testid=cite-card][data-qid="${ctx.qids.C2Q1}"]`).first()
  check('P2 引用', '样本题 C2 第 1 题的引用卡片里是按 bbox 裁出的截图', (await c2card.count()) === 1 && (await c2card.locator('[data-mode=crop]').count()) === 1)
  await c2card.click()
  await T('page-viewer').waitFor()
  await sleep(500)
  const hl = await page.evaluate(() => { const i = document.querySelector('[data-testid=page-viewer-img]').getBoundingClientRect(), h = document.querySelector('[data-testid=page-highlight]'); if (!h) return null; const r = h.getBoundingClientRect(); return [(r.x - i.x) / i.width, (r.y - i.y) / i.height, r.width / i.width, r.height / i.height] })
  check('P2 引用', '点引用卡片打开整页原卷，高亮框 = 这道题的 bbox', !!hl && hl.every((x, i) => near(x, ctx.bbox[i])), JSON.stringify(hl))
  await page.keyboard.press('Escape')
  await T('page-viewer').waitFor({ state: 'detached' }).catch(() => {})
  // 入库
  const rows = dbAnalyses()
  const usage = withDb(ctx.ud, d => d.prepare("SELECT * FROM ai_usage WHERE kind = 'p2_yoy'").all())
  check('P2 缓存', 'ai_analyses 里有 1 行：提示词版本 v1.1、数据指纹（64 位）、缓存键、Markdown 与界面一致；ai_usage 记了这次调用', rows.length === 1 && rows[0].prompt_version === 'v1.1' && /^[0-9a-f]{64}$/.test(rows[0].fingerprint) && /^[0-9a-f]{64}$/.test(rows[0].cache_key) && rows[0].markdown.includes('## 五、下学期教学与复习建议') && usage.length === 1 && usage[0].ok === 1 && usage[0].prompt_tokens > 0, `${rows.length} 行 / 用量 ${usage.length}`)
  ctx.cached = rows[0]
}

// ───────── P2：缓存命中（重载不再请求）、抽屉里只看本知识点 ─────────
async function phaseP2Cache() {
  const { page } = ctx
  const before = mockReqs().length
  await page.reload()
  await openCompare()
  const cached = await waitFor(async () => (await aiBtn('ai-cached').count()) > 0, 10000)
  check('P2 缓存', '重载页面后直接显示已缓存的分析，没有再请求模型', cached && mockReqs().length === before && /GR\.TENSE\.FUT｜一般将来时/.test(await mdText()), `${mockReqs().length} 次`)
  // 抽屉：只显示本知识点的小节
  await T('item-GR.TENSE.FUT').click()
  const dr = T('kp-drawer')
  await dr.locator('[data-testid=ai-text]').waitFor()
  const t1 = await dr.locator('[data-testid=ai-text]').innerText()
  check('P2 抽屉', '抽屉里的 AI 分析只显示「一般将来时」这一小节（含数据、原因判断、教学建议），不是整篇', /GR\.TENSE\.FUT｜一般将来时/.test(t1) && /数据/.test(t1) && /教学建议/.test(t1) && !/五、下学期教学与复习建议/.test(t1), t1.slice(0, 60).replace(/\n/g, ' '))
  check('P2 抽屉', '抽屉里的引用也是可点的截图卡片', (await dr.locator('[data-testid=cite-card]').count()) >= 1)
  await dr.locator('[data-testid=ai-toggle-full]').click()
  check('P2 抽屉', '点「查看完整分析」展开整篇', /五、下学期教学与复习建议/.test(await dr.locator('[data-testid=ai-text]').innerText()))
  await shot('16-drawer-ai')
  await dr.locator('.ant-drawer-close').click()
  await dr.waitFor({ state: 'detached', timeout: 8000 })
  // 消失类知识点在完整分析里只有一条列表项，没有单独小节 → 说明
  await T('item-PH.PHONICS').click()
  await T('kp-drawer').locator('[data-testid=ai-text]').waitFor()
  check('P2 抽屉', '没有单独小节的知识点（消失的字母组合发音）：说明「完整分析里没有单独讨论」，而不是空白', /完整分析里没有单独讨论/.test(await T('kp-drawer').locator('[data-testid=ai-text]').innerText()))
  await T('kp-drawer').locator('.ant-drawer-close').click()
  await T('kp-drawer').waitFor({ state: 'detached', timeout: 8000 })
  // 筛选栏里的「学年」在同比页不生效 → 它不能混进缓存的范围键：换一个学年筛选，同比四栏不变，AI 分析也要原样还在（修复前会掉回「还没有分析」）
  const nReq = mockReqs().length
  await pickOpt('filter-year', '2024-2025')
  await T('compare-year-ignored').waitFor()
  await sleep(1500)
  check('P2 缓存', '在筛选栏里换学年（同比页不生效）：AI 分析仍是「已缓存」同一份，没有掉回「还没有分析」，也没有新请求', (await aiStatus()) === 'fresh' && /GR\.TENSE\.FUT｜一般将来时/.test(await mdText()) && mockReqs().length === nReq)
  await clearSel('filter-year')
  await T('compare-year-ignored').waitFor({ state: 'detached', timeout: 8000 })
  // 另一个范围（基线只看 2024）：没有缓存，不会拿别的范围的结果充数
  await pickOpt('compare-base', '只看 2024-2025学年')
  const none = await waitFor(async () => (await aiStatus()) === 'none', 10000)
  check('P2 缓存', '缓存按范围区分：基线改成只看 2024 学年 → 这个范围还没有分析，显示「生成 AI 分析」', none && /生成 AI 分析/.test(await aiBtn('ai-run').innerText()))
  await pickOpt('compare-base', '之前的全部学年')
  check('P2 缓存', '切回默认范围，原来的缓存还在', await waitFor(async () => (await aiStatus()) === 'fresh', 10000))
}

// ───────── P2：只发给发起请求的窗口；取消；各种故障 ─────────
async function phaseP2Faults() {
  const { page, mock, app } = ctx
  const orig = dbAnalyses()[0]
  const sameCache = () => { const r = dbAnalyses(); return r.length === 1 && r[0].cache_key === orig.cache_key && r[0].markdown === orig.markdown && r[0].created_at === orig.created_at }

  // 第二个窗口：不该收到任何 ai:chunk
  await app.evaluate(({ BrowserWindow }, a) => { const w = new BrowserWindow({ show: false, webPreferences: { preload: a.preload, contextIsolation: true, sandbox: true } }); w.loadFile(a.html) }, { preload: path.join(root, 'out/preload/index.js'), html: path.join(root, 'out/renderer/index.html') })
  const w2 = await waitFor(async () => app.windows().find(w => w !== page), 15000)
  await w2.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  await w2.evaluate(() => { window.__ev = []; window.api.on('ai:chunk', e => window.__ev.push(e.type)) })
  await page.evaluate(() => { window.__ev = []; window.api.on('ai:chunk', e => window.__ev.push(e.type === 'error' ? `error(${e.partial?.length})` : e.type)) })
  mock.p2DelayMs = 30
  await runAi()
  await waitFor(async () => (await page.evaluate(() => window.__ev.includes('done'))), 40000)
  const ev1 = await page.evaluate(() => window.__ev), ev2 = await w2.evaluate(() => window.__ev)
  check('P2 事件', 'ai:chunk 只发给发起请求的窗口：发起方收到 start / delta… / done，另一个窗口 0 个事件', ev1[0] === 'start' && ev1.filter(x => x === 'delta').length > 3 && ev1.at(-1) === 'done' && ev2.length === 0, `发起方 ${ev1.length} 个，另一窗口 ${ev2.length} 个`)
  await w2.close()
  await waitFor(async () => app.windows().length === 1, 8000)
  mock.p2DelayMs = 0
  const regen1 = dbAnalyses()[0]
  Object.assign(orig, regen1)   // 之后以「重新生成后」的结果作为基准

  // ── 取消 ──
  mock.script([{ type: 'p2_slow', times: 1, delayMs: 250, only: 'p2' }])
  const n0 = mockReqs().length
  await runAi()
  await waitFor(async () => (await aiBtn('ai-running').count()) > 0, 10000)
  await sleep(1200)
  const partialLen = (await mdText()).length
  await aiBtn('ai-cancel').click()
  const cancelled = await waitFor(async () => (await T('ai-cancelled').count()) > 0, 10000)
  check('P2 取消', '生成中点「取消生成」：立即显示「已取消，没有保存结果」，已收到的部分内容灰显保留', cancelled && partialLen > 0 && (await T('ai-partial').count()) === 1 && (await aiBtn('ai-running').count()) === 0, `已收到 ${partialLen} 字`)
  check('P2 取消', '取消不会覆盖已缓存的结果（库里那一行原样不变），也没有再发第二次请求', sameCache() && mockReqs().length === n0 + 1, `${mockReqs().length - n0} 次新请求`)
  await shot('17-ai-cancelled')
  await sleep(800)
  check('P2 取消', '取消后界面不会被迟到的数据冲回「生成中」', (await aiBtn('ai-running').count()) === 0 && (await T('ai-cancelled').count()) === 1)
  await T('ai-cancelled').locator('xpath=..').locator('button', { hasText: '关闭提示' }).click().catch(() => {})
  mock.clearScript()

  // ── 中途断流：重试 3 次都断 → 失败，保留已收到的部分、不入库 ──
  const faultRun = async (script, want, name, extra = async () => true) => {
    mock.clearScript()
    mock.script(script)
    const n = mockReqs().length
    const t0 = Date.now()
    // 先关掉上一次的提示
    const dismiss = page.locator(`${CARD} button`, { hasText: '关闭提示' })
    if (await dismiss.count()) await dismiss.first().click()
    await runAi()
    const err = await waitFor(async () => (await T('ai-error').count()) > 0, 60000)
    const text = err ? await txt('ai-error') : ''
    await sleep(300)
    const ex = await extra()
    const evTypes = await page.evaluate(() => window.__ev.slice(-30).join(','))
    check('P2 故障', `${name}：失败时给出中文原因，不入库、不影响已缓存的结果`, err && want.test(text) && sameCache() && ex, `${text.slice(0, 90)}（${mockReqs().length - n} 次请求，${Math.round((Date.now() - t0) / 100) / 10} 秒；缓存未变 ${sameCache()}，附加条件 ${ex}，partial 元素 ${await T('ai-partial').count()}，entry 长度 ${await page.locator(`${CARD} [data-testid=ai-panel]`).getAttribute('data-entry-len')}；事件 ${evTypes}）`)
    return { n, ms: Date.now() - t0 }
  }
  let n = mockReqs().length
  await faultRun([{ type: 'p2_cut', times: 3, after: 4, only: 'p2' }], /数据流中断|无法连接/, '中途断流（3 次都断）', async () => (await T('ai-partial').count()) === 1)
  check('P2 故障', '断流时自动重试了 2 次（共 3 次请求），重试前把界面上半截内容清掉', mockReqs().length - n === 3, `${mockReqs().length - n}`)
  await shot('18-ai-error')
  // 断一次后重试成功：文字从头再来，不会重复拼接
  mock.clearScript()
  mock.script([{ type: 'p2_cut', times: 1, after: 4, only: 'p2' }])
  await page.evaluate(() => { window.__ev = [] })
  n = mockReqs().length
  await page.locator(`${CARD} button`, { hasText: '关闭提示' }).first().click().catch(() => {})
  await runAi()
  const okAfterCut = await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && mockReqs().length - n >= 2, 60000)
  const mdAfter = await mdText()
  const evs = await page.evaluate(() => window.__ev)
  check('P2 故障', '断流一次后重试成功：收到 reset 事件清空半截内容，最终文字完整且只出现一次（没有拼接重复）', okAfterCut && evs.includes('reset') && (mdAfter.match(/一、总体变化/g) ?? []).length === 1 && mockReqs().length - n === 2, `请求 ${mockReqs().length - n} 次，reset ${evs.filter(e => e === 'reset').length} 次`)
  Object.assign(orig, dbAnalyses()[0])
  // 「干净」的提前结束：服务端正常关闭连接，但既没发 finish_reason 也没发 [DONE]（网关/代理超时、服务商掐断时常见）。
  // 修复前：读流读到结尾就当成完整结果存库，界面显示「已缓存」；现在当作数据流中断（重试 / 报错），半截内容不入库
  n = mockReqs().length
  await faultRun([{ type: 'p2_eof', times: 3, after: 4, only: 'p2' }], /数据流意外结束/, '服务端正常关闭连接但没有结束标记（3 次都这样）', async () => (await T('ai-partial').count()) === 1)
  check('P2 故障', '干净 EOF：同样自动重试 2 次（共 3 次请求），最终失败、半截内容没有存进缓存、界面不显示「已缓存」', mockReqs().length - n === 3 && sameCache() && (await T('ai-cached').count()) === 0)
  mock.clearScript()
  mock.script([{ type: 'p2_eof', times: 1, after: 4, only: 'p2' }])
  await page.evaluate(() => { window.__ev = [] })
  n = mockReqs().length
  await page.locator(`${CARD} button`, { hasText: '关闭提示' }).first().click().catch(() => {})
  await runAi()
  const okAfterEof = await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && mockReqs().length - n >= 2, 60000)
  const mdEof = await mdText()
  check('P2 故障', '干净 EOF 一次后重试成功：丢弃半截内容、重新生成完整的一份（只出现一次「一、总体变化」），共 2 次请求', okAfterEof && (mdEof.match(/一、总体变化/g) ?? []).length === 1 && /五、下学期教学与复习建议/.test(mdEof) && mockReqs().length - n === 2)
  Object.assign(orig, dbAnalyses()[0])
  // 最后一行没有结尾换行（`data: [DONE]` 后直接关连接）：这是正常结束，不能被当成中断重试、白白多烧 token（复审 P2-N1）
  mock.clearScript()
  mock.script([{ type: 'p2_nonl', times: 1, only: 'p2' }])
  n = mockReqs().length
  await page.locator(`${CARD} button`, { hasText: '关闭提示' }).first().click().catch(() => {})
  await runAi()
  const okNonl = await waitFor(async () => (await aiBtn('ai-cached').count()) > 0, 60000)
  check('P2 故障', '最后一行没有结尾换行：当作正常结束，只发 1 次请求、没有重试，结果完整入库', okNonl && mockReqs().length - n === 1 && /五、下学期教学与复习建议/.test(await mdText()), `${mockReqs().length - n} 次请求`)
  Object.assign(orig, dbAnalyses()[0])
  // 空内容
  n = mockReqs().length
  await faultRun([{ type: 'empty', times: 2, only: 'p2' }], /空内容/, '模型返回空内容（重试一次仍为空）')
  check('P2 故障', '空内容：先同参数重试一次（共 2 次请求）再报错', mockReqs().length - n === 2, `${mockReqs().length - n}`)
  // 429
  const r429 = await faultRun([{ type: '429', retryAfter: 1, times: 3, only: 'p2' }], /请求太频繁|额度/, '限流 429')
  check('P2 故障', '429：遵守 Retry-After（两次间隔约 1 秒，总耗时 ≥ 2 秒），共 3 次请求', r429.ms >= 2000 && mockReqs().length - r429.n === 3, `${r429.ms} 毫秒`)
  // 超时（没有任何响应）与中途停住：把超时设成 2 秒
  await saveCfg(cfgFor(mock, { timeout_sec: 2 }))
  await faultRun([{ type: 'hang', ms: 30000, times: 3, only: 'p2' }], /超时/, '服务无响应（超时 2 秒）')
  await faultRun([{ type: 'p2_stall', after: 3, ms: 30000, times: 3, only: 'p2' }], /超时|中断/, '流到一半不再有数据（空闲超时）', async () => (await T('ai-partial').count()) === 1)
  await saveCfg(cfgFor(mock, { timeout_sec: 180 }))
  mock.clearScript()
  // 模型自造引用 / 小标题代码不在输入里
  mock.quirks = { p2: { badCite: true, badHeading: true } }
  await page.locator(`${CARD} button`, { hasText: '关闭提示' }).first().click().catch(() => {})
  await runAi()
  const warn = await waitFor(async () => (await T('ai-warning').count()) >= 2, 60000)
  const wtxt = warn ? (await T('ai-warning').allInnerTexts()).join(' | ') : ''
  const mdQ = await mdText()
  check('P2 校验', '模型自造的引用被移除并提示；小标题里的知识点代码不在输入数据里也给出提示', warn && /已移除 1 处无法核对的引用/.test(wtxt) && /ZZ\.NOT\.IN\.INPUT/.test(wtxt) && !/不存在的卷/.test(mdQ), wtxt)
  mock.quirks = {}
  mock.clearScript()
  await runAi()   // 重新生成一份干净的作为后续基准
  await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && (await T('ai-warning').count()) === 0, 60000)
  Object.assign(orig, dbAnalyses()[0])
}

// ───────── P2：数据 / 提示词变了 → 已过期，不自动重算 ─────────
async function phaseP2Stale() {
  const { page, mock } = ctx
  const n0 = mockReqs().length
  const row0 = dbAnalyses()[0]
  // 在审核里改了一道样本题的题干：done 的试卷回到待审核（离开统计）→ 数字变、样本题变
  // 抽屉开着时数据变了：抽屉上方的「目标 x/y 份」也要跟着变（抽屉只记知识点代码，数字每次从最新结果里取）
  await T('item-GR.TENSE.FUT').click()
  await T('drawer-stats').waitFor()
  const drawerBefore = await txt('drawer-stats')
  await page.evaluate(id => window.api.questions.update(id, { stem: 'E2E 改过的题干' }), ctx.qids.C2Q1)
  const drawerLive = await waitFor(async () => /1\/4 份/.test(await txt('drawer-stats')), 15000)
  check('抽屉', '抽屉开着时 C2 回到待审核：抽屉里的数字自动由「目标 2/5 份」变成「1/4 份」（不用关了重开）', /2\/5 份/.test(drawerBefore) && drawerLive, `${drawerBefore.slice(0, 40)} → ${await txt('drawer-stats').then(t => t.slice(0, 40))}`)
  await T('kp-drawer').locator('.ant-drawer-close').click()
  await T('kp-drawer').waitFor({ state: 'detached', timeout: 8000 })
  const stale = await waitFor(async () => (await T('ai-stale').count()) > 0, 15000)
  check('P2 过期', '数据变了（C2 回到待审核，目标学年只剩 4 份）：界面自动刷新，缓存标「已过期，可重新生成」并说明原因', stale && /已过期，可重新生成/.test(await txt('ai-stale')) && /统计数据或样本题有变化/.test(await txt('ai-stale')), stale ? await txt('ai-stale') : '')
  // 读状态时的「核对结果」记在缓存行里：数据修订号变了才重新核对，核对完记下新的修订号（之后再读就不用重算）
  const chk = withDb(ctx.ud, d => d.prepare('SELECT a.checked_rev, a.checked_sig, a.checked_json, r.rev FROM ai_analyses a, data_rev r WHERE r.id = 1').get())
  check('P2 过期', '核对结果按数据修订号缓存：缓存行记着核对时的修订号 = 当前修订号，结论是「过期（数据）」，之后再读状态不用重算整套统计', chk.checked_rev === chk.rev && JSON.parse(chk.checked_json).fresh === false && JSON.parse(chk.checked_json).reasons.includes('data') && !!chk.checked_sig, JSON.stringify(chk).slice(0, 160))
  const w4 = await waitFor(async () => (await T('sample-warning').count()) > 0 && /目标学年只有 4 份/.test(await txt('sample-warning')), 10000)
  check('同比', '目标学年恰好 4 份（C2 离开后）→ 立刻出现「样本有限」；边界：4 份有限、5 份不限', w4 && (await T('col-added').getAttribute('data-count')) === '1', w4 ? await txt('sample-warning') : '')
  await shot('19-ai-stale')
  await sleep(2500)
  check('P2 过期', '过期了也不会自动重新生成（2.5 秒后仍没有新请求，旧结果还在）', mockReqs().length === n0 && dbAnalyses()[0].cache_key === row0.cache_key && /总体变化/.test(await mdText()))
  // 审核确认回来：试卷恢复为 done，但题干已经是改过的 → 数据指纹仍不同 → 仍然过期
  await page.evaluate(id => window.api.questions.confirmPaper(id, false), ctx.ids.C2)
  await waitFor(async () => (await T('sample-warning').count()) === 0, 15000)
  check('P2 过期', '试卷重新确认后目标学年回到 5 份（样本提示消失）；样本题的题干变了 → 仍是「已过期」', (await T('ai-stale').count()) === 1 && mockReqs().length === n0)
  // 重新生成：提示词里用的是改过的题干
  await runAi()
  await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && (await T('ai-stale').count()) === 0, 60000)
  check('P2 过期', '点「重新生成」后：新的请求里带的是改过的题干，缓存恢复为新鲜', mockReqs().length === n0 + 1 && /E2E 改过的题干/.test(mockReqs().at(-1).user), `${mockReqs().length - n0} 次`)
  // 提示词改了 → 过期；恢复默认后实际发出的文本又和缓存时一致 → 又是新鲜的（缓存键是实际提示词文本的哈希，不靠人工维护的版本号）
  const sys = (await page.evaluate(() => window.api.ai.prompts())).items.find(p => p.id === 'p2_yoy' && p.part === 'system').text
  await page.evaluate(t => window.api.ai.savePrompt('p2_yoy', 'system', t), sys + '\n（E2E：追加一行）')
  const staleP = await waitFor(async () => (await T('ai-stale').count()) > 0, 15000)
  check('P2 过期', '改了 P2 提示词：缓存标「已过期」，原因是「提示词变了」，同样不自动重算', staleP && /提示词变了/.test(await txt('ai-stale')) && !/统计数据/.test(await txt('ai-stale')) && mockReqs().length === n0 + 1, staleP ? await txt('ai-stale') : '')
  await page.evaluate(() => window.api.ai.resetPrompt('p2_yoy', 'system'))
  check('P2 过期', '恢复默认提示词后，缓存键与已存的一致，又变回「已缓存」', await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && (await T('ai-stale').count()) === 0, 15000))
  // P2 提示词被改坏（占位符拼错）：不把 {{XXX}} 原样发给模型；界面说明原因，统计和旧缓存照常显示
  const n1 = mockReqs().length
  const userP = (await page.evaluate(() => window.api.ai.prompts())).items.find(p => p.id === 'p2_yoy' && p.part === 'user').text
  await page.evaluate(t => window.api.ai.savePrompt('p2_yoy', 'user', t.replace('{{FILTER_DESC}}', '{{FILTER_DESCX}}')), userP)
  const bad = await waitFor(async () => (await T('ai-blocked').count()) > 0 && /FILTER_DESCX/.test(await txt('ai-blocked')), 15000)
  const rawBad = await page.evaluate(() => window.api.ai.analyzeCompare({ filter: { grade: '4' }, target: 2025, base: 'before', level: 2 }, crypto.randomUUID()))
  check('P2 提示词', '提示词里有填不了的占位符：界面说明原因、旧结果仍在；强行生成会被拒绝，不会把「{{…}}」发给模型', bad && rawBad.ok === false && rawBad.code === 'bad_prompt' && /FILTER_DESCX/.test(rawBad.message) && mockReqs().length === n1, bad ? await txt('ai-blocked') : '')
  await page.evaluate(() => window.api.ai.resetPrompt('p2_yoy', 'user'))
  await waitFor(async () => (await T('ai-blocked').count()) === 0 && (await aiBtn('ai-cached').count()) > 0, 15000)
  const rej = await page.evaluate(t => window.api.ai.savePrompt('p2_yoy', 'user', t.replace('{{HOT}}', '')).then(() => 'resolved', e => String(e)), userP)
  check('P2 提示词', '保存 P2 提示词时缺少统计表占位符（{{HOT}}）会被拒绝', /缺少必需的占位符/.test(rej) && /HOT/.test(rej), rej.slice(-60))
  // 换模型：输出是上次那个模型写的，缓存仍然有效，但提示一下
  const m0 = mockReqs().length
  await saveCfg(cfgFor(mock, { model: 'mock-text-model-2' }))
  const modelTag = await waitFor(async () => (await aiBtn('ai-cached').count()) > 0 && /当前设置的模型已换/.test(await txt('ai-cached')), 15000)
  check('P2 过期', '换了模型：缓存仍有效（输出是旧模型写的，界面写着模型名），并提示「当前设置的模型已换」；不自动重算', modelTag && mockReqs().length === m0, modelTag ? await txt('ai-cached') : '')
  await saveCfg(cfgFor(mock))
  void mock
}

// ───────── 重难点 ─────────
async function phaseHot() {
  const { page } = ctx
  // 重难点页同样有范围说明：六年级的 H1 与副本 H1d 是同一个文件，只算一份并提示已合并
  await setFilter({ grade: '6' }, '#/dashboard')
  await page.getByRole('tab', { name: '重难点' }).click()
  await T('hot-table').waitFor()
  check('重难点', '重难点页也显示范围说明：六年级有 1 份重复导入（H1d）已合并', await waitFor(async () => (await T('not-counted').count()) > 0 && /有 1 份内容重复的试卷/.test(await txt('not-counted')), 10000), (await T('not-counted').count()) ? await txt('not-counted') : '')
  await setFilter({ grade: '4' }, '#/dashboard')
  await page.getByRole('tab', { name: '重难点' }).click()
  await T('hot-table').waitFor()
  await waitFor(async () => (await T('hot-table').locator('tbody tr[data-testid^=hot-row-]').count()) > 0, 10000)
  const g4 = naive.counted({ grade: '4' })
  const want = naive.hot(ctx.tree, g4, 2)
  const got = await T('hot-table').locator('tbody tr[data-testid^=hot-row-]').evaluateAll(els => els.map(e => [e.dataset.testid.replace('hot-row-', ''), Number(e.dataset.priority)]))
  check('重难点', '排序 = 出现率 × 分值占比 × (1 + 易错率) 的逐条循环重算；综合得分数值一致', JSON.stringify(got.map(x => x[0])) === JSON.stringify(want.map(x => x.code)) && got.every((x, i) => Math.abs(x[1] - want[i].priority) < 1e-9), got.slice(0, 3).map(x => `${x[0]}=${x[1].toFixed(4)}`).join(' '))
  const past = got.find(x => x[0] === 'GR.TENSE.PAST')
  // 手算：出现率 7/11，分值占比 14/97（7 道主知识点题×2 分；C1 第 4 题的次知识点不加分值），易错率 2/8（题数 8 含那道次知识点题）→ 7/11 × 14/97 × (1 + 2/8)
  check('重难点', '手算校验「一般过去时」综合得分 = 7/11 × 14/97 × (1+2/8) ≈ 0.1148（次知识点题只增加题数，不增加分值）', Math.abs(past[1] - (7 / 11) * (14 / 97) * (1 + 2 / 8)) < 1e-9, String(past[1]))
  check('重难点', '页面写明排序公式；难度、易错标「估计」', /综合得分 = 出现率 × 分值占比 × \(1 \+ 1\.0 × 易错率\)/.test(await txt('hot-formula')) && (await T('hot-table').locator('[data-testid=est-tag]').count()) >= 2)
  await T('hot-row-GR.TENSE.PAST').locator('.ant-table-row-expand-icon').click()
  await T('hot-detail-GR.TENSE.PAST').waitFor()
  const detail = await txt('hot-detail-GR.TENSE.PAST')
  check('重难点', '展开：易错原因「规则变化加-ed ×2」（手算 A1Q3、C1Q1）与 3 道典型题（易错优先）', /规则变化加-ed ×2/.test(detail) && (await T('hot-detail-GR.TENSE.PAST').locator('[data-testid=question-card]').count()) === 3 && /易错原因（估计）：规则变化加-ed/.test(detail), detail.slice(0, 80))
  const row = await txt('hot-row-GR.TENSE.PAST')
  check('重难点', '「一般过去时」行：出现率 7/11 份 · 63.6%，易错率 2/8 · 25%', /7\/11 份 · 63\.6%/.test(row) && /2\/8 · 25%/.test(row), row)
  await shot('20-hot')
  await T('hot-level').getByText('三级知识点').click()
  const want3 = naive.hot(ctx.tree, g4, 3).map(x => x.code)
  await waitFor(async () => (await T('hot-table').locator('tbody tr[data-testid^=hot-row-GR\\.TENSE\\.PAST\\.REG]').count()) > 0, 10000)
  const got3 = await T('hot-table').locator('tbody tr[data-testid^=hot-row-]').evaluateAll(els => els.map(e => e.dataset.testid.replace('hot-row-', '')))
  check('重难点', '切到三级知识点：排序同样与重算一致', JSON.stringify(got3) === JSON.stringify(want3.slice(0, 20)), got3.slice(0, 3).join(','))
  // 没有任何分值 → 改用题数占比并说明（用只含 H1/H1d 以外…此处用 R1 之外的范围无法造；该逻辑由单测 stats-core.test 覆盖）
}

// ───────── 实时更新：改标注、新卷子审核完 ─────────
async function phaseRealtime() {
  const { page, mock } = ctx
  await setFilter({ grade: '4' }, '#/dashboard')
  await T('dist-papers').waitFor()
  check('实时更新', '起点：看板显示 11 份试卷；名词复数出现 7/11', await waitText1('dist-papers', '11 份') && (await T('freq-GR.NOUN.PLURAL').getAttribute('data-papers')) === '7')
  // 1) 在审核里改了一道题的标注：done 的试卷回到待审核 → 看板自动少一份
  const q = ctx.qids.C1Q2   // 名词复数（不规则）→ 改成一般过去时（规则）
  await page.evaluate(id => window.api.questions.update(id, { kp_main: 'GR.TENSE.PAST.REG' }), q)
  const dropped = await waitText1('dist-papers', '10 份')
  check('实时更新', '改了标注（C1 回到待审核）：不用刷新，看板试卷数 11 → 10', dropped, await txt('dist-papers'))
  await page.evaluate(id => window.api.questions.confirmPaper(id, false), ctx.ids.C1)
  const back = await waitText1('dist-papers', '11 份') && await waitFor(async () => (await T('freq-GR.NOUN.PLURAL').getAttribute('data-papers')) === '6', 10000)
  check('实时更新', '重新确认后：试卷数回到 11，且改过的标注生效（名词复数 7 → 6/11）——全程没有手动刷新', back)
  await page.evaluate(id => window.api.questions.update(id, { kp_main: 'GR.NOUN.PLURAL.IRR' }), q)
  await waitText1('dist-papers', '10 份')
  await page.evaluate(id => window.api.questions.confirmPaper(id, false), ctx.ids.C1)
  check('实时更新', '把标注改回去：数字恢复（11 份、名词复数 7）', await waitText1('dist-papers', '11 份') && await waitFor(async () => (await T('freq-GR.NOUN.PLURAL').getAttribute('data-papers')) === '7', 10000))

  // 2) 真实流水线导入一份新卷子：提取 → mock AI 解析 → 待审核 →（看板开着）确认 → 自动出现
  mock.reset(); mock.apiKey = SECRET
  await saveCfg(cfgFor(mock), SECRET)
  const pdf = path.join(root, 'samples/g4-2026.pdf')
  const tmp = path.join(work, 'g4-2026-m3.pdf')
  L.copyWithTag(pdf, tmp, 'm3-realtime')
  await dropFiles(page, [tmp])
  const p = await waitStatus(page, 'g4-2026-m3.pdf', ['reviewing', 'failed'], 240000)
  const meta = p && withDb(ctx.ud, d => d.prepare('SELECT grade, school_year_start, status FROM papers WHERE id = ?').get(p.id))
  check('实时更新', '新卷子走完提取与 AI 解析，进入待审核（它还不计入统计）', p?.status === 'reviewing', JSON.stringify(meta))
  await setFilter({ grade: '4' }, '#/dashboard')
  await T('dist-papers').waitFor()
  const stillOld = await waitText1('dist-papers', '11 份')
  const nq = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(p.id).c)
  check('实时更新', '待审核的新卷子没有计入：看板仍是 11 份、44 题', stillOld && /44 道/.test(await txt('dist-questions')) && nq === 36, `新卷 ${nq} 题`)
  await page.evaluate(id => window.api.questions.confirmPaper(id, true), p.id)
  const grown = await waitText1('dist-papers', '12 份', 20000)
  check('实时更新', '看板开着时审核确认新卷子：不用刷新，试卷数 11 → 12，题目数 44 → 80', grown && await waitFor(async () => /80 道/.test(await txt('dist-questions')), 10000), `${await txt('dist-papers')} / ${await txt('dist-questions')}`)
  await shot('21-realtime')
  // 总览页同样自动更新（页面上没有手动刷新入口）
  await goto('#/overview')
  check('实时更新', '总览页同样反映新卷子（试卷 12 份）', await waitStat('card-papers', 12))
}
const waitText1 = (id, want, ms = 15000) => waitFor(async () => (await T(id).count()) > 0 && (await txt(id)).includes(want), ms)

// ───────── IPC 参数校验（zod）与事件通道 ─────────
async function phaseValidation() {
  const { page } = ctx
  const rej = (fn, args) => page.evaluate(([f, a]) => { const [ns, m] = f.split('.'); return window.api[ns][m](...a).then(() => 'resolved', e => String(e.message || e)) }, [fn, args])
  const cases = [
    ['年级不在 1–6', 'stats.distribution', [{ grade: '9' }]],
    ['出现未知字段（strict）', 'stats.overview', [{ foo: 1 }]],
    ['开关不是布尔', 'stats.distribution', [{ includeReviewing: 'yes' }]],
    ['学年超范围', 'stats.compare', [{}, 1999, 'before']],
    ['基线不是 before 或学年', 'stats.compare', [{}, 2025, 'after']],
    ['层级超范围', 'stats.matrix', [{}, 7]],
    ['层级不是整数', 'stats.hot', [{}, 1.5]],
    ['知识点代码格式不对', 'stats.questions', [{}, { kind: 'filter' }, 'a; DROP TABLE kps']],
    ['题目范围的类型未知', 'stats.questions', [{}, { kind: 'x' }, 'GR']],
    ['limit 超上限', 'stats.questions', [{}, { kind: 'filter' }, 'GR', 5000]],
    ['请求号不是 uuid', 'ai.analyzeCompare', [{ filter: {}, target: 2025, base: 'before', level: 2 }, 'not-a-uuid']],
    ['同比范围缺目标学年', 'ai.compareAnalysis', [{ filter: {}, base: 'before', level: 2 }]],
    ['取消的请求号不是 uuid', 'ai.cancel', ['x']],
    ['同比的「按学期对齐」不是布尔', 'stats.compare', [{}, 2025, 'before', 2, 'yes']],
    ['范围说明接口的筛选带未知字段', 'stats.notes', [{ excludeDuplicates: true }]],
    ['筛选栏状态不是合法的筛选对象（通用设置接口）', 'settings.set', ['ui_stats_filter', { grade: '9' }]]
  ]
  const res = []
  for (const [name, fn, args] of cases) res.push([name, await rej(fn, args)])
  check('IPC 校验', `统计与 P2 接口的参数全部用 zod 校验：${cases.length} 种非法入参都被拒绝（不是静默当作默认值）`, res.every(([, r]) => r !== 'resolved'), res.filter(([, r]) => r === 'resolved').map(x => x[0]).join(',') || '全部拒绝')
  const ok = await page.evaluate(async () => {
    const f = { grade: '4' }
    const [o, d, m, h, c] = await Promise.all([window.api.stats.overview(f), window.api.stats.distribution(f), window.api.stats.matrix(f, 2), window.api.stats.hot(f, 2), window.api.stats.compare(f, 2025, 'before', 2)])
    return [o.cards.papers, d.papers, m.level, h.level, c.level]
  })
  check('IPC 校验', '合法入参正常返回', JSON.stringify(ok) === JSON.stringify([12, 12, 2, 2, 2]), JSON.stringify(ok))
  const cancelUnknown = await page.evaluate(() => window.api.ai.cancel('00000000-0000-4000-8000-000000000999'))
  check('IPC 校验', '取消一个不存在的请求：返回 false，不抛错', cancelUnknown === false)
  // 渲染端拿不到密钥：P2 的接口返回里没有
  const dump = JSON.stringify(await page.evaluate(() => window.api.ai.compareAnalysis({ filter: { grade: '4' }, target: 2025, base: 'before', level: 2 })))
  check('密钥安全', 'P2 状态接口的返回里没有密钥；全部 ai_analyses / 用量表 / 进程输出里也没有', !dump.includes(SECRET) && !JSON.stringify(dbAnalyses()).includes(SECRET) && !L.procOutput.join('').includes(SECRET))
  void waitStat
  check('页面', '整个测试过程中页面控制台没有报错', (ctx.consoleErrors ?? []).length === 0, JSON.stringify(ctx.consoleErrors ?? []).slice(0, 300))
}

const phases = [phaseP2Basic, phaseP2Cache, phaseP2Faults, phaseP2Stale, phaseHot, phaseRealtime, phaseValidation]
module.exports = { phases, phaseP2Basic, phaseP2Cache, phaseP2Faults, phaseP2Stale, phaseHot, phaseRealtime, phaseValidation }
