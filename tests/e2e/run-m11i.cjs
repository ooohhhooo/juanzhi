// 分享卡片端到端（M11i）：mock AI 依次调用 card_templates → card_make（学生知识点卡、家长本周学情卡各一张）
// → 右侧「产出」出现两张图片、能预览，有「复制图片 / 保存图片 / 发到企业微信」
// → 助手设置「分享卡片」页签里切换默认学生模板 → 再出一张，用的是新默认模板。
// 全程 mock AI（tests/mock-ai/agent.cjs 的「做卡片」剧本），数据全部虚构。
// 用法：node tests/e2e/run-m11i.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）。截图目录可用环境变量 EWB_SHOTS 指定。
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, fs, path, work, SECRET, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L, dataDirOf, stubSave } = M

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11i')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = name => ctx.page.screenshot({ path: path.join(SHOTS, `m11i-${name}.png`) })
const count = id => T(id).count()

const sessionsDir = () => path.join(dataDirOf(), 'agent-outputs')
const readIndexes = () => (fs.existsSync(sessionsDir()) ? fs.readdirSync(sessionsDir()).filter(d => fs.existsSync(path.join(sessionsDir(), d, 'index.json'))).map(d => ({ sid: d, items: JSON.parse(fs.readFileSync(path.join(sessionsDir(), d, 'index.json'), 'utf8')).items })) : [])

