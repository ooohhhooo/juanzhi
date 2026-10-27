// 打包版冒烟 E2E（M5）：启动「打包出来的」应用（不是 out/ + 开发版 electron），走一遍真实流程，核对资源路径在打包后都找得到。
//
//   node tests/e2e/smoke-packaged.cjs                  自动找本机刚打出来的包（见 findApp）
//   EWB_APP_EXE=<可执行文件> node tests/e2e/smoke-packaged.cjs
//   EWB_SMOKE_OUT=<目录>                               截图 / 结果 JSON 的输出目录（默认 docs/screenshots，CI 里设成 smoke-artifacts）
//
// 流程：启动 → 打包事实（isPackaged / app.asar / OCR 组件在 resources/native 里）→ 导入图片（OCR，或如实的降级提示）→ 导入 docx
// （mammoth / jszip 在 asar 里能动态加载）→ 配 mock AI（tests/mock-ai，随机端口，不占 18080）→ 导入两份文本型 PDF（走文字层）→ AI 解析 → 确认
// → 看板有数据 → 生成报告（mock P3）并导出 Markdown / PDF（检查中文字体）→ 导出数据包。
// 全程用临时 userData（EWB_USER_DATA_DIR），不碰真实数据目录；不调用真实 AI。失败时把窗口截图存进输出目录。
'use strict'
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const JSZip = require('jszip')
const { startMock } = require('../mock-ai/server.cjs')

const root = path.resolve(__dirname, '../..')
const pkg = require('../../package.json')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const outDir = path.resolve(process.env.EWB_SMOKE_OUT || path.join(root, 'docs/screenshots'))
const prefix = process.env.EWB_SMOKE_PREFIX ?? 'm5-'
fs.mkdirSync(outDir, { recursive: true })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-smoke-'))
const userData = path.join(work, 'userData')

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
function check(feature, name, pass, detail = '') {
  results.push({ feature, name, pass: !!pass, detail: String(detail).slice(0, 600) })
  console.log(`${pass ? '✅' : '❌'} [${feature}] ${name}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`)
}
async function waitFor(fn, ms = 120000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}

/** 找打包出来的可执行文件：EWB_APP_EXE > 各个常见输出目录里的 unpacked 产物 */
function findApp() {
  if (process.env.EWB_APP_EXE) return process.env.EWB_APP_EXE
  const dirs = [process.env.EWB_BUILD_DIR, path.join(root, 'release'), path.join(os.homedir(), '.ewb-build')].filter(Boolean)
  for (const d of dirs) {
    if (isWin) {
      const p = path.join(d, 'win-unpacked', 'EnglishExamWorkbench.exe')
      if (fs.existsSync(p)) return p
    } else if (isMac) {
      const sub = process.arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64']
      for (const s of sub) {
        const app = path.join(d, s, '英语校考分析工作台.app')
        const exe = path.join(app, 'Contents/MacOS/英语校考分析工作台')
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  throw new Error('找不到打包产物：先运行 npm run dist:mac / dist:win，或用 EWB_APP_EXE 指定可执行文件')
}

// ── 测试用的 docx：一段中文 + 一张图（用 jszip 现拼，CI 上不需要 python-docx）──
async function makeDocx(file) {
  const z = new JSZip()
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  z.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  const p = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${p('冒烟测试 · 四年级英语 · 一、选择题')}${p('1. How many apples are there? 这里有几个苹果？ ' + 'This is a smoke test paper. '.repeat(3))}<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="p1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${p('2. Look at the picture above. 看上面的图。')}<w:sectPr/></w:body></w:document>`)
  z.file('word/media/image1.png', fs.readFileSync(path.join(root, 'build/icon.png')))
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return file
}

/** pdf.js（Node 里直接读，不需要画布）：页数、全文、用到的字体名 */
async function pdfInfo(file) {
  const pdfjs = await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href)
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise
  let text = ''
  const fonts = new Set()
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map(x => x.str).join('') + '\n'
    try {
      const ops = await page.getOperatorList()
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== pdfjs.OPS.setFont) continue
        const id = ops.argsArray[k][0]
        const f = await new Promise(res => { const t = setTimeout(() => res(null), 3000); page.commonObjs.get(id, o => { clearTimeout(t); res(o) }) })
        if (f && (f.name || f.loadedName)) fonts.add(String(f.name || f.loadedName))
      }
    } catch { /* 字体名只作记录，取不到不算失败 */ }
  }
  const n = doc.numPages
  await doc.destroy()
  return { pages: n, text, fonts: [...fonts] }
}

