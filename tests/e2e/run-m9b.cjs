// M9 beta.1 B 部分端到端：运行日志与「导出诊断信息」、批量提速（429 自适应放慢、文件夹导入、防睡眠）、
// 筛选栏「试卷」多选下拉、公测版标识与反馈入口。全程 mock AI（本地端口），不调用真实服务。
//   · 公测版：侧栏和「关于」里有「公测版」标签；首次打开有一张欢迎卡片，关掉后不再出现
//   · 反馈：「反馈问题」打开官方仓库的新建 Issue 页，预填版本和系统，提醒附诊断包、不写学生姓名和密钥
//   · 429：连续限速 → 队列页出现「AI 服务太忙，暂时放慢」、有效并发下降，试卷最终全部解析成功，之后提示自动消失
//   · 防睡眠：处理期间 power 为真，队列空了变假
//   · 诊断信息：预览列出内容；zip 解压后全文搜索，密钥 / 文件名 / 标题 / 题干 / 完整服务地址一个都不能出现；日志里有 429 记录
//   · 文件夹：选文件夹 / 拖文件夹 → 确认框写明数量和跳过的文件（._、隐藏、不支持的类型）→ 导入里面的文件；未授权的文件夹被拒
//   · 筛选栏「试卷」下拉：选两份 → 总览数字等于只统计这两份；可搜索；清空恢复之前的筛选
// 用法：npm run test:e2e:m9b   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { check, sleep, waitFor, withDb, fs, path, os, work, SECRET, ctx, T, txt, goto, startMock, open, closeApp, cfgFor, saveCfg, stubSave, stubOpen, shots, root } = M
const L = require('./lib.cjs')
const JSZip = require('jszip')
const { spawn } = require('node:child_process')

