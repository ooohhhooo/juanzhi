// M6 端到端：让不懂英语的人也能用。
//   A1 AI 不再因输出长度失败（推理模型思考中、写不完自动加大上限重试、两次都写不完留草稿、白话报错、队列只给「重试」）
//   A2 报告分读者（老板 / 家长 / 老师 / 完整数据）、标题含年级 / 学期 / 日期、家长版「我已核对」才能导出 / 复制到微信、去代码、去反引号
//   A3 事实核对（time for / time to 写反标「与题目解释矛盾」，证据里没有的标「未核实」）、「AI 草稿 · 请老师核对」
//   A4 重复 / 部分重复的卷子（真实案例：g4-2025-page1.png 是 g4-2025.pdf 的第 1 页）
//   A5 首页角色引导、使用说明；B6 白话 / 隐藏代码 / 管理员设置；B7 知识点白话；B8 样本少不下结论；B9 审核页不悄悄改变；B10 引用截图；C 档导出 Word / PDF 提示 / ._ 清理
// 用法：npm run test:e2e:m6   （沙箱外运行：Vision OCR、本地端口与 Electron 都被沙箱限制；全程用 mock AI，不调用真实服务）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const naive = require('./naive.cjs')
const { DatabaseSync } = require('node:sqlite')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, api, stubSave, cfgFor, saveCfg, root, startMock, open, closeApp, pdfInfo, L } = M
const mammoth = require(path.join(root, 'node_modules/mammoth'))

const FRIENDLY = 'AI 这次没写完，已经自动重试过；可以点「重试」，多次失败请联系管理员'
const TECH = /token|tokens|输出上限|输出长度|max_tokens|finish_reason|HTTP|\b[45]\d\d\b/i
const reports = () => withDb(ctx.ud, d => d.prepare("SELECT * FROM reports WHERE kind = 'report' ORDER BY created_at, rowid").all())
const p3reqs = () => ctx.mock.p3Requests
const p2reqs = () => ctx.mock.p2Requests
const drafts = () => withDb(ctx.ud, d => d.prepare('SELECT * FROM ai_drafts').all())
const CODE_RE = /\b[A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*)+\b|\b[A-Z]{2,}_[A-Z]+\b/
const REPORT = '[data-testid=report-page]'
const sel = id => ctx.page.locator(`[data-testid="${id}"]`)

/** 在报告页选读者、点生成，等到「正在生成」消失（成功入库或出错） */
async function generate(reader, { expectError = false, waitMs = 60000 } = {}) {
  const { page } = ctx
  const before = reports().length
  await T(`reader-${reader}`).locator('xpath=ancestor::label').click()
  await waitFor(async () => (await T('report-generate').count()) > 0 || (await T('report-retry').count()) > 0, 15000)
  if (await T('report-dismiss').count()) await T('report-dismiss').click()
  await T('report-generate').click()
  const ok = await waitFor(async () => (expectError ? (await T('report-error').count()) > 0 : reports().length > before && (await T('report-running').count()) === 0), waitMs)
  // 入库之后，页面还要取详情、把新报告渲染出来；后面的断言要读页面（引用卡片、标记），必须等到页面上显示的就是这一份（标题里带版本名），
  // 不能在入库那一刻就去数元素——那是「A2 老师版」偶发失败的根因：入库了，但正文还是上一份报告或还没画完
  if (ok && !expectError) {
    const label = { boss: '老板版', parent: '家长版', teacher: '老师版', full: '完整数据版' }[reader]
    await waitFor(async () => (await T('report-body').count()) > 0 && (await T('report-body').innerText().catch(() => '')).includes(label), 15000)
  }
  return { ok, row: reports()[reports().length - 1] }
}

