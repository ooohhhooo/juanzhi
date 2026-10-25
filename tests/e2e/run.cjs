// 端到端测试：用 playwright-core 启动真实的 Electron 应用（out/ 构建产物），
// 通过 CDP 派发真实的 drop 事件、驱动界面并核对数据库。
// 用法：npm run test:e2e   （需在沙箱外运行；会先构建）
const { _electron: electron } = require('playwright-core')
const { DatabaseSync } = require('node:sqlite')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-e2e-'))
const userData = path.join(work, 'userData')
const fx = path.join(work, 'fixtures')
const shots = path.join(root, 'docs/screenshots')
fs.mkdirSync(shots, { recursive: true })

const results = []
function check(feature, name, pass, detail = '') {
  results.push({ feature, name, pass: !!pass, detail: String(detail) })
  console.log(`${pass ? '✅' : '❌'} [${feature}] ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 120000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}

function seedLegacyDb() {
  // 模拟「旧版本代码（M1 初版）创建的库」：user_version=0，schema_version 记在 settings 里，pages 没有 text/ocr_conf
  fs.mkdirSync(path.join(userData, 'workbench-data', 'files'), { recursive: true })
  const db = new DatabaseSync(path.join(userData, 'workbench-data', 'db.sqlite'))
  db.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', grade TEXT, semester TEXT,
      school_year_start INTEGER, exam_type TEXT, textbook TEXT, region TEXT, school TEXT, total_score INTEGER,
      file_name TEXT NOT NULL, file_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'imported', error TEXT,
      page_count INTEGER NOT NULL DEFAULT 0, ai_model TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL, image_rel TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
      text_source TEXT NOT NULL DEFAULT 'ocr', lines_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    INSERT INTO settings VALUES ('schema_version', '1');
    INSERT INTO papers (id, title, file_name, file_hash, status, page_count) VALUES
      ('11111111-1111-4111-8111-111111111111', '旧版已完成', 'legacy.pdf', 'h-legacy', 'done', 1),
      ('22222222-2222-4222-8222-222222222222', '旧版卡死', 'stuck.pdf', 'h-stuck', 'extracting', 0);
    INSERT INTO pages (paper_id, idx, image_rel, text_source, lines_json) VALUES
      ('11111111-1111-4111-8111-111111111111', 1, 'page-1.png', 'pdf-text+ocr', '[]');
  `)
  db.close()
}

function readDb() {
  const db = new DatabaseSync(path.join(userData, 'workbench-data', 'db.sqlite'), { readOnly: true })
  return db
}

async function launch(extraEnv = {}) {
  const env = { ...process.env, EWB_USER_DATA_DIR: userData, ...extraEnv }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k]
  const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env })
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(String(e)))
  await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  return { app, page, consoleErrors }
}

async function dropFiles(page, paths) {
  // 顶部堆叠的 toast 会盖住拖拽区，先等它们消失
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  const box = await page.locator('[data-testid=dropzone]').boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
  }
  await cdp.detach()
}

const listPapers = page => page.evaluate(() => window.api.papers.list())
const allSettled = async page => {
  const ps = await listPapers(page)
  return ps.length > 0 && ps.every(p => ['done', 'failed'].includes(p.status))
}

