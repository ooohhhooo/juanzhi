// 课程大纲 · 教材 / 整本书 + 大文件端到端（全程 mock AI；合成教材、大文件现场生成，不进仓库，测完删除）：
//  1. 教材：选「教材课本」→ 目录切单元（不用 AI）→ 一个单元一次 AI 调用（只给标题 / 小节标题 / 开头 + 候选知识点）→ 按单元核对（默认折叠、低把握展开）→ 保存，知识点写进 course_kp_map；
//  2. AI 给了知识点树里没有的代码 → 丢弃；引用的原文是编的 → 降为低把握；
//  3. 某个单元失败 → 任务失败并说明，「重试」只重做失败的单元；
//  4. 页数超过课程表上限 → 提示「像是教材」，可按教材整理或只选页码范围；错误提示带实际页数 / 大小和上限；
//  5. 大文件：501 / 600 MB 被拒并说明大小；480 MB（接近上限）的合成 PDF 能按教材打开；320 MB 的合成 PDF 能导入试卷，主进程内存不随文件大小增长。
// 用法：npm run test:e2e:textbook   （沙箱外运行）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const D = require('./make-course-docs.cjs')
const { reviewJob, check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, stubOpen, shots, L } = M

const q = (sql, ...p) => withDb(ctx.ud, d => d.prepare(sql).all(...p))
const lastMsg = async () => (await ctx.page.locator('.ant-message-notice').last().innerText().catch(() => '')).replace(/\s+/g, ' ')
const shotT = async name => {
  await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {})
  await sleep(500)
  await ctx.page.screenshot({ path: path.join(shots, `textbook-${name}.png`) })
}
const rss = () => ctx.app.evaluate(() => process.memoryUsage().rss)
const mb = n => Math.round(n / 1024 / 1024)

/** 打开向导、选文件类型和页码范围、选文件；返回是否读取成功（失败时留下提示条文字在 pick.msg） */
async function pick(file, o = {}) {
  await goto('#/courses'); await T('course-settings').waitFor()
  if (!(await T('course-wizard').count())) await ((await T('course-add').count()) ? T('course-add') : T('course-add-empty')).first().click()
  await T('course-wizard').waitFor()
  await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {})
  await T(`course-kind-${o.kind || 'auto'}`).click()
  await T('course-page-range').fill(o.range || '')
  await stubOpen([file])
  await T('course-pick').click()
  let t = 0
  const limit = o.wait || 20000
  while (t < limit) {
    if (await T('course-file-name').count()) { pick.msg = ''; return true }
    if (await T('course-textbook-suggest').count()) { pick.msg = 'SUGGEST'; return false }
    const m = await lastMsg()
    if (m) { pick.msg = m; return false }
    await sleep(150); t += 150
  }
  pick.msg = ''
  return false
}
const closeWizard = async () => {
  await ctx.page.keyboard.press('Escape').catch(() => {})
  await sleep(300)
  if (await T('course-wizard').count()) { await ctx.page.locator('.ant-modal-close').first().click().catch(() => {}); await sleep(300) }
  await ctx.page.locator('.ant-modal-confirm .ant-btn-dangerous, .ant-modal-confirm .ant-btn-primary').first().click({ timeout: 800 }).catch(() => {})
  await T('course-wizard').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}
const removeJobs = () => ctx.page.evaluate(async () => { for (const j of await window.api.course.jobs()) await window.api.course.jobRemove(j.id) })

