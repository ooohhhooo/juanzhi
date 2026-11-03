// 课程大纲 · 后台整理队列端到端：多文件一次上传、整理中切到别的页面再回来、待核对 → 核对并保存、取消、失败重试。
// 全程 mock AI（延迟用 mock.courseDelayMs 拉长，好观察「整理中」），文件现场生成（虚构通用课名）。
// 用法：npm run test:e2e:m10e   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const D = require('./make-course-docs.cjs')
const { reviewJob, check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, stubOpen, L } = M

const q = (sql, ...p) => withDb(ctx.ud, d => d.prepare(sql).all(...p))
const states = async () => ctx.page.evaluate(() => [...document.querySelectorAll('[data-testid^=course-job-][data-status]')].map(e => e.getAttribute('data-status')))
const count = async s => (await states()).filter(x => x === s).length
const openWizard = async () => {
  await goto('#/courses'); await T('course-settings').waitFor()
  await ((await T('course-add').count()) ? T('course-add') : T('course-add-empty')).first().click()
  await T('course-wizard').waitFor()
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM10e')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  const cfg = cfgFor(mock, { auto_parse: false })
  await saveCfg(cfg, SECRET)
  const dir = path.join(work, 'courses-e'); fs.mkdirSync(dir, { recursive: true })
  const f = n => path.join(dir, n)
  const header = ['课次', '课程标题', '词汇']
  const mk = async (file, titles) => D.makeXlsx(file, '示例级别', [header, ...titles.map((t, i) => [String(i + 1), t, 'word' + i])])
  await mk(f('甲体系.xlsx'), ['一般现在时', '一般过去时'])
  await mk(f('乙体系.xlsx'), ['现在进行时', '将来时', '比较级'])
  await mk(f('丙体系.xlsx'), ['名词复数'])
  await D.makeDocxText(f('文字版.docx'), ['课程安排（虚构示例）', '第1课 一般现在时', '词汇：is / are', '第2课 一般过去时', '词汇：played'])

  // ── 1. 多文件一次上传 → 弹窗立刻关闭 → 三张卡片（并发 2，其余排队） ──
  mock.courseDelayMs = 2500
  await openWizard()
  await stubOpen([f('甲体系.xlsx'), f('乙体系.xlsx'), f('丙体系.xlsx')])
  await T('course-pick').click()
  await T('course-file-list').waitFor({ timeout: 10000 })
  check('多文件', '一次选 3 个文件：显示“已读取 3 个文件”和各自文件名，名称框停用', /3 个文件/.test(await txt('course-file-name')) && (await T('course-file-item').count()) === 3 && await T('course-name').isDisabled())
  check('多文件', '主按钮是“开始整理”', /开始整理/.test(await txt('course-next')))
  await T('course-next').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 8000 })
  check('多文件', '点“开始整理”后弹窗立刻关闭（不等 AI）', true)
  check('多文件', '列表里出现 3 张任务卡片：2 张“AI 整理中”、1 张“排队中”，每张可取消', await waitFor(async () => (await count('running')) === 2 && (await count('queued')) === 1, 6000) && (await T('course-job-cancel').count()) === 3)
  const names = (await ctx.page.locator('[data-testid=course-job-name]').allInnerTexts()).sort()
  check('多文件', '卡片显示各自的文件名', JSON.stringify(names) === JSON.stringify(['丙体系', '乙体系', '甲体系']), JSON.stringify(names))
  check('多文件', '整理期间还没有任何体系落库', q('SELECT COUNT(*) c FROM course_outlines')[0].c === 0)

  // ── 2. 整理中切到别的页面再回来：任务还在 ──
  await goto('#/overview'); await sleep(500)
  await goto('#/courses'); await T('course-settings').waitFor()
  check('切页面', '切到总览再回来：3 张卡片还在，状态没丢', (await states()).length === 3)
  check('切页面', '整理在后台完成：3 张卡片全部变成“待核对”，按钮“核对并保存”', await waitFor(async () => (await count('ready')) === 3, 30000) && (await T('course-job-review').count()) === 3 && /待核对/.test(await T('course-job-state').first().innerText()))
  check('切页面', '每个文件各调用 1 次 AI 认列', mock.courseRequests.filter(r => r.courseKind === 'cols').length === 3)

  // ── 3. 待核对 → 核对并保存（第 2 步里能改名称），其余卡片保留 ──
  await T('course-job-review').nth(1).click()
  await T('course-step2').waitFor({ timeout: 20000 })
  const nm = await T('course-name-2').inputValue()
  check('核对', '点“核对并保存”：弹窗直接进入第 2 步，名称默认取文件名，没有“上一步”', ['甲体系', '乙体系', '丙体系'].includes(nm) && /识别到 1 个级别/.test(await txt('course-summary')) && (await ctx.page.getByRole('button', { name: '上一步' }).count()) === 0, nm)
  const nLessons = nm === '甲体系' ? 2 : nm === '乙体系' ? 3 : 1
  await T('course-name-2').fill(nm + '（核对后）')
  await T('course-save').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
  const o = q('SELECT id, name, scene FROM course_outlines')
  check('核对', '保存：数据库里有这个体系（改过的名称），课数对得上', o.length === 1 && o[0].name === nm + '（核对后）' && q('SELECT COUNT(*) c FROM course_lessons WHERE outline_id = ?', o[0].id)[0].c === nLessons, JSON.stringify(o))
  check('核对', '保存后这张任务卡片消失，其余 2 张仍待核对，体系出现在卡片列表里', await waitFor(async () => (await states()).length === 2 && (await count('ready')) === 2 && (await T(`course-card-${o[0].id}`).count()) === 1, 8000))
  // 关闭核对但不保存：任务保留
  await T('course-job-review').first().click(); await T('course-step2').waitFor({ timeout: 20000 })
  await ctx.page.keyboard.press('Escape')
  await T('course-wizard').waitFor({ state: 'detached', timeout: 8000 })
  check('核对', '打开核对后直接关闭（没改动）：任务仍是“待核对”，没有落库', (await count('ready')) === 2 && q('SELECT COUNT(*) c FROM course_outlines')[0].c === 1)
  for (let i = 0; i < 2; i++) await T('course-job-remove').first().click()
  check('核对', '“移除”：待核对的卡片可以直接去掉', await waitFor(async () => (await states()).length === 0, 8000))

  // ── 4. 取消 ──
  mock.courseDelayMs = 4000
  const before = q('SELECT COUNT(*) c FROM course_outlines')[0].c
  await openWizard()
  await stubOpen([f('甲体系.xlsx')])
  await T('course-pick').click(); await T('course-file-name').waitFor({ timeout: 10000 })
  await T('course-name').fill('要取消的')
  await T('course-next').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 8000 })
  check('取消', '单个文件也走后台：卡片“AI 整理中”', await waitFor(async () => (await count('running')) === 1, 6000))
  await T('course-job-cancel').click()
  check('取消', '点“取消”：卡片消失', await waitFor(async () => (await states()).length === 0, 8000))
  await sleep(4500)
  check('取消', '取消后晚到的 AI 结果不会让卡片重新出现，也不会落库', (await states()).length === 0 && q('SELECT COUNT(*) c FROM course_outlines')[0].c === before)

  // ── 5. 失败 → 重试 ──
  mock.courseDelayMs = 0
  mock.forbidModels = ['mock-text-model']   // 服务拒绝这个模型：整理失败
  await openWizard()
  await stubOpen([f('文字版.docx')])
  await T('course-pick').click(); await T('course-file-name').waitFor({ timeout: 10000 })
  await T('course-name').fill('失败后重试')
  await T('course-next').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 8000 })
  check('失败重试', 'AI 服务拒绝请求：卡片“整理失败”，显示简短原因，有“重试”“移除”', await waitFor(async () => (await count('failed')) === 1, 15000) && /AI 整理没成功/.test(await txt('course-job-error')) && (await T('course-job-retry').count()) === 1 && (await T('course-job-remove').count()) === 1 && (await T('course-job-review').count()) === 0, await txt('course-job-error').catch(() => ''))
  mock.forbidModels = []
  await T('course-job-retry').click()
  check('失败重试', '服务恢复后点“重试”：重新整理，成为“待核对”', await waitFor(async () => (await count('ready')) === 1, 30000))
  await reviewJob()
  check('失败重试', '核对：从文字版 Word 整理出 2 课，名称是向导里填的', /共 2 课/.test(await txt('course-summary')) && (await T('course-name-2').inputValue()) === '失败后重试')
  await T('course-save').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
  check('失败重试', '保存成功，任务卡片消失', q("SELECT COUNT(*) c FROM course_outlines WHERE name = '失败后重试'")[0].c === 1 && await waitFor(async () => (await states()).length === 0, 8000))

  // ── 6. 手动指定列：单文件直接进第 2 步，不调用 AI ──
  mock.resetStats()
  await openWizard()
  await stubOpen([f('甲体系.xlsx')])
  await T('course-pick').click(); await T('course-file-name').waitFor({ timeout: 10000 })
  await ctx.page.locator('label:has([data-testid=course-mode-manual])').click()
  check('手动', '手动指定列：按钮是“下一步：核对整理结果”', /下一步/.test(await txt('course-next')))
  await T('course-next').click()
  await T('course-step2').waitFor({ timeout: 10000 })
  check('手动', '直接进入第 2 步，没有调用 AI，也没有任务卡片', mock.courseRequests.length === 0 && (await states()).length === 0)
  await ctx.page.keyboard.press('Escape')
  await ctx.page.locator('.ant-modal-confirm-btns button.ant-btn-dangerous').click()

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m10e.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m10e.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
