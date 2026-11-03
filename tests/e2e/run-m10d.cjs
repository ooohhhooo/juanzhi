// 课程大纲 · 多种格式上传端到端：xlsx、csv、Word（有表格 / 没表格）、文字版 PDF、扫描版 PDF（OCR）、png 截图、手机拍照式 jpg（EXIF 旋转）、heic。
// 每种格式：向导里选文件 → 第 2 步核对（截图 docs/screenshots/m10d-*.png）→ 保存 → 在“课程大纲”页出现、课数和标题与夹具一致 → 开始匹配并完成。
// 还有失败路径（空白图片、没有课程内容的 PDF、超大文件、AI 编造的课被去掉）。全程 mock AI，文件现场生成（虚构通用课名）。
// 用法：npm run test:e2e:m10d   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const D = require('./make-course-docs.cjs')
const { reviewJob, check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, cfgFor, saveCfg, startMock, open, closeApp, stubOpen, shots, L } = M

const q = (sql, ...p) => withDb(ctx.ud, d => d.prepare(sql).all(...p))
const shotD = async name => {
  await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {})
  await sleep(600)
  await ctx.page.screenshot({ path: path.join(shots, `m10d-${name}.png`) })
}
const TITLES = ['一般现在时', '一般过去时', '现在进行时']
const EN_TITLES = ['Present Simple', 'Past Simple', 'Present Continuous']
const lastMsg = async () => (await ctx.page.locator('.ant-message-notice').last().innerText().catch(() => '')).replace(/\s+/g, ' ')

/** 打开向导并选这个文件；返回是否读取成功（失败时向导留在第 1 步） */
async function pickFile(file) {
  await goto('#/courses'); await T('course-settings').waitFor()
  if (!(await T('course-wizard').count())) await ((await T('course-add').count()) ? T('course-add') : T('course-add-empty')).first().click()
  await T('course-wizard').waitFor()
  await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {})   // 上一次的提示条先消失，免得误读
  await stubOpen([file])
  await T('course-pick').click()
  // 成功（出现文件名）或失败（弹出提示条，几秒后就消失，所以边等边记）
  let t = 0
  while (t < 15000) {
    if (await T('course-file-name').count()) { pickFile.msg = ''; return true }
    const m = await lastMsg()
    if (m) { pickFile.msg = m; return false }
    await sleep(150); t += 150
  }
  pickFile.msg = ''
  return false
}
const closeWizard = async () => {
  await ctx.page.keyboard.press('Escape').catch(() => {})
  await sleep(300)
  if (await T('course-wizard').count()) { await ctx.page.locator('.ant-modal-close').first().click().catch(() => {}); await sleep(300) }
  await ctx.page.locator('.ant-modal-confirm .ant-btn-dangerous, .ant-modal-confirm .ant-btn-primary').first().click({ timeout: 800 }).catch(() => {})
  await T('course-wizard').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}

