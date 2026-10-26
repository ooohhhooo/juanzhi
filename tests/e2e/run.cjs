// 端到端测试：用 playwright-core 启动真实的 Electron 应用（out/ 构建产物），
// 通过 CDP 派发真实的 drop 事件、驱动界面并核对数据库。
// 用法：npm run test:e2e   （需在沙箱外运行；会先构建）
const { _electron: electron } = require('playwright-core')
const { DatabaseSync } = require('node:sqlite')
const { execFileSync, spawnSync } = require('node:child_process')
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
    UPDATE papers SET error = '有 1 页没有识别出文字' WHERE id LIKE '1111%';
    INSERT INTO pages (paper_id, idx, image_rel, text_source, lines_json) VALUES
      ('11111111-1111-4111-8111-111111111111', 1, 'page-1.png', 'pdf-text+ocr', '[]');
  `)
  db.close()
}

function readDb(ud = userData) {
  const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'), { readOnly: true })
  return db
}

async function launch({ appDir = root, userDataDir = userData } = {}) {
  const env = { ...process.env, EWB_USER_DATA_DIR: userDataDir }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k]
  const app = await electron.launch({ executablePath: require('electron'), args: [appDir], cwd: appDir, env })
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(String(e)))
  await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  // 监听器挂好之后整页重载一次，这样加载早期的 CSP 违规也不会漏掉
  await page.reload()
  await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  return { app, page, consoleErrors }
}

async function dropFiles(page, paths, at) {
  // 顶部堆叠的 toast 会盖住拖拽区，先等它们消失
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  let x, y
  if (at) { ({ x, y } = at) } else {
    const box = await page.locator('[data-testid=dropzone]').boundingBox()
    x = box.x + box.width / 2
    y = box.y + box.height / 2
  }
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
  return ps.length > 0 && ps.every(p => ['extracted', 'failed'].includes(p.status))
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
  const hasAssets = !!dbm.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_assets'").get()
  const legacyRows = dbm.prepare("SELECT id, status, error, warning FROM papers ORDER BY id").all()
  const legacyPages = dbm.prepare('SELECT COUNT(*) c, MAX(text_source) ts FROM pages').get()
  dbm.close()
  const L1 = legacyRows.find(r => r.id.startsWith('1111'))
  const L2 = legacyRows.find(r => r.id.startsWith('2222'))
  check('迁移', '旧库(user_version=0)启动后升级到最新版本 v9（M2 新增 v5、M3 新增 v6、v7、v8、M4 新增 v9）', uv === 9, `user_version=${uv}`)
  check('迁移', '新增列与附件表齐全，旧数据保留',
    ['text', 'ocr_conf', 'ocr_error', 'text_layer_chars'].every(c => pageCols.includes(c)) &&
    ['extracted_at', 'warning', 'duplicate_of'].every(c => paperCols.includes(c)) && hasAssets && legacyPages.c === 1,
    `pages 列=${pageCols.join(',')}`)
  check('迁移', 'v4 把旧 done 映射为 extracted，原挂在 error 上的警告挪到 warning，pdf-text+ocr 改名为 ocr',
    L1?.status === 'extracted' && L1.error === null && L1.warning === '有 1 页没有识别出文字' && legacyPages.ts === 'ocr', JSON.stringify(L1))
  check('崩溃恢复', '启动时把遗留的 extracting 标成 failed 并提示重试',
    L2?.status === 'failed' && /中断/.test(L2?.error || ''), JSON.stringify(L2))

  const dataDir = await page.evaluate(() => window.api.settings.getDataDir())
  check('数据目录', '数据目录 = EWB_USER_DATA_DIR/workbench-data', dataDir === path.join(userData, 'workbench-data'), dataDir)

  const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '')
  check('CSP', '页面带 CSP（含 base-uri/form-action），整页重载全程无违规', /default-src 'self'/.test(csp) && /base-uri 'none'/.test(csp) && !consoleErrors.some(e => /Content Security Policy/i.test(e)), consoleErrors.join(' | ').slice(0, 200))

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
  check('拖拽导入', '3 份文件全部提取完成（status=extracted）', settled && papers1.length === 3 && papers1.every(p => p.status === 'extracted'), papers1.map(p => `${p.file_name}:${p.status}`).join(', '))

  const uiDone = await waitFor(async () => {
    // 库页的行显示的是标题（文件名去掉扩展名），exact 避免 g4-2025 误匹配 g4-2025-page1
    for (const title of ['g4-2025', 'g4-2026', 'g4-2025-page1']) {
      const row = page.locator('tr', { has: page.getByText(title, { exact: true }) })
      if ((await row.getByText('已提取').count()) === 0) return false
    }
    return true
  }, 15000)
  check('事件刷新', '列表无需手动刷新，3 份试卷都自动显示为「已提取」（data:changed → 重新查询）', !!uiDone)
  const prog = await page.evaluate(() => window.__prog)
  check('事件刷新', '渲染端收到 job:progress，且包含 extracted 终态', prog.length > 0 && prog.some(p => p.stage === 'extracted'), `${prog.length} 条`)

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
  const varied = pdfLines.every(ls => new Set(ls.map(l => l.x.toFixed(3))).size >= 2 && new Set(ls.map(l => l.w.toFixed(3))).size > 5)
  check('PDF 文本层', 'lines_json 是 PDF 自带的真实坐标：范围合法，且 x、w 有多种取值（伪造的固定值过不了）', coordsOk && varied, pdfLines.map(l => l.length + '行').join(','))
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

  // 全局拖放：在非试卷库页面（详情页的任意位置）拖入文件，窗口不能被导航成该文件
  const entryBefore = page.url().split('#')[0]
  await dropFiles(page, [path.join(fx, 'old-format.doc')], { x: 700, y: 450 })
  await sleep(700)
  const hashAfter = await page.evaluate(() => location.hash)
  const navToast = (await page.locator('.ant-message-notice').allInnerTexts()).join(' ')
  check('导航拦截', '在详情页拖入文件：窗口仍在应用入口页，被当作导入处理并跳到试卷库',
    page.url().split('#')[0] === entryBefore && hashAfter === '#/' && /\.doc/.test(navToast) && (await page.locator('[data-testid=dropzone]').count()) === 1,
    `${page.url().split('#')[0] === entryBefore ? '入口页未变' : '页面被导航走了: ' + page.url()} hash=${hashAfter}`)
  await page.evaluate(() => { location.href = 'file:///etc/hosts' })
  await sleep(1200)
  check('导航拦截', '页面脚本直接跳转到任意 file:// 被 will-navigate 拦截',
    page.url().split('#')[0] === entryBefore && (await page.locator('[data-testid=dropzone]').count()) === 1, page.url())

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

  // 路径授权：页面脚本自己传一个从未经对话框/拖拽登记的路径，必须被拒
  const unreg = path.join(fx, 'unregistered.pdf')
  fs.writeFileSync(unreg, Buffer.concat([fs.readFileSync(pdf26), Buffer.from('\n% unregistered\n')]))
  const authRes = await page.evaluate(p => window.api.papers.import([p]), unreg)
  const unregRows = (await listPapers(page)).filter(p => p.file_name === 'unregistered.pdf').length
  check('路径授权', '页面脚本直接传入从未登记的路径 → 被拒绝，且没有入库', /未经授权/.test(authRes[0]?.error || '') && unregRows === 0, authRes[0]?.error)

  // 设置页：OCR 状态
  await page.evaluate(() => { location.hash = '#/settings' })
  await page.waitForSelector('[data-testid=ocr-status]')
  const ocrOn = await page.locator('[data-testid=ocr-status]').innerText()
  const ocrDetail = await page.locator('[data-testid=ocr-detail]').innerText()
  check('OCR 状态', '设置页显示「OCR 可用」及说明', ocrOn === '可用' || process.platform !== 'darwin', `${ocrOn} / ${ocrDetail}`)
  await page.screenshot({ path: path.join(shots, 'fix-07-settings-ocr.png') })

  // 回到列表，测重复/损坏/重试
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  await dropFiles(page, [pdf25])
  const dupBox = await page.waitForSelector('[data-testid=duplicate-confirm]', { timeout: 10000 }).catch(() => null)
  const dupText = dupBox ? await dupBox.innerText() : ''
  check('重复导入', '再次拖入同一文件：弹出「内容相同」确认框', !!dupBox && /内容完全相同/.test(dupText), dupText.replace(/\n/g, ' ').slice(0, 80))
  await page.getByRole('button', { name: /跳\s*过/ }).click()
  await sleep(600)
  const afterSkip = (await listPapers(page)).filter(p => p.file_name === 'g4-2025.pdf').length
  check('重复导入', '选「跳过」不产生新记录', afterSkip === 1, `${afterSkip} 条`)

  await dropFiles(page, [png1])
  await page.waitForSelector('[data-testid=duplicate-confirm]', { timeout: 10000 }).catch(() => null)
  await page.getByRole('button', { name: /仍然导入/ }).click()
  const dupRows = await waitFor(async () => {
    const r = (await listPapers(page)).filter(p => p.file_name === 'g4-2025-page1.png')
    return r.length === 2 && r.every(p => p.status === 'extracted') ? r : null
  }, 60000)
  const origPng = papers1.find(p => p.file_name === 'g4-2025-page1.png')
  const copyPng = dupRows?.find(p => p.id !== origPng.id)
  check('重复导入', '选「仍然导入」后多出一份，duplicate_of 指向原件，且没有 UNIQUE 约束拦截', !!copyPng && copyPng.duplicate_of === origPng.id, `duplicate_of=${copyPng?.duplicate_of?.slice(0, 8)}`)

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
  await waitFor(async () => (await listPapers(page)).find(p => p.id === p26.id)?.status === 'extracted', 90000)
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
  await waitFor(async () => (await listPapers(page)).find(p => p.file_name === 'cjk-nonembedded.pdf')?.status === 'extracted', 60000)
  const dbc = readDb()
  const cjk = dbc.prepare("SELECT p.text, p.text_source FROM pages p JOIN papers pp ON pp.id = p.paper_id WHERE pp.file_name = 'cjk-nonembedded.pdf'").get()
  dbc.close()
  check('PDF 字体/CMap', '未内嵌中文字体（GBK-EUC-H）的 PDF 能读出文字「测试」', !!cjk && /测试测试测试/.test(cjk.text || ''), String(JSON.stringify(cjk)).slice(0, 120) + ' toast=' + cjkToast)

  // 对话框导入（点击导入按钮；系统原生对话框无法被自动点击，故在主进程里替换 showOpenDialog 的返回值，
  // 返回路径仍然要走 dialog:openFiles 的登记逻辑，所以授权链是真的）
  const hasHeic = fs.existsSync(path.join(fx, 'phone.heic'))
  check('HEIC', 'HEIC 夹具存在（macOS 上缺失即失败，不允许静默跳过）', hasHeic || process.platform !== 'darwin')
  const dialogFiles = ['phone-exif6.jpg', 'unit-test.docx', ...(hasHeic ? ['phone.heic'] : []), 'blank-page.png',
    'garbled-textlayer.pdf', 'docx-image-only.docx', 'docx-textbox.docx', 'docx-empty.docx'].map(f => path.join(fx, f))
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }) }, dialogFiles)
  await page.getByRole('button', { name: /导入试卷/ }).click()
  const dialogQueued = await waitFor(async () => {
    const l = await listPapers(page)
    return dialogFiles.every(f => l.some(p => p.file_name === path.basename(f)))
  }, 30000)
  check('对话框导入', `点击「导入试卷」→ 对话框返回 ${dialogFiles.length} 个路径 → 全部入库排队（对话框本身是替身）`, !!dialogQueued)
  await waitFor(() => allSettled(page), 240000)
  const papers2 = await listPapers(page)

  const dbj = readDb()
  const P = n => papers2.find(p => p.file_name === n)
  const pg = n => dbj.prepare('SELECT * FROM pages WHERE paper_id = ?').get(P(n).id)
  const assetsOf = n => dbj.prepare('SELECT * FROM paper_assets WHERE paper_id = ? ORDER BY seq').all(P(n).id)
  const jpg = P('phone-exif6.jpg'), jpgPage = pg('phone-exif6.jpg')
  check('EXIF 方向', '竖拍照片（EXIF=6，像素横存）规范化为竖图，且 OCR 能识别（>30 行）',
    jpg.status === 'extracted' && jpgPage.height > jpgPage.width && JSON.parse(jpgPage.lines_json).length > 30,
    `${jpgPage.width}x${jpgPage.height} ${JSON.parse(jpgPage.lines_json).length}行`)
  if (hasHeic) {
    const h = P('phone.heic'), hp = pg('phone.heic')
    check('HEIC', 'HEIC 导入成功且方向正确（竖图 + OCR>30 行）', h.status === 'extracted' && hp.height > hp.width && JSON.parse(hp.lines_json).length > 30,
      `${h.status} ${hp.width}x${hp.height} ${JSON.parse(hp.lines_json).length}行 ${h.error || ''}`)
  }

  // docx：文本 + 内嵌图片
  const docxPaper = P('unit-test.docx'), docxPage = pg('unit-test.docx'), docxAssets = assetsOf('unit-test.docx')
  const mediaFile = path.join(userData, 'workbench-data', 'files', docxPaper.id, 'media', '1.png')
  check('docx', 'docx：文本入库且 [图1] 占位在原位，图片落盘并登记到 paper_assets，不造坐标',
    docxPaper.status === 'extracted' && docxPage.text_source === 'docx' && /How are you[\s\S]*\[图1\][\s\S]*What is this/.test(docxPage.text) &&
    docxPage.lines_json === '[]' && docxAssets.length === 1 && docxAssets[0].mime === 'image/png' && docxAssets[0].bytes > 0 && fs.existsSync(mediaFile),
    `${docxPage.text_source} ${docxPage.text.length}字 assets=${docxAssets.length}`)
  const stM = url => app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, url)
  const mOk = await stM(`ewb://media/${docxPaper.id}/1.png`)
  const mOrig = await stM(`ewb://media/${docxPaper.id}/original.docx`)
  const mTrav = await stM(`ewb://media/${docxPaper.id}/..%2Fpage-1.png`)
  const mBad = await stM(`ewb://media/not-a-uuid/1.png`)
  check('协议安全', 'ewb://media：图片 200；原件 / 穿越 / 非 UUID → 400', mOk === 200 && mOrig === 400 && mTrav === 400 && mBad === 400, `${mOk}/${mOrig}/${mTrav}/${mBad}`)

  const dImg = P('docx-image-only.docx'), dImgPage = pg('docx-image-only.docx')
  check('docx', '纯图片 docx：[图1] 入库，并提示「主要是图片」而不是静默已提取', dImg.status === 'extracted' && /\[图1\]/.test(dImgPage.text) && /主要是图片/.test(dImg.warning || ''), dImg.warning)
  const dBox = P('docx-textbox.docx')
  check('docx', '带文本框的 docx：提示「文本框里的文字没有被提取」', dBox.status === 'extracted' && /文本框/.test(dBox.warning || ''), dBox.warning)
  const dEmpty = P('docx-empty.docx'), dEmptyPage = pg('docx-empty.docx')
  check('docx', '空 docx：text_source=none 且有警告', dEmpty.status === 'extracted' && dEmptyPage.text_source === 'none' && /没有可提取/.test(dEmpty.warning || ''), dEmpty.warning)

  // 区分「页面真的没字」与「OCR 没跑成」
  const blank = P('blank-page.png'), blankPage = pg('blank-page.png')
  check('OCR 失败原因', 'OCR 正常运行但页面空白 → text_source=none，没有 ocr_error，提示「OCR 已运行」',
    blank.status === 'extracted' && blankPage.text_source === 'none' && blankPage.ocr_error === null && /OCR 已运行/.test(blank.warning || ''), `${blankPage.text_source} / ${blank.warning}`)
  // 文本层质量门：字数够但全是私有区字符
  const garbled = P('garbled-textlayer.pdf'), garbledPage = pg('garbled-textlayer.pdf')
  check('文本层质量门', '文本层字数已过 50 字门槛、但全是私有区乱码 → 不当作 pdf-text（只有乱码占比检查能拒绝它），转 OCR，并记录 text_layer_chars',
    garbled.status === 'extracted' && garbledPage.text_source !== 'pdf-text' && garbledPage.text_layer_chars >= 50, `${garbledPage.text_source} layer=${garbledPage.text_layer_chars}`)
  dbj.close()

  await page.evaluate(id => { location.hash = '#/paper/' + id }, jpg.id)
  await page.waitForSelector('img[alt="第1页"]')
  await page.locator('.ant-switch').click()
  await sleep(600)
  await page.screenshot({ path: path.join(shots, 'fix-04-detail-exif-overlay.png') })

  // docx 详情页：文字 + 内联图片，没有破图缩略图，也没有无意义的叠加开关
  await page.evaluate(id => { location.hash = '#/paper/' + id }, docxPaper.id)
  await page.waitForSelector('[data-testid=docx-view]')
  const docxImgOk = await waitFor(() => page.evaluate(() => { const i = document.querySelector('[data-testid=docx-image]'); return !!i && i.complete && i.naturalWidth > 0 }), 10000)
  const brokenThumbs = await page.locator('img[alt^="第"]').count()
  const switches = await page.locator('.ant-switch').count()
  const docxShown = await page.getByText('How are you').count()
  check('docx', '详情页：文字可见、图片内联且加载成功、无页面缩略图请求（不再破图）、无叠加开关', docxShown > 0 && !!docxImgOk && brokenThumbs === 0 && switches === 0,
    `文字=${docxShown} 图片ok=${!!docxImgOk} 页图=${brokenThumbs} 开关=${switches}`)
  await page.screenshot({ path: path.join(shots, 'fix-05-detail-docx.png') })

  // 删除带附件的试卷：附件行（外键级联）与 media 目录一并清理
  const delDir = path.join(userData, 'workbench-data', 'files', dImg.id)
  const hadMedia = fs.existsSync(path.join(delDir, 'media'))
  await page.evaluate(id => window.api.papers.remove(id), dImg.id)
  const dbd = readDb()
  const leftAssets = dbd.prepare('SELECT COUNT(*) c FROM paper_assets WHERE paper_id = ?').get(dImg.id).c
  dbd.close()
  check('删除', '删除含图片的 docx：paper_assets 级联清空，media 目录一并删除', hadMedia && leftAssets === 0 && !fs.existsSync(delDir), `残留附件行=${leftAssets}`)
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
    await page.locator('tr', { hasText: 'kill-me' }).locator('[data-testid=retry-extract]').click()   // M4 N10：失败卷的重试入口与处理队列统一
    const re = await waitFor(async () => (await listPapers(page)).find(p => p.file_name === 'kill-me.pdf')?.status === 'extracted', 90000)
    check('崩溃恢复', '点「重试」后恢复为已提取', !!re)
  }
  await app.close()

  // ───────── 第 3 次：OCR 组件缺失（应用副本里没有 native/，不给生产代码加后门）─────────
  const noOcrApp = path.join(work, 'app-no-ocr')
  fs.mkdirSync(noOcrApp, { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(noOcrApp, 'package.json'))
  fs.cpSync(path.join(root, 'out'), path.join(noOcrApp, 'out'), { recursive: true })
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(noOcrApp, 'node_modules'), 'dir')
  const ud4 = path.join(work, 'userData-no-ocr')
  const r4 = await launch({ appDir: noOcrApp, userDataDir: ud4 })
  await dropFiles(r4.page, [png1])
  await waitFor(async () => (await listPapers(r4.page)).some(p => p.file_name === 'g4-2025-page1.png' && ['extracted', 'failed'].includes(p.status)), 60000)
  const lp = (await listPapers(r4.page)).find(p => p.file_name === 'g4-2025-page1.png')
  const d4 = readDb(ud4)
  const lpPage = d4.prepare('SELECT * FROM pages WHERE paper_id = ?').get(lp.id)
  d4.close()
  check('OCR 失败原因', 'OCR 组件缺失：页面标 ocr_failed，保存具体原因，试卷警告里带上它（而不是「没识别出文字」）',
    lp.status === 'extracted' && lpPage.text_source === 'ocr_failed' && /找不到 OCR 组件/.test(lpPage.ocr_error || '') && /OCR 没有成功/.test(lp.warning || ''),
    `${lpPage.text_source} | ${lpPage.ocr_error}`)
  await r4.page.evaluate(id => { location.hash = '#/paper/' + id }, lp.id)
  await r4.page.waitForSelector('[data-testid=ocr-failed]', { timeout: 10000 }).catch(() => {})
  const failedShown = await r4.page.locator('[data-testid=ocr-failed]').innerText().catch(() => '')
  await r4.page.screenshot({ path: path.join(shots, 'fix-08-ocr-failed.png') })
  check('OCR 失败原因', '详情页把失败原因直接展示给用户', /找不到 OCR 组件/.test(failedShown) && (await r4.page.locator('[data-testid=paper-warning]').count()) === 1, failedShown.slice(0, 80))
  await r4.page.evaluate(() => { location.hash = '#/settings' })
  await r4.page.waitForSelector('[data-testid=ocr-status]')
  const st4 = await r4.page.locator('[data-testid=ocr-status]').innerText()
  const dt4 = await r4.page.locator('[data-testid=ocr-detail]').innerText()
  check('OCR 状态', '设置页显示「OCR 不可用」并说明原因', st4 === '不可用' && /找不到 OCR 组件/.test(dt4), `${st4} / ${dt4}`)
  await r4.app.close()

  // ───────── 第 4 次：不带环境变量，检查默认 userData 路径（只打印路径就退出，不碰真实数据库）─────────
  const env5 = { ...process.env, EWB_PRINT_USERDATA: '1' }
  delete env5.EWB_USER_DATA_DIR
  const out5 = spawnSync(require('electron'), ['.'], { cwd: root, env: env5, encoding: 'utf8', timeout: 30000 })
  const ud5 = /EWB_USERDATA=(.*)/.exec(out5.stdout || '')?.[1]?.trim()
  const expected5 = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/english-exam-workbench') : null
  check('数据目录', '未设置环境变量时 userData = <appData>/english-exam-workbench（dev/打包一致；本项不初始化数据库）',
    !!ud5 && (expected5 ? ud5 === expected5 : /english-exam-workbench$/.test(ud5)), ud5)
}

main().then(() => finish(), e => { console.error('E2E 异常:', e); check('E2E', '测试脚本未异常退出', false, e.message); finish() })

function finish() {
  const failed = results.filter(r => !r.pass)
  fs.writeFileSync(path.join(__dirname, 'last-result.json'), JSON.stringify(results, null, 2))
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过；工作目录 ${work} ====`)
  process.exit(failed.length ? 1 : 0)
}
