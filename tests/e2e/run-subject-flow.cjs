// 三个学科的全链路 E2E：
//  1. 加载示例数据（英语 12 + 数学 8 + 语文 8）→ 切到数学 → 打开「示例数据」筛选 → 总览和看板只出现数学的知识点（没有英语的语音 / 语法）
//     → 切到语文同样检查 → 切回英语，数据和切走前一模一样；
//  2. 数学下导入一份 PDF（samples/g4-2025.pdf）→ 模拟 AI 解析 → 库里：卷子 subject = math、题目知识点都是 MA. 开头、题型都是 MA_ 开头；
//     审核页的题型下拉分组是「计算 / 概念与基础 / 图形与操作 / 解决问题」；
//  3. 数学下生成一份报告（模拟 AI）→ 报告列表只有数学这份，切到英语、语文看不到；
//  4. 助手：数学下新建对话，会话列表只出现在数学下。
// 用法：node tests/e2e/run-subject-flow.cjs   （先 npm run build；沙箱外运行，去掉代理变量）
const M = require('./m4-lib.cjs')
const { check, waitFor, T, goto, open, closeApp, ctx, work, withDb, fs, path, L, root, startMock, cfgFor, saveCfg, SECRET } = M
const { dropFiles, waitStatus } = L

const pick = async id => {
  await T('subject-switch').click()
  await T(`subject-opt-${id}`).click()
  await waitFor(async () => (await T('subject-switch').getAttribute('data-subject')) === id, 8000)
}
/** 范围开关切到「示例数据」（已经在示例数据上就不动） */
const ensureSample = async () => {
  await T('filter-dataset').waitFor({ state: 'attached', timeout: 15000 })
  const closed = ctx.page.locator('[data-testid=scope-bar] .ewb-scope__trigger[aria-expanded=false]')
  if (await closed.count()) await closed.first().click()   // 范围面板默认收起，先展开
  await T('filter-dataset').waitFor({ state: 'visible', timeout: 8000 })
  const on = async () => /示例数据/.test(await T('filter-dataset').locator('.ant-segmented-item-selected').innerText())
  if (!(await on())) await T('filter-dataset').getByText('示例数据').click()
  return waitFor(on, 8000)
}
const num = async id => Number((await T(id).innerText()).trim())
/** 总览 / 看板里能看到的知识点代码和大类文字 */
const overviewInfo = async () => {
  await goto('#/overview')
  await waitFor(async () => (await T('card-papers').count()) > 0 && (await ensureSample()), 15000)
  await waitFor(async () => (await T('sample-banner').count()) > 0, 8000)
  await waitFor(async () => (await num('card-papers')) > 0, 15000)
  await ctx.page.waitForTimeout(500)
  const codes = await ctx.page.locator('[data-testid^="top-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid').slice(4)))
  return { papers: await num('card-papers'), questions: await num('card-questions'), kps: await num('card-kps'), codes, text: await T('overview').innerText() }
}
const dashboardInfo = async () => {
  await goto('#/dashboard')
  await waitFor(async () => (await ctx.page.locator('[data-testid^="freq-"]:not([data-testid="freq-level"]):not([data-testid="freq-flat"])').count()) > 0 || (await T('freq-flat').count()) > 0, 15000)
  await ctx.page.waitForTimeout(500)
  const codes = await ctx.page.locator('li[data-testid^="freq-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid').slice(5)))
  const text = await ctx.page.locator('main, [role=main], .ewb-page').first().innerText().catch(() => ctx.page.locator('body').innerText())
  return { codes, text }
}
const ENGLISH_ROOTS = /^(PH|VO|GR|FN|LS|RD|WR|MC)(\.|$)/

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userSubjectFlow')
  await open(ud)
  await saveCfg(cfgFor(mock, { auto_parse: true }), SECRET)

  // ── 1. 示例数据 ──
  const loaded = await ctx.page.evaluate(() => window.api.data.loadSample())
  check('示例数据', '加载示例数据：28 份（英语 12 + 数学 8 + 语文 8）', loaded.papers === 28 && loaded.questions >= 224, JSON.stringify(loaded))
  const bySubject = withDb(ud, d => d.prepare('SELECT subject, COUNT(*) c FROM papers WHERE is_sample = 1 GROUP BY subject ORDER BY subject').all().map(r => `${r.subject}:${r.c}`).join(','))
  check('示例数据', '库里三个学科的 subject 写对', bySubject === 'chinese:8,english:12,math:8', bySubject)
  await ctx.page.reload()
  await T('dropzone').waitFor({ timeout: 30000 })

  // 英语基线
  await goto('#/overview')
  await ensureSample()
  const en0 = await overviewInfo()
  const enDash0 = await dashboardInfo()
  check('英语', '示例数据：12 份卷子，知识点是英语的', en0.papers === 12 && en0.codes.length > 0 && en0.codes.every(c => ENGLISH_ROOTS.test(c)), `${en0.papers} ${en0.codes.join(',')}`)
  check('英语', '看板里有英语的大类「语法」', /语法/.test(enDash0.text) && enDash0.codes.length > 5 && enDash0.codes.every(c => ENGLISH_ROOTS.test(c)))

  // 数学、语文
  const subjects = [
    { id: 'math', name: '数学', root: /^MA\./, papers: 8, cats: ['数的认识', '运算', '图形与几何'], others: /拼音识字|古诗文积累/ },
    { id: 'chinese', name: '语文', root: /^CN\./, papers: 8, cats: ['拼音识字', '词语', '古诗文积累'], others: /数的认识|图形与几何/ }
  ]
  for (const s of subjects) {
    await pick(s.id)
    const ov = await overviewInfo()
    check(s.name, `总览：筛选停在示例数据，只有 ${s.papers} 份${s.name}示例卷`, ov.papers === s.papers && ov.questions >= 60, `${ov.papers} 份 ${ov.questions} 题`)
    check(s.name, `总览：常考知识点全是 ${s.root.source.slice(1, 3)} 开头`, ov.codes.length > 0 && ov.codes.every(c => s.root.test(c)), ov.codes.join(','))
    check(s.name, `总览：出现${s.name}的大类，没有英语的「语音 / 语法」`, s.cats.some(c => ov.text.includes(c)) && !/语音|语法/.test(ov.text) && !s.others.test(ov.text), s.cats.filter(c => ov.text.includes(c)).join('、'))
    const db = await dashboardInfo()
    check(s.name, `看板：知识点全是${s.name}的，没有英语的「语音 / 语法」`, db.codes.length > 5 && db.codes.every(c => s.root.test(c)) && !/语音|语法/.test(db.text) && !s.others.test(db.text), db.codes.slice(0, 6).join(','))
    check(s.name, `看板：有${s.name}的大类`, s.cats.some(c => db.text.includes(c)))
  }

  // 切回英语：数据不变
  await pick('english')
  const en1 = await overviewInfo()
  const enDash1 = await dashboardInfo()
  check('英语', '切回英语：总览数据和之前完全一样', en1.papers === en0.papers && en1.questions === en0.questions && en1.kps === en0.kps && JSON.stringify(en1.codes) === JSON.stringify(en0.codes), `${en1.papers}/${en1.questions}/${en1.kps}`)
  check('英语', '切回英语：看板数据和之前完全一样', JSON.stringify(enDash1.codes) === JSON.stringify(enDash0.codes))

  // ── 2. 数学下导入 PDF ──
  await pick('math')
  const pdf = path.join(work, 'math-import.pdf')
  fs.copyFileSync(path.join(root, 'samples/g4-2025.pdf'), pdf)
  await goto('#/')
  await T('dropzone').waitFor({ timeout: 15000 })
  check('数学导入', '导入处写着「导入到：数学」', /导入到：\s*数学/.test(await T('import-target').innerText()))
  await dropFiles(ctx.page, [pdf])
  // 试卷列表接口按学科取，要带 subject: 'math'
  const got = await waitFor(async () => { const p = (await ctx.page.evaluate(() => window.api.papers.list({ subject: 'math' }))).find(x => x.file_name === 'math-import.pdf'); return p && ['reviewing', 'failed', 'done'].includes(p.status) ? p : null }, 120000)
  check('数学导入', '模拟 AI 解析完成，进入待审核', !!got && got.status === 'reviewing', got ? `${got.status} ${got.error ?? ''}` : '超时')
  const paper = withDb(ud, d => d.prepare("SELECT id, subject FROM papers WHERE file_name = 'math-import.pdf'").get())
  check('数学导入', '库里这份卷子 subject = math', paper?.subject === 'math', JSON.stringify(paper))
  const rows = withDb(ud, d => d.prepare('SELECT q.qtype, qk.kp_code FROM questions q LEFT JOIN question_kps qk ON qk.question_id = q.id WHERE q.paper_id = ?').all(paper.id))
  check('数学导入', '题目有内容，知识点都是 MA. 开头，题型都是 MA_ 开头', rows.length > 0 && rows.every(r => r.kp_code && r.kp_code.startsWith('MA.') && r.qtype.startsWith('MA_')), JSON.stringify(rows))
  const noEnglish = withDb(ud, d => d.prepare("SELECT COUNT(*) c FROM papers WHERE subject <> 'math' AND file_name = 'math-import.pdf'").get().c)
  check('数学导入', '没有写成别的学科', noEnglish === 0)

  await goto(`#/review/${paper.id}`)
  await T('question-form').waitFor({ timeout: 30000 })
  await T('f-qtype').click()
  await ctx.page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ timeout: 8000 })
  // 下拉是虚拟列表，只渲染看得见的几项：一边滚动一边收集分组名
  const groups = []
  const dd = ctx.page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
  for (let i = 0; i < 30; i++) {
    for (const g of await dd.locator('.ant-select-item-group').allInnerTexts()) if (!groups.includes(g.trim())) groups.push(g.trim())
    // 用键盘往下走，虚拟列表会跟着滚动
    await ctx.page.keyboard.press('ArrowDown')
    await ctx.page.waitForTimeout(60)
  }
  check('数学审核', '题型下拉的分组是「计算 / 概念与基础 / 图形与操作 / 解决问题」', JSON.stringify(groups) === JSON.stringify(['计算', '概念与基础', '图形与操作', '解决问题']), groups.join('｜'))
  await ctx.page.keyboard.press('Escape')

  // ── 3. 数学下生成报告 ──
  await goto('#/report')
  await T('report-new').waitFor({ timeout: 15000 })
  await ensureSample()
  const scope = await waitFor(async () => (await T('report-counts').count()) > 0 && (await T('report-counts').innerText()), 15000)
  check('数学报告', '报告范围是数学的示例卷（8 份）', /共 8 份卷子/.test(scope || ''), scope || '')
  await waitFor(async () => !(await T('report-generate').isDisabled()), 15000)
  await T('report-generate').click()
  const made = await waitFor(async () => (await ctx.page.evaluate(() => window.api.report.list('math'))).length > 0, 120000)
  check('数学报告', '模拟 AI 生成了一份报告，在数学下', !!made)
  const rm = await ctx.page.evaluate(() => window.api.report.list('math'))
  const re = await ctx.page.evaluate(() => window.api.report.list('english'))
  const rc = await ctx.page.evaluate(() => window.api.report.list('chinese'))
  check('数学报告', '接口：数学 1 份，英语、语文 0 份', rm.length === 1 && re.length === 0 && rc.length === 0, `${rm.length}/${re.length}/${rc.length}`)
  const repRow = withDb(ud, d => d.prepare('SELECT subject FROM reports').all().map(r => r.subject).join(','))
  check('数学报告', '库里这份报告 subject = math', repRow === 'math', repRow)
  await goto('#/report')
  await waitFor(async () => (await ctx.page.locator('.ewb-rep-item').count()) > 0, 15000)
  check('数学报告', '报告页：数学下的历史里有 1 份', (await ctx.page.locator('.ewb-rep-item').count()) === 1)
  await pick('english')
  await goto('#/report'); await T('report-new').waitFor({ timeout: 15000 }); await ctx.page.waitForTimeout(800)
  check('数学报告', '切到英语：报告历史里没有这份', (await ctx.page.locator('.ewb-rep-item').count()) === 0)
  await pick('chinese')
  await goto('#/report'); await T('report-new').waitFor({ timeout: 15000 }); await ctx.page.waitForTimeout(800)
  check('数学报告', '切到语文：报告历史里也没有这份', (await ctx.page.locator('.ewb-rep-item').count()) === 0)

  // ── 4. 助手：会话按学科 ──
  await pick('math')
  await goto('#/assistant'); await T('assistant-page').waitFor({ timeout: 15000 })
  await T('assistant-input').fill('你好，先简单介绍一下你能做什么')
  await T('assistant-send').click()
  await waitFor(async () => (await ctx.page.evaluate(() => window.api.agent.sessions('math'))).length > 0, 30000)
  await waitFor(async () => (await T('assistant-answer').count()) > 0, 60000)
  await waitFor(async () => (await T('assistant-stop').count()) === 0, 30000)
  const sm = await ctx.page.evaluate(() => window.api.agent.sessions('math'))
  const se = await ctx.page.evaluate(() => window.api.agent.sessions('english'))
  const sc = await ctx.page.evaluate(() => window.api.agent.sessions('chinese'))
  check('助手', '接口：数学 1 个会话，英语、语文 0 个', sm.length === 1 && se.length === 0 && sc.length === 0, `${sm.length}/${se.length}/${sc.length}`)
  const sub = withDb(ud, d => d.prepare('SELECT subject FROM agent_sessions').all().map(r => r.subject).join(','))
  check('助手', '库里会话 subject = math', sub === 'math', sub)
  check('助手', '数学下会话列表里有 1 个', (await T('assistant-history-item').count()) === 1)
  await pick('english')
  await goto('#/assistant'); await T('assistant-page').waitFor({ timeout: 15000 }); await ctx.page.waitForTimeout(800)
  check('助手', '切到英语：会话列表里没有数学的会话', (await T('assistant-history-item').count()) === 0)
  await pick('math')
  await goto('#/assistant'); await T('assistant-page').waitFor({ timeout: 15000 }); await ctx.page.waitForTimeout(800)
  check('助手', '切回数学：会话还在', (await T('assistant-history-item').count()) === 1)

  // ── 清除示例数据：三个学科一起清 ──
  const cleared = await ctx.page.evaluate(() => window.api.data.clearSample())
  const left = withDb(ud, d => d.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1').get().c)
  check('示例数据', '清除示例数据：28 份一起清掉，导入的数学卷还在', cleared.papers === 28 && left === 0 && withDb(ud, d => d.prepare("SELECT COUNT(*) c FROM papers WHERE file_name = 'math-import.pdf'").get().c) === 1, JSON.stringify(cleared))
  const rep2 = await ctx.page.evaluate(() => window.api.report.list('math'))
  check('示例数据', '基于示例数据生成的数学报告也一起清掉', rep2.length === 0)

  check('运行', '页面没有控制台错误', ctx.consoleErrors.length === 0, ctx.consoleErrors.join(' | ').slice(0, 300))
  await closeApp()
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-subject-flow.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-subject-flow.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
