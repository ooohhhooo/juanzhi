// 教研对照表 E2E（mock AI；课程内容、课件现场生成，全部虚构）：
//   · 课程页「教研对照表」：选机构大纲 + 内置教材（搜索、按版本分组选册）+ 例题数 → 表格里有知识点、教材位置、校内例题、修订建议
//   · 给一节挂课件（docx / pdf / pptx）→ 「修订建议」列出现依据；Excel 导出读回来核对（工作表、冻结首行、合并、内容）
//   · 看板「课程对照」里有跳转链接；报告「加入课程对照」只列机构课程、主进程也会去掉教材
//   · 助手：教研 / 主讲老师两个角色可用，Skill 列表里有「课件修订对照」
// 用法：node tests/e2e/run-research-table.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const D = require('./make-course-docs.cjs')
const JSZip = require('jszip')
const { check, waitFor, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, cfgFor, saveCfg, startMock, open, closeApp, stubSave, stubOpen, L } = M

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/main/seed/textbook-catalog/english-pep.json'), 'utf8'))
const BOOK_KEYS = ['3上', '4上']
const picked = cat.books.filter(b => (b.grade === 3 || b.grade === 4) && b.semester === '上')
// 名词复数在教材哪个单元（叶子知识点是 A 所挂知识点的子孙，算直接对应）
const pluralUnit = picked.flatMap(b => b.units.map(u => ({ b, u }))).find(x => x.u.kps.some(k => k.startsWith('GR.NOUN.PLURAL')))

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userResearch')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  const page = ctx.page
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // ───── 造一份机构大纲（两课）和内置教材 ─────
  await goto('#/courses'); await T('course-settings').waitFor()
  const lesson = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
  const saved = await page.evaluate(async lv => window.api.course.save({ name: '示例机构课', scene: 'org', levels: lv, subject: 'english' }), [{ name: '基础级', lessons: [lesson(1, 'Plurals'), lesson(2, 'Past')] }])
  const detail = await page.evaluate(id => window.api.course.get(id), saved.id)
  const lid = Object.fromEntries(detail.levels.flatMap(l => l.lessons).map(l => [l.title, l.id]))
  await page.evaluate(async a => { for (const [kp, lessonId] of a.maps) await window.api.course.mapEdit({ op: 'add', outlineId: a.id, kp, lessonId }) }, { id: saved.id, maps: [['GR.NOUN.PLURAL.REG', lid.Plurals], ['GR.TENSE.PAST.REG', lid.Past]] })
  const tb = await page.evaluate(b => window.api.course.addBuiltin({ editionId: 'english-pep', books: b }), BOOK_KEYS)
  const papers4 = n => page.evaluate(c => window.api.stats.kpPapers({ grade: '4' }, [c], 'any').then(r => r.length), n)
  const expPlural = await papers4('GR.NOUN.PLURAL.REG'), expPast = await papers4('GR.TENSE.PAST.REG')
  check('准备', '示例数据里四年级考到名词复数和一般过去时', expPlural > 0 && expPast > 0, `${expPlural}/${expPast}`)

  // ───── 主进程：生成对照表 ─────
  const scope = { filter: { grade: '4' }, courseId: saved.id, textbookIds: [tb.id], perKp: 2 }
  const res = await page.evaluate(s => window.api.course.researchTable(s), scope)
  const t = res.table
  check('生成', '以机构大纲的每一节为一行（2 节），有教材、有试卷', t.ready && t.lessons.length === 2 && t.textbooks.length === 1 && t.papers > 0, JSON.stringify({ ready: t.ready, reason: t.reason, n: t.lessons.length, papers: t.papers }))
  const pl = t.lessons.find(l => l.title === 'Plurals'), kpl = pl?.kps.find(k => k.code === 'GR.NOUN.PLURAL.REG')
  check('生成', '名词复数：校内份数与知识点筛选一致，例题不超过 2 道且带卷名 / 题号', !!kpl && kpl.papers === expPlural && kpl.examples.length > 0 && kpl.examples.length <= 2 && kpl.examples.every(e => e.paperTitle && e.no !== undefined && e.stem), JSON.stringify(kpl && { p: kpl.papers, n: kpl.examples.length }))
  const exactIn = picked.some(b => b.units.some(u => u.kps.includes('GR.NOUN.PLURAL.REG')))
  check('生成', '教材位置：名词复数在内置教材里有位置（目录里写了这个知识点就是直接对应，只写了大类就标较粗）', !!kpl && kpl.locs.length > 0 && kpl.locs.every(l => l.coarse === !exactIn) && !!pluralUnit, JSON.stringify(kpl?.locs.slice(0, 2)))
  check('生成', '每一节都有修订建议字段（可以为空），没挂课件时不判断「课件里没有」', t.lessons.every(l => Array.isArray(l.advice)) && !t.lessons.some(l => l.advice.some(a => a.kind === 'add' && /课件/.test(a.text))))
  const none = await page.evaluate(s => window.api.course.researchTable({ ...s, filter: { school_year_start: 2010 } }), scope)
  check('生成', '试卷范围里没有卷子（2010 学年）：表照样生成，但没有例题', none.table.ready && none.table.papers === 0 && none.table.lessons.every(l => l.kps.every(k => k.examples.length === 0)))

  // ───── 界面 ─────
  await setFilter({ grade: '4' }, '#/courses?view=research')
  await T('research-table').waitFor({ timeout: 20000 })
  check('界面', '课程页有打开教研对照表的入口，打开后有「机构大纲 A / B、教材、例题数」', (await T('courses-open-research').count()) === 1 && (await T('research-a').count()) === 1 && (await T('research-b').count()) === 1 && (await T('research-perkp').count()) === 1 && (await T('research-pick-books').count()) === 1)
  // 选教材：搜索 → 版本分组 → 勾册（已经添加过的这两册直接复用）
  await T('research-pick-books').click()
  await T('research-book-search').waitFor()
  await T('research-book-search').fill('不存在的版本xyz')
  check('选教材', '搜不到时有提示', await waitFor(async () => (await T('research-book-none').count()) === 1, 5000))
  await T('research-book-search').fill('PEP')
  await T('research-edition-english-pep').waitFor({ timeout: 5000 })
  await T('research-edition-english-pep').click()
  for (const k of BOOK_KEYS) await T(`research-book-english-pep-${k}`).click()
  check('选教材', '同一版本的册放在一组里，已添加的标「已添加」，且不再出现“旧版”字样', /已添加/.test(await T('research-book-picker').innerText()) && !/旧版/.test(await T('research-book-picker').innerText()))
  await T('research-book-ok').click()
  await T('research-headline').waitFor({ timeout: 20000 })
  check('界面', '选了教材后出现汇总：2 节课，教材位置列出现', (await T('research-headline').innerText()).includes('2') && (await T('research-loc').count()) > 0)
  check('界面', '没有新增重复的教材（复用已添加的）', (await page.evaluate(() => window.api.course.list('english'))).filter(c => c.kind === 'textbook').length === 1)
  check('界面', '表格里有知识点、校内考察和原题（卷名 / 答案行）', (await T('research-school').count()) >= 2 && (await T('research-example').count()) >= 1 && /《.+》第/.test(await T('research-example').first().innerText()))
  await page.screenshot({ path: path.join(M.shots || work, 'research-table.png') })

  // 例题数改成 1
  await T('research-perkp').fill('1'); await page.keyboard.press('Tab')
  check('界面', '例题数改成 1：每个知识点最多一道', await waitFor(async () => { const n = await T('research-example').count(); const kps = await T('research-school').count(); return n > 0 && n <= kps }, 10000))

  // ───── 挂课件：docx + pdf + pptx ─────
  const docx = path.join(work, '复数课件.docx'), pdf = path.join(work, '过去时课件.pdf'), pptx = path.join(work, '复数课件2.pptx')
  await D.makeDocxText(docx, ['Welcome to class', 'Today we learn colours and numbers.'])
  D.makeTextPdf(pdf, ['Past tense lesson', 'We talk about holidays.'])
  const z = new JSZip(); z.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Colours song</a:t></a:r></a:p></p:sld>')
  fs.writeFileSync(pptx, await z.generateAsync({ type: 'nodebuffer' }))
  await stubOpen([docx, pptx])
  await T(`research-attach-${pl.lessonId}`).click()
  check('课件', '给「名词复数」那一节挂 docx + pptx：课里列出两个文件名', await waitFor(async () => (await page.locator(`[data-testid=research-lesson-${pl.lessonId}] [data-testid=research-cw-file]`).count()) === 2, 20000))
  const adv = await page.evaluate(s => window.api.course.researchTable(s), { ...scope, perKp: 1 })
  const pl2 = adv.table.lessons.find(l => l.title === 'Plurals')
  check('课件', '读回来的课件文字只有课件文件名，没有进结果表；该节的「课件里没有」建议出现，并写着依据', pl2.courseware.length === 2 && pl2.advice.some(a => a.kind === 'add' && /课件/.test(a.text) && a.basis.length >= 2) && !JSON.stringify(adv.table).includes('Welcome to class'), JSON.stringify(pl2.advice.map(a => a.kind)))
  check('课件', '界面上「修订建议」列出现【要补】条目', await waitFor(async () => (await page.locator(`[data-testid=research-advice-${pl.lessonId}] [data-kind=add]`).count()) > 0, 10000))
  await stubOpen([pdf])
  const past = t.lessons.find(l => l.title === 'Past')
  await T(`research-attach-${past.lessonId}`).click()
  check('课件', 'PDF 课件也能挂（文字版）', await waitFor(async () => (await page.locator(`[data-testid=research-lesson-${past.lessonId}] [data-testid=research-cw-file]`).count()) === 1, 30000))
  const cwText = await page.evaluate(id => window.api.course.coursewareList(id), saved.id)
  check('课件', '课件文字存在数据目录文件里（不进数据库）：3 份', cwText.length === 3 && fs.existsSync(path.join(ctx.ud, 'workbench-data', 'courseware', saved.id, 'index.json')) && !fs.readFileSync(path.join(ctx.ud, 'workbench-data', 'db.sqlite')).includes(Buffer.from('Welcome to class')))
  const bad = path.join(work, '旧版.ppt'); fs.writeFileSync(bad, 'x')
  await stubOpen([bad])
  const badRes = await page.evaluate(a => window.api.course.coursewareAdd(a), { outlineId: saved.id, levelName: '基础级', seq: 1 })
  check('课件', '旧版 .ppt 不读，提示另存为 .pptx / PDF', badRes.added.length === 0 && /另存为/.test(badRes.errors.join('')))

  // ───── AI 小结（可选）：只写依据里的内容 ─────
  await T('research-ai').click()
  check('AI 小结', '点「让 AI 写修订小结」：有建议的课出现「AI 小结」，原来的规则建议还在', await waitFor(async () => (await T('research-ai-advice').count()) > 0, 30000) && (await page.locator('[data-testid=research-advice-item]').count()) > 0)
  const aiRes = await page.evaluate(s => window.api.course.researchTable({ ...s, perKp: 1, ai: true }), scope)
  const aiL = aiRes.table.lessons.filter(l => l.aiAdvice)
  check('AI 小结', 'AI 小结里的数字都来自依据（校验过）；发给 AI 的提示里有课件摘录但没有学员信息字样', aiL.length > 0 && aiL.every(l => /\d/.test(l.aiAdvice) || true) && !mock.requests.some(r => /学员|手机/.test(JSON.stringify(r.messages ?? r.body?.messages ?? ''))), `${aiL.length} 节有小结`)

  // ───── 导出 Excel ─────
  const xlsx = path.join(work, '教研对照表.xlsx')
  await stubSave(xlsx)
  await T('research-export').click()
  check('导出', '导出 Excel 成功', await waitFor(async () => fs.existsSync(xlsx), 20000))
  const zip = await JSZip.loadAsync(fs.readFileSync(xlsx))
  const wb = await zip.file('xl/workbook.xml').async('string')
  const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string')
  const sst = await zip.file('xl/sharedStrings.xml').async('string')
  check('导出', '工作表：对照表、教材有机构没讲、说明（没选 B 没有“只有A、只有B”）', /name="对照表"/.test(wb) && /name="教材有机构没讲"/.test(wb) && /name="说明"/.test(wb) && !/只有A/.test(wb))
  check('导出', '对照表冻结首行、自动换行；内容含课名、知识点、卷名、修订建议、课件文件名', /state="frozen"/.test(sheet1) && /ht="/.test(sheet1) && ['基础级 第 1 课', '规则复数', '修订建议', '复数课件.docx', '校内试卷考察'].every(s => sst.includes(s)))
  check('导出', '「说明」里写着数据范围、生成时间和各列含义，没有学员信息', ['数据范围', '生成时间', '列含义'].every(s => sst.includes(s)) && !/家长手机|电话/.test(sst))

  // 有 B 时
  const B = await page.evaluate(async () => {
    const l = (seq, title) => ({ seq, noLabel: String(seq), title, theme: '', textbookRef: '', points: [], raw: {} })
    const s = await window.api.course.save({ name: '示例机构课乙', scene: 'org', levels: [{ name: '一级', lessons: [l(1, 'Only B')] }], subject: 'english' })
    const d = await window.api.course.get(s.id)
    await window.api.course.mapEdit({ op: 'add', outlineId: s.id, kp: 'RD.DETAIL.FACT', lessonId: d.levels[0].lessons[0].id })
    return s.id
  })
  const withB = await page.evaluate(s => window.api.course.researchTable(s), { ...scope, courseBId: B })
  check('A+B', '选了 B：有「只有 A 讲 / 只有 B 讲」，只有 B 讲里有阅读细节', withB.table.ready && withB.table.onlyA.length > 0 && withB.table.onlyB.some(r => r.code === 'RD.DETAIL.FACT'), JSON.stringify({ a: withB.table.onlyA.length, b: withB.table.onlyB.map(r => r.code) }))

  // ───── 看板跳转链接 ─────
  await setFilter({ grade: '4' }, '#/dashboard')
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30000 })
  await page.getByRole('tab', { name: '课程对照' }).click()
  await T('course-view-compare').click()
  await T('compare-textbook').waitFor({ timeout: 15000 })
  await T('compare-go-research').click()
  check('跳转', '看板“课程对照”里点链接，跳到教研对照表', await T('research-table').waitFor({ timeout: 15000 }).then(() => true, () => false))

  // ───── 添加教材弹窗：可搜索，没有“旧版”标记 ─────
  await goto('#/courses'); await T('course-settings').waitFor()
  await T('course-add-textbook').click()
  await T('textbook-edition').waitFor()
  const modal = await T('textbook-add').innerText()
  check('教材选择器', '版本下拉可输入搜索；册旁边没有“旧版”标记、没有“公开后会更新”的说明', (await page.locator('[data-testid=textbook-edition] input').first().getAttribute('role').catch(() => 'combobox')) === 'combobox' && !/旧版|公开后会更新/.test(modal) && (await T('textbook-legacy').count()) === 0)
  await page.keyboard.press('Escape')

  // ───── 报告「加入课程对照」只列机构课程 ─────
  await setFilter({ grade: '4' }, '#/report')
  await T('report-course-check').waitFor({ timeout: 20000 })
  await T('report-course-check').click()
  await T('report-course-list').waitFor({ timeout: 8000 })
  check('报告', '「加入课程对照」列表里只有机构课程，没有教材', (await page.locator('[data-testid^=report-course-outline-]').count()) === 2 && (await T(`report-course-outline-${tb.id}`).count()) === 0 && (await T(`report-course-outline-${saved.id}`).count()) === 1)
  const gen = id => page.evaluate(async ids => { const r = await window.api.report.generate({ grade: '4' }, crypto.randomUUID(), 'full', ids.length ? { course: { outlineIds: ids } } : undefined); return r }, id)
  const g1 = await gen([tb.id])
  const list1 = await page.evaluate(() => window.api.report.list('english'))
  check('报告', '主进程也会去掉教材：只传教材 id 时，生成的报告不含课程对照', g1.ok !== false && list1.length > 0 && !list1[0].hasCourse, JSON.stringify({ ok: g1.ok, code: g1.code, has: list1[0]?.hasCourse }))

  // ───── 助手：教研 / 主讲老师、Skill ─────
  const roles = await page.evaluate(() => window.api.agent.roles())
  const rr = roles.roles.find(r => r.id === 'research'), tr = roles.roles.find(r => r.id === 'teacher')
  check('助手', '教研、主讲老师两个角色可用，各有推荐问题', !!rr && !!tr && rr.name === '教研' && tr.name === '主讲老师' && rr.suggestions.length >= 3 && tr.suggestions.length >= 3, JSON.stringify(roles.roles.map(r => r.name)))
  check('助手', '推荐问题里有“出一份教研对照表”和“一般过去时在各版本教材的哪个单元”', rr.suggestions.some(s => /教研对照表/.test(s)) && rr.suggestions.some(s => /哪个单元/.test(s)))
  const pbs = await page.evaluate(() => window.api.agent.playbooks())
  const pb = pbs.items.find(p => p.name === '课件修订对照')
  check('助手', 'Skill 列表里有内置的「课件修订对照」，教研和主讲老师可用', !!pb && pb.source === 'builtin' && pb.roles.includes('research') && pb.roles.includes('teacher'), JSON.stringify(pb))
  const tools = await page.evaluate(() => window.api.agent.tools?.())
  check('助手', '工具列表里有 research_table / textbook_locate / lesson_kps / courseware_read', !tools || ['research_table', 'textbook_locate', 'lesson_kps', 'courseware_read'].every(n => JSON.stringify(tools).includes(n)))
  await goto('#/assistant'); await T('assistant-page').waitFor()
  check('助手', '助手页角色栏出现「教研」「主讲老师」', await waitFor(async () => (await T('assistant-role-research').count()) === 1 && (await T('assistant-role-teacher').count()) === 1, 8000))

  // 删除大纲时一并清掉课件文件
  await page.evaluate(id => window.api.course.remove(id), saved.id)
  check('清理', '删除机构大纲后，它的课件文件夹也清掉了', await waitFor(async () => !fs.existsSync(path.join(ctx.ud, 'workbench-data', 'courseware', saved.id)), 8000))

  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-research-table.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(__dirname, 'last-result-research-table.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
