// 导入自动分流 + 自动认学科 E2E（界面部分）：
//  1) 窗口里（非试卷库、数据页）拖入文件 → 汇总提示、「切到数学查看」按钮
//  2) 试卷库「学科建议」提醒条：【放到数学】【保持英语】、批量按钮；处理队列同样有提醒
//  3) 试卷「改学科」：已审核的题要二次确认
//  4) 数据页：没有来源入口条；文档、数据集有学科标签并能改；顶部筛选「当前学科和通用 / 全部」
// 依赖后端接口：files.importAuto、papers.resolveSubject / setSubject、datasets.setDocumentSubject / setDatasetSubject、
// papers.list 的 subject_hint、datasets 返回的 subject。后端合并后再跑。
// 用法：node tests/e2e/run-auto-route.cjs   （先 npm run build；沙箱外运行）
const M = require('./m4-lib.cjs')
const { check, waitFor, T, goto, open, closeApp, ctx, work, fs, path, L, shots, startMock, cfgFor, saveCfg } = M
const JSZip = require('jszip')

/** 现场生成一份只有几段文字的 .docx */
async function writeDocx(file, lines) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(t => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
}
const mathLines = n => [`三年级数学期中测试卷（${n}）`, '姓名：______  班级：______  得分：______', '一、计算题（共 20 分）', '1. 125 + 378 = （  ）', '2. 504 ÷ 6 = （  ）', '3. 3/8 + 2/8 = （  ）', '二、填空题', '1. 一根绳子长 3 米，剪去 150 厘米，还剩（  ）厘米。', '三、应用题', '小明买 3 本练习本，每本 4 元，付了 20 元，应找回多少元？']

/** 把文件拖到窗口的空白处（不在试卷库 / 数据页的拖放区内），走 GlobalDrop */
async function dropOnWindow(paths) {
  const cdp = await ctx.page.context().newCDPSession(ctx.page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 4, y: 4, data })
  await cdp.detach()
}
const hintCount = () => T('subject-hint').count()