async function ask(text) {
  await T('assistant-input').fill(text)
  await T('assistant-send').click()
  await waitFor(async () => (await count('assistant-stop')) === 0, 90000)
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM11i')
  await open(ud, { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // ── 1. 辅导老师角色：推荐问题里有「给小雨做一张过去时的知识卡」 ──
  await goto('#/assistant'); await T('assistant-page').waitFor()
  const roles = await ctx.page.evaluate(() => window.api.agent.roles())
  const tutor = roles.roles.find(r => r.id === 'tutor')
  check('推荐问题', '辅导老师的推荐问题里有做知识卡', !!tutor && tutor.suggestions.some(s => /知识卡/.test(s)), tutor && tutor.suggestions.join('｜'))
  await T('assistant-mode').click(); await T('assistant-mode-direct').click()

  // ── 2. 提问 → card_templates → card_make ×2 ──
  await ask('请帮我做卡片：给小雨一张过去式知识卡，再给家长一张本周反馈')
  const calls = await ctx.page.locator('[data-testid=assistant-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-name') + ':' + e.getAttribute('data-ok')))
  check('工具', '依次调用了 card_templates、card_make、card_make，都成功', calls.join(',') === 'card_templates:true,card_make:true,card_make:true', calls.join(','))
  // 窗口窄时右侧面板默认收成竖条：展开
  if (await waitFor(async () => (await count('side-unfold')) === 1, 3000)) await T('side-unfold').click()
  check('产出', '右侧产出出现两张图片', await waitFor(async () => (await ctx.page.locator('[data-testid^=out-tab-i]').count()) === 2, 20000), String(await ctx.page.locator('[data-testid^=out-tab-]').evaluateAll(es => es.map(e => e.getAttribute('data-testid')).join(','))))
  const tabs = await ctx.page.locator('[data-testid^=out-tab-i]').allInnerTexts()
  await T('out-tab-i1').click()
  const imgSize = () => ctx.page.evaluate(() => { const i = document.querySelector('[data-testid=out-image]'); return i && i.complete ? i.naturalWidth + 'x' + i.naturalHeight : '' })
  check('预览', '能预览第一张：图片已加载，是 1086×1448', await waitFor(async () => (await imgSize()) === '1086x1448', 15000), tabs.join('｜') + ' ' + (await imgSize()))
  await shot('01-student-card')
  await T('out-tab-i2').click()
  check('预览', '能预览第二张（家长卡）', await waitFor(async () => (await ctx.page.evaluate(() => { const i = document.querySelector('[data-testid=out-image]'); return i && i.complete && i.naturalWidth })) === 1086, 15000))
  await shot('02-parent-card')
  check('按钮', '有「复制图片」「保存图片」「发到企业微信」', (await count('out-copy-image')) === 1 && (await count('out-save-image')) === 1 && (await count('out-send-wecom')) === 1)

  // ── 3. 文件：在会话 exports 里，是有效 PNG；用的是默认模板；孩子称呼只写名 ──
  const idx = readIndexes()
  const items = idx.flatMap(x => x.items.map(i => ({ ...i, sid: x.sid }))).filter(i => i.type === 'image')
  check('文件', '索引里有两张 image，模板是默认的 s01 / p01', items.length === 2 && items[0].card.templateId === 's01' && items[1].card.templateId === 'p01', JSON.stringify(items.map(i => i.card)))
  const files = items.map(i => path.join(sessionsDir(), i.sid, i.file))
  check('文件', '都在 exports 文件夹里，是 PNG', files.every(f => f.includes(`${path.sep}exports${path.sep}`) && M.isPng(f)), files.join(','))
  files.forEach((f, i) => { try { fs.copyFileSync(f, path.join(SHOTS, `card-${i === 0 ? 'student-knowledge-s01' : 'parent-weekly-p01'}.png`)) } catch { /* 忽略 */ } })

  // ── 4. 复制 / 保存 ──
  await T('out-tab-i1').click()
  await T('out-copy-image').click()
  const fmts = await waitFor(async () => (await ctx.app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap(i => i.types))).some(f => /png|image/i.test(f)), 8000)
  check('复制', '点「复制图片」后剪贴板里有图片', fmts)
  const saveTo = path.join(work, '保存的卡片.png')
  await stubSave(saveTo)
  await T('out-save-image').click()
  check('保存', '点「保存图片」后文件写到选的位置', await waitFor(async () => fs.existsSync(saveTo) && M.isPng(saveTo), 8000))

  // ── 5. 发到企业微信：交给助手走 wecom_send（需要审批），请求里带了文件路径提示 ──
  const before = mock.agentRequests.length
  await T('out-send-wecom').click()
  await sleep(1500)
  const req = mock.agentRequests.slice(before).find(r => !r.toolNames.includes('ping'))
  check('发送', '点「发到企业微信」会让助手去发这张图（消息里写明 wecom_send / 文件）', !!req && /wecom_send/.test(JSON.stringify(req.messages)) && /图片/.test(JSON.stringify(req.messages)))
  await waitFor(async () => (await count('assistant-stop')) === 0, 60000)

  // ── 6. 设置：分享卡片页签，切换默认学生模板 ──
  await T('assistant-new').first().click()
  await T('assistant-settings-open').first().click()
  await T('assistant-settings-tab-cards').click()
  await T('assistant-cards').waitFor()
  check('设置', '学生、家长各 10 个缩略图，默认的 s01 / p01 高亮', await waitFor(async () => (await ctx.page.locator('[data-testid^=card-tpl-s]').count()) === 10 && (await ctx.page.locator('[data-testid^=card-tpl-p]').count()) === 10, 10000)
    && (await T('card-tpl-s01').getAttribute('data-picked')) === '1' && (await T('card-tpl-p01').getAttribute('data-picked')) === '1')
  check('设置', '缩略图是实时渲染出来的（至少前几张已出图）', await waitFor(async () => (await ctx.page.locator('[data-testid^=card-tpl-s] img').count()) >= 2, 60000))
  await T('card-zoom-s05').click()
  check('设置', '「预览大图」能打开大图', await waitFor(async () => (await count('card-zoom-img')) === 1, 30000))
  await shot('03-settings-zoom')
  await ctx.page.keyboard.press('Escape')
  await T('card-tpl-s05').locator('button').first().click()
  check('设置', '点 s05 设为默认：s05 高亮，s01 取消', await waitFor(async () => (await T('card-tpl-s05').getAttribute('data-picked')) === '1' && (await T('card-tpl-s01').getAttribute('data-picked')) === null, 8000))
  await shot('04-settings-picked')
  await T('card-name-none').click()
  check('设置', '孩子称呼可切到「不写名字」', await waitFor(async () => (await T('card-name-none').getAttribute('aria-pressed')) === 'true', 5000))
  await T('card-name-first').click()
  const st = JSON.parse(fs.readFileSync(path.join(dataDirOf(), 'share-cards.json'), 'utf8'))
  check('设置', '设置写进数据目录的 share-cards.json', st.defaults.student === 's05' && st.defaults.parent === 'p01' && st.childName === 'first', JSON.stringify(st))
  await ctx.page.keyboard.press('Escape')
  await T('assistant-settings-open').first().waitFor()

  // ── 7. 再出一张：用新默认 s05 ──
  await ask('再做一张卡片，还是过去式')
  check('默认', '新出的卡片用的是新默认模板 s05', await waitFor(() => {
    const it = readIndexes().flatMap(x => x.items).filter(i => i.type === 'image')
    return Promise.resolve(it.length === 3 && it.some(i => i.card.templateId === 's05'))
  }, 30000), JSON.stringify(readIndexes().flatMap(x => x.items).filter(i => i.type === 'image').map(i => i.card.templateId)))
  const newest = readIndexes().flatMap(x => x.items.map(i => ({ ...i, sid: x.sid }))).filter(i => i.type === 'image' && i.card.templateId === 's05')[0]
  if (newest) { try { fs.copyFileSync(path.join(sessionsDir(), newest.sid, newest.file), path.join(SHOTS, 'card-student-knowledge-s05.png')) } catch { /* 忽略 */ } }
  await shot('05-after-default')

  // ── 8. 收尾 ──
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11i.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11i.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
