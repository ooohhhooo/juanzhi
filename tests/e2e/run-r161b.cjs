// Skill 从多次对话里长出来 + 定制包（r161-b）：同一类事做 3 次 → 出现「存成 Skill」提示 → 审核页（每步几次里几次有、来源可点开、AI 编的步骤被去掉）
// → 先试一次对比 → 保存 → Skill 列表里有；之后 3 次使用都被要求改结尾 → 更新提示 + 新旧对比 → 版本 2、历史可恢复；
// 定制包：导出（不含密钥）→ 导入预览（新增 / 替换）→ 勾选导入。全程 mock AI，数据虚构。
// 用法：node tests/e2e/run-r161b.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { check, waitFor, fs, path, work, SECRET, ctx, T, goto, cfgFor, saveCfg, startMock, open, closeApp, L, dataDirOf } = M
const { DatabaseSync } = require('node:sqlite')

const SHOTS = process.env.EWB_SHOTS || path.join(process.env.TMPDIR || '/tmp', 'r161b-shots')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = name => ctx.page.screenshot({ path: path.join(SHOTS, `r161b-${name}.png`) })
const count = id => T(id).count()
const stubSave = p => ctx.app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, p)
const stubOpen = p => ctx.app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, p)
const dbq = fn => { const d = new DatabaseSync(path.join(dataDirOf(), 'db.sqlite')); try { return fn(d) } finally { d.close() } }