/** 完整走一遍：选文件 → 下一步 → 核对 → 保存 → 课程大纲页 → 匹配 → 删除（保持页面只有一个体系，方便下一轮） */
async function runFormat(tag, label, file, expectTitles, o = {}) {
  const name = `体系-${tag}`
  const picked = await pickFile(file)
  check(label, '选择文件后显示“已读取”', picked, picked ? await txt('course-file-name') : (await lastMsg()))
  if (!picked) { await closeWizard(); return }
  if (o.pendingNote) check(label, '第 1 步说明了：约多少字、点“下一步”后由 AI 整理、需要核对', /由 AI 整理成表格，需要你核对/.test(await txt('course-doc-note')), await txt('course-doc-note').catch(() => ''))
  await T('course-name').fill(name)
  const before = M.ctx.mock.courseRequests.length
  await T('course-next').click()
  await reviewJob()
  const reqs = M.ctx.mock.courseRequests.slice(before)
  if (o.extract) check(label, '文字整理：恰好一次 p5_course_extract 调用，请求里带行号，没有认列调用', reqs.length === 1 && reqs[0].courseKind === 'extract' && /\nL1: /.test('\n' + reqs[0].user), reqs.map(r => r.courseKind).join(','))
  else check(label, '表格直接读出来，走认列（p5_course_cols），不调用文字整理', reqs.length >= 1 && reqs.every(r => r.courseKind === 'cols'), reqs.map(r => r.courseKind).join(','))
  const sum = await txt('course-summary')
  check(label, `第 2 步一句话：共 ${expectTitles.length} 课`, new RegExp(`共 ${expectTitles.length} 课`).test(sum), sum)
  if (o.fromDoc) {
    const note = await txt('course-doc-warning').catch(() => '')
    check(label, o.extract ? '第 2 步有醒目提示：这张表是 AI 从文件里整理的，请核对' : '第 2 步有提示：表格取自 Word，请核对', (o.extract ? /AI 从 .* 里整理出来的/ : /直接取自 .* 里的表格/).test(note) && note.includes(o.fromDoc), note)
  }
  const got = []
  for (let i = 0; i < expectTitles.length; i++) got.push(await T(`course-lesson-title-${i}`).inputValue().catch(() => ''))
  if (o.fuzzy) check(label, '核对表里的课程标题和夹具一致（OCR 容许少量差异：每课都包含夹具标题的主要字符）', got.length === expectTitles.length && got.every((g, i) => o.fuzzy(g, expectTitles[i])), JSON.stringify(got))
  else check(label, '核对表里的课程标题和夹具一致', JSON.stringify(got.map(g => g.replace(/^第\s*\d+\s*课\s*/, ''))) === JSON.stringify(expectTitles), JSON.stringify(got))
  if (o.warnRe) check(label, '核对步骤里提示了找不到原文的课', o.warnRe.test(await txt('course-warnings').catch(() => '')), await txt('course-warnings').catch(() => ''))
  await ctx.page.evaluate(() => document.querySelector('.ant-modal-body')?.scrollTo(0, 0))
  await shotD(`${tag}-review`)
  await T('course-save').click()
  await T('course-wizard').waitFor({ state: 'detached', timeout: 20000 })
  const o1 = q('SELECT id, name FROM course_outlines WHERE name = ?', name)[0]
  const lessons = o1 ? q('SELECT title FROM course_lessons WHERE outline_id = ? ORDER BY seq, id', o1.id).map(x => x.title) : []
  const norm = s => s.replace(/^第\s*\d+\s*课\s*/, '')
  check(label, `保存：数据库里有这个体系，课数 = ${expectTitles.length}，标题与夹具一致`, !!o1 && lessons.length === expectTitles.length && (o.fuzzy ? lessons.every((g, i) => o.fuzzy(g, expectTitles[i])) : lessons.every((g, i) => norm(g) === expectTitles[i])), JSON.stringify(lessons))
  const card = o1 ? T(`course-card-${o1.id}`) : null
  check(label, '“课程大纲”页出现这个体系的卡片', !!card && (await card.count()) === 1 && (await card.innerText()).includes(name))
  if (!o1) return
  // 匹配
  await T('match-start').click()
  const done = await waitFor(async () => (await T('match-result').count()) > 0, 60000)
  check(label, '开始匹配并完成', done, done ? await txt('match-result') : '')
  await ctx.page.evaluate(id => window.api.course.remove(id), o1.id)
  await ctx.page.reload(); await sleep(800)
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM10d')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  const page = ctx.page
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  const dir = path.join(work, 'courses'); fs.mkdirSync(dir, { recursive: true })
  const f = n => path.join(dir, n)

  // ── 夹具 ──
  const header = ['课次', '课程标题', '词汇']
  const rows = TITLES.map((t, i) => [String(i + 1), t, ['is / are', 'played / watched', 'reading'][i]])
  await D.makeXlsx(f('课程表.xlsx'), '示例级别', [header, ...rows])
  fs.writeFileSync(f('课程表.csv'), [header, ...rows].map(r => r.join(',')).join('\n'))
  await D.makeDocxTable(f('表格版.docx'), header, rows)
  const textLines = TITLES.flatMap((t, i) => [`第${i + 1}课 ${t}`, `词汇：${rows[i][2]}`])
  await D.makeDocxText(f('无表格版.docx'), ['课程安排（虚构示例）', ...textLines, '以上安排以实际通知为准'])
  const pdfLines = EN_TITLES.map((t, i) => `Lesson ${i + 1} ${t}`)
  D.makeTextPdf(f('文字版.pdf'), ['Course Schedule (sample)', ...pdfLines, 'Please check the final notice before class starts.'])
  const cn = await D.drawImages(page, ['课程安排', ...TITLES.map((t, i) => `第${i + 1}课 ${t}`)])
  const en = await D.drawImages(page, ['Course Schedule', ...EN_TITLES.map((t, i) => `Lesson ${i + 1} ${t}`)])
  fs.writeFileSync(f('截图.png'), cn.png)
  fs.writeFileSync(f('手机拍照.jpg'), cn.rotatedJpg)
  D.makeImagePdf(f('扫描版.pdf'), en.jpg, en.w, en.h)
  fs.writeFileSync(f('英文截图.png'), en.png)
  const heic = D.makeHeic(f('英文截图.png'), f('照片.heic'))

  // OCR 可能有个别字识别偏差：标题里至少 70% 的字符能在读出的文字里找到
  const near = (got, want) => { const g = got.replace(/\s+/g, '').toLowerCase(); const w = want.replace(/\s+/g, '').toLowerCase(); return [...w].filter(c => g.includes(c)).length >= Math.ceil(w.length * 0.7) }

  // ── 各种格式 ──
  await runFormat('xlsx', 'xlsx', f('课程表.xlsx'), TITLES)
  await runFormat('csv', 'csv', f('课程表.csv'), TITLES)
  await runFormat('docx-table', 'Word（有表格）', f('表格版.docx'), TITLES, { fromDoc: 'Word' })
  await runFormat('docx-text', 'Word（没有表格）', f('无表格版.docx'), TITLES, { extract: true, pendingNote: true, fromDoc: 'Word' })
  await runFormat('pdf-text', '文字版 PDF', f('文字版.pdf'), EN_TITLES, { extract: true, pendingNote: true, fromDoc: 'PDF' })
  await runFormat('pdf-scan', '扫描版 PDF（OCR）', f('扫描版.pdf'), EN_TITLES, { extract: true, pendingNote: true, fromDoc: 'PDF', fuzzy: near })
  await runFormat('png', 'png 截图', f('截图.png'), TITLES, { extract: true, pendingNote: true, fromDoc: '图片', fuzzy: near })
  await runFormat('jpg-rotated', '手机拍照 jpg（EXIF 旋转）', f('手机拍照.jpg'), TITLES, { extract: true, pendingNote: true, fromDoc: '图片', fuzzy: near })
  if (heic) await runFormat('heic', 'heic', heic, EN_TITLES, { extract: true, pendingNote: true, fromDoc: '图片', fuzzy: near })
  else check('heic', '系统 sips 不能生成 heic，跳过（非失败）', true)

  // ── AI 编造的课：被程序按原文核对后去掉，并在核对步骤提示 ──
  mock.quirks = { course: { extractInvent: true } }
  await runFormat('invent', 'AI 编造一课', f('无表格版.docx'), TITLES, { extract: true, fromDoc: 'Word', warnRe: /原文里找不到.*凭空多出来的一课/ })
  mock.quirks = {}

  // ── 失败路径：都应给清楚的中文说明，向导留在第 1 步，不落库 ──
  const outlinesBefore = q('SELECT COUNT(*) c FROM course_outlines')[0].c
  {
    const blank = await D.drawImages(page, [])
    fs.writeFileSync(f('空白.png'), blank.png)
    const ok = await pickFile(f('空白.png'))
    const msg = pickFile.msg
    await ctx.page.screenshot({ path: path.join(shots, 'm10d-fail-blank-image.png') })
    check('失败路径', '空白图片：提示“没有读到文字”，不进入下一步', !ok && /图片里没有读到文字/.test(String(msg)), String(msg))
    await closeWizard()
  }
  {
    D.makeTextPdf(f('无课程内容.pdf'), ['Meeting Notes', 'The committee discussed the budget for next year and agreed on a new schedule for the annual picnic.', 'Please bring your own lunch and a water bottle to the park.'])
    const ok = await pickFile(f('无课程内容.pdf'))
    check('失败路径', '没有课程内容的 PDF：能读到文字', ok)
    const before = mock.courseRequests.length
    await T('course-name').fill('不该保存')
    await T('course-next').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    const msg = await waitFor(async () => { const m = await T('course-job-error').first().innerText().catch(() => ''); return /整理出任何一课/.test(m) ? m : null }, 30000)
    await ctx.page.screenshot({ path: path.join(shots, 'm10d-fail-no-course.png') })
    check('失败路径', '没有课程内容的 PDF：AI 整理后卡片显示“没有从PDF里整理出任何一课”，有“重试”和“移除”，没有可核对的结果', !!msg && (await T('course-job-retry').count()) === 1 && (await T('course-job-remove').count()) === 1 && (await T('course-job-review').count()) === 0 && mock.courseRequests.length === before + 1, String(msg))
    await T('course-job-remove').first().click()
    check('失败路径', '点“移除”：卡片消失', await waitFor(async () => (await T('course-job-state').count()) === 0, 8000))
  }
  {
    fs.writeFileSync(f('超大.pdf'), Buffer.alloc(31 * 1024 * 1024))
    const ok = await pickFile(f('超大.pdf'))
    const msg = pickFile.msg
    check('失败路径', '超大文件（31 MB）：提示“文件太大了（超过 30 MB）”', !ok && /文件太大了/.test(String(msg)), String(msg))
    await closeWizard()
    fs.rmSync(f('超大.pdf'), { force: true })
  }
  {
    fs.writeFileSync(f('旧版.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))
    const ok = await pickFile(f('旧版.doc'))
    const msg = pickFile.msg
    check('失败路径', '旧版 .doc：提示另存为 .docx', !ok && /另存为.*\.docx/.test(String(msg)), String(msg))
    await closeWizard()
  }
  check('失败路径', '失败的上传都没有落库', q('SELECT COUNT(*) c FROM course_outlines')[0].c === outlinesBefore)

  // ── 日志与密钥 ──
  const logs = (() => { try { return fs.readdirSync(path.join(ud, 'logs')).map(x => fs.readFileSync(path.join(ud, 'logs', x), 'utf8')).join('\n') } catch { return '' } })()
  check('隐私', '运行日志里没有课程内容、体系名、文件名', logs.length > 0 && !/一般现在时|Present Simple|体系-|课程表\.xlsx|Course Schedule/.test(logs), logs.slice(0, 120))
  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  await closeApp()
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m10d.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m10d.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
