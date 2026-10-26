// M4 E2E（四）：知识点树编辑（界面操作 → 看板 / AI 缓存 / 报告随之变化）、失败卷入口一致（M2 N10）、其它收尾项。
const M = require('./m4-lib.cjs')
const naive = require('./naive.cjs')
const { SPEC } = require('./fixtures-m3.cjs')
const D = require('./m4-phases-data.cjs')
const { root, check, sleep, waitFor, withDb, fs, path, work, SECRET, ctx, T, txt, stat, goto, shot, setFilter, api, cfgFor, saveCfg, waitStat, L } = M

const rev = () => withDb(ctx.ud, d => d.prepare('SELECT rev FROM data_rev').get().rev)
const kpRow = code => withDb(ctx.ud, d => d.prepare('SELECT * FROM kps WHERE code = ?').get(code))
const pickNode = async code => {
  await T('kp-search').locator('input').fill(code)
  await T(`kp-node-${code}`).waitFor({ timeout: 8000 })
  await T(`kp-node-${code}`).click()
  const ok = await waitFor(async () => (await T('kp-selected').count()) > 0 && (await T('kp-selected').getAttribute('data-code')) === code, 5000)
  if (!ok) throw new Error(`没能选中知识点 ${code}：选中的是 ${(await T('kp-selected').getAttribute('data-code').catch(() => null))}；树里的节点：${(await T('kp-tree').innerText().catch(() => '')).slice(0, 200)}`)
}
const popOk = () => ctx.page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
const distNodes = f => api(async f => (await window.api.stats.distribution(f)).nodes.map(n => [n.code, n.name, n.papers, n.questions, n.score]), f)