/** 把还开着的弹窗都关掉（点右上角的 ×） */
async function closeModals() {
  for (let i = 0; i < 5; i++) {
    const x = ctx.page.locator('.ant-modal-wrap:visible .ant-modal-close')
    if (!(await x.count())) return
    await x.last().click(); await ctx.page.waitForTimeout(400)
  }
}
async function ask(text, fresh = true) {
  if (fresh) await T('assistant-new').first().click()
  await T('assistant-input').fill(text)
  await T('assistant-send').click()
  await waitFor(async () => (await count('assistant-stop')) === 0, 90000)
  await waitFor(async () => (await count('assistant-answer')) >= 1, 20000)
  await ctx.page.waitForTimeout(400)
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  await open(path.join(work, 'userR161b'), { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()

  // ── 1. 同一类事做 3 次 → 第 3 次出现提示 ──
  await ask('做一份学情小结，三年级', false)
  check('提示', '第 1 次没有提示', (await count('skill-suggest')) === 0)
  check('提示', '每个回答下面有「这次做得好」和「存成 Skill」', (await count('skill-like')) === 1 && (await count('skill-save-manual')) === 1)
  await ask('做一份学情小结，四年级')
  check('提示', '第 2 次没有提示', (await count('skill-suggest')) === 0)
  await T('skill-like').last().click()
  check('信号', '点「这次做得好」后记下 👍', await waitFor(async () => dbq(d => d.prepare('SELECT COUNT(*) c FROM agent_turns WHERE rating = 1').get().c) === 1, 5000))
  await ask('做一份学情小结，五年级')
  check('提示', '第 3 次出现「这类事你已经做了 3 次」', await waitFor(async () => (await count('skill-suggest')) === 1, 10000))
  const sugg = await T('skill-suggest').innerText()
  check('提示', '文案说明做了 3 次，有「存成 Skill」「不用了」', /已经做了 3 次/.test(sugg) && /存成 Skill/.test(sugg) && /不用了/.test(sugg), sugg)
  await ctx.page.waitForTimeout(500)
  await shot('01-suggestion-under-answer')

  // ── 2. 起草 + 审核页 ──
  await T('skill-suggest-save').click()
  await T('skill-review').waitFor({ timeout: 60000 })
  const steps = await ctx.page.locator('[data-testid=skill-review-step]').evaluateAll(els => els.map(e => ({ tool: e.getAttribute('data-tool'), hit: e.getAttribute('data-hit'), total: e.getAttribute('data-total'), text: e.innerText })))
  check('审核', '只留下样本里真有的 3 步（整体情况 / 试卷清单 / 确认年级）', steps.length === 3 && steps.map(s => s.tool).join() === 'stats_overview,papers_list,', JSON.stringify(steps.map(s => s.tool)))
  check('审核', 'AI 编的步骤（不存在的工具、角色用不了的发送、样本里没有的课程查询、没出处的）都被去掉', !steps.some(s => /course_for_kp|wecom_send|no_such_tool/.test(s.tool)) && !steps.some(s => /凭空/.test(s.text)))
  check('审核', '每步显示程序数出来的次数：3 次里 3 次都有（AI 自己说 5 次的也被改正）', steps.every(s => s.hit === '3' && s.total === '3') && steps[0].text.includes('3 次里 3 次都有'), steps[0]?.text)
  check('审核', '去掉了哪些步骤有说明', (await T('skill-review-warnings').innerText()).includes('一次都没出现'))
  check('审核', '参数（年级、时间段）出现在「需要你告诉我」', (await count('skill-review-param')) === 2)
  check('审核', '没有「只根据 N 次」的提醒（有 3 次）', (await count('skill-review-thin')) === 0)
  check('审核', '参考了 3 次对话，👍 那次排在里面', (await count('skill-review-sample')) === 3)
  const sentSamples = JSON.stringify(mock.skillDraftRequests[0]?.user ?? '')
  check('隐私', '发给 AI 的样本里带了请求、工具顺序和最终回答，但没有工具结果原文', sentSamples.includes('样本 3') && sentSamples.includes('stats_overview') && sentSamples.includes('这次做得好') && !sentSamples.includes('tool_result'))
  await T('skill-review-evidence').first().click()
  await T('skill-sample-view').waitFor()
  check('来源', '点「第 N 次」能看到那次对话的问题和回答', (await T('skill-sample-view').innerText()).includes('学情小结'))
  await ctx.page.keyboard.press('Escape')
  await T('skill-sample-view').waitFor({ state: 'detached' })
  await shot('02-review-with-evidence')

  // ── 3. 先试一次 ──
  const reqBefore = mock.agentRequests.length
  await T('skill-review-try').click()
  await T('skill-try-compare').waitFor({ timeout: 90000 })
  const tn = await T('skill-try-new').innerText(), to = await T('skill-try-original').innerText()
  check('试跑', '并排显示原来的回答和试跑的回答', tn.includes('学情小结') && to.includes('学情小结'))
  const tryTools = mock.agentRequests.slice(reqBefore).flatMap(r => r.toolNames ?? [])
  check('试跑', '试跑时不开放发送 / 写文件类功能', !tryTools.some(n => /wecom_send|board_|doc_create|output_export|table_save|card_make|paper_import/.test(n)), tryTools.filter(n => /wecom|board|doc_|output|table|card/.test(n)).join())
  await T('skill-review-try').scrollIntoViewIfNeeded()
  await ctx.page.locator('[data-testid=skill-try-compare]').scrollIntoViewIfNeeded()
  await ctx.page.waitForTimeout(500)
  await shot('03-try-run-compare')

  // ── 4. 保存 → Skill 列表里有 ──
  await T('skill-review-save').click()
  await T('skill-review').waitFor({ state: 'detached', timeout: 15000 })
  const meta = dbq(d => d.prepare("SELECT version, sample_count, sources_json FROM skill_meta WHERE name = '学情小结'").get())
  check('保存', '保存后有 Skill「学情小结」，版本 1，来自 3 次对话（来源记下了）', meta && meta.version === 1 && meta.sample_count === 3 && JSON.parse(meta.sources_json).length === 3, JSON.stringify(meta))
  const file = path.join(dataDirOf(), 'playbooks')
  const md = fs.readdirSync(file).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(file, f), 'utf8')).join('\n')
  check('保存', 'Skill 正文有步骤、参数、输出格式，且不含 AI 编的工具', md.includes('stats_overview') && md.includes('需要你告诉我') && md.includes('输出格式') && !md.includes('wecom_send') && !md.includes('no_such_tool'))
  check('提示', '保存后这一类不再提示', (await count('skill-suggest')) === 0)
  await T('assistant-settings-open').first().click()
  await T('assistant-settings-tab-skills').click()
  await T('skill-list').waitFor()
  const item = ctx.page.locator('[data-testid=skill-item][data-name=学情小结]')
  check('列表', '「我的 Skill」里能看到它，写着版本 1、根据 3 次对话整理', (await item.count()) === 1 && (await item.innerText()).includes('版本 1') && (await item.innerText()).includes('3 次对话'))
  await closeModals()

  // ── 5. 只有 1 次也能手动存，会标注「可能不够通用」 ──
  await ask('做一份阶段小结，高年级')
  await T('skill-save-manual').last().click()
  await T('skill-review').waitFor({ timeout: 60000 })
  check('手动', '只根据 1 次对话时审核页标注「只根据 1 次对话，可能不够通用」', (await T('skill-review-thin').innerText()).includes('只根据 1 次对话，可能不够通用'))
  await ctx.page.keyboard.press('Escape')
  await T('skill-review').waitFor({ state: 'detached', timeout: 10000 })

  // ── 6. 用 Skill 做 3 次，每次都要求改结尾 → 更新提示 ──
  for (let i = 0; i < 3; i++) {
    await ask('做一份学情小结，六年级')
    check('使用', `第 ${i + 1} 次：助手读了 Skill「学情小结」`, (await ctx.page.locator('[data-testid=assistant-tool][data-name=load_playbook]').count()) >= 1)
    await ask('结尾改短一点', false)
    if (i < 2) check('更新', `第 ${i + 1} 次改完还不提示更新`, (await count('skill-update-suggest')) === 0)
  }
  check('更新', '连续 3 次都改了结尾 → 提示更新 Skill', await waitFor(async () => (await count('skill-update-suggest')) === 1, 10000))
  const ut = await T('skill-update-suggest').innerText()
  check('更新', '文案说「最近 3 次你都改了「结尾」」', /最近 3 次/.test(ut) && /结尾/.test(ut), ut)
  await ctx.page.waitForTimeout(500)
  await shot('04-update-suggestion')
  await T('skill-update-open').click()
  await T('skill-diff').waitFor({ timeout: 60000 })
  const adds = await ctx.page.locator('[data-testid=skill-diff] [data-diff=add]').allInnerTexts()
  check('更新', '新旧对比里新版加了「结尾只写一句话」', adds.some(t => t.includes('结尾只写一句话')), adds.join('|').slice(0, 100))
  await ctx.page.waitForTimeout(500)
  await shot('05-update-diff')
  await T('skill-review-save').click()
  await T('skill-review').waitFor({ state: 'detached', timeout: 15000 })
  check('更新', '更新后版本 2，旧版本存进历史', dbq(d => d.prepare("SELECT version FROM skill_meta WHERE name = '学情小结'").get().version) === 2 && fs.readdirSync(path.join(file, '.history')).length === 1)
  check('更新', '更新后不再提示', (await count('skill-update-suggest')) === 0)
  await T('assistant-settings-open').first().click()
  await T('assistant-settings-tab-skills').click()
  await T('skill-history').click()
  await T('skill-versions').waitFor()
  check('历史', '历史里有第 1 版和第 2 版', (await count('skill-version-row')) === 2)
  await T('skill-version-restore').click()
  await ctx.page.locator('.ant-modal-confirm .ant-btn-primary').click()
  check('历史', '恢复到第 1 版后版本变 3，内容回到旧版', await waitFor(async () => dbq(d => d.prepare("SELECT version FROM skill_meta WHERE name = '学情小结'").get().version) === 3, 8000) && !fs.readFileSync(path.join(file, fs.readdirSync(file).find(f => f.endsWith('.md'))), 'utf8').includes('结尾只写一句话'))
  await closeModals()

  // ── 7. 定制包 ──
  await ctx.page.evaluate(() => window.api.connectors.save({ type: 'mcp', name: '文档服务', config: { transport: 'stdio', command: 'npx', args: ['-y', 'some-doc-server'], env: { DOC_API_KEY: 'sk-live-ABCDEFGH12345678' } } }))
  await ctx.page.evaluate(() => window.api.agent.saveRole({ name: '续费跟进', description: '你在帮班主任跟进续费', tools: ['stats_overview'], suggestions: ['谁快到期了'], notes: '' }))
  await T('assistant-settings-open').first().click()
  await T('assistant-settings-tab-pack').click()
  await T('pack-panel').waitFor()
  await T('pack-group-skills').waitFor()
  check('配置包', '导出页列出我的角色、Skill、外部连接', (await count('pack-group-roles')) === 1 && (await count('pack-group-skills')) === 1 && (await count('pack-group-connectors')) === 1)
  const out = path.join(work, '卷知配置包.juanzhi-pack.json')
  await stubSave(out)
  await T('pack-export').click()
  await waitFor(async () => fs.existsSync(out), 10000)
  const txt = fs.readFileSync(out, 'utf8')
  const pack = JSON.parse(txt)
  check('配置包', '导出文件里有角色、Skill（带版本）、外部连接的设置', pack.roles.length === 1 && pack.skills.length === 1 && pack.skills[0].version === 3 && pack.connectors.length === 1)
  check('配置包', '导出文件里没有任何密钥（环境变量只留名字，AI 密钥也不在）', !txt.includes('sk-live-ABCDEFGH12345678') && !txt.includes(SECRET) && pack.connectors[0].needs.env[0] === 'DOC_API_KEY')
  check('配置包', '导出文件里没有试卷、学员、对话', !/"sessionId"|answerSeq|agent_steps|"papers"|学员/.test(txt))
  // 造一个「同事给的」包：改了 Skill 的内容（替换）、多了一个角色（新增）、一个同名连接（替换）
  const theirs = JSON.parse(txt)
  theirs.skills[0].body = theirs.skills[0].body + '\n- [ ] 同事加的检查\n'; theirs.skills[0].version = 5
  theirs.roles.push({ name: '新来的角色', description: '你在帮同事', tools: ['stats_overview', 'no_such_tool'], suggestions: [], notes: '' })
  const inFile = path.join(work, '同事的配置包.juanzhi-pack.json')
  fs.writeFileSync(inFile, JSON.stringify(theirs))
  await stubOpen(inFile)
  await T('pack-import').click()
  await T('pack-preview').waitFor()
  const items = await ctx.page.locator('[data-testid=pack-item]').evaluateAll(els => els.map(e => `${e.getAttribute('data-kind')}:${e.getAttribute('data-key')}:${e.getAttribute('data-status')}`))
  check('导入', '预览里：Skill 会替换、新角色新增、同名角色和连接相同或会替换', items.includes('skill:学情小结:replace') && items.includes('role:新来的角色:add') && items.some(i => i.startsWith('connector:')) && items.includes('role:续费跟进:same'), items.join(' | '))
  check('导入', '预览说明了不会运行任何东西', (await T('pack-preview').innerText()).includes('不会立刻运行'))
  await ctx.page.waitForTimeout(700)
  await shot('06-pack-import-preview')
  await ctx.page.locator('[data-testid=pack-item][data-kind=skill] input[type=checkbox]').check()
  await ctx.page.locator('[data-testid=pack-item][data-kind=connector] input[type=checkbox]').check()
  await T('pack-import-apply').click()
  await T('pack-result').waitFor()
  const rtxt = await T('pack-result').innerText()
  check('导入', '导入结果：新增 1（新角色），替换 2（Skill 和连接），提示去填密钥', /新增 1 项，替换 2 项/.test(rtxt) && /DOC_API_KEY|文档服务/.test(rtxt), rtxt)
  const roles = await ctx.page.evaluate(() => window.api.agent.customRoles())
  check('导入', '新角色已存在，不认识的工具被去掉', roles.some(r => r.name === '新来的角色' && r.tools.join() === 'stats_overview'))
  check('导入', 'Skill 被替换后版本继续往上加，旧的进历史', dbq(d => d.prepare("SELECT version FROM skill_meta WHERE name = '学情小结'").get().version) === 4)
  const secretKept = await ctx.page.evaluate(() => window.api.connectors.list())
  check('导入', '同名连接只更新设置，没有把已填的密钥清掉', secretKept.length === 1 && secretKept[0].summary.includes('DOC_API_KEY'))
  check('稳定', '没有页面报错', (ctx.consoleErrors ?? []).filter(e => !/ResizeObserver|Download the React DevTools/.test(String(e))).length === 0, JSON.stringify((ctx.consoleErrors ?? []).slice(0, 3)).slice(0, 200))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(work, 'last-result-r161b.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(work, 'last-result-r161b.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
