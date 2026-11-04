// 助手附件端到端（M11j）：拖入表格不再跳到试卷库；文本 / 图片当附件（读出文字跟问题一起发给 AI，手机号去掉）；
// 粘贴截图（没有文件路径）也能当附件；发出后用户消息下显示附件名、输入区的附件清空；追问时历史里仍带着附件内容。
// 全程 mock AI，数据全部虚构。
// 用法：node tests/e2e/run-m11j.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { check, waitFor, fs, path, work, SECRET, ctx, T, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11j')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = name => ctx.page.screenshot({ path: path.join(SHOTS, `m11j-${name}.png`) })
const count = id => T(id).count()
const IMG = path.join(__dirname, '..', 'unit', 'fixtures', 'real-page-1.png')

/** 用真实文件模拟拖入：先放进隐藏的 <input type=file>（这样 File 带真实路径），再在助手页上派发 drop */
async function dropFiles(files) {
  await ctx.page.evaluate(() => { let i = document.getElementById('m11j-input'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'm11j-input'; i.style.display = 'none'; document.body.appendChild(i) } })
  await ctx.page.setInputFiles('#m11j-input', files)
  await ctx.page.evaluate(() => {
    const dt = new DataTransfer()
    for (const f of document.getElementById('m11j-input').files) dt.items.add(f)
    const el = document.querySelector('[data-testid=assistant-page]')
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
}

async function ask(text) {
  await T('assistant-input').fill(text)
  await T('assistant-send').click()
  await waitFor(async () => (await count('assistant-stop')) === 0, 90000)
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  await open(path.join(work, 'userM11j'), { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()

  // ── 1. 拖入：表格 + 文本 ──
  const csv = path.join(work, '续费名单.csv')
  fs.writeFileSync(csv, '学员,班级,是否续费\n学员甲,三年级1班,是\n学员乙,三年级1班,否\n')
  const note = path.join(work, '家长反馈.txt')
  fs.writeFileSync(note, '家长反馈记录：孩子最近过去式总是写错，希望多练习。联系电话 13812345678。')
  await dropFiles([csv, note])
  check('拖入', '表格加为本次对话的数据', await waitFor(async () => (await count('assistant-datachip')) === 1, 20000))
  check('拖入', '文本文件成为附件', await waitFor(async () => (await ctx.page.locator('[data-testid=assistant-attachchip][data-kind=text]').count()) === 1, 20000))
  await ctx.page.waitForTimeout(800)
  check('拖入', '还在助手页，没有跳到试卷库', (await ctx.page.evaluate(() => location.hash)).startsWith('#/assistant'), await ctx.page.evaluate(() => location.hash))
  const papers = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l.length : (l.items ?? []).length)).catch(() => -1))
  check('拖入', '没有被当成试卷导入', papers === 0, String(papers))

  // ── 2. 拖入不支持的文件：提示原因，不加附件 ──
  const zip = path.join(work, '资料.zip'); fs.writeFileSync(zip, 'PK')
  await dropFiles([zip])
  check('拖入', '不支持的文件给出提示', await waitFor(async () => (await ctx.page.locator('.ant-message').innerText().catch(() => '')).includes('读不了'), 8000))
  check('拖入', '不支持的文件不加附件', (await count('assistant-attachchip')) === 1)

  // ── 3. 粘贴截图（没有路径）：读出文字 ──
  const b64 = fs.readFileSync(IMG).toString('base64')
  await T('assistant-input').click()
  await ctx.page.evaluate(b => {
    const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    const dt = new DataTransfer(); dt.items.add(new File([u], 'image.png', { type: 'image/png' }))
    document.querySelector('[data-testid=assistant-input]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, b64)
  const imgOk = await waitFor(async () => (await ctx.page.locator('[data-testid=assistant-attachchip][data-kind=image]').count()) === 1, 60000)
  check('粘贴', '粘贴的截图识别出文字，成为图片附件', imgOk)
  check('输入框', '粘贴图片没有往输入框里塞东西', (await T('assistant-input').inputValue()) === '')
  await shot('01-chips')

  // ── 4. 发出：文字跟问题一起给 AI，手机号去掉；界面显示附件名；附件清空 ──
  const before = mock.agentRequests.length
  await ask('看看这些附件，家长主要反馈了什么')
  const req = mock.agentRequests.slice(before).filter(r => !JSON.stringify(r.messages).includes('"ping"')).pop()
  const sent = JSON.stringify(req?.messages ?? [])
  check('发送', 'AI 收到了文本附件的内容', sent.includes('过去式总是写错') && sent.includes('家长反馈.txt'))
  check('发送', '手机号没有发给 AI', !sent.includes('13812345678') && sent.includes('【手机号】'))
  check('发送', 'AI 收到了截图识别出的文字', /附件：截图1\.png（图片，以下是识别出的文字/.test(sent))
  check('界面', '用户消息下显示两个附件名', (await ctx.page.locator('[data-testid=assistant-user-attachments] .ewb-as-user__att').count()) === 2)
  const bubble = await T('assistant-user').first().innerText()
  check('界面', '用户消息里不显示附件全文', !bubble.includes('过去式总是写错'), bubble.slice(0, 80))
  check('界面', '发出后输入区的附件清空', (await count('assistant-attachchip')) === 0)
  await shot('02-sent')

  // ── 5. 追问：历史里还带着附件内容 ──
  const b2 = mock.agentRequests.length
  await ask('那该怎么跟家长回复')
  const req2 = mock.agentRequests.slice(b2).pop()
  check('追问', '追问时历史里仍带着附件内容', JSON.stringify(req2?.messages ?? []).includes('过去式总是写错'))

  // ── 5b. 粘贴两张试卷截图，让助手导入试卷库：合成一份 2 页的试卷 ──
  await T('assistant-new').first().click()
  const b64b = fs.readFileSync(path.join(__dirname, '..', 'unit', 'fixtures', 'real-page-2.png')).toString('base64')
  for (const [nm, data] of [['卷子第1页.png', b64], ['卷子第2页.png', b64b]]) {
    await T('assistant-input').click()
    await ctx.page.evaluate(([n, b]) => {
      const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
      const dt = new DataTransfer(); dt.items.add(new File([u], n, { type: 'image/png' }))
      document.querySelector('[data-testid=assistant-input]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, [nm, data])
  }
  await waitFor(async () => (await ctx.page.locator('[data-testid=assistant-attachchip][data-kind=image]').count()) === 2, 60000)
  const p0 = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l : l.items ?? []).length))
  await ask('把这份卷子导入试卷库，再帮我分析一下')
  const calls = await ctx.page.locator('[data-testid=assistant-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-name') + ':' + e.getAttribute('data-ok')))
  check('导入试卷', '调用了 paper_import 且成功', calls.includes('paper_import:true'), calls.join(','))
  const papersNow = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l : l.items ?? [])))
  check('导入试卷', '两张截图合成一份试卷进了试卷库', papersNow.length === p0 + 1, `${p0} → ${papersNow.length}`)
  const newest = papersNow.find(p => /2 页/.test(p.file_name ?? p.fileName ?? p.title ?? ''))
  check('导入试卷', '导入的是合成的 PDF', !!newest, JSON.stringify(papersNow.map(p => p.file_name ?? p.fileName ?? p.title)))
  const pages = await waitFor(async () => { const l = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l : l.items ?? []))); const x = l.find(p => /2 页/.test(p.file_name ?? p.fileName ?? p.title ?? '')); return x && (x.page_count ?? x.pageCount) === 2 }, 60000)
  check('导入试卷', '提取出 2 页', pages)

  // ── 5c. 两份不同的卷子：助手按分组导入成两份 ──
  await T('assistant-new').first().click()
  for (const data of [b64, b64b]) {
    await T('assistant-input').click()
    await ctx.page.evaluate(b => {
      const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
      const dt = new DataTransfer(); dt.items.add(new File([u], 'image.png', { type: 'image/png' }))
      document.querySelector('[data-testid=assistant-input]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, data)
  }
  await waitFor(async () => (await ctx.page.locator('[data-testid=assistant-attachchip][data-kind=image]').count()) === 2, 60000)
  const chipNames = await ctx.page.locator('[data-testid=assistant-attachchip]').allInnerTexts()
  check('导入试卷', '粘贴的截图按顺序叫「截图1、截图2」', chipNames.map(t => t.trim()).join(',') === '截图1.png,截图2.png', chipNames.join(','))
  const q0 = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l : l.items ?? []).length))
  await ask('这是两份卷子，分成两份导入')
  const q1 = await ctx.page.evaluate(() => window.api.papers.list().then(l => (Array.isArray(l) ? l : l.items ?? []).length))
  check('导入试卷', '按分组导入成两份试卷', q1 === q0 + 2, `${q0} → ${q1}`)

  // ── 6. ＋菜单有「添加图片或文档」 ──
  await T('assistant-plus').click()
  check('＋菜单', '有「添加图片或文档…」', (await ctx.page.locator('.ant-dropdown [data-testid=assistant-plus-attach]').count()) === 1)
  await ctx.page.keyboard.press('Escape')
  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11j.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11j.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