const CJK = /[一-鿿]/
// 能画中文的字体族（Chrome printToPDF 嵌入的是实际用到的字体，名字形如 ABCDEE+PingFangSC-Regular）
// 注意不能含裸的 Microsoft（MicrosoftSansSerif 之类不能画汉字）：只认 YaHei / JhengHei 等明确的中文字体名
const CJK_FONT = /PingFang|Microsoft ?YaHei|MicrosoftYaHei|微软雅黑|Microsoft ?JhengHei|MicrosoftJhengHei|SimSun|SimHei|NSimSun|DengXian|KaiTi|FangSong|Noto.*(Sans|Serif).*(CJK|SC)|SourceHan|Source ?Han|WenQuanYi|Heiti|STHei|STSong|Songti|Hiragino|Yu ?Gothic|Meiryo|MS ?Gothic|Droid ?Sans ?Fallback/i

async function main() {
  const exe = findApp()
  console.log('打包版：', exe)
  const mock = await startMock({ port: 0, apiKey: 'sk-smoke-key' })
  const env = { ...process.env, EWB_USER_DATA_DIR: userData }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'ELECTRON_RUN_AS_NODE']) delete env[k]
  // macOS：--use-mock-keychain 让 safeStorage 用内存里的假钥匙串（只给自动化测试用）。否则打包版第一次保存 API Key 会弹出「钥匙串访问」授权框，无人值守的测试会一直卡住
  // （真实使用时这个弹窗是正常的，见 docs/安装指南.md）。Windows 的 DPAPI 不需要
  const app = await electron.launch({ executablePath: exe, args: isMac ? ['--use-mock-keychain'] : [], env, timeout: 90000 })
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(String(e)))
  const state = { app, page, mock }
  const shot = name => page.screenshot({ path: path.join(outDir, `${prefix}${name}.png`), timeout: 90000 })
  state.shot = shot
  try {
    await page.waitForSelector('[data-testid=dropzone]', { timeout: 60000 })
    const api = (fn, arg) => page.evaluate(fn, arg)
    const T = id => page.locator(`[data-testid="${id}"]`)

    // ── 1. 打包事实 ──
    const facts = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), name: app.getName(), userData: app.getPath('userData'),
      resources: process.resourcesPath, platform: process.platform, arch: process.arch
    }))
    check('打包事实', 'app.isPackaged 为真，应用代码在 app.asar 里', facts.packaged === true && /app\.asar$/.test(facts.appPath), `${facts.appPath}`)
    check('打包事实', `版本号 = package.json（${pkg.version}），应用名固定为 english-exam-workbench（与 productName 无关，userData 路径不随打包版名字变）`, facts.version === pkg.version && facts.name === 'english-exam-workbench', `${facts.version} ${facts.name}`)
    check('打包事实', 'userData 就是测试指定的临时目录（EWB_USER_DATA_DIR 生效，没碰真实数据目录）', path.resolve(facts.userData) === path.resolve(userData), facts.userData)
    const helper = isMac ? path.join(facts.resources, 'native/macos/bin/ewb-ocr') : path.join(facts.resources, 'native/windows/ocr.ps1')
    check('打包事实', `OCR 组件在 resources/native 里（${path.basename(helper)}），不在 asar 里`, fs.existsSync(helper) && !/app\.asar/.test(helper), helper)
    if (isMac) check('打包事实', 'OCR helper 带执行位（Mac 上没有它图片 OCR 全坏）', (fs.statSync(helper).mode & 0o111) === 0o111, (fs.statSync(helper).mode & 0o777).toString(8))
    if (isWin) {
      const b = fs.readFileSync(helper)
      check('打包事实', 'ocr.ps1 带 UTF-8 BOM（打包没有改字节；PowerShell 5.1 对无 BOM 脚本按 GBK 读）', b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    }
    // asar 里的文件只有在 Electron 自己的进程里（fs 被打了 asar 补丁）才读得到，所以在主进程里查
    const pdfjsFiles = ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps/GBK-EUC-H.bcmap', 'standard_fonts/FoxitSerif.pfb']
    const inAsar = await app.evaluate(({ app }, fl) => {
      const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
      const dir = path.join(app.getAppPath(), 'node_modules/pdfjs-dist')
      return { dir, missing: fl.filter(f => !fs.existsSync(path.join(dir, f))), pkg: fs.existsSync(path.join(dir, 'package.json')), canvas: fs.existsSync(path.join(app.getAppPath(), 'node_modules/@napi-rs')), antd: fs.existsSync(path.join(app.getAppPath(), 'node_modules/antd')) }
    }, pdfjsFiles)
    check('打包事实', 'asar 里有 pdf.js 需要的文件（legacy/build 两个 .mjs、cmaps、standard_fonts），没有多余的原生模块 @napi-rs，也没有只给渲染端用的 antd', inAsar.pkg && inAsar.missing.length === 0 && !inAsar.canvas && !inAsar.antd, JSON.stringify(inAsar))
    // 老师看到的名字（M5 审核 P2-8）：app.name 是内部名，菜单 / 窗口标题不能露出它。原生菜单栏截不了图（playwright 只能截页面），
    // 所以直接读主进程里真正安装的菜单、窗口标题和 Info.plist，写进 m5-menu-*.json 留证
    const uiNames = await app.evaluate(({ Menu, BrowserWindow }) => ({
      menu: (Menu.getApplicationMenu()?.items ?? []).map(i => ({ label: i.label, items: (i.submenu?.items ?? []).map(x => x.type === 'separator' ? '—' : x.label) })),
      title: BrowserWindow.getAllWindows()[0]?.getTitle()
    }))
    fs.writeFileSync(path.join(outDir, `${prefix}menu-${process.platform}.json`), JSON.stringify({ ...uiNames, appName: facts.name, pageTitle: await page.title() }, null, 2))
    check('产品名', `窗口标题和页面标题都是「英语校考分析工作台」（不是内部名 ${facts.name}，也不是第三个名字）`, uiNames.title === '英语校考分析工作台' && (await page.title()) === '英语校考分析工作台', `${uiNames.title} / ${await page.title()}`)
    if (isMac) {
      const flat = JSON.stringify(uiNames.menu)
      const appMenu = uiNames.menu[0]
      check('产品名', 'macOS 应用菜单：第一项和「关于 / 隐藏 / 退出」都用产品名，菜单里没有 english-exam-workbench；有编辑菜单（Cmd+C / V）', appMenu?.label === '英语校考分析工作台' && appMenu.items.includes('关于英语校考分析工作台') && appMenu.items.includes('退出英语校考分析工作台') && appMenu.items.includes('隐藏英语校考分析工作台') && !flat.includes('english-exam-workbench') && uiNames.menu.some(m => m.label === '编辑' && m.items.includes('粘贴')) && !uiNames.menu.some(m => m.label === '视图'), flat.slice(0, 300))
      const plist = require('node:child_process').spawnSync('plutil', ['-p', path.join(path.dirname(facts.resources), 'Info.plist')], { encoding: 'utf8' }).stdout
      check('产品名', 'Info.plist 的 CFBundleName / CFBundleDisplayName（Dock 和「强制退出」列表里的名字）是产品名', /"CFBundleName" => "英语校考分析工作台"/.test(plist), plist.split('\n').filter(l => /CFBundle(Name|DisplayName)/.test(l)).join(' '))
    }
    const ocr = await api(() => window.api.ocr.status())
    check('OCR', `OCR 状态可读：${ocr.available ? '可用' : '不可用'} — ${ocr.detail}`, typeof ocr.available === 'boolean' && typeof ocr.detail === 'string', JSON.stringify(ocr))
    if (isMac) check('OCR', 'macOS：Vision 组件在打包版里可用', ocr.available === true, JSON.stringify(ocr))
    await shot('smoke-01-start')

    // ── 2. 图片导入（OCR；Windows 无中文语言包时要如实降级，不能假装通过）──
    const png = path.join(work, 'smoke-page.png')
    fs.copyFileSync(path.join(root, 'samples/g4-2025-page1.png'), png)
    await dropFiles(page, [png])
    const pPng = await waitFor(async () => { const p = (await api(() => window.api.papers.list())).find(x => x.file_name === 'smoke-page.png'); return p && ['extracted', 'failed'].includes(p.status) ? p : null }, 180000)
    const pagesPng = pPng ? await api(id => window.api.papers.pages(id), pPng.id) : []
    const pg = pagesPng[0]
    const lines = pg ? JSON.parse(pg.lines_json || '[]') : []
    if (isMac || ocr.available) {
      const ok = pg?.text_source === 'ocr' && lines.length > 30
      check('图片 OCR', `图片走本机 OCR：text_source=ocr，识别出 ${lines.length} 行（>30）`, ok || (isWin && pg?.text_source === 'ocr' && lines.length > 0), `${pg?.text_source} ${lines.length} 行 ${pPng?.warning ?? ''}`)
      if (isWin) check('图片 OCR', 'Windows：若 OCR 回退到非中文引擎，试卷上必须带「没有中文」之类的提示（不能悄悄给出一堆乱码）', !pg || pg.text_source !== 'ocr' || /中文|语言/.test(pPng?.warning ?? '') || /^zh/i.test(ocr.lang ?? '') || ocr.detail.includes('zh'), `${pPng?.warning ?? ''} / ${ocr.detail}`)
    } else {
      // 本机没有 OCR（Windows 缺语言包 / 组件）：页面必须标成 ocr_failed / needs_ocr，并给出原因
      check('图片 OCR', '没有可用 OCR 时如实降级：页面标 ocr_failed / needs_ocr，原因写进 ocr_error / 试卷警告，没有假装识别成功', !!pg && ['ocr_failed', 'needs_ocr'].includes(pg.text_source) && !!((pg.ocr_error ?? '') + (pPng?.warning ?? '')).trim(), `${pg?.text_source} ${pg?.ocr_error ?? ''} ${pPng?.warning ?? ''}`)
    }
    check('图片 OCR', '图片页面图落盘（files/<id>/page-1.png）并能通过 ewb:// 协议加载', !!pPng && fs.existsSync(path.join(userData, 'workbench-data', 'files', pPng.id, 'page-1.png')) && (await api(id => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = `ewb://page/${id}/page-1.png` }), pPng.id)) > 100)

    // ── 3. docx（mammoth / jszip 在 asar 里动态加载）──
    const docx = await makeDocx(path.join(work, 'smoke.docx'))
    await dropFiles(page, [docx])
    const pDocx = await waitFor(async () => { const p = (await api(() => window.api.papers.list())).find(x => x.file_name === 'smoke.docx'); return p && ['extracted', 'failed'].includes(p.status) ? p : null }, 120000)
    const dPages = pDocx ? await api(id => window.api.papers.pages(id), pDocx.id) : []
    const dAssets = pDocx ? await api(id => window.api.papers.assets(id), pDocx.id) : []
    check('docx', `docx 提取成功：中文文本、[图1] 占位、图片落盘（asar 里的 mammoth / jszip 能加载）`, pDocx?.status === 'extracted' && dPages[0]?.text_source === 'docx' && /四年级英语/.test(dPages[0]?.text ?? '') && /\[图1\]/.test(dPages[0]?.text ?? '') && dAssets.length === 1 && fs.existsSync(path.join(userData, 'workbench-data', 'files', pDocx.id, 'media', '1.png')), `${pDocx?.status} ${pDocx?.error ?? ''} ${dAssets.length}`)

    // ── 4. 配 mock AI，导入文本型 PDF，解析 ──
    const cfg = { provider: 'custom', base_url: mock.baseUrl, model: 'mock-text-model', vision_model: 'mock-vision-model', concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 8192 }
    await api(([c, k]) => window.api.ai.saveConfig(c, k), [cfg, 'sk-smoke-key'])
    const test = await api(() => window.api.ai.test({ kind: 'text' }))
    check('AI（mock）', '连接测试通过（打包版里的网络请求通往本机 mock，没有走真实 AI）', test.ok === true && mock.requests.length >= 1, JSON.stringify(test))
    const pdfs = ['g4-2025.pdf', 'g4-2026.pdf'].map(n => { const d = path.join(work, n); fs.copyFileSync(path.join(root, 'samples', n), d); return d })
    await dropFiles(page, pdfs)
    const done = await waitFor(async () => { const l = await api(() => window.api.papers.list()); const two = ['g4-2025.pdf', 'g4-2026.pdf'].map(n => l.find(x => x.file_name === n)); return two.every(p => p && ['reviewing', 'failed'].includes(p.status)) ? two : null }, 240000)
    check('PDF 提取 + AI 解析', '两份文本型 PDF 都走完提取 → AI 解析（mock），进入「待审核」', !!done && done.every(p => p.status === 'reviewing'), done ? done.map(p => `${p.file_name}:${p.status}${p.error ? ' ' + p.error : ''}`).join(' ') : '超时')
    const pdfPages = done ? await api(id => window.api.papers.pages(id), done[0].id) : []
    check('PDF 提取', '文本型 PDF 走文字层（text_source=pdf-text，没有触发 OCR），坐标是真实的', pdfPages.length >= 1 && pdfPages.every(p => p.text_source === 'pdf-text') && new Set(JSON.parse(pdfPages[0].lines_json).map(l => Math.round(l.x * 1000))).size > 3)
    let questions = 0
    for (const p of done ?? []) {
      const qs = await api(id => window.api.questions.list(id), p.id)
      questions += (qs.questions ?? qs).length
      await api(id => window.api.questions.confirmPaper(id, true), p.id)
    }
    check('审核', `两份卷子共 ${questions} 道题（>30），确认后进入「已完成」`, questions > 30 && (await api(() => window.api.papers.list())).filter(p => p.status === 'done').length === 2)

    // ── 5. 看板有数据 ──
    await page.evaluate(() => { location.hash = '#/overview' })
    const card = await waitFor(async () => (await T('card-papers').count()) > 0 && (await page.locator('[data-testid="card-papers"]').first().innerText()).trim() === '2', 20000)
    const ov = await api(() => window.api.stats.overview({}))
    const dist = await api(() => window.api.stats.distribution({}))
    check('看板', '总览「试卷」卡片 = 2，题数与数据库一致，知识点分布有数据', !!card && ov.cards.papers === 2 && ov.cards.questions === questions && dist.nodes.length > 5, `${JSON.stringify(ov.cards)} nodes=${dist.nodes.length}`)
    await shot('smoke-02-overview')
    await page.evaluate(() => { location.hash = '#/dashboard' })
    await sleep(1500)
    await shot('smoke-03-dashboard')

    // ── 6. 报告：生成 + 导出 Markdown / PDF ──
    const gen = await api(() => window.api.report.generate({}, crypto.randomUUID()))
    check('报告', '用 mock 生成报告成功并进入历史', gen.ok === true && (await api(() => window.api.report.list())).length === 1, JSON.stringify(gen).slice(0, 200))
    const rep = (await api(() => window.api.report.list()))[0]
    await page.evaluate(() => { location.hash = '#/report' })
    await sleep(1500)
    await shot('smoke-04-report')
    const mdFile = path.join(work, 'report', '报告.md')
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, mdFile)
    const em = await api(id => window.api.report.export(id, 'md'), rep.id)
    check('报告 导出', 'Markdown 导出成功，文件存在且含中文标题', em.saved === true && fs.existsSync(mdFile) && CJK.test(fs.readFileSync(mdFile, 'utf8')), JSON.stringify(em).slice(0, 200))
    const pdfFile = path.join(work, 'report', '报告.pdf')
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, pdfFile)
    const ep = await api(id => window.api.report.export(id, 'pdf'), rep.id)
    const head = fs.existsSync(pdfFile) ? fs.readFileSync(pdfFile).subarray(0, 5).toString('latin1') : ''
    check('报告 导出', 'PDF 导出成功：%PDF 头，体积合理（>5 KB）', ep.saved === true && head === '%PDF-' && fs.statSync(pdfFile).size > 5000, `${JSON.stringify(ep).slice(0, 160)} ${head}`)
    const info = await pdfInfo(pdfFile)
    fs.copyFileSync(pdfFile, path.join(outDir, `${prefix}smoke-report.pdf`))
    check('报告 导出', `PDF 里有中文文字（共 ${info.pages} 页）`, info.pages >= 1 && CJK.test(info.text), info.text.slice(0, 80).replace(/\s+/g, ' '))
    check('报告 导出', `PDF 嵌入了能画中文的字体：${info.fonts.join(', ') || '（读不到字体名）'}`, info.fonts.length === 0 ? !isWin : info.fonts.some(f => CJK_FONT.test(f)), info.fonts.join(', '))

    // ── 7. 导出数据包 ──
    const packFile = path.join(work, 'pack', '冒烟数据包.ewb.zip')
    fs.mkdirSync(path.dirname(packFile), { recursive: true })
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, packFile)
    const ex = await api(() => window.api.data.exportPack())
    const zip = ex.saved ? await JSZip.loadAsync(fs.readFileSync(ex.path)) : null
    const man = zip ? JSON.parse(await zip.file('manifest.json').async('string')) : {}
    const names = zip ? Object.keys(zip.files) : []
    check('数据包导出', '导出成功：manifest 写明应用版本和 4 份卷子，zip 里有 db.sqlite 和 files/<uuid>/…，没有 API 密钥', ex.saved === true && man.format === 'ewb-pack' && man.appVersion === pkg.version && man.paperCount === 4 && names.includes('db.sqlite') && names.some(n => /^files\/[0-9a-f-]{36}\/original\.pdf$/.test(n)) && !fs.readFileSync(ex.path).includes(Buffer.from('sk-smoke-key')), JSON.stringify(man).slice(0, 220))
    await page.evaluate(() => { location.hash = '#/settings' })
    await sleep(1500)
    await shot('smoke-05-settings')
    // 安装指南页：正文在打包后的 renderer bundle 里（构建时内联了 docs/安装指南.md）
    await page.evaluate(() => { location.hash = '#/guide' })
    const guideOk = await waitFor(async () => (await T('guide-body').count()) > 0, 60000)   // x64 包在 Apple 芯片上靠 Rosetta 转译跑时页面切换会慢到几秒
    const guideText = guideOk ? await T('guide-body').innerText() : ''
    const guideSrc = fs.readFileSync(path.join(root, 'docs/安装指南.md'), 'utf8')
    const heads = [...guideSrc.matchAll(/^## (.+)$/gm)].map(m => m[1])
    check('安装指南', '打包版里的 /guide 页显示完整正文（docs/安装指南.md 的每个二级标题都在）', guideOk && heads.length >= 9 && heads.every(h => guideText.includes(h)) && /仍要运行/.test(guideText), `${heads.length} 个标题；正文 ${guideText.length} 字；缺少：${heads.filter(h => !guideText.includes(h)).join(' / ') || '无'}`)
    await shot('smoke-06-guide')

    // ── 8. 运行期健康 ──
    const bad = consoleErrors.filter(e => !/Autofill|DevTools/i.test(e))
    check('运行期', '渲染进程没有控制台错误（含 CSP 违规）', bad.length === 0, bad.slice(0, 3).join(' | '))
    // 真检查：应用里保存的 AI 服务地址（从应用读回来）是回环地址，且这个本机 mock 确实收到了请求。
    // 它证明「测试用的是 mock、请求到了 mock」；证明不了「没有请求发去别处」（那种请求本来就不会出现在 mock 里），所以名字不写成那样
    const savedCfg = await api(() => window.api.ai.getConfig())
    const host = (() => { try { return new URL(savedCfg.cfg?.base_url ?? savedCfg.base_url).hostname } catch { return '' } })()
    check('运行期', `应用里配置的 AI 服务地址是本机回环地址（${host}），并且本机 mock 收到了 ${mock.requests.length} 个请求（含 P1 解析和 P3 报告）`, ['127.0.0.1', 'localhost', '[::1]'].includes(host) && mock.requests.length >= 3 && mock.p1Requests.length >= 2 && mock.p3Requests.length >= 1, JSON.stringify({ host, total: mock.requests.length, p1: mock.p1Requests.length, p3: mock.p3Requests.length }))
  } catch (e) {
    console.error('冒烟异常：', e)
    check('冒烟', '脚本没有异常退出', false, e && e.message)
    try { await page.screenshot({ path: path.join(outDir, `${prefix}smoke-FAILURE.png`) }) } catch { /* 窗口可能已不在 */ }
  } finally {
    try { await app.close() } catch { /* 已关闭 */ }
    try { await mock.stop() } catch { /* 已关闭 */ }
  }
}

async function dropFiles(page, paths) {
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  // 新外壳里页面在白色画布里滚动：拖拽事件必须落在可见位置（与 lib.cjs 一致）
  await page.locator('[data-testid=dropzone]').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  const box = await page.locator('[data-testid=dropzone]').boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data })
  await cdp.detach()
}

main().then(() => {
  const failed = results.filter(r => !r.pass)
  const file = path.join(outDir, `${prefix}smoke-result-${process.platform}.json`)
  fs.writeFileSync(file, JSON.stringify({ platform: process.platform, arch: process.arch, version: pkg.version, results }, null, 2))
  console.log(`\n==== 打包版冒烟：${results.length - failed.length}/${results.length} 通过（${process.platform}-${process.arch}）====`)
  process.exit(failed.length ? 1 : 0)
}, e => { console.error(e); process.exit(1) })