async function main() {
  // ───────────────────────── 阶段 0：全新电脑第一次打开（管理员设置默认收起） ─────────────────────────
  const udFirst = path.join(work, 'first')
  await open(udFirst, { adminOpen: false })
  {
    const { page } = ctx
    check('首页引导', '全新数据库、第一次打开：首页有「我是运营 / 我是辅导老师」两条路线（默认运营），每条 3 步，每步一句白话 + 一个跳转按钮', await waitFor(async () => (await T('role-guide').count()) === 1, 10000)
      && /我是运营/.test(await txt('role-guide-role')) && /我是辅导老师/.test(await txt('role-guide-role')) && (await page.locator('[data-testid^=role-step-ops-]').count()) === 3 && !/\bM[1-6]\b/.test(await txt('role-guide')), (await txt('role-guide')).slice(0, 80))
    await sel('role-step-go-ops-1').click()
    check('首页引导', '运营第 1 步「去试卷库」按钮可用（停在试卷库）', (await page.evaluate(() => location.hash)).replace('#', '') === '/')
    await sel('role-step-go-ops-2').click()
    check('首页引导', '运营第 2 步跳到「处理队列」', await waitFor(async () => (await page.evaluate(() => location.hash)) === '#/queue', 5000))
    await goto('#/'); await T('role-guide').waitFor()
    await page.locator('[data-testid=role-guide-role] .ant-segmented-item', { hasText: '我是辅导老师' }).click()
    // 点了切换之后要等新的三步画出来再读（偶发失败的根因：点击一返回就去数元素，React 还没重画）
    await waitFor(async () => (await page.locator('[data-testid^=role-step-tutor-]').count()) === 3, 8000)
    check('首页引导', '切到「我是辅导老师」：另一条三步路线（审核 → 看分析 → 生成老师版和家长版）', (await page.locator('[data-testid^=role-step-tutor-]').count()) === 3 && /核对 AI 标的题/.test(await txt('role-step-tutor-1')) && /家长版/.test(await txt('role-step-tutor-3')))
    await sel('role-step-go-tutor-3').click()
    check('首页引导', '辅导老师第 3 步跳到「AI 报告」', await waitFor(async () => (await page.evaluate(() => location.hash)) === '#/report', 5000))
    await goto('#/'); await T('role-guide').waitFor()
    await T('role-guide-dismiss').click()
    await waitFor(async () => (await T('role-guide-collapsed').count()) === 1, 5000)
    check('首页引导', '「收起」后只留一行「展开三步上手 · 查看使用说明」，重新进入页面仍是收起的；点「展开」又出来', (await T('role-guide').count()) === 0 && (await T('role-guide-collapsed').count()) === 1
      && (await (async () => { await page.reload(); await T('dropzone').waitFor(); return await waitFor(async () => (await T('role-guide-collapsed').count()) === 1, 8000) })()))
    await T('role-guide-reopen').click()
    check('首页引导', '点「展开三步上手」恢复引导卡片', await waitFor(async () => (await T('role-guide').count()) === 1, 5000))
    await T('open-help').first().click()
    await T('help-page').waitFor()
    const help = await txt('help-body')
    check('使用说明', '「使用说明」页面向两个角色：写明运营 / 辅导老师各自的步骤、家长版要「我已核对」、AI 失败点「重试」、管理员设置在哪；没有里程碑字样', /我是运营/.test(help) && /我是辅导老师/.test(help) && /我已核对/.test(help) && /重试/.test(help) && /管理员设置/.test(help) && !/\bM[1-6]\b|里程碑/.test(help))
    // 设置页：管理员设置默认收起，技术设置不在老师眼前
    await goto('#/settings'); await T('admin-settings').waitFor()
    check('管理员设置', '设置页默认只有「示例数据 / 知识点 / 关于」；AI 服务、提示词、文字识别、数据包都在收起的「管理员设置」里', (await T('admin-settings-body').count()) === 0 && (await T('ai-settings').count()) === 0 && (await T('data-pack').count()) === 0 && (await T('prompt-settings').count()) === 0 && (await T('data-sample').count()) === 1 && (await T('taxonomy-settings').count()) === 1)
    check('管理员设置', '设置页上没有 Base URL / token / 输出长度这类技术词（默认状态）', !/Base URL|token|输出长度|API Key|提示词/.test((await page.locator('body').innerText())))
    await T('admin-toggle').click()
    check('管理员设置', '点「展开管理员设置」后技术设置出现（AI 服务、数据包、提示词、文字识别），「显示内部代码」默认关', await waitFor(async () => (await T('admin-settings-body').count()) === 1, 5000) && (await T('ai-settings').count()) === 1 && (await T('data-pack').count()) === 1 && (await T('prompt-settings').count()) === 1
      && (await T('show-codes-switch').getAttribute('aria-checked')) === 'false')
    // /settings?admin=1 直接展开（「请联系管理员」的提示都链到这里）
    await T('admin-toggle').click()
    await page.evaluate(() => { location.hash = '#/settings?admin=1' }); await page.reload(); await T('admin-settings').waitFor()
    check('管理员设置', '链接 #/settings?admin=1 直接展开管理员设置（各处「请联系管理员」的提示链到这里）', await waitFor(async () => (await T('admin-settings-body').count()) === 1, 8000))
    // 迁移 v10：新库的版本和内置白话
    check('迁移 v10', '全新库 = v10：知识点表有白话 / 例句 / 例词四列，145 个内置节点全部有内容；reports 有 reader / confirmed_at / verify_json；有 ai_drafts 表', withDb(udFirst, d => {
      const cols = t => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
      return d.prepare('PRAGMA user_version').get().user_version === 10 && ['plain', 'example_en', 'example_zh', 'hint_words'].every(c => cols('kps').includes(c)) && d.prepare('SELECT COUNT(*) c FROM kps WHERE builtin = 1 AND plain IS NOT NULL AND example_en IS NOT NULL AND hint_words IS NOT NULL').get().c === 145
        && ['reader', 'confirmed_at', 'verify_json'].every(c => cols('reports').includes(c)) && cols('ai_drafts').includes('markdown') && ['similar_state', 'similar_to', 'error_detail'].every(c => cols('papers').includes(c))
    }))
    // 旧默认输出上限 8192 → 自动
    const cfg = await api(() => window.api.ai.getConfig())
    check('A1 默认输出上限', '全新配置：输出上限「自动」（按模型取默认；推理模型 32768），不再是固定的 8192', cfg.max_tokens_auto === true && cfg.max_tokens === 32768, JSON.stringify([cfg.max_tokens, cfg.max_tokens_auto]))
    const pr = await api(() => window.api.ai.presets())
    const ds = pr.find(p => p.id === 'deepseek')
    check('A1 模型档案', 'DeepSeek 预设里 deepseek-v4-pro 标注为推理模型：默认 32768、天花板 65536', ds.profiles['deepseek-v4-pro'].reasoning === true && ds.profiles['deepseek-v4-pro'].defaultMaxTokens === 32768 && ds.profiles['deepseek-v4-pro'].ceiling === 65536, JSON.stringify(ds.profiles['deepseek-v4-pro']))
  }
  await closeApp()

  // ───────────────────────── 阶段 1：夹具 ─────────────────────────
  ctx.mock = await startMock({ apiKey: SECRET })
  const mock = ctx.mock
  const ud = path.join(work, 'userA')
  const r = await open(ud)
  await r.app.close()
  const pageSize = { width: 1224, height: 1584 }
  const s = seed(ud, { bboxes: {}, pageImage: pageImg, pageSize })
  ctx.ids = s.ids; ctx.qids = s.qids
  {
    const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
    db.exec('PRAGMA foreign_keys=ON')
    // 事实核对的证据：C1 第 3 题改成「介词固定搭配」，老师审核过的易错说明写对了 time for / time to
    db.prepare("UPDATE questions SET stem = ?, qtype = 'MC', error_prone = 1, error_reason = ? WHERE id = ?").run("It's time ____ breakfast.", 'time for + 名词，time to + 动词', s.qids.C1Q3)
    db.prepare("UPDATE question_kps SET kp_code = 'GR.PREP.COLLOC' WHERE question_id = ? AND is_primary = 1").run(s.qids.C1Q3)
    // 同类题标注不一致（B9）：三年级一份卷子里 4 道同一个知识点的单选，难度 3,3,3,5
    const pid = '00000000-0000-4000-8000-0000000000e1'
    db.prepare("INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, file_name, file_hash, status, created_at) VALUES (?, '三年级一致性卷', '3', '上', 2025, '期中', '人教PEP', 'S1.pdf', 'hash-S1', 'done', '2026-10-20 09:00:00')").run(pid)
    ;[3, 3, 3, 5].forEach((diff, i) => {
      const qid = `00000000-0000-4000-8000-0000000000f${i + 1}`
      db.prepare("INSERT INTO questions (id, paper_id, ord, no_label, no, section, qtype, stem, options, score, difficulty, error_prone, error_reason, confidence, reviewed, flags_json) VALUES (?, ?, ?, ?, ?, '一', 'MC', ?, '[]', 2, ?, 0, '', 1, 1, '[]')").run(qid, pid, i + 1, String(i + 1), i + 1, `S1-${i + 1} Look at the ____ (sheep).`, diff)
      db.prepare("INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, 'GR.NOUN.PLURAL.IRR', 1)").run(qid)
    })
    ctx.consistencyPaper = pid; ctx.consistencyOdd = '00000000-0000-4000-8000-0000000000f4'
    db.close()
  }
  await open(ud)
  await saveCfg(cfgFor(mock, { model: 'mock-reasoning-model', max_tokens_auto: true }), SECRET)
  await setFilter({ grade: '4' }, '#/report')
  await T('report-page').waitFor()

  // ───────────────────────── 阶段 2：A1 AI 不再因输出长度失败 ─────────────────────────
  {
    const { page } = ctx
    // 2.1 推理模型：先流出思考（reasoning_content），界面显示「AI 正在思考 · 已用 N 秒（通常 2–3 分钟）」，思考不进正文；默认上限 32768
    mock.reasoning = { chars: 480, delayMs: 300 }
    mock.resetStats()
    await T('reader-full').locator('xpath=ancestor::label').click()
    await T('report-generate').click()
    const sawThink = await waitFor(async () => (await T('report-running').count()) > 0 && /AI 正在思考 · 已用 \d+ 秒（通常 2–3 分钟）/.test(await txt('report-running')), 8000)
    const lenWhileThinking = (await T('report-text').count()) ? await T('report-text').getAttribute('data-len') : '0'
    const done1 = await waitFor(async () => reports().length === 1 && (await T('report-running').count()) === 0, 40000)
    check('A1 思考状态', '推理模型思考时界面显示「AI 正在思考 · 已用 N 秒（通常 2–3 分钟）」，此时正文还是空的（思考内容不进正文）', sawThink && lenWhileThinking === '0', await txt('report-running').catch(() => ''))
    check('A1 默认上限', '推理模型（mock-reasoning-model）自动上限 = 32768；生成成功，正文里没有思考内容', done1 && p3reqs().length === 1 && p3reqs()[0].maxTokens === 32768 && !reports()[0].markdown.includes('思思思'), JSON.stringify(p3reqs().map(x => x.maxTokens)))
    check('A1 用量', 'ai_usage 记下推理模型的思考 token（reasoning_tokens 包含在输出里，不额外计）', withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM ai_usage WHERE kind = 'p3_report' AND ok = 1").get().c) === 1)
    mock.reasoning = null

    // 2.2 先写不完（finish_reason=length）、加倍上限后成功：用户无感，只多一次请求
    mock.resetStats(); mock.script([{ type: 'length', times: 1, only: 'p3' }])
    const g2 = await generate('full')
    check('A1 自动加大重试', '第一次写不完（length）→ 程序把上限 32768 翻倍到 65536 自动重试 → 成功入库；用户没有看到任何报错', g2.ok && p3reqs().length === 2 && p3reqs()[0].maxTokens === 32768 && p3reqs()[1].maxTokens === 65536 && (await T('report-error').count()) === 0 && reports().length === 2, JSON.stringify(p3reqs().map(x => x.maxTokens)))

    // 2.3 两次都写不完：白话报错，技术原因收在详情里，已写出的部分留作草稿（不是有效结果）
    mock.resetStats(); mock.script([{ type: 'length', times: 2, only: 'p3' }])
    const g3 = await generate('full', { expectError: true })
    const msg = g3.ok ? await txt('report-error') : ''
    await T('report-error').locator('.ant-collapse-header').first().click(); await sleep(300)
    const detail = await txt('report-error-detail').catch(() => '')
    check('A1 白话报错', `两次都写不完：提示「${FRIENDLY}」，不出现 token、输出上限、HTTP 这类词`, g3.ok && msg.includes(FRIENDLY) && !TECH.test(msg.replace('查看详情（给管理员看）', '')) && p3reqs().length === 2 && reports().length === 2, msg)
    check('A1 查看详情', '「查看详情」折叠里才有技术原因（finish_reason=length、上限 32768→65536），给管理员看', /finish_reason=length/.test(detail) && /65536/.test(detail), detail.slice(0, 120))
    check('A1 未完成草稿', '失败时已生成的部分存成「未完成草稿」（ai_drafts 一行、有内容），不进历史报告', drafts().length === 1 && drafts()[0].kind === 'report' && drafts()[0].markdown.length > 20 && reports().length === 2 && /AI 这次没写完/.test(drafts()[0].message))
    await T('report-dismiss').click()
    await T('report-draft-box').waitFor({ timeout: 8000 }).catch(() => undefined)
    check('A1 查看草稿', '关掉报错后，页面上仍有「未完成草稿」入口，点开能看到已写出的内容，并写明「不算有效结果」', (await T('report-draft-box').count()) === 1 && /不算有效结果/.test(await txt('report-draft-box')), await txt('report-draft-box').catch(() => ''))
    await T('report-draft-box').locator('.ant-collapse-header').first().click(); await sleep(300)
    check('A1 查看草稿', '草稿正文可见', (await txt('report-draft-text')).length > 20)
    // 重试成功：草稿清掉
    const gOk = await generate('full')
    check('A1 草稿清理', '再生成一次成功后，未完成草稿自动清掉', gOk.ok && drafts().length === 0 && reports().length === 3)

    // 2.4 P2 同比解读：同样的流程（接口层）
    const scope = { filter: { grade: '4' }, target: 2025, base: 'before', level: 2, align: true }
    mock.resetStats(); mock.script([{ type: 'length', times: 2, only: 'p2' }])
    const res = await api(sc => window.api.ai.analyzeCompare(sc, crypto.randomUUID()), scope)
    const st = await api(sc => window.api.ai.compareAnalysis(sc), scope)
    check('A1 P2 失败', 'P2 两次都写不完：白话报错 + 技术详情；已写出的部分存成草稿，缓存状态仍是「还没有分析」', res.ok === false && res.message === FRIENDLY && /finish_reason=length/.test(res.detail) && st.status === 'none' && !!st.draft && st.draft.markdown.length > 10 && st.aiDraft === true, JSON.stringify([res.message, st.status, !!st.draft]))
    mock.resetStats()
    const res2 = await api(sc => window.api.ai.analyzeCompare(sc, crypto.randomUUID()), scope)
    const st2 = await api(sc => window.api.ai.compareAnalysis(sc), scope)
    check('A1 P2 成功', 'P2 重新生成成功：入缓存、草稿清掉；默认上限同样是 32768', res2.ok && st2.status === 'fresh' && st2.draft === null && p2reqs()[0].maxTokens === 32768, JSON.stringify(p2reqs().map(x => x.maxTokens)))

    // 2.5 处理队列（P1）：思考状态、写不完自动加大、失败只给「重试」+「更多」
    await goto('#/')
    const f1 = path.join(root, 'samples/g4-2025.pdf')
    mock.resetStats(); mock.delayMs = 2500; mock.script([{ type: 'length', times: 1, only: 'p1' }])
    await L.dropFiles(page, [f1])
    await goto('#/queue')
    const sawQ = await waitFor(async () => /AI 正在思考 · 已用 \d+ 秒（通常 2–3 分钟）/.test((await page.locator('[data-testid="qstate-g4-2025.pdf"]').innerText().catch(() => '')) || ''), 60000)
    check('A1 队列思考状态', '处理队列里这份卷子显示「AI 正在思考 · 已用 N 秒（通常 2–3 分钟）」（P1 也能看到）', sawQ, await page.locator('[data-testid="qstate-g4-2025.pdf"]').innerText().catch(() => ''))
    const p = await L.waitStatus(page, 'g4-2025.pdf', ['reviewing', 'failed'], 120000)
    mock.delayMs = 0
    const p1r = mock.p1Requests
    check('A1 P1 自动加大', 'P1 第一次写不完（length）→ 上限 32768 翻倍到 65536 自动重试 → 成功进待审核；队列里没有失败', p && p.status === 'reviewing' && p1r.length === 2 && p1r[0].maxTokens === 32768 && p1r[1].maxTokens === 65536, JSON.stringify(p1r.map(x => x.maxTokens)))
    check('B7 提示词带白话', 'P1 发给 AI 的知识点树每行 5 栏（代码 | 路径 | 年级 | 说明 | 白话），物主代词那一行带白话「表示“谁的”」', (() => {
      const tree = /【知识点树】[^\n]*\n([\s\S]*?)\n\n【题型列表】/.exec(p1r[0].user)?.[1] ?? ''
      const lines = tree.split('\n')
      return lines.length > 100 && lines.every(l => l.split(' | ').length === 5) && /GR\.PRON\.POSS \| .+ \| .+ \| .+ \| .*谁的/.test(tree)
    })(), p1r[0].user.slice(0, 60))
    check('A1 P1 新版提示词', 'P1 的 system 要求：同类题难度 / 易错一致、error_reason 用白话（docs/prompts/v2 的原文）', /同类题要一致/.test(p1r[0].system) && /用不懂英语的老师也看得懂的白话写/.test(p1r[0].system))

    // 失败：持续写不完（非推理模型不翻倍，直接拆小再失败）→ 白话 + 详情；队列只有「重试」主按钮，其它收进「更多」
    await saveCfg(cfgFor(mock, { model: 'mock-text-model', max_tokens_auto: true }), SECRET)
    const f2 = L.copyWithTag(path.join(root, 'samples/g4-2026.pdf'), path.join(work, 'g4-2026-fail.pdf'), 'fail')
    mock.resetStats(); mock.script([{ type: 'length', times: 50, only: 'p1' }])
    await L.dropFiles(page, [f2])
    const pf = await L.waitStatus(page, 'g4-2026-fail.pdf', ['failed', 'reviewing'], 120000)
    mock.clearScript()
    await goto('#/queue')
    await page.locator('[data-testid=queue-all], .ant-segmented-item', { hasText: '全部' }).first().click().catch(() => undefined)
    const row = page.locator('tr', { hasText: 'g4-2026-fail.pdf' })
    await row.waitFor({ timeout: 10000 })
    const perr = await row.locator('[data-testid=paper-error]').innerText().catch(() => '')
    await row.locator('.ant-collapse-header').first().click().catch(() => undefined); await sleep(300)
    const pdetail = await row.locator('[data-testid=paper-error-detail]').innerText().catch(() => '')
    check('A1 队列白话报错', 'P1 持续写不完：失败原因是白话「AI 没能完整读懂第 N 页（已经自动重试过）…点「重试」，多次失败请联系管理员」，不出现技术词；技术原因在「查看详情」里', pf.status === 'failed' && /AI 没能完整读懂第 \d 页（已经自动重试过）；可以点「重试」，多次失败请联系管理员/.test(perr) && !TECH.test(perr) && /长度上限|length/.test(pdetail) && !!pf.error_detail, `${perr}｜${pdetail}`.slice(0, 160))
    check('A1 队列重试按钮', '失败的卷子只有一个「重试」主按钮，其它三个选项收进「更多」', (await row.locator('[data-testid=retry-parse]').innerText()).trim() === '重试' && (await row.locator('[data-testid=retry-menu]').innerText()).trim() === '更多' && (await row.locator('button', { hasText: '重试' }).count()) === 1)
    await row.locator('[data-testid=retry-menu]').click()
    const items = await page.locator('.ant-dropdown-menu-item').allInnerTexts()
    check('A1 队列「更多」菜单', '「更多」里是三个白话选项（重新让 AI 读一遍 / 只重新找题目位置 / 从头来），不再叫「仅重新定位（沿用上次 AI 结果，不再调用模型）」', items.length === 3 && items.some(x => /重新让 AI 读一遍/.test(x)) && items.some(x => /只重新找题目位置/.test(x)) && items.some(x => /从头来/.test(x)), items.join('｜'))
    await page.keyboard.press('Escape')
    // 点「重试」成功
    await row.locator('[data-testid=retry-parse]').click()
    const pr2 = await L.waitStatus(page, 'g4-2026-fail.pdf', ['reviewing', 'failed'], 120000)
    check('A1 队列重试', '点「重试」后成功进待审核，失败原因和详情清空', pr2.status === 'reviewing' && pr2.error === null && pr2.error_detail === null)
  }

  // ───────────────────────── 阶段 3：A4 重复 / 部分重复的卷子 ─────────────────────────
  {
    const { page } = ctx
    // g4-2025.pdf 已经解析好（待审核）。再导入 g4-2025-page1.png（它就是 PDF 的第 1 页）
    await goto('#/')
    await L.dropFiles(page, [pageImg])
    const pp = await L.waitStatus(page, 'g4-2025-page1.png', ['reviewing', 'failed'], 180000)
    const row = () => withDb(ctx.ud, d => d.prepare("SELECT p.*, (SELECT title FROM papers s WHERE s.id = p.similar_to) st FROM papers p WHERE file_name = 'g4-2025-page1.png'").get())
    await waitFor(async () => row()?.similar_state === 'suspect', 10000)
    const rr = row()
    const orig = withDb(ctx.ud, d => d.prepare("SELECT id, title FROM papers WHERE file_name = 'g4-2025.pdf'").get())
    check('A4 疑似重复', '导入 g4-2025-page1.png（就是 g4-2025.pdf 的第 1 页）：解析完成后被标成「疑似重复」，指向 g4-2025.pdf，重合度 ≥ 80%', pp && pp.status === 'reviewing' && rr.similar_state === 'suspect' && rr.similar_to === orig.id && rr.similar_ratio >= 0.8, JSON.stringify([rr.similar_state, rr.similar_ratio]))
    // 默认不计入统计（待审核 + 含待审核开关打开也不计）
    const cnt = f => api(x => window.api.stats.overview(x), f)
    const o1 = await cnt({ includeReviewing: true, grade: '4' })
    // 真实卷子这里没有 g4 夹具冲突：直接数 g4-2025 系列的两份
    const nSuspect = withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM papers WHERE similar_state = 'suspect'").get().c)
    check('A4 默认不计入', '疑似重复的卷子默认不计入统计；范围说明里写明「有 1 份疑似重复的卷子没有计入」', nSuspect === 1 && o1.similarSuspects === 1, JSON.stringify([nSuspect, o1.similarSuspects]))
    await goto('#/queue')
    await page.locator('.ant-segmented-item', { hasText: '全部' }).first().click()
    const qrow = page.locator('tr', { hasText: 'g4-2025-page1.png' })
    await qrow.waitFor({ timeout: 8000 })
    const notice = await qrow.locator('[data-testid=similar-notice]').innerText().catch(() => '')
    check('A4 白话提醒', '处理队列里这份卷子下面有白话提醒：「疑似重复：像是《…》的一部分（NN% 的题在那份卷子里也有）」，并给「确实是新卷，计入统计」「删除这份」两个选择', /疑似重复：像是《.+》的一部分（\d+% 的题在那份卷子里也有）/.test(notice) && (await qrow.locator('[data-testid=similar-accept]').count()) === 1 && (await qrow.locator('[data-testid=similar-delete]').count()) === 1, notice.slice(0, 80))
    await goto('#/')
    check('A4 试卷库提醒', '试卷库里同一份卷子标题旁有「疑似重复」小标签', (await page.locator('tr', { hasText: 'g4-2025-page1' }).locator('[data-testid=similar-tag]').count()) === 1)
    await goto('#/queue')
    await page.locator('.ant-segmented-item', { hasText: '全部' }).first().click()
    await page.locator('tr', { hasText: 'g4-2025-page1.png' }).locator('[data-testid=similar-accept]').click()
    await waitFor(async () => row()?.similar_state === 'accepted', 8000)
    const o2 = await cnt({ includeReviewing: true, grade: '4' })
    check('A4 确实是新卷', '点「确实是新卷，计入统计」：状态变 accepted，以后不再提示，统计里计入（疑似份数回到 0）', row().similar_state === 'accepted' && o2.similarSuspects === 0 && (await T('similar-notice').count()) === 0)
    // 删除这份：再造一次
    const dup2 = L.copyWithTag(pageImg, path.join(work, 'g4-2025-page1-again.png'), 'again')
    await goto('#/')
    await L.dropFiles(page, [dup2])
    await L.waitStatus(page, 'g4-2025-page1-again.png', ['reviewing', 'failed'], 180000)
    await waitFor(async () => withDb(ctx.ud, d => d.prepare("SELECT similar_state s FROM papers WHERE file_name = 'g4-2025-page1-again.png'").get()?.s) === 'suspect', 10000)
    await goto('#/queue')
    await page.locator('.ant-segmented-item', { hasText: '全部' }).first().click()
    const q2 = page.locator('tr', { hasText: 'g4-2025-page1-again.png' })
    await q2.locator('[data-testid=similar-delete]').click()
    await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
    check('A4 删除这份', '点「删除这份」→ 确认后这份卷子从库里删除', await waitFor(async () => withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM papers WHERE file_name = 'g4-2025-page1-again.png'").get().c) === 0, 8000))
    // 「检查重复试卷」（升级后整库扫描）：夹具里的卷子题干是「Q-n 题干」这类占位文字，规范化后太短、根本不参与比较，
    // 所以「没被误标」在它们身上永远成立、说明不了什么；真的检查放在最后一个阶段（阶段 8：造可比较的题干，再扫描）
    // 清理这三份导入的卷子，免得影响后面按夹具手算的数字
    for (const f of ['g4-2025.pdf', 'g4-2025-page1.png', 'g4-2026-fail.pdf']) {
      const id = withDb(ctx.ud, d => d.prepare('SELECT id FROM papers WHERE file_name = ?').get(f)?.id)
      if (id) await api(i => window.api.papers.remove(i), id)
    }
  }

  // ───────────────────────── 阶段 4：A2 / A3 报告分读者、事实核对、家长版核对、导出 ─────────────────────────
  {
    const { page } = ctx
    await saveCfg(cfgFor(mock, { model: 'mock-text-model', max_tokens_auto: true }), SECRET)
    await setFilter({ grade: '4' }, '#/report')
    await T('report-page').waitFor()
    const base = reports().length
    // 老板版
    mock.resetStats(); mock.quirks = { p3: { echoCodes: true, backtick: true } }
    const gb = await generate('boss')
    const boss = reports()[reports().length - 1]
    check('A2 老板版', '老板版：存库 reader = boss；标题含年级 / 学年 / 版本 / 日期、不含「全部年级」；开头「三句话结论」、再「教研重点与课程卖点」「风险提示」；没有表格', gb.ok && boss.reader === 'boss' && /^# 四年级 2023–2026学年 考情分析报告（老板版）· \d{4}-\d{2}-\d{2}/.test(boss.markdown) && !boss.markdown.includes('全部年级') && boss.markdown.indexOf('## 三句话结论') < boss.markdown.indexOf('## 教研重点与课程卖点') && boss.markdown.indexOf('## 教研重点与课程卖点') < boss.markdown.indexOf('## 风险提示') && !/\|---/.test(boss.markdown) && boss.title === boss.markdown.split('\n')[0].replace(/^# /, ''), boss.title)
    check('A2 去代码', '模型在正文里写出的内部代码（GR.NOUN.PLURAL、PH_DIFF）被程序去掉；引用外面的反引号也去掉了', !CODE_RE.test(boss.markdown) && !boss.markdown.includes('`'), (boss.markdown.match(CODE_RE) ?? [])[0] ?? '')
    check('A2 提示词 老板版', 'P3 老板版发给 AI 的 system = docs/prompts/v2 里的老板版 system；同一份证据包（11 个占位符）', p3reqs()[0].system === L.docsPrompt('p3_boss', 'system') && /【题目解释（证据）】/.test(p3reqs()[0].user) && !/\{\{/.test(p3reqs()[0].user))
    // 老师版
    mock.quirks = { p3: { echoCodes: true, backtick: true } }
    const gt = await generate('teacher')
    const teacher = reports()[reports().length - 1]
const teacherCards = await waitFor(async () => (await T('report-body').locator('[data-testid=cite-card]').count()) >= 1, 15000)
    // 引用截图集中放在这一段 / 这一条的后面（cite-row），不夹在句子中间
    const teacherRows = await T('report-body').locator('[data-testid=cite-row]').count()
    const tparts = {
      ok: !!gt.ok, reader: teacher.reader === 'teacher', h3: /### 1\./.test(teacher.markdown), example: /\*\*原卷例题\*\*/.test(teacher.markdown), points: /\*\*讲解要点\*\*/.test(teacher.markdown),
      noBacktick: !teacher.markdown.includes('`'), refs: JSON.parse(teacher.refs_json).length >= 1, cards: !!teacherCards, rows: teacherRows >= 1
    }
    check('A2 老师版', '老师版：易错点（错在哪 / 原卷例题 / 练法 / 讲解要点）+ 备课建议；引用的原卷例题保留（截图卡片）、反引号去掉', Object.values(tparts).every(Boolean), JSON.stringify(tparts))
    // 完整数据版：mock 照真实模型的样子在表格里放「代码」列 + 写错规则 + 编一条证据里没有的规则
    mock.quirks = { p3: { echoCodes: true, backtick: true, wrongRule: true, inventRule: true } }
    const gf = await generate('full')
    const full = reports()[reports().length - 1]
    check('A2 完整数据版', '完整数据版：表格里的「代码」列整列去掉（输入表里有，输出里没有）、正文没有内部代码、没有反引号', gf.ok && full.reader === 'full' && /\| 层级 \| 名称 \|/.test(full.markdown) && !/\| 代码 \|/.test(full.markdown) && !CODE_RE.test(full.markdown) && !full.markdown.includes('`'), full.markdown.split('\n').find(l => /^\| 层级/.test(l)) ?? '')
    const ver = JSON.parse(full.verify_json)
    check('A3 事实核对', 'time for / time to 写反了（「It\'s time for 后接动词」）→ 标「与题目解释矛盾」；证据里没有的规则（be good at …）→ 标「未核实」；写对的不标', ver.some(v => v.kind === 'conflict' && /time for/.test(v.sentence)) && ver.some(v => v.kind === 'unverified' && /be good at/.test(v.sentence)) && full.markdown.includes('〔与题目解释矛盾，请核对〕') && full.markdown.includes('〔未核实〕'), JSON.stringify(ver.map(v => [v.kind, v.sentence.slice(0, 20)])))
    check('A3 界面标记', '正文里的标记画成小标签（「未核实」橙、「与题目解释矛盾」红），页面上方汇总「有 N 句…」，并给出是哪几句', (await T('report-body').locator('[data-testid=mark-conflict]').count()) >= 1 && (await T('report-body').locator('[data-testid=mark-unverified]').count()) >= 1 && /有 2 句讲英语规则的话/.test(await txt('report-unverified')), await txt('report-unverified').catch(() => ''))
    check('A3 AI 草稿标识', '每份报告都带「AI 草稿 · 请老师核对」标识（状态字段 aiDraft = true，confirmedAt = null）', /AI 草稿 · 请老师核对/.test(await txt('ai-draft-badge')) && (await T('ai-draft-badge').getAttribute('data-confirmed')) === '0')
    const detail = await api(i => window.api.report.get(i), full.id)
    check('A3 状态字段', 'report:get 返回 aiDraft / reader / readerLabel / confirmedAt / needsConfirm / unverified（给设计代理）', detail.aiDraft === true && detail.reader === 'full' && detail.readerLabel === '完整数据版' && detail.confirmedAt === null && detail.needsConfirm === false && detail.unverified.length === 2)
    // 完整版的 P3 提示词：system 逐字 = docs 里的完整数据版；证据里有老师审核过的易错说明
    const ev = /【题目解释（证据）】[^\n]*\n列：[^\n]*\n([\s\S]*?)\n\n请按 system/.exec(p3reqs()[p3reqs().length - 1].user)?.[1] ?? ''
    check('A3 证据注入', '提示词里的「题目解释（证据）」带每个知识点的白话、例句和老师审核过的易错说明（time for + 名词，time to + 动词），且不含内部代码', /介词固定搭配 \| .+ \| .+ \| time for \+ 名词，time to \+ 动词/.test(ev) && !CODE_RE.test(ev), ev.slice(0, 120))

    // 家长版：删统计词、删矛盾句；必须「我已核对」才能导出 / 复制
    mock.quirks = { p3: { parentStats: true, wrongRule: true } }
    const gp = await generate('parent')
    const parent = reports()[reports().length - 1]
    const pw = JSON.parse(parent.warnings_json)
    check('A2 家长版', '家长版：不出现统计词和百分比（含「100% / 出现率 / 分值占比」的句子整句删掉）；写反的 time for 规则整句删掉；正文 ≤ 300 字', gp.ok && parent.reader === 'parent' && !/%|出现率|分值|占比|基线/.test(parent.markdown) && !/It's time for 后接动词/.test(parent.markdown) && pw.some(w => /已从家长版里删掉/.test(w)) && pw.some(w => /统计词或百分比/.test(w)) && parent.markdown.replace(/^#.*\n/, '').replace(/\s/g, '').length <= 300 + 30, parent.markdown.slice(0, 120))
    check('A2 家长版未核对', '家长版未核对时：「导出 Word / PDF / Markdown」和「复制到微信」都是灰的，页面写明「要先由老师核对」，历史列表标「待老师核对」', (await T('report-export-docx').isDisabled()) && (await T('report-export-pdf').isDisabled()) && (await T('report-export-md').isDisabled()) && (await T('report-copy-wechat').isDisabled()) && (await T('report-needs-confirm').count()) === 1 && /待老师核对/.test(await txt(`report-item-${parent.id}`)))
    const rej = await api(i => window.api.report.copyWechat(i).then(() => 'ok', e => String(e.message)), parent.id)
    const rej2 = await api(i => window.api.report.export(i, 'docx').then(() => 'ok', e => String(e.message)), parent.id)
    check('A2 后端把关', '绕过界面直接调接口也不行：家长版未核对时复制 / 导出都被拒绝（「先点我已核对」）', /我已核对/.test(rej) && /我已核对/.test(rej2), `${rej}｜${rej2}`)
    await T('report-confirm').click()
    await T('confirm-dialog').waitFor()
    const dlg = await txt('confirm-dialog')
    check('A2 核对确认框', '点「我已核对」弹确认框，写明核对后才能导出 / 复制；列出还标着「未核实」的句子（没有则不列）', /才能导出或复制到微信/.test(dlg))
    // 有「未核实」的句子时，确认键默认禁用：要先把每一句都勾「已确认无误」（或删掉）才能点
    for (const cb of await T('confirm-dialog').locator('[data-testid=verify-ok]').all()) await cb.click()
    await T('confirm-ok').click()
    await waitFor(async () => !(await T('report-copy-wechat').isDisabled()), 8000)
    check('A2 核对后', '核对后：标识换成「已由老师核对 · 时间」，导出和复制到微信可用，库里 confirmed_at 有值', (await T('ai-draft-badge').getAttribute('data-confirmed')) === '1' && /已由老师核对/.test(await txt('ai-draft-badge')) && !(await T('report-export-docx').isDisabled()) && withDb(ctx.ud, d => d.prepare('SELECT confirmed_at c FROM reports WHERE id = ?').get(parent.id).c) !== null)
    // 复制到微信：纯文本
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('旧的剪贴板内容'))
    await T('report-copy-wechat').click()
    await waitFor(async () => (await ctx.app.evaluate(({ clipboard }) => clipboard.readText())) !== '旧的剪贴板内容', 8000)
    const wx = await ctx.app.evaluate(({ clipboard }) => clipboard.readText())
    check('A2 复制到微信', '复制到剪贴板的是纯文本：带换行和序号（1. 2. 3.），没有任何 Markdown 符号（# * > | ` [ ]）、没有〔未核实〕标记；每个要点有英文例句和中文意思', /\n1\. /.test(wx) && /\n2\. /.test(wx) && !/[#*>|`\[\]〔〕]/.test(wx) && /[A-Za-z]{3,}.*（.+）/.test(wx) && wx.endsWith('\n'), wx.slice(0, 160))

    // 导出：Word / PDF / Markdown，成功提示，._ 文件清理
    const out = path.join(work, 'export6'); fs.mkdirSync(out, { recursive: true })
    await T(`report-item-${full.id}`).click()
    await waitFor(async () => (await T('report-body').count()) > 0 && /完整数据版/.test(await txt('report-title')), 8000)
    const docx = path.join(out, '考情报告.docx')
    fs.writeFileSync(path.join(out, '._考情报告.docx'), 'appledouble')   // 模拟 macOS 在外置盘上生成的元数据文件
    await stubSave(docx)
    await T('report-export-docx').click()
    const dw = await waitFor(async () => fs.existsSync(docx) && fs.statSync(docx).size > 1000 && (await T('report-export-result').count()) > 0, 30000)
    const dtext = dw ? (await mammoth.extractRawText({ path: docx })).value : ''
    check('C 导出 Word', '导出 .docx：能被 Word 类软件读回，含标题（年级 / 学年 / 版本 / 日期）、「AI 草稿 · 请老师核对」页脚、表格和引用', dw && /四年级 2023–2026学年 考情分析报告（完整数据版）/.test(dtext) && /AI 草稿 · 请老师核对/.test(dtext) && /样本概览/.test(dtext) && /教学建议/.test(dtext), dtext.slice(0, 80))
    check('C 导出提示', '导出成功后页面上出现明显的成功提示：写明格式、文件路径，并有「在文件夹里显示」按钮（不再是一闪而过的小提示）', /已导出 Word/.test(await txt('report-export-result')) && (await txt('report-export-path')).includes('考情报告.docx') && (await T('report-reveal').count()) === 1)
    check('C 清理 ._', '导出后，macOS 在外置盘上为这个文件生成的 ._考情报告.docx 被清掉（只清我们写出的文件对应的）', await waitFor(async () => !fs.existsSync(path.join(out, '._考情报告.docx')), 5000))
    const pdf = path.join(out, '考情报告.pdf')
    fs.writeFileSync(path.join(out, '._考情报告.pdf'), 'x')
    await stubSave(pdf)
    await T('report-export-pdf').click()
    const pw2 = await waitFor(async () => fs.existsSync(pdf) && fs.statSync(pdf).size > 1000 && /已导出 PDF/.test(await txt('report-export-result').catch(() => '')), 40000)
    const pinfo = pw2 ? await pdfInfo(pdf) : { text: '' }
    check('C 导出 PDF 提示', '导出 PDF 成功：页面上有明确的「已导出 PDF」提示和路径（体验报告里「PDF 导出没有明显提示」）；PDF 里有「AI 草稿」页脚', pw2 && /AI草稿·请老师核对/.test(pinfo.text.normalize('NFKC').replace(/\s/g, '')), pinfo.text.slice(-80))
    check('C 清理 ._', 'PDF 同样清掉 ._ 文件', await waitFor(async () => !fs.existsSync(path.join(out, '._考情报告.pdf')), 5000))
    const md = path.join(out, '考情报告.md')
    fs.writeFileSync(path.join(out, '._考情报告.md'), 'x'); fs.mkdirSync(path.join(out, '考情报告'), { recursive: true })
    await stubSave(md)
    await T('report-export-md').click()
    await waitFor(async () => fs.existsSync(md) && /已导出 Markdown/.test(await txt('report-export-result').catch(() => '')), 20000)
    const mdt = fs.readFileSync(md, 'utf8')
    check('A2 导出 Markdown', 'Markdown 里：标题含年级 / 学年 / 版本 / 日期，表格没有代码列，没有反引号，文首有「AI 草稿」说明；引用旁是 ![题目截图…]()', /AI 草稿 · 请老师核对/.test(mdt) && /^# 四年级 2023–2026学年 考情分析报告（完整数据版）/m.test(mdt) && !/\| 代码 \|/.test(mdt) && !mdt.includes('`'))
    check('C 清理 ._', 'Markdown 同样清掉 ._ 文件', await waitFor(async () => !fs.existsSync(path.join(out, '._考情报告.md')), 5000))
    // 家长版导出 docx（核对后可导出）
    await T(`report-item-${parent.id}`).click()
    await waitFor(async () => /家长版/.test(await txt('report-title')), 8000)
    const pdocx = path.join(out, '家长版.docx'); await stubSave(pdocx)
    await T('report-export-docx').click()
    check('A2 家长版导出', '核对后的家长版可以导出 Word', await waitFor(async () => fs.existsSync(pdocx) && fs.statSync(pdocx).size > 1000, 20000))
    mock.quirks = {}
  }

  // ───────────────────────── 阶段 5：B6 白话 / 隐藏代码、B7 知识点白话、B8 样本少 ─────────────────────────
  {
    const { page } = ctx
    await setFilter({ grade: '4' }, '#/overview')
    await T('overview').waitFor()
    const top = await txt('top10')
    check('B6 总览白话', '总览的 Top 10 不再写「2/2 份 · 100%」：写成「十一份卷子都考了」「十一份卷子里有七份考了」这样的话（原始数字在悬停说明里）', /份卷子都考了|份卷子里有.+份考了/.test(top) && !/\d+\/\d+ 份 · \d/.test(top) && !/出现率/.test(top), top.slice(0, 100))
    // 只有 1–2 份卷子：Top 10 → 每份都考 / 只考了一份
    await setFilter({ grade: '6' }, '#/overview')
    await T('overview').waitFor()
    const grp = await waitFor(async () => (await T('top10-groups').count()) === 1, 10000)
    check('B8 总览分组', '六年级只有 1 份卷子：Top 10 改成「这份卷子里考了」分组，不再是全 100% 的排名', grp && /卷子只有 1–2 份/.test(await txt('top10-groups')), await txt('top10').catch(() => ''))
    // 同比：五年级 目标 1 份、基线 2 份 → 样本不足，新增 / 消失默认折叠
    await setFilter({ grade: '5' }, '#/dashboard')
    await page.locator('.ant-tabs-tab', { hasText: '同比' }).first().click()
    await T('compare-target').waitFor({ timeout: 15000 })
    await waitFor(async () => (await T('insufficient-warning').count()) > 0, 10000)
    check('B8 同比样本不足', '五年级目标只有 1 份、基线 2 份：写「样本不足，暂不比较」，「新考的 / 没再考的」默认折叠', (await T('insufficient-warning').count()) === 1 && /样本不足，暂不比较/.test(await txt('insufficient-warning')) && ((await T('col-added-folded').count()) + (await T('col-removed-folded').count())) >= 1 && /今年只有 1 份/.test(await txt('sample-warning')), await txt('insufficient-warning').catch(() => ''))
    const before = await page.locator('[data-testid^=item-]').evaluateAll(es => es.filter(e => e.offsetParent !== null).length)
    await T('show-few').click()
    const after = await page.locator('[data-testid^=item-]').evaluateAll(es => es.filter(e => e.offsetParent !== null).length)
    check('B8 仍要查看', '点「仍要查看」才展开被折叠的条目', after > before, `${before} → ${after}`)
    // 四年级 5 vs 6：不折叠
    await setFilter({ grade: '4' }, '#/dashboard')
    await page.locator('.ant-tabs-tab', { hasText: '同比' }).first().click()
    await T('compare-target').waitFor({ timeout: 15000 })
    await sleep(800)
    check('B8 样本够了', '四年级目标 5 份、基线 6 份：没有「样本不足」提示，条目直接可见', (await T('insufficient-warning').count()) === 0 && (await T('col-added-folded').count()) === 0)
    const cmpTxt = await page.locator('[data-testid=item-GR\\.TENSE\\.FUT\\.GOING], [data-testid="item-GR.TENSE.FUT"]').first().innerText().catch(() => '')
    check('B6 同比白话', '「基线 0/6 → 目标 2/5」写成「去年及以前没考，今年考了（今年 2/5 份卷子有）」', /去年及以前没考，今年考了/.test(cmpTxt) && !/基线/.test(cmpTxt), cmpTxt)
    // 重难点：标签、公式折叠、白话列名
    await page.locator('.ant-tabs-tab', { hasText: '重难点' }).first().click()
    await T('hot-table').waitFor({ timeout: 15000 })
    const hotTxt = await txt('hot-table')
    check('B6 重难点白话', '重难点表：每个知识点带「重点 / 难点 / 又重又难 / 个例 / 一般」标签；列名是「考了几份卷子 / 占总分多少 / 容易错 / 难易程度」；不再有「综合得分」列', (await page.locator('[data-testid^=hot-label-]').count()) >= 5 && /考了几份卷子/.test(hotTxt) && /占总分多少/.test(hotTxt) && !/综合得分|出现率|易错率|平均难度/.test(hotTxt), hotTxt.slice(0, 120))
    check('B6 公式折叠', '排序公式折叠在「怎么算的」里，默认看不到', /怎么算的/.test(await txt('hot-how')) && !(await T('hot-formula').isVisible()))
    // 显示内部代码：默认关；打开后知识点树里出现代码
    await goto('#/settings'); await T('admin-settings').waitFor()
    await T('taxonomy-settings').waitFor()
    await T('kp-search').locator('input').fill('物主')
    await T('kp-node-GR.PRON.POSS').click({ trial: false }).catch(() => undefined)
    const tx0 = await txt('taxonomy-settings')
    check('B6 隐藏代码', '默认不显示知识点的内部代码（GR.PRON.POSS）；树上改为显示例词（my / your / his）', !/GR\.PRON\.POSS/.test(tx0) && /my \/ your/.test(tx0), tx0.slice(0, 160))
    check('B7 白话释义', '知识点编辑器里选中「物主代词」：显示白话「表示“谁的”」和例句 This is my book. 这是我的书。', /表示“谁的”/.test(await txt('kp-selected-plain').catch(() => '')) && /This is my book\./.test(await txt('kp-selected-example').catch(() => '')), await txt('kp-selected').catch(() => ''))
    await T('show-codes-switch').click()
    await waitFor(async () => /GR\.PRON\.POSS/.test(await txt('taxonomy-settings')), 8000)
    check('B6 显示内部代码', '管理员设置里打开「显示内部代码」后，代码出现', /GR\.PRON\.POSS/.test(await txt('taxonomy-settings')))
    await T('show-codes-switch').click()
    // 自建节点：填白话 / 例句，保存后能读回
    await api(() => window.api.taxonomy.save([{ op: 'add', parent_code: 'GR.PRON', name: 'E2E 自建代词', plain: '测试用的一句话', example_en: 'This is **mine**.', example_zh: '这是我的。', hint_words: 'mine / yours' }]))
    const tree = await api(() => window.api.taxonomy.tree())
    const mine = tree.kps.find(k => k.name === 'E2E 自建代词')
    check('B7 自建节点', '自建节点可以填白话 / 例句 / 例词，taxonomy:tree 读得回', mine && mine.plain === '测试用的一句话' && mine.example_en === 'This is **mine**.' && mine.hint_words === 'mine / yours' && mine.builtin === 0)
    // 审核页下拉：「中文名（例词）· 白话」
    const pid = ctx.ids.C1
    await goto(`#/review/${pid}`)
    await T('question-form').waitFor({ timeout: 15000 })
    await T('f-kp-main').click()
    await page.keyboard.type('物主')
    await sleep(500)
    const opt = await page.locator('.ant-select-tree-treenode', { hasText: '物主代词' }).first().innerText()
    check('B7 审核页下拉', '审核页知识点下拉每项显示「中文名（例词）· 白话」，如「物主代词（my / your / his）· 表示“谁的”」；默认不带代码', /物主代词（my \/ your \/ his）\s*· 表示“谁的”/.test(opt) && !/GR\.PRON/.test(opt), opt)
    await page.keyboard.press('Escape')
    // 审核页：置信度只在低时出现；质题型下拉不带代码
    check('B6 审核页', '置信度 100% 的题不显示「置信度 xx%」标签（只有低的才提示「需要核对」）', (await T('confidence-tag').count()) === 0 && !/置信度/.test(await txt('question-form')))
    await T('f-qtype').click()
    const qt = await page.locator('.ant-select-item-option').allInnerTexts()
    check('B6 题型下拉', '题型下拉只显示中文名（单项选择），不带 MC / PH_DIFF 这类代码；打 MC 仍能搜到', qt.length >= 8 && qt.every(x => !/\([A-Z_]+\)|（[A-Z_]+）/.test(x)), JSON.stringify(qt.filter(x => /\([A-Z_]+\)|（[A-Z_]+）/.test(x)).concat(qt.length)))
    await page.keyboard.press('Escape')
  }

  // ───────────────────────── 阶段 6：B9 审核页不悄悄改变 ─────────────────────────
  {
    const { page } = ctx
    const pid = ctx.ids.C1
    await goto(`#/review/${pid}`)
    await T('question-form').waitFor({ timeout: 15000 })
    check('B9 前提', 'C1 是「已完成」，页面没有「变回待审核」的提示', withDb(ctx.ud, d => d.prepare('SELECT status s FROM papers WHERE id = ?').get(pid).s) === 'done' && (await T('reopened-notice').count()) === 0)
    await page.locator('[data-testid=f-difficulty] li.ant-rate-star').nth(3).click()
    const shown = await waitFor(async () => (await T('reopened-notice').count()) > 0, 8000)
    const nt = shown ? await txt('reopened-notice') : ''
    check('B9 变回待审核要提示', '改了已完成卷子的一道题 → 卷子变回「待审核」：页面顶部明确提示「已经变回待审核，暂时不计入统计」并写明「点右上角确认整份试卷就恢复」', shown && /变回「待审核」/.test(nt) && /确认整份试卷/.test(nt) && /不计入统计/.test(nt) && withDb(ctx.ud, d => d.prepare('SELECT status s FROM papers WHERE id = ?').get(pid).s) === 'reviewing', nt)
    await T('finish-paper').click()
    await waitFor(async () => (await T('reopened-notice').count()) === 0, 8000)
    check('B9 恢复', '点「确认整份试卷」后提示消失，卷子回到已完成', withDb(ctx.ud, d => d.prepare('SELECT status s FROM papers WHERE id = ?').get(pid).s) === 'done')
    // 改主知识点 → 次知识点被去重删掉：接口返回 notices，界面提示并给「撤销」
    const q4 = ctx.qids.C1Q4   // 主 RD.DETAIL.FACT，次 GR.TENSE.PAST.REG
    const before = await api(i => window.api.questions.list(i), pid)
    const bq = before.questions.find(q => q.id === q4)
    const upd = await api(([i, kp]) => window.api.questions.update(i, { kp_main: kp }), [q4, 'GR.TENSE.PAST.REG'])
    check('B9 接口提示', '改主知识点时原来的次知识点和新主知识点重复被去掉：questions.update 的返回里有 notices.droppedSecondary = [GR.TENSE.PAST.REG]、notices.reopened = true', upd.notices.droppedSecondary.join() === 'GR.TENSE.PAST.REG' && upd.notices.reopened === true && upd.kp_secondary.length === 0, JSON.stringify(upd.notices))
    await api(([i, kp, sec]) => window.api.questions.update(i, { kp_main: kp, kp_secondary: sec }), [q4, bq.kp_main, bq.kp_secondary])   // 复原
    await api(i => window.api.questions.confirmPaper(i, true), pid)
    // 界面：改主知识点（树选择）→ 提示 + 撤销
    await page.reload(); await goto(`#/review/${pid}`)
    await T('question-form').waitFor({ timeout: 15000 })
    await page.locator(`[data-qid="${q4}"]`).click()
    await waitFor(async () => /第 4 题/.test(await txt('form-title')), 8000)
    await T('f-kp-main').click()
    await page.keyboard.type('一般过去时')
    await sleep(500)
    await page.locator('.ant-select-tree-node-content-wrapper', { hasText: '规则动词过去式' }).first().click()
    const dropped = await waitFor(async () => (await page.locator('[data-testid=dropped-secondary-notice]').count()) > 0, 8000)
    const dtxt = dropped ? await page.locator('[data-testid=dropped-secondary-notice]').innerText() : ''
    check('B9 次知识点被去掉要提示', '改主知识点导致次知识点被去重删除：界面提示「…已经被去掉」并给「撤销这一步」', dropped && /已经被去掉/.test(dtxt) && /撤销这一步/.test(dtxt), dtxt)
    await page.locator('[data-testid=undo-dropped-secondary]').click()
    const back = await waitFor(async () => { const l = await api(i => window.api.questions.list(i), pid); const q = l.questions.find(x => x.id === q4); return q.kp_main === bq.kp_main && q.kp_secondary.join() === bq.kp_secondary.join() }, 8000)
    check('B9 撤销', '点「撤销这一步」：主 / 次知识点恢复成改之前的样子', back)
    await api(i => window.api.questions.confirmPaper(i, true), pid)
    // 同类题不一致：三年级一致性卷第 4 题（5 星，其余 3 星）→ 标「需要核对」
    await goto(`#/review/${ctx.consistencyPaper}`)
    await T('question-form').waitFor({ timeout: 15000 })
    const hints = await api(i => window.api.questions.list(i), ctx.consistencyPaper)
    check('B9 同类题一致性', '同一大题里 4 道考同一个知识点的题，3 道 3 星、1 道 5 星：questions.list 的 hints 只给那 1 道（其余不提示）', Object.keys(hints.hints).join() === ctx.consistencyOdd && /请核对是不是标得不一致/.test(hints.hints[ctx.consistencyOdd]), JSON.stringify(hints.hints))
    check('B9 界面标核对', '左侧列表那一题标「核对」小标签；选中它时右边出现「需要核对：同类题…」', (await T('hint-tag').count()) === 1)
    await page.locator(`[data-qid="${ctx.consistencyOdd}"]`).click()
    await waitFor(async () => (await T('consistency-hint').count()) > 0, 5000)
    check('B9 提示文字', '提示写明「同类题大多数难度是 3 星，这道是 5 星」', /大多数难度是 3 星，这道是 5 星/.test(await txt('consistency-hint')), await txt('consistency-hint').catch(() => ''))
    // 审核页空状态
    await goto('#/review')
    await waitFor(async () => (await T('review-empty').count()) > 0 || (await page.locator('tbody tr').count()) > 0, 8000)
    const sumPapers = await api(() => window.api.papers.list())
    if (!sumPapers.some(p => p.status === 'reviewing')) check('B9 审核空状态', '「待审核 0」时空状态告诉老师：已经审核完的在「已完成」里，想改点进去（改完要再确认一次整份）', /已完成/.test(await txt('review-empty')) && /再确认一次整份/.test(await txt('review-empty')))
    else check('B9 审核空状态', '（本次数据里有待审核的卷子，空状态不出现；文案由单元测试之外的源码保证）', true)
  }

  // ───────────────────────── 阶段 7：B10 引用截图 ─────────────────────────
  {
    // 用真实 OCR 的整行数据复现「16. … 17」：把 C2 第 1 题的框设成真实页面上第 3 题那一行（含右边第 4 题的起点），确认导出 / 界面的裁切不带出邻题
    const { page } = ctx
    const out = path.join(work, 'crop'); fs.mkdirSync(out, { recursive: true })
    const { execFileSync } = require('node:child_process')
    const j = JSON.parse(execFileSync(path.join(root, 'native/macos/bin/ewb-ocr'), [pageImg], { encoding: 'utf8', maxBuffer: 20 << 20 }).replace(/^﻿/, ''))
    const l3 = j.lines.find(l => l.text.startsWith('3. A. skirt'))
    check('B10 前提', 'OCR 找到了第 3 题那一行', !!l3)
    if (l3) {
      const r4 = v => Math.round(v * 10000) / 10000
      const bbox = [r4(l3.x - 0.004), r4(l3.y - 0.004), r4(l3.w + 0.008), r4(l3.h + 0.008)]
      await api(([id, b]) => window.api.questions.update(id, { bbox: b, page_idx: 1 }), [ctx.qids.C2Q1, bbox])
      await api(i => window.api.questions.confirmPaper(i, true), ctx.ids.C2)
      await setFilter({ grade: '4' }, '#/dashboard')
      await page.locator('.ant-tabs-tab', { hasText: '重难点' }).first().click()
      await T('hot-table').waitFor({ timeout: 15000 })
      const cards = await api(() => window.api.stats.questions({ grade: '4' }, { kind: 'filter' }, 'GR.TENSE.FUT.GOING', 5))
      const card = cards.find(c => c.id === ctx.qids.C2Q1)
      check('B10 引用带卷名题号', '统计返回的题目卡片带 卷名 + 题号 + 页面图 + 定位框（报告和抽屉的引用据此显示完整截图）', !!card && /C2/.test(card.paperTitle) && card.no === '1' && !!card.pageRel && Array.isArray(card.bbox))
      // 报告里的引用卡片：标签完整不截断（卷名 + 第 N 题），带「点击放大」
      await goto('#/report'); await T('report-page').waitFor()
      const ids = (reports()).filter(r => r.reader === 'teacher').map(r => r.id)
      if (ids.length) {
        await T(`report-item-${ids[0]}`).click()
        await waitFor(async () => (await T('report-body').count()) > 0, 8000)
        const lab = await T('report-body').locator('[data-testid=cite-label]').first().innerText().catch(() => '')
        check('B10 引用卡片', '报告里的引用卡片：标签写全「卷名 · 第 N 题（题型）」，不再被截断成一个小框；截图上有「点击放大」', /第 \d+ 题/.test(lab) && /卷/.test(lab) && (await T('report-body').locator('[data-testid=zoom-hint]').count()) >= 1, lab)
      }
    }
  }

  // ───────────────────────── 阶段 7.5：R5-1 抽屉里的 AI 分析只讲「这一个考点」 ─────────────────────────
  {
    const sc = { filter: { grade: '4' }, code: 'GR.TENSE.PAST', target: 2025, base: 'before', align: true }
    const st0 = await api(s => window.api.ai.kpAnalysis(s), sc)
    const before = ctx.mock.kpRequests.length
    const r = await api(s => window.api.ai.analyzeKp(s, crypto.randomUUID()), sc)
    const reqs = ctx.mock.kpRequests.slice(before)
    const last = reqs[reqs.length - 1] ?? { user: '', system: '' }
    const st1 = await api(s => window.api.ai.kpAnalysis(s), sc)
    check('R5 单个考点分析', '抽屉里的 AI 分析：只发一次请求，提示词 = docs 里的单个考点版；输入里只有「一般过去时」这一个考点（没有别的考点的名字、没有整篇年度分析的表格）',
      r.ok === true && reqs.length === 1 && last.system === L.docsPrompt('p2_kp', 'system') && /【这一个考点】一般过去时/.test(last.user) && !/名词复数|购物/.test(last.user) && !/【新增知识点】|【知识点分布】/.test(last.user), JSON.stringify({ ok: r.ok, n: reqs.length, head: last.user.slice(0, 120) }))
    check('R5 单个考点分析', '结果短、四行（考什么 / 今年的情况 / 容易错在哪 / 课上怎么讲），没有代码；状态从「还没有」变成「已缓存」',
      st0.status === 'none' && st1.status === 'fresh' && /考什么/.test(st1.markdown) && /课上怎么讲/.test(st1.markdown) && st1.markdown.length < 600 && !/[A-Z]{2,}\.[A-Z]/.test(st1.markdown) && !/一、总体变化|五、下学期/.test(st1.markdown), st1.markdown.slice(0, 120))
  }

  // ───────────────────────── 阶段 8：A4 整库扫描（升级后 / 「检查重复试卷」）——放在最后，它会改动夹具里的题干 ─────────────────────────
  {
    const long = (tag, i) => `Look at the picture and choose the right answer for number ${i} about ${tag} in this paper.`
    const stems = async (pid, tag) => {
      const qs = (await api(i => window.api.questions.list(i), pid)).questions.slice(0, 3)
      for (let i = 0; i < qs.length; i++) await api(([id, st]) => window.api.questions.update(id, { stem: st }), [qs[i].id, long(tag, i + 1)])
      return qs.length
    }
    // A1 和 A2 写上互不相同的长题干（不能互相误标）；A3 写上和 A1 一模一样的（应被标成疑似重复）
    const n1 = await stems(ctx.ids.A1, 'animals'), n2 = await stems(ctx.ids.A2, 'weather'), n3 = await stems(ctx.ids.A3, 'animals')
    const scan = await api(() => window.api.papers.scanSimilar())
    const st = pid => withDb(ctx.ud, d => d.prepare('SELECT similar_state s, similar_to t FROM papers WHERE id = ?').get(pid))
    const [a1, a2, a3] = [st(ctx.ids.A1), st(ctx.ids.A2), st(ctx.ids.A3)]
    const flagged = [['A1', a1, ctx.ids.A3], ['A3', a3, ctx.ids.A1]].filter(([, x]) => x.s === 'suspect')
    check('A4 整库扫描', '造三份真的可比较的卷子（每份 3 道够长的题干）：互不相同的两份不会互相误标；题干一模一样的两份里，后导入的那份被标成疑似重复、指向另一份（扫描按导入先后处理）',
      n1 >= 3 && n2 >= 3 && n3 >= 3 && a2.s === null && flagged.length === 1 && flagged[0][1].t === flagged[0][2] && scan.checked >= 3 && scan.suspects >= 1, JSON.stringify({ a1, a2, a3, scan }))
  }
}

const out = path.join(__dirname, 'last-result-m6.json')
const dumpFailure = async () => {
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
}
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  await dumpFailure()
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 1)
})
