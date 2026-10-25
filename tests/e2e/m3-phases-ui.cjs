// M3 端到端：分析看板（筛选、分布、细目表、同比、抽屉截图、P2 流式分析、重难点、总览、实时更新）。
// 数据：fixtures-m3.cjs 直接往数据库造 3 个学年、多个年级的卷子；AI 走 tests/mock-ai 的本地服务。
// 期望值：关键数字写死成手算结果（注释里有推导），其余用 naive.cjs 的逐条循环独立重算，不拿应用里的 SQL 再算一遍。
// （阶段模块：由 run-m3.cjs 依次调用；用法：npm run test:e2e:m3）
const L = require('./lib.cjs')
const { startMock } = require('../mock-ai/server.cjs')
const p2mock = require('../mock-ai/p2.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const naive = require('./naive.cjs')
const { check, sleep, waitFor, launch, dropFiles, waitStatus, withDb, docsPrompt, root, fs, path, os } = L
const { execFileSync } = require('node:child_process')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-m3-'))
const shots = path.join(root, 'docs/screenshots')
fs.mkdirSync(shots, { recursive: true })
const SECRET = 'sk-e2e-M3-SECRET-20261025'
const pageImg = path.join(root, 'samples/g4-2025-page1.png')
const ctx = { ud: path.join(work, 'userData'), mock: null, app: null, page: null, ids: null, qids: null, tree: null, bbox: null }
const clean = e => String(e).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '')
const shot = async (name) => ctx.page.screenshot({ path: path.join(shots, `m3-${name}.png`) })

const cfgFor = (mock, over = {}) => ({ provider: 'custom', base_url: mock.baseUrl, model: 'mock-text-model', vision_model: 'mock-vision-model', concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 8192, ...over })
const saveCfg = (cfg, key) => ctx.page.evaluate(([c, k]) => (k === undefined ? window.api.ai.saveConfig(c) : window.api.ai.saveConfig(c, k)), [cfg, key])

const T = id => ctx.page.locator(`[data-testid="${id}"]`)
const txt = async id => (await T(id).first().innerText()).replace(/\s+/g, ' ').trim()
const stat = async id => (await ctx.page.locator(`[data-testid="${id}"] .ant-statistic-content-value`).first().innerText()).trim()
const goto = async hash => { await ctx.page.evaluate(h => { location.hash = h }, hash) }
const pickOpt = async (testid, optionText) => {
  await T(testid).click()
  await ctx.page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: optionText }).first().click()
}
const clearSel = async testid => {
  await T(testid).hover()
  await T(testid).locator('.ant-select-clear').click({ force: true })
}
const waitText = (id, want, ms = 15000) => waitFor(async () => (await T(id).count()) > 0 && (await txt(id)).includes(want), ms)
const waitStat = (id, want, ms = 15000) => waitFor(async () => (await T(id).count()) > 0 && (await stat(id)) === String(want), ms)
/** 直接写设置并重载页面，让阶段不依赖前一个阶段留下的筛选状态（单独调试某个阶段时也能跑） */
const setFilter = async (f, hash) => {
  await ctx.page.evaluate(v => window.api.settings.set('ui_stats_filter', v), f)
  await ctx.page.reload()
  await ctx.page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 }).catch(() => {})
  await goto(hash)
  await T('filter-bar').waitFor()
}
const near = (a, b, eps = 0.003) => Math.abs(a - b) <= eps
const fmtPct = v => `${Math.round(v * 1000) / 10}%`

