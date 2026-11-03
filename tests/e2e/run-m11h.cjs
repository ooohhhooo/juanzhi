// 新建角色三步向导端到端：首次引导 → 向导第 1 步（模板卡片）→ 选模板预填 → 保存 → 「让助手帮我生成」→ 第 2 步 → 生成草稿（过滤不存在的工具 / Skill）
// → 改名保存 → 角色切换里出现；学校场景隐藏续费顾问 / 课程顾问；AI 出错时可改用模板；没配 AI 时「让助手帮我生成」置灰。
// 全程 mock AI。用法：npm run test:e2e:m11h   （沙箱外运行：Electron、本地端口都被沙箱限制）
// 向导三步截图：SHOT_DIR 环境变量指定目录（默认放在临时目录）。
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { check, waitFor, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, L } = M

const SHOTS = process.env.SHOT_DIR || work
fs.mkdirSync(SHOTS, { recursive: true })
const count = async id => T(id).count()
const customRoleFiles = ud => { const d = path.join(ud, 'workbench-data', 'agent-roles'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^c-.*\.json$/.test(f)) : [] }
const readRole = (ud, f) => JSON.parse(fs.readFileSync(path.join(ud, 'workbench-data', 'agent-roles', f), 'utf8')).role
/** 等弹窗的开合动画结束（这些 testid 的元素已从页面移除），再多留一点时间，截图才不会叠着上一个弹窗 */
const settle = async (...ids) => { for (const id of ids) await T(id).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); await ctx.page.waitForTimeout(700) }
const openWizard = async () => { await T('assistant-settings-open').click(); await T('assistant-role-new').click(); await T('role-wizard').waitFor() }

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM11h')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  await ctx.page.setViewportSize({ width: 1280, height: 860 })
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()

  // ── 0. 没配 AI：「让助手帮我生成」置灰并提示 ──
  await openWizard()
  check('没配 AI', '「让助手帮我生成」置灰，并提示先在设置里配置 AI 服务', await T('role-wizard-ai').isDisabled() && /先在设置里配置 AI 服务/.test(await txt('role-wizard-ai')))
  await ctx.page.keyboard.press('Escape'); await T('role-wizard').waitFor({ state: 'detached' })

  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/overview'); await goto('#/assistant'); await T('assistant-page').waitFor()

  // ── 1. 首次使用引导 ──
  check('首次引导', '还没选过角色：空状态上方有「先选一个最像你的角色」+ 4 个模板按钮 + 「更多…」', await waitFor(async () => (await count('assistant-role-guide')) === 1, 8000)
    && (await ctx.page.locator('[data-testid^=assistant-guide-]:not([data-testid=assistant-guide-more])').count()) === 4 && (await count('assistant-guide-more')) === 1)

  // ── 2. 向导第 1 步 ──
  await openWizard()
  const tplCount = await ctx.page.locator('[data-testid^=role-tpl-]').count()
  check('第 1 步', '卡片网格展示 12 个模板（机构叫法），另有「让助手帮我生成」「从空白开始」', tplCount === 12 && (await count('role-wizard-ai')) === 1 && (await count('role-wizard-blank')) === 1 && !(await T('role-wizard-ai').isDisabled()))
  check('第 1 步', '机构场景能看到续费顾问、课程顾问', (await count('role-tpl-renewal')) === 1 && (await count('role-tpl-advisor')) === 1 && /辅导老师/.test(await txt('role-tpl-tutor')))
  await settle('assistant-settings'); await ctx.page.screenshot({ path: path.join(SHOTS, 'role-1-pick.png') })

  // ── 3. 选模板 → 第 3 步预填 → 保存 ──
  await T('role-tpl-tutor').click(); await T('role-modal').waitFor()
  check('第 3 步', '选模板后直接进入编辑页，名称、说明、推荐问题（4 个）都已预填', (await T('role-name').inputValue()) === '辅导老师' && (await T('role-desc').inputValue()).length > 10 && (await T('role-suggest').inputValue()).split('\n').length === 4)
  check('第 3 步', '工具按类别分组（数据、统计、看板与产出、试卷、连接器），每类有全选', (await ctx.page.locator('[data-testid^=role-tools-all-]').count()) === 5 && /统计/.test(await txt('role-tools-stats')))
  // 全选 / 取消全选
  await ctx.page.locator('label:has([data-testid=role-tools-all-stats])').click()
  const statsPicked = async () => ctx.page.locator('[data-testid=role-tools-stats] .ant-checkbox-group input:checked').count()
  check('第 3 步', '点某一类的「全选」可以取消 / 全选这一类', (await statsPicked()) === 0)
  await ctx.page.locator('label:has([data-testid=role-tools-all-stats])').click()
  check('第 3 步', '再点一次全部勾回', (await statsPicked()) > 5)
  await T('role-back').click(); await T('role-wizard').waitFor()
  check('第 3 步', '「上一步」回到第 1 步', (await count('role-tpl-tutor')) === 1)
  await T('role-tpl-tutor').click(); await T('role-modal').waitFor()
  await T('role-save').click()
  check('选模板保存', '保存后角色出现在角色切换里，文件写进数据目录', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-role-c-]').count()) === 1, 8000) && customRoleFiles(ud).length === 1)
  const r1 = readRole(ud, customRoleFiles(ud)[0])
  check('选模板保存', '保存的内容是模板里的：4 个推荐问题、带工具、默认 Skill', r1.suggestions.length === 4 && r1.tools.includes('run_query') && r1.defaultPlaybook === 'student-followup-list')
  check('首次引导', '选过角色后引导不再出现', await waitFor(async () => (await count('assistant-role-guide')) === 0, 6000))

  // ── 4. 让助手帮我生成 ──
  await openWizard()
  await T('role-wizard-ai').click(); await T('role-ai-form').waitFor()
  check('第 2 步', '没填岗位时「生成」不可点', await T('role-ai-generate').isDisabled())
  await T('role-ai-job').locator('input').fill('班主任')
  for (const t of ['看数据', '跟进学员']) await ctx.page.locator('[data-testid=role-ai-tasks] label', { hasText: t }).click()
  await ctx.page.locator('[data-testid=role-ai-report] label', { hasText: '主管' }).click()
  await ctx.page.locator('[data-testid=role-ai-style] label', { hasText: '温和鼓励' }).click()
  await T('role-ai-extra').fill('我带三个班')
  await settle('assistant-settings', 'role-wizard'); await ctx.page.screenshot({ path: path.join(SHOTS, 'role-2-ai.png') })
  mock.roleDraftDelayMs = 1500
  await T('role-ai-generate').click()
  check('生成中', '生成时显示加载状态，可以取消', await waitFor(async () => (await count('role-ai-loading')) === 1 && (await count('role-ai-cancel')) === 1, 4000))
  await T('role-ai-cancel').click()
  check('取消', '取消后回到问题页，不会跳到编辑页', await waitFor(async () => (await count('role-ai-generate')) === 1, 4000))
  await new Promise(r => setTimeout(r, 1800))
  check('取消', '取消后即使稍后 AI 返回，也不进入编辑页', (await count('role-modal')) === 0)
  mock.roleDraftDelayMs = 0
  await T('role-ai-generate').click()
  await T('role-modal').waitFor({ timeout: 20000 })
  const rq = mock.roleDraftRequests.at(-1)
  check('生成', '提示词带上了岗位、常做的事、汇报对象、说话风格和补充，也带了工具清单', !!rq && /岗位：班主任/.test(rq.user) && /看数据、跟进学员/.test(rq.user) && /主管/.test(rq.user) && /温和鼓励/.test(rq.user) && /我带三个班/.test(rq.user) && /run_query：/.test(rq.user) && !/\{\{/.test(rq.user))
  check('生成', '编辑页预填了 AI 草稿的名称和 4 个推荐问题', (await T('role-name').inputValue()) === '班级跟进助手' && (await T('role-suggest').inputValue()).split('\n').length === 4)
  await T('role-name').fill('我的班主任助手')
  await settle('role-ai-form'); await ctx.page.screenshot({ path: path.join(SHOTS, 'role-3-edit.png') })
  await T('role-save').click()
  check('生成后保存', '改名保存后，角色切换里出现「我的班主任助手」', await waitFor(async () => (await ctx.page.locator('[data-testid^=assistant-role-c-]').count()) === 2, 8000)
    && (await ctx.page.locator('[data-testid^=assistant-role-c-]', { hasText: '我的班主任助手' }).count()) === 1)
  const r2 = customRoleFiles(ud).map(f => readRole(ud, f)).find(r => r.name === '我的班主任助手')
  check('过滤', '草稿里不存在的工具、Skill 已被过滤掉，存在的保留', !!r2 && r2.tools.includes('run_query') && r2.tools.includes('stat_nps') && !r2.tools.includes('no_such_tool') && !r2.defaultPlaybook)

  // ── 5. AI 出错：显示原因，可改用模板 ──
  mock.roleDraftFail = true
  await openWizard()
  await T('role-wizard-ai').click(); await T('role-ai-job').locator('input').fill('教务')
  await T('role-ai-generate').click()
  check('出错', '生成失败：显示原因（AiErrorExplain），不跳页', await waitFor(async () => (await count('role-ai-error')) === 1 && (await count('ai-error-explain')) === 1, 15000))
  await T('role-ai-usetpl').click(); await T('role-wizard').waitFor()
  check('出错', '点「改用模板」回到第 1 步', (await count('role-tpl-admin')) === 1)
  mock.roleDraftFail = false
  await ctx.page.keyboard.press('Escape'); await T('role-wizard').waitFor({ state: 'detached' })

  // ── 6. 学校场景：隐藏续费顾问、课程顾问，改用学校叫法 ──
  await T('assistant-settings-open').click(); await T('assistant-settings').waitFor()
  await T('assistant-scene-school').click()
  await T('assistant-role-new').click(); await T('role-wizard').waitFor()
  check('学校场景', '学校场景不显示续费顾问、课程顾问，模板用学校叫法（班主任、年级主任）', (await count('role-tpl-renewal')) === 0 && (await count('role-tpl-advisor')) === 0
    && (await ctx.page.locator('[data-testid^=role-tpl-]').count()) === 10 && /班主任/.test(await txt('role-tpl-tutor')) && /年级主任/.test(await txt('role-tpl-head')))
  await ctx.page.keyboard.press('Escape')
  await T('assistant-settings-open').click(); await T('assistant-scene-org').click(); await ctx.page.keyboard.press('Escape')
}

main().then(async () => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11h.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  console.error('渲染端控制台错误：', ctx.consoleErrors.slice(0, 5)); try { await ctx.page.screenshot({ path: path.join(work, 'failure.png') }); console.error('失败现场截图：', path.join(work, 'failure.png')) } catch { /* 忽略 */ }
  L.finish(path.join(__dirname, 'last-result-m11h.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
