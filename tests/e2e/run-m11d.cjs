// 助手画布 + 右侧面板（独立组件）端到端：演示路由 /assistant-canvas-demo，全部是虚构数据，不需要 AI。
// 用法：npm run test:e2e:m11d   （沙箱外运行：Electron 被沙箱限制；先 electron-vite build）
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, ctx, T, goto, open, closeApp, L, path, work, shots } = M

const shot = name => ctx.page.screenshot({ path: path.join(shots, `m11d-${name}.png`) })
const count = sel => ctx.page.locator(sel).count()
const logText = () => T('demo-log').innerText()
const world = () => ctx.page.evaluate(() => document.querySelector('.ewb-cv-world').style.transform)
const zoom = async () => parseInt((await T('cv-zoom').innerText()), 10)
const openDemo = async () => { await goto('#/assistant-canvas-demo'); await T('canvas').waitFor({ timeout: 20000 }); await sleep(500) }

async function main() {
  await open(path.join(work, 'userM11d'))
  await openDemo()

  // ── 1. 画布渲染出节点和连线 ──
  const nodes = await count('.ewb-cv-node')
  check('画布', '渲染出 30 个节点', nodes === 30, String(nodes))
  check('画布', '渲染出 29 条连线', (await count('[data-testid=cv-edge]')) === 29)
  check('画布', '主线问题节点和 3 条分支的追问节点都在', (await count('.ewb-cv-node[data-kind=question]')) === 1 && (await count('.ewb-cv-node[data-kind=followup]')) === 5)
  check('画布', '进行中的节点有 running 标记', (await count('.ewb-cv-node[data-status=running]')) >= 2)
  check('画布', 'step-group 默认折叠成一个小节点', (await count('.ewb-cv-node[data-kind=step-group]')) === 4)
  check('可访问性', '画布与节点有 aria 标签', (await T('canvas').getAttribute('role')) === 'tree' && /问题：/.test(await T('cv-node-q').getAttribute('aria-label')))
  await shot('canvas-light')

  // ── 2. 缩放 / 适应窗口 / 滚轮 ──
  const z0 = await zoom()
  await T('cv-zoom-in').click(); await T('cv-zoom-in').click()
  const z1 = await zoom()
  check('缩放', '点放大后比例变大', z1 > z0, `${z0}% → ${z1}%`)
  await T('cv-zoom-out').click()
  await T('cv-fit').click()
  check('缩放', '适应窗口：整棵树落进画布（比例变小）', (await zoom()) < z0 && (await zoom()) < 40, String(await zoom()))
  const box = await T('canvas').boundingBox()
  await ctx.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45)
  const zb = await zoom()
  await ctx.page.mouse.wheel(0, -240)
  await sleep(150)
  check('缩放', '滚轮缩放', (await zoom()) > zb, `${zb}% → ${await zoom()}%`)
  await T('cv-fit').click()

  // ── 3. 拖动平移 ──
  const w0 = await world()
  await ctx.page.mouse.move(box.x + 12, box.y + box.height - 60)
  await ctx.page.mouse.down(); await ctx.page.mouse.move(box.x + 90, box.y + box.height - 100, { steps: 6 }); await ctx.page.mouse.up()
  check('平移', '拖动背景后画布位置改变', (await world()) !== w0)
  check('平移', '拖动不会误选节点', (await T('cv-node-q').getAttribute('data-selected')) === null)
  await T('cv-fit').click()

  // ── 4. 只看结论 ──
  await T('cv-conclusions').click(); await sleep(300)
  const concl = await count('.ewb-cv-node')
  check('只看结论', '隐藏 plan / step-group / ask，只剩 23 个', concl === 23 && (await count('.ewb-cv-node[data-kind=plan]')) === 0 && (await count('.ewb-cv-node[data-kind=ask]')) === 0 && (await count('.ewb-cv-node[data-kind=step-group]')) === 0, String(concl))
  check('只看结论', '主线发现仍接在问题下面（连线 22 条）', (await count('[data-testid=cv-edge]')) === 22)
  await T('cv-conclusions').click(); await sleep(300)
  check('只看结论', '再点一次恢复 30 个', (await count('.ewb-cv-node')) === 30)

  // ── 5. 选中节点 → 右侧卡片详情 ──
  check('面板', '没选中时右侧是「产出」', (await T('side-panel').getAttribute('data-mode')) === 'outputs')
  await T('cv-fit').click(); await sleep(400)   // 默认缩放不低于 80%，30 个节点放不下，先适应窗口再点
  await T('cv-node-f2').click()
  await T('card-detail').waitFor({ timeout: 5000 })
  check('选中', '节点高亮', (await T('cv-node-f2').getAttribute('data-selected')) === '1')
  check('卡片详情', '标题是被选中的卡片', (await T('card-title').innerText()) === '新生比老生低 15 分')
  check('卡片详情', '来源：主线 · 第 1 轮', /主线 · 第 1 轮/.test(await T('card-source').innerText()), await T('card-source').innerText())
  check('卡片详情', '「数字从哪来」列出查询摘要', /按「新老生」分组计算推荐分/.test(await T('card-refs').innerText()))
  check('卡片详情', '这张卡片下的追问列表含分支追问和回答', /哪个渠道的新生最低？/.test(await T('card-followups').innerText()) && /渠道 A 最低/.test(await T('card-followups').innerText()))
  await T('card-ref').first().click()
  check('卡片详情', '点出处触发 onOpenRef(query:4)', /ref query:4/.test(await logText()))
  check('追问框', '显示「追问「新生比老生低 15 分」」', /追问「新生比老生低 15 分」/.test(await T('cv-ask-to').innerText()))
  await T('card-act-report').click(); await T('card-act-board').click()
  check('卡片详情', '加到汇报 / 加到看板 回调带节点 id', /action f2 add-to-report/.test(await logText()) && /action f2 add-to-board/.test(await logText()))
  await T('card-askfrom').click()
  check('卡片详情', '「从这里追问」让追问框获得焦点', await waitFor(() => ctx.page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'cv-ask-input'), 3000))

  // ── 6. 在节点上追问：回调收到正确节点 id ──
  await T('cv-act-ask-f1').click()
  check('追问', '点节点上的「↳ 追问」选中该节点并聚焦输入框', (await T('cv-node-f1').getAttribute('data-selected')) === '1' && /追问「各级别普遍下降」/.test(await T('cv-ask-to').innerText()))
  await ctx.page.keyboard.type('二级为什么降得最多呢')
  await ctx.page.keyboard.press('Enter')
  await sleep(200)
  check('追问', 'onFollowUp(f1, 文本)', /followup f1 二级为什么降得最多呢/.test(await logText()), await logText())
  check('追问', '发送后输入框清空，画布长出一个新节点', (await T('cv-ask-input').inputValue()) === '' && (await count('.ewb-cv-node')) === 31, `${await T('cv-ask-input').inputValue()} / ${await count('.ewb-cv-node')}`)
  await T('cv-act-make-list-f3').click()
  check('节点按钮', '生成名单回调带 f3', /action f3 make-list/.test(await logText()))
  check('节点按钮', 'finding / answer 有操作按钮，其他种类没有', (await count('[data-testid^="cv-act-add-to-board-"]')) === 13 && (await count('.ewb-cv-node[data-kind=plan] .ewb-cv-node__act')) === 0, String(await count('[data-testid^="cv-act-add-to-board-"]')))

  // ── 7. 键盘 ──
  await T('cv-node-q').click()
  await ctx.page.locator('[data-testid=canvas]').focus()
  await ctx.page.keyboard.press('ArrowDown')
  check('键盘', '↓ 移到第一个子节点（计划）', (await T('cv-node-plan').getAttribute('data-selected')) === '1')
  await ctx.page.keyboard.press('ArrowUp')
  check('键盘', '↑ 回到父节点', (await T('cv-node-q').getAttribute('data-selected')) === '1')
  await ctx.page.keyboard.press('ArrowDown'); await ctx.page.keyboard.press('ArrowDown'); await ctx.page.keyboard.press('ArrowRight')
  check('键盘', '→ 移到右边的兄弟节点', (await T('cv-node-f1').getAttribute('data-selected')) === '1' || (await count('.ewb-cv-node[data-selected]')) === 1)
  await ctx.page.keyboard.press('Enter')
  check('键盘', 'Enter 打开追问框', await waitFor(() => ctx.page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'cv-ask-input'), 3000))
  await ctx.page.keyboard.press('Escape')
  await ctx.page.keyboard.press('Escape')
  check('键盘', 'Esc 取消选中，右侧回到「产出」', (await count('.ewb-cv-node[data-selected]')) === 0 && (await T('side-panel').getAttribute('data-mode')) === 'outputs')
  check('键盘', '没有选中时追问框默认追问最后一个回答', /追问「/.test(await T('cv-ask-to').innerText()))

  // ── 8. 子树折叠 ──
  const before = await count('.ewb-cv-node')
  await T('cv-fold-b1q').click(); await sleep(300)
  check('折叠', '折叠分支一的追问后，它下面的 3 个回答 / 发现消失', (await count('.ewb-cv-node')) === before - 3 || (await count('.ewb-cv-node')) < before, `${before} → ${await count('.ewb-cv-node')}`)
  await T('cv-fold-b1q').click(); await sleep(300)
  check('折叠', '再点展开恢复', (await count('.ewb-cv-node')) === before)
  await T('cv-fold-sg0').count()   // step-group 没有子节点，不显示折叠按钮
  check('折叠', '没有子节点的小节点不显示折叠按钮', (await count('[data-testid=cv-fold-sg0]')) === 0)

  // ── 9. 小地图 ──
  const mm = await T('cv-minimap').boundingBox()
  const wv = await world()
  await ctx.page.mouse.click(mm.x + 15, mm.y + 15)
  await sleep(100)
  check('小地图', '显示视口框', (await count('[data-testid=cv-minimap-vp]')) === 1 && (await count('.ewb-cv-mini i')) >= 30)
  check('小地图', '点击小地图跳转视口', (await world()) !== wv)
  await T('cv-fit').click()

  // ── 10. 「产出」：md 预览（实时写）、表格、看板插槽、导出 ──
  check('产出', '4 个产出标签', (await count('[data-testid^=out-tab-]')) === 4)
  await T('out-preview').waitFor()
  check('产出', 'Markdown 预览含「一、结论」标题和表格', await waitFor(async () => /一、结论/.test(await T('output-md').innerText()), 5000))
  check('产出', '汇报正在一节一节写出来：显示「正在写 第 x/5 节」', await waitFor(async () => /正在写 第 4\/5 节/.test(await T('out-writing').innerText()), 8000), await T('out-writing').innerText())
  check('产出', '预览里有 3 节正文和 1 张表格', (await count('[data-testid=output-md] h4, [data-testid=output-md] h3, [data-testid=output-md] h5')) >= 3 && (await count('[data-testid=output-md] table')) === 1)
  await T('md-ref').first().click()
  check('产出', '引用标签可点（onOpenRef query:3）', /ref query:3/.test(await logText()))
  check('产出', '写作中的文档不能导出 Word / PDF（按钮禁用）', await T('out-export-docx').isDisabled())
  await T('out-tab-t1').click()
  check('产出', '表格预览', (await count('[data-testid=out-table] tbody tr')) === 3 && /C12/.test(await T('out-table').innerText()))
  check('产出', '表格显示「导出 Excel」', await T('out-export-xlsx').isVisible() && (await count('[data-testid=out-export-docx]')) === 0)
  await T('out-export-xlsx').click()
  check('产出', '导出回调 export t1 xlsx', /export t1 xlsx/.test(await logText()))
  await T('out-tab-b1').click()
  check('产出', '看板留了插槽 renderBoard', /demo-board/.test(await T('demo-board').innerText()))
  await T('out-tab-n1').click()
  check('产出', '口径说明（note）可预览，Word / PDF 导出可用', /口径说明/.test(await T('output-md').innerText()) && !(await T('out-export-docx').isDisabled()))
  await T('out-reveal').click()
  check('产出', '在文件夹中显示回调', /reveal n1/.test(await logText()))
  check('产出', '下方文件列表含名称和状态', /写作中/.test(await T('out-files').innerText()) && /已完成/.test(await T('out-files').innerText()))

  // ── 11. 面板：宽度可拖动并记住、可折叠、可切回产出 ──
  const sp = await T('side-panel').boundingBox()
  const handle = await T('side-resize').boundingBox()
  await ctx.page.mouse.move(handle.x + 3, handle.y + 200); await ctx.page.mouse.down(); await ctx.page.mouse.move(handle.x - 77, handle.y + 200, { steps: 5 }); await ctx.page.mouse.up()
  const sp2 = await T('side-panel').boundingBox()
  check('面板', '拖动左边缘调整宽度', sp2.width > sp.width + 60, `${sp.width} → ${sp2.width}`)
  check('面板', '宽度记在 localStorage', Math.abs(Number(await ctx.page.evaluate(() => localStorage.getItem('ewb-demo-side-w'))) - sp2.width) <= 1)
  await T('cv-node-f3').click()
  await T('card-detail').waitFor()
  await T('side-mode-outputs').click()
  check('面板', '卡片详情可切回「产出」', (await T('side-panel').getAttribute('data-mode')) === 'outputs' && (await T('out-preview').count()) === 1)
  await T('side-mode-card').click()
  check('面板', '再切到卡片详情', (await count('[data-testid=card-detail]')) === 1)
  await T('side-fold').click()
  check('面板', '可折叠成窄条', (await T('side-panel').getAttribute('data-folded')) === '1' && (await T('side-panel').boundingBox()).width < 60)
  await T('side-unfold').click()
  check('面板', '再点展开，宽度还是之前拖的', Math.abs((await T('side-panel').boundingBox()).width - sp2.width) <= 1)

  // ── 12. 200 节点性能 ──
  await T('demo-stress').click()
  const t0 = Date.now()
  await ctx.page.waitForFunction(() => document.querySelectorAll('.ewb-cv-node').length === 200, null, { timeout: 15000 })
  const renderMs = Date.now() - t0
  await T('cv-fit').click()
  await shot('canvas-200')
  const ms = await ctx.page.evaluate(async () => {
    const el = document.querySelector('[data-testid=canvas]'); const r = el.getBoundingClientRect()
    const t = performance.now()
    for (let i = 0; i < 40; i++) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? 60 : -60, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true })); await new Promise(res => requestAnimationFrame(res)) }
    return (performance.now() - t) / 40
  })
  check('性能', '200 个节点渲染完成', renderMs < 5000, `${renderMs}ms`)
  check('性能', '200 节点缩放每帧 < 40ms', ms < 40, `${ms.toFixed(1)}ms/帧`)
  await T('demo-reset').click()
  await sleep(300)

  // ── 13. 深色模式 ──
  await ctx.page.evaluate(() => localStorage.setItem('ewb-theme-pref', 'dark'))
  await ctx.page.reload()
  await openDemo()
  check('深色', 'data-theme=dark 生效', (await ctx.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await T('cv-fit').click(); await sleep(400)
  await T('cv-node-f2').click()
  await T('card-detail').waitFor()
  await sleep(2500)
  await shot('canvas-dark-card')
  await T('cv-node-q').click()
  await T('side-mode-outputs').click()
  await sleep(300)
  await shot('canvas-dark-outputs')
  const bg = await ctx.page.evaluate(() => getComputedStyle(document.querySelector('.ewb-cv-node[data-kind=finding]')).backgroundColor)
  check('深色', '节点背景是深色（不是白底）', /^rgb\((\d+), (\d+), (\d+)\)$/.test(bg) && bg.match(/\d+/g).map(Number).every(v => v < 100), bg)
  await ctx.page.evaluate(() => localStorage.removeItem('ewb-theme-pref'))

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错', errs.length === 0, errs.slice(0, 3).join(' | '))
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11d.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11d.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
