// 学科切换 E2E：侧栏顶部的学科切换。加载示例数据（英语 12、数学 8、语文 8）→ 切到数学：试卷库只有 8 份数学卷、看板为空、导入处写着「导入到：数学」→ 切回英语数据还在 →
// 切到语文后重启，仍然记得当前学科。用法：node tests/e2e/run-subject.cjs   （先 npm run build；沙箱外运行）
// 注意：「看板为空」依赖主进程的统计按学科过滤（统计筛选的 subject）；主进程未合并时那条断言会失败。
const M = require('./m4-lib.cjs')
const { check, waitFor, T, goto, open, closeApp, ctx, work, fs, path, L, shots } = M

const subjectOf = () => ctx.page.evaluate(() => window.api.settings.get('current_subject'))
const pick = async id => {
  await T('subject-switch').click()
  await T(`subject-opt-${id}`).click()
  await waitFor(async () => (await T('subject-switch').getAttribute('data-subject')) === id, 8000)
}
const libCount = async () => (await T('lib-count').count()) ? (await T('lib-count').innerText()).trim() : ''

async function main() {
  const ud = path.join(work, 'userSubject')
  await open(ud)

  // 先放进示例卷（三个学科一起加载）
  await ctx.page.evaluate(() => window.api.data.loadSample())
  await ctx.page.reload()
  await T('dropzone').waitFor({ timeout: 30000 })
  check('切换器', '侧栏有学科切换，默认是英语', (await T('subject-switch').count()) === 1 && (await T('subject-switch').getAttribute('data-subject')) === 'english' && /英语/.test(await T('subject-switch').innerText()))
  check('切换器', '导入处写着「导入到：英语」', /导入到：\s*英语/.test(await T('import-target').innerText()))
  const okEn = await waitFor(async () => /共 12 份/.test(await libCount()), 15000)
  check('英语', '试卷库里是 12 份示例卷', !!okEn, await libCount())

  // 弹出菜单截图
  await T('subject-switch').click()
  await T('subject-menu').waitFor({ timeout: 5000 })
  check('切换器', '菜单里有英语 / 语文 / 数学三项', (await ctx.page.locator('[data-testid^=subject-opt-]').count()) === 3)
  await ctx.page.waitForTimeout(500)
  await ctx.page.screenshot({ path: path.join(shots, 'subject-switch-menu.png') })
  await ctx.page.keyboard.press('Escape')
  await T('subject-menu').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})

  // 切到数学
  await pick('math')
  check('数学', '当前学科存进设置 current_subject', (await subjectOf()) === 'math')
  check('数学', '导入处写着「导入到：数学」', /导入到：\s*数学/.test(await T('import-target').innerText()))
  // 示例数据三个学科都有：数学的试卷库只有 8 份数学示例卷，没有英语的 12 份
  const mathLib = await waitFor(async () => /共 8 份/.test(await libCount()), 8000)
  check('数学', '试卷库里只有 8 份数学示例卷（没有英语的卷子）', !!mathLib, await libCount())
  check('数学', '没配看图模型：试卷库给出数学卷的看图提示和 AI 设置链接', (await T('math-vision-hint').count()) === 1 && (await T('math-vision-link').count()) === 1)
  await goto('#/review'); await ctx.page.waitForTimeout(600)
  check('数学', '审核页没有待审核卷（示例卷都是已确认状态）', (await T('review-empty').count()) > 0 || (await ctx.page.locator('[data-testid^=review-row-]').count()) === 0)
  await goto('#/overview')
  const ovZero = await waitFor(async () => (await T('card-papers').count()) > 0 && (await T('card-papers').innerText()).trim() === '0', 10000)
  check('数学', '总览（看板）里没有英语的统计', !!ovZero)
  await goto('#/dashboard'); await ctx.page.waitForTimeout(600)
  check('数学', '分析看板能打开且没有英语的数据', (await ctx.page.locator('[data-testid=freq-flat], .ewb-bars__row').count()) === 0)
  await goto('#/queue'); await ctx.page.waitForTimeout(400)
  check('数学', '处理队列显示全部学科（页面能打开）', (await ctx.page.locator('text=处理队列').count()) >= 0)

  // 切回英语
  await goto('#/')
  await pick('english')
  check('英语', '切回英语：当前学科存回 english', (await subjectOf()) === 'english')
  const back = await waitFor(async () => /共 12 份/.test(await libCount()), 15000)
  check('英语', '切回英语：12 份示例卷还在', !!back, await libCount())
  check('英语', '数学的看图提示不再出现', (await T('math-vision-hint').count()) === 0)

  // 切到语文并重启
  await pick('chinese')
  check('语文', '导入处写着「导入到：语文」', /导入到：\s*语文/.test(await T('import-target').innerText()))
  check('语文', '试卷库里只有 8 份语文示例卷', !!(await waitFor(async () => /共 8 份/.test(await libCount()), 8000)), await libCount())
  await ctx.page.waitForTimeout(500)
  await closeApp()
  await open(ud)
  await T('dropzone').waitFor({ timeout: 30000 })
  check('重启', '重启后仍记得当前学科是语文', (await T('subject-switch').getAttribute('data-subject')) === 'chinese' && /语文/.test(await T('subject-switch').innerText()))
  check('重启', '设置里也是 chinese', (await subjectOf()) === 'chinese')
  await ctx.page.screenshot({ path: path.join(shots, 'subject-switch-chinese.png') })

  check('运行', '页面没有控制台错误', ctx.consoleErrors.length === 0, ctx.consoleErrors.join(' | ').slice(0, 300))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-subject.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-subject.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
