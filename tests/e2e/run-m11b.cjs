// M11b E2E：数据集。导入虚构的 xlsx 与 csv → 列表出现 → 概况正确 → 敏感列被自动标出（可改）→ 预览显示真名 → 删除（文件也没了）。
// 数据全部由 tests/fixtures/gen-ops-data.cjs 现生成（虚构）。用法：npm run test:e2e:m11b   （沙箱外运行）
const M = require('./m4-lib.cjs')
const { check, waitFor, T, goto, open, closeApp, ctx, stubOpen, work, fs, path, L } = M
const { generate } = require('../fixtures/gen-ops-data.cjs')

const cardNames = () => ctx.page.locator('[data-testid^="dataset-"][data-name]').evaluateAll(els => els.map(e => e.getAttribute('data-name')))

async function importVia(file, expectCount) {
  await stubOpen(file)
  await T('datasets-drop').click()
  return waitFor(async () => (await cardNames()).length >= expectCount, 60000)
}

async function main() {
  const dir = path.join(work, 'ops')
  await generate(dir)
  const ud = path.join(work, 'userM11b')
  await open(ud)
  const dsDir = path.join(ud, 'workbench-data', 'datasets')

  // 侧栏入口 + 空状态
  check('数据页', '侧栏有“数据”入口', (await ctx.page.locator('.ewb-sider').innerText()).includes('数据'))
  await goto('#/datasets'); await T('datasets-page').waitFor({ timeout: 15000 })
  check('数据页', '没有数据时显示空状态', (await ctx.page.locator('text=还没有数据').count()) > 0)

  // 导入 xlsx
  check('导入', '导入 survey.xlsx：列表出现数据集卡片', !!(await importVia(path.join(dir, 'survey.xlsx'), 1)))
  const summary = await T('dataset-summary').first().innerText()
  check('导入', '卡片摘要含两张表及行数（问卷 300 行）和敏感列提示', /问卷 300 行/.test(summary) && /含敏感列/.test(summary), summary)
  // 导入 csv
  check('导入', '再导入 classes.csv：列表有两个数据集', !!(await importVia(path.join(dir, 'classes.csv'), 2)))
  check('导入', '目录里有 catalog.json 和两个 sqlite 文件', fs.existsSync(path.join(dsDir, 'catalog.json')) && fs.readdirSync(dsDir).filter(f => f.endsWith('.sqlite')).length === 2)

  // 概况（IPC）
  const list = await ctx.page.evaluate(() => window.api.datasets.list())
  const survey = list.find(d => d.sourceFile === 'survey.xlsx')
  const st = survey.tables.find(t => t.sheet === '问卷')
  const col = l => st.columns.find(c => c.label === l)
  check('概况', '问卷 300 行、标题行已跳过；类型：渠道=选项、推荐分=整数、原因=多选、提交时间=日期时间',
    st.rows === 300 && st.notes.some(n => /前 2 行/.test(n)) && col('渠道').type === 'select' && col('推荐分').type === 'integer' && col('推荐原因（多选）').type === 'multi' && col('提交时间').type === 'datetime')
  check('概况', '推荐分范围 0–10、有“像评分”提示；渠道常见取值 4 种', col('推荐分').profile.min === 0 && col('推荐分').profile.max === 10 && col('推荐分').profile.hints.some(h => /评分/.test(h)) && col('渠道').profile.distinct === 4)
  check('概况', '多选原因：6 个选项，有长表视图', col('推荐原因（多选）').profile.distinct === 6 && st.views.length === 1)

  // 敏感列自动标出
  const sens = st.columns.filter(c => c.sensitive).map(c => c.label).sort()
  check('敏感列', '自动标出：学员编号、家长手机、授课老师、辅导老师（年级 / 渠道 / 分数不标）', JSON.stringify(sens) === JSON.stringify(['学员编号', '家长手机', '授课老师', '辅导老师'].sort()), sens.join(','))

  // 界面：打开概况
  await ctx.page.locator(`[data-testid="dataset-${survey.id}"] [data-testid=dataset-open]`).click()
  await T('dataset-profile').first().waitFor({ timeout: 15000 })
  const sw = n => T(`dataset-sens-${n}`).first()
  const teacherCol = st.columns.find(c => c.label === '授课老师').name, gradeCol = st.columns.find(c => c.label === '年级').name
  check('敏感列', '界面开关：授课老师为开、年级为关', (await sw(teacherCol).getAttribute('aria-checked')) === 'true' && (await sw(gradeCol).getAttribute('aria-checked')) === 'false')

  // 预览显示真名
  await T('dataset-preview').first().waitFor({ timeout: 15000 })
  const pv = await T('dataset-preview').first().innerText()
  check('预览', '预览前 100 行显示真名（张老师01 一类），不是代号', /[张李王赵]老师0\d/.test(pv) && !/人员A\d{3}/.test(pv))
  const pvApi = await ctx.page.evaluate(([id, t]) => window.api.datasets.preview(id, t), [survey.id, st.name])
  check('预览', '预览接口返回 100 行、总行数 300', pvApi.rows.length === 100 && pvApi.total === 300)

  // 给 AI 看的概况文本不含真名 / 手机号
  const text = await ctx.page.evaluate(([id, t]) => window.api.datasets.profileText(id, t), [survey.id, st.name])
  check('敏感列', '给 AI 的概况文本里敏感列是代号，没有真名和手机号', /人员A\d{3}/.test(text) && !/[张李王赵]老师0\d/.test(text) && !/139\d{8}/.test(text))

  // 用户改标记
  await sw(gradeCol).click()
  await waitFor(async () => (await sw(gradeCol).getAttribute('aria-checked')) === 'true', 10000)
  const after = await ctx.page.evaluate(id => window.api.datasets.profile(id), survey.id)
  check('敏感列', '在界面勾选“年级”后，目录里记为敏感（非自动）', after.tables.find(t => t.sheet === '问卷').columns.find(c => c.label === '年级').sensitive === true && after.tables.find(t => t.sheet === '问卷').columns.find(c => c.label === '年级').sensitiveAuto === false)
  await sw(gradeCol).click()
  await waitFor(async () => (await sw(gradeCol).getAttribute('aria-checked')) === 'false', 10000)
  await ctx.page.keyboard.press('Escape')

  // 删除
  await ctx.page.locator(`[data-testid="dataset-${survey.id}"] [data-testid=dataset-remove]`).click()
  await ctx.page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').first().click()
  const gone = await waitFor(async () => !(await cardNames()).includes(survey.name), 15000)
  check('删除', '删除后列表里没有了，sqlite 与代号文件一并删除', !!gone && !fs.existsSync(path.join(dsDir, `${survey.id}.sqlite`)) && !fs.existsSync(path.join(dsDir, `${survey.id}.codes.json`)))
  const rest = JSON.parse(fs.readFileSync(path.join(dsDir, 'catalog.json'), 'utf8')).datasets
  check('删除', 'catalog.json 只剩 classes.csv 一项', rest.length === 1 && rest[0].sourceFile === 'classes.csv')

  // 错误提示：不支持的文件
  const bad = path.join(work, '不支持.pdf'); fs.writeFileSync(bad, 'x')
  await stubOpen(bad)
  await T('datasets-drop').click()
  const msg = await waitFor(async () => (await ctx.page.locator('.ant-message-notice').allInnerTexts()).find(t => /只支持 Excel/.test(t)), 15000)
  check('导入', '不支持的文件给白话提示', !!msg)

  check('运行', '页面没有控制台错误', ctx.consoleErrors.length === 0, ctx.consoleErrors.join(' | ').slice(0, 300))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11b.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11b.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