async function main() {
  const samples = path.join(root, 'samples')
  const pdf25 = path.join(samples, 'g4-2025.pdf')
  const pdf26 = path.join(samples, 'g4-2026.pdf')
  const png1 = path.join(samples, 'g4-2025-page1.png')

  execFileSync('python3', [path.join(__dirname, 'make-fixtures.py'), fx, png1], { stdio: 'inherit' })
  seedLegacyDb()

  // ───────── 第 1 次启动：迁移 + 恢复 + 拖拽 ─────────
  let { app, page, consoleErrors } = await launch()

  const dbm = readDb()
  const uv = dbm.prepare('PRAGMA user_version').get().user_version
  const pageCols = dbm.prepare('PRAGMA table_info(pages)').all().map(c => c.name)
  const paperCols = dbm.prepare('PRAGMA table_info(papers)').all().map(c => c.name)
  const legacyRows = dbm.prepare("SELECT id, status, error FROM papers ORDER BY id").all()
  const legacyPages = dbm.prepare('SELECT COUNT(*) c FROM pages').get().c
  dbm.close()
  check('迁移', '旧库(user_version=0)启动后升级到最新版本', uv === 3, `user_version=${uv}`)
  check('迁移', 'pages 增加 text/ocr_conf，papers 增加 extracted_at，旧数据保留',
    pageCols.includes('text') && pageCols.includes('ocr_conf') && paperCols.includes('extracted_at') && legacyPages === 1,
    `pages 列=${pageCols.join(',')}`)
  check('崩溃恢复', '启动时把遗留的 extracting 标成 failed 并提示重试',
    legacyRows.find(r => r.id.startsWith('2222'))?.status === 'failed' && /中断/.test(legacyRows.find(r => r.id.startsWith('2222'))?.error || ''),
    JSON.stringify(legacyRows.find(r => r.id.startsWith('2222'))))

  const dataDir = await page.evaluate(() => window.api.settings.getDataDir())
  check('数据目录', '数据目录 = EWB_USER_DATA_DIR/workbench-data', dataDir === path.join(userData, 'workbench-data'), dataDir)

  const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '')
  check('CSP', '页面带 CSP 且未被违反', /default-src 'self'/.test(csp) && !consoleErrors.some(e => /Content Security Policy/i.test(e)), consoleErrors.join(' | ').slice(0, 200))

  await page.evaluate(() => { window.__prog = []; window.api.on('job:progress', p => window.__prog.push(p)) })

  // 真实拖拽：2 PDF + 1 PNG + AppleDouble + .doc 一次拖入
  const dropPaths = [pdf25, pdf26, png1, path.join(fx, '._junk.pdf'), path.join(fx, 'old-format.doc')]
  await dropFiles(page, dropPaths)
  const queued = await waitFor(async () => (await listPapers(page)).filter(p => !p.id.startsWith('1111') && !p.id.startsWith('2222')).length >= 3)
  check('拖拽导入', '拖入 5 个文件后，3 个有效文件进入队列（触发了 papers:import）', !!queued)
  const warnTexts = await page.locator('.ant-message-notice').allInnerTexts()
  check('拖拽导入', '无效文件有明确提示（AppleDouble、.doc）',
    warnTexts.join('\n').includes('AppleDouble') && warnTexts.join('\n').includes('.doc'), warnTexts.join(' / ').replace(/\n/g, ' ').slice(0, 160))

  const settled = await waitFor(() => allSettled(page), 180000)
  const papers1 = (await listPapers(page)).filter(p => !p.id.startsWith('1111') && !p.id.startsWith('2222'))
  check('拖拽导入', '3 份文件全部提取完成（status=done）', settled && papers1.length === 3 && papers1.every(p => p.status === 'done'), papers1.map(p => `${p.file_name}:${p.status}`).join(', '))

  const uiDone = await waitFor(async () => (await page.locator('tr', { hasText: 'g4-2025.pdf' }).count() || (await page.locator('tr', { hasText: 'g4-2025' }).count())) && (await page.locator('tr', { hasText: 'g4-2026' }).getByText('已提取').count()) > 0, 15000)
  check('事件刷新', '列表无需手动刷新，自动显示为「已提取」（data:changed → 重新查询）', !!uiDone)
  const prog = await page.evaluate(() => window.__prog)
  check('事件刷新', '渲染端收到 job:progress，且包含 done 终态', prog.length > 0 && prog.some(p => p.stage === 'done'), `${prog.length} 条`)

  // 数据库核对：PDF 文本层
  const db1 = readDb()
  const rows = db1.prepare(`SELECT pp.file_name, p.idx, p.text_source, p.width, p.height, length(p.text) tl, p.lines_json, p.ocr_conf
                            FROM pages p JOIN papers pp ON pp.id = p.paper_id WHERE pp.file_name IN ('g4-2025.pdf','g4-2026.pdf','g4-2025-page1.png') ORDER BY pp.file_name, p.idx`).all()
  db1.close()
  const pdfRows = rows.filter(r => r.file_name.endsWith('.pdf'))
  check('PDF 文本层', 'PDF 页面 text_source=pdf-text 且 text 列保存了文本层全文',
    pdfRows.length >= 2 && pdfRows.every(r => r.text_source === 'pdf-text' && r.tl >= 50),
    pdfRows.map(r => `${r.file_name}#${r.idx}:${r.text_source}/${r.tl}字`).join(' '))
  const pdfLines = pdfRows.map(r => JSON.parse(r.lines_json))
  const coordsOk = pdfLines.every(ls => ls.length > 5 && ls.every(l => l.x >= 0 && l.y >= 0 && l.x + l.w <= 1.001 && l.y + l.h <= 1.001 && l.w > 0 && l.h > 0))
  check('PDF 文本层', 'lines_json 是 PDF 自带的真实坐标（0-1，非伪造）', coordsOk, pdfLines.map(l => l.length + '行').join(','))
  const pngRow = rows.find(r => r.file_name.endsWith('.png'))
  check('OCR', 'PNG 走 OCR（text_source=ocr，行数>30，有置信度）', pngRow && pngRow.text_source === 'ocr' && JSON.parse(pngRow.lines_json).length > 30 && pngRow.ocr_conf > 0,
    pngRow && `${JSON.parse(pngRow.lines_json).length}行 conf=${pngRow.ocr_conf?.toFixed(2)}`)

  // 界面：列表与详情
  await page.screenshot({ path: path.join(shots, 'fix-01-library.png') })
  const pdfPaper = papers1.find(p => p.file_name === 'g4-2025.pdf')
  await page.evaluate(id => { location.hash = '#/paper/' + id }, pdfPaper.id)
  await page.waitForSelector('img[alt="第1页"]')
  const imgOk = await waitFor(() => page.evaluate(() => [...document.querySelectorAll('img')].every(i => i.complete && i.naturalWidth > 0)), 15000)
  check('ewb:// 图片', '详情页缩略图与主图经 ewb:// 加载成功', imgOk)
  await page.locator('.ant-switch').click()
  await sleep(500)
  const rects = await page.locator('svg rect').count()
  check('OCR 叠加', 'PDF 文本页打开叠加层，画出真实坐标行框', rects > 5, `${rects} 个框`)
  await page.screenshot({ path: path.join(shots, 'fix-02-detail-pdf-overlay.png') })

  const pngPaper = papers1.find(p => p.file_name.endsWith('.png'))
  await page.evaluate(id => { location.hash = '#/paper/' + id }, pngPaper.id)
  await page.waitForSelector('img[alt="第1页"]')
  await page.locator('.ant-switch').click()
  await sleep(500)
  await page.screenshot({ path: path.join(shots, 'fix-03-detail-png-overlay.png') })

  // 协议安全
  const pid = pdfPaper.id
  const st = url => app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, url)
  const sPage = await st(`ewb://page/${pid}/page-1.png`)
  const sOrig = await st(`ewb://page/${pid}/original.pdf`)
  const sTrav = await st(`ewb://page/${pid}/..%2F..%2Fdb.sqlite`)
  const sBadId = await st(`ewb://page/not-a-uuid/page-1.png`)
  check('协议安全', 'page-N.png → 200；original.pdf / 穿越 / 非 UUID → 拒绝', sPage === 200 && sOrig === 400 && sTrav === 400 && sBadId === 400, `${sPage}/${sOrig}/${sTrav}/${sBadId}`)

  // IPC 校验
  const setRes = await page.evaluate(() => window.api.settings.set('schema_version', 99).then(() => 'resolved', e => String(e)))
  const badId = await page.evaluate(() => window.api.papers.get('not-a-uuid').then(() => 'resolved', e => 'rejected'))
  check('IPC 校验', 'settings 内部键不可写；papers.get 非 UUID 被拒', /不允许/.test(setRes) && badId === 'rejected', setRes.slice(-60))

  // 回到列表，测重复/损坏/重试
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  await dropFiles(page, [pdf25])
  await sleep(800)
  const dupMsg = (await page.locator('.ant-message-notice').allInnerTexts()).join(' ')
  check('重复导入', '再次拖入同一文件被提示「重复导入」', /重复导入/.test(dupMsg), dupMsg.replace(/\n/g, ' ').slice(0, 80))

  await dropFiles(page, [path.join(fx, 'corrupt.pdf')])
  await waitFor(async () => (await listPapers(page)).some(p => p.file_name === 'corrupt.pdf' && p.status === 'failed'), 60000)
  const corrupt = (await listPapers(page)).find(p => p.file_name === 'corrupt.pdf')
  check('失败处理', '损坏 PDF → failed，错误信息为中文', corrupt?.status === 'failed' && /PDF/.test(corrupt.error || '') && !/[Ii]nvalid/.test(corrupt.error), corrupt?.error)
  await dropFiles(page, [path.join(fx, 'corrupt.pdf')])
  await sleep(300)
  await waitFor(async () => (await listPapers(page)).filter(p => p.file_name === 'corrupt.pdf').every(p => p.status === 'failed'), 60000)
  const corruptRows = (await listPapers(page)).filter(p => p.file_name === 'corrupt.pdf')
  check('失败处理', '失败的文件可重新导入（旧失败记录被替换，不留重复）', corruptRows.length === 1, `${corruptRows.length} 条`)

  // 重新提取
  const p26 = papers1.find(p => p.file_name === 'g4-2026.pdf')
  await page.locator('tr', { hasText: 'g4-2026' }).locator('[data-testid=reprocess]').click()
  await sleep(500)
  await waitFor(async () => (await listPapers(page)).find(p => p.id === p26.id)?.status === 'done', 90000)
  const dbr = readDb()
  const cnt26 = dbr.prepare('SELECT COUNT(*) c FROM pages WHERE paper_id = ?').get(p26.id).c
  dbr.close()
  check('重新提取', 'reprocess 后仍是 2 页（不产生重复页）', cnt26 === 2, `${cnt26} 页`)

  // 元数据可置空 + 删除会清理磁盘文件
  await page.evaluate(id => window.api.papers.update(id, { grade: '4', exam_type: '期末' }), p26.id)
  const afterSet = await page.evaluate(id => window.api.papers.get(id), p26.id)
  await page.evaluate(id => window.api.papers.update(id, { grade: null, exam_type: null }), p26.id)
  const afterClear = await page.evaluate(id => window.api.papers.get(id), p26.id)
  check('元数据', '字段可以设置也可以置空（null）', afterSet.grade === '4' && afterClear.grade === null && afterClear.exam_type === null)
  const corruptId = (await listPapers(page)).find(p => p.file_name === 'corrupt.pdf').id
  const corruptDir = path.join(userData, 'workbench-data', 'files', corruptId)
  const dirBefore = fs.existsSync(corruptDir)
  const removed = await page.evaluate(id => window.api.papers.remove(id), corruptId)
  const stillListed = (await listPapers(page)).some(p => p.id === corruptId)
  check('删除', '删除试卷同时清理磁盘上的原件与页面图', dirBefore && removed === true && !stillListed && !fs.existsSync(corruptDir))

  // 未内嵌 CJK 字体 + 预定义 CMap 的 PDF：必须读出「测试」两字（依赖 pdf.js 的 CMap 数据）
  await dropFiles(page, [path.join(fx, 'cjk-nonembedded.pdf')])
  await sleep(800)
  const cjkToast = (await page.locator('.ant-message-notice').allInnerTexts()).join(' / ').replace(/\n/g, ' ')
  await waitFor(async () => (await listPapers(page)).find(p => p.file_name === 'cjk-nonembedded.pdf')?.status === 'done', 60000)
  const dbc = readDb()
  const cjk = dbc.prepare("SELECT p.text, p.text_source FROM pages p JOIN papers pp ON pp.id = p.paper_id WHERE pp.file_name = 'cjk-nonembedded.pdf'").get()
  dbc.close()
  check('PDF 字体/CMap', '未内嵌中文字体（GBK-EUC-H）的 PDF 能读出文字「测试」', !!cjk && /测试测试测试/.test(cjk.text || ''), String(JSON.stringify(cjk)).slice(0, 120) + ' toast=' + cjkToast)

  // 对话框导入（点击导入按钮；原生对话框无法点击，故在主进程里替换 showOpenDialog 返回值）
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }) },
    [path.join(fx, 'phone-exif6.jpg'), path.join(fx, 'unit-test.docx'), ...(fs.existsSync(path.join(fx, 'phone.heic')) ? [path.join(fx, 'phone.heic')] : [])])
  await page.getByRole('button', { name: /导入试卷/ }).click()
  await waitFor(async () => (await listPapers(page)).some(p => p.file_name === 'phone-exif6.jpg'), 20000)
  check('对话框导入', '点击「导入试卷」→ 对话框返回路径 → 进入队列', true, '对话框本身为替身，无法点击系统原生窗口')
  await waitFor(() => allSettled(page), 120000)
  const papers2 = await listPapers(page)

  const jpg = papers2.find(p => p.file_name === 'phone-exif6.jpg')
  const dbj = readDb()
  const jpgPage = dbj.prepare('SELECT * FROM pages WHERE paper_id = ?').get(jpg.id)
  const docxPaper = papers2.find(p => p.file_name === 'unit-test.docx')
  const docxPage = dbj.prepare('SELECT * FROM pages WHERE paper_id = ?').get(docxPaper.id)
  const heic = papers2.find(p => p.file_name === 'phone.heic')
  const heicPage = heic && dbj.prepare('SELECT * FROM pages WHERE paper_id = ?').get(heic.id)
  dbj.close()
  check('EXIF 方向', '竖拍照片（EXIF=6，像素横存）规范化为竖图，且 OCR 能识别（>30 行）',
    jpg.status === 'done' && jpgPage.height > jpgPage.width && JSON.parse(jpgPage.lines_json).length > 30,
    `${jpgPage.width}x${jpgPage.height} ${JSON.parse(jpgPage.lines_json).length}行`)
  check('docx', 'docx：text_source=docx，文本入库，无伪造坐标', docxPaper.status === 'done' && docxPage.text_source === 'docx' && /How are you/.test(docxPage.text) && docxPage.lines_json === '[]',
    `${docxPage.text_source} ${docxPage.text.length}字`)
  if (heic) {
    check('HEIC', 'HEIC 导入成功且方向正确（竖图 + OCR>30 行）', heic.status === 'done' && heicPage.height > heicPage.width && JSON.parse(heicPage.lines_json).length > 30,
      `${heic.status} ${heicPage.width}x${heicPage.height} ${JSON.parse(heicPage.lines_json).length}行 ${heic.error || ''}`)
  }
  await page.evaluate(id => { location.hash = '#/paper/' + id }, jpg.id)
  await page.waitForSelector('img[alt="第1页"]')
  await page.locator('.ant-switch').click()
  await sleep(600)
  await page.screenshot({ path: path.join(shots, 'fix-04-detail-exif-overlay.png') })
  await page.evaluate(id => { location.hash = '#/paper/' + id }, docxPaper.id)
  await sleep(800)
  const docxShown = await page.getByText('How are you').count()
  check('docx', 'docx 详情页能看到文字内容', docxShown > 0)
  await page.screenshot({ path: path.join(shots, 'fix-05-detail-docx.png') })
  await page.evaluate(() => { location.hash = '#/' })
  await sleep(500)
  await page.screenshot({ path: path.join(shots, 'fix-06-library-final.png') })

  // 生命周期（P0-2 / P0-3）：导入过 PDF 后关闭主窗口，再激活
  if (process.platform === 'darwin') {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(w => w.close()) })
    await sleep(800)
    const nWin = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    check('生命周期', '关闭主窗口后，隐藏的 PDF 渲染窗口一并销毁（0 个窗口残留）', nWin === 0, `${nWin} 个窗口`)
    await app.evaluate(({ app }) => { app.emit('activate') })
    await sleep(1500)
    const page2 = await app.firstWindow()
    await page2.waitForSelector('[data-testid=dropzone]', { timeout: 20000 })
    const again = await page2.evaluate(() => window.api.papers.list().then(l => l.length, e => 'ERR ' + e))
    check('生命周期', 'macOS 关窗后从 Dock 激活：窗口重建且数据库 IPC 仍可用', typeof again === 'number' && again > 5, `list=${again}`)
    page = page2
  } else {
    check('生命周期', 'Windows/Linux 关窗退出（需在对应平台验证）', false, '⚠️ 本机为 macOS，未验证')
  }
  await app.close()

  // ───────── 第 2 次：强杀恢复 ─────────
  ;({ app, page } = await launch())
  const killPdf = path.join(fx, 'kill-me.pdf')
  fs.writeFileSync(killPdf, Buffer.concat([fs.readFileSync(pdf26), Buffer.from('\n% kill-test\n')]))
  await dropFiles(page, [killPdf])
  // 紧盯状态，一看到「排队/提取中」立刻 kill -9，确保真的杀在提取过程里
  const inFlight = await waitFor(async () => {
    const st = (await listPapers(page)).find(p => p.file_name === 'kill-me.pdf')?.status
    return ['imported', 'extracting'].includes(st) ? st : null
  }, 15000, 15)
  const statusBeforeKill = inFlight || (await listPapers(page)).find(p => p.file_name === 'kill-me.pdf')?.status
  process.kill(app.process().pid, 'SIGKILL')
  await sleep(1500)
  ;({ app, page } = await launch())
  const afterKill = (await listPapers(page)).find(p => p.file_name === 'kill-me.pdf')
  check('崩溃恢复', `提取中被强杀（kill -9，杀前状态=${statusBeforeKill}）后重启，不再卡在「提取中」`,
    !!inFlight && afterKill?.status === 'failed' && /中断/.test(afterKill.error || ''), `${afterKill?.status} ${afterKill?.error || ''}`)
  if (afterKill?.status === 'failed') {
    await page.locator('tr', { hasText: 'kill-me' }).locator('[data-testid=reprocess]').click()
    const re = await waitFor(async () => (await listPapers(page)).find(p => p.file_name === 'kill-me.pdf')?.status === 'done', 90000)
    check('崩溃恢复', '点「重试」后恢复为已提取', !!re)
  }
  await app.close()

  // ───────── 第 3 次：不带环境变量，检查默认 userData 路径（与启动方式无关）─────────
  const env3 = { ...process.env }
  delete env3.EWB_USER_DATA_DIR
  const app3 = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env: env3 })
  const ud3 = await app3.evaluate(({ app }) => app.getPath('userData'))
  await app3.close()
  check('数据目录', '未设置环境变量时 userData = ~/Library/Application Support/english-exam-workbench（dev/打包一致）',
    ud3 === path.join(os.homedir(), 'Library/Application Support/english-exam-workbench') || process.platform !== 'darwin', ud3)
}

main().then(() => finish(), e => { console.error('E2E 异常:', e); check('E2E', '测试脚本未异常退出', false, e.message); finish() })

function finish() {
  const failed = results.filter(r => !r.pass)
  fs.writeFileSync(path.join(__dirname, 'last-result.json'), JSON.stringify(results, null, 2))
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过；工作目录 ${work} ====`)
  process.exit(failed.length ? 1 : 0)
}
