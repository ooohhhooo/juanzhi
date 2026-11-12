// M9 beta.2 端到端：课程对照。全程 mock AI（本地端口），不调用真实服务；课程表全部由程序现场生成（虚构数据）。
//   · 空状态：看板“课程对照”教你怎么开始（三步 + 去上传 + 隐私说明）
//   · 侧栏「课程大纲」页（试卷库下面）：空状态、上传向导：下载虚构示例 → 选文件 → AI 只认列（请求里没有内部代码）→ 预览（每个级别 5 课）→ 改一格 → 保存 → 体系卡片
//   · 匹配：预估规模 → 开始 → 进度 → 完成；课程内容不进日志；quote 不在课次原文里的降为 low
//   · 看板四块：丢分考点 → 课程（数字对得上数据库）、体系 × 级别、常考但没覆盖（含 CSV）、家长沟通建议
//   · 人工修正：点“不对”立即生效，重新匹配不恢复；“我知道是哪一课”；“其实没有”
//   · 家长沟通建议：价格 / 优惠整句删除；未点“我已核对”不能复制；数据变了标“已过期”不能复制
//   · 数据包：默认带课程，导出对话框里取消勾选「课程大纲」则不带；删除体系后回到空状态；草稿的确认
//   · 命令行：course import（草稿 / --i-reviewed）、course list、course match（草稿拒绝）、report generate --with-course 未匹配 → 退出码 15
//   · 浅色 / 深色截图 docs/screenshots/m10a-*.png
// 报告里的课程对照（M9 §1.9）：老师版 / 完整版 / 家长版（截图 docs/screenshots/m10c-*.png）。
// 用法：npm run test:e2e:m10a   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const { DatabaseSync } = require('node:sqlite')
const { spawn } = require('node:child_process')
const JSZip = require('jszip')
const { reviewJob, check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, cfgFor, saveCfg, startMock, open, closeApp, stubSave, stubOpen, shots, root, L } = M

