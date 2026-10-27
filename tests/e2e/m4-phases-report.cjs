// M4 E2E（一）：夹具 + AI 报告页（P3）：流式、取消、故障、引用校验、样本提示兜底、过期、导出 Markdown / PDF。
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const naive = require('./naive.cjs')
const { check, sleep, waitFor, withDb, docsPrompt, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, shot, setFilter, api, stubSave, cfgFor, saveCfg, root, clean } = M
const { startMock, open, pdfInfo, isPng, execFileSync, L } = M

const REPORT = '[data-testid=report-page]'
const rows = () => withDb(ctx.ud, d => d.prepare("SELECT * FROM reports WHERE kind = 'report' ORDER BY created_at, rowid").all())
const reqs = () => ctx.mock.p3Requests

/** 把收到的 user 提示词按 docs 里的模板拆回 11 个占位符的值（M6 起多一个 EVIDENCE）（拆不回去 = 模板骨架被改了） */
function parseUser(user) {
  const tpl = docsPrompt('p3_report', 'user')
  const names = [...tpl.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])
  const parts = tpl.split(/\{\{[A-Z_]+\}\}/)
  const vals = {}
  if (!user.startsWith(parts[0])) return null
  let pos = parts[0].length
  for (let i = 0; i < names.length; i++) {
    const next = parts[i + 1]
    const end = i + 1 < names.length || next.length ? user.indexOf(next, pos) : user.length
    if (end < 0) return null
    vals[names[i]] = user.slice(pos, end)
    pos = end + next.length
  }
  return pos === user.length ? vals : null
}

