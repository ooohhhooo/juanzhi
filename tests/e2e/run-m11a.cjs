// 内置助手（Agent 内核）端到端：打开助手页 → 选运营角色 → 点推荐问题 → 先出计划（暂停、确认）→ 计划清单 / 工具步骤 / ask_user 按钮 /
// 最终回答和可点击引用（假引用被去掉）→ 停止按钮可用 → 历史会话可回看 → 从回答「从这里追问」形成分支 → 模型不支持工具调用时的说明 → 自定义角色 → 机构说明。
// 全程 mock AI（tests/mock-ai/agent.cjs 按关键字返回预设的工具调用序列）。
// 用法：npm run test:e2e:m11a   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, shot, L, stubOpen } = M

const firstAgentReq = () => mock0.agentRequests.find(r => !r.toolNames.includes('ping'))
let mock0
const q = (sql, ...p) => withDb(ctx.ud, d => d.prepare(sql).all(...p))
const count = async id => T(id).count()
const typeAndSend = async text => { await T('assistant-input').fill(text); await T('assistant-send').click() }

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock; mock0 = mock
  const ud = path.join(work, 'userM11a')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)

  // ── 0. 没配置 AI：直接说明，不硬跑 ──
  await goto('#/assistant'); await T('assistant-page').waitFor()
  check('入口', '侧栏有「助手」，排在第一个，点进去是 /assistant', (await ctx.page.locator('.ewb-contents__link').first().getAttribute('aria-label')) === '助手' && (await ctx.page.evaluate(() => location.hash)) === '#/assistant')
  check('没配置', '没有设置 AI 服务：页面顶部说明并给「去设置」，输入框不可用', await waitFor(async () => (await count('assistant-noconfig')) === 1, 8000) && await T('assistant-input').isDisabled())
  check('角色', '默认两个内置角色：运营、辅导老师（教研、授课老师先占位不显示）', (await txt('assistant-role-ops')) === '运营' && (await txt('assistant-role-tutor')) === '辅导老师' && (await count('assistant-role-research')) === 0)

  const cfg = cfgFor(mock, { auto_parse: false })
  await saveCfg(cfg, SECRET)
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()
  check('配置后', '配置好 AI 服务后说明消失，输入框可用', await waitFor(async () => (await count('assistant-noconfig')) === 0 && !(await T('assistant-input').isDisabled()), 8000))

  // ── 1. 空状态 + 推荐问题 + 默认「先出计划」模式 ──
  check('空状态', '大标题「今天要做什么？」、数据只在本机的说明、4 张推荐问题卡片（运营）', /今天要做什么/.test(await txt('assistant-empty')) && /不会发给 AI/.test(await txt('assistant-empty')) && (await ctx.page.locator('[data-testid^=assistant-suggest-]').count()) === 4)
  check('输入框', '输入框是一张卡片：上面输入区（占位提示）、下面一行：＋、审批标签、运行模式标签、模型与思考强度按钮、发送', /描述你要分析什么/.test(await T('assistant-input').getAttribute('placeholder')) && (await count('assistant-plus')) === 1 && (await count('assistant-approval-tag')) === 1 && (await count('assistant-mode')) === 1 && (await count('assistant-model-btn')) === 1 && (await count('assistant-send')) === 1)
  check('模式', '运行模式默认「先出计划」；审批默认「只问对外发送」；模型按钮显示「模型名 · 自动」', /先出计划/.test(await txt('assistant-mode')) && /只问对外发送/.test(await txt('assistant-approval-tag')) && /mock-text-model · 自动/.test(await txt('assistant-model-btn')))
  await shot('assistant-composer')
  // 「＋」菜单
  await T('assistant-plus').click()
  check('＋菜单', '＋菜单：添加数据文件…、选择已有数据集（数据功能已接入，不再置灰）、使用 Skill…、产出为…', (await count('assistant-plus-add')) === 1 && (await count('assistant-plus-dataset')) === 1 && (await count('assistant-plus-playbook')) === 1 && (await count('assistant-plus-output')) === 1 && (await ctx.page.locator('.ant-dropdown-menu-item-disabled').count()) === 0)
  await ctx.page.locator('.ant-dropdown [data-testid=assistant-plus-output]').hover()
  await ctx.page.locator('[data-testid=assistant-plus-output-item]', { hasText: 'Excel 表' }).click()
  check('＋菜单', '选「产出为 Excel 表」：以小标签出现在输入框上方，可删除', (await T('assistant-chip').count()) === 1 && /产出 · Excel 表/.test(await txt('assistant-chip')))
  await T('assistant-chip-remove').click()
  check('＋菜单', '点标签上的 × 删除', (await count('assistant-chip')) === 0)
  // @ 提及
  await T('assistant-input').fill('请按 @学情')
  check('@提及', '输入框里打 @ 弹出可搜索列表（分组：Skill……），列出「学情周报」', await waitFor(async () => (await count('assistant-mention-list')) === 1, 5000) && /学情周报/.test(await txt('assistant-mention-list')))
  await T('assistant-mention-item').first().click()
  check('@提及', '选中后变成标签，输入框里的 @ 文字被去掉', (await T('assistant-chip').count()) === 1 && /Skill · 学情周报/.test(await txt('assistant-chip')) && !(await T('assistant-input').inputValue()).includes('@'))
  await T('assistant-chip-remove').click(); await T('assistant-input').fill('')
  // 审批标签
  await T('assistant-approval-tag').click()
  await ctx.page.locator('.ant-dropdown [data-testid=assistant-approval-ask-all]').click()
  check('审批模式', '审批标签可切换，只有「每次询问 / 只问对外发送」两档（没有「完全不问」）', /每次询问/.test(await txt('assistant-approval-tag')) && (await ctx.page.locator('[data-testid^=assistant-approval-ask-]').count()) <= 2)
  await T('assistant-approval-tag').click()
  check('审批模式', '菜单里只有两项', (await ctx.page.locator('.ant-dropdown [data-testid^=assistant-approval-ask-]').count()) === 2)
  await ctx.page.locator('.ant-dropdown [data-testid=assistant-approval-ask-external]').click()
  await shot('assistant-empty')

  // 点推荐问题「帮我做一份学情周报」
  // 推荐问题现在面向数据分析；这里走学情周报剧本（试卷数据），直接输入
  await typeAndSend('帮我做一份学情周报')
  check('先出计划', '先出现计划清单，然后暂停：显示「按这个做 / 修改计划」，还没有跑查询工具', await waitFor(async () => (await count('assistant-plan-go')) === 1, 20000) && (await count('assistant-plan')) === 1 && (await T('assistant-plan-item').count()) === 3 && (await count('assistant-tool')) === 0)
  check('先出计划', '暂停期间只有「写计划」那一次请求；停止按钮可用，用量条显示第 1 轮和 token', (await count('assistant-stop')) === 1 && /第 1 轮/.test(await txt('assistant-meter')) && /token/.test(await txt('assistant-meter')))
  const reqsBefore = mock.agentRequests.length
  check('先出计划', '计划阶段发给模型的工具清单里没有 kp_questions / course_for_kp（程序层面禁用，不靠提示词）', !firstAgentReq().toolNames.includes('kp_questions') && firstAgentReq().toolNames.includes('update_plan') && firstAgentReq().toolNames.includes('stats_overview'), firstAgentReq().toolNames.join(','))
  await shot('assistant-plan-review')
  // 先给修改意见
  await T('assistant-plan-feedback').fill('只看已审核的试卷')
  await T('assistant-plan-revise').click()
  check('修改计划', '给了修改意见：模型收到意见并重新出计划（仍在等确认）', await waitFor(async () => mock.agentRequests.length > reqsBefore && /用户想修改计划：只看已审核的试卷/.test(JSON.stringify(mock.agentRequests.at(-1).messages)), 15000))
  await sleep(300)
  // 确认
  await waitFor(async () => (await count('assistant-plan-go')) === 1, 20000)
  await T('assistant-plan-go').click()
  // ask_user
  check('ask_user', '确认后模型向用户提问：显示问题和选项按钮', await waitFor(async () => (await count('assistant-ask')) === 1 && (await count('assistant-ask-opt-0')) === 1, 30000) && /周报要看哪个范围/.test(await txt('assistant-ask')))
  await shot('assistant-ask')
  await T('assistant-ask-opt-0').click()
  check('ask_user', '点选项后继续：问题处显示「你选了：全部年级」', await waitFor(async () => (await count('assistant-ask-answer')) >= 1 && /你选了：全部年级/.test(await txt('assistant-ask-answer')), 20000))
  // 最终回答
  check('最终回答', '出现最终回答（Markdown 表格 + 加粗结论）', await waitFor(async () => (await count('assistant-answer')) === 1, 60000) && /学情周报/.test(await txt('assistant-answer')) && (await T('assistant-md').locator('table').count()) === 1)
  check('工具步骤', '工具步骤默认折叠成单行（看整体情况 / 查考这个知识点的题），展开能看参数和结果摘要', (await T('assistant-tool').count()) >= 2 && await (async () => {
    const t = T('assistant-tool').first()
    const closed = !(await t.getAttribute('open') !== null)
    await t.locator('summary').click()
    return closed && /查询条件/.test(await t.innerText()) && /返回结果/.test(await t.innerText()) && (await t.locator('[data-testid=assistant-tool-result]').innerText()).includes('最常考的知识点')
  })())
  check('计划', '计划清单最后全部更新（已完成的划掉），整段对话里只显示一份计划', (await count('assistant-plan')) === 1 && (await T('assistant-plan-item').count()) >= 3)
  const toolNames = await ctx.page.locator('[data-testid=assistant-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-name')))
  check('多工具并行', '一轮里同时调用两个工具（更新计划 + 看整体情况）都执行了；查题工具在确认之后才跑', toolNames.includes('stats_overview') && toolNames.includes('kp_questions') && toolNames.indexOf('stats_overview') < toolNames.indexOf('kp_questions'))
  // 引用
  const chips = T('assistant-cite')
  check('引用', '回答里的真实题目引用渲染成浅紫小标签（可点击），假引用被程序去掉并在末尾注明', (await chips.count()) === 1 && /题 · /.test(await chips.first().innerText()) && !(await txt('assistant-answer')).includes('not-a-real-id') && /有 1 处引用对不上，已去掉/.test(await txt('assistant-answer')))
  await shot('assistant-answer')
  const qid = await chips.first().getAttribute('data-id')
  await chips.first().click()
  check('引用跳转', '点引用标签：跳到该题所在试卷的审核页（并选中这道题）', await waitFor(async () => (await ctx.page.evaluate(() => location.hash)).startsWith('#/review/') && (await ctx.page.evaluate(() => location.hash)).includes('q=' + qid), 8000))
  await goto('#/assistant'); await T('assistant-page').waitFor()

  // ── 2. 数据库记录 ──
  const sess = q('SELECT * FROM agent_sessions')
  check('记录', 'agent_sessions 有 1 个会话（运营、标题取自第一句、状态空闲、带 data_rev）', sess.length === 1 && sess[0].role === 'ops' && /学情周报/.test(sess[0].title) && sess[0].status === 'idle' && sess[0].data_rev !== null, JSON.stringify(sess[0]))
  const kinds = q('SELECT kind FROM agent_steps WHERE session_id = ? ORDER BY seq', sess[0].id).map(r => r.kind)
  check('记录', 'agent_steps 记下了 user / plan / tool_call / tool_result / ask / answer 各步骤，answer 里有模型和强度', ['user', 'plan', 'tool_call', 'tool_result', 'ask', 'answer'].every(k => kinds.includes(k)) && /"model":"mock-text-model"/.test(q("SELECT payload_json p FROM agent_steps WHERE kind = 'answer'")[0].p))
  const usage = q("SELECT COUNT(*) c, SUM(prompt_tokens) p FROM ai_usage WHERE kind = 'agent'")[0]
  check('用量', 'ai_usage 里记了助手的调用（kind = agent），有 token', usage.c >= 5 && usage.p > 0, JSON.stringify(usage))
  check('工具支持', '检测结果按 服务地址+模型 缓存在 settings 里', q("SELECT key FROM settings WHERE key LIKE 'agent_tool_support:%'").length === 1)

  // ── 3. 历史会话可回看 ──
  await T('assistant-new').click()
  check('历史', '左侧有历史会话（带角色和时间），点「新对话」回到空状态', (await count('assistant-history-item')) === 1 && (await count('assistant-empty')) === 1)
  await T('assistant-history-item').first().click()
  check('历史', '点历史会话：完整回放（提问、计划、工具步骤、回答、引用标签）', await waitFor(async () => (await count('assistant-answer')) === 1 && (await T('assistant-tool').count()) >= 2 && (await count('assistant-cite')) === 1 && (await count('assistant-user')) === 1, 8000))

  // ── 4. 数据变化后打开旧回答提示「数据已更新」 ──
  check('数据版本', '数据没变时不提示「数据已更新」', (await count('assistant-stale')) === 0)
  await ctx.page.evaluate(async () => { await window.api.papers.list() })
  withDbWrite()
  await sleep(300)
  await T('assistant-new').click(); await T('assistant-history-item').first().click()
  check('数据版本', '试卷数据变了以后再打开旧回答：顶部提示「数据已更新」，历史列表里也有标记', await waitFor(async () => (await count('assistant-stale')) === 1, 8000) && (await count('assistant-history-stale')) === 1, JSON.stringify({ rev: q('SELECT rev FROM data_rev')[0], sess: q('SELECT data_rev FROM agent_sessions')[0], stale: await count('assistant-stale') }))

  // ── 5. 继续追问（在旧会话里） + 分支 ──
  // 切到「直接回答」模式
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()
  await typeAndSend('再说一句总结')
  check('追问', '在旧会话里接着追问：同一个会话里多了一轮，回答出现；直接回答模式没有计划暂停', await waitFor(async () => (await count('assistant-answer')) === 2, 40000) && q('SELECT COUNT(*) c FROM agent_sessions')[0].c === 1 && (await count('assistant-plan-go')) === 0)
  const last = mock.agentRequests.at(-1)
  check('追问', '追问时历史带上了以前的问答，但没有带工具中间过程', JSON.stringify(last.messages).includes('学情周报') && !last.messages.some(m => m.role === 'tool'))
  check('直接回答', '直接回答模式发给模型的工具清单里没有 update_plan', !last.toolNames.includes('update_plan'))
  // 从第一条回答「从这里追问」
  const firstAnswer = ctx.page.locator('[data-testid=assistant-answer]').first()
  await firstAnswer.locator('[data-testid=assistant-fork]').click()
  check('分支', '点回答右上角「从这里追问」：输入框上方出现分支提示，对话只剩到这条回答为止的内容', (await count('assistant-forkbar')) === 1 && (await count('assistant-answer')) === 1)
  await typeAndSend('分支里问一句')
  check('分支', '在分支里发问后：顶部显示「当前在分支」，可回到主线；兄弟分支的内容（再说一句总结）不显示', await waitFor(async () => (await count('assistant-branch')) === 1 && (await count('assistant-answer')) === 2, 40000) && !(await txt('assistant-flow')).includes('再说一句总结'))
  const bReq = mock.agentRequests.at(-1)
  check('分支上下文', '分支的上下文只有路径上的问答：有第一轮的问题和回答、没有主线上的第二轮', JSON.stringify(bReq.messages).includes('学情周报') && !JSON.stringify(bReq.messages).includes('再说一句总结'))
  const br = q('SELECT DISTINCT branch_id FROM agent_steps').map(r => r.branch_id)
  check('分支记录', 'agent_steps 里有 main 和一个分支，分支第一步的 parent_id 指向那条回答', br.length === 2 && br.includes('main') && q("SELECT parent_id FROM agent_steps WHERE branch_id != 'main' ORDER BY seq LIMIT 1")[0].parent_id === q("SELECT seq FROM agent_steps WHERE kind = 'answer' AND branch_id = 'main' ORDER BY seq LIMIT 1")[0].seq)
  await T('assistant-branch-main').click()
  check('分支', '点「回到主线」：分支提示消失，主线的内容回来', await waitFor(async () => (await count('assistant-branch')) === 0 && /再说一句总结/.test(await txt('assistant-flow')), 8000))

  // ── 6. 停止按钮 ──
  await T('assistant-new').click()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-auto]').click()
  await typeAndSend('请慢慢回答')
  check('停止', '回答进行中：停止按钮可用，已经能看到逐步显示的文字', await waitFor(async () => (await count('assistant-stop')) === 1 && (await count('assistant-live')) === 1, 20000))
  await T('assistant-stop').click()
  check('停止', '点停止：很快结束，给出「到目前为止的结果」，停止按钮消失，输入框恢复', await waitFor(async () => (await count('assistant-stop')) === 0 && (await count('assistant-answer')) === 1, 15000) && /已停止/.test(await txt('assistant-answer')) && /到目前为止的结果/.test(await txt('assistant-answer')))
  check('停止', '这一轮在库里记为 stopped 的回答', q("SELECT payload_json p FROM agent_steps WHERE kind = 'answer' ORDER BY rowid DESC LIMIT 1")[0].p.includes('"stop":"stopped"'))

  // ── 7. 卡住检测 ──
  await T('assistant-new').click()
  await typeAndSend('请一直卡住')
  check('卡住', '模型连续重复同一个查询：自动停止并说明', await waitFor(async () => (await count('assistant-answer')) === 1, 40000) && /重复同一个查询/.test(await txt('assistant-answer')))

  // ── 8. 模型：下拉里列出设置里的模型；思考强度；不支持工具调用时直说 ──
  await T('assistant-new').click()
  await T('assistant-model-btn').click(); await T('assistant-modelpop').waitFor()
  await T('assistant-model-name').click()
  const optTexts = await T('assistant-model-list').innerText()
  check('模型选择', '点模型名展开列表：有设置里配置的模型（带用途）和「其他模型」输入', /mock-text-model/.test(optTexts) && (await count('assistant-model-other')) === 1, optTexts)
  const marks = await T('assistant-effort-slider').locator('.ant-slider-mark-text').allInnerTexts()
  check('思考强度', '分档滑块：自动 / 关 / 低 / 中 / 高，顶部显示当前强度名', ['自动', '关', '低', '中', '高'].every(x => marks.includes(x)) && (await txt('assistant-effort-name')) === '自动', marks.join('|'))
  await T('assistant-effort-slider').locator('.ant-slider-mark-text', { hasText: '高' }).click()
  check('思考强度', '点「高」档：顶部强度名变成「高」，提示越高越慢、用量越大', await waitFor(async () => (await txt('assistant-effort-name')) === '高', 5000) && /越慢、用量越大/.test(await txt('assistant-effort-hint')))
  await T('assistant-model-reset').click()
  check('思考强度', '右上角「恢复默认」：回到「自动」和主模型', await waitFor(async () => (await txt('assistant-effort-name')) === '自动', 5000))
  await T('assistant-effort-slider').locator('.ant-slider-mark-text', { hasText: '高' }).click()
  await ctx.page.keyboard.press('Escape'); await T('assistant-modelpop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()
  await typeAndSend('用高强度问一句')
  await waitFor(async () => (await count('assistant-answer')) === 1, 40000)
  check('思考强度', '选「高」：请求里带了 reasoning_effort=high；这一轮用的模型和强度记在步骤里', mock.agentRequests.some(r => r.body_effort === 'high') && /"effort":"high"/.test(q("SELECT payload_json p FROM agent_steps WHERE kind = 'user' ORDER BY rowid DESC LIMIT 1")[0].p))
  // 换一个服务不认的模型名：工具调用不支持
  mock.agentNoTools = true
  const cfg2 = { ...cfg, model: 'mock-no-tools-model' }
  await saveCfg(cfg2)
  await T('assistant-new').click()
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()
  await typeAndSend('这个模型能用吗')
  check('不支持工具调用', '模型不支持工具调用：直接说明并建议换模型，不硬跑（给「去换模型 / 重新检测」）', await waitFor(async () => (await count('assistant-error-notools')) === 1, 30000) && /不支持/.test(await txt('assistant-error-notools')) && /换/.test(await txt('assistant-error-notools')))
  check('不支持工具调用', '结果缓存后，页面顶部也提示当前模型不能用于助手，且不再发请求', await waitFor(async () => (await count('assistant-notools')) === 1, 8000))
  const n0 = mock.agentRequests.length
  await T('assistant-new').click(); await typeAndSend('再试一次')
  await sleep(1500)
  check('不支持工具调用', '再问一次：直接回复说明，不再向模型发请求（已缓存）', mock.agentRequests.length === n0 && (await count('assistant-error-notools')) >= 1)
  mock.agentNoTools = false
  await saveCfg(cfg)

  // ── 9. 自定义角色：新建 → 使用 → 导出 / 导入 → 删除 ──
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-settings-open').click(); await T('assistant-role-new').click(); await T('role-modal').waitFor()
  await T('role-name').fill('续费跟进'); await T('role-desc').fill('关心续费，说话简短。')
  await ctx.page.locator('[data-testid=role-tools] label', { hasText: '看整体情况' }).click()
  await T('role-suggest').fill('今年哪些知识点最难？\n哪些课最该补？')
  await T('role-save').click()
  check('自定义角色', '保存后角色出现在角色切换里，文件存在数据目录 agent-roles/ 下', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-role-c-]').count()) === 1, 8000)
    && fs.readdirSync(path.join(ud, 'workbench-data', 'agent-roles')).filter(f => /^c-.*\.json$/.test(f)).length === 1)
  const rid = (await ctx.page.locator('[data-testid^=assistant-role-c-]').first().getAttribute('data-testid')).replace('assistant-role-', '')
  await ctx.page.locator(`[data-testid=assistant-role-${rid}]`).click()
  check('自定义角色', '选中自定义角色：推荐问题是它自己的（2 个）', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-suggest-]').count()) === 2, 8000))
  await typeAndSend('随便问一句')
  await waitFor(async () => (await count('assistant-answer')) === 1, 40000)
  const names = mock.agentRequests.at(-1).toolNames
  check('自定义角色', '这个角色只能用勾选的查询 + 基础工具（没有 kp_questions）', names.includes('stats_overview') && !names.includes('kp_questions') && names.includes('session_state') && names.includes('ask_user'), names.join(','))
  check('自定义角色', '角色说明进了给模型的规矩', /关心续费/.test(mock.agentRequests.at(-1).messages[0].content))
  // 导出
  await T('assistant-settings-open').click(); await T('assistant-role-edit').click(); await T('role-modal').waitFor()
  const exportPath = path.join(work, 'role-export.json')
  await M.stubSave(exportPath)
  await T('role-export').click()
  check('角色导出', '导出成文件（带格式标记，可发给别人）', await waitFor(async () => fs.existsSync(exportPath), 8000) && /juanzhi-agent-role-v1/.test(fs.readFileSync(exportPath, 'utf8')))
  // 删除
  await T('role-delete').click(); await T('role-delete-ok').click()
  check('角色删除', '删除后角色和文件都没了，以前的对话还在', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-role-c-]').count()) === 0, 8000) && fs.readdirSync(path.join(ud, 'workbench-data', 'agent-roles')).filter(f => f.endsWith('.json')).length === 0 && (await count('assistant-history-item')) >= 1)
  // 导入
  await stubOpen([exportPath])
  await T('assistant-settings-open').click(); await T('assistant-role-import').click()
  check('角色导入', '导入刚才导出的文件：角色回来了（新 id）', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-role-c-]').count()) === 1, 8000) && (await ctx.page.locator('[data-testid^=assistant-role-c-]').first().getAttribute('data-testid')) !== `assistant-role-${rid}`)

  // ── 10. 机构说明 ──
  await T('assistant-settings-open').click(); await T('assistant-settings').waitFor()
  await T('assistant-org-context').fill('我们把一级叫“启蒙级”。')
  await T('assistant-settings-save').click()
  const ctxFile = path.join(ud, 'workbench-data', 'agent-context.md')
  check('机构说明', '保存到数据目录 agent-context.md', await waitFor(async () => fs.existsSync(ctxFile) && /启蒙级/.test(fs.readFileSync(ctxFile, 'utf8')), 8000))
  await T('assistant-role-ops').click(); await T('assistant-new').click()
  await typeAndSend('机构说明有用吗')
  await waitFor(async () => (await count('assistant-answer')) >= 1, 40000)
  check('机构说明', '每次对话的 system 里带上了机构说明', /启蒙级/.test(mock.agentRequests.at(-1).messages[0].content))
  check('剧本按需', 'system 里只有剧本的名字和用途，没有全文步骤', /学情周报：/.test(mock.agentRequests.at(-1).messages[0].content) && !/## 周报格式/.test(mock.agentRequests.at(-1).messages[0].content))

  // ── 11. 设置里的「打开卷知时先进入」 ──
  await goto('#/settings'); await T('start-page').waitFor()
  await ctx.page.evaluate(() => window.api.settings.set('start_page', 'assistant'))
  await ctx.page.evaluate(() => { location.hash = '#/' })
  await ctx.page.reload()
  check('启动页', '设置为「助手」后重新打开先进入助手页；默认值不改（这套测试其余部分都是试卷库）', await waitFor(async () => (await ctx.page.evaluate(() => location.hash)) === '#/assistant', 10000))
  await ctx.page.evaluate(() => window.api.settings.set('start_page', 'library'))

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.stop()
}

/** 往 papers 里加一行（触发数据修订号 +1），模拟「数据变了」 */
function withDbWrite() {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ctx.ud, 'workbench-data', 'db.sqlite'))
  db.exec('PRAGMA busy_timeout=5000')
  db.prepare("UPDATE kps SET plain = COALESCE(plain, '') || '。' WHERE code = (SELECT code FROM kps LIMIT 1)").run()
  db.close()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11a.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  console.error('渲染端控制台错误：', ctx.consoleErrors.slice(0, 5)); try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m11a.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