const writeDb = (ud, fn) => { const d = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite')); d.exec('PRAGMA busy_timeout=5000'); d.exec('PRAGMA foreign_keys=ON'); try { return fn(d) } finally { d.close() } }
const q = (sql, ...p) => withDb(ctx.ud, d => d.prepare(sql).all(...p))
const q1 = (sql, ...p) => q(sql, ...p)[0]
/** 截图前等提示条消失、动画结束，免得截到半截的抽屉或盖在内容上的提示 */
const shot10 = async name => { await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {}); await sleep(700); await ctx.page.screenshot({ path: path.join(shots, `m10a-${name}.png`) }) }
/** 报告里的课程对照截图（m10c-） */
const shot10c = async name => { await ctx.page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 8000 }).catch(() => {}); await sleep(700); await ctx.page.screenshot({ path: path.join(shots, `m10c-${name}.png`) }) }
const setTheme = async mode => { await goto('#/'); await ctx.page.evaluate(m => localStorage.setItem('ewb-theme-pref', m), mode); await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }) }
const reload = async () => { await ctx.page.reload(); await sleep(1500) }
const openCourseTab = async () => {
  await setFilter({ grade: '4' }, '#/dashboard')
  await ctx.page.waitForSelector('[data-testid=dashboard]', { timeout: 30000 })
  await ctx.page.getByRole('tab', { name: '课程对照' }).click()
}
/** 某个二级考点（含三级）的「主要匹配」课数：匹配分过线或老师确认过、每节课最多 3 个主知识点（不含被否决的）。按主进程算出来的角色数，和界面同一口径 */
const dbMain2 = async code => {
  const id = q1('SELECT id FROM course_outlines').id
  const rows = await ctx.page.evaluate(i => window.api.course.maps(i), id)
  return new Set(rows.filter(r => r.role === 'main' && (r.kp === code || r.kp.startsWith(code + '.'))).map(r => r.lessonId)).size
}
const clipboard = () => ctx.app.evaluate(({ clipboard }) => clipboard.readText())
const FORBID = /优惠|折扣|报名|价格|保证|提分|\d+\s*元/

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM10a')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  // 让 mock 能按“例词”把知识点对到课：给要用的几个知识点写上例词（与虚构示例课程里的词汇对得上）
  writeDb(ud, db => {
    const set = db.prepare('UPDATE kps SET hint_words = ?, plain = COALESCE(NULLIF(plain, \'\'), ?) WHERE code = ?')
    set.run('played / watched', '说过去发生的事', 'GR.TENSE.PAST.REG')
    set.run('taller', '比较两个人或物', 'GR.ADJ.COMPARE.REG')
    set.run('dress / expensive', '购物时的说法', 'FN.SHOP')
    set.run('dress / expensive', '购物时的说法', 'FN.SHOP.PRICE')
    set.run('visited', '说过去的经历', 'GR.TENSE.PAST.IRREG')
  })
  await open(ud)
  const page = ctx.page
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)

  // ───────────────────────── 1. 空状态 ─────────────────────────
  {
    await openCourseTab()
    const empty = await T('course-empty').waitFor({ timeout: 15000 }).then(() => true, () => false)
    const t = empty ? await txt('course-empty') : ''
    check('空状态', '没有上传课程大纲：看板“课程对照”页签是教学型空状态（标题、三步说明、去上传、隐私说明）', empty && /丢分的考点在哪一课讲/.test(t) && /上传课程表/.test(t) && /核对 AI 整理的结果/.test(t) && /开始匹配/.test(t) && (await T('course-go-upload').count()) === 1 && /不会发给卷知开发者/.test(await page.locator('body').innerText()), t.slice(0, 160))
    check('空状态', '不显示任何“默认课程”', !/示例体系|基础级/.test(t))
    await shot10('empty-light')
    await T('course-go-upload').click()
    check('空状态', '点“去上传课程大纲”：跳到侧栏的“课程大纲”页（侧栏该项高亮）', await waitFor(async () => (await T('course-settings').count()) > 0 && (await page.evaluate(() => location.hash)) === '#/courses', 8000) && (await page.locator('.ewb-contents__link[aria-current=page]').first().getAttribute('aria-label').catch(() => '')) === '课程' && (await T('nav-tabs').count()) === 1)
  }

  // ───────────────────────── 2. 上传向导 ─────────────────────────
  const sampleXlsx = path.join(work, '课程表示例（虚构）.xlsx')
  {
    await goto('#/courses'); await T('course-settings').waitFor()
    await shot10('courses-empty-light')
    check('空状态', '课程大纲页空状态：说明它是做什么的，有“添加课程大纲”主按钮、“下载空白模板”、“看示例”', (await T('course-add-empty').count()) === 1 && (await T('course-empty-blank').count()) === 1 && (await T('course-empty-sample').count()) === 1 && /课程表/.test(await txt('courses-page')))
    await T('course-add-empty').click()
    await T('course-wizard').waitFor()
    // 下载虚构示例 / 空白模板（程序运行时生成）
    await stubSave(sampleXlsx)
    await T('course-template-sample').click()
    check('向导', '“下载示例（虚构数据）”：运行时生成 .xlsx（两个级别 × 5 课）', await waitFor(() => fs.existsSync(sampleXlsx), 8000))
    const z = await JSZip.loadAsync(fs.readFileSync(sampleXlsx))
    const wbXml = await z.file('xl/workbook.xml').async('string')
    check('向导', '示例文件里是两张工作表：基础级、进阶级；内容是虚构的', /基础级/.test(wbXml) && /进阶级/.test(wbXml) && /示例教材/.test(await z.file('xl/worksheets/sheet1.xml').async('string')))
    const blankXlsx = path.join(work, '模板.xlsx')
    await stubSave(blankXlsx)
    await T('course-template-blank').click()
    check('向导', '“下载空白模板”：只有表头（课次 / 级别 / 主题 / 课程标题 / …）', await waitFor(() => fs.existsSync(blankXlsx), 8000) && /课程标题/.test(await (await JSZip.loadAsync(fs.readFileSync(blankXlsx))).file('xl/worksheets/sheet1.xml').async('string')))

    check('向导', '第 1 步有醒目的隐私说明，并提供“手动指定每一列”', /不会发给卷知开发者/.test(await txt('course-wizard')) && (await T('course-mode-manual').count()) === 1)
    await stubOpen([sampleXlsx])
    await T('course-pick').click()
    await T('course-file-name').waitFor({ timeout: 10000 })
    check('向导', '选文件后显示“已读取”，名称默认取文件名', /已读取/.test(await txt('course-file-name')) && (await T('course-name').inputValue()) === '课程表示例（虚构）')
    await T('course-name').fill('示例体系 A')
    await T('course-term').fill('示例学期')
    await shot10('wizard-step1-light')
    mock.resetStats()
    await T('course-next').click()
    // 点“开始整理”后弹窗立刻关闭，卡片在课程大纲页里整理；整理好再点“核对并保存”
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    check('后台整理', '点“开始整理”后弹窗关闭，列表里出现这个文件的任务卡片', (await page.locator('[data-testid^=course-job-][data-status]').count()) === 1 && (await T('course-job-name').first().innerText()) === '课程表示例（虚构）')
    await reviewJob()
    const cols = mock.courseRequests.filter(r => r.courseKind === 'cols')
    check('向导', '让 AI 认列：每张工作表一次调用（共 2 次），提示词只有预览行，没有内部代码', cols.length === 2 && cols.every(r => !/\b[A-Z]{2}\.[A-Z]+/.test(r.user)) && cols[0].jsonMode === true, `cols=${cols.length}`)
    const sum = await txt('course-summary')
    check('向导', '第 2 步一句话：识别到 2 个级别、共 10 课', /识别到 2 个级别、共 10 课/.test(sum), sum)
    check('向导', '列识别条：每列有类型下拉，课次 / 课程标题 / 词汇 / 句型被认出来', (await T('course-col-0').inputValue()) === 'seq' && (await T('course-col-3').inputValue()) === 'title' && (await T('course-col-5').inputValue()) === 'word' && (await T('course-col-6').inputValue()) === 'pattern')
    check('向导', '左侧是级别列表（基础级 5 课 / 进阶级 5 课），右侧是该级别的课次表，内容原样来自单元格', /基础级[\s\S]*5 课/.test(await txt('course-levels')) && (await T('course-lesson-title-4').inputValue()) === '第 5 课 Animals')
    // 改一格
    await T('course-lesson-title-4').fill('第 5 课 Animals（已核对）')
    await T('course-level-1').click()
    check('向导', '可以切到另一个级别查看；改过的格子在切换后还在', (await T('course-lesson-title-0').inputValue()) === '第 1 课 My day')
    await T('course-level-0').click()
    check('向导', '切回来时改过的格子保持', (await T('course-lesson-title-4').inputValue()) === '第 5 课 Animals（已核对）')
    const modalScroll = y => page.evaluate(v => { const b = document.querySelector('.ant-modal-body'); if (b) b.scrollTo(0, v) }, y)
    await modalScroll(0); await shot10('wizard-step2-light')
    await modalScroll(99999); await shot10('wizard-step2-lessons-light')
    await modalScroll(0)
    check('向导', '保存之前什么都没落库', q1('SELECT COUNT(*) c FROM course_outlines').c === 0)
    await T('course-save').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    const o = q1('SELECT * FROM course_outlines')
    check('保存', '保存成功：体系、2 个级别、10 课，场景 org，备注保存了', o && o.name === '示例体系 A' && o.scene === 'org' && o.term_note === '示例学期' && o.status === 'active' && o.active === 1 && o.rev === 1 && q1('SELECT COUNT(*) c FROM course_levels').c === 2 && q1('SELECT COUNT(*) c FROM course_lessons').c === 10, JSON.stringify(o))
    check('保存', '改过的格子存进去了；原行单元格保真；不含价格列', q1("SELECT title FROM course_lessons WHERE title LIKE '%已核对%'")?.title === '第 5 课 Animals（已核对）' && /词汇/.test(q1('SELECT raw_json FROM course_lessons LIMIT 1').raw_json))
    check('保存', '卡片出现，匹配状态“未匹配”，没有任何 AI 匹配结果', (await T('course-match-state').first().innerText()) === '未匹配' && q1('SELECT COUNT(*) c FROM course_kp_map').c === 0)
  }

  // ───────────────────────── 3. 匹配 ─────────────────────────
  const oid = q1('SELECT id FROM course_outlines').id
  {
    const est = await T('match-estimate').innerText()
    check('匹配', '开始之前先显示规模和预计用量（课数、程序直接认出几课、交给 AI 补充几课、token），用户点了才调用', /10 课里约 \d+ 课由程序直接认出/.test(est) && /预计用量约/.test(est) && mock.courseRequests.filter(r => r.courseKind === 'match').length === 0, est)
    mock.resetStats()
    mock.courseDelayMs = 700
    await T('match-start').click()
    const prog = await T('match-progress').waitFor({ timeout: 10000 }).then(() => true, () => false)
    const progText = await waitFor(async () => { const t = await txt('match-progress').catch(() => ''); return /第 \d+ 步，共 \d+ 步/.test(t) ? t : null }, 8000)
    check('匹配', '匹配时显示进度（第几步 / 共几步）和“取消”', prog && !!progText && (await T('match-cancel').count()) === 1, String(progText))
    await shot10('match-progress-light')
    await waitFor(async () => (await T('match-result').count()) > 0, 60000)
    mock.courseDelayMs = 0
    const res = await txt('match-result')
    const m = mock.courseRequests.filter(r => r.courseKind === 'match')
    check('匹配', '完成：提示“匹配完成”，卡片状态变成“已匹配”', /匹配完成/.test(res) && (await T('course-match-state').first().innerText()) === '已匹配', res)
    check('匹配', '发给 AI 的匹配请求：课程行带 #编号，知识点是 K1 K2…，没有内部代码，没有文件名', m.length >= 1 && m.every(r => /#\d+ \|/.test(r.user) && /\nK1 \| /.test(r.user) && !/\b(GR|PH|RD|FN|VO)\.[A-Z]/.test(r.user) && !r.user.includes('课程表示例')) && m.every(r => r.jsonMode), `n=${m.length}`)
    const maps = q('SELECT kp_code, lesson_id, confidence, quote, state, locked, source FROM course_kp_map')
    check('匹配', '落库：有对应；每条高把握的对应都带依据（AI 的原文片段 quote / 规则命中的词），并且它真的出现在那一课的文本里', maps.length >= 3 && maps.filter(x => x.confidence === 'high').every(x => x.quote && x.quote.split('、').every(w => q1('SELECT search_text FROM course_lessons WHERE id = ?', x.lesson_id).search_text.toLowerCase().includes(w.toLowerCase()))), `maps=${maps.length}`)
    const past = q('SELECT l.title FROM course_kp_map m JOIN course_lessons l ON l.id = m.lesson_id WHERE m.kp_code = ?', 'GR.TENSE.PAST.REG').map(x => x.title)
    check('匹配', '“一般过去时·规则变化”（例词 played / watched）对到了“第 3 课 Last weekend”', past.includes('第 3 课 Last weekend'), JSON.stringify(past))
    check('匹配', '检查结果缓存：每个知识点一行（含“看过但没找到”），记录体系版本号和模型', q1("SELECT COUNT(*) c FROM course_kp_check WHERE result = 'none'").c >= 1 && q1('SELECT COUNT(*) c FROM course_kp_check WHERE outline_rev = 1').c === q1('SELECT COUNT(*) c FROM course_kp_check').c)
    check('匹配', '用量记在 ai_usage（认列 + 匹配）', q1("SELECT COUNT(*) c FROM ai_usage WHERE kind = 'course-match'").c === m.length && q1("SELECT COUNT(*) c FROM ai_usage WHERE kind = 'course-cols'").c === 2)
    const logs = (() => { try { return fs.readdirSync(path.join(ud, 'logs')).map(f => fs.readFileSync(path.join(ud, 'logs', f), 'utf8')).join('\n') } catch { return '' } })()
    check('隐私', '运行日志里没有课程内容、体系名、文件名', logs.length > 0 && !/Last weekend|示例体系|课程表示例|示例教材|Animals/.test(logs), logs.slice(0, 120))
  }

  // ───────────────────────── 4. 看板四块 ─────────────────────────
  {
    await openCourseTab()
    await T('course-headline').waitFor({ timeout: 20000 })
    const head = await txt('course-headline')
    const rows = await page.locator('[data-testid^=course-row-]').evaluateAll(els => els.map(e => ({ code: e.getAttribute('data-testid').replace('course-row-', ''), main: Number(e.getAttribute('data-main')) })))
    const withCourse = rows.filter(r => r.main > 0).length
    check('看板', '一句大字结论：“最容易出错的 N 个考点，M 个在「示例体系 A」里能找到对应的课，K 个没有课讲到”，三个数字和行数、有无对应课的行数一致', new RegExp(withCourse === rows.length ? `最容易出错的 ${rows.length} 个考点，在「示例体系 A」里都能找到对应的课` : withCourse === 0 ? `最容易出错的 ${rows.length} 个考点，在「示例体系 A」里都还没有找到对应的课` : `最容易出错的 ${rows.length} 个考点，${withCourse} 个在「示例体系 A」里能找到对应的课，${rows.length - withCourse} 个还没有课讲到`).test(head), `${head} rows=${rows.length} with=${withCourse}`)
    // 数字和数据库独立核对：二级考点“一般过去时”名下所有知识点的高 / 中把握对应
    const dbMain = dbMain2
    const pastRow = rows.find(r => r.code === 'GR.TENSE.PAST')
    check('看板', '块 1：“一般过去时”这一行的课程数 = 它名下（含三级）的主要匹配课数（匹配分过线、每课最多 3 个）', !!pastRow && pastRow.main === await dbMain('GR.TENSE.PAST') && pastRow.main >= 1, JSON.stringify(pastRow))
    const chip = await page.locator('[data-testid=course-row-GR\\.TENSE\\.PAST] [data-testid=course-chip]').first().innerText()
    check('看板', '课程胶囊写“体系 · 级别 · 第 N 课《标题》”', /示例体系 A · 进阶级 · 第 3 课《Last weekend》/.test(chip), chip)
    check('看板', '行上有“易错”标签和白话释义', /易错/.test(await txt('course-row-GR.TENSE.PAST')))
    const cross = await txt('course-cross')
    check('看板', '块 2：体系 × 级别交叉表，格子里写“N 个”和“约占分值 X%”', /示例体系 A/.test(cross) && /基础级/.test(cross) && /进阶级/.test(cross) && /\d+ 个/.test(cross) && /约占分值 \d+%/.test(cross), cross.replace(/\s+/g, ' ').slice(0, 160))
    const g = await T('course-block3').innerText()
    check('看板', '块 3：常考但课程没覆盖——有结论或明确说明都没覆盖的考点（不是空白）', /没有找到对应的课/.test(g) || /都能找到对应的课/.test(g) || /样本太少/.test(g), g.slice(0, 120))
    check('看板', '块 4：家长沟通建议——未生成时有说明和“生成”按钮，标“AI 草稿”', (await T('advice-run').count()) === 1 && /AI 草稿/.test(await txt('course-block4')))
    await shot10('dashboard-light')
  }

  // ───────────────────────── 5. 人工修正 ─────────────────────────
  {
    const before = await page.locator('[data-testid=course-row-GR\\.TENSE\\.PAST] [data-testid=course-chip]').count()
    await page.locator('[data-testid=course-row-GR\\.TENSE\\.PAST] [data-testid=course-chip]').first().click()
    await T('course-drawer').waitFor()
    check('修正', '点课程胶囊：右侧抽屉显示课次详情、AI 的理由和课程里的原文依据、这个考点在原卷里的题', /课程详情/.test(await txt('course-drawer')) && (await T('course-quote').count()) === 1 && /原卷里/.test(await txt('course-drawer')) && (await T('course-lesson-info').count()) === 1)
    await shot10('drawer-light')
    mock.resetStats()
    await T('course-reject-map').click()
    await waitFor(() => q("SELECT 1 FROM course_kp_map WHERE state = 'rejected'").length === 1, 8000)
    const rejRow = q1("SELECT kp_code, lesson_id, state, locked FROM course_kp_map WHERE state = 'rejected'")
    const lessonId = rejRow.lesson_id, rejKp = rejRow.kp_code
    check('修正', '点“不对”：这条对应变成 rejected 并锁定', rejRow.state === 'rejected' && rejRow.locked === 1, JSON.stringify(rejRow))
    // 同一课也可能经另一个三级知识点（比如“不规则变化”的例词 visited）对到这个考点，所以按数据库重算期望值
    check('修正', '看板上的数字立即变化（按数据库重算：被否决的不再算），并且没有再调用 AI', await waitFor(async () => Number(await T('course-row-GR.TENSE.PAST').getAttribute('data-main')) === await dbMain2('GR.TENSE.PAST'), 8000) && mock.courseRequests.length === 0, `before=${before}`)
    // 重新匹配不恢复被否决的、不覆盖锁定的
    await goto('#/courses'); await T('course-settings').waitFor()
    mock.resetStats()
    await T('match-redo').first().click()
    await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
    await waitFor(async () => mock.courseRequests.filter(r => r.courseKind === 'match').length >= 1, 30000)
    await waitFor(async () => (await T('match-result').count()) > 0, 60000)
    const rej2 = q1('SELECT state, locked FROM course_kp_map WHERE lesson_id = ? AND kp_code = ?', lessonId, rejKp)
    check('修正', '重新匹配后：被否决的对应没有被 AI 加回，仍是 rejected 且锁定', rej2.state === 'rejected' && rej2.locked === 1)
    // 故障：quote 不在课次原文里 → 降为 low，标“仅凭主题推测”；不存在的课次被丢弃
    mock.quirks = { course: { matchBadQuote: true, matchBadLesson: true } }
    await T('match-redo').first().click()
    await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
    await waitFor(async () => (await T('match-result').count()) > 0 && /匹配完成/.test(await txt('match-result')), 60000)
    const bad = q("SELECT confidence, reason, quote, state FROM course_kp_map WHERE source = 'ai' AND state = 'suggested'")
    check('防幻觉', 'quote 不在课次原文里：降为 low、reason 标“仅凭主题推测”、不保存假的 quote；AI 给的不存在的课次(#999999)被丢弃', bad.length > 0 && bad.some(x => x.confidence === 'low' && /^仅凭主题推测/.test(x.reason) && x.quote === '') && q1('SELECT COUNT(*) c FROM course_kp_map WHERE lesson_id = 999999').c === 0, JSON.stringify(bad.slice(0, 2)))
    check('防幻觉', '界面提示有条回答对不上课程已丢弃', /已丢弃/.test(await txt('match-result')), await txt('match-result'))
    mock.quirks = {}
    // 回到看板
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 })
    // “我知道是哪一课”：找一个没有对应课的行
    const none = await page.locator('[data-testid^=course-row-][data-main="0"]').first()
    if (await none.count()) {
      const code = (await none.getAttribute('data-testid')).replace('course-row-', '')
      await none.locator('[data-testid=course-know]').click()
      await T('lesson-picker').waitFor()
      await T('lesson-picker-q').fill('Shopping')
      await page.locator('[data-testid=lesson-picker-item]').first().waitFor()
      await page.locator('[data-testid=lesson-picker-item] button').first().click()
      await waitFor(() => q1("SELECT COUNT(*) c FROM course_kp_map WHERE source = 'manual'").c >= 1, 8000)
      const man = q1("SELECT state, locked, confidence FROM course_kp_map WHERE source = 'manual'")
      check('修正', '“我知道是哪一课”：搜课、点一课 → 记为老师手工指定（confirmed、锁定）', man.state === 'confirmed' && man.locked === 1 && man.confidence === 'high', code)
    } else check('修正', '（夹具里没有“没有对应课”的行，跳过手工添加）', true)
  }

  // ───────────────────────── 6. 块 3：没覆盖 + CSV ─────────────────────────
  {
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 })
    const csv = path.join(work, 'gaps.csv')
    if (await T('course-export-gaps').count()) {
      await stubSave(csv)
      await T('course-export-gaps').click()
      await waitFor(() => fs.existsSync(csv), 8000)
      const buf = fs.readFileSync(csv)
      check('没覆盖', '导出 CSV：带 BOM（Excel 直接打开），有说明、范围、课程体系和表头', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf && /AI 匹配的结果，请教研核对/.test(buf.toString('utf8')) && /考点,出现份数,总份数,题数,AI 估计易错题数/.test(buf.toString('utf8')))
    } else check('没覆盖', '（这批卷子里所选课程都有对应，没有“没覆盖”的考点，跳过 CSV）', true)
  }

  // ───────────────────────── 7. 家长沟通建议 ─────────────────────────
  {
    mock.resetStats()
    await T('advice-run').click()
    await waitFor(async () => (await T('advice-confirm').count()) > 0, 60000)
    const adviceReq = mock.courseRequests.filter(r => r.courseKind === 'advice')
    check('话术', '生成：只调用一次 p5_course_advice；输入里有课令牌 [课#N]、没有内部代码、没有价格 / 机构词', adviceReq.length === 1 && /\[课#\d+\]/.test(adviceReq[0].user) && !/\b(GR|PH|RD|FN|VO)\.[A-Z]/.test(adviceReq[0].user) && !FORBID.test(adviceReq[0].system.replace(/价格、费用、优惠、折扣、报名[^\n]*/g, '')))
    const text = await txt('advice-text')
    const row = q1('SELECT * FROM course_advice')
    check('话术', '结果：令牌已换成完整课名，没有 [课#N]；存进 course_advice，confirmed_at 为空', /示例体系 A · /.test(text) && !/\[课#/.test(text) && row && row.markdown && row.confirmed_at === null, text.slice(0, 120))
    check('话术', '标“AI 草稿 · 请老师核对”；未点“我已核对”时“复制给家长”是灰的', /AI 草稿/.test(await txt('advice-panel')) && (await T('advice-copy').isDisabled()) && (await T('advice-copy-hint').count()) === 1)
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('旧内容'))
    let blocked = false
    try { await page.evaluate(() => window.api.course.adviceCopy({ filter: { grade: '4' }, outlineIds: [] })) } catch { blocked = true }
    const tryCopy = await page.evaluate(async id => { try { await window.api.course.adviceCopy({ filter: { grade: '4' }, outlineIds: [id] }); return 'ok' } catch (e) { return String(e.message) } }, oid)
    check('话术', '主进程也拦着：没核对时直接调用复制接口会被拒绝，剪贴板没有变', blocked !== undefined && /我已核对/.test(tryCopy) && (await clipboard()) === '旧内容', tryCopy)
    await T('course-block4').scrollIntoViewIfNeeded()
    await shot10('advice-light')
    await T('advice-confirm').click()
    await T('advice-confirm-modal').waitFor()
    const acks = await T('advice-ack').count()
    for (let i = 0; i < acks; i++) await T('advice-ack').nth(i).click()
    await T('advice-confirm-ok').click()
    await waitFor(async () => !(await T('advice-copy').isDisabled()), 10000)
    check('话术', '点“我已核对”后（未核实的句子要逐句确认）才能复制；confirmed_at 写入', !(await T('advice-copy').isDisabled()) && q1('SELECT confirmed_at FROM course_advice').confirmed_at !== null)
    await T('advice-copy').click()
    await waitFor(async () => (await clipboard()) !== '旧内容', 8000)
    const clip = await clipboard()
    check('话术', '复制的是正文（没有“未核实”标记），可以粘贴到微信', clip.length >= 100 && !/〔/.test(clip) && /示例体系 A/.test(clip), clip.slice(0, 80))
    // 故障：价格 / 优惠 / 保证提分 整句删除；不存在的课令牌删除并告警；重新生成后要重新核对
    mock.quirks = { course: { advicePrice: true, adviceBadToken: true } }
    await T('advice-run').click()
    await page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
    await waitFor(async () => (await T('advice-confirm').count()) > 0, 60000)
    const bad = await txt('advice-text')
    check('话术', '价格 / 优惠 / 保证提分的句子整句删除；不存在的课令牌删除并告警', !FORBID.test(bad) && !/\[课#/.test(bad) && /已删除 \d+ 句含价格/.test(await txt('advice-panel')) && /无法核对的课程引用/.test(await txt('advice-panel')), bad.slice(0, 100))
    check('话术', '重新生成后需要重新核对：confirmed_at 清空，复制又变灰', q1('SELECT confirmed_at FROM course_advice').confirmed_at === null && (await T('advice-copy').isDisabled()))
    mock.quirks = {}
    // 数据变了 → 已过期，不能复制
    await T('advice-confirm').click(); await T('advice-confirm-modal').waitFor()
    for (let i = 0, n = await T('advice-ack').count(); i < n; i++) await T('advice-ack').nth(i).click()
    await T('advice-confirm-ok').click()
    await waitFor(async () => !(await T('advice-copy').isDisabled()), 10000)
    // 知识点的白话释义变了（话术提示词里用到它）：缓存键必变；写库后重新打开看板
    writeDb(ud, db => db.prepare("UPDATE kps SET plain = '改过的白话说明' WHERE code = 'GR.TENSE.PAST'").run())
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 })
    check('话术', '数据有变化（知识点说明改了）：建议标“已过期”，不再允许复制（不自动重新生成）', await waitFor(async () => (await T('advice-stale').count()) > 0 && (await T('advice-copy').isDisabled()), 10000))
    check('话术', '没有自动重新生成：话术请求总数没有增加', mock.courseRequests.filter(r => r.courseKind === 'advice').length === 2)
  }

  // ───────────────────────── 7b. 报告里的课程对照（m10c-） ─────────────────────────
  {
    const reportRows = () => q('SELECT * FROM reports ORDER BY created_at, rowid')
    const partsOf = id => Object.fromEntries(q('SELECT part, status, message FROM report_parts WHERE report_id = ?', id).map(p => [p.part, p]))
    const pickReader = async r => { await T(`reader-${r}`).locator('xpath=ancestor::label').click(); await sleep(400) }
    const gen = async (reader, { course = true, hint = true } = {}) => {
      const before = reportRows().length
      await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
      if (await T('report-dismiss').count()) await T('report-dismiss').click()
      await pickReader(reader)
      if (course) {
        await T('report-course-check').locator('xpath=ancestor::label').click()
        await T('report-course-list').waitFor({ timeout: 8000 })
        if (reader === 'parent' && !hint) await T('report-course-hint').locator('xpath=ancestor::label').click()
      }
      await sleep(400)
      await T('report-generate').click()
      const done = await waitFor(() => {
        const rows = reportRows()
        if (rows.length <= before) return false
        const ps = q('SELECT status FROM report_parts WHERE report_id = ?', rows[rows.length - 1].id)
        return ps.length > 0 && ps.every(x => x.status !== 'running')
      }, 120000, 500)
      await sleep(1200)
      const row = reportRows()[reportRows().length - 1]
      return { ok: !!done, row, parts: partsOf(row.id) }
    }

    // 老板版：不支持课程对照
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    await pickReader('boss')
    check('报告课程', '老板版：“加入课程对照”不可勾，并写明老板版不加', (await T('report-course-check').isDisabled()) && (await T('report-course-boss-hint').count()) === 1)

    // 老师版
    mock.resetStats()
    const t = await gen('teacher')
    const opt = JSON.parse(t.row.options_json ?? 'null')
    check('报告课程', '老师版：勾选的体系随报告保存（reports.options_json = {course:{outlineIds:[…]}}），列表上有“含课程对照”标签', t.ok && opt?.course?.outlineIds?.length === 1 && opt.course.outlineIds[0] === oid && (await page.locator(`[data-testid=report-item-${t.row.id}]`).innerText()).includes('含课程对照'), t.row.options_json)
    const tMd = t.row.markdown
    check('报告课程', '老师版：新小节“课程对照与选课建议”（课程列表由程序拼）+ 子节“可发给家长的话”，课程段状态 ok', t.parts.course_teacher?.status === 'ok' && /## 课程对照与选课建议/.test(tMd) && /### 可发给家长的话/.test(tMd) && /示例体系 A · /.test(tMd) && !/\[课#/.test(tMd), JSON.stringify(t.parts.course_teacher))
    check('报告课程', '老师版：话术只调用一次 p5_course_advice，不调用家长一句话；课程小节在“学习进步建议”之前', mock.courseRequests.filter(r => r.courseKind === 'advice').length === 1 && mock.courseRequests.filter(r => r.courseKind === 'hint').length === 0 && tMd.indexOf('课程对照与选课建议') < tMd.indexOf('学习进步建议'))
    check('报告课程', '老师版：话术里没有价格 / 优惠 / 保证提分', !FORBID.test(tMd.slice(tMd.indexOf('### 可发给家长的话'))))
    await T('report-copy-advice').waitFor({ timeout: 10000 })
    check('报告课程', '“复制给家长”在没点“我已核对”前是灰的', await T('report-copy-advice').isDisabled())
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('旧内容'))
    const tryCopy = await page.evaluate(async id => { try { await window.api.report.copyCourseAdvice(id); return 'ok' } catch (e) { return String(e.message) } }, t.row.id)
    check('报告课程', '主进程也拦着：没核对时直接调用复制接口被拒绝，剪贴板没变', /我已核对/.test(tryCopy) && (await clipboard()) === '旧内容', tryCopy)
    await T('report-body').scrollIntoViewIfNeeded().catch(() => {})
    await shot10c('teacher-light')
    await T('report-confirm').click(); await T('confirm-dialog').waitFor()
    await T('confirm-ok').click()
    await waitFor(async () => !(await T('report-copy-advice').isDisabled()), 10000)
    await T('report-copy-advice').click()
    await waitFor(async () => (await clipboard()) !== '旧内容', 8000)
    const clipT = await clipboard()
    check('报告课程', '点“我已核对”后才能复制；复制的是那一段话（没有“未核实”标记和 AI 草稿提示）', clipT.length >= 100 && !/〔|AI 草稿/.test(clipT) && /示例体系 A/.test(clipT), clipT.slice(0, 80))

    // 过期：课程体系 rev 变了 → 已过期；改回来 → 又是最新（只改 rev，不碰对应）
    await goto('#/report'); await T('report-page').waitFor()
    const itemSel = `[data-testid=report-item-${t.row.id}]`
    await page.locator(itemSel).waitFor()
    const was = await page.locator(itemSel).getAttribute('data-status')
    writeDb(ud, db => db.prepare('UPDATE course_outlines SET rev = rev + 1 WHERE id = ?').run(oid))
    await page.reload(); await T('report-page').waitFor(); await page.locator(itemSel).waitFor()
    const stale = await waitFor(async () => (await page.locator(itemSel).getAttribute('data-status')) === 'stale', 10000)
    check('报告课程', '课程体系内容更新（rev + 1）：这份带课程对照的报告显示“已过期”，且没有自动重新生成', was === 'fresh' && !!stale && reportRows().length === 1 + 0 + reportRows().length - 1)
    writeDb(ud, db => db.prepare('UPDATE course_outlines SET rev = rev - 1 WHERE id = ?').run(oid))
    await page.reload(); await T('report-page').waitFor(); await page.locator(itemSel).waitFor()
    check('报告课程', '改回去后又是“最新”', await waitFor(async () => (await page.locator(itemSel).getAttribute('data-status')) === 'fresh', 10000))

    // 完整版
    mock.resetStats()
    const f = await gen('full')
    const fMd = f.row.markdown
    check('报告课程', '完整版：末尾“课程对照”表（知识点 | 出现份数 | AI 估计易错题数 | 对应课程 | 把握），全部由程序拼，没有任何 AI 课程请求', f.parts.course_full?.status === 'ok' && /## 课程对照\n/.test(fMd) && fMd.includes('| 知识点 | 出现份数 | AI 估计易错题数 | 对应课程（最多 3 课） | 把握 |') && mock.courseRequests.length === 0, JSON.stringify(f.parts.course_full))
    check('报告课程', '完整版：表在文末（没有“学习进步建议”之后的别的小节），对应课程是完整课名', fMd.lastIndexOf('## 课程对照') > fMd.lastIndexOf('\n## ', fMd.lastIndexOf('## 课程对照') - 1) && /\| .*示例体系 A · .*\|/.test(fMd))
    await T('report-body').scrollIntoViewIfNeeded().catch(() => {})
    await page.locator('table').last().scrollIntoViewIfNeeded().catch(() => {})
    await shot10c('full-light')

    // 家长版（带一句话）
    mock.resetStats()
    const pa = await gen('parent')
    const pMd = pa.row.markdown
    const pWx = await page.evaluate(id => window.api.report.get(id).then(r => r.chars), pa.row.id)
    const kept = /这类题常见易错/.test(pMd)
    const pWarn = JSON.parse(pa.row.warnings_json ?? '[]')
    check('报告课程', '家长版：p5_course_hint 只调用一次；一句话要么追加（带课名）、要么因加上会超过 300 字被丢弃并记告警；复制到微信字数始终不超过 300', pa.parts.course_hint?.status === 'ok' && mock.courseRequests.filter(r => r.courseKind === 'hint').length === 1 && pWx <= 300 && (kept ? /示例体系 A|基础|第/.test(pMd.slice(pMd.indexOf('这类题常见易错'))) : pWarn.some(w => /超过 300 字，已省略/.test(w))), `kept=${kept} chars=${pWx} warn=${JSON.stringify(pWarn)}`)
    check('报告课程', '家长版：没有老师版的课程小节 / 表格 / “可发给家长的话”', !/课程对照与选课建议|可发给家长的话|\| 知识点 \|/.test(pMd))
    await shot10c('parent-light')

    // 家长版不勾一句话 / 不勾课程：报告里没有课程内容，也没有课程请求
    mock.resetStats()
    const pn = await gen('parent', { course: false })
    check('报告课程', '不勾“加入课程对照”：没有课程段、options_json 为空、没有任何课程请求（与原来完全一致）', pn.row.options_json === null && !pn.parts.course_hint && !/这类题常见易错/.test(pn.row.markdown) && mock.courseRequests.length === 0)

    // 选项区截图（勾选后）
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    await pickReader('teacher')
    await T('report-course-check').locator('xpath=ancestor::label').click()
    await T('report-course-list').waitFor({ timeout: 8000 })
    await T('report-course-opt').scrollIntoViewIfNeeded()
    await shot10c('options-light')
  }

  // ───────────────────────── 8. 数据包 ─────────────────────────
  {
    await goto('#/settings?admin=1&tab=data'); await T('data-pack').waitFor()
    await T('data-pack').scrollIntoViewIfNeeded()
    const withZip = path.join(work, 'with-course.ewb.zip'), noZip = path.join(work, 'no-course.ewb.zip')
    await stubSave(withZip)
    await T('pack-export').click(); await T('export-confirm').click()
    await T('pack-done').waitFor({ timeout: 60000 })
    const m1 = JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(withZip))).file('manifest.json').async('string'))
    check('数据包', '默认导出带课程大纲：manifest 里 courseIncluded = true、courseCount = 1', m1.courseIncluded === true && m1.courseCount === 1 && /1 个课程体系/.test(await txt('pack-done')), JSON.stringify(m1))
    await T('pack-export').click()   // 上面那次点完「导出」后对话框已关；这次在对话框里取消勾选「课程大纲」
    await T('export-course').click()
    await stubSave(noZip)
    await T('export-confirm').click()
    await waitFor(() => fs.existsSync(noZip), 60000)
    await sleep(500)
    const m2 = JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(noZip))).file('manifest.json').async('string'))
    check('数据包', '取消勾选「课程大纲」：manifest 里 courseIncluded = false、courseCount = 0', m2.courseIncluded === false && m2.courseCount === 0, JSON.stringify(m2))
  }

  // ───────────────────────── 9. 草稿、停用、删除 ─────────────────────────
  {
    writeDb(ud, db => {
      db.exec(`INSERT INTO course_outlines (id, name, scene, status, active, rev) VALUES ('00000000-0000-4000-8000-00000000d001', '命令行导入的草稿', 'family', 'draft', 1, 1);
        INSERT INTO course_levels (outline_id, name, sort) VALUES ('00000000-0000-4000-8000-00000000d001', '甲级', 0);`)
      db.exec(`INSERT INTO course_lessons (outline_id, level_id, seq, no_label, title, search_text, text_hash) VALUES ('00000000-0000-4000-8000-00000000d001', (SELECT id FROM course_levels WHERE name = '甲级'), 1, '1', 'Draft lesson', 'Draft lesson', 'x')`)
    })
    await reload(); await goto('#/courses'); await T('course-settings').waitFor()
    const draftCard = page.locator('[data-testid^=course-card-][data-draft=true]')
    await draftCard.waitFor()
    check('草稿', '命令行导入的草稿：卡片写“草稿 · 还没确认，不参与对照”，没有匹配按钮', /不参与对照/.test(await draftCard.innerText()) && (await draftCard.locator('[data-testid=match-start]').count()) === 0)
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 })
    check('草稿', '草稿不出现在看板的体系选择里', (await page.locator('[data-testid^=course-pick-]').count()) === 1)
    await goto('#/courses'); await T('course-settings').waitFor()
    await draftCard.locator('[data-testid=course-confirm-draft]').click()
    check('草稿', '点“确认使用”后变成正式体系（可以匹配）', await waitFor(() => q1("SELECT status FROM course_outlines WHERE name = '命令行导入的草稿'").status === 'active', 8000))
    // 这个草稿体系没匹配过：停用它，免得后面的看板因为“还有体系没匹配完”不显示数字
    await page.evaluate(() => window.api.course.setActive('00000000-0000-4000-8000-00000000d001', false))
    // 停用
    const first = page.locator(`[data-testid=course-card-${oid}]`)
    await first.locator('[data-testid=course-active]').click()
    await waitFor(() => q1('SELECT active FROM course_outlines WHERE id = ?', oid).active === 0, 8000)
    await openCourseTab(); await sleep(1200)
    check('停用', '关掉“参与对照”：看板里不再出现这个体系', (await page.locator(`[data-testid=course-pick-${oid}]`).count()) === 0)
    await goto('#/courses'); await T('course-settings').waitFor()
    await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-active]').click()
    await waitFor(() => q1('SELECT active FROM course_outlines WHERE id = ?', oid).active === 1, 8000)
  }

  // ───────────────────────── 10. 重新上传（替换） ─────────────────────────
  {
    // 改一份示例：删掉“基础级”的第 5 课、改“第 2 课”的标题（用主进程生成的 xlsx 再改不方便，这里直接用 csv）
    const csv = path.join(work, '替换用.csv')
    // 与“下载示例”里的内容逐字相同，只改基础级第 2 课的标题、删掉基础级第 5 课
    const H = '课次,级别,主题,课程标题,字母与语音,词汇,句型,实用表达,教材对标,能力目标,备注'
    const rows = [
      ['1', '基础级', '打招呼', '第 1 课 Hello', 'Aa Bb', 'hello, bye, name', "I'm …", '问好与告别', '示例教材 三上 Unit 1', '能听懂简单问候', ''],
      ['2', '基础级', '颜色', '第 2 课 Colors（改）', 'Cc Dd', 'red, blue, green', 'What colour is it?', '询问颜色', '示例教材 三上 Unit 2', '能说出 5 种颜色', ''],
      ['3', '基础级', '数字', '第 3 课 Numbers', 'Ee Ff', 'one, two, three, four', 'How many …?', '数数', '示例教材 三上 Unit 3', '能数到 10', ''],
      ['4', '基础级', '家人', '第 4 课 Family', 'Gg Hh', 'mother, father, brother', 'This is my …', '介绍家人', '示例教材 三上 Unit 4', '能介绍家庭成员', ''],
      ['1', '进阶级', '日常', '第 1 课 My day', '', 'breakfast, school, homework', 'I get up at …', '说一天的安排', '示例教材 四下 Unit 1', '能描述日程', ''],
      ['2', '进阶级', '天气', '第 2 课 Weather', 'ai ay', 'sunny, rainy, windy', "It's … today.", '谈论天气', '示例教材 四下 Unit 2', '能描述天气', ''],
      ['3', '进阶级', '过去的事', '第 3 课 Last weekend', 'ed', 'visited, played, watched', 'I played … yesterday.', '说周末做了什么', '示例教材 四下 Unit 3', '能说简单的过去经历', ''],
      ['4', '进阶级', '比较', '第 4 课 Who is taller?', 'er est', 'taller, shorter, heavier', 'A is taller than B.', '比较两个人或物', '示例教材 四下 Unit 4', '能用比较级描述', ''],
      ['5', '进阶级', '购物', '第 5 课 Shopping', 'sh ch', 'dress, skirt, expensive', 'How much is it?', '购物对话', '示例教材 四下 Unit 5', '能完成简单购物对话', '']
    ]
    const cell = v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    fs.writeFileSync(csv, [H, ...rows.map(r => r.map(cell).join(','))].join('\n'))
    mock.resetStats()
    const lockedBefore = q1("SELECT COUNT(*) c FROM course_kp_map WHERE locked = 1").c
    await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-reupload]').click()
    await T('course-wizard').waitFor()
    // 这一次用拖入：拖到向导里的虚线框，只读成课程表，不能被当成试卷导入（窗口级拖放要被拦住）
    const papersBefore = q1('SELECT COUNT(*) c FROM papers').c
    {
      await sleep(900)   // 等对话框的打开动画结束再量位置
      const box = await T('course-drop').boundingBox()
      const cdp = await page.context().newCDPSession(page)
      const data = { items: [], files: [csv], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data })
      await cdp.detach()
    }
    await T('course-file-name').waitFor({ timeout: 10000 })
    await sleep(1500)
    check('替换', '拖入文件：读成课程表（显示文件名），没有被当成试卷导入，页面也没有跳走', (await txt('course-file-name')).includes('替换用') && q1('SELECT COUNT(*) c FROM papers').c === papersBefore && (await page.evaluate(() => location.hash)).startsWith('#/courses'), `papers=${q1('SELECT COUNT(*) c FROM papers').c}/${papersBefore}`)
    check('替换', '重新上传：名称沿用原来的，不能改', (await T('course-name').inputValue()) === '示例体系 A' && (await T('course-name').isDisabled()))
    await page.locator('label:has([data-testid=course-mode-manual])').click()
    await T('course-next').click()
    await T('course-step2').waitFor({ timeout: 20000 })
    {
      const c0 = await T('course-col-0').inputValue(), st2 = await txt('course-step2')
      check('替换', '手动模式：列识别条全部“未识别”，没有调用 AI 认列', c0 === '' && /还没有识别出任何一课/.test(st2) && mock.courseRequests.filter(r => r.courseKind === 'cols').length === 0, `col0=${c0} cols请求=${mock.courseRequests.filter(r => r.courseKind === 'cols').length} ${st2.slice(0, 100)}`)
    }
    const sel = async (c, v) => { await T(`course-col-${c}`).selectOption(v) }
    for (const [c, f] of [[0, 'seq'], [1, 'level'], [2, 'theme'], [3, 'title'], [4, 'phonics'], [5, 'word'], [6, 'pattern'], [7, 'expression'], [8, 'textbook_ref'], [9, 'skill'], [10, 'note']]) await sel(c, f)
    await T('course-lesson-0').waitFor({ timeout: 10000 })
    // 列逐个选完后比对结果会再刷新一次：等它稳定到最终结果（最多 10 秒）
    const diffText = (await waitFor(async () => { const s = await T('course-diff').innerText(); return /新增 0 课、修改 1 课、删除 1 课/.test(s) ? s : null }, 10000)) || await T('course-diff').innerText()
    check('替换', '按（级别 + 课次）比对：显示“新增 0 课、修改 1 课、删除 1 课”，并说明涉及多少条知识点对应需要重新匹配', /新增 0 课、修改 1 课、删除 1 课/.test(diffText) && /条涉及改动的课，需要重新匹配/.test(diffText), diffText)
    await T('course-save').click()
    await T('course-replace-ok').click()
    await T('course-wizard').waitFor({ state: 'detached', timeout: 15000 })
    const o = q1('SELECT rev FROM course_outlines WHERE id = ?', oid)
    check('替换', '替换成功：id 不变，rev + 1，课数 10 → 9，确认 / 否决过的锁定对应保留', o.rev === 2 && q1('SELECT COUNT(*) c FROM course_lessons WHERE outline_id = ?', oid).c === 9 && q1("SELECT COUNT(*) c FROM course_kp_map WHERE locked = 1").c >= lockedBefore - 1)
    check('替换', '匹配状态变成“大纲已更新，需要重新匹配”', /需要重新匹配/.test(await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-match-state]').innerText()))
    await openCourseTab(); await sleep(1500)
    check('替换', '看板提示还没匹配完，匹配前不显示数字', (await T('course-unmatched').count()) === 1 && (await T('course-headline').count()) === 0)
    await shot10('stale-light')
  }

  // ───────────────────────── 11. 深色截图 ─────────────────────────
  {
    // 先把状态恢复成已匹配，截图更有代表性
    await goto('#/courses'); await T('course-settings').waitFor()
    await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=match-start]').click()
    await waitFor(async () => /已匹配/.test(await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-match-state]').innerText().catch(() => '')), 60000)
    await setTheme('dark')
    await goto('#/courses'); await T('course-settings').waitFor(); await T('course-settings').scrollIntoViewIfNeeded(); await sleep(500); await shot10('courses-dark')
    await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-view]').click()
    await T('course-detail').waitFor(); await sleep(400); await shot10('detail-dark'); await page.keyboard.press('Escape')
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 }); await sleep(600); await shot10('dashboard-dark')
    await page.locator('[data-testid=course-chip]').first().click(); await T('course-drawer').waitFor(); await sleep(500); await shot10('drawer-dark'); await page.keyboard.press('Escape')
    await goto('#/courses'); await T('course-settings').waitFor()
    await T('course-reupload').first().click(); await T('course-wizard').waitFor(); await sleep(300); await shot10('wizard-step1-dark')
    // 第 2 步的深色截图：读入示例文件、让 AI 认列
    await stubOpen([sampleXlsx])
    await T('course-pick').click(); await T('course-file-name').waitFor({ timeout: 10000 })
    await T('course-next').click(); await reviewJob()
    await page.evaluate(() => { const b = document.querySelector('.ant-modal-body'); if (b) b.scrollTo(0, 0) })
    await shot10('wizard-step2-dark')
    await page.keyboard.press('Escape')
    await T('course-wizard').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    await T('course-job-remove').first().click().catch(() => {})
    await setTheme('light')
    // 窄屏
    await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(300, 300); w.setContentSize(760, 900) })
    await openCourseTab(); await T('course-headline').waitFor({ timeout: 20000 }); await sleep(600); await shot10('dashboard-narrow-light')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
    check('界面', '窄屏（760 宽）下看板“课程对照”页没有横向滚动条', !overflow)
    await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 860) })
  }

  // ───────────────────────── 12. 删除 ─────────────────────────
  {
    await goto('#/courses'); await T('course-settings').waitFor()
    await page.locator(`[data-testid=course-card-${oid}]`).locator('[data-testid=course-delete]').click()
    await T('course-delete-ok').click()
    await waitFor(() => q1('SELECT COUNT(*) c FROM course_outlines WHERE id = ?', oid).c === 0, 8000)
    check('删除', '删除体系：课次、对应、检查结果级联删除；试卷不受影响', q1('SELECT COUNT(*) c FROM course_lessons WHERE outline_id = ?', oid).c === 0 && q1('SELECT COUNT(*) c FROM course_kp_map WHERE outline_id = ?', oid).c === 0 && q1("SELECT COUNT(*) c FROM papers WHERE status = 'done'").c > 5)
    writeDb(ud, db => db.exec("DELETE FROM course_outlines"))
    await openCourseTab()
    check('删除', '体系都删掉后，看板回到空状态', await T('course-empty').waitFor({ timeout: 15000 }).then(() => true, () => false))
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    check('报告课程', '没有课程大纲时：“加入课程对照”置灰，并指向“课程大纲”页', (await T('report-course-disabled').count()) === 1 && (await T('report-course-check').count()) === 0 && /课程大纲/.test(await txt('report-course-disabled')))
    await T('report-course-link').click()
    check('报告课程', '点提示里的“课程大纲”：跳到课程大纲页', await waitFor(async () => (await page.evaluate(() => location.hash)) === '#/courses', 8000))
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    await shot10c('options-disabled-light')
  }

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools|Autofill/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  check('密钥安全', '主进程输出里没有密钥', !L.procOutput.join('\n').includes(SECRET))
  await closeApp()

  // ───────────────────────── 13. 命令行 ─────────────────────────
  {
    const env = () => { const e = { ...process.env, EWB_USER_DATA_DIR: ud }; for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete e[k]; return e }
    const cli = (args) => new Promise(resolve => {
      const p = spawn(require('electron'), [root, 'cli', ...args], { env: env(), cwd: root })
      let o = '', e = ''
      p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { e += d })
      p.on('close', code => { let json = null; try { json = JSON.parse(o.trim().split('\n').pop()) } catch { /* 下面的检查会报 */ } resolve({ code, o, e, json }) })
    })
    const csv = path.join(work, '命令行用.csv')
    fs.writeFileSync(csv, '课次,主题,课程标题,词汇,句型,价格\n1,打招呼,第 1 课 Hello,"hello, bye",I\'m …,99\n2,颜色,第 2 课 Colors,"red, blue",What colour is it?,99\n')
    const imp = await cli(['course', 'import', csv, '--name', '命令行体系', '--scene', 'school'])
    check('命令行', 'course import（不带 --i-reviewed）：保存为草稿，返回 draft:true、级别 1、课数 2，并提示到窗口里确认', imp.code === 0 && imp.json?.ok && imp.json.data.draft === true && imp.json.data.status === 'draft' && imp.json.data.lessons === 2 && /确认/.test(imp.json.data.note) && imp.json.data.columnsFrom === 'ai', (imp.o + imp.e).slice(0, 300))
    const draftId = imp.json?.data?.id
    check('命令行', '课程内容由程序复制，价格列被忽略（数据库里没有 99）', !withDb(ud, d => JSON.stringify(d.prepare('SELECT raw_json, search_text FROM course_lessons').all())).includes('99') && imp.json.data.warnings.some(w => /价格/.test(w)))
    const lst = await cli(['course', 'list'])
    check('命令行', 'course list：列出草稿、状态“未匹配”', lst.code === 0 && lst.json.data.outlines.some(o => o.id === draftId && o.draft === true && o.match === 'none') && /草稿/.test(lst.json.data.note ?? ''), lst.o.slice(0, 200))
    const mDraft = await cli(['course', 'match', draftId])
    check('命令行', 'course match 草稿：退出码 7（invalid_state），不会调用 AI', mDraft.code === 7 && mDraft.json?.code === 'invalid_state' && /草稿/.test(mDraft.json.message), mDraft.o.slice(0, 200))
    const imp2 = await cli(['course', 'import', csv, '--name', '已核对体系', '--i-reviewed'])
    check('命令行', 'course import --i-reviewed：直接保存为正式体系', imp2.code === 0 && imp2.json.data.status === 'active' && imp2.json.data.draft === false, imp2.o.slice(0, 200))
    const activeId = imp2.json?.data?.id
    const rep = await cli(['report', 'generate', '--reader', 'teacher', '--with-course', activeId])
    check('命令行', 'report generate --with-course 指向还没匹配的体系：退出码 15（course_not_matched），提示先 course match', rep.code === 15 && rep.json?.code === 'course_not_matched' && /course match/.test(rep.json.message), rep.o.slice(0, 200))
    const repDraft = await cli(['report', 'generate', '--reader', 'teacher', '--with-course', draftId])
    check('命令行', '--with-course 指向草稿：退出码 7', repDraft.code === 7 && repDraft.json?.code === 'invalid_state', repDraft.o.slice(0, 200))
    const bad = await cli(['course', 'import', csv, '--scene', 'company'])
    check('命令行', '--scene 写错：退出码 2', bad.code === 2 && bad.json?.code === 'usage', bad.o.slice(0, 160))
    const nofile = await cli(['course', 'import', path.join(work, '不存在.xlsx')])
    check('命令行', '文件不存在：给白话错误（退出码 7）', nofile.code === 7 && /读不了/.test(nofile.json?.message ?? ''), nofile.o.slice(0, 200))
    const m = await cli(['course', 'match', activeId])
    check('命令行', 'course match：退出码 0，返回批次、matched / none 和用量（usage.calls ≥ 1）', m.code === 0 && m.json?.ok && m.json.data.usage.calls >= 1 && m.json.data.batches >= 1 && /AI 的建议/.test(m.json.data.note), (m.o + m.e).slice(0, 300))
    const lst2 = await cli(['course', 'list'])
    check('命令行', '匹配后 course list 的状态是“done”，--with-course 不再报 15', lst2.json.data.outlines.find(o => o.id === activeId)?.match === 'done')
    const wc = await cli(['report', 'generate', '--reader', 'full', '--with-course', activeId])
    const wcRow = withDb(ud, d => d.prepare('SELECT * FROM reports ORDER BY created_at DESC, rowid DESC LIMIT 1').get())
    check('命令行', 'report generate --with-course：体系 id 作为 options 传进报告生成（options_json = {course:{outlineIds:[…]}}，不再是没人读的第 4 个参数）', wc.code === 0 && wc.json?.ok && JSON.parse(wcRow?.options_json ?? 'null')?.course?.outlineIds?.[0] === activeId && wc.json.data.courseIds?.[0] === activeId, (wc.o + wc.e).slice(0, 300) + ' ' + wcRow?.options_json)
    const help = await cli([])
    check('命令行', '帮助里有 course list / import / match 和退出码 course_not_matched = 15', ['course list', 'course import', 'course match'].every(c => help.json.data.commands.some(x => x.command === c || x.name === c || String(x.usage ?? x.command ?? '').includes(c))) && help.json.data.exitCodes.course_not_matched === 15, JSON.stringify(help.json?.data?.exitCodes).slice(0, 120))
  }

  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m10a.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
  L.finish(path.join(__dirname, 'last-result-m10a.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