async function phaseTaxonomy() {
  const { page, mock } = ctx
  await saveCfg(cfgFor(mock), SECRET)
  const scope = { filter: { grade: '4' }, target: 2025, base: 'before', level: 2, align: true }
  const g = await api(sc => window.api.ai.analyzeCompare(sc, crypto.randomUUID()), scope)
  const st0 = await api(sc => window.api.ai.compareAnalysis(sc), scope)
  const reports0 = await api(() => window.api.report.list())
  check('知识点树 缓存', '编辑前：P2 同比分析（四年级）生成并缓存，状态「已缓存」；从数据包带来的 2 份 P3 报告都是「最新」', g.ok && st0.status === 'fresh' && reports0.length === 2 && reports0.every(r => r.status === 'fresh'), `${st0.status} / ${reports0.map(r => r.status)}`)
  await goto('#/settings')
  await T('taxonomy-settings').waitFor()
  // ── 改名（内置节点）──
  const r0 = rev()
  await pickNode('GR.NOUN.PLURAL')
  await T('kp-edit').click()
  await T('kp-modal-name').fill('名词复数（教研组改名）')
  await T('kp-modal-ok').click()
  const renamed = await waitFor(async () => kpRow('GR.NOUN.PLURAL').name === '名词复数（教研组改名）', 8000)
  const uiNew = await waitFor(async () => /名词复数（教研组改名）/.test(await T('kp-node-GR.NOUN.PLURAL').innerText().catch(() => '')), 8000)
  check('知识点树 改名', '内置节点「名词复数」改名：代码 GR.NOUN.PLURAL 不变、仍是内置；界面树上立刻显示新名字', renamed && kpRow('GR.NOUN.PLURAL').builtin === 1 && uiNew)
  check('知识点树 缓存', '改名推高数据修订号，并且让缓存正确失效：P2 分析变"已过期（统计数据…变了）"，两份 P3 报告也都变"已过期"——都不自动重新生成（没有新的 AI 请求）', rev() > r0 && await (async () => {
    mock.resetStats()
    const ok = await waitFor(async () => (await api(sc => window.api.ai.compareAnalysis(sc), scope)).status === 'stale', 15000)
    const s = await api(sc => window.api.ai.compareAnalysis(sc), scope)
    const rl = await api(() => window.api.report.list())
    await sleep(1500)
    return ok && s.staleReasons.includes('data') && rl.every(r => r.status === 'stale' && r.staleReasons.includes('data')) && mock.requests.length === 0
  })())
  await setFilter({ grade: '4' }, '#/dashboard')
  await T('dist-papers').waitFor()
  check('知识点树 看板', '看板（分布页）立刻用新名字：考频里"名词复数（教研组改名）"，旧名字不再出现', await waitFor(async () => /名词复数（教研组改名）/.test(await ctx.page.locator('[data-testid=freq-GR\\.NOUN\\.PLURAL]').innerText().catch(() => '')), 8000) && !/(^|[^（])名词复数(?!（教研组改名）)/.test(await ctx.page.locator('[data-testid=freq-GR\\.NOUN\\.PLURAL]').innerText()))
  await goto('#/settings'); await T('taxonomy-settings').waitFor()

  // ── 内置节点的保护 ──
  await pickNode('GR.TENSE.FUT')
  check('知识点树 内置保护', '选中内置节点「一般将来时」：改名可用；移动、合并、删除按钮都是灰的', !(await T('kp-edit').isDisabled()) && (await T('kp-move').isDisabled()) && (await T('kp-merge').isDisabled()) && (await T('kp-delete').isDisabled()))
  const apiTry = async ops => api(async o => { try { await window.api.taxonomy.save(o); return 'ok' } catch (e) { return e.message } }, ops)
  check('知识点树 内置保护', '绕过界面直接调接口也不行：移动 / 合并掉 / 删除内置节点都被主进程拒绝，写明"内置知识点"', (await apiTry([{ op: 'move', code: 'FN.SHOP', parent_code: 'GR' }])).match(/内置知识点，只能改名，不能移动/) && (await apiTry([{ op: 'merge', code: 'FN.SHOP', into: 'FN.DIR' }])).match(/不能合并掉/) && (await apiTry([{ op: 'delete', code: 'FN.SHOP' }])).match(/内置知识点，不能删除/) && kpRow('FN.SHOP').parent_code === 'FN')
  check('知识点树 校验', '接口参数用 zod 校验：未知操作 / 缺字段 / 代码带 SQL → 被拒绝，库不变', (await apiTry([{ op: 'drop', code: 'X' }])).length > 0 && (await apiTry([{ op: 'update', code: "FN.SHOP'; DROP TABLE kps;--", name: 'x' }])).length > 0 && (await apiTry([])).length > 0 && withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM kps').get().c) > 100)

  // ── 新增自建节点，把两道题改标到它，再合并到内置节点 ──
  await pickNode('GR.NOUN')
  await T('kp-add-child').click()
  await T('kp-modal-name').fill('名词补充（自建）')
  await T('kp-modal-ok').click()
  const added = await waitFor(async () => !!kpRow('GR.NOUN.U1'), 8000)
  const u1 = added ? kpRow('GR.NOUN.U1') : null
  check('知识点树 新增', '在「名词」下新增自建子节点：自动编号 GR.NOUN.U1、二级、自建（builtin=0）；界面树上出现并带"自建"标记', added && u1.parent_code === 'GR.NOUN' && u1.level === 2 && u1.builtin === 0 && u1.name === '名词补充（自建）' && (await T('kp-node-GR.NOUN.U1').getAttribute('data-builtin')) === '0')
  await shot('16-taxonomy-added')
  // 把 A3 第 2 题、B1 第 1 题（原来都是规则复数 GR.NOUN.PLURAL.REG）改标到新节点，并重新确认这两份卷子
  const mut = [['A3', 1], ['B1', 0]]
  for (const [pk, qi] of mut) {
    const qid = ctx.qids[`${pk}Q${qi + 1}`]
    await api(([q]) => window.api.questions.update(q, { kp_main: 'GR.NOUN.U1' }), [qid])
    await api(([p]) => window.api.questions.confirmPaper(p, true), [ctx.ids[pk]])
  }
  // 期望值：逐条循环重算（把夹具里这两道题的主知识点换成新节点）
  const specKp = (pk, qi, kp) => { const p = SPEC.find(x => x.key === pk); const old = p.q[qi].kp; p.q[qi].kp = kp; return old }
  const olds = mut.map(([pk, qi]) => specKp(pk, qi, 'GR.NOUN.U1'))
  const rows = () => withDb(ctx.ud, d => d.prepare('SELECT code, parent_code, level, name FROM kps').all())
  let tree = naive.makeTree(rows())
  let tbl = naive.nodeTable(tree, naive.counted({ grade: '4' }))
  const nodeOf = (nodes, code) => nodes.find(n => n[0] === code)
  let nodes = await distNodes({ grade: '4' })
  const eq = (code) => { const e = tbl.get(code); const n = nodeOf(nodes, code); return !!e && !!n && n[2] === e.papers.size && n[3] === e.qs.size && n[4] === e.primScore }
  check('知识点树 看板', '把 2 道题改标到新节点后：新节点出现 2 份卷子 / 2 题；规则复数、名词复数、名词的数字都 = 逐条循环重算（规则复数少了这 2 题）', nodeOf(nodes, 'GR.NOUN.U1')?.[2] === 2 && nodeOf(nodes, 'GR.NOUN.U1')?.[3] === 2 && ['GR.NOUN.U1', 'GR.NOUN.PLURAL.REG', 'GR.NOUN.PLURAL', 'GR.NOUN'].every(eq), JSON.stringify(['GR.NOUN.U1', 'GR.NOUN.PLURAL.REG', 'GR.NOUN.PLURAL', 'GR.NOUN'].map(c => nodeOf(nodes, c))))
  const r1 = rev()
  // 界面合并：新节点 → 名词复数（内置，二级）
  await goto('#/settings'); await T('taxonomy-settings').waitFor()
  await pickNode('GR.NOUN.U1')
  await T('kp-merge').click()
  await T('kp-modal-target').click()
  await page.keyboard.type('GR.NOUN.PLURAL）')
  await page.locator('.ant-select-tree-title', { hasText: 'GR.NOUN.PLURAL）' }).first().click()
  await shot('17-taxonomy-merge')
  await T('kp-modal-ok').click()
  const merged = await waitFor(async () => kpRow('GR.NOUN.U1').merged_into === 'GR.NOUN.PLURAL', 8000)
  // 期望：这两道题的主知识点现在是 GR.NOUN.PLURAL（二级）；新节点不再出现在统计里
  mut.forEach(([pk, qi]) => specKp(pk, qi, 'GR.NOUN.PLURAL'))
  tree = naive.makeTree(rows())
  tbl = naive.nodeTable(tree, naive.counted({ grade: '4' }))
  nodes = await distNodes({ grade: '4' })
  const qk = withDb(ctx.ud, d => d.prepare("SELECT kp_code, is_primary FROM question_kps WHERE question_id IN (?, ?)").all(ctx.qids.A3Q2, ctx.qids.B1Q1))
  check('知识点树 合并', '界面合并：题目关联迁到目标节点（这两道题的标注 = GR.NOUN.PLURAL 主知识点）；被合并的节点停用并记下去向', merged && qk.length === 2 && qk.every(k => k.kp_code === 'GR.NOUN.PLURAL' && k.is_primary === 1) && kpRow('GR.NOUN.U1').deprecated === 1)
  check('知识点树 合并', '合并后看板数字 = 逐条循环重算：新节点从统计里消失；名词复数 / 规则复数 / 名词 的出现份数、题数、分值都对（同一份卷子不重复计数）', !nodeOf(nodes, 'GR.NOUN.U1') && ['GR.NOUN.PLURAL.REG', 'GR.NOUN.PLURAL', 'GR.NOUN'].every(eq), JSON.stringify(['GR.NOUN.PLURAL.REG', 'GR.NOUN.PLURAL', 'GR.NOUN'].map(c => nodeOf(nodes, c))))
  check('知识点树 缓存', '合并同样推高修订号', rev() > r1)
  await shot('18-taxonomy-merged')
  mut.forEach(([pk, qi], i) => specKp(pk, qi, olds[i]))   // 还原夹具（后面的断言不受影响）
  // 看板界面上的数字（考频柱）也一致
  await setFilter({ grade: '4' }, '#/dashboard')
  await T('dist-papers').waitFor()
  const uiPapers = await waitFor(async () => Number(await ctx.page.locator('[data-testid=freq-GR\\.NOUN\\.PLURAL]').getAttribute('data-papers').catch(() => -1)), 8000)
  check('知识点树 看板', '看板考频柱里"名词复数（教研组改名）"的出现份数 = 接口返回值；新节点不在考频里', uiPapers === nodeOf(nodes, 'GR.NOUN.PLURAL')[2] && (await ctx.page.locator('[data-testid=freq-GR\\.NOUN\\.U1]').count()) === 0)
  // ── 停用 / 启用内置节点：不再提供给选择器和 AI，但统计照常 ──
  await goto('#/settings'); await T('taxonomy-settings').waitFor()
  await pickNode('GR.TENSE.FUT')
  await T('kp-deprecate').click()
  await popOk()
  const dep = await waitFor(async () => kpRow('GR.TENSE.FUT').deprecated === 1, 8000)
  const visible = await api(() => window.api.taxonomy.tree())
  const all = await api(() => window.api.taxonomy.tree({ includeDeprecated: true }))
  const stillCounted = (await distNodes({ grade: '4' })).some(n => n[0] === 'GR.TENSE.FUT')
  check('知识点树 停用', '停用内置节点「一般将来时」：它和子节点不再出现在默认的树里（选择器 / AI 提示词用的）；设置页的编辑器仍能看到；看板统计照常包含它（已有标注保留）', dep && !visible.kps.some(k => k.code.startsWith('GR.TENSE.FUT')) && all.kps.some(k => k.code === 'GR.TENSE.FUT.GOING') && stillCounted && kpRow('GR.TENSE.FUT.GOING').deprecated === 1)
  await T('kp-enable').click()
  const enabled = await waitFor(async () => kpRow('GR.TENSE.FUT').deprecated === 0, 8000)
  check('知识点树 停用', '重新启用：恢复；（子节点要各自再启用，避免一次误操作全部恢复）', enabled)
  await shot('19-taxonomy')
}

// ───────── 阶段 7：失败卷的入口一致（M2 N10）+ 其它收尾 ─────────
async function phaseMisc() {
  const { page, mock } = ctx
  // N10：试卷库与处理队列里，同一份失败的卷子给的重试入口完全一致
  await goto('#/')
  await T('dropzone').waitFor()
  const libRow = async name => ctx.page.locator('tr', { hasText: name })
  await waitFor(async () => (await ctx.page.locator('tr', { hasText: 'F1' }).count()) > 0, 8000)
  const lib = async (title) => { const r = ctx.page.locator('tr', { hasText: title }).first(); return { parse: await r.locator('[data-testid=retry-parse]').count(), menu: await r.locator('[data-testid=retry-menu]').count(), extract: await r.locator('[data-testid=retry-extract]').count() } }
  let F1 = null, I1 = null
  for (const pg of [1, 2]) {
    await page.locator(`.ant-pagination-item-${pg}`).click().catch(() => {})
    await sleep(300)
    const rowsOnPage = await page.locator('tbody tr').evaluateAll(trs => trs.map(tr => ({ text: tr.innerText, parse: tr.querySelectorAll('[data-testid=retry-parse]').length, menu: tr.querySelectorAll('[data-testid=retry-menu]').length, extract: tr.querySelectorAll('[data-testid=retry-extract]').length, legacy: tr.querySelectorAll('[data-testid=reprocess]').length })))
    F1 ||= rowsOnPage.find(r => /失败/.test(r.text) && r.parse === 1)
    I1 ||= rowsOnPage.find(r => /失败/.test(r.text) && r.extract === 1)
  }
  check('N10 失败卷入口', '试卷库里：AI 解析失败的卷子（F1）有「重试 AI 解析」+ 下拉；提取失败 / 被导入时标成失败的卷子（I1）有「重试（重新提取）」——不再只有一个"重新提取"', !!F1 && F1.menu === 1 && F1.legacy === 0 && !!I1 && I1.legacy === 0, JSON.stringify({ F1: !!F1, I1: !!I1 }))
  await goto('#/queue')
  await page.getByText(/需处理/).first().click()
  await waitFor(async () => (await page.locator('tbody tr').count()) > 0, 8000)
  const q = await page.locator('tbody tr').evaluateAll(trs => trs.map(tr => ({ text: tr.innerText, parse: tr.querySelectorAll('[data-testid=retry-parse]').length, menu: tr.querySelectorAll('[data-testid=retry-menu]').length, extract: tr.querySelectorAll('[data-testid=retry-extract]').length })))
  const qF1 = q.find(r => r.parse === 1), qI1 = q.find(r => r.extract === 1)
  check('N10 失败卷入口', '处理队列里同样：F1 的入口 = 「重试 AI 解析」+ 下拉，I1 = 「重试（重新提取）」——两个页面入口一致（同一个组件）', !!qF1 && qF1.menu === 1 && !!qI1)
  const menuItems = async (scopeSel) => {
    await page.locator(`${scopeSel} [data-testid=retry-menu]`).first().click()
    const items = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').allInnerTexts()
    await page.keyboard.press('Escape')
    return items
  }
  const queueItems = await menuItems('tbody tr:has([data-testid=retry-menu])')
  await goto('#/')
  await T('dropzone').waitFor()
  await page.locator('.ant-pagination-item-1').click().catch(() => {})
  let libItems = []
  for (const pg of [1, 2]) {
    if (pg === 2) await page.locator('.ant-pagination-item-2').click().catch(() => {})
    if (await page.locator('tbody tr:has([data-testid=retry-menu])').count()) { libItems = await menuItems('tbody tr:has([data-testid=retry-menu])'); break }
  }
  check('N10 失败卷入口', '下拉里的选项两处一致：重新 AI 解析 / 仅重新定位 / 从头重试', JSON.stringify(libItems) === JSON.stringify(queueItems) && libItems.length === 3 && /从头重试/.test(libItems[2]), JSON.stringify(libItems))
  // 审核徽标（M2 缺口）：B 里有 2 份待审核（R1、K1）→ 侧栏"审核"旁显示 2
  const badge = await waitFor(async () => (await page.locator('[data-testid=badge-review]').count()) > 0, 8000)
  const nRev = withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM papers WHERE status = 'reviewing'").get().c)
  check('审核徽标（M2 缺口）', '侧栏"审核"旁的徽标数字 = 待审核卷子数', badge && Number((await page.locator('[data-testid=badge-review]').innerText()).trim()) === nRev && nRev >= 2, `${nRev}`)
  // 关于页 / 安装指南入口
  await goto('#/settings')
  await T('about-card').waitFor()
  await waitFor(async () => (await txt('about-version')).includes(require('../../package.json').version), 8000)
  const ver = await txt('about-card')
  check('设置 关于', '关于卡片：版本号读自 package.json、数据库版本 v9、运行环境（系统 / Electron / Chromium / Node）、数据目录', new RegExp('版本\\s*' + require('../../package.json').version.replace(/\./g, '\\.')).test(ver) && /数据库版本 v9/.test(ver) && !/M[1-5]|里程碑/.test(ver) && /Electron 45/.test(await txt('about-env')) && /darwin|win32|linux/.test(await txt('about-env')))
  await shot('20-settings-about')
  await T('open-guide').click()
  // M5：安装指南页换成完整正文（和 docs/安装指南.md 是同一份文件，构建时内联）
  const guideSrc = fs.readFileSync(path.join(root, 'docs/安装指南.md'), 'utf8')
  const guideOpened = await waitFor(async () => (await T('guide-page').count()) > 0, 5000)
  const guideText = guideOpened ? await txt('guide-body') : ''
  const heads = [...guideSrc.matchAll(/^## (.+)$/gm)].map(m => m[1])
  check('设置 安装指南入口', '「查看安装指南」→ 安装指南页显示完整正文：和 docs/安装指南.md 的每个二级标题、几个关键句一一对上（不再是占位）', guideOpened && heads.length >= 9 && heads.every(h => guideText.includes(h)) && /仍要运行/.test(guideText) && /仍要打开/.test(guideText) && /光学字符识别/.test(guideText) && /DeepSeek/.test(guideText) && !/M5/.test(guideText) && !/\*\*|```/.test(guideText), `${heads.length} 个标题；${guideText.length} 字`)
  await shot('20b-guide')
  // 设置页各卡片都在
  await goto('#/settings')
  await T('about-card').waitFor()
  const cards = await Promise.all(['data-storage', 'data-pack', 'data-sample', 'ai-settings', 'taxonomy-settings', 'about-card'].map(async id => (await T(id).count()) === 1))
  check('设置页', '设置页六块都在：数据存储、数据包、示例数据、AI 服务、知识点树、关于', cards.every(Boolean), JSON.stringify(cards))
  // P2：重复点击生成（M3 缺口）——同一范围正在生成时再发起被拒绝
  const scope = { filter: { grade: '5' }, target: 2025, base: 'before', level: 2, align: true }
  mock.p2DelayMs = 200
  mock.resetStats()
  const first = api(sc => window.api.ai.analyzeCompare(sc, crypto.randomUUID()), scope)
  await sleep(500)
  const second = await api(sc => window.api.ai.analyzeCompare(sc, crypto.randomUUID()), scope)
  const r1 = await first
  mock.p2DelayMs = 0
  check('P2 重复生成（M3 缺口）', '同一个同比范围正在生成时再发起一次 → 被拒绝（busy），只发了 1 次模型请求', second.ok === false && second.code === 'busy' && r1.ok === true && mock.p2Requests.length === 1, JSON.stringify([second.code, mock.p2Requests.length]))
  // 控制台没有未处理的错误；密钥没有泄漏到主进程输出
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|net::ERR|favicon|ResizeObserver/i.test(e))
  check('收尾', '页面控制台没有错误（排除资源加载噪声）', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 300))
  check('收尾', '主进程输出里没有出现 API 密钥', !L.procOutput.join('').includes(SECRET))
}

module.exports = { phaseTaxonomy, phaseMisc }