// ───────── 阶段 0：迁移 v8、造夹具 ─────────
async function phaseSetup() {
  ctx.mock = await startMock({ apiKey: SECRET })
  // 先启动一次让应用建好 v6 库，再关掉写夹具
  let r = await launch({ userDataDir: ctx.ud })
  await r.app.close()
  withDb(ctx.ud, d => {
    const uv = d.prepare('PRAGMA user_version').get().user_version
    const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(x => x.name)
    const cols = d.prepare('PRAGMA table_info(ai_analyses)').all().map(x => x.name)
    const trg = d.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(x => x.name)
    check('迁移 v8', `全新库升到 v${uv}：v6 的 3 个统计索引与 ai_analyses 缓存表；v7 的数据修订号表与缓存核对列；v8 把 papers / questions / question_kps 的触发器重建成带 WHEN 条件的（共 15 个触发器）`, uv === 8 && trg.filter(n => n.startsWith('trg_rev_')).length === 15 && d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_rev_%' AND (name LIKE '%papers%' OR name LIKE '%questions%' OR name LIKE '%question_kps%') AND sql LIKE '%WHEN%'").get().c === 9 && !!d.prepare("SELECT 1 FROM data_rev WHERE id = 1").get() && ['template_sig', 'checked_rev', 'checked_sig', 'checked_json'].every(c => cols.includes(c)) && ['idx_question_kps_kp', 'idx_papers_stats', 'idx_questions_paper_qtype'].every(i => idx.includes(i)) && ['scope_key', 'cache_key', 'prompt_version', 'fingerprint', 'markdown'].every(c => cols.includes(c)), `v${uv}`)
    ctx.tree = naive.makeTree(d.prepare('SELECT code, parent_code, level, name FROM kps').all())
  })
  // 用真实 Vision OCR 找到页面里第 3 题那一行的位置，作为 C2 第 1 题的定位框（截图位置能和它对照）
  const ocr = JSON.parse(execFileSync(path.join(root, 'native/macos/bin/ewb-ocr'), [pageImg], { encoding: 'utf8', maxBuffer: 20 << 20 }).replace(/^\uFEFF/, ''))
  const line = t => ocr.lines.find(l => l.text.startsWith(t))
  const l3 = line('3. A. skirt')
  if (!l3) throw new Error('OCR 没找到第 3 题那一行')
  const r4 = v => Math.round(v * 10000) / 10000
  ctx.bbox = [r4(l3.x - 0.01), r4(l3.y - 0.004), r4(l3.w + 0.02), r4(l3.h + 0.008)]
  ctx.pageSize = { width: ocr.width, height: ocr.height }
  const s = seed(ctx.ud, { bboxes: { C2Q1: ctx.bbox }, pageImage: pageImg, pageSize: ctx.pageSize })
  ctx.ids = s.ids; ctx.qids = s.qids
  r = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, r)
  check('夹具', `直接往库里造了 ${SPEC.length} 份卷子、${SPEC.reduce((n, p) => n + p.q.length, 0)} 道题（3 个学年 × 多个年级）`, withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM papers').get().c) === SPEC.length)
}

// ───────── 阶段 1：总览 + 全局筛选 + 口径开关 ─────────
async function phaseOverview() {
  const { page } = ctx
  await goto('#/overview')
  await T('card-papers').waitFor()
  await waitStat('card-papers', 16)
  // 18 份 = 四年级 A1–A3 B1–B3 C1–C5（11）+ 五年级 G1–G4（4）+ 六年级 H1（1；H1d 是它的重复副本，同一个文件只算一份）+ 二年级 K1d、K2d（2；K1d 是待审核原件 K1 的副本，K1 不可见所以 K1d 顶上；K2d 的原件已删除）；
  // 待审核 R1 与 K1、失败 F1、刚导入 I1 不计入
  const all = naive.counted({})
  check('总览', '数字卡：试卷 18 份（手算：11+4+1+2），题目 58 道（手算：44+8+2+4），涉及知识点 16 个，待审核 2 份（R1、K1）', all.length === 18 && (await stat('card-papers')) === '18' && (await stat('card-questions')) === '58' && (await stat('card-kps')) === '16' && (await stat('card-pending')) === '2', [await stat('card-papers'), await stat('card-questions'), await stat('card-kps'), await stat('card-pending')].join('/'))
  check('总览', '题目数卡片旁显示「分值覆盖 x/y 题」（58 题里 B2 第 4 题、C3 第 2 题没有分值 → 56/58）', /分值覆盖 56\/58 题/.test(await txt('coverage')), await txt('coverage'))
  // Top 10
  const t = ctx.tree
  const tbl = naive.nodeTable(t, all)
  const wantTop = [...tbl].filter(([c]) => t.level.get(c) === 2).sort((a, b) => b[1].papers.size - a[1].papers.size || b[1].qs.size - a[1].qs.size || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([c, e]) => [c, e.papers.size])
  const gotTop = await T('top10').locator('[data-testid^=top-]').evaluateAll(els => els.map(e => [e.dataset.testid.replace('top-', ''), Number(e.dataset.papers), Number(e.dataset.rank)]))
  check('总览', '常考 Top 10（二级知识点）与逐条循环重算的结果一致（含并列时的次序），第 1 名是「细节理解」15/18 份（手算：A×3 B×3 C×5 G1 G4 K1d K2d）', JSON.stringify(gotTop.map(x => [x[0], x[1]])) === JSON.stringify(wantTop) && gotTop[0][0] === 'RD.DETAIL' && gotTop[0][1] === 15 && gotTop.every((x, i) => x[2] === i + 1), JSON.stringify(gotTop.slice(0, 4)))
  // 本学年新增：最新学年 2025，之前所有学年里没出现过的二级知识点只有「一般将来时」（C2、C5、G3 共 3 份，2025 学年共 5+1+1=7 份：C1–C5、G3、H1，H1d 是重复副本不另算）
  check('总览', '本学年新增知识点：2025-2026 学年只有「一般将来时」3/7 份', (await T('new-this-year').count()) === 1 && (await T('new-GR.TENSE.FUT').count()) === 1 && (await T('new-this-year').locator('[data-testid^=new-G]').count()) === 1 && /一般将来时 3\/7/.test(await txt('new-GR.TENSE.FUT')) && /2025-2026学年/.test(await txt('new-this-year')), await txt('new-this-year'))
  // 最近导入：按创建时间倒序，包含所有状态
  const wantRecent = SPEC.map((p, i) => [p, i]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => ctx.ids[p.key])
  const gotRecent = await T('recent').locator('[data-testid^=recent-]').evaluateAll(els => els.map(e => e.dataset.testid.replace('recent-', '')))
  check('总览', '最近导入：最新 8 份按导入时间倒序（含待审核、失败、刚导入的），能看到状态', JSON.stringify(gotRecent) === JSON.stringify(wantRecent) && /失败/.test(await txt(`recent-${ctx.ids.F1}`)) && /待审核/.test(await txt(`recent-${ctx.ids.R1}`)), gotRecent.length + ' 行')
  check('总览', '范围说明：2 份待审核没有计入；有 1 份内容重复的试卷（H1d）已合并，同一文件只算一份', /2 份待审核的试卷没有计入/.test(await txt('not-counted')) && /有 1 份内容重复的试卷（同一文件导入了多份）已合并/.test(await txt('not-counted')), await txt('not-counted'))
  await shot('01-overview')

  // 各筛选维度：逐个用界面选，卡片上的试卷数 = 手算 / 逐条循环的结果
  const steps = [
    ['年级=四年级', async () => pickOpt('filter-grade', '四年级'), { grade: '4' }, 11],   // A3+B3+C5
    ['再选学期=下', async () => pickOpt('filter-semester', '下学期'), { grade: '4', semester: '下' }, 8],   // A1 A2 B1 B2 C1 C2 C3 C4
    ['再选学年=2025-2026', async () => pickOpt('filter-year', '2025-2026'), { grade: '4', semester: '下', school_year_start: 2025 }, 4],   // C1–C4
    ['再选考试类型=期末', async () => pickOpt('filter-exam', '期末'), { grade: '4', semester: '下', school_year_start: 2025, exam_type: '期末' }, 4],
    ['再选教材=人教PEP', async () => pickOpt('filter-textbook', '人教PEP'), { grade: '4', semester: '下', school_year_start: 2025, exam_type: '期末', textbook: '人教PEP' }, 3],   // C1 C2 C3
    ['再选地区=北京', async () => pickOpt('filter-region', '北京'), { grade: '4', semester: '下', school_year_start: 2025, exam_type: '期末', textbook: '人教PEP', region: '北京' }, 2]   // C1 C2
  ]
  for (const [name, act, f, hand] of steps) {
    await act()
    const want = naive.counted(f).length
    const ok = await waitStat('card-papers', hand)
    check('筛选栏', `${name} → 试卷 ${hand} 份（手算），与逐条循环重算（${want}）一致，总览数字随之变化`, ok && want === hand, await stat('card-papers'))
  }
  await shot('02-filtered')
  await T('filter-reset').click()
  check('筛选栏', '「清除筛选」后回到 18 份', await waitStat('card-papers', 18))
  // 总览的「本学年新增」也带样本量提示：五年级目标学年只有 1 份、之前学年（按学期对齐后）2 份 → 「样本有限」，免得把「还没考到」当成新增
  await pickOpt('filter-grade', '五年级')
  const nl = await waitFor(async () => (await T('new-limited').count()) > 0, 10000)
  check('总览', '本学年新增知识点带样本提示：五年级目标学年 1 份、之前学年 2 份 → 「样本有限」', nl && /本学年只有 1 份卷子/.test(await txt('new-limited')) && /之前学年只有 2 份/.test(await txt('new-limited')) && (await stat('card-papers')) === '4', nl ? await txt('new-limited') : '')
  await T('filter-reset').click()
  await waitStat('card-papers', 18)
  // 重复导入：同一个文件导入了多份，默认只算一份；「包含重复导入」打开后每份都算
  await pickOpt('filter-grade', '六年级')
  check('筛选栏', '六年级：H1 与它的重复副本 H1d 是同一个文件 → 默认只算 1 份，并提示「已合并」', await waitStat('card-papers', 1) && /有 1 份内容重复的试卷/.test(await txt('not-counted')) && naive.counted({ grade: '6' }).length === 1, await txt('not-counted'))
  await T('filter-dup').click()
  check('筛选栏', '打开「包含重复导入（会重复计数）」→ 2 份，提示改成「会被重复计数」', await waitStat('card-papers', 2) && naive.counted({ grade: '6', includeDuplicates: true }).length === 2 && /已包含重复导入/.test(await txt('not-counted')), await txt('not-counted'))
  await T('filter-dup').click()
  await waitStat('card-papers', 1)
  // 二年级：原件待审核 + 已确认的副本；原件已删除的孤儿副本——副本能顶上，一份卷子不会因为「是副本」而消失
  await T('filter-reset').click()
  await pickOpt('filter-grade', '二年级')
  check('筛选栏', '二年级：原件 K1 待审核、副本 K1d 已确认 → K1d 顶上算 1 份；K2d 的原件已删除 → 算 1 份；共 2 份（修复前打开开关会得到 0）', await waitStat('card-papers', 2) && naive.counted({ grade: '2' }).length === 2)
  await T('filter-reviewing').click()
  check('筛选栏', '再打开「含待审核」：K1 与 K1d 都可见，代表卷取「已确认的」K1d（不是更早但未确认的 K1）→ 仍是 2 份（不是 3 份）', await waitStat('card-papers', 2) && naive.counted({ grade: '2', includeReviewing: true }).length === 2)
  await T('filter-dup').click()
  check('筛选栏', '再打开「包含重复导入」→ K1、K1d、K2d 都算 → 3 份', await waitStat('card-papers', 3) && naive.counted({ grade: '2', includeReviewing: true, includeDuplicates: true }).length === 3)
  await T('filter-dup').click(); await T('filter-reviewing').click()
  await waitStat('card-papers', 2)
  // 无数据范围：给出空状态引导
  await T('filter-reset').click()
  await pickOpt('filter-grade', '一年级')
  check('总览', '当前筛选下没有试卷 → 空状态说明（不是一片空白或 NaN）', await waitFor(async () => (await T('empty-stats').count()) > 0, 10000) && /没有已确认的试卷/.test(await txt('empty-stats')))
  await T('filter-reset').click()

  // 计入范围开关：待审核
  await waitStat('card-papers', 18)
  await T('filter-reviewing').click()
  const bannerOk = await waitFor(async () => (await T('reviewing-banner').count()) > 0, 8000)
  check('口径开关', '打开「含待审核」：出现醒目的黄色提示条，说明实际计入了 1 份待审核（R1），另有 1 份（K1）因已确认的副本顶替而没有重复计入', bannerOk && /包含尚未确认的 AI 结果/.test(await txt('reviewing-banner')) && /1 份待审核的试卷已计入/.test(await txt('reviewing-banner')) && /另有 1 份待审核的卷子因同一文件已有别的代表卷/.test(await txt('reviewing-banner')) && !/2 份待审核/.test(await txt('reviewing-banner')), bannerOk ? await txt('reviewing-banner') : '')
  check('口径开关', '开关打开后试卷数 18 → 19（R1 计入；已确认的副本 K1d 继续作代表，K1 让位，数量不变），题目 58 → 60；失败的 F1 与刚导入的 I1 仍不计入', await waitStat('card-papers', 19) && (await stat('card-questions')) === '60' && naive.counted({ includeReviewing: true }).length === 19, `${await stat('card-papers')}/${await stat('card-questions')}`)
  await shot('03-include-reviewing')
  const saved = await page.evaluate(() => window.api.settings.get('ui_stats_filter'))
  check('筛选栏', '筛选条件写进了设置（ui_stats_filter），含「含待审核」开关', saved?.includeReviewing === true, JSON.stringify(saved))
  await T('filter-reviewing').click()
  check('口径开关', '关闭后提示条消失，回到 18 份', await waitFor(async () => (await T('reviewing-banner').count()) === 0, 8000) && await waitStat('card-papers', 18))
  // 持久化：设年级=四年级，下面重启后检查
  await pickOpt('filter-grade', '四年级')
  await waitStat('card-papers', 11)
  // 两个「计入范围」开关写进设置；重启后下面检查它们回到关闭（只有年级这类筛选条件被记住）
  await T('filter-reviewing').click()
  await T('filter-dup').click()
  await waitStat('card-papers', 12)
  const saved2 = await page.evaluate(() => window.api.settings.get('ui_stats_filter'))
  check('筛选栏', '设置里记着 {年级 4、含待审核、包含重复导入}（重启前）', saved2?.grade === '4' && saved2.includeReviewing === true && saved2.includeDuplicates === true, JSON.stringify(saved2))
}

// ───────── 阶段 2：重启后筛选被记住 ─────────
async function phaseRestart() {
  await ctx.app.close()
  const r = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, r)
  await goto('#/dashboard')
  await T('filter-bar').waitFor()
  const okSel = await waitFor(async () => /四年级/.test(await txt('filter-grade')), 10000)
  check('筛选栏', '重启应用后，上次的筛选（年级=四年级）还在筛选栏里', okSel, await txt('filter-grade'))
  check('筛选栏', '但两个「计入范围」开关（含待审核、包含重复导入）每次启动回到关闭——安全的默认是只统计已确认、重复只算一份', (await T('filter-reviewing').getAttribute('aria-checked')) === 'false' && (await T('filter-dup').getAttribute('aria-checked')) === 'false' && (await T('reviewing-banner').count()) === 0)
  check('筛选栏', '重启后看板直接按记住的筛选取数（分布页签试卷数 = 11）', await waitText('dist-papers', '11 份'), await txt('dist-papers').catch(() => ''))
  await goto('#/overview')
  check('筛选栏', '总览页同样受记住的筛选控制（试卷 11 份）', await waitStat('card-papers', 11))
}

