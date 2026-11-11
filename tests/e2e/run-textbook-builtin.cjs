// 内置学校教材 + 「机构课程 vs 学校教材」对比。全程 mock AI（本地端口）；课程内容现场生成（虚构数据）。
//   · 课程大纲页：添加学校教材（选版本 + 两册）→ 生成一份带「学校教材 · 内置」标记的教材，不需要 AI 匹配；机构课程和学校教材分开显示
//   · 看板「课程对照」→「机构课程 vs 学校教材」：覆盖 / 未覆盖 / 机构课超前拓展的数字对得上；导出 CSV
//   · 删除教材：回到空状态
// 用法：node tests/e2e/run-textbook-builtin.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const { check, waitFor, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, cfgFor, saveCfg, startMock, open, closeApp, stubSave, L } = M

// 期望值从内置目录文件现算（目录随调研更新，不写死数字）
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/main/seed/textbook-catalog/english-pep.json'), 'utf8'))
const picked = cat.books.filter(b => (b.grade === 3 || b.grade === 4) && b.semester === '上')
const UNITS = picked.reduce((n, b) => n + b.units.length, 0)
const TB = new Set(picked.flatMap(b => b.units.flatMap(u => u.kps)))
const COURSE_KPS = ['GR.NOUN.PLURAL.REG', 'GR.TENSE.PAST.REG']
const COVERED = COURSE_KPS.filter(k => TB.has(k)).length

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userTextbook')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  const page = ctx.page
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // 一份机构课程（现场造）：两课，名词复数 → 第 1 课，一般过去时（教材里没有）→ 第 2 课
  await goto('#/courses'); await T('course-settings').waitFor()
  const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
  const saved = await page.evaluate(async lv => window.api.course.save({ name: '示例机构课', scene: 'org', levels: lv, subject: 'english' }), [{ name: '基础级', lessons: [lesson(1, 'Plurals'), lesson(2, 'Past')] }])
  const detail = await page.evaluate(id => window.api.course.get(id), saved.id)
  const lid = Object.fromEntries(detail.levels.flatMap(l => l.lessons).map(l => [l.title, l.id]))
  await page.evaluate(async a => { for (const [kp, lessonId] of a.maps) await window.api.course.mapEdit({ op: 'add', outlineId: a.id, kp, lessonId }) }, { id: saved.id, maps: [['GR.NOUN.PLURAL.REG', lid.Plurals], ['GR.TENSE.PAST.REG', lid.Past]] })
  await page.reload(); await T('course-settings').waitFor()
  check('机构课程', '课程大纲页只有机构课程时不加分组小标题，卡片标记是「培训机构的课程」', (await T('course-kind-tag').first().getAttribute('data-kind')) === 'course' && (await T('course-group-course').count()) === 0)

  // ───── 添加学校教材 ─────
  await T('course-add-textbook').click()
  await T('textbook-edition').waitFor()
  check('添加教材', '弹窗里有教材版本下拉和年级 / 上下册多选，先不选册时「添加」不可用', (await T('textbook-edition').count()) === 1 && (await T('textbook-books').count()) === 1 && (await T('textbook-add-ok').isDisabled()))
  await T('textbook-book-3上').click()
  await T('textbook-book-4上').click()
  await T('textbook-add-ok').click()
  const cardOk = await waitFor(async () => (await page.locator('[data-testid=course-kind-tag][data-kind=textbook]').count()) === 1, 15000)
  check('添加教材', '点添加后列表里出现一份「学校教材 · 内置」', cardOk && /学校教材 · 内置/.test(await page.locator('[data-testid=course-kind-tag][data-kind=textbook]').first().innerText()))
  check('添加教材', '机构课程和学校教材分开显示（各有小标题）', (await T('course-group-course').count()) === 1 && (await T('course-group-textbook').count()) === 1)
  const card = page.locator('[data-testid^=course-card-]').filter({ has: page.locator('[data-kind=textbook]') }).first()
  const cardText = await card.innerText()
  check('添加教材', '教材卡片：2 个年级学期 · 全部单元，内置教材不显示匹配按钮，只说明来自内置目录', /2 个/.test(cardText) && new RegExp(`${UNITS} 课`).test(cardText) && /不需要 AI 匹配/.test(cardText) && (await card.locator('[data-testid=match-start]').count()) === 0)
  check('添加教材', '内置教材有「重新从内置更新」，没有「重新上传」', (await card.locator('[data-testid=course-refresh-builtin]').count()) === 1 && (await card.locator('[data-testid=course-reupload]').count()) === 0)
  const tbId = (await card.getAttribute('data-testid')).replace('course-card-', '')
  const dbMaps = await page.evaluate(id => window.api.course.maps(id), tbId)
  check('添加教材', '知识点对应直接写进库（内置、已确认），不经过 AI', dbMaps.length > 0 && dbMaps.every(m => m.source === 'builtin' && m.state === 'confirmed'), `${dbMaps.length} 条`)
  await card.locator('[data-testid=course-refresh-builtin]').click()
  await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').first().click()
  check('更新教材', '「重新从内置更新」成功，对应条数不变', await waitFor(async () => (await page.evaluate(id => window.api.course.maps(id), tbId)).length === dbMaps.length, 8000))

  // ───── 看板对比 ─────
  await setFilter({ grade: '4' }, '#/dashboard')
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30000 })
  await page.getByRole('tab', { name: '课程对照' }).click()
  await T('course-view-compare').click()
  await T('compare-textbook').waitFor({ timeout: 15000 })
  await T('compare-headline').waitFor({ timeout: 15000 })
  const covered = Number(await txt('compare-covered')), uncovered = Number(await txt('compare-uncovered'))
  check('对比', `教材共考到 ${TB.size} 个知识点：机构课讲到 ${COVERED} 个（名词复数在教材里），其余没讲到`, COVERED >= 1 && covered === COVERED && uncovered === TB.size - COVERED, `${covered}/${uncovered}`)
  check('对比', '单元列表里「讲到」「没讲到」的知识点标记数对得上（同一个知识点可出现在多个单元里）', (await T('compare-kp-covered').count()) >= COVERED && (await T('compare-kp-uncovered').count()) >= uncovered)
  check('对比', '机构课讲了教材里没有的（一般过去时）出现在「超前 / 拓展」里', TB.has('GR.TENSE.PAST.REG') || /Past/.test(await txt('compare-extra')))
  await page.screenshot({ path: path.join(M.shots || work, 'textbook-compare.png') })
  const csv = path.join(work, '对比.csv')
  await stubSave(csv)
  await T('compare-export').click()
  check('对比', '导出 CSV：带 BOM，有机构课名、「没讲到」和「超前 / 拓展」', await waitFor(async () => fs.existsSync(csv), 8000) && (() => { const t = fs.readFileSync(csv, 'utf8'); return t.charCodeAt(0) === 0xfeff && /示例机构课/.test(t) && /没讲到/.test(t) && /超前 \/ 拓展/.test(t) })())
  await T('compare-copy').click()
  const clip = await ctx.app.evaluate(({ clipboard }) => clipboard.readText())
  check('对比', '「复制成文字」：剪贴板里是对比小结', /对照/.test(clip) && /请教研核对/.test(clip))

  // ───── 删除教材 ─────
  await goto('#/courses'); await T('course-settings').waitFor()
  const card2 = page.locator(`[data-testid=course-card-${tbId}]`)
  await card2.locator('[data-testid=course-delete]').click()
  await T('course-delete-ok').click()
  check('删除教材', '删除后教材卡片消失，课程仍在', await waitFor(async () => (await page.locator(`[data-testid=course-card-${tbId}]`).count()) === 0, 8000) && (await page.locator('article[data-testid^=course-card-]').count()) === 1)
  check('删除教材', '数据库里这份教材的课次、对应都没了', (await page.evaluate(id => window.api.course.maps(id), tbId)).length === 0)
  await setFilter({ grade: '4' }, '#/dashboard')
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30000 })
  await page.getByRole('tab', { name: '课程对照' }).click()
  await T('course-view-compare').click()
  check('删除教材', '对比页回到「还没有添加学校教材」的空状态', await T('compare-empty').waitFor({ timeout: 10000 }).then(() => true, () => false))
  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-textbook-builtin.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(__dirname, 'last-result-textbook-builtin.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