// ───────── 阶段 0：夹具 ─────────
async function phaseSetup() {
  ctx.mock = await startMock({ apiKey: SECRET })
  const ud = path.join(work, 'userA')
  let r = await open(ud)
  await r.app.close()
  const ocr = JSON.parse(execFileSync(path.join(root, 'native/macos/bin/ewb-ocr'), [pageImg], { encoding: 'utf8', maxBuffer: 20 << 20 }).replace(/^﻿/, ''))
  const l3 = ocr.lines.find(l => l.text.startsWith('3. A. skirt'))
  if (!l3) throw new Error('OCR 没找到第 3 题那一行')
  const r4 = v => Math.round(v * 10000) / 10000
  ctx.bbox = [r4(l3.x - 0.01), r4(l3.y - 0.004), r4(l3.w + 0.02), r4(l3.h + 0.008)]
  ctx.pageSize = { width: ocr.width, height: ocr.height }
  const s = seed(ud, { bboxes: { C2Q1: ctx.bbox }, pageImage: pageImg, pageSize: ctx.pageSize })
  ctx.ids = s.ids; ctx.qids = s.qids
  await open(ud)
  check('夹具', `直接往库里造了 ${SPEC.length} 份卷子（含待审核 / 失败 / 刚导入），迁移后库版本 = v10`, withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM papers').get().c === SPEC.length && d.prepare('PRAGMA user_version').get().user_version === 10))
  withDb(ctx.ud, d => { ctx.tree = naive.makeTree(d.prepare('SELECT code, parent_code, level, name FROM kps').all()) })
}

// ───────── 阶段 1：P3 报告 ─────────
async function phaseReport() {
  const { page, mock } = ctx
  await setFilter({ grade: '4' }, '#/report')
  await T('report-page').waitFor()
  // 没配 AI：给引导，没有生成按钮；统计与历史照常
  check('报告 无 AI', '没配 AI：报告页给出引导（链到设置），没有「生成报告」按钮；页面上仍显示按当前筛选的卷子数', await waitFor(async () => (await T('report-guide').count()) > 0, 10000) && (await T('report-generate').count()) === 0 && /共 11 份卷子、44 道题/.test(await txt('report-counts')), await txt('report-counts').catch(() => ''))
  await shot('01-report-guide')
  await T('report-guide-link').click()
  check('报告 无 AI', '引导链接直接去「设置」', await waitFor(async () => (await page.evaluate(() => location.hash)) === '#/settings?admin=1', 5000))   // 链到「设置 → 管理员设置」
  await saveCfg(cfgFor(mock), SECRET)
  await goto('#/report')
  check('报告 无 AI', '配好 AI 后回到报告页（不用刷新）：引导消失，出现「生成报告」', await waitFor(async () => (await T('report-generate').count()) > 0 && (await T('report-guide').count()) === 0, 10000))
  check('报告 筛选', '范围 = 当前全局筛选：四年级，共 11 份卷子（A1–A3、B1–B3、C1–C5）、44 道题（手算）', /四年级/.test(await txt('report-scope')) && naive.counted({ grade: '4' }).length === 11 && /共 11 份卷子、44 道题/.test(await txt('report-counts')), await txt('report-counts'))

  // 第一份报告：慢速流式
  mock.p3DelayMs = 120
  mock.resetStats()
  await T('report-generate').click()
  const running = await waitFor(async () => (await T('report-running').count()) > 0, 10000)
  await waitFor(async () => Number(await T('report-text').getAttribute('data-len')) > 0, 20000)   // 先等第一段文字到达（准备统计 + 请求要一点时间，机器忙时更久），再取两次采样
  await sleep(500)
  const len1 = Number(await T('report-text').getAttribute('data-len'))
  await shot('02-report-streaming')
  await sleep(900)
  const len2 = Number(await T('report-text').getAttribute('data-len'))
  check('报告 流式', '生成中：显示「正在生成…」和取消按钮，「生成」按钮换掉，文字随流式增量越来越长（不是最后一次性出现）', running && (await T('report-cancel').count()) === 1 && (await T('report-generate').count()) === 0 && len1 > 0 && len2 > len1, `${len1} → ${len2}`)
  // 并发：同时再发一个请求会被拒绝（不烧两份钱）
  const dup = await api(f => window.api.report.generate(f, crypto.randomUUID()), { grade: '4' })
  check('报告 并发', '已经有一份在生成时再发起生成被拒绝（busy），不会多发请求', dup.ok === false && dup.code === 'busy' && reqs().length === 1, JSON.stringify([dup.code, reqs().length]))
  const done = await waitFor(async () => (await T('report-cancel').count()) === 0 && (await T('report-fresh').count()) > 0, 60000)
  mock.p3DelayMs = 0
  check('报告 流式', '生成完成：取消按钮消失，报告进入历史列表并被自动选中，状态「最新」', done && (await page.locator('[data-testid^=report-item-]').count()) === 1, '')
  await shot('03-report-done')

  // ── 发给模型的提示词：占位符全部由本地统计填入 ──
  const req = reqs()[0]
  check('报告 提示词', '只发了 1 次请求，流式，模型名和鉴权正确', reqs().length === 1 && req.stream === true && req.model === 'mock-text-model' && req.auth === `Bearer ${SECRET}`)
  check('报告 提示词', 'system 与 docs/prompts/v2-分读者与事实核对.md 里的 P3 system 逐字一致', req.system === docsPrompt('p3_report', 'system'))
  const v = parseUser(req.user)
  check('报告 提示词', 'user 的骨架与 docs 里的 P3 user 模板逐字一致，11 个占位符一个不缺（M6 新增 EVIDENCE）；无残留 {{ }}', !!v && Object.keys(v).length === 11 && !req.user.includes('{{') && !req.user.includes('}}'), v ? Object.keys(v).join(',') : '拆不回去')
  const g4 = naive.counted({ grade: '4' })
  const tot = naive.totals(g4)
  const t = ctx.tree
  const tbl = naive.nodeTable(t, g4)
  check('报告 提示词', '头部 = 手算：全部… 四年级；11 份卷子 44 道题；覆盖学年 2023–2025 三个学年', v && v.FILTER_DESC === '四年级' && v.PAPER_COUNT === '11' && v.QUESTION_COUNT === '44' && v.YEARS === '2023-2024学年、2024-2025学年、2025-2026学年' && tot.papers === 11 && tot.questions === 44, v && [v.FILTER_DESC, v.PAPER_COUNT, v.QUESTION_COUNT, v.YEARS].join(' / '))
  check('报告 提示词', 'SAMPLE_WARNING 由程序判定：卷子 11 份、同一年级，但混入了期中和期末 → 只提示考试类型混入，没有「样本偏小」类的话', v && v.SAMPLE_WARNING === '范围内混入了不同考试类型的试卷，结论只能作粗略参考。', v && v.SAMPLE_WARNING)
  // KP_DIST = 逐条循环重算：每个有题的节点（一级全列，二级前 30）的 出现份数/总份数 与 题数
  const kpRows = v ? v.KP_DIST.split('\n').map(l => l.split(' | ')) : []
  const l1 = kpRows.filter(r => r[0] === '一级'), l2 = kpRows.filter(r => r[0] === '二级')
  const okL1 = l1.length === [...tbl.keys()].filter(c => t.level.get(c) === 1).length && l1.every(r => { const e = tbl.get(r[1]); return e && r[3] === `${e.papers.size}/11` && Number(r[4]) === e.qs.size && Number(r[7]) === e.err })
  const okL2 = l2.length > 0 && l2.every(r => { const e = tbl.get(r[1]); return e && r[3] === `${e.papers.size}/11` && Number(r[4]) === e.qs.size && Number(r[7]) === e.err })
  check('报告 提示词', '知识点分布表 = 逐条循环重算：每个一级 / 二级节点的出现份数/11、题数、AI 估计易错题数都一致', okL1 && okL2, `${l1.length} 个一级、${l2.length} 个二级`)
  const read = kpRows.find(r => r[1] === 'RD')
  check('报告 提示词', '手算抽查：阅读理解 11/11 份、15 题（细节题 11 + 判断正误 1 + 另外 3 题落在…见夹具），分值占比 = 35/97 = 36.1%', read && read[3] === '11/11' && Number(read[4]) === tbl.get('RD').qs.size && read[5] === `${Math.round(tbl.get('RD').primScore / 97 * 1000) / 10}%`, read && read.join(' | '))
  const qtRows = v ? v.QTYPE_DIST.split('\n').map(l => l.split(' | ')) : []
  const byType = {}
  for (const p of g4) for (const q of p.q) { byType[q.qtype] ??= { n: 0, s: 0 }; byType[q.qtype].n++; byType[q.qtype].s += q.score ?? 0 }
  check('报告 提示词', '题型分布 = 逐题累加：单选 18 题 / 34 分，阅读选择 11 题 / 33 分（手算）；难度分布总数 = 44', qtRows.some(r => r[0] === '单项选择' && r[1] === '18' && r[2] === '34') && qtRows.some(r => r[0] === '阅读选择' && r[1] === '11' && r[2] === '33') && qtRows.reduce((n, r) => n + Number(r[1]), 0) === 44 && qtRows.every(r => { const k = Object.keys(byType).find(c => byType[c].n === Number(r[1]) && byType[c].s === Number(r[2])); return !!k }), JSON.stringify(qtRows.slice(0, 3)))
  const dRows = v ? v.DIFF_DIST.split('\n').map(l => l.split(' | ')) : []
  const byDiff = [0, 0, 0, 0, 0]; for (const p of g4) for (const q of p.q) if (q.diff) byDiff[q.diff - 1]++
  check('报告 提示词', '难度分布 = 逐题累加', JSON.stringify(dRows.filter(r => /^[1-5]$/.test(r[0])).map(r => Number(r[1]))) === JSON.stringify(byDiff), JSON.stringify(dRows.map(r => r.join(':'))))
  const errRows = v ? v.ERROR_PRONE.split('\n').map(l => l.split(' | ')) : []
  const errCodes = new Set(errRows.map(r => r[0]))
  const wantErr = [...tbl].filter(([c, e]) => t.level.get(c) === 2 && e.err > 0).map(([c]) => c).sort()
  check('报告 提示词', '易错点表 = 有 AI 估计易错题的二级知识点（逐条循环重算），每行带样本题 token；一般将来时的样本题指向 C2 第 1 题', JSON.stringify([...errCodes].sort()) === JSON.stringify(wantErr) && errRows.every(r => /\[[^\]]+ · [^\]]+\]/.test(r[3])) && errRows.some(r => r[0] === 'GR.TENSE.FUT' && /2025学年四年级下期末卷C2 · 1/.test(r[3])), errRows.map(r => r[0]).join(','))
  const cmp = naive.compare(t, { grade: '4' }, 2025, 'before', 2)
  check('报告 提示词', '年度变化摘要 = 同比重算：新增 1（一般将来时 2/5）、消失 1（字母与字母组合发音 基线 3/6）、上升 2、下降 1；学期范围写明已对齐', v && /今年新出现（去年及以前从未出现）：一般将来时（今年 2\/5 份卷子有）/.test(v.YEAR_DIFF) && /今年没再出现（去年及以前出现过）：字母与字母组合发音（去年及以前 3\/6 份卷子有）/.test(v.YEAR_DIFF) && /明显变多：购物（去年及以前 1\/6 份 → 今年 3\/5 份卷子有）；一般过去时（去年及以前 3\/6 份 → 今年 4\/5 份卷子有）/.test(v.YEAR_DIFF) && /明显变少：名词复数（去年及以前 6\/6 份 → 今年 1\/5 份卷子有）/.test(v.YEAR_DIFF) && /去年及以前已按学期对齐/.test(v.YEAR_DIFF) && !/基线|目标学年|百分点/.test(v.YEAR_DIFF) && cmp.added.length === 1 && cmp.up.length === 2, v && v.YEAR_DIFF.split('\n')[1])

  // ── 报告页上的呈现 ──
  const body = T('report-body')
  check('报告 呈现', '报告按 Markdown 渲染：标题、表格（至少 3 张）、「结论 / 依据 / 建议」粗体都在；样本提示只在正文开头的说明里出现一次（界面上方不再重复放一条黄条）', (await body.locator('[data-testid=md-table]').count()) >= 3 && /考情分析报告/.test(await body.innerText()) && (await T('report-sample-warning').count()) === 0 && ((await body.innerText()).match(/混入了不同考试类型/g) || []).length === 1 && !(await body.innerText()).includes('**'), `${await body.locator('[data-testid=md-table]').count()} 张表`)
  const cards = await body.locator('[data-testid=cite-card]').evaluateAll(els => els.map(e => e.dataset.token))
  const tokens = new Set([...req.user.matchAll(/\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/g)].map(m => m[0]))
  check('报告 引用', '引用渲染成截图卡片：每张卡片的 token 都来自提示词里给出的样本题（至少 1 张）', cards.length >= 1 && cards.every(c => tokens.has(c)), `${cards.length} 张`)
  const c2 = body.locator(`[data-testid=cite-card][data-qid="${ctx.qids.C2Q1}"]`).first()
  if (await c2.count()) {
    await c2.click()
    const hl = await waitFor(async () => (await T('page-highlight').count()) > 0, 8000)
    const hb = hl ? JSON.parse(await T('page-highlight').getAttribute('data-bbox')) : null
    check('报告 引用', '点 C2 第 1 题的卡片 → 打开整页原卷，高亮框 = 该题 bbox', hl && JSON.stringify(hb) === JSON.stringify(ctx.bbox), JSON.stringify(hb))
    await page.keyboard.press('Escape')
  } else check('报告 引用', '点 C2 第 1 题的卡片 → 打开整页原卷', false, '没有找到 C2 第 1 题的卡片')
  const row0 = rows()[0]
  check('报告 存库', '库里 reports 一行：kind=report、筛选 JSON、64 位缓存键与指纹、提示词模板签名、引用索引、模型；ai_usage 记了 p3_report 用量', rows().length === 1 && row0.kind === 'report' && JSON.parse(row0.filter_json).grade === '4' && /^[0-9a-f]{64}$/.test(row0.cache_key) && /^[0-9a-f]{64}$/.test(row0.fingerprint) && !!row0.template_sig && JSON.parse(row0.refs_json).length >= 1 && row0.model === 'mock-text-model' && row0.markdown.length > 300 && withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM ai_usage WHERE kind = 'p3_report' AND ok = 1").get().c) === 1)
  ctx.firstReport = row0.id
  ctx.firstMarkdown = row0.markdown

  // ── 引用校验 + 样本提示兜底 ──
  mock.quirks = { p3: { badCite: true, dropWarning: true, noAdvice: true } }
  await T('report-generate').click()
  await waitFor(async () => (await page.locator('[data-testid^=report-item-]').count()) === 2, 30000)
  mock.quirks = {}
  const r2 = rows()[1]
  const w = JSON.parse(r2.warnings_json)
  await waitFor(async () => (await T('report-warning').allInnerTexts()).some(x => /已移除 1 处/.test(x)), 10000)   // 新报告生成完会自动选中，等界面切过去
  check('报告 引用校验', '模型自造的引用 [不存在的卷 · 99] 被移除并提示「已移除 1 处」；正文里不再有它', !r2.markdown.includes('不存在的卷') && w.some(x => /已移除 1 处无法核对的引用/.test(x)) && (await T('report-warning').allInnerTexts()).some(x => /已移除 1 处/.test(x)), JSON.stringify([r2.markdown.includes('不存在的卷'), w, await T('report-warning').allInnerTexts()]).slice(0, 300))
  check('报告 样本提示', '模型没转述样本提示 → 程序判定的提示补在开头（「样本提示：」），只补这一处、不再另放一条「模型没有转述」的说明', /样本提示：范围内混入了不同考试类型/.test(r2.markdown) && !w.some(x => /样本提示|模型没有转述/.test(x)) && (await T('report-sample-warning').count()) === 0 && r2.sample_warning === '范围内混入了不同考试类型的试卷，结论只能作粗略参考。')
  check('报告 完整性', '默认提示词规定的最后一节「教学建议」缺了 → 提示「内容可能不完整」', w.some(x => /没有最后一节「教学建议」/.test(x)))
  check('报告 历史', '历史列表：两份报告，最新的在最上面并被选中', (await page.locator('[data-testid^=report-item-]').count()) === 2 && (await page.locator('[data-testid^=report-item-]').first().getAttribute('data-testid')) === `report-item-${r2.id}`)
  ctx.badReport = r2.id

  // ── 取消 ──
  mock.p3DelayMs = 150
  await T('report-generate').click()
  await waitFor(async () => Number(await T('report-text').getAttribute('data-len').catch(() => 0)) > 0, 15000)
  await T('report-cancel').click()
  const cancelled = await waitFor(async () => (await T('report-cancelled').count()) > 0, 10000)
  await sleep(800)
  check('报告 取消', '生成中点「取消生成」→ 「已取消，没有保存结果」，已收到的部分灰显保留；库里没有多出报告（仍 2 份）；0.8 秒后界面不会被迟到的数据冲回「生成中」', cancelled && (await T('report-partial').count()) === 1 && rows().length === 2 && (await T('report-running').count()) === 0, `${rows().length} 条`)
  await shot('04-report-cancelled')
  mock.p3DelayMs = 0
  await T('report-dismiss').click()

  // ── 故障：中途断流 / 干净 EOF / 空内容；都不入库 ──
  const attempt = async (script, wantCode) => {
    mock.resetStats()
    mock.script(script)
    await T('report-generate').click()
    const err = await waitFor(async () => (await T('report-error').count()) > 0, 60000)
    const msg = err ? await txt('report-error') : ''
    // 白话报错 + 「查看详情」折叠里的技术原因（给管理员看）
    if (err) { await T('report-error').locator('.ant-collapse-header').first().click().catch(() => undefined); await sleep(300) }
    const detail = err && (await T('report-error-detail').count()) ? await txt('report-error-detail') : ''
    const n = reqs().length
    await T('report-dismiss').click()
    return { err, msg, detail, n }
  }
  const cut = await attempt([{ type: 'p2_cut', times: 3, after: 3, only: 'p3' }])
  check('报告 故障', '中途断流（连接被硬断）3 次 → 白话「连不上 AI 服务」（技术原因「数据流中断」收在详情里），自动重试 2 次（共 3 次请求），不入库', cut.err && /连不上 AI 服务/.test(cut.msg) && /数据流中断|中断/.test(cut.detail) && cut.n === 3 && rows().length === 2, `${cut.n} 次；${cut.msg}`)
  const eof = await attempt([{ type: 'p2_eof', times: 3, after: 3, only: 'p3' }])
  check('报告 故障', '「干净 EOF」（没有 finish_reason 也没有 [DONE]）3 次 → 白话提示（技术原因「数据流意外结束」收在详情里），半截内容不入库', eof.err && /连不上 AI 服务/.test(eof.msg) && /意外结束/.test(eof.detail) && eof.n === 3 && rows().length === 2, eof.msg)
  const empty = await attempt([{ type: 'empty', times: 2, only: 'p3' }])
  check('报告 故障', '模型连续返回空内容 → 先同参数重试一次再报白话「AI 这次没有返回内容」（技术原因「空内容」在详情里），不入库', empty.err && /没有返回内容/.test(empty.msg) && /空内容/.test(empty.detail) && empty.n === 2 && rows().length === 2, `${empty.n} 次；${empty.msg}`)
  // 断流 1 次后重试成功：只有完整的一份
  mock.resetStats(); mock.script([{ type: 'p2_cut', times: 1, after: 3, only: 'p3' }])
  await T('report-generate').click()
  await waitFor(async () => rows().length === 3, 60000)
  check('报告 故障', '断流 1 次后自动重试成功：入库的是完整的一份（只多 1 条），正文里「考情分析报告」标题只出现一次（没有拼接重复）', rows().length === 3 && reqs().length === 2 && (rows()[2].markdown.match(/^# .*考情分析报告/gm) ?? []).length === 1, `${reqs().length} 次请求`)
  // 提示词被改坏（占位符拼错）→ 不发给模型
  const before = reqs().length
  const p = await api(() => window.api.ai.prompts())
  const cur = p.items.find(x => x.id === 'p3_report' && x.part === 'user').text
  await api(t => window.api.ai.savePrompt('p3_report', 'user', t), cur.replace('{{FILTER_DESC}}', '{{FILTER_DESCC}}'))
  await page.reload(); await goto('#/report')
  await T('report-blocked').waitFor({ timeout: 10000 }).catch(() => {})
  const gen = await api(f => window.api.report.generate(f, crypto.randomUUID()), { grade: '4' })
  check('报告 故障', '提示词被改坏（占位符拼错）：页面说明原因、不能生成，强行生成被拒绝，不会把 {{…}} 发给模型', gen.ok === false && gen.code === 'bad_prompt' && /FILTER_DESCC/.test(gen.message) && reqs().length === before && (await T('report-generate').count()) === 0 && /FILTER_DESCC|提示词/.test(await txt('report-blocked').catch(() => '')), gen.message)
  await api(() => window.api.ai.resetPrompt('p3_report', 'user'))
  await page.reload(); await goto('#/report')
  await T('report-generate').waitFor({ timeout: 10000 })

  // ── 过期：数据变 / 提示词变 → 标「已过期」，不自动重新生成 ──
  const listStatus = async () => page.locator('[data-testid^=report-item-]').evaluateAll(els => Object.fromEntries(els.map(e => [e.dataset.testid.replace('report-item-', ''), e.dataset.status])))
  const sFresh = await listStatus()
  check('报告 过期', '没动过数据和提示词：三份报告都是「最新」', Object.values(sFresh).length === 3 && Object.values(sFresh).every(x => x === 'fresh'), JSON.stringify(sFresh))
  const reqBefore = reqs().length
  const pid = ctx.ids.C2
  await api(i => window.api.questions.reopen(i), pid)   // C2 退回待审核 → 四年级已确认卷子 11 → 10
  const stale1 = await waitFor(async () => Object.values(await listStatus()).every(x => x === 'stale'), 15000)
  await T(`report-item-${rows()[0].id}`).click()
  await waitFor(async () => (await T('report-stale').count()) > 0, 10000)
  const staleTxt = (await T('report-stale').count()) ? await txt('report-stale') : ''
  await sleep(2500)
  check('报告 过期', '把 C2 退回待审核（数据变了）→ 历史里的报告都标「已过期」，写明「统计数据…有变化」，2.5 秒后仍没有新请求（不自动重算）', stale1 && /已过期/.test(staleTxt) && /统计数据/.test(staleTxt) && reqs().length === reqBefore, staleTxt)
  await shot('05-report-stale')
  await api(i => window.api.questions.confirmPaper(i, true), pid)
  const back = await waitFor(async () => Object.values(await listStatus()).every(x => x === 'fresh'), 15000)
  check('报告 过期', '重新确认 C2 → 数据回到原样，报告又是「最新」（过期按实际发给模型的文本判断，不是靠修订号）', back, JSON.stringify(await listStatus()))
  // 提示词变了
  await api(t => window.api.ai.savePrompt('p3_report', 'system', t + '\n（测试追加一句）'), (await api(() => window.api.ai.prompts())).items.find(x => x.id === 'p3_report' && x.part === 'system').text)
  const staleP = await waitFor(async () => Object.values(await listStatus()).every(x => x === 'stale'), 15000)
  await T(`report-item-${rows()[0].id}`).click()
  await waitFor(async () => (await T('report-stale').count()) > 0 && /写作要求有更新/.test(await txt('report-stale')), 10000)
  check('报告 过期', '改了 P3 提示词 → 标「已过期（AI 的写作要求有更新）」，仍不自动重算', staleP && /写作要求有更新/.test(await txt('report-stale')) && reqs().length === reqBefore, await txt('report-stale').catch(() => ''))
  await api(() => window.api.ai.resetPrompt('p3_report', 'system'))
  check('报告 过期', '恢复默认提示词 → 又是「最新」', await waitFor(async () => Object.values(await listStatus()).every(x => x === 'fresh'), 15000))
  // 删除
  const del = rows()[2].id
  await T(`report-delete-${del}`).click()
  await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
  check('报告 历史', '删除一份报告：库里少一条，列表少一项', await waitFor(async () => rows().length === 2 && (await page.locator('[data-testid^=report-item-]').count()) === 2, 8000))
}

// ───────── 阶段 2：导出 Markdown / PDF ─────────
async function phaseExport() {
  const { page } = ctx
  await goto('#/report')
  await T('report-detail').waitFor()
  await T(`report-item-${ctx.firstReport}`).click()
  await waitFor(async () => (await T('report-body').count()) > 0, 8000)
  const out = path.join(work, 'export'); fs.mkdirSync(out, { recursive: true })
  // ── Markdown ──
  const md = path.join(out, '考情报告.md')
  await stubSave(md)
  await T('report-export-md').click()
  const wrote = await waitFor(async () => fs.existsSync(md), 15000)
  const text = wrote ? fs.readFileSync(md, 'utf8') : ''
  const dir = path.join(out, '考情报告')
  const links = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => decodeURIComponent(m[1]))
  const files = links.map(l => path.join(out, l))
  check('导出 Markdown', '文件存在，内容是这份报告（标题含年级 / 学年 / 版本 / 日期，表格里没有「代码」列），文首有来源注释', wrote && /^<!-- 由「英语校考分析工作台」导出/.test(text) && /# 四年级 2023–2026学年 考情分析报告（完整数据版）· \d{4}-\d{2}-\d{2}/.test(text) && /\| 层级 \| 名称 \|/.test(text) && !/\| 代码 \|/.test(text), text.slice(0, 80))
  check('导出 Markdown', '引用的题目截图导成同名文件夹「考情报告/」下的真实 PNG：文档里每个图片链接指向的文件都存在、都是有效 PNG（至少 1 张）', links.length >= 1 && files.every(f => fs.existsSync(f) && isPng(f)) && links.every(l => /^考情报告\/q-\d{3}\.png$/.test(l)) && fs.readdirSync(dir).length === new Set(links).size, `${links.length} 个链接：${links.slice(0, 3).join(', ')}`)
  // 截图内容正确：C2 第 1 题的裁切图 OCR 出 skirt，且不含相邻题
  // 截图现在放在这一段的后面，不再紧跟在引用后面：按图片的说明文字找
  const c2link = (() => { const m = /!\[题目截图：(2025学年四年级下期末卷C2 · 1)\]\(([^)]+)\)/.exec(text); return m ? decodeURIComponent(m[2]) : null })()
  let ocrOk = false, ocrTxt = ''
  if (c2link && fs.existsSync(path.join(out, c2link))) { ocrTxt = L.ocrText(path.join(out, c2link)); ocrOk = /skirt/i.test(ocrTxt) && !/sheep|library/i.test(ocrTxt) }
  check('导出 Markdown', '截图内容对：C2 第 1 题的裁切图（主进程 nativeImage.crop）用真实 OCR 读出「skirt」，且不含相邻题的 sheep / library', ocrOk, ocrTxt.slice(0, 80))
  // 导出的不含自造引用；表格语法完整（每行列数一致）
  const tableLines = text.split('\n').filter(l => /^\|.*\|$/.test(l.trim()))
  check('导出 Markdown', '没有留下指向不存在文件的图片链接；没有字面的 **[… · …]**；表格行完整', !text.includes('不存在的卷') && tableLines.length > 10 && !/\*\*\[/.test(text))
  // 再导一次到同一个路径：旧图被清掉重写，不会混入旧文件
  fs.writeFileSync(path.join(dir, 'q-099.png'), 'stale')
  await T('report-export-md').click()
  await waitFor(async () => !fs.existsSync(path.join(dir, 'q-099.png')), 10000)
  check('导出 Markdown', '重复导出到同一个位置：上次留下的 q-xxx.png 被清掉，不会混进旧图', !fs.existsSync(path.join(dir, 'q-099.png')) && fs.readdirSync(dir).length === links.length)
  // ── PDF ──
  const pdf = path.join(out, '考情报告.pdf')
  await stubSave(pdf)
  await T('report-export-pdf').click()
  const pwrote = await waitFor(async () => fs.existsSync(pdf) && fs.statSync(pdf).size > 1000, 30000)
  const info = pwrote ? await pdfInfo(pdf) : { pages: 0, text: '' }
  check('导出 PDF', '文件存在、是有效 PDF（%PDF- 开头）、页数 > 0', pwrote && fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-' && info.pages > 0, `${info.pages} 页，${pwrote ? fs.statSync(pdf).size : 0} 字节`)
  check('导出 PDF', '中文能正常显示：PDF 里读得出标题「四年级 2023–2026学年 考情分析报告（完整数据版）」、表头「出现份数/总份数」、章节「教学建议」', /四年级2023–2026学年考情分析报告（完整数据版）/.test(info.text.replace(/\s/g, '')) && info.text.replace(/\s/g, '').includes('出现份数/总份数') && info.text.includes('教学建议'), info.text.slice(0, 60))
  check('导出 PDF', '题目截图出现在 PDF 里（带截图的 PDF 比同一份纯文字大得多：> 40 KB），并且有页脚页码「1 / N」', pwrote && fs.statSync(pdf).size > 40_000 && /1\s*\/\s*\d/.test(info.text), `${fs.statSync(pdf).size} 字节`)
  // PDF 的 HTML 用跨平台字体链：源码级检查（Windows 上无法实跑，见交付说明）
  const src = fs.readFileSync(path.join(root, 'src/shared/mdhtml.ts'), 'utf8')
  check('导出 PDF', '字体回退链含 PingFang SC / Microsoft YaHei / Noto Sans CJK SC / sans-serif，没有依赖 Mac 独有字体（⚠️ Windows 上没有实跑）', /"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"/.test(src) && /sans-serif'?;?\s*$/m.test(src.split('\n').find(l => l.includes('CJK_FONT_STACK =')) ?? ''))
  // 取消保存对话框：什么都不写
  await ctx.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }) })
  const none = path.join(out, '不该出现.pdf')
  await T('report-export-pdf').click()
  await sleep(1200)
  check('导出', '在「另存为」里点取消：没有写任何文件，界面不报错', !fs.existsSync(none) && (await T('report-error').count()) === 0)
}

module.exports = { phaseSetup, phaseReport, phaseExport, parseUser }