const UNITS = ['Hello', 'Colours', 'Numbers', 'Family', 'Review', 'Food']

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userTextbook')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  const dir = path.join(work, 'books'); fs.mkdirSync(dir, { recursive: true })
  const f = n => path.join(dir, n)
  const book = D.makeTextbookPdf(f('课本.pdf'), UNITS, 6)   // 封面 + 目录 + 6 个单元 × 6 页 = 38 页

  // ───────── 1. 教材：目录切单元 → 一个单元一次调用 → 按单元核对 → 保存 ─────────
  {
    const L1 = '教材'
    const ok = await pick(book, { kind: 'textbook' })
    check(L1, '选「教材课本」后读取成功', ok, pick.msg)
    const note = await txt('course-textbook-note').catch(() => '')
    check(L1, '第 1 步说明：共 38 页、认出版本年级学期、单元数 = AI 调用次数、可以取消', /共 38 页，处理 38 页/.test(note) && /人教版 三年级上册/.test(note) && /单元数 = 调用次数/.test(note) && /取消/.test(note), note)
    check(L1, '文字版：不提示 OCR 很慢', !/扫描版/.test(note), note)
    check(L1, '内置目录里有这一册（英语 人教PEP 三年级上册）→ 出现「用内置目录」的提示', (await T('course-catalog-hint').count()) === 1 && /内置/.test(await txt('course-catalog-hint')))
    await shotT('step1')
    await T('course-name').fill('体系-教材')
    mock.quirks = { course: { textbookInvent: true } }
    const before = mock.courseRequests.length
    await T('course-next').click()
    await reviewJob()
    const reqs = mock.courseRequests.slice(before)
    check(L1, '一个单元一次调用：6 次 p5_course_textbook，没有别的 AI 调用', reqs.length === 6 && reqs.every(r => r.courseKind === 'textbook'), reqs.map(r => r.courseKind).join(','))
    const u1 = reqs.find(r => /单元：Unit 1 Hello/.test(r.user))?.user ?? ''
    check(L1, '请求里只有标题 / 小节标题 / 开头几行和候选知识点，没有整本书', /Lesson 1 Hello basics/.test(u1) && /【候选知识点】/.test(u1) && u1.length < 12000, `len=${u1.length}`)
    check(L1, '候选知识点来自当前学科的知识点树（代码 | 路径名称）', (u1.match(/^[A-Z][A-Za-z0-9_.]* \| .+$/gm) ?? []).length >= 20, String((u1.match(/^[A-Z][A-Za-z0-9_.]* \| .+$/gm) ?? []).length))
    check(L1, '请求里没有后面单元的正文（只给当前单元）', !/unit 3\./.test(u1))
    check(L1, '核对步骤是按单元的界面，不是一行一课的表格', (await T('textbook-review').count()) === 1 && (await T('course-lessons').count()) === 0)
    const sum = await txt('textbook-summary')
    check(L1, '一句话：共 6 个单元，有把握不高的（Review 单元一个知识点都没挑出）', /共 6 个单元/.test(sum) && /1 个把握不高/.test(sum), sum)
    check(L1, '低把握的单元（Review）默认展开并标「需核对」；其余折叠', (await T('textbook-unit-5').getAttribute('data-open')) === 'true' && (await T('textbook-unit-flag-5').count()) === 1 && (await T('textbook-unit-1').getAttribute('data-open')) === 'false' && (await T('textbook-unit-2').getAttribute('data-open')) === 'false')
    check(L1, '每个单元显示页码范围（第一个单元 = PDF 第 3–8 页，目录页码和 PDF 页的偏移已对上）', /第 3–8 页/.test(await txt('textbook-unit-toggle-1')), await txt('textbook-unit-toggle-1'))
    // 展开第 1 个单元：看原书那一页
    await T('textbook-unit-toggle-1').click()
    await T('textbook-unit-page-1').click()
    await T('textbook-unit-preview-1').waitFor({ timeout: 20000 })
    const hasImg = await T('textbook-unit-preview-1').locator('img').count()
    const pv = await txt('textbook-unit-preview-1')
    check(L1, '看原书：显示这一页的缩略图和文字', hasImg === 1 && /Unit 1 Hello/.test(pv), pv.slice(0, 80))
    await shotT('review')
    // 给 Review 单元手工加一个知识点（只能从知识点树里选）
    const sel = T('textbook-unit-5').locator('.ant-select').first()
    await sel.click(); await ctx.page.keyboard.type('时'); await sleep(500)
    const opt = ctx.page.locator('.ant-select-tree-title').first()
    const hasOpt = await opt.count()
    if (hasOpt) { await opt.click(); await sleep(300) }
    await ctx.page.keyboard.press('Escape')
    check(L1, '手工给 Review 单元加了知识点后，它不再标「需核对」', hasOpt > 0 && (await T('textbook-unit-flag-5').count()) === 0, `options=${hasOpt}`)
    // 删掉最后一个单元、其余全部确认
    await T('textbook-unit-toggle-6').click()
    await T('textbook-unit-delete-6').click()
    await sleep(300)
    check(L1, '删除一个单元后只剩 5 个', (await ctx.page.locator('[data-testid^=textbook-unit-][data-testid$=""]').count()) >= 0 && (await T('textbook-unit-6').count()) === 0 && /共 5 个单元/.test(await txt('textbook-summary')), await txt('textbook-summary'))
    await T('textbook-confirm-rest').click()
    await sleep(300)
    check(L1, '「其余全部确认」后：已确认个数增加', /已确认 [1-9]\d* 个/.test(await txt('textbook-summary')), await txt('textbook-summary'))
    await T('course-save').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 20000 })
    const o1 = q('SELECT id FROM course_outlines WHERE name = ?', '体系-教材')[0]
    const lessons = o1 ? q('SELECT id, seq, title FROM course_lessons WHERE outline_id = ? ORDER BY seq', o1.id) : []
    // 书库在后台建；小 PDF 可能已经建好、课次已换成书库单元（6 个，含核对时删掉的 Unit 6）。两种情况前 5 个单元都一样
    check(L1, '保存：一个单元一行（AI 整理的 5 行，或书库建好后换成书库的单元），标题是单元名', (lessons.length === 5 || lessons.length === 6) && lessons[0].title === 'Unit 1 Hello' && lessons[4].title === 'Unit 5 Review', JSON.stringify(lessons.map(x => x.title)))
    const maps = o1 ? q('SELECT m.kp_code, m.lesson_id, m.confidence, m.source, m.state, m.locked, (SELECT COUNT(*) FROM kps k WHERE k.code = m.kp_code) inTree FROM course_kp_map m WHERE m.outline_id = ?', o1.id) : []
    check(L1, '知识点写进 course_kp_map，代码全部在知识点树里（AI 编的 ZZ.NOT.IN.TREE 被丢弃）', maps.length >= 8 && maps.every(m => m.inTree === 1) && !maps.some(m => m.kp_code === 'ZZ.NOT.IN.TREE'), `n=${maps.length}`)
    check(L1, '每个单元 2–8 个以内；Review 单元只有手工加的（source=manual，已确认并锁定）', (() => { const by = {}; for (const m of maps) (by[m.lesson_id] ??= []).push(m); return Object.values(by).every(a => a.length <= 8) && (by[lessons[4].id] ?? []).every(m => m.source === 'manual' && m.state === 'confirmed' && m.locked === 1) && (by[lessons[4].id] ?? []).length >= 1 })(), JSON.stringify(maps.filter(m => m.lesson_id === lessons[4].id)))
    check(L1, '「其余全部确认」的单元：知识点已确认并锁定；AI 挑的 source=ai', maps.some(m => m.source === 'ai' && m.state === 'confirmed' && m.locked === 1))
    const kindCol = q("SELECT name FROM pragma_table_info('course_outlines') WHERE name = 'kind'")
    if (kindCol.length) check(L1, 'course_outlines.kind = textbook', q('SELECT kind FROM course_outlines WHERE id = ?', o1.id)[0].kind === 'textbook')
    else check(L1, '库里还没有 kind 列（v15 由另一个子任务加）：保存时忽略它，没有报错', !!o1)
    // 保存整本教材 PDF 后，后台顺带建好“教材书库”（逐页原文 + 单元），可以按原文搜索
    let bk = []
    for (let i = 0; i < 40 && !bk.length; i++) { bk = q("SELECT id, outline_id, total_pages FROM book_files WHERE outline_id = ?", o1.id); if (!bk.length) await sleep(500) }
    check(L1, '书库：保存后自动建好（关联这个课程体系）', bk.length === 1 && bk[0].total_pages > 30, JSON.stringify(bk))
    if (bk.length) {
      const bu = q('SELECT title FROM book_units WHERE book_id = ? ORDER BY seq', bk[0].id)
      const bp = q('SELECT COUNT(*) c FROM book_pages WHERE book_id = ? AND length(text) > 0', bk[0].id)[0].c
      check(L1, '书库：单元和逐页文字都存下来了', bu.length >= 5 && bp > 20, `units=${bu.length} pages=${bp}`)
      const sr = await ctx.page.evaluate(() => window.api.books.search('Unit 1 Hello', { limit: 3 }))
      check(L1, '书库：能按原文搜到', sr.hits.length >= 1, JSON.stringify(sr.hits.slice(0, 1).map(h => [h.page, h.unitTitle])))
      // 书库建好后：教材的课次换成书库切出的单元（不依赖 AI），不再需要匹配；老师手工加的对应按单元保留
      let card = null
      for (let i = 0; i < 40 && !card?.fromBook; i++) { card = (await ctx.page.evaluate(() => window.api.course.list('english'))).find(c => c.id === o1.id); if (!card?.fromBook) await sleep(500) }
      const ls2 = q('SELECT id, title FROM course_lessons WHERE outline_id = ? ORDER BY seq', o1.id)
      check(L1, '书库建好后：课次 = 书库单元，匹配状态为已完成（不用 AI 匹配）', !!card?.fromBook && card.match.state === 'done' && JSON.stringify(ls2.map(x => x.title)) === JSON.stringify(bu.map(x => x.title)), JSON.stringify({ fromBook: card?.fromBook, lessons: ls2.map(x => x.title), units: bu.map(x => x.title) }))
      const rv = ls2.find(x => x.title === 'Unit 5 Review')
      const kept = rv ? q("SELECT source, state, locked FROM course_kp_map WHERE lesson_id = ? AND source = 'manual'", rv.id) : []
      check(L1, '书库建好后：老师手工加在 Unit 5 Review 上的对应还在（按单元搬过去）', kept.length >= 1 && kept.every(m => m.state === 'confirmed' && m.locked === 1), JSON.stringify(kept))
      await goto('#/courses'); await T(`course-card-${o1.id}`).waitFor()
      await T(`course-card-${o1.id}`).locator('[data-testid=course-from-book]').waitFor({ timeout: 10000 }).catch(() => {})
      check(L1, '书库建好后：教材卡片不再显示花 token 的匹配按钮，说明知识点由程序算', (await T(`course-card-${o1.id}`).locator('[data-testid=course-from-book]').count()) === 1 && (await T(`course-card-${o1.id}`).locator('[data-testid=match-start], [data-testid=match-redo]').count()) === 0, (await T(`course-card-${o1.id}`).innerText()).replace(/\s+/g, ' ').slice(0, 200))
    }
    await ctx.page.evaluate(id => window.api.course.remove(id), o1.id)
    mock.quirks = {}
  }

  // ───────── 2. 引用的原文是编的 → 降为低把握，单元标「需核对」 ─────────
  {
    const L2 = '教材·把握'
    mock.quirks = { course: { textbookFake: true } }
    await pick(book, { kind: 'textbook' })
    await T('course-name').fill('体系-编造引用')
    await T('course-next').click()
    await reviewJob()
    const sum = await txt('textbook-summary')
    check(L2, '引用的原文在书里找不到：全部降为低把握，6 个单元都标「需核对」', /6 个把握不高/.test(sum), sum)
    await removeJobs(); await closeWizard()
    mock.quirks = {}
  }

  // ───────── 3. 某个单元失败：任务失败并说明，重试只重做失败的单元 ─────────
  {
    const L3 = '教材·重试'
    mock.quirks = { course: { textbookBadFor: 'Colours' } }
    await pick(book, { kind: 'textbook' })
    await T('course-name').fill('体系-重试')
    const before = mock.courseRequests.length
    await T('course-next').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    const msg = await waitFor(async () => { const m = await T('course-job-error').first().innerText().catch(() => ''); return /没整理成功/.test(m) ? m : null }, 60000)
    check(L3, '失败卡片说明是第 2 个单元、已整理好的保留、点重试', !!msg && /第 2 个单元没整理成功/.test(msg) && /已整理好的 5 个单元已保留/.test(msg) && /重试/.test(msg), String(msg))
    check(L3, '第一次 6 次调用（其余单元照常整理完）', mock.courseRequests.length - before === 6, String(mock.courseRequests.length - before))
    mock.quirks = {}
    const b2 = mock.courseRequests.length
    await T('course-job-retry').first().click()
    const ready = await waitFor(async () => (await ctx.page.locator('[data-testid^=course-job-][data-status=ready]').count()) > 0, 60000)
    const again = mock.courseRequests.slice(b2)
    check(L3, '点重试：只重新调用失败的那 1 个单元（不是 6 个），任务变成待核对', ready && again.length === 1 && /单元：Unit 2 Colours/.test(again[0].user), `n=${again.length}`)
    await removeJobs()
  }

  // ───────── 4. 页数超过课程表上限：提示像是教材；错误提示带页数和上限 ─────────
  {
    const L4 = '页数上限'
    const lines25 = Array.from({ length: 25 }, (_, i) => [`Lesson ${i + 1} Topic ${i + 1}`, 'Words: apple, bread, cake, banana, orange, grape, lemon, peach, melon, mango', 'Pattern: I like apples. Do you like bread? Yes, I do. No, I do not.'])
    D.makeMultiPagePdf(f('二十五页.pdf'), lines25)
    let ok = await pick(f('二十五页.pdf'), { kind: 'auto' })
    check(L4, '自动判断：25 页的 PDF 提示「这像是一整本教材」，说明页数、课程表上限', !ok && pick.msg === 'SUGGEST' && /25 页/.test(await txt('course-textbook-suggest')) && /20 页/.test(await txt('course-textbook-suggest')), await txt('course-textbook-suggest').catch(() => ''))
    await shotT('suggest')
    await T('course-textbook-yes').click()
    const read = await waitFor(async () => (await T('course-textbook-note').count()) > 0, 20000)
    check(L4, '点「按教材课本整理」：读取成功，进入教材方式', read && /共 25 页/.test(await txt('course-textbook-note')), await txt('course-textbook-note').catch(() => ''))
    await closeWizard()
    ok = await pick(f('二十五页.pdf'), { kind: 'course' })
    check(L4, '选「课程表」+ 不限页：提示 25 页超过 20 页上限，并告诉用户可以选页码范围', !ok && /25 页.*20 页.*页码范围/.test(pick.msg), pick.msg)
    await closeWizard()
    ok = await pick(f('二十五页.pdf'), { kind: 'course', range: '1-10' })
    check(L4, '选「课程表」+ 页码范围 1-10：能读', ok, pick.msg)
    await closeWizard()
    ok = await pick(f('二十五页.pdf'), { kind: 'textbook', range: '3-1' })
    check(L4, '页码范围写反：提示范围不对', !ok && /页码范围不对/.test(pick.msg), pick.msg)
    await closeWizard()
    ok = await pick(f('二十五页.pdf'), { kind: 'textbook', range: '20-90' })
    check(L4, '页码超出：提示这份文件一共 25 页', !ok && /一共 25 页.*第 90 页/.test(pick.msg), pick.msg)
    await closeWizard()
    ok = await pick(f('二十五页.pdf'), { kind: 'textbook', range: '5-12, 20' })
    const nt = await txt('course-textbook-note').catch(() => '')
    check(L4, '页码范围 5-12, 20：共 25 页、处理 9 页', ok && /共 25 页，处理 9 页/.test(nt), nt)
    await closeWizard()
    // 教材 301 页超限
    D.makeMultiPagePdf(f('三百零一页.pdf'), Array.from({ length: 301 }, (_, i) => [`Page ${i + 1}`]))
    ok = await pick(f('三百零一页.pdf'), { kind: 'textbook' })
    check(L4, '教材 301 页：提示 301 页超过 300 页上限，可选页码范围', !ok && /301 页.*300 页.*页码范围/.test(pick.msg), pick.msg)
    await closeWizard()
    ok = await pick(f('三百零一页.pdf'), { kind: 'textbook', range: '1-300' })
    check(L4, '教材 301 页 + 页码范围 1-300：能读', ok, pick.msg)
    await closeWizard()
    fs.rmSync(f('三百零一页.pdf'), { force: true })
  }

  // ───────── 5. 大文件 ─────────
  {
    const L5 = '大文件'
    // 501 MB：稀疏文件（不占磁盘），应被拒并说明大小和上限
    fs.writeFileSync(f('超大.pdf'), ''); fs.truncateSync(f('超大.pdf'), 501 * 1024 * 1024)
    let ok = await pick(f('超大.pdf'), { kind: 'textbook' })
    check(L5, '501 MB：提示「文件太大了：501 MB，超过 500 MB 的上限」', !ok && /文件太大了.*501 MB.*500 MB/.test(pick.msg), pick.msg)
    await closeWizard()
    fs.rmSync(f('超大.pdf'), { force: true })

    // 600 MB（稀疏文件）：同样被干净地拒绝，说明实际大小和上限
    fs.writeFileSync(f('六百兆.pdf'), ''); fs.truncateSync(f('六百兆.pdf'), 600 * 1024 * 1024)
    ok = await pick(f('六百兆.pdf'), { kind: 'textbook' })
    check(L5, '600 MB：提示「文件太大了：600 MB，超过 500 MB 的上限」，应用没崩', !ok && /文件太大了.*600 MB.*500 MB/.test(pick.msg), pick.msg)
    await closeWizard()
    fs.rmSync(f('六百兆.pdf'), { force: true })

    // 480 MB 合成教材（接近上限，真实写满）：按教材打开，不崩，主进程内存不随文件大小增长
    const r0 = mb(await rss())
    D.makeTextbookPdf(f('四百八十兆.pdf'), UNITS, 6, { junkBytes: 480 * 1024 * 1024 })
    const sz = fs.statSync(f('四百八十兆.pdf')).size
    const t0 = Date.now()
    ok = await pick(f('四百八十兆.pdf'), { kind: 'textbook', wait: 120000 })
    const r1 = mb(await rss())
    check(L5, `接近上限的合成 PDF（${mb(sz)} MB）按教材打开成功、共 38 页（${Math.round((Date.now() - t0) / 1000)} 秒）`, ok && /共 38 页/.test(await txt('course-textbook-note').catch(() => '')), pick.msg)
    check(L5, `主进程内存没有随文件大小增长（打开前 ${r0} MB → 后 ${r1} MB，增长 < 300 MB）`, r1 - r0 < 300, `${r0} -> ${r1}`)
    await closeWizard()
    fs.rmSync(f('四百八十兆.pdf'), { force: true })

    // 320 MB 合成 PDF 导入试卷
    D.makeTextbookPdf(f('三百二十兆.pdf'), ['A', 'B'], 1, { junkBytes: 320 * 1024 * 1024 })
    const r2 = mb(await rss())
    await goto('#/'); await sleep(500)
    await stubOpen([f('三百二十兆.pdf')])
    const paths = await ctx.page.evaluate(() => window.api.dialog.openFiles())
    const res = await ctx.page.evaluate(p => window.api.papers.import(p), paths)
    check(L5, '320 MB 合成 PDF 导入试卷：登记成功（没有“文件太大”）', res.length === 1 && !res[0].error, JSON.stringify(res).slice(0, 200))
    const done = await waitFor(async () => { const p = (await L.listPapers(ctx.page)).find(x => /三百二十兆/.test(x.file_name)); return p && ['extracted', 'failed'].includes(p.status) }, 240000)
    const paper = (await L.listPapers(ctx.page)).find(p => /三百二十兆/.test(p.file_name))
    const nPages = paper ? q('SELECT COUNT(*) c FROM pages WHERE paper_id = ?', paper.id)[0].c : 0
    const r3 = mb(await rss())
    check(L5, `320 MB PDF 提取完成：status=extracted、${4} 页（封面 + 目录 + 2 页）都渲染了`, !!done && paper?.status === 'extracted' && nPages === 4, `${paper?.status} pages=${nPages}`)
    check(L5, `导入 320 MB 期间主进程内存平稳（${r2} MB → ${r3} MB，增长 < 300 MB），应用没崩`, r3 - r2 < 300 && (await ctx.page.evaluate(() => document.readyState)) === 'complete', `${r2} -> ${r3}`)
    if (paper) await ctx.page.evaluate(id => window.api.papers.remove ? window.api.papers.remove(id) : null, paper.id).catch(() => {})
    fs.rmSync(f('三百二十兆.pdf'), { force: true })
  }

  // ───────── 日志与密钥 ─────────
  const logs = (() => { try { return fs.readdirSync(path.join(ud, 'logs')).map(x => fs.readFileSync(path.join(ud, 'logs', x), 'utf8')).join('\n') } catch { return '' } })()
  check('隐私', '运行日志里没有教材内容、体系名、文件名', logs.length > 0 && !/Colours|Numbers|体系-|课本\.pdf|四百八十兆|三百二十兆|People Education/.test(logs), logs.slice(0, 120))
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-textbook.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-textbook.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
