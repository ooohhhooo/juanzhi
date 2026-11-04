// README 截图脚本：用内置「示例数据」（12 份虚构试卷）+ mock AI 重拍 docs/screenshots/readme-v14-*.png。
// 全部数据虚构（示例试卷、tests/fixtures/gen-ops-data.cjs 的假问卷、课程表示例），没有真实机构和学生。
// 窗口内容区固定 1440×900，浅色主题；每张图拍之前等提示条消失、等加载完。
// 用法：npm run docs:shots   （沙箱外运行；PATH=/usr/bin:$PATH，去掉代理变量）
//   只拍几张：EWB_SHOTS_ONLY=assistant,cards node tests/e2e/readme-shots.cjs ；输出目录：EWB_SHOTS_OUT=/some/dir
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, fs, path, work, SECRET, ctx, T, goto, cfgFor, saveCfg, startMock, open, closeApp, stubOpen, stubSave, root } = M
const { generate } = require('../fixtures/gen-ops-data.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { DatabaseSync } = require('node:sqlite')

const OUT = process.env.EWB_SHOTS_OUT || path.join(root, 'docs/screenshots')
const ONLY = (process.env.EWB_SHOTS_ONLY || '').split(',').filter(Boolean)
const want = n => !ONLY.length || ONLY.includes(n)
fs.mkdirSync(OUT, { recursive: true })
const count = id => T(id).count()
const WIDTH = 1440, HEIGHT = 900

/** 等提示条、加载中、动画都停下来再拍；鼠标移到空白处，避免悬浮提示 */
async function shot(name, settleMs = 900) {
  const page = ctx.page
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice, .ant-notification-notice, .ant-tooltip:not(.ant-tooltip-hidden)'), null, { timeout: 10000 }).catch(() => {})
  await page.waitForFunction(() => !document.querySelector('.ant-spin-spinning, .ant-skeleton-active, [aria-busy=true]'), null, { timeout: 15000 }).catch(() => {})
  await page.mouse.move(WIDTH - 4, HEIGHT - 4)
  await sleep(settleMs)
  const file = path.join(OUT, `readme-v14-${name}.png`)
  await page.screenshot({ path: file })
  console.log('shot', file, Math.round(fs.statSync(file).size / 1024) + ' KB')
}
async function ask(text) {
  await T('assistant-input').fill(text)
  await T('assistant-send').click()
}
const idle = () => waitFor(async () => (await count('assistant-stop')) === 0 && (await count('assistant-working')) === 0, 120000)
/** 窄于 1280 时右侧面板会收成竖条；固定 1440 一般不需要，保险起见 */
const unfold = async () => { if ((await count('side-unfold')) === 1 && (await T('side-panel').getAttribute('data-folded')) === '1') await T('side-unfold').click() }

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const opsDir = path.join(work, 'ops')
  await generate(opsDir)
  const ud = path.join(work, 'userReadme')
  const env = { adminOpen: false, extraEnv: { EWB_UPDATE_CHECK_DELAY_MS: '600000', EWB_TEST_HOOKS: '1' } }
  // 先用 fixtures-m3 往库里放一批虚构的「真实数据」试卷（课程对照只匹配非示例数据），再叠加内置示例数据拍前面的页面
  const r0 = await open(ud, env)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: M.pageImg, pageSize: { width: 1224, height: 1584 } })
  const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
  const hint = db.prepare("UPDATE kps SET hint_words = ?, plain = COALESCE(NULLIF(plain, ''), ?) WHERE code = ?")   // 让 mock 能按例词把知识点对到课
  hint.run('played / watched', '说过去发生的事', 'GR.TENSE.PAST.REG'); hint.run('taller', '比较两个人或物', 'GR.ADJ.COMPARE.REG')
  hint.run('dress / expensive', '购物时的说法', 'FN.SHOP'); hint.run('dress / expensive', '购物时的说法', 'FN.SHOP.PRICE'); hint.run('visited', '说过去的经历', 'GR.TENSE.PAST.IRREG')
  db.exec("UPDATE papers SET status = 'done' WHERE status NOT IN ('done') AND is_sample = 0")   // 侧栏不要出现「待审核」角标
  db.close()
  await open(ud, env)
  const page = ctx.page
  await ctx.app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(w, h) }, [WIDTH, HEIGHT])
  await saveCfg(cfgFor(mock, { auto_parse: false, concurrency: 4 }), SECRET)
  await page.evaluate(() => { localStorage.setItem('ewb-theme-pref', 'light'); return window.api.settings.set('beta_welcome_seen', true) })
  await page.reload(); await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  await sleep(800)
  const size = await page.evaluate(() => [innerWidth, innerHeight])
  check('窗口', `内容区 ${WIDTH}×${HEIGHT}`, size[0] === WIDTH && size[1] === HEIGHT, size.join('×'))

  // ── 示例数据：设置页里点「加载示例数据」──
  await goto('#/settings'); await T('sample-load').waitFor({ timeout: 15000 })
  await T('sample-load').click()
  const papers = await waitFor(async () => { const ps = await page.evaluate(() => window.api.papers.list()); return ps.filter(x => x.file_name.startsWith('示例')).length >= 12 ? ps.filter(x => x.file_name.startsWith('示例')) : null }, 60000)
  check('示例数据', '加载了 12 份示例试卷', !!papers, String(papers && papers.length))
  await sleep(2500)

  // ── 1. 总览 ──
  if (want('overview')) {
    await goto('#/overview'); await sleep(2500)
    await shot('overview')
  }

  // ── 2. 审核：打开一份有题的试卷 ──
  if (want('review')) {
    const withQ = []
    for (const p of papers.filter(x => x.status === 'done' || x.status === 'reviewing' || x.status === 'extracted' || x.status === 'approved')) {
      const qs = await page.evaluate(id => window.api.questions.list(id), p.id).catch(() => [])
      if (qs.length) withQ.push({ p, n: qs.length })
    }
    withQ.sort((a, b) => b.n - a.n)
    const target = (withQ[0] || { p: papers[0] }).p
    console.log('review paper', target.file_name, target.status)
    await goto(`#/review/${target.id}`); await sleep(3500)
    await shot('review', 1200)
  }

  // ── 3. 分析看板 ──
  if (want('dashboard')) {
    await goto('#/dashboard'); await sleep(3000)
    await shot('dashboard', 1200)
  }

  // ── 4. 报告：生成一份老师版 ──
  if (want('report')) {
    await goto('#/report'); await T('report-page').waitFor({ timeout: 15000 })
    await T('reader-teacher').check().catch(() => T('reader-full').check())
    await T('report-generate').click()
    await waitFor(async () => (await page.locator('[data-testid^=report-item-]').count()) >= 1 && (await count('report-cancel')) === 0, 90000)
    await sleep(1500)
    // 往下滚一点，让历史列表和报告正文（含「问助手」按钮、各部分）都进画面
    await T('report-detail').evaluate(e => e.scrollIntoView({ block: 'start' })).catch(() => {})
    await sleep(500)
    await shot('report', 1200)
  }

  // ── 6. 数据页：问卷数据集 + 文档资料 ──
  const surveyOk = want('data') || want('assistant') || want('cards')
  if (surveyOk && want('data')) {
    await goto('#/datasets'); await T('datasets-page').waitFor({ timeout: 15000 })
    await stubOpen(path.join(opsDir, 'survey.xlsx'))
    await T('datasets-drop').click()
    await waitFor(async () => (await page.locator('[data-testid^="dataset-"][data-name]').count()) >= 1, 60000)
    await stubOpen(path.join(opsDir, 'attendance.xlsx')).catch(() => {})
    const note = path.join(work, '三年级家长沟通纪要.md')
    fs.writeFileSync(note, [
      '# 三年级家长沟通纪要（虚构）', '',
      '- 时间：11 月第 1 周，线上家长会', '- 参加：启航 A 班家长 18 位', '',
      '## 家长关心的问题', '',
      '1. 周六下午的课时间偏晚，希望能提前 1 小时。',
      '2. 一般过去时的练习希望多一点口头的，不只是做题。',
      '3. 想知道孩子每周大概花多少时间在课后练习上。', '',
      '## 老师的回复', '',
      '下周起试行周六上午的班次；课后练习控制在每天 10 分钟以内，口头练习用小卡片完成。'
    ].join('\n'))
    // 把文本拖到「数据」页的拖放区：和 M11k 一样，用隐藏 input 取 File 再派发 drop 事件
    await page.evaluate(() => { let i = document.getElementById('shots-input'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'shots-input'; i.style.display = 'none'; document.body.appendChild(i) } })
    await page.setInputFiles('#shots-input', [note])
    await page.evaluate(() => {
      const dt = new DataTransfer()
      for (const f of document.getElementById('shots-input').files) dt.items.add(f)
      const el = document.querySelector('[data-testid=datasets-drop]')
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await waitFor(async () => (await count('document-card')) >= 1, 60000)
    await sleep(2000)
    await shot('data', 1200)
  }

  // ── 7. 助手：分析满意度（计划 → 工具 → 看板 / 汇报）──
  if (want('assistant') || want('cards')) {
    if ((await page.locator('[data-testid^="dataset-"][data-name]').count()) === 0 && !want('data')) { /* 数据集在助手里添加 */ }
  }
  if (want('assistant')) {
    await goto('#/assistant'); await T('assistant-page').waitFor({ timeout: 15000 })
    await stubOpen(path.join(opsDir, 'survey.xlsx'))
    await T('assistant-plus').click()
    await T('assistant-plus-add').click()
    await waitFor(async () => (await count('assistant-datachip')) >= 1, 60000)
    await sleep(500)
    await ask('帮我看看这批问卷的满意度，找出偏低的班级，出一份看板和汇报')
    await waitFor(async () => (await count('assistant-plan-go')) === 1, 60000)
    await T('assistant-plan-go').click()
    await idle()
    await waitFor(async () => (await count('assistant-answer')) >= 1, 60000)
    await unfold()
    await waitFor(async () => (await page.locator('[data-testid^=out-tab-]').count()) >= 3, 30000)
    await page.locator('[data-testid^=out-tab-]', { hasText: '看板' }).first().click().catch(() => {})
    await waitFor(async () => (await count('assistant-boardpane')) === 1, 15000)
    await sleep(2000)
    // 对话区滚到最底：看到最后的工具步骤和最终回答
    await page.evaluate(() => { for (const e of document.querySelectorAll('*')) { const r = e.getBoundingClientRect(); const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 40 && r.x > 290 && r.x < 330) e.scrollTop = e.scrollHeight } })
    await sleep(600)
    await shot('assistant', 1500)
  }

  // ── 8. 分享卡片：新对话，做学生卡和家长卡 ──
  if (want('cards')) {
    await goto('#/assistant'); await T('assistant-page').waitFor({ timeout: 15000 })
    await T('assistant-new').first().click()
    await T('assistant-mode').click(); await page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()
    await ask('请帮我做卡片：给小雨一张过去式知识卡，再给家长一张本周反馈')
    await waitFor(async () => (await count('assistant-working')) === 0 && (await count('assistant-stop')) === 0, 90000)
    await unfold()
    await waitFor(async () => (await page.locator('[data-testid^=out-tab-i]').count()) === 2, 30000)
    await T('out-tab-i1').click()
    await waitFor(async () => page.evaluate(() => { const i = document.querySelector('[data-testid=out-image]'); return i && i.complete && i.naturalWidth > 0 }), 15000)
    await shot('cards', 1500)
  }

  // ── 9. 设置（左侧导航）──
  if (want('settings')) {
    await goto('#/settings'); await T('settings-nav').waitFor({ timeout: 15000 })
    await sleep(1500)
    await shot('settings')
  }

  // ── 5. 课程对照：下载示例 → 导入向导 → 匹配 → 看板「课程对照」页签 ──
  if (want('course')) {
    const sampleXlsx = path.join(work, '课程表示例（虚构）.xlsx')
    await goto('#/courses'); await T('course-settings').waitFor({ timeout: 15000 })
    await T('course-add-empty').click()
    await T('course-wizard').waitFor()
    await stubSave(sampleXlsx)
    await T('course-template-sample').click()
    await waitFor(() => fs.existsSync(sampleXlsx), 8000)
    await stubOpen([sampleXlsx])
    await T('course-pick').click()
    await T('course-file-name').waitFor({ timeout: 10000 })
    await T('course-name').fill('示例课程体系')
    await T('course-term').fill('示例学期')
    await T('course-next').click()
    await M.reviewJob()
    await T('course-save').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    await T('match-start').waitFor({ timeout: 15000 })
    await T('match-start').click()
    await waitFor(async () => (await count('match-result')) > 0, 90000)
    await page.evaluate(v => window.api.settings.set('ui_stats_filter', v), { grade: '4' })
    await page.reload(); await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 }).catch(() => {})
    await goto('#/dashboard'); await T('dashboard').waitFor({ timeout: 30000 })
    await page.getByRole('tab', { name: '课程对照' }).click()
    await sleep(3000)
    await shot('course', 1200)
  }

  await closeApp()
  mock.close?.()
  console.log('done ->', OUT)
}

main().then(() => process.exit(0), async e => { console.error(e); try { await ctx.page?.screenshot({ path: path.join(work, 'readme-shots-error.png') }); console.error('error shot:', path.join(work, 'readme-shots-error.png')) } catch { /* 无页面 */ } await closeApp(); process.exit(1) })