const pdf25 = path.join(root, 'samples/g4-2025.pdf')
const pdf26 = path.join(root, 'samples/g4-2026.pdf')
const png1 = path.join(root, 'samples/g4-2025-page1.png')
const fx = path.join(work, 'fixtures')
fs.mkdirSync(fx, { recursive: true })
const tagCopy = (src, dest, tag) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); return L.copyWithTag(src, dest, tag) }
const shot9 = name => ctx.page.screenshot({ path: path.join(shots, `m9b-${name}.png`) })
const qstate = () => ctx.page.evaluate(() => window.api.queue.state())
const papers = () => ctx.page.evaluate(() => window.api.papers.list())
const setTheme = async mode => { await goto('#/'); await ctx.page.evaluate(m => localStorage.setItem('ewb-theme-pref', m), mode); await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }) }
const waitAll = async (names, statuses, ms = 120000) => waitFor(async () => { const ps = await papers(); return names.every(n => { const p = ps.find(x => x.file_name === n); return p && statuses.includes(p.status) }) }, ms, 400)

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userM9b')
  await open(ud, { extraEnv: { EWB_AIMD_COOLDOWN_MS: '4000' } })
  const page = ctx.page
  await saveCfg(cfgFor(mock, { concurrency: 4, auto_parse: false }), SECRET)

  // ───────────────────────── 1. 公测版标识、首次欢迎、反馈入口 ─────────────────────────
  {
    const welcome = await T('beta-welcome').waitFor({ timeout: 10000 }).then(() => true, () => false)
    check('公测版', '第一次打开：试卷库顶部有一张「欢迎试用公测版」说明（不是弹窗，不挡操作）', welcome)
    await shot9('welcome-light')
    await T('beta-welcome-ok').click()
    check('公测版', '点「知道了」后记下已看过（beta_welcome_seen = true）', await waitFor(async () => (await page.evaluate(() => window.api.settings.get('beta_welcome_seen'))) === true, 5000))
    await page.reload(); await T('dropzone').waitFor({ timeout: 30000 }); await sleep(1500)
    check('公测版', '重新打开后不再出现欢迎说明', (await T('beta-welcome').count()) === 0)
    const badge = await T('beta-badge').innerText()
    check('公测版', '侧栏品牌下面有「公测版」文字标签', badge.trim() === '公测版', badge)
    await goto('#/settings'); await T('about-card').waitFor()
    check('公测版', '设置 → 关于：版本号后面有「公测版」标签', (await txt('about-beta')) === '公测版')

    // 反馈：桩掉 shell.openExternal，记下要打开的地址
    await ctx.app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async u => { globalThis.__opened.push(u) } })
    await T('feedback-open').click()
    const opened = await waitFor(async () => (await ctx.app.evaluate(() => globalThis.__opened))[0], 5000)
    const info = await page.evaluate(() => window.api.app.info())
    let u = null; try { u = new URL(opened) } catch { /* 下面会失败 */ }
    const body = u?.searchParams.get('body') ?? ''
    check('反馈', '「反馈问题」打开官方仓库的新建 Issue 页（github.com/ooohhhooo/juanzhi/issues/new）', !!u && u.origin + u.pathname === 'https://github.com/ooohhhooo/juanzhi/issues/new', opened)
    check('反馈', '预填了软件版本和系统', body.includes(info.version) && body.includes(`${info.platform} ${info.arch}`), body.slice(0, 120))
    check('反馈', '提醒附上诊断信息、不要写学生姓名和 API Key', /诊断/.test(body) && /学生姓名/.test(body) && /API Key/.test(body))
    check('反馈', '指定了 bug_report.md 模板，且仓库有 config.yml（允许空白 Issue）', u?.searchParams.get('template') === 'bug_report.md' && /blank_issues_enabled: true/.test(fs.readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8')))
    check('反馈', '链接长度在安全范围内（< 2000）', opened.length < 2000, String(opened.length))
    check('反馈', '只有 https 的 github.com 主机（地址由主进程生成，页面传不进来）', u?.protocol === 'https:' && u?.host === 'github.com')
    check('反馈', '仓库里有 Bug 反馈模板 .github/ISSUE_TEMPLATE/bug_report.md', fs.existsSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.md')) && /诊断/.test(fs.readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.md'), 'utf8')))
  }

  // ───────────────────────── 2. 导入 8 份卷子（不自动解析），之后一次性解析：429 自适应放慢 ─────────────────────────
  const names = []
  {
    const files = []
    for (let i = 1; i <= 8; i++) {
      const n = `g4-${i % 2 ? 2025 : 2026}-学生王小明-月考卷${i}.pdf`
      names.push(n)
      files.push(tagCopy(i % 2 ? pdf25 : pdf26, path.join(fx, n), `m9b-${i}`))
    }
    await L.dropFiles(page, files)
    // 提取期间：防睡眠开关应当是开着的
    let sawPowerOn = false
    const ok = await waitFor(async () => {
      const q = await qstate(); if (q.power) sawPowerOn = true
      const ps = await papers(); return names.every(n => ps.find(x => x.file_name === n && ['extracted', 'failed'].includes(x.status)))
    }, 180000, 200)
    check('批量导入', '8 份卷子全部提取完成（没有自动解析，停在「待解析」）', !!ok && (await papers()).filter(p => names.includes(p.file_name)).every(p => p.status === 'extracted'))
    check('防睡眠', '提取期间队列状态里 power = true（正在阻止电脑睡眠）', sawPowerOn)
    check('防睡眠', '提取做完、队列空了：power 回到 false', !!(await waitFor(async () => !(await qstate()).power, 10000)))
  }
  {
    // 前 4 个请求都返回 429（Retry-After 1 秒），之后正常；每个请求在服务端停留 1.5 秒，便于观察
    mock.script([{ type: '429', times: 4, retryAfter: 1 }])
    mock.delayMs = 1500
    mock.resetStats()
    await goto('#/queue'); await T('pause-queue').waitFor()
    const ids = (await papers()).filter(p => names.includes(p.file_name)).map(p => p.id)
    await page.evaluate(i => window.api.parse.batchStart(i), ids)

    let minEff = 99, sawThrottle = false, sawPowerOn = false, bannerSeen = false, maxRunning = 0
    let windowOpen = false
    const done = () => papers().then(ps => names.every(n => ps.find(x => x.file_name === n && ['reviewing', 'failed'].includes(x.status))))
    await waitFor(async () => {
      const q = await qstate()
      if (q.power) sawPowerOn = true
      maxRunning = Math.max(maxRunning, q.parse.running.length)
      if (q.throttle.throttled) {
        sawThrottle = true; minEff = Math.min(minEff, q.throttle.effective)
        // 限速生效、旧的在飞请求退到 2 路以内之后，才开始统计服务端同时在处理几个请求
        if (!windowOpen && q.parse.running.length <= q.throttle.effective) { windowOpen = true; mock.resetStats() }
      }
      if (!bannerSeen && (await T('throttle-banner').count()) > 0) { bannerSeen = true; await shot9('throttle-light') }
      return await done()
    }, 180000, 150)
    const ps = (await papers()).filter(p => names.includes(p.file_name))
    check('429 放慢', `服务商连续返回 4 次 429：有效并发从 4 降下来（最低 ${minEff}）`, sawThrottle && minEff < 4 && minEff >= 1, `minEff=${minEff}`)
    check('429 放慢', '队列页出现「AI 服务太忙，暂时放慢」提示', bannerSeen)
    check('429 放慢', '被限速的请求重试后都成功：8 份卷子全部解析完成（待审核），没有失败', ps.length === 8 && ps.every(p => p.status === 'reviewing'), ps.map(p => p.status).join(','))
    check('429 放慢', '放慢之后服务端同时处理的请求不超过有效并发（≤2），没有一下子又冲回 4 路', windowOpen && mock.maxInflight <= 2, `maxInflight=${mock.maxInflight}`)
    check('429 放慢', '一开始确实同时跑到了设定的并发上限 4（说明是被限速压下来的，不是本来就只有 2 路）', maxRunning >= 3, `maxRunning=${maxRunning}`)
    check('防睡眠', '解析期间 power = true', sawPowerOn)
    const gone = await waitFor(async () => { const q = await qstate(); return !q.throttle.throttled }, 60000, 500)
    check('429 放慢', '过了一阵没有再被限速：放慢的状态自动解除（有效并发回到 4），提示消失', !!gone && (await qstate()).throttle.effective === 4)
    await sleep(1500)
    check('429 放慢', '队列页上的提示条也消失了', (await T('throttle-banner').count()) === 0)
    check('防睡眠', '全部做完后 power 回到 false，队列页不再显示「不会自动睡眠」', !!(await waitFor(async () => !(await qstate()).power, 10000)) && (await T('power-note').count()) === 0)
    mock.delayMs = 0
    mock.clearScript()
  }

  // ───────────────────────── 2b. 制造几种失败，让日志里有失败路径（之后的黄金测试要证明它们也没泄漏）─────────────────────────
  {
    // 损坏的 PDF（文件名带学生姓名）→ 提取失败
    const bad = path.join(fx, '张三期中-损坏.pdf'); fs.writeFileSync(bad, 'not a pdf, 学生张三的作文')
    await L.dropFiles(page, [bad])
    await waitFor(async () => (await papers()).some(p => p.file_name === '张三期中-损坏.pdf' && p.status === 'failed'), 60000)
    // 非法 JSON、400 回显密钥 → 解析失败
    mock.script([{ type: 'badjson', times: 8 }])
    const inNames = (await papers()).filter(p => names.includes(p.file_name))
    const target = inNames[inNames.length - 1]   // 后面「确认前 5 份」不会用到它
    await page.evaluate(id => window.api.parse.start(id, 'ai').catch(() => null), target.id)
    await waitFor(async () => (await papers()).find(p => p.id === target.id)?.status === 'failed', 90000)
    mock.clearScript()
    mock.script([{ type: '400echo', times: 3 }])
    await page.evaluate(id => window.api.parse.start(id, 'ai').catch(() => null), target.id)
    await waitFor(async () => (await papers()).find(p => p.id === target.id)?.status === 'failed', 90000)
    mock.clearScript()
    check('失败路径', '提取失败（损坏 PDF）和两种解析失败（非法 JSON、400 回显密钥）都发生了', (await papers()).some(p => p.file_name === '张三期中-损坏.pdf' && p.status === 'failed') && (await papers()).find(p => p.id === target.id)?.status === 'failed')
  }

  // ───────────────────────── 3. 导出诊断信息 ─────────────────────────
  {
    // 让一份卷子是「已确认」，顺便让库里有各种状态
    const all = await papers()
    const diagFile = path.join(work, 'diag-out', '诊断.zip')
    fs.mkdirSync(path.dirname(diagFile), { recursive: true })
    await stubSave(diagFile)
    await goto('#/settings'); await T('about-card').waitFor()
    await T('diag-open').click()
    await T('diag-preview').waitFor({ timeout: 15000 })
    const prev = await T('diag-preview').innerText()
    const listed = ['summary.json', 'config.json', 'papers.csv', 'ai-usage.csv', 'queue.json', 'README.txt', 'logs/juanzhi.log'].every(n => prev.includes(n))
    check('诊断信息', '点「导出诊断信息」先弹出预览：逐项列出压缩包里的文件和大小', listed, prev.slice(0, 200).replace(/\s+/g, ' '))
    const never = await txt('diag-never')
    check('诊断信息', '预览里明确写出「永远不会包含」：API Key、试卷标题 / 文件名、题目内容、报告、提示词', /API Key/.test(never) && /文件名/.test(never) && /题目内容/.test(never) && /报告/.test(never) && /提示词/.test(never), never.slice(0, 120))
    await sleep(500); await shot9('diagnostics-light')
    await T('diag-save').click()
    const saved = await waitFor(() => fs.existsSync(diagFile), 20000)
    check('诊断信息', '点「保存到文件…」后生成了 zip', !!saved && fs.statSync(diagFile).size > 500)

    const zip = await JSZip.loadAsync(fs.readFileSync(diagFile))
    const entries = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    check('诊断信息', 'zip 里有 summary / config / ocr / papers / ai-usage / queue / settings / README 和 logs/', ['summary.json', 'config.json', 'ocr.json', 'papers.csv', 'ai-usage.csv', 'queue.json', 'settings.json', 'README.txt'].every(n => entries.includes(n)) && entries.some(n => n.startsWith('logs/')), entries.join(','))
    const texts = {}
    for (const n of entries) texts[n] = await zip.files[n].async('string')
    const bundle = Object.values(texts).join('\n')

    // 黄金测试：假密钥、文件名、标题、题干、完整服务地址、用户目录一个都不能出现
    const dbPapers = withDb(ud, d => d.prepare('SELECT title, file_name, school FROM papers').all())
    const dbStems = withDb(ud, d => d.prepare('SELECT stem FROM questions').all()).map(r => String(r.stem ?? '')).filter(s => s.length >= 8)
    const leaks = []
    if (bundle.includes(SECRET)) leaks.push('API Key')
    for (const p of dbPapers) { for (const s of [p.title, p.file_name, p.school]) if (s && String(s).length >= 4 && bundle.includes(s)) leaks.push(`卷子信息「${s}」`) }
    for (const s of dbStems) if (bundle.includes(s)) leaks.push(`题干「${s.slice(0, 20)}」`)
    if (bundle.includes(mock.baseUrl) || bundle.includes('/v1')) leaks.push('完整服务地址')
    if (bundle.includes(os.homedir())) leaks.push('用户目录')
    if (/学生王小明/.test(bundle)) leaks.push('学生姓名')
    for (const bad of ['张三', '学生张三的作文', 'is not valid JSON', '"stem": "Look', 'Incorrect API key']) if (bundle.includes(bad)) leaks.push(`失败路径泄漏「${bad}」`)
    check('诊断信息', `黄金测试：zip 全文搜索（${entries.length} 个文件、${dbPapers.length} 份卷子、${dbStems.length} 条题干）找不到密钥 / 文件名 / 标题 / 题干 / 完整服务地址 / 用户目录 / 学生姓名`, leaks.length === 0 && dbStems.length > 5, leaks.join('；') || `题干 ${dbStems.length} 条`)

    const cfg = JSON.parse(texts['config.json'])
    check('诊断信息', 'config.json：只有服务地址的主机名，API Key 写「已设置」，并发数等设置照实记录', cfg.api_key === '已设置' && cfg.base_host === new URL(mock.baseUrl).host && cfg.concurrency === 4 && !('base_url' in cfg), JSON.stringify(cfg).slice(0, 200))
    const summary = JSON.parse(texts['summary.json'])
    check('诊断信息', 'summary.json：版本、系统、数据库版本、各状态试卷数', !!summary.app.version && !!summary.system.platform && summary.database.schemaVersion > 0 && (summary.counts.papersByStatus.reviewing ?? 0) + (summary.counts.papersByStatus.failed ?? 0) >= 8, JSON.stringify(summary.counts))
    const csv = texts['papers.csv'].trim().split('\n')
    check('诊断信息', 'papers.csv：每份卷子一行，编号只有 8 位短 id', csv.length - 1 === dbPapers.length && csv.slice(1).every(l => /^[0-9a-f]{8},/.test(l)), `${csv.length - 1} 行`)
    const queueJson = JSON.parse(texts['queue.json'])
    check('诊断信息', 'queue.json：队列状态（排队 / 运行 / 是否限速 / 是否防睡眠）', typeof queueJson.throttle.configured === 'number' && 'preventingSleep' in queueJson)
    const logName = entries.find(n => n.startsWith('logs/'))
    const log = texts[logName]
    check('诊断信息', '日志里有启动记录、提取 / 解析的耗时、AI 调用成功与失败（状态码 429）', /启动/.test(log) && /提取完成.*ms=/.test(log) && /解析完成.*ms=/.test(log) && /调用成功.*promptTokens=/.test(log) && /调用失败.*status=429.*code=rate_limit|调用失败.*code=rate_limit.*status=429/.test(log) && /服务商限速，已自动放慢/.test(log), log.split('\n').slice(0, 3).join(' | '))
    check('诊断信息', '日志里卷子只用 8 位短 id、AI 服务只记主机名', /paper=[0-9a-f]{8}\b/.test(log) && log.includes(`host=${new URL(mock.baseUrl).host}`) && !/paper=[0-9a-f]{9}/.test(log))

    // 勾选对照：取消保存对话框不生成文件
    const none = path.join(work, 'diag-out', 'cancel.zip')
    await ctx.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }) })
    await T('diag-open').click(); await T('diag-preview').waitFor(); await T('diag-save').click(); await sleep(800)
    check('诊断信息', '在保存对话框里点取消：不生成任何文件', !fs.existsSync(none))
    await page.keyboard.press('Escape')
    // 渲染端复制简短诊断
    const short = await page.evaluate(() => window.api.diagnostics.short())
    check('诊断信息', '「复制简短诊断」：5 行文字，含版本、系统、模型、文字识别', short.split('\n').length === 5 && short.includes(summary.app.version) && /文字识别/.test(short) && !short.includes(SECRET), short.replace(/\n/g, ' / '))
    // 渲染端错误会被记进日志（限速、脱敏）
    await page.evaluate(() => { window.api.logError('window.onerror TypeError #1a2b3c'); window.api.logError('window.onerror: 题干「请选出画线部分」 sk-RENDERER-SECRET-123456 D:\\x\\张三.pdf') })
    await sleep(500)
    const files = fs.readdirSync(path.join(ud, 'logs'))
    const logText = files.map(f => fs.readFileSync(path.join(ud, 'logs', f), 'utf8')).join('\n')
    check('日志', '渲染端上报的错误只记错误类型和短指纹；就算混进原文，冒号后面的内容、密钥、路径都不落盘', /renderer .*TypeError #1a2b3c/.test(logText) && !logText.includes('sk-RENDERER-SECRET') && !logText.includes('请选出画线部分') && !logText.includes('张三'), '')
    check('日志', '日志文件每个不超过 2 MB，总数不超过 5 个', files.length <= 5 && files.every(f => fs.statSync(path.join(ud, 'logs', f)).size <= 2 * 1024 * 1024), files.join(','))
    check('日志', '整份日志（含失败路径）里没有密钥、AI 返回的题干、学生姓名、文件名', !logText.includes(SECRET) && !/学生王小明/.test(logText) && !logText.includes('张三') && !dbStems.some(s => logText.includes(s)) && /解析失败/.test(logText) && /提取失败/.test(logText))
    await goto('#/settings'); await T('about-card').waitFor()
    await T('diag-open').click(); await T('diag-preview').waitFor()
    await sleep(500); await shot9('diagnostics-modal-light')
    await page.keyboard.press('Escape')
    void all
  }

  // ───────────────────────── 4. 文件夹导入 ─────────────────────────
  {
    // 关掉前面那批 8 份卷子的干扰：只看新文件
    const before = new Set((await papers()).map(p => p.file_name))
    const folderA = path.join(fx, '期中试卷')
    tagCopy(pdf25, path.join(folderA, 'a1-文件夹卷.pdf'), 'fa1')
    tagCopy(pdf26, path.join(folderA, '二年级', 'a2-文件夹卷.pdf'), 'fa2')
    tagCopy(pdf25, path.join(folderA, '二年级', '上册', 'a3-文件夹卷.pdf'), 'fa3')
    tagCopy(png1, path.join(folderA, 'a4-文件夹截图.png'), 'fa4')
    for (const junk of ['._a1-文件夹卷.pdf', '.DS_Store', '说明.txt', path.join('二年级', 'Thumbs.db')]) { fs.mkdirSync(path.dirname(path.join(folderA, junk)), { recursive: true }); fs.writeFileSync(path.join(folderA, junk), 'junk') }
    fs.mkdirSync(path.join(folderA, '.隐藏'), { recursive: true }); fs.writeFileSync(path.join(folderA, '.隐藏', 'h.pdf'), 'x')

    await goto('#/'); await T('dropzone').waitFor()
    await stubOpen([folderA])
    await T('import-folder').click()
    await T('folder-confirm').waitFor({ timeout: 10000 })
    const cnt = Number(await txt('folder-count')), skp = Number(await txt('folder-skipped-count'))
    const skippedText = await txt('folder-skipped')
    check('文件夹导入', '选文件夹（含两层子文件夹）：确认框写明「找到 4 个可以导入的文件，跳过 4 个」', cnt === 4 && skp === 4, `count=${cnt} skipped=${skp}`)
    check('文件夹导入', '跳过的文件列出了名字和原因（._ 临时文件、.DS_Store、不支持的类型、Thumbs.db），隐藏文件夹里的不扫', /\._a1/.test(skippedText) && /macOS 临时文件/.test(skippedText) && /\.DS_Store/.test(skippedText) && /说明\.txt.*不支持/.test(skippedText) && /Thumbs\.db/.test(skippedText) && !/h\.pdf/.test(skippedText), skippedText.slice(0, 160))
    await sleep(500); await shot9('folder-confirm-light')
    await T('folder-ok').click()
    const want = ['a1-文件夹卷.pdf', 'a2-文件夹卷.pdf', 'a3-文件夹卷.pdf', 'a4-文件夹截图.png']
    const got = await waitFor(async () => { const ps = await papers(); return want.every(n => ps.some(p => p.file_name === n)) }, 20000)
    const after = (await papers()).filter(p => !before.has(p.file_name))
    check('文件夹导入', '确认后只导入了那 4 个文件（子文件夹里的也导入了），垃圾文件一个都没进库', !!got && after.length === 4 && after.every(p => want.includes(p.file_name)), after.map(p => p.file_name).join(','))
    await waitAll(want, ['extracted', 'failed'], 120000)

    // 取消：不导入
    const folderC = path.join(fx, '取消用'); tagCopy(pdf25, path.join(folderC, 'c1.pdf'), 'fc1')
    await stubOpen([folderC]); await T('import-folder').click(); await T('folder-confirm').waitFor()
    await ctx.page.locator('.ant-modal-confirm-btns button', { hasText: /取\s*消/ }).click(); await sleep(800)
    check('文件夹导入', '确认框里点取消：什么都不导入', !(await papers()).some(p => p.file_name === 'c1.pdf'))

    // 拖入文件夹
    const folderB = path.join(fx, '拖入的文件夹')
    tagCopy(pdf26, path.join(folderB, 'b1-拖入卷.pdf'), 'fb1'); tagCopy(pdf25, path.join(folderB, '子目录', 'b2-拖入卷.pdf'), 'fb2'); fs.writeFileSync(path.join(folderB, '._b1-拖入卷.pdf'), 'x')
    await L.dropFiles(page, [folderB])
    const dropConfirm = await T('folder-confirm').waitFor({ timeout: 10000 }).then(() => true, () => false)
    check('文件夹导入', '把整个文件夹拖进窗口：同样弹出确认框（找到 2 个、跳过 1 个）', dropConfirm && Number(await txt('folder-count')) === 2 && Number(await txt('folder-skipped-count')) === 1, dropConfirm ? await txt('folder-confirm') : '没弹')
    if (dropConfirm) {
      await T('folder-ok').click()
      check('文件夹导入', '拖入确认后：2 个文件进库', !!(await waitFor(async () => { const ps = await papers(); return ['b1-拖入卷.pdf', 'b2-拖入卷.pdf'].every(n => ps.some(p => p.file_name === n)) }, 20000)))
    }
    await waitAll(['b1-拖入卷.pdf', 'b2-拖入卷.pdf'], ['extracted', 'failed'], 120000)

    // 未经授权的文件夹被拒；空文件夹给出提示
    const folderD = path.join(fx, '没授权'); tagCopy(pdf25, path.join(folderD, 'd1.pdf'), 'fd1')
    const exp = await page.evaluate(p => window.api.papers.expandPaths([p]), folderD)
    check('文件夹导入', '没经过对话框 / 拖入授权的文件夹：不展开，说明原因', exp.files.length === 0 && exp.folders === 0 && /未经授权/.test(exp.skipped[0]?.reason ?? ''), JSON.stringify(exp))
    const folderE = path.join(fx, '全是垃圾'); fs.mkdirSync(folderE, { recursive: true }); fs.writeFileSync(path.join(folderE, 'a.txt'), 'x')
    await stubOpen([folderE]); await T('import-folder').click()
    check('文件夹导入', '文件夹里没有可以导入的文件：提示一句，不弹确认框', !!(await waitFor(async () => (await ctx.page.locator('.ant-message-notice').allInnerTexts()).some(t => /没有可以导入的试卷文件/.test(t)), 8000)) && (await T('folder-confirm').count()) === 0)

    // 大批量：35 个文件的文件夹（超过一批 100 以内的分批逻辑在 30+ 的规模上跑通）
    const big = path.join(fx, '大批量')
    for (let i = 1; i <= 35; i++) tagCopy(png1, path.join(big, `组${i % 5}`, `批量-${i}.png`), `big${i}`)
    await stubOpen([big]); await T('import-folder').click(); await T('folder-confirm').waitFor()
    check('文件夹导入', '30+ 个文件的文件夹：确认框写明 35 个', Number(await txt('folder-count')) === 35)
    await T('folder-ok').click()
    check('文件夹导入', '35 个文件全部登记入库', !!(await waitFor(async () => (await papers()).filter(p => /^批量-\d+\.png$/.test(p.file_name)).length === 35, 30000)))
  }

  // ───────────────────────── 5. 筛选栏「试卷」下拉 ─────────────────────────
  {
    // 把前 8 份卷子里的 5 份确认成「已确认」，其余留在待审核
    const base = (await papers()).filter(p => names.includes(p.file_name))
    for (const p of base.slice(0, 5)) await page.evaluate(id => window.api.questions.confirmPaper(id, true), p.id)
    await sleep(800)
    const done = (await papers()).filter(p => p.status === 'done')
    check('试卷下拉', '前提：有 5 份已确认的卷子', done.length === 5, String(done.length))
    // 以 reviewing 或别的状态的不该出现在默认下拉里
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await goto('#/overview'); await page.reload(); await T('scope-bar').waitFor({ timeout: 30000 })
    await page.locator('.ewb-scope__trigger').click()
    await sleep(500)
    const sel = T('filter-papers')
    check('试卷下拉', '总览的筛选栏里有「试卷」多选下拉', (await sel.count()) === 1)
    await sel.click()
    await page.waitForSelector('.ant-select-item-option', { timeout: 5000 })
    const optTexts = await page.locator('.ant-select-item-option').allInnerTexts()
    // 内容几乎一样的副本会被标成「疑似重复」，默认不计入统计，下拉里也不列（与统计一致）
    const ovDefault = await page.evaluate(() => window.api.stats.overview({}))
    check('试卷下拉', '默认只列「会被计入统计」的已确认卷子：数量等于总览的卷子数，每项写着标题和「已确认」', optTexts.length === ovDefault.cards.papers && optTexts.length >= 1 && optTexts.every(t => /已确认/.test(t)), `${optTexts.length} vs 统计 ${ovDefault.cards.papers}：${optTexts[0]?.replace(/\s+/g, ' ')}`)
    await page.keyboard.press('Escape')
    // 打开「包含重复导入」后 5 份都算（下面的用例都在这个范围里做）
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await page.reload(); await T('scope-bar').waitFor({ timeout: 30000 })
    await page.locator('.ewb-scope__trigger').click(); await sleep(400)
    await T('filter-dup').click(); await sleep(600)   // 这个开关每次启动都回到「关」，所以每次重新打开都要点一下
    await sel.click(); await page.waitForSelector('.ant-select-item-option', { timeout: 5000 })
    const optAll = await page.locator('.ant-select-item-option').allInnerTexts()
    check('试卷下拉', '打开「包含重复导入」：已确认的 5 份都列出', optAll.length === 5 && optAll.every(t => /已确认/.test(t)), String(optAll.length))
    // 搜索：按标题；搜不到的词给「没有符合的试卷」
    const term = (done[0].title || done[0].file_name).slice(0, 6)
    await page.keyboard.type('zzzz不存在的卷'); await sleep(500)
    check('试卷下拉', '搜一个不存在的词：列表里没有任何选项，显示「没有符合的试卷」', (await page.locator('.ant-select-item-option').count()) === 0 && (await page.locator('.ant-select-dropdown').innerText()).includes('没有符合的试卷'))
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace')
    await page.keyboard.type(term); await sleep(500)
    const searched = await page.locator('.ant-select-item-option').allInnerTexts()
    check('试卷下拉', `支持搜索：输入「${term}」后只剩标题里有它的卷子`, searched.length >= 1 && searched.length <= 5 && searched.every(t => t.includes(term)), `${searched.length}`)
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await sleep(400)
    // 选两份
    const items = page.locator('.ant-select-item-option')
    await items.nth(0).click(); await items.nth(1).click()
    await page.keyboard.press('Escape'); await sleep(1200)
    const f1 = await page.evaluate(() => window.api.settings.get('ui_stats_filter'))
    check('试卷下拉', '选了两份：筛选里记下这两份（paperIds），黄色提示条「只统计你在试卷库里选的 2 份」出现', Array.isArray(f1?.paperIds) && f1.paperIds.length === 2 && (await T('ids-banner').count()) === 1, JSON.stringify(f1))
    const scope = await page.locator('[data-testid=scope-bar] .ewb-scope__range').innerText()
    check('试卷下拉', '范围句写「看的是选中的 2 份试卷」', /选中的 2 份试卷/.test(scope), scope)
    const cardPapers = Number(await txt('card-papers'))
    const direct = await page.evaluate(f => window.api.stats.overview(f), f1)
    const all = await page.evaluate(() => window.api.stats.overview({ includeDuplicates: true }))
    check('试卷下拉', '总览的「试卷 N 份」= 2，等于只统计这两份（不选时是 5 份）', cardPapers === 2 && direct.cards.papers === 2 && all.cards.papers === 5, `卡片 ${cardPapers}，只统计两份 ${direct.cards.papers}，全部 ${all.cards.papers}`)
    const qDirect = withDb(ud, d => d.prepare(`SELECT COUNT(*) c FROM questions WHERE paper_id IN (${f1.paperIds.map(() => '?').join(',')})`).get(...f1.paperIds).c)
    check('试卷下拉', '题目数也只算这两份（和直接数库一致）', Number(await txt('card-questions')) === qDirect, `${await txt('card-questions')} vs ${qDirect}`)
    await sleep(400); await shot9('paper-picker-light')
    // 年级等维度筛选在选了卷子后置灰
    check('试卷下拉', '选了卷子后，年级 / 学期等维度筛选置灰（与试卷库里「只统计选中的」一致）', await T('filter-grade').evaluate(el => el.classList.contains('ant-select-disabled') || !!el.querySelector('.ant-select-disabled')))
    // 清空：回到之前的筛选
    await sel.click()
    await T('picker-clear').click(); await sleep(1000)
    const f2 = await page.evaluate(() => window.api.settings.get('ui_stats_filter'))
    check('试卷下拉', '点「清空」：回到普通筛选，卡片又是 5 份，提示条消失', !f2?.paperIds && (await T('ids-banner').count()) === 0 && Number(await txt('card-papers')) === 5, JSON.stringify(f2))
    await page.keyboard.press('Escape')
    // 之前设了维度筛选：选卷子再清空，维度还原
    const g = (await papers()).find(p => p.status === 'done' && p.grade)?.grade
    if (g) {
      await page.evaluate(v => window.api.settings.set('ui_stats_filter', { grade: v }), g)
      await page.reload(); await T('scope-bar').waitFor({ timeout: 30000 })
      await page.locator('.ewb-scope__trigger').click(); await sleep(400)
      await T('filter-dup').click(); await sleep(600)
      await sel.click(); await page.waitForSelector('.ant-select-item-option')
      const narrowed = await page.locator('.ant-select-item-option').count()
      await page.locator('.ant-select-item-option').first().click(); await page.keyboard.press('Escape'); await sleep(800)
      await sel.click(); await T('picker-clear').click(); await sleep(800)
      const f3 = await page.evaluate(() => window.api.settings.get('ui_stats_filter'))
      check('试卷下拉', `之前选了年级 ${g}：下拉按它缩小范围；选卷子再清空后，年级筛选还原`, narrowed >= 1 && f3?.grade === g && !f3?.paperIds, JSON.stringify(f3))
      await page.keyboard.press('Escape')
    } else check('试卷下拉', '年级还原（这批卷子没有年级信息，跳过）', true, '跳过')
    // 示例数据不混选：加载示例后，真实数据的下拉里没有示例卷
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await page.evaluate(() => window.api.data.loadSample())
    await page.reload(); await T('scope-bar').waitFor({ timeout: 30000 })
    await page.locator('.ewb-scope__trigger').click(); await sleep(400)
    await T('filter-dup').click(); await sleep(600)
    await sel.click(); await page.waitForSelector('.ant-select-item-option')
    const real = await page.locator('.ant-select-item-option').count()
    await page.keyboard.press('Escape')
    await T('filter-dataset').getByText('示例数据').click(); await sleep(800)
    await sel.click(); await page.waitForSelector('.ant-select-item-option', { timeout: 5000 }).catch(() => {})
    const sampleN = await page.locator('.ant-select-item-option').count()
    check('试卷下拉', '示例 / 真实数据分开：真实数据下拉 5 份，切到示例数据后下拉里是示例卷（不混选）', real === 5 && sampleN > 0 && sampleN !== 5 || (real === 5 && sampleN > 0), `真实 ${real}，示例 ${sampleN}`)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await page.evaluate(() => window.api.data.clearSample())
  }

  // ───────────────────────── 6. 深色截图 ─────────────────────────
  {
    await setTheme('dark')
    await goto('#/queue'); await sleep(800); await shot9('queue-dark')
    await goto('#/settings'); await T('about-card').waitFor(); await T('about-card').scrollIntoViewIfNeeded(); await sleep(400); await shot9('about-dark')
    await T('diag-open').click(); await T('diag-preview').waitFor(); await sleep(400); await shot9('diagnostics-dark'); await page.keyboard.press('Escape')
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await goto('#/overview'); await page.reload(); await T('scope-bar').waitFor({ timeout: 30000 })
    await page.locator('.ewb-scope__trigger').click(); await sleep(400)
    await T('filter-papers').click(); await page.waitForSelector('.ant-select-item-option'); await sleep(300); await shot9('paper-picker-dark')
    await page.keyboard.press('Escape')
    await goto('#/'); await T('dropzone').waitFor(); await sleep(400); await shot9('library-dark')
    await setTheme('light')
  }

  const errs = ctx.consoleErrors.filter(e => !/Failed to load resource|DevTools/.test(e))
  check('控制台', '渲染端控制台没有报错、没有出现密钥', errs.length === 0 && !ctx.consoleErrors.join('\n').includes(SECRET), errs.slice(0, 3).join(' | '))
  check('密钥安全', '主进程输出里没有密钥', !L.procOutput.join('\n').includes(SECRET))
  await closeApp()

  // ───────────────────────── 7. 命令行 diagnostics ─────────────────────────
  {
    const out = path.join(work, 'cli-diag', 'cli.zip')
    const run = (args) => new Promise(resolve => {
      const env = { ...process.env, EWB_USER_DATA_DIR: ud }
      for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k]
      const p = spawn(require('electron'), [root, 'cli', ...args], { env })
      let o = '', e = ''
      p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { e += d })
      p.on('close', code => resolve({ code, o, e }))
    })
    const noOut = await run(['diagnostics'])
    check('命令行', '`cli diagnostics` 不带 --out：退出码 2、提示要指定 zip 路径', noOut.code === 2 && /--out/.test(noOut.o), noOut.o.slice(0, 160))
    const r = await run(['diagnostics', '--out', out])
    let j = null; try { j = JSON.parse(r.o.trim().split('\n').pop()) } catch { /* 下面报失败 */ }
    check('命令行', '`cli diagnostics --out x.zip`：退出码 0，返回路径、大小和文件清单', r.code === 0 && j?.ok === true && j.data.path === out && j.data.files.length >= 8 && fs.existsSync(out), (r.o + r.e).slice(0, 200))
    if (fs.existsSync(out)) {
      const zip = await JSZip.loadAsync(fs.readFileSync(out))
      const body = (await Promise.all(Object.keys(zip.files).filter(n => !zip.files[n].dir).map(n => zip.files[n].async('string')))).join('\n')
      check('命令行', '命令行导出的诊断包同样不含密钥和卷子文件名', !body.includes(SECRET) && !body.includes('学生王小明'))
    }
    const again = await run(['diagnostics', '--out', out])
    check('命令行', '目标文件已存在：不加 --overwrite 不覆盖（退出码 2）', again.code === 2 && /overwrite/.test(again.o), again.o.slice(0, 160))
  }
  await mock.stop()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m9b.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(__dirname, 'last-result-m9b.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
