// 知识点 ↔ 试卷 双向筛选与对比 E2E（示例数据，英语 / 数学 / 语文各跑一遍）：
// 试卷库「按知识点找卷子」→ 命中的知识点与题数 → 勾两份卷子「知识点对比」→ 看板里的并排表 → 点格子看原题；
// 回到普通筛选后从知识点出发（不选卷子）也能并排。用法：node tests/e2e/run-kp-compare.cjs   （先 npm run build；沙箱外运行）
const M = require('./m4-lib.cjs')
const { check, waitFor, T, goto, open, closeApp, ctx, work, path, L, shots } = M

const pick = async id => {
  await T('subject-switch').click()
  await T(`subject-opt-${id}`).click()
  await waitFor(async () => (await T('subject-switch').getAttribute('data-subject')) === id, 8000)
}
const libCount = async () => (await T('lib-count').count()) ? (await T('lib-count').innerText()).trim() : ''

async function runSubject(id, label) {
  await goto('#/')
  await pick(id)
  await waitFor(async () => /共 \d+ 份/.test(await libCount()), 15000)
  // 找一个在示例数据里至少 2 份卷子都考到的二级知识点（用主进程统计找，界面里再去选它）
  const target = await ctx.page.evaluate(async subject => {
    const d = await window.api.stats.distribution({ subject, sample: true })
    const tax = await window.api.taxonomy.tree({ subject })
    const byCode = new Map(tax.kps.map(k => [k.code, k]))
    const nodes = d.nodes.filter(n => n.level === 2 && n.papers >= 2 && n.papers < d.papers).sort((a, b) => b.papers - a.papers)
    const n = nodes[0] ?? d.nodes.filter(x => x.level === 2 && x.papers >= 2).sort((a, b) => b.papers - a.papers)[0]
    if (!n) return null
    const sameName = tax.kps.filter(k => k.name === byCode.get(n.code).name).map(k => k.code)
    const counts = []
    for (const c of sameName) counts.push((await window.api.stats.kpPapers({ subject, sample: true }, [c], 'any')).length)
    return { code: n.code, name: byCode.get(n.code).name, papers: n.papers, counts }
  }, id)
  check(label, '示例数据里有至少 2 份卷子都考到的知识点', !!target, JSON.stringify(target))
  if (!target) return

  // 界面里按知识点筛
  await T('kp-filter-select').click()
  await ctx.page.keyboard.type(target.name)
  await ctx.page.waitForTimeout(400)
  await ctx.page.locator('.ant-select-tree-node-content-wrapper:visible').filter({ has: ctx.page.locator('.ewb-kp-name', { hasText: new RegExp(`^${target.name}$`) }) }).first().click()
  await ctx.page.keyboard.press('Escape')
  const ok = await waitFor(async () => /找到 \d+ 份/.test(await libCount()), 8000)
  const n = Number(/找到 (\d+) 份/.exec(await libCount())?.[1] ?? -1)
  check(label, '选了知识点：试卷库只剩考了它的卷子（数量与主进程查询一致）', !!ok && target.counts.includes(n) && n >= 2, `${await libCount()} 期望之一 ${target.counts}`)
  const hitRows = await waitFor(async () => (await ctx.page.locator('[data-testid=kp-hits]').count()) > 0, 5000)
  check(label, '每份卷子下面写着命中的知识点和题数', !!hitRows && /\d+ 题/.test(await ctx.page.locator('[data-testid=kp-hits]').first().innerText()), await ctx.page.locator('[data-testid=kp-hits]').first().innerText().catch(() => ''))
  check(label, '给出口径说明（只列已确认的）', /已确认/.test(await T('kp-filter-note').innerText()))
  // 与搜索叠加：搜一个不存在的词 → 没有结果；清除后回来
  await T('lib-search').fill('不存在的卷名zzz')
  await waitFor(async () => (await T('lib-search-empty').count()) > 0, 5000)
  check(label, '知识点筛选能和标题搜索叠加', (await T('lib-search-empty').count()) > 0)
  await T('lib-search').fill('')
  await waitFor(async () => /找到 \d+ 份/.test(await libCount()), 5000)

  // 勾两份卷子 → 知识点对比
  const ids = await ctx.page.locator('[data-testid=kp-hits]').evaluateAll(els => els.slice(0, 2).map(e => e.getAttribute('data-paper')))
  for (const pid of ids) await ctx.page.locator(`[data-testid=select-row-${pid}] input, input[data-testid=select-row-${pid}]`).first().check().catch(async () => { await ctx.page.locator(`[data-testid=select-row-${pid}]`).first().click() })
  await T('select-bar').waitFor({ timeout: 5000 })
  check(label, '勾选 2 份后选择栏里有「知识点对比」', (await T('compare-selected').count()) === 1 && (await T('select-count').innerText()).trim() === '2')
  await T('compare-selected').click()
  await T('kpc-table').waitFor({ timeout: 15000 })
  check(label, '进入看板「知识点对比」，横排是这 2 份卷子', (await ctx.page.locator('[data-testid^=kpc-head-]').count()) === 2)
  check(label, '竖排有刚才选的知识点，两份卷子都考了', (await T(`kpc-row-${target.code}`).count()) === 1 && /^\d+\/2$/.test((await T(`kpc-hit-${target.code}`).innerText()).trim()))
  check(label, '摘要写出「几个每份都考了、几个只有一份考」', /每份都考了/.test(await T('kpc-summary').innerText()), await T('kpc-summary').innerText())
  await ctx.page.screenshot({ path: path.join(shots, `kp-compare-${id}.png`) })
  // 点格子看原题
  const cell = ctx.page.locator(`[data-testid^="kpc-cell-"][data-testid$="-${target.code}"]`).first()
  await cell.click()
  const qok = await waitFor(async () => (await ctx.page.locator('[data-testid=kpc-drawer] [data-testid=question-card]').count()) > 0, 10000)
  check(label, '点格子打开抽屉，能看到原题卡片', !!qok)
  await ctx.page.keyboard.press('Escape')
  // 不选知识点：这两份卷子考过的全部知识点
  check(label, '导出 Excel 按钮可用', !(await T('kpc-export').isDisabled()))

  // 另一个方向：回到普通筛选，从知识点出发（不选卷子），找出考了它的卷子
  await T('ids-back').click()
  await waitFor(async () => (await ctx.page.locator('[data-testid^=kpc-head-]').count()) === n, 15000)
  check(label, '清掉卷子选择后，按知识点找出全部命中的卷子并排', (await ctx.page.locator('[data-testid^=kpc-head-]').count()) === n && /考了这些知识点/.test(await T('kpc-summary').innerText()), await T('kpc-summary').innerText())
  // 只看「都考了」筛选
  await T('kpc-kind').getByText('都考了').click()
  check(label, '「都考了」筛选后只剩每份都考的知识点', (await ctx.page.locator('[data-testid^=kpc-row-][data-kind=all]').count()) >= 1 && (await ctx.page.locator('[data-testid^=kpc-row-]:not([data-kind=all])').count()) === 0)
  // 清掉知识点：回到试卷库
  await goto('#/')
  await waitFor(async () => /共 \d+ 份/.test(await libCount()), 10000)
}

async function main() {
  const ud = path.join(work, 'userKpCompare')
  await open(ud)
  await ctx.page.evaluate(() => window.api.data.loadSample())
  await ctx.page.reload()
  await T('dropzone').waitFor({ timeout: 30000 })
  await runSubject('english', '英语')
  await runSubject('math', '数学')
  await runSubject('chinese', '语文')
  check('运行', '页面没有控制台错误', ctx.consoleErrors.length === 0, ctx.consoleErrors.join(' | ').slice(0, 300))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-kp-compare.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-kp-compare.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