// ───────── 阶段 3：分布页签 ─────────
async function phaseDistribution() {
  const { page } = ctx
  const t = ctx.tree
  await setFilter({ grade: '4' }, '#/dashboard')
  await T('dist-papers').waitFor()
  const g4 = naive.counted({ grade: '4' })
  const tot = naive.totals(g4)
  // 手算：四年级 11 份、44 题；总分 = A 9+9+10 + B 9+7+9 + C 10+9+7+9+9 = 97；分值覆盖 42/44（B2 第 4 题、C3 第 2 题无分值）
  check('分布', '汇总：试卷 11 份、题目 44 道、总分 97，「分值覆盖 42/44 题」（手算）', tot.papers === 11 && tot.questions === 44 && tot.totalScore === 97 && tot.scored === 42 && /11 份/.test(await txt('dist-papers')) && /44 道/.test(await txt('dist-questions')) && /97/.test(await txt('dist-total-score')) && /分值覆盖 42\/44 题/.test(await txt('coverage')), (await txt('dist-summary')))
  const tbl = naive.nodeTable(t, g4)

  // treemap：一级节点，面积 = 主知识点分值
  const cellsOf = () => T('treemap').locator('[data-testid^=treemap-cell-]').evaluateAll(els => els.map(e => ({ id: e.dataset.testid.replace('treemap-cell-', ''), v: Number(e.dataset.value), drill: e.dataset.drillable === '1', rate: e.dataset.rate })))
  const wantL1 = [...tbl].filter(([c, e]) => t.level.get(c) === 1 && e.primScore > 0).map(([c, e]) => [c, e.primScore]).sort()
  let cells = await cellsOf()
  check('treemap', '一级节点格子的面积值 = 逐条循环重算的主知识点分值；「阅读理解」= 35（手算：细节题 11 份×3 分 + 判断正误 C5 的 2 分）', JSON.stringify(cells.map(c => [c.id, c.v]).sort()) === JSON.stringify(wantL1) && cells.find(c => c.id === 'RD').v === 35, JSON.stringify(cells.map(c => [c.id, c.v])))
  const rd = cells.find(c => c.id === 'RD')
  check('treemap', '颜色深浅对应出现率：「阅读理解」出现率 100%', Number(rd.rate) === 1)
  // 格子占的面积比例与值成正比（取 DOM 里的真实位置）
  const geo = await T('treemap').evaluate(el => {
    const W = el.getBoundingClientRect(); const out = {}
    for (const c of el.querySelectorAll('[data-testid^=treemap-cell-]')) { const r = c.getBoundingClientRect(); out[c.dataset.testid.replace('treemap-cell-', '')] = { a: (r.width * r.height) / (W.width * W.height), v: Number(c.dataset.value) } }
    return out
  })
  const sumV = Object.values(geo).reduce((s, x) => s + x.v, 0)
  check('treemap', '格子面积占比与值成正比（取页面里的真实尺寸，误差 < 1%）', Object.values(geo).every(x => near(x.a, x.v / sumV, 0.01)), JSON.stringify(Object.fromEntries(Object.entries(geo).map(([k, x]) => [k, Math.round(x.a * 1000) / 1000]))))
  await shot('04-distribution')
  // 下钻：时态 → 一般过去时
  await T('treemap-cell-GR.TENSE').click()
  await waitFor(async () => (await T('crumb-GR.TENSE').count()) > 0, 5000)
  cells = await cellsOf()
  const wantTense = [...tbl].filter(([c, e]) => t.parent.get(c) === 'GR.TENSE' && e.primScore > 0).map(([c, e]) => [c, e.primScore]).sort()
  check('treemap', '点「时态」下钻：面包屑出现，格子换成二级节点；一般过去时 = 14、一般将来时 = 4（手算：7 题×2 分、2 题×2 分）', JSON.stringify(cells.map(c => [c.id, c.v]).sort()) === JSON.stringify(wantTense) && cells.find(c => c.id === 'GR.TENSE.PAST').v === 14 && cells.find(c => c.id === 'GR.TENSE.FUT').v === 4, JSON.stringify(cells.map(c => [c.id, c.v])))
  await T('treemap-cell-GR.TENSE.PAST').click()
  await waitFor(async () => (await T('crumb-GR.TENSE.PAST').count()) > 0, 5000)
  cells = await cellsOf()
  check('treemap', '再下钻到「一般过去时」：规则 8 + 不规则 6（手算），三级是叶子、不能再点', cells.length === 2 && cells.find(c => c.id === 'GR.TENSE.PAST.REG')?.v === 8 && cells.find(c => c.id === 'GR.TENSE.PAST.IRREG')?.v === 6 && cells.every(c => !c.drill), JSON.stringify(cells))
  await shot('05-treemap-drill')
  await T('treemap-metric').getByText('题数（主知识点）').click()
  cells = await cellsOf()
  check('treemap', '面积口径切到「题数」：规则 4 题、不规则 3 题（手算）', cells.find(c => c.id === 'GR.TENSE.PAST.REG')?.v === 4 && cells.find(c => c.id === 'GR.TENSE.PAST.IRREG')?.v === 3, JSON.stringify(cells.map(c => [c.id, c.v])))
  await T('crumb-GR.TENSE').click()
  check('treemap', '点面包屑回到上一层', (await cellsOf()).some(c => c.id === 'GR.TENSE.FUT'))
  await T('crumb-root').click()
  await T('treemap-metric').getByText('分值（主知识点）').click()

  // 考频柱状图（二级，按出现率）
  const wantFreq = [...tbl].filter(([c]) => t.level.get(c) === 2).sort((a, b) => b[1].papers.size / g4.length - a[1].papers.size / g4.length || b[1].qs.size - a[1].qs.size || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([c, e]) => [c, e.papers.size])
  const gotFreq = await page.locator('[data-testid^=freq-]:not([data-testid=freq-level])').evaluateAll(els => els.map(e => [e.dataset.testid.replace('freq-', ''), Number(e.dataset.papers)]))
  check('考频', '考频柱状图（二级）：次序与出现份数 = 逐条循环重算；「细节理解」11/11、「名词复数」7/11（手算：A×3 B×3 C1）', JSON.stringify(gotFreq) === JSON.stringify(wantFreq) && gotFreq[0][0] === 'RD.DETAIL' && gotFreq[0][1] === 11 && gotFreq.find(x => x[0] === 'GR.NOUN.PLURAL')[1] === 7, JSON.stringify(gotFreq.slice(0, 3)))
  await T('freq-level').getByText('三级').click()
  const wantF3 = [...tbl].filter(([c]) => t.level.get(c) === 3).sort((a, b) => b[1].papers.size - a[1].papers.size || b[1].qs.size - a[1].qs.size || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([c, e]) => [c, e.papers.size])
  const gotF3 = await page.locator('[data-testid^=freq-]:not([data-testid=freq-level])').evaluateAll(els => els.map(e => [e.dataset.testid.replace('freq-', ''), Number(e.dataset.papers)]))
  check('考频', '切到三级：同样与重算一致', JSON.stringify(gotF3) === JSON.stringify(wantF3) && gotF3[0][0] === 'RD.DETAIL.FACT', JSON.stringify(gotF3.slice(0, 2)))

  // 题型分布、难度分布
  const byType = {}
  for (const p of g4) for (const q of p.q) { byType[q.qtype] ??= { n: 0, score: 0 }; byType[q.qtype].n++; byType[q.qtype].score += q.score ?? 0 }
  const gotQt = await page.locator('[data-testid^=qtype-]').evaluateAll(els => Object.fromEntries(els.map(e => [e.dataset.testid.replace('qtype-', ''), { n: Number(e.dataset.questions), score: Number(e.dataset.score) }])))
  check('题型分布', '各题型题数与分值 = 逐题累加的结果（单选 18 题/34 分、阅读选择 11 题/33 分，手算）', JSON.stringify(gotQt) === JSON.stringify(Object.fromEntries(Object.keys(gotQt).map(k => [k, byType[k]]))) && Object.keys(gotQt).length === Object.keys(byType).length && gotQt.MC.n === 18 && gotQt.MC.score === 34 && gotQt.RD_MC.n === 11 && gotQt.RD_MC.score === 33, JSON.stringify(gotQt))
  const byDiff = [0, 0, 0, 0, 0]
  for (const p of g4) for (const q of p.q) if (q.diff) byDiff[q.diff - 1]++
  const gotDiff = await page.locator('[data-testid^=diff-]').evaluateAll(els => els.map(e => Number(e.dataset.questions)))
  check('难度分布', '难度 1–5 的题数 = 逐题累加，并标注「估计」', JSON.stringify(gotDiff) === JSON.stringify(byDiff) && (await page.locator('[data-testid=est-tag]').count()) >= 1, JSON.stringify(gotDiff))

  // 双向细目表
  await T('matrix').waitFor()
  const cell = async (r, c) => T(`matrix-cell-${r}-${c}`).count().then(async n => (n ? { q: Number(await T(`matrix-cell-${r}-${c}`).getAttribute('data-q')), s: Number(await T(`matrix-cell-${r}-${c}`).getAttribute('data-score')) } : null))
  // 手算：时态 × 用所给词填空 = A1Q3 B1Q2 C1Q1 C3Q1 C5Q1 → 5 题 10 分；时态 × 单选 = A2Q3 C2Q1 C2Q2 C4Q1 → 4 题 8 分
  const f = await cell('GR.TENSE', 'FORM'), m = await cell('GR.TENSE', 'MC')
  check('双向细目表', '一级行：时态 × 填空 = 5 题/10 分，时态 × 单选 = 4 题/8 分（手算）', f?.q === 5 && f?.s === 10 && m?.q === 4 && m?.s === 8, JSON.stringify([f, m]))
  check('双向细目表', '表尾「全部题目合计」= 44 题 / 97 分（手算），不受一道题标多个知识点影响', (await T('matrix').innerText()).replace(/\s+/g, ' ').includes('全部题目合计') && (await page.locator('[data-testid^=matrix-foot-]').evaluateAll(els => els.reduce((s, e) => s + Number(e.dataset.q), 0))) === 44 && (await page.locator('[data-testid^=matrix-foot-]').evaluateAll(els => els.reduce((s, e) => s + Number(e.dataset.score), 0))) === 97)
  // 次知识点的格子：时态 × 阅读选择（C1 第 4 题把一般过去时标成次知识点）显示「仅次知识点」，不是「0 分」
  const sec = T('matrix-cell-GR.TENSE-RD_MC')
  check('双向细目表', '只作为次知识点的格子写「仅次知识点」而不是 0 分：时态 × 阅读选择 = 1 题', (await sec.count()) === 1 && /1 题 \/ 仅次知识点/.test(await sec.innerText()) && (await sec.getAttribute('data-prim')) === '0', await sec.innerText().catch(() => ''))
  await T('matrix-level').getByText('二级知识点').click()
  await waitFor(async () => (await T('matrix').getAttribute('data-level')) === '2', 8000)
  const f2 = await cell('GR.TENSE.PAST', 'FORM'), m2 = await cell('GR.TENSE.PAST', 'MC')
  check('双向细目表', '切到二级行：一般过去时 × 填空 = 4 题/8 分，× 单选 = 3 题/6 分（手算）', f2?.q === 4 && f2?.s === 8 && m2?.q === 3 && m2?.s === 6, JSON.stringify([f2, m2]))
  await shot('06-matrix')
  // 导出 CSV：桩掉系统「另存为」对话框，由主进程真正写文件
  const csvPath = path.join(work, 'matrix.csv')
  await ctx.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) }, csvPath)
  await T('matrix-level').getByText('一级知识点').click()
  await waitFor(async () => (await T('matrix').getAttribute('data-level')) === '1', 8000)
  await T('matrix-export').click()
  const wrote = await waitFor(async () => fs.existsSync(csvPath), 8000)
  const raw = wrote ? fs.readFileSync(csvPath, 'utf8') : ''
  const rows = raw.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).map(l => l.split(','))
  const head = rows[0] || []
  const col = (name) => head.indexOf(name)
  const tenseRow = rows.find(r => r[0] === 'GR.TENSE') || []
  const iFoot = rows.findIndex(r => (r[1] || '').startsWith('全部题目合计'))
  const foot = rows[iFoot] || []
  const nameRow = rows.find(r => r[0] === 'GR.NOUN') || []
  check('CSV 导出', '导出的 CSV 带 BOM、CRLF；表头含「知识点代码 / 知识点 / 各题型的题数与分值 / 合计」', raw.startsWith('\uFEFF') && raw.includes('\r\n') && head[0] === '知识点代码' && head[1] === '知识点' && head.includes('用所给词的适当形式填空 题数') && head.includes('单项选择 分值') && head.at(-1) === '合计分值', head.join('|').slice(0, 120))
  check('CSV 导出', '内容与界面一致：时态行 填空 5 题/10 分、单选 4 题/8 分（手算）；表尾合计 44 题 / 97 分', tenseRow[col('用所给词的适当形式填空 题数')] === '5' && tenseRow[col('用所给词的适当形式填空 分值')] === '10' && tenseRow[col('单项选择 题数')] === '4' && tenseRow[col('单项选择 分值')] === '8' && foot[1].startsWith('全部题目合计') && foot[head.length - 2] === '44' && foot[head.length - 1] === '97', `${tenseRow.join('|')} || ${foot.join('|')}`)
  check('CSV 导出', 'CSV：表头 + 一级知识点行 + 表尾，每行列数一致；每个题型三列（题数、分值、分值覆盖）', iFoot === 1 + [...tbl.keys()].filter(c => t.level.get(c) === 1).length && rows.slice(0, iFoot + 1).every(r => r.length === head.length) && head.includes('用所给词的适当形式填空 分值覆盖') && tenseRow[col('用所给词的适当形式填空 分值覆盖')] === '5/5' && tenseRow[col('单项选择 分值覆盖')] === '4/4', `${rows.length} 行 × ${head.length} 列`)
  // 次知识点：C1 第 4 题（阅读选择）把「一般过去时」标成次知识点 → 时态 × 阅读选择 有 1 题、分值 0（只算主知识点）、覆盖写「仅次知识点」；名词 × 阅读选择 同理（A1 第 4 题）
  check('CSV 导出', '主/次知识点：只作为次知识点出现的格子——时态 × 阅读选择 = 1 题 / 分值 0 / 「仅次知识点」；名词 × 阅读选择 同（手算，夹具 C1Q4、A1Q4）', tenseRow[col('阅读选择 题数')] === '1' && tenseRow[col('阅读选择 分值')] === '0' && tenseRow[col('阅读选择 分值覆盖')] === '仅次知识点' && nameRow[col('阅读选择 题数')] === '1' && nameRow[col('阅读选择 分值覆盖')] === '仅次知识点', `${tenseRow.slice(-5).join('|')}`)
  const metaRow = rows.find(r => r[0] === '说明') || []
  check('CSV 导出', '表后附口径说明：筛选范围「四年级 · 按一级知识点统计」、计入试卷 11 份、分值覆盖 42/44 题——文件被转发时数字不脱离口径', /筛选范围：四年级 · 按一级知识点统计/.test(metaRow[1] || '') && /计入试卷 11 份；分值覆盖 42\/44 题/.test((rows[rows.indexOf(metaRow) + 1] || [])[1] || ''), metaRow.join('|'))

  // 口径说明
  await T('methodology-btn').click()
  await T('methodology').waitFor()
  const mt = await txt('methodology')
  check('口径说明', '口径说明写清楚了：出现率分母、分值占比分母、向上汇总、主/次知识点只按主知识点计分值、分值缺失、20 个百分点、<5 份样本有限、重难点公式、「估计」、默认只统计已确认、重复导入只算一份、按学期对齐', ['出现率 = 含该知识点的试卷数 ÷ 当前筛选内的试卷数', '分值只按主知识点计', '分值缺失', '向上汇总', '不小于 20 个百分点', '5 份', '综合得分 = 出现率 × 分值占比 × (1 + 1.0 × 易错率)', '估计', '默认只统计状态为「已完成」', '同一个文件导入了多份时，只算一份', '按学期对齐（默认）', '不是考情结论'].every(s => mt.includes(s)))
  await shot('07-methodology')
  await page.keyboard.press('Escape')
}

