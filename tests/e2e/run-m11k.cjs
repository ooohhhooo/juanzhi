// 数据目录与跨对话记忆（M11k）：新对话能翻到以前对话里的内容；数据页能导入图片 / 文本成为「文档资料」并查看读出的文字；
// 助手的数据目录里能看到文档、试卷、课程、报告，read_document 读到的文字去掉了手机号。全程 mock AI，数据虚构。
// 用法：node tests/e2e/run-m11k.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { check, waitFor, fs, path, work, SECRET, ctx, T, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11k')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = name => ctx.page.screenshot({ path: path.join(SHOTS, `m11k-${name}.png`) })
const count = id => T(id).count()
const IMG = path.join(__dirname, '..', 'unit', 'fixtures', 'real-page-1.png')

async function dropOn(selector, files) {
  await ctx.page.evaluate(() => { let i = document.getElementById('m11k-input'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'm11k-input'; i.style.display = 'none'; document.body.appendChild(i) } })
  await ctx.page.setInputFiles('#m11k-input', files)
  await ctx.page.evaluate(sel => {
    const dt = new DataTransfer()
    for (const f of document.getElementById('m11k-input').files) dt.items.add(f)
    const el = document.querySelector(sel)
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, selector)
}
async function ask(text) {
  await T('assistant-input').fill(text)
  await T('assistant-send').click()
  await waitFor(async () => (await count('assistant-stop')) === 0, 90000)
}
const toolCalls = () => ctx.page.locator('[data-testid=assistant-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-name') + ':' + e.getAttribute('data-ok')))

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  await open(path.join(work, 'userM11k'), { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()

  // ── 1. 跨对话记忆 ──
  await ask('帮我写一段话术，跟家长沟通续费')
  await T('assistant-new').first().click()
  const before = mock.agentRequests.length
  await ask('上次那段话术是什么')
  const calls = await toolCalls()
  check('记忆', '新对话里调用了 history_search、history_read，都成功', calls.join(',') === 'history_search:true,history_read:true', calls.join(','))
  const ans = await T('assistant-answer').last().innerText().catch(() => '')
  check('记忆', '回答里带上了上次对话的内容', ans.includes('话术示例：坚持练习'), ans.slice(0, 80))
  const sys = JSON.stringify(mock.agentRequests.slice(before)[0]?.messages?.[0] ?? '')
  check('记忆', 'system 里列出了最近的其他对话标题', sys.includes('用户最近的其他对话') && sys.includes('帮我写一段话术'))
  await shot('01-memory')

  // ── 2. 数据页：导入图片和文本成为文档资料 ──
  const note = path.join(work, '家长沟通记录.md')
  fs.writeFileSync(note, '# 家长沟通记录\n家长希望孩子多练过去式。联系电话 13812345678。')
  await goto('#/datasets'); await T('datasets-page').waitFor()
  check('数据页', '说明里写了可以导入图片和文档', (await T('datasets-drop').innerText()).includes('图片'))
  await dropOn('[data-testid=datasets-drop]', [note, IMG])
  check('数据页', '两份文件成为文档资料', await waitFor(async () => (await count('document-card')) === 2, 90000), String(await count('document-card')))
  check('数据页', '没有跳到试卷库', (await ctx.page.evaluate(() => location.hash)).startsWith('#/datasets'))
  await T('document-open').first().click()
  check('数据页', '能查看读出的文字', await waitFor(async () => (await T('document-text').innerText().catch(() => '')).length > 10, 8000))
  await shot('02-documents')
  await ctx.page.keyboard.press('Escape')

  // ── 3. 助手的数据目录：文档 + 试卷 + 课程 + 报告；read_document 去掉手机号 ──
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-new').first().click()
  const b2 = mock.agentRequests.length
  await ask('看看所有资料')
  const c2 = await toolCalls()
  check('数据目录', '调用了 list_datasets、papers_list、course_coverage、reports_list、read_document，都成功', ['list_datasets', 'papers_list', 'course_coverage', 'reports_list', 'read_document'].every(n => c2.includes(n + ':true')), c2.join(','))
  const sent = JSON.stringify(mock.agentRequests.slice(b2).map(r => r.messages))
  check('数据目录', 'list_datasets 结果里有文档资料', sent.includes('家长沟通记录.md') || sent.includes('real-page-1.png'))
  check('数据目录', 'read_document 读到的文字里没有手机号', !sent.includes('13812345678'))

  // ── 4. 删除文档 ──
  await goto('#/datasets'); await T('datasets-page').waitFor()
  await T('document-remove').first().click()
  await ctx.page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
  check('数据页', '删除后少一份', await waitFor(async () => (await count('document-card')) === 1, 8000))

  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11k.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11k.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
