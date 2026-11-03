// M11c 分析看板与导出端到端：演示路由 → 各类图表渲染 → 窄窗口不溢出 → 表格排序 → 深色模式截图 → 导出 xlsx / html / docx 并检查文件。
// 用法：npm run test:e2e:m11c   （沙箱外运行；构建时带 VITE_EWB_DESIGN=1 才有 /analysis-demo 路由）
const M = require('./m4-lib.cjs')
const JSZip = require('jszip')
const { check, waitFor, path, work, ctx, T, goto, open, closeApp, L, stubSave, fs, shots } = M

async function main() {
  const ud = path.join(work, 'userM11c')
  await open(ud)
  await goto('#/analysis-demo')
  await T('analysis-board').waitFor({ timeout: 20000 })
  const page = ctx.page

  // ── 1. 渲染 ──
  const kinds = await page.$$eval('[data-testid=rb-chart]', els => els.map(e => ({ k: e.dataset.kind, svg: !!e.querySelector('svg.rb-chart'), marks: e.querySelectorAll('.rb-m').length, titles: e.querySelectorAll('title').length })))
  check('渲染', '8 种图表都渲染出 SVG', kinds.length === 8 && kinds.every(k => k.svg), JSON.stringify(kinds))
  check('渲染', '覆盖柱 / 条形 / 堆叠 / 分组 / 折线 / 饼 / 散点 / 热力行', ['bar', 'barH', 'stackedBar', 'groupedBar', 'line', 'pie', 'scatter', 'heatRow'].every(k => kinds.some(x => x.k === k)))
  check('渲染', '每张图都有可悬停的图形和提示', kinds.every(k => k.marks > 0 && k.titles > 0))
  check('渲染', '核心发现 3 条、章节 4 个、口径说明在最后', (await page.locator('.rb-finding').count()) === 3 && (await T('rb-section').count()) === 4 && (await T('rb-caliber').count()) === 1)
  check('渲染', '指标卡、出处标签、高亮行都在', (await T('rb-kpis').count()) === 1 && (await T('rb-source').count()) >= 3 && (await page.locator('tr.rb-hi').count()) === 2)
  check('渲染', '饼图可见数字标签（占比）', /31\.7%/.test(await page.locator('[data-kind=pie]').innerText()))

  // ── 2. 点出处回调 ──
  await T('rb-source').first().click()
  check('出处', '点「出处」触发回调并带回查询 id', /q-001/.test(await T('demo-source').innerText()))

  // ── 3. 表格排序 ──
  const col = async () => page.$$eval('[data-testid=rb-table] tbody tr td:first-child', tds => tds.map(t => t.textContent))
  const before = await col()
  await page.locator('[data-testid=rb-table] th', { hasText: '最近得分' }).locator('button').click()
  const asc = await col()
  await page.locator('[data-testid=rb-table] th', { hasText: '最近得分' }).locator('button').click()
  const desc = await col()
  check('表格', '点表头升序、再点降序', asc[0] === '学生甲' && desc[0] === '学生戊' && before.join() !== desc.join(), `${asc} | ${desc}`)

  // ── 4. 窄窗口不溢出 ──
  await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(300, 400); w.setSize(520, 900) })
  await waitFor(async () => (await page.evaluate(() => window.innerWidth)) <= 540, 5000)
  await page.waitForTimeout(600)
  const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, svgs: [...document.querySelectorAll('svg.rb-chart')].filter(s => s.getBoundingClientRect().right > window.innerWidth + 1).length }))
  check('窄窗口', '页面没有横向滚动，图表不超出窗口', over.sw <= over.iw + 1 && over.svgs === 0, JSON.stringify(over))
  await page.screenshot({ path: path.join(shots, 'm11c-narrow.png'), fullPage: false })
  await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 900) })
  await page.waitForTimeout(600)

  // ── 5. 浅色 / 深色截图 ──
  await page.screenshot({ path: path.join(shots, 'm11c-light.png'), fullPage: true })
  await T('demo-theme').click()
  await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 5000)
  await page.waitForTimeout(400)
  const dark = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('[data-testid=analysis-board]')).backgroundColor
    const txt = document.querySelector('.rb-chart text') && getComputedStyle(document.querySelector('.rb-chart text')).fill
    return { bg, txt }
  })
  check('深色', '深色模式：看板底色变深、图表文字是浅色', /rgb\((\d+)/.exec(dark.bg) && +/rgb\((\d+)/.exec(dark.bg)[1] < 80 && /rgb\((\d+)/.exec(dark.txt) && +/rgb\((\d+)/.exec(dark.txt)[1] > 120, JSON.stringify(dark))
  await page.screenshot({ path: path.join(shots, 'm11c-dark.png'), fullPage: true })
  await T('demo-theme').click()

  // ── 6. 导出：桩掉保存对话框，点界面按钮 ──
  const out = {}
  for (const [fmt, ext] of [['xlsx', 'xlsx'], ['html', 'html'], ['docx', 'docx']]) {
    const f = path.join(work, `board.${ext}`)
    await stubSave(f)
    await T(`rb-export-${fmt}`).click()
    check('导出', `${fmt}：界面点导出后写出文件`, await waitFor(async () => /已导出/.test(await T('demo-msg').innerText()) && fs.existsSync(f), 15000), await T('demo-msg').innerText())
    out[fmt] = f
    await page.evaluate(() => {}) ; await ctx.page.waitForTimeout(100)
  }
  const zx = await JSZip.loadAsync(fs.readFileSync(out.xlsx))
  const wb = await zx.file('xl/workbook.xml').async('string')
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1])
  check('xlsx', '工作表：核心发现 + 4 章 + 口径说明', names.length === 6 && names[0] === '核心发现' && names[5] === '口径说明', names.join(','))
  const html = fs.readFileSync(out.html, 'utf8')
  check('html', '单文件：8 张内联图，无外部引用，含深色样式', (html.match(/<svg class="rb-chart"/g) || []).length === 8 && !/<link\b|<script[^>]*\ssrc=|<img\b|(src|href)=["']https?:/i.test(html) && html.includes('prefers-color-scheme:dark'))
  const zd = await JSZip.loadAsync(fs.readFileSync(out.docx))
  const doc = await zd.file('word/document.xml').async('string')
  check('docx', 'Word 含标题、核心发现、表格和口径说明', doc.includes('示例学期学情分析') && doc.includes('阅读理解失分最集中') && doc.includes('<w:tbl>') && doc.includes('口径说明'))

  // ── 7. 名单导出（IPC 直调） ──
  const lf = path.join(work, 'list.xlsx')
  await stubSave(lf)
  const r = await page.evaluate(() => window.api.analysisReport.exportTable([{ key: 'name', label: '学生' }, { key: 'rate', label: '得分率', format: 'percent' }], [{ name: '学生甲', rate: 0.41 }, { name: '学生乙', rate: 0.5 }], '跟进名单'))
  check('名单', '名单 Excel 导出成功', r.saved === true && fs.existsSync(lf))
  const zl = await JSZip.loadAsync(fs.readFileSync(lf))
  check('名单', '含表头和百分比格式', (await zl.file('xl/styles.xml').async('string')).includes('0.0%') && (await zl.file('xl/sharedStrings.xml').async('string')).includes('学生甲'))

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11c.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(__dirname, 'last-result-m11c.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