// ───────── 阶段 4：同比 + 抽屉 + 截图 ─────────
async function phaseCompare() {
  const { page } = ctx
  const t = ctx.tree
  await setFilter({ grade: '4' }, '#/dashboard')
  await page.getByRole('tab', { name: '同比' }).click()
  await T('compare-target').waitFor()
  check('同比', '默认目标学年 = 最新学年 2025-2026，基线 = 之前的全部学年', /2025-2026/.test(await txt('compare-target')) && /之前的全部学年/.test(await txt('compare-base')))
  await T('col-added').waitFor()
  await waitFor(async () => (await T('col-added').getAttribute('data-count')) === '1', 8000)
  const want = naive.compare(t, { grade: '4' }, 2025, 'before', 2)
  const cnt = async k => Number(await T(`col-${k}`).getAttribute('data-count'))
  check('同比', '四栏（二级知识点）：新增 1 / 消失 1 / 上升 2 / 下降 1（手算，推导见 fixtures-m3.cjs 头部）', want.added.length === 1 && want.removed.length === 1 && want.up.length === 2 && want.down.length === 1 && await cnt('added') === 1 && await cnt('removed') === 1 && await cnt('up') === 2 && await cnt('down') === 1, [await cnt('added'), await cnt('removed'), await cnt('up'), await cnt('down')].join('/'))
  const codesIn = k => T(`col-${k}`).locator('[data-testid^=item-]').evaluateAll(els => els.map(e => e.dataset.testid.replace('item-', '')))
  check('同比', '各栏内容 = 逐条循环重算：新增=一般将来时；消失=字母与字母组合发音；上升=一般过去时、购物；下降=名词复数', JSON.stringify(await codesIn('added')) === JSON.stringify(['GR.TENSE.FUT']) && JSON.stringify(await codesIn('removed')) === JSON.stringify(['PH.PHONICS']) && JSON.stringify((await codesIn('up')).sort()) === JSON.stringify(['FN.SHOP', 'GR.TENSE.PAST']) && JSON.stringify(await codesIn('down')) === JSON.stringify(['GR.NOUN.PLURAL']) && JSON.stringify(want.up.map(x => x.code).sort()) === JSON.stringify(['FN.SHOP', 'GR.TENSE.PAST']))
  const pastTxt = await txt('item-GR.TENSE.PAST'), shopTxt = await txt('item-FN.SHOP'), plTxt = await txt('item-GR.NOUN.PLURAL')
  check('同比', '数字：一般过去时 基线 3/6 → 目标 4/5，+30.0 个百分点；购物 1/6 → 目标 3/5，+43.3（C4 第 4 题把购物标成次知识点，次知识点也计出现率）；名词复数 6/6 → 1/5，−80.0（手算）', /基线 3\/6 → 目标 4\/5/.test(pastTxt) && pastTxt.includes('+30.0 个百分点') && /基线 1\/6 → 目标 3\/5/.test(shopTxt) && shopTxt.includes('+43.3 个百分点') && /基线 6\/6 → 目标 1\/5/.test(plTxt) && plTxt.includes('-80.0 个百分点'), `${pastTxt} | ${shopTxt} | ${plTxt}`)
  check('同比', '「上升」栏按变化幅度排序：购物 +43.3 在 一般过去时 +30.0 之前', JSON.stringify(await codesIn('up')) === JSON.stringify(['FN.SHOP', 'GR.TENSE.PAST']))
  check('同比', '两侧各 ≥5 份（5 与 6）：不显示「样本有限」', (await T('sample-warning').count()) === 0)
  const tb = async (side, name) => Number(await T(`textbooks-${side}-${name}`).getAttribute('data-papers'))
  check('同比', '并排的教材版本分布：目标 人教PEP 3 + 外研版 2；基线 人教PEP 6（手算）', await tb('target', '人教PEP') === 3 && await tb('target', '外研版') === 2 && await tb('base', '人教PEP') === 6 && (await T('textbooks-base').locator('[data-testid^=textbooks-base-]').count()) === 1)
  await shot('08-compare')

  // 基线只选 2024 一年（3 份）→ 样本有限
  await pickOpt('compare-base', '只看 2024-2025学年')
  const warnOk = await waitFor(async () => (await T('sample-warning').count()) > 0, 8000)
  const w = warnOk ? await txt('sample-warning') : ''
  const want2 = naive.compare(t, { grade: '4' }, 2025, 2024, 2)
  await waitFor(async () => (await cnt('added')) === want2.added.length, 8000)
  check('同比', '基线只选 2024 学年（3 份）→ 显示「样本有限：基线只有 3 份卷子」，四栏按新基线重算（新增 ' + want2.added.length + '）', warnOk && /样本有限/.test(w) && /基线只有 3 份/.test(w) && !/目标学年只有/.test(w) && await cnt('added') === want2.added.length && await cnt('removed') === want2.removed.length && await cnt('up') === want2.up.length && await cnt('down') === want2.down.length, w)
  check('同比', '单一基线时「字母组合发音」不再算消失（它只出现在 2023 学年）', !(await codesIn('removed')).includes('PH.PHONICS'))
  await shot('09-compare-limited')
  await pickOpt('compare-base', '之前的全部学年')
  await waitFor(async () => (await T('sample-warning').count()) === 0, 8000)

  // 层级切到「一级」：向上汇总到一级知识点后重新分类（手算，grade=4）：
  //   语音 PH 基线 3/6 → 目标 0/5 消失；时态 GR.TENSE 3/6 → 5/5（+50.0）上升；功能交际 FN 1/6 → 3/5（+43.3）上升；
  //   名词 GR.NOUN 6/6 → 1/5（−80.0）下降；形容词 +10、阅读 6/6→5/5、词汇 2/6→2/5 都不够 20 个百分点；没有新增
  await T('compare-level').getByText('一级').click()
  await waitFor(async () => (await codesIn('removed')).includes('PH'), 8000)
  const l1 = { added: await codesIn('added'), removed: await codesIn('removed'), up: await codesIn('up'), down: await codesIn('down') }
  const wantL1 = naive.compare(t, { grade: '4' }, 2025, 'before', 1)
  check('同比', '层级切到「一级」：向上汇总后重新分类——消失 语音；上升 时态(+50.0)、功能交际(+43.3)；下降 名词；没有新增（手算，且与逐条循环重算一致）', JSON.stringify(l1) === JSON.stringify({ added: [], removed: ['PH'], up: ['GR.TENSE', 'FN'], down: ['GR.NOUN'] }) && JSON.stringify([...wantL1.up.map(x => x.code)].sort()) === JSON.stringify(['FN', 'GR.TENSE']) && /\+50\.0 个百分点/.test(await txt('item-GR.TENSE')) && /\+43\.3 个百分点/.test(await txt('item-FN')), JSON.stringify(l1))
  await T('compare-level').getByText('二级').click()
  await waitFor(async () => (await codesIn('added')).includes('GR.TENSE.FUT'), 8000)

  // 五年级：目标 1 份、基线 2 份 → 两侧都有限
  await T('filter-reset').click()
  await pickOpt('filter-grade', '五年级')
  const w5 = await waitFor(async () => (await T('sample-warning').count()) > 0 && /目标学年只有 1 份/.test(await txt('sample-warning')), 10000)
  check('同比', '五年级：目标 1 份、基线 2 份 → 「样本有限」两侧都提示', w5 && /基线只有 2 份/.test(await txt('sample-warning')), w5 ? await txt('sample-warning') : '')
  // 学期对齐：五年级目标学年（2025）只有下学期的 G3；基线里 2024 学年有下学期的 G1、G2 和上学期的 G4。默认按学期对齐，G4 不参与比较
  const al = await waitFor(async () => (await T('align-note').count()) > 0, 8000)
  check('同比', '按学期对齐（默认）：目标学年只有下学期 → 基线只取下学期的 G1、G2（2 份），上学期的 G4 不参与，页面说明「另有 1 份其他学期的基线卷子没有参与比较」', al && /另有 1 份其他学期的基线卷子/.test(await txt('align-note')) && (await T('semesters-target-下').getAttribute('data-papers')) === '1' && (await T('semesters-base-下').getAttribute('data-papers')) === '2' && (await T('semesters-base-上').count()) === 0 && naive.compare(t, { grade: '5' }, 2025, 'before', 2).nB === 2, al ? await txt('align-note') : '')
  await T('compare-align').click()
  const off = await waitFor(async () => (await T('align-off').count()) > 0 && (await T('semesters-base-上').count()) === 1, 8000)
  check('同比', '关掉「按学期对齐」：基线含上、下学期共 3 份，学期分布并排显示；提示「学期构成不一致（目标学年有：下学期；基线有：上学期、下学期）」与「未按学期对齐」', off && /基线只有 3 份/.test(await txt('sample-warning')) && (await T('semesters-base-上').getAttribute('data-papers')) === '1' && /学期构成不一致（目标学年有：下学期；基线有：上学期、下学期）/.test(await txt('mixed-warning')) && naive.compare(t, { grade: '5' }, 2025, 'before', 2, false).nB === 3, off ? await txt('mixed-warning') : '')
  // 知识点抽屉里的基线题目卡片与表格同源（共用同一个「对齐后的基线范围」）：RD.DETAIL 在对齐时基线 1/2 份，抽屉 1 张卡片；不对齐时基线 2/3 份，抽屉 2 张
  const drawerBase = async () => {
    await T('item-RD.DETAIL').click()
    await T('drawer-stats').waitFor()
    await T('kp-drawer').locator('[data-testid=question-card]').first().waitFor()
    const out = { stats: await txt('drawer-stats'), cards: await T('kp-drawer').locator('[data-testid=question-card]').count() }
    await closeDrawer()
    return out
  }
  const offDrawer = await drawerBase()
  await T('compare-align').click()
  await waitFor(async () => (await T('align-off').count()) === 0, 8000)
  const onDrawer = await drawerBase()
  check('抽屉', '基线卡片与表格同源（复审 P1-B）：对齐时 RD.DETAIL 基线 1/2 份、抽屉 1 张卡片；不对齐时 2/3 份、2 张卡片（修复前对齐时抽屉也是 2 张，与表格对不上）', /基线 .* 2\/3 份/.test(offDrawer.stats) && offDrawer.cards === 2 && /基线 .* 1\/2 份/.test(onDrawer.stats) && onDrawer.cards === 1 && naive.compare(t, { grade: '5' }, 2025, 'before', 2, true).removed.some(x => x.code === 'RD.DETAIL' && x.aB === 1), `${JSON.stringify(offDrawer)} / ${JSON.stringify(onDrawer)}`)
  // 全部年级：混入不同年级 → 提示
  await T('filter-reset').click()
  const mixed = await waitFor(async () => (await T('mixed-warning').count()) > 0, 10000)
  check('同比', '不限年级时两侧混入了不同年级 → 给出口径提示', mixed && /混入了不同年级/.test(await txt('mixed-warning')))
  // 学年筛选在同比页签不生效，有说明
  await pickOpt('filter-year', '2024-2025')
  check('同比', '筛选栏选了学年时，同比页签说明「学年不生效，由目标/基线决定」，目标学年仍可选', await waitFor(async () => (await T('compare-year-ignored').count()) > 0, 8000))
  await T('filter-reset').click()
  await pickOpt('filter-grade', '四年级')
  await waitFor(async () => (await T('compare-year-ignored').count()) === 0, 8000)
  await waitFor(async () => (await T('col-added').getAttribute('data-count')) === '1', 8000)
  check('同比', '同比页同样显示范围说明（1 份待审核没有计入）——不只是总览和分布页', /1 份待审核的试卷没有计入/.test(await txt('not-counted')), await txt('not-counted'))
}