async function main() {
  const ud = path.join(work, 'userAutoRoute')
  const mock = await startMock()
  await open(ud)
  await saveCfg(cfgFor(mock, { auto_parse: true }))
  await ctx.page.evaluate(() => window.api.data.loadSample())
  await ctx.page.reload()
  await T('dropzone').waitFor({ timeout: 30000 })

  const fx = path.join(work, 'fx'); fs.mkdirSync(fx, { recursive: true })
  const m1 = path.join(fx, '数学卷一.docx'), m2 = path.join(fx, '数学卷二.docx'), csv = path.join(fx, '学生名单.csv'), note = path.join(fx, '教案.docx')
  await writeDocx(m1, mathLines('一')); await writeDocx(m2, mathLines('二'))
  await writeDocx(note, ['第三单元教学设计', '教学目标：理解分数的意义。', '教学过程：导入、新授、练习、小结。'])
  fs.writeFileSync(csv, '科目,班级,成绩\n数学,三1,90\n英语,三1,85\n')

  // ── 1) 全局拖放：汇总提示 ──
  await goto('#/settings'); await ctx.page.waitForTimeout(500)
  await dropOnWindow([m1, m2, csv, note])
  const sumOk = await waitFor(async () => (await T('import-auto-summary').count()) > 0, 30000)
  check('全局拖放', '弹出一条导入汇总提示', !!sumOk)
  const sumText = sumOk ? (await T('import-auto-summary').innerText()) : ''
  check('全局拖放', '汇总里写了进试卷库的卷子数量和学科', /份.*卷.*进了试卷库/.test(sumText), sumText)
  check('全局拖放', '汇总里写了进数据的表', /1 张表.*进了数据/.test(sumText), sumText)
  check('全局拖放', '拖放不再把页面跳到试卷库', /#\/settings/.test(await ctx.page.evaluate(() => location.hash)))
  const hasSwitch = (await T('switch-to-math').count()) > 0
  if (hasSwitch) {
    await T('switch-to-math').click()
    check('全局拖放', '点「切到数学查看」切到了数学', !!(await waitFor(async () => (await T('subject-switch').getAttribute('data-subject')) === 'math', 8000)))
    await T('subject-switch').click(); await T('subject-opt-english').click()
    await waitFor(async () => (await T('subject-switch').getAttribute('data-subject')) === 'english', 8000)
  } else {
    check('全局拖放', '（卷子留在当前学科等确认时没有切换按钮）', true)
  }

  // ── 2) 学科建议提醒条 ──
  await goto('#/'); await T('dropzone').waitFor({ timeout: 10000 })
  const seen = await waitFor(async () => (await hintCount()) >= 1, 60000)
  check('学科建议', '试卷库顶部出现「这份看起来是数学卷」提醒', !!seen && /这份看起来是数学卷/.test(await T('subject-hint').first().innerText()))
  check('学科建议', '提醒有【放到数学】和【保持英语】两个按钮', (await T('hint-accept').first().innerText()).includes('放到数学') && (await T('hint-keep').first().innerText()).includes('保持英语'))
  check('学科建议', '有多份时出现批量按钮', (await hintCount()) < 2 || (await T('hint-accept-all').count()) === 1)
  check('学科建议', '带建议的卷子不能手动解析（先确认学科）', (await T('parse-paper').count()) === 0)
  await goto('#/queue')
  check('学科建议', '处理队列页也有同样的提醒', !!(await waitFor(async () => (await hintCount()) >= 1, 10000)))
  await goto('#/')
  await T('hint-accept').first().waitFor({ timeout: 10000 })
  const before = await hintCount()
  await T('hint-accept').first().click()
  check('学科建议', '点【放到数学】后这条提醒消失', !!(await waitFor(async () => (await hintCount()) === before - 1, 15000)))
  if (before >= 2) {
    await T('hint-keep').first().click()
    check('学科建议', '点【保持英语】后提醒消失', !!(await waitFor(async () => (await hintCount()) === before - 2, 15000)))
  }
  const left = await ctx.page.evaluate(() => window.api.papers.list({ allSubjects: true }))
  check('学科建议', '确认之后卷子上不再有 subject_hint', left.filter(p => p.subject_hint).length === 0)

  // ── 3) 改学科：已审核的二次确认 ──
  await goto('#/'); await waitFor(async () => /共 \d+ 份/.test(await T('lib-count').innerText()), 15000)
  const row = ctx.page.locator('tr', { has: ctx.page.locator('[data-testid=more-menu]') }).first()
  await row.locator('[data-testid=more-menu]').click()
  await T('change-subject').click()
  await T('subject-change-modal').waitFor({ timeout: 5000 })
  check('改学科', '弹出改学科窗口，当前学科不可选', await T('subject-change-english').locator('input').isDisabled())
  await T('subject-change-math').click()
  await T('subject-change-ok').click()
  const lose = await waitFor(async () => (await T('subject-lose-review').count()) > 0, 10000)
  check('改学科', '示例卷的题都是已审核的：弹出二次确认「已审核的 n 道题会丢失」', !!lose && /已审核的 \d+ 道题会丢失，按数学重新识别/.test(await T('subject-lose-review').innerText()))
  const n0 = (await T('lib-count').innerText()).match(/共 (\d+) 份/)
  await T('subject-lose-ok').click()
  check('改学科', '确认后这份卷子离开英语试卷库', !!(await waitFor(async () => { const m = (await T('lib-count').innerText()).match(/共 (\d+) 份/); return m && n0 && Number(m[1]) === Number(n0[1]) - 1 }, 15000)))

  // ── 4) 数据页 ──
  await ctx.page.evaluate(([c, d]) => window.api.datasets.import([c, d]), [csv, note])
  await goto('#/datasets')
  await T('datasets-page').waitFor({ timeout: 10000 })
  await waitFor(async () => (await T('data-subject-tag').count()) >= 2, 15000)
  check('数据页', '顶部没有「试卷 / 课程 / 报告」来源入口', (await T('datasets-sources').count()) === 0)
  check('数据页', '数据集和文档都有学科标签', (await T('data-subject-tag').count()) >= 2)
  check('数据页', '有「当前学科和通用 / 全部」筛选，默认前者', /当前学科和通用/.test(await T('datasets-scope').innerText()) && (await ctx.page.locator('[data-testid=datasets-scope] .ant-segmented-item-selected').innerText()).includes('当前学科和通用'))
  // 把文档改成数学：英语学科下默认筛选看不到它，切到「全部」能看到
  const docTag = T('documents-list').locator('[data-testid=data-subject-tag]').first()
  await docTag.click()
  await ctx.page.locator('.ant-select-item-option', { hasText: '数学' }).click()
  const hidden = await waitFor(async () => (await T('document-card').count()) === 0, 10000)
  check('数据页', '文档改成数学后，英语学科的默认筛选里不显示它', !!hidden && (await T('datasets-hidden').count()) === 1)
  await ctx.page.locator('[data-testid=datasets-scope] .ant-segmented-item', { hasText: '全部' }).click()
  check('数据页', '切到「全部」后又能看到，标签是数学', !!(await waitFor(async () => (await T('document-card').count()) === 1, 10000)) && (await T('document-card').locator('[data-testid=data-subject-tag]').getAttribute('data-subject')) === 'math')
  await ctx.page.screenshot({ path: path.join(shots, 'auto-route-datasets.png') })

  check('运行', '页面没有控制台错误', ctx.consoleErrors.length === 0, ctx.consoleErrors.join(' | ').slice(0, 300))
  await closeApp(); await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-auto-route.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-auto-route.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