const closeDrawer = async () => {
  await T('kp-drawer').locator('.ant-drawer-close').click()
  await T('kp-drawer').waitFor({ state: 'detached', timeout: 8000 })
}

// 抽屉：题目卡片 + 原卷截图
async function phaseDrawer() {
  const { page } = ctx
  if ((await T('item-GR.TENSE.FUT').count()) === 0) {
    await setFilter({ grade: '4' }, '#/dashboard')
    await page.getByRole('tab', { name: '同比' }).click()
    await T('item-GR.TENSE.FUT').waitFor()
  }
  await T('item-GR.TENSE.FUT').click()
  await T('kp-drawer').waitFor()
  const drawer = T('kp-drawer')
  await drawer.locator('[data-testid=question-card]').first().waitFor()
  const cards = drawer.locator('[data-testid=question-card]')
  check('抽屉', '点「一般将来时」打开抽屉：目标侧 2 题（C2 第 1 题、C5 第 1 题），易错的 C2 排在前面', (await cards.count()) === 2 && (await cards.nth(0).getAttribute('data-qid')) === ctx.qids.C2Q1 && (await cards.nth(1).getAttribute('data-qid')) === ctx.qids.C5Q1, `${await cards.count()}`)
  const stats = await drawer.locator('[data-testid=drawer-stats]').innerText()
  check('抽屉', '抽屉里的对比数据：目标 2/5 份 · 40%，基线 0/6 份；目标侧 2 题', /2\/5 份 · 40%/.test(stats) && /0\/6 份 · 0%/.test(stats) && /2 题/.test(stats), stats.replace(/\s+/g, ' '))
  // 截图位置与 bbox 一致：从 DOM 实测
  const crop = cards.nth(0).locator('[data-testid=crop]')
  const bbox = ctx.bbox
  await crop.locator('img').evaluate(i => i.decode())   // 图片加载完才量得出高度
  const geo = await crop.evaluate(el => {
    const c = el.getBoundingClientRect(), i = el.querySelector('img').getBoundingClientRect()
    return { mode: el.dataset.mode, bbox: JSON.parse(el.dataset.bbox), x: (c.x - i.x) / i.width, y: (c.y - i.y) / i.height, w: c.width / i.width, h: c.height / i.height, cw: c.width, ch: c.height, iw: i.width, ih: i.height }
  })
  check('抽屉截图', '截图是按 bbox 用 CSS 裁切的：容器相对整页图的 位置/大小 = 库里的 bbox（误差 < 0.3%）', geo.mode === 'crop' && JSON.stringify(geo.bbox) === JSON.stringify(bbox) && near(geo.x, bbox[0]) && near(geo.y, bbox[1]) && near(geo.w, bbox[2]) && near(geo.h, bbox[3]), JSON.stringify({ geo: [geo.x, geo.y, geo.w, geo.h].map(v => Math.round(v * 10000) / 10000), bbox }))
  check('抽屉截图', '截图容器的宽高比 = bbox 的像素宽高比（没有变形）', near((geo.cw / geo.ch) / ((bbox[2] * ctx.pageSize.width) / (bbox[3] * ctx.pageSize.height)), 1, 0.02), `${(geo.cw / geo.ch).toFixed(3)}`)
  // 像素级核对：把这个截图元素放大后截下来，跑真实 OCR，里面应是第 3 题那一行，不含相邻的第 2、4 题
  const origW = await crop.evaluate(el => { const w = el.style.width; el.style.width = '760px'; return w })
  await sleep(300)
  const png = path.join(work, 'drawer-crop.png')
  await crop.screenshot({ path: png })
  fs.copyFileSync(png, path.join(shots, 'm3-10-drawer-crop.png'))
  let text = ''
  try { text = L.ocrText(png) } catch (e) { text = 'OCR 失败：' + e.message }
  check('抽屉截图', '截图元素的像素内容经 Vision OCR：含第 3 题「skirt」，不含相邻题「sheep」「library」', /skirt/i.test(text) && !/sheep/i.test(text) && !/library/i.test(text), text.slice(0, 120))
  await crop.evaluate((el, w) => { el.style.width = w }, origW)
  // 没有 bbox 的题：整页缩略图并注明
  const c2 = cards.nth(1).locator('[data-testid=crop]')
  check('抽屉截图', '没有定位框的题（C5 第 1 题）显示整页缩略图，并注明「没有定位框」', (await c2.getAttribute('data-mode')) === 'page' && /没有定位框，显示的是整页缩略图/.test(await c2.innerText()))
  await shot('11-drawer')
  // 点截图 → 整页原卷 + 高亮
  await crop.click()
  await T('page-viewer').waitFor()
  await sleep(500)
  const hl = await ctx.page.evaluate(() => {
    const img = document.querySelector('[data-testid=page-viewer-img]').getBoundingClientRect(), h = document.querySelector('[data-testid=page-highlight]')
    if (!h) return null
    const r = h.getBoundingClientRect()
    return { x: (r.x - img.x) / img.width, y: (r.y - img.y) / img.height, w: r.width / img.width, h: r.height / img.height, visible: r.top >= 0 && r.bottom <= window.innerHeight }
  })
  check('抽屉截图', '点截图打开整页原卷，高亮框的位置/大小 = bbox（误差 < 0.3%），且滚进了可视区', !!hl && near(hl.x, bbox[0]) && near(hl.y, bbox[1]) && near(hl.w, bbox[2]) && near(hl.h, bbox[3]) && hl.visible, JSON.stringify(hl))
  await shot('12-page-viewer')
  await page.keyboard.press('Escape')
  await T('page-viewer').waitFor({ state: 'detached' }).catch(() => {})
  // 点没有框的那张：整页打开、没有高亮
  await c2.locator('img').click()
  await T('page-viewer').waitFor()
  check('抽屉截图', '没有定位框的题点开整页：不画高亮，并说明无法高亮', (await T('page-highlight').count()) === 0 && /没有定位框，无法高亮/.test(await txt('page-viewer')))
  await page.keyboard.press('Escape')
  await closeDrawer()

  // 消失的知识点：取基线侧的题，且没有页面图 → 说明
  await T('item-PH.PHONICS').click()
  const d2 = T('kp-drawer')
  await d2.locator('[data-testid=question-card]').first().waitFor()
  const bcards = d2.locator('[data-testid=question-card]')
  const wantQ = ['A1Q1', 'A2Q1', 'A3Q1'].map(k => ctx.qids[k]).sort()
  const gotQ = (await bcards.evaluateAll(els => els.map(e => e.dataset.qid))).sort()
  const gotQ0 = null; void gotQ0
  check('抽屉', '消失的知识点默认看基线侧：字母组合发音 3 题（A1/A2/A3 第 1 题）；这些卷子没有页面图 → 说明「没有原卷页面图」', JSON.stringify(gotQ) === JSON.stringify(wantQ) && /没有原卷页面图/.test(await bcards.first().innerText()), `${gotQ.length}`)
  await closeDrawer()
}

module.exports = { setFilter, phaseSetup, phaseOverview, phaseRestart, phaseDistribution, phaseCompare, phaseDrawer, ctx, T, txt, stat, goto, pickOpt, clearSel, waitText, waitStat, near, check, sleep, waitFor, work, shots, shot, SECRET, cfgFor, saveCfg, clean, fmtPct, p2mock, naive, SPEC }
