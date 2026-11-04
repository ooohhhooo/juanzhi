// M9 beta.1 A 部分端到端：识别质量（只有识别不好的页才读图）、视觉模型自己的服务地址与密钥、拆题模型与写报告模型分开、
// 「出自原卷」不再拿整页冒充（去框一下）、没找到位置的题、Word 也有原卷图并能定位。全程 mock AI。
//   · 夹具：PNG 截图、手机拍的 JPG（EXIF 旋转）、现场生成的 Word；解析后 ≥ 90% 的题有框，框是题目区域而不是整页
//   · 测试连接：拆题 / 写报告 / 视觉分别测；403 →「这个密钥没有权限使用这个模型」+ 怎么办；视觉模型自己的服务地址和密钥
//   · 识别方式：注入「Windows 英文引擎 + 固定 0.8 置信度」的识别结果 → 识别不好的页读图（auto）/ 一律读图 / 从不读图 / 没有视觉模型 / 读图 403 改用本机文字
//   · 总览「出自原卷」：没有框时写明「这道题还没在原卷上框出位置」+「去框一下」，跳到审核页那道题，画框后立即生效
// 用法：npm run test:e2e:m9a   （沙箱外运行：Electron、本地端口都被沙箱限制；全程用 mock AI，不调用真实服务）
const M = require('./m4-lib.cjs')
const { makeExamDocx } = require('./make-docx.cjs')
const { DatabaseSync } = require('node:sqlite')
const { check, sleep, waitFor, withDb, fs, path, os, work, SECRET, root, ctx, T, txt, goto, api, cfgFor, startMock, open, shots, L, execFileSync } = M
/** 保存 AI 配置：key / vkey 省略 = 不改，null = 清除（vkey 是视觉模型自己的密钥） */
const saveCfg = (cfg, key, vkey) => ctx.page.evaluate(([c, k, v]) => (v === undefined ? (k === undefined ? window.api.ai.saveConfig(c) : window.api.ai.saveConfig(c, k)) : window.api.ai.saveConfig(c, k, v)), [cfg, key, vkey])
const PARSE_M = 'mock-reasoning-parse'   // 名字里有 reason：按推理模型处理（输出上限 32768，天花板 65536，写不完时可以加长重试）

const VKEY = 'sk-e2e-M9A-VISION-20261102'
const writeDb = (fn) => { const d = new DatabaseSync(path.join(ctx.ud, 'workbench-data', 'db.sqlite')); d.exec('PRAGMA busy_timeout=5000'); d.exec('PRAGMA foreign_keys=ON'); try { return fn(d) } finally { d.close() } }
const paperRow = name => withDb(ctx.ud, d => d.prepare('SELECT * FROM papers WHERE file_name = ?').get(name))
const qsOf = id => withDb(ctx.ud, d => d.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY ord').all(id))
const pagesOf = id => withDb(ctx.ud, d => d.prepare('SELECT * FROM pages WHERE paper_id = ? ORDER BY idx').all(id))
const hasBox = q => { try { const b = JSON.parse(q.bbox_json); return Array.isArray(b) && b[2] > 0 && b[3] > 0 } catch { return false } }
const located = id => { const qs = qsOf(id); return { n: qs.length, withBox: qs.filter(hasBox).length, qs } }
const shot9 = async (name, testid) => {
  // 先把要看的那块滚到屏幕中间再截图（整页很长，默认截到的是页面最上面）
  if (testid) { const el = T(testid).first(); await el.scrollIntoViewIfNeeded().catch(() => {}); await el.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {}); await sleep(300) }
  return ctx.page.screenshot({ path: path.join(shots, `m9a-${name}.png`) })
}
const setTheme = async mode => { await goto('#/'); await ctx.page.evaluate(m => localStorage.setItem('ewb-theme-pref', m), mode); await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }) }
const waitParsed = async (name, ms = 120000) => (await L.waitStatus(ctx.page, name, ['reviewing', 'failed'], ms))
const waitExtracted = async (name, ms = 90000) => (await L.waitStatus(ctx.page, name, ['extracted', 'failed', 'reviewing'], ms))
const parseAi = id => api(i => window.api.parse.start(i, 'ai'), id)
const clean = s => String(s).replace(/\s+/g, ' ').trim()

async function main() {
  ctx.mock = await startMock({ apiKey: SECRET })
  const mock2 = await startMock({ apiKey: VKEY })
  const mock = ctx.mock
  const ud = path.join(work, 'userM9A')
  await open(ud)
  const page = () => ctx.page

  // ───────────────────────── 夹具 ─────────────────────────
  const fx = path.join(work, 'fx')
  fs.mkdirSync(fx, { recursive: true })
  const srcPng = path.join(root, 'samples/g4-2025-page1.png')
  // 手机竖拍照片（EXIF 旋转）：沿用 make-fixtures.py 的做法
  const mk = path.join(fx, 'mk')
  execFileSync('/usr/bin/python3', [path.join(__dirname, 'make-fixtures.py'), mk, srcPng], { stdio: 'pipe' })
  const FILES = {
    png: 'g4-2025-page1-m9a.png',        // 文件名以 g4-2025-page1 开头：mock 据此给出这一页的标准答案
    jpg: 'g4-2025-page1-phone.jpg',
    docx: 'm9a-word.docx'
  }
  fs.copyFileSync(srcPng, path.join(fx, FILES.png))
  fs.copyFileSync(path.join(mk, 'phone-exif6.jpg'), path.join(fx, FILES.jpg))
  await makeExamDocx(path.join(fx, FILES.docx))
  const tagged = (name, tag) => L.copyWithTag(path.join(fx, FILES.png), path.join(fx, name), tag)

  // ───────────────────────── 1. 设置页：模型拆分 / 测试连接 / 403 / 视觉模型自己的服务 ─────────────────────────
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await page().reload()   // 界面里缓存着启动时读到的默认配置：刷新后设置页才是刚保存的这份
  await T('dropzone').waitFor({ timeout: 30000 })
  await goto('#/settings?admin=1&tab=ai')
  await T('ai-settings').waitFor()
  const maxAttr = await T('ai-concurrency').getAttribute('aria-valuemax')
  check('设置', '「同时解析的试卷数」上限提到 16', maxAttr === '16', `aria-valuemax=${maxAttr}`)
  const saved16 = await api(c => window.api.ai.saveConfig({ ...c, concurrency: 16 }), await api(() => window.api.ai.getConfig()).then(({ hasKey, hasVisionKey, keyStorage, ...c }) => c)).then(v => v.concurrency, e => String(e))
  check('设置', '保存 16 能通过校验；17 被拒绝（主进程 zod）', saved16 === 16 && (await api(async () => { try { const { hasKey, hasVisionKey, keyStorage, ...c } = await window.api.ai.getConfig(); await window.api.ai.saveConfig({ ...c, concurrency: 17 }); return 'saved' } catch (e) { return 'rejected' } })) === 'rejected', String(saved16))
  check('设置', '拆题用的模型和写报告用的模型是两个输入框，旧配置里拆题模型是空的（默认等于写报告的那一个）',
    (await T('ai-parse-model').count()) === 1 && (await T('ai-model').count()) === 1 && (await page().locator('[data-testid=ai-parse-model] input').inputValue()) === '', '')
  const hintText = await txt('parse-model-hint')
  check('设置', '拆题模型旁边写明推荐用快速、不带深度思考的模型', /快速/.test(hintText) && /不带深度思考/.test(hintText), hintText)
  // 预设：通义 / Kimi 带推荐拆题模型（模型档案里已标明不是推理型的）；其余不猜
  const presets = await api(() => window.api.ai.presets())
  check('设置', '预设里只给「查得到是快速模型」的服务商填了推荐拆题模型（通义、Kimi），其余留空不猜', presets.filter(p => p.parseModel).map(p => p.id).sort().join() === 'kimi,qwen', presets.map(p => `${p.id}:${p.parseModel ?? ''}`).join(' '))

  // 填一套：拆题 = mock-parse-model，写报告 = mock-text-model，视觉 = 会被 403 的模型
  await page().locator('[data-testid=ai-parse-model] input').fill('mock-parse-model')
  await page().locator('[data-testid=ai-model] input').fill('mock-text-model')
  await page().locator('[data-testid=ai-vision-model] input').fill('mock-vision-403')
  await page().locator('[data-testid=ai-key]').fill(SECRET)
  mock.forbidModels = ['mock-vision-403']
  mock.resetStats()
  await T('ai-test').click()
  await T('ai-test-result').waitFor()
  await waitFor(async () => (await page().locator('[data-testid^=ai-test-row-]').count()) === 3, 15000)
  const rows = {}
  for (const k of ['parse', 'report', 'vision']) rows[k] = { status: await T(`ai-test-row-${k}`).getAttribute('data-status'), text: clean(await T(`ai-test-row-${k}`).innerText()) }
  check('测试连接', '「测试全部」分别测三项：拆题模型成功、写报告模型成功、视觉模型 403 失败', rows.parse.status === 'ok' && rows.report.status === 'ok' && rows.vision.status === 'fail', JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.status]))) + ' 请求 ' + mock.requests.map(r => `${r.model}:${r.auth.slice(-6)}`).join())
  check('测试连接', '403 的话是「这个密钥没有权限使用这个模型」，写明模型名，不再和「密钥无效」混成一句', /这个密钥没有权限使用这个模型（mock-vision-403）/.test(rows.vision.text) && !/API Key 无效/.test(rows.vision.text), rows.vision.text.slice(0, 160))
  const steps = await page().locator('[data-testid=ai-test-steps] li').count()
  check('测试连接', '403 下面有「怎么办」的几步（开通模型 / 换模型 / 用另一家 / 看详情）和服务商原话', steps >= 3 && /开通/.test(rows.vision.text) && /服务商返回的原话/.test(rows.vision.text), `steps=${steps}`)
  const models = mock.requests.map(r => r.model)
  check('测试连接', '三项各用各的模型发请求（拆题 mock-parse-model、写报告 mock-text-model、视觉 mock-vision-403），没有重复测同一个', models.join() === 'mock-parse-model,mock-text-model,mock-vision-403', models.join())
  check('测试连接', '视觉测试发出带图的请求，图是 64×64 的点阵字图（不是纯色块）', mock.requests.at(-1).images === 1 && mock.requests.at(-1).imageDims[0].w === 64 && mock.requests.at(-1).imageDims[0].h === 64)
  await sleep(300)
  await shot9('settings-test-403-light', 'ai-test-result')
  // 拆题模型和写报告模型相同 → 不重复测
  await page().locator('[data-testid=ai-parse-model] input').fill('')
  mock.resetStats()
  await T('ai-test').click()
  await waitFor(async () => (await T('ai-test-row-report').count()) === 1 && (await T('ai-test-row-report').getAttribute('data-status')) === 'skip', 15000)
  check('测试连接', '拆题模型留空（= 和写报告的相同）时只测一次，写报告那行写「与拆题用的模型相同，不重复测」', /不重复测/.test(await txt('ai-test-row-report')) && mock.requests.filter(r => r.images === 0).length === 1, mock.requests.map(r => r.model).join())
  // 视觉模型会看图 / 不会看图
  await page().locator('[data-testid=ai-vision-model] input').fill('mock-vision-model')
  mock.forbidModels = []
  await T('ai-test-vision').click()
  await waitFor(async () => (await T('ai-test-row-vision').count()) === 1 && (await T('ai-test-row-vision').getAttribute('data-status')) === 'ok', 15000)
  check('测试连接', '视觉模型读对了测试图上的字（7K）→ 「能看图」', /能看图/.test(await txt('ai-test-row-vision')))
  mock.visionBlind = true
  await T('ai-test-vision').click()
  await waitFor(async () => (await T('ai-test-row-vision').getAttribute('data-status')) === 'warn', 15000)
  check('测试连接', '能连通但读不对测试图 → 黄色提示「可能不会看图，请换一个带视觉能力的模型」', /可能不会看图/.test(await txt('ai-test-row-vision')))
  mock.visionBlind = false

  // 视觉模型自己的服务地址和密钥
  await page().locator('.ant-collapse-header', { hasText: '视觉模型用不同的服务商' }).click()
  await T('ai-vision-base-url').fill(mock2.baseUrl)
  mock.resetStats(); mock2.resetStats()
  await T('ai-test').click()
  await waitFor(async () => (await T('ai-test-row-vision').count()) === 1 && /自己的 API Key/.test(await txt('ai-test-row-vision')), 15000)
  check('视觉模型自己的服务', '换了视觉模型的服务地址但没填它自己的密钥：不会把文本模型的密钥发过去，提示先填它自己的 API Key', /请先填写它自己的 API Key/.test(await txt('ai-test-row-vision')) && mock2.requests.length === 0, await txt('ai-test-row-vision'))
  await T('ai-vision-key').fill(VKEY)
  await T('ai-test').click()
  await waitFor(async () => mock2.requests.length >= 1, 15000)
  await waitFor(async () => (await T('ai-test-row-vision').getAttribute('data-status')) === 'ok', 15000)
  check('视觉模型自己的服务', '视觉测试发到了它自己的服务地址，带的是它自己的密钥；文本测试仍发给原来的服务', mock2.requests.length === 1 && mock2.requests[0].auth === `Bearer ${VKEY}` && mock2.requests[0].images === 1 && mock.requests.every(r => r.auth === `Bearer ${SECRET}` && r.images === 0), `${mock2.requests.map(r => r.auth).join()} | ${mock.requests.map(r => r.auth).join()}`)
  await T('ai-save').click()
  await page().waitForSelector('.ant-message-notice')
  const view = await api(() => window.api.ai.getConfig())
  const viewStr = JSON.stringify(view)
  check('密钥安全', '保存后 hasVisionKey = true，配置视图里没有任何密钥；视觉模型的密钥只存在加密槽 ai_key_vision_enc 里，通用设置接口读不到',
    view.hasVisionKey === true && !viewStr.includes(VKEY) && !viewStr.includes(SECRET) && view.vision_base_url === mock2.baseUrl &&
    (await api(() => window.api.settings.get('ai_key_vision_enc').then(() => 'resolved', () => 'rejected'))) === 'rejected', viewStr.slice(0, 120))
  const encRow = withDb(ud, d => d.prepare("SELECT value_json FROM settings WHERE key = 'ai_key_vision_enc'").get())
  check('密钥安全', '库里存的是密文（不含明文），且数据包 / 日志里不会出现', !!encRow && !encRow.value_json.includes(VKEY), '')
  // 视觉密钥与服务地址配套：只改地址不重新输入密钥 → 拒绝保存（和文本模型的密钥一样的守卫）
  const guard = await api(async ({ u }) => { try { const { hasKey, hasVisionKey, keyStorage, ...c } = await window.api.ai.getConfig(); await window.api.ai.saveConfig({ ...c, vision_base_url: u }); return 'saved' } catch (e) { return String(e.message) } }, { u: 'http://127.0.0.1:9/v1' })
  check('密钥安全', '改视觉模型的服务地址而不重新输入它的密钥 → 拒绝保存（已存的密钥不会被发往新地址）', /重新输入它的 API Key/.test(guard), guard.slice(0, 120))
  const outputs = L.procOutput.join('')
  check('密钥安全', '主进程输出里没有任何密钥', !outputs.includes(VKEY) && !outputs.includes(SECRET))

  // ───────────────────────── 2. 三种夹具：解析后 ≥ 90% 的题有框，框是题目区域 ─────────────────────────
  // 不配视觉模型：走「本机识别的文字 + 行位置」这条路，真实 OCR 的定位成功率才有意义（读图的路径在第 5 节单独测）
  await saveCfg(cfgFor(mock, { auto_parse: true, parse_model: '', vision_model: '', vision_base_url: '' }), SECRET, null)
  mock.reset()
  await L.dropFiles(page(), [path.join(fx, FILES.png), path.join(fx, FILES.jpg), path.join(fx, FILES.docx)])
  const parsed = {}
  for (const [k, name] of Object.entries(FILES)) parsed[k] = await waitParsed(name, 150000)
  check('三种夹具', 'PNG 截图、手机照片（JPG）、Word 都解析成功（待审核）', Object.values(parsed).every(p => p && p.status === 'reviewing'), Object.entries(parsed).map(([k, p]) => `${k}:${p?.status}${p?.error ? ' ' + p.error : ''}`).join(' '))
  const loc = {}
  for (const [k, p] of Object.entries(parsed)) {
    loc[k] = located(p.id)
    const areas = loc[k].qs.filter(hasBox).map(q => { const b = JSON.parse(q.bbox_json); return b[2] * b[3] })
    check('三种夹具', `${k}：${loc[k].n} 道题里 ${loc[k].withBox} 道有框（≥ 90%），框都是题目区域（面积 < 页面的一半），不是整页`, loc[k].n >= 10 && loc[k].withBox / loc[k].n >= 0.9 && areas.every(a => a < 0.5), `${loc[k].withBox}/${loc[k].n} 最大面积 ${Math.max(...areas).toFixed(3)}`)
  }
  for (const k of ['png', 'jpg']) {
    const pg = pagesOf(parsed[k].id)[0]
    check('三种夹具', `${k}：用的是本机识别的文字定位（text-anchor，真实 OCR 的行位置），识别方式记为 Mac 自带识别；置信度偏低不算「识别可能不完整」`, loc[k].qs.filter(hasBox).every(q => q.bbox_source === 'text-anchor') && pg.recognizer === 'mac-vision' && pg.rec_reason === 'ocr-ok' && !(await api(i => window.api.papers.diag(i), parsed[k].id)).incomplete, `${pg.recognizer}/${pg.rec_reason} conf=${pg.ocr_conf?.toFixed(2)}`)
  }
  // Word：有页面图、有带坐标的行、识别方式是「直接读取文字」
  const wp = pagesOf(parsed.docx.id)
  const wlines = JSON.parse(wp[0].lines_json)
  check('Word 页面图', 'Word 试卷有页面图（A4 宽的 PNG，文件真实存在），行带坐标（lines_json），识别方式 = Word 直接读取文字',
    wp.length >= 1 && !!wp[0].image_rel && wp[0].width >= 1500 && fs.existsSync(path.join(ud, 'workbench-data', 'files', parsed.docx.id, wp[0].image_rel)) && wlines.length >= 20 && wlines.every(l => l.w > 0 && l.h > 0) && wp[0].recognizer === 'docx-text' && wp[0].rec_reason === 'docx-text',
    `${wp.length} 页 ${wp[0].width}×${wp[0].height} 行 ${wlines.length}`)
  const wtext = wlines.map(l => l.text).join('\n')
  check('Word 页面图', 'Word 的自动编号补回了题号（「1. What is your name?」类），填空横线保留成下划线（「7. I ________」）', /^1\. What's your name\?/m.test(wtext) && /^6\. What time is it\?/m.test(wtext) && /^7\. I$/m.test(wtext) && /^_{4,}$/m.test(wtext), wtext.split('\n').slice(2, 6).join(' | '))
  // 解析用的是带位置的行（以前 Word 没有坐标，bbox 恒为空）
  check('Word 页面图', 'Word 的题 bbox_source = text-anchor（和 PDF / 图片同一套定位）', loc.docx.qs.filter(hasBox).every(q => q.bbox_source === 'text-anchor'), [...new Set(loc.docx.qs.map(q => q.bbox_source))].join())
  await shot9('word-page-image')
  // 页面图预览（试卷详情里能看到 Word 页）
  await goto(`#/paper/${parsed.docx.id}`)
  await page().waitForSelector('.ewb-lib-pageimg img', { timeout: 15000 })
  const rec = clean(await txt('recognition-card'))
  check('识别方式', '试卷详情里 Word 一行写「Word 文件：直接读取文字，不经过识别」', /Word 文件：直接读取文字，不经过识别/.test(rec), rec.slice(0, 120))
  await shot9('word-detail-light')

  // ───────────────────────── 3. 总览「出自原卷」：区域截图；没有框时不拿整页冒充 ─────────────────────────
  for (const k of ['png', 'jpg', 'docx']) await api(i => window.api.questions.confirmPaper(i, true), parsed[k].id)
  const setScope = async f => { await api(v => window.api.settings.set('ui_stats_filter', v), f); await page().reload(); await goto('#/overview'); await T('overview').waitFor({ timeout: 30000 }) }
  await setScope({ paperIds: [parsed.docx.id] })
  await waitFor(async () => (await page().locator('[data-testid=ov-crop]').count()) >= 3, 20000)
  const crops = await page().locator('[data-testid=ov-crop]').evaluateAll(els => els.map(e => ({ mode: e.dataset.mode, bbox: e.dataset.bbox ? JSON.parse(e.dataset.bbox) : null })))
  check('出自原卷', '总览每个知识点的「出自原卷」都是按框裁出的题目区域（框面积 < 页面的一半），没有整页', crops.length >= 3 && crops.every(c => c.mode === 'crop' && c.bbox && c.bbox[2] * c.bbox[3] < 0.5), `${crops.length} 个：${[...new Set(crops.map(c => c.mode))].join()}`)
  const pngCrops = await (async () => { await setScope({ paperIds: [parsed.png.id] }); await waitFor(async () => (await page().locator('[data-testid=ov-crop]').count()) >= 3, 20000); return page().locator('[data-testid=ov-crop]').evaluateAll(els => els.map(e => ({ mode: e.dataset.mode, bbox: e.dataset.bbox ? JSON.parse(e.dataset.bbox) : null }))) })()
  check('出自原卷', 'PNG 截图的试卷同样是区域截图', pngCrops.filter(c => c.mode === 'crop').length / pngCrops.length >= 0.9 && pngCrops.filter(c => c.bbox).every(c => c.bbox[2] * c.bbox[3] < 0.5), `${pngCrops.length} 个`)
  await shot9('overview-crop-light', 'ov-crop')

  // 把 Word 试卷所有题的框清掉 → 总览显示「还没框出位置」，不是整页
  const docxQs = loc.docx.qs
  for (const q of docxQs) await api(i => window.api.questions.update(i, { bbox: null }), q.id)
  await api(i => window.api.questions.confirmPaper(i, true), parsed.docx.id)   // 改了已确认的卷子会变回待审核：重新确认，才计入统计
  await setScope({ paperIds: [parsed.docx.id] })
  await waitFor(async () => (await page().locator('[data-testid=ov-crop]').count()) >= 3, 20000)
  const nob = await page().locator('[data-testid=ov-crop]').evaluateAll(els => els.map(e => ({ mode: e.dataset.mode, text: e.innerText, imgs: e.querySelectorAll('img').length, btn: e.querySelectorAll('[data-testid=goto-box]').length })))
  check('出自原卷', '没有框的题：不显示整页，写明「这道题还没在原卷上框出位置」，并有「去框一下」按钮', nob.length >= 3 && nob.every(c => c.mode === 'nobox' && /这道题还没在原卷上框出位置/.test(c.text) && c.imgs === 0 && c.btn === 1), JSON.stringify(nob[0]))
  await shot9('overview-nobox-light', 'ov-crop')
  await setTheme('dark')
  await goto('#/overview'); await T('overview').waitFor()
  await waitFor(async () => (await page().locator('[data-testid=ov-crop]').count()) >= 3, 20000)
  await shot9('overview-nobox-dark', 'ov-crop')
  await setTheme('light')
  await goto('#/overview'); await T('overview').waitFor()
  await waitFor(async () => (await page().locator('[data-testid=goto-box]').count()) >= 3, 20000)

  // 「去框一下」→ 审核页，选中的就是这道题；画框后立即生效
  const firstBtn = page().locator('[data-testid=goto-box]').first()
  await firstBtn.click()
  await waitFor(async () => /#\/review\/[0-9a-f-]{36}\?q=[0-9a-f-]{36}/.test(await page().evaluate(() => location.hash)), 10000)
  const hash = await page().evaluate(() => location.hash)
  const qid = /q=([0-9a-f-]{36})/.exec(hash)[1]
  check('去框一下', '点「去框一下」跳到审核页，地址里带着这道题的 id，属于这份试卷', hash.includes(`/review/${parsed.docx.id}?q=`) && docxQs.some(q => q.id === qid), hash)
  await T('draw-box').waitFor({ timeout: 15000 })
  const selected = await page().evaluate(id => !!document.querySelector(`[data-qid="${id}"]`), qid)
  const curNo = docxQs.find(q => q.id === qid).no_label
  check('去框一下', '审核页选中的就是这道题（页面图上有「这道题没有定位框」+「在此页画一个框」）', selected && /这道题没有定位框/.test(await page().locator('.ewb-rev-cloth__act').first().innerText()), `第 ${curNo} 题`)
  await shot9('review-from-origin-light')
  await T('draw-box').click()
  await waitFor(async () => { const q = qsOf(parsed.docx.id).find(x => x.id === qid); return q && hasBox(q) && q.bbox_source === 'manual' }, 15000)
  check('去框一下', '画框后立即写库（bbox_source = manual）', hasBox(qsOf(parsed.docx.id).find(x => x.id === qid)), '')
  await api(i => window.api.questions.confirmPaper(i, true), parsed.docx.id)
  await goto('#/overview'); await T('overview').waitFor()
  await waitFor(async () => (await page().locator('[data-testid=ov-crop][data-mode=crop]').count()) >= 1, 20000)
  check('去框一下', '回到总览，这个知识点的「出自原卷」变成了截图，其余还没框的仍写「去框一下」', (await page().locator('[data-testid=ov-crop][data-mode=crop]').count()) >= 1 && (await page().locator('[data-testid=ov-crop][data-mode=nobox]').count()) >= 1)
  await api(v => window.api.settings.set('ui_stats_filter', v), {})

  // ───────────────────────── 4. 解析完成后：「N 道题没找到位置」+ 一键跳去框 ─────────────────────────
  {
    const pj = parsed.jpg
    const qs = qsOf(pj.id)
    for (const q of qs.slice(0, 3)) await api(i => window.api.questions.update(i, { bbox: null }), q.id)
    await waitFor(async () => qsOf(pj.id).slice(0, 3).every(q => !hasBox(q)), 10000)
    const missing = qsOf(pj.id).filter(q => !hasBox(q))
    await goto(`#/paper/${pj.id}`)
    await T('missing-box-notice').waitFor({ timeout: 15000 })
    const t = clean(await txt('missing-box-notice'))
    check('没找到位置', `试卷详情写「${missing.length} 道题没找到位置」，列出题号，并有「去框一下」`, new RegExp(`${missing.length} 道题没找到位置`).test(t) && /去框一下/.test(t) && missing.slice(0, 3).every(q => t.includes(q.no_label)), t.slice(0, 160))
    await shot9('missing-box-light')
    await setTheme('dark'); await goto(`#/paper/${pj.id}`); await T('missing-box-notice').waitFor()
    await shot9('missing-box-dark')
    await setTheme('light'); await goto(`#/paper/${pj.id}`); await T('missing-box-notice').waitFor()
    await T('goto-first-missing').click()
    await waitFor(async () => (await page().evaluate(() => location.hash)).startsWith(`#/review/${pj.id}?q=`), 10000)
    check('没找到位置', '点「去框一下」跳到审核页的第一道没框的题', (await page().evaluate(() => location.hash)).includes(missing[0].id), await page().evaluate(() => location.hash))
    // 手动框完后提示消失
    for (const q of missing) await api(([i, b]) => window.api.questions.update(i, { bbox: b }), [q.id, [0.1, 0.1, 0.5, 0.03]])
    await goto(`#/paper/${pj.id}`)
    check('没找到位置', '都框好之后这条提示不再出现', await waitFor(async () => (await T('missing-box-notice').count()) === 0, 8000))
  }

  // ───────────────────────── 5. 识别方式：Windows 英文引擎 + 固定 0.8 → 识别不好的页读图 ─────────────────────────
  await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_policy: 'auto' }), SECRET, null)
  /** 导入一份 PNG 副本，提取完成后把页面记录改成「Windows 英文引擎、置信度固定 0.8」（注入的假 OCR 结果），再解析 */
  const seedWin = async (name, tag, o = {}) => {
    mock.resetStats()
    tagged(name, tag)
    await L.dropFiles(page(), [path.join(fx, name)])
    const p = await waitExtracted(name)
    writeDb(d => { d.prepare("UPDATE pages SET ocr_lang = ?, ocr_conf = 0.8, recognizer = ?, quality_json = NULL, rec_reason = NULL WHERE paper_id = ?").run(o.lang ?? 'en-US', 'win-ocr', p.id); garbleCjk(d, p.id) })
    return p
  }
  /** 英文引擎读中文页的真实样子：中文变成乱码字符（只有文件名带中文是不够的，见 ocr-quality） */
const garbleCjk = (d, paperId) => {
  const pg = d.prepare('SELECT id, lines_json, text FROM pages WHERE paper_id = ?').get(paperId)
  const g = t => String(t ?? '').replace(/[\u4e00-\u9fff]/g, '\ufffd')
  d.prepare('UPDATE pages SET lines_json = ?, text = ? WHERE id = ?').run(g(pg.lines_json), g(pg.text), pg.id)
}
const nameA = 'g4-2025-page1-期末A.png'
  {
    // A：视觉模型用自己的服务（mock2）。Windows 英文引擎读中文卷 → 这页改用 AI 读图，请求发到视觉模型自己的服务地址
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_base_url: mock2.baseUrl }), SECRET, VKEY)
    mock2.resetStats()
    const pA = await seedWin(nameA, 'A')
    await parseAi(pA.id)
    const doneA = await waitParsed(nameA)
    const pgA = pagesOf(pA.id)[0]
    const reqA = mock2.p1Requests
    check('识别质量', 'Windows 英文引擎 + 固定 0.8 置信度 + 中文卷（auto）：这页改用 AI 读图（以前永远不会）', doneA.status === 'reviewing' && pgA.recognizer === 'vision-model' && pgA.rec_reason === 'lang-mismatch', `${doneA.status} ${pgA.recognizer}/${pgA.rec_reason}`)
    check('识别质量', '读图请求发到了视觉模型自己的服务地址、带自己的密钥；文本服务没有收到 P1 请求', reqA.length >= 1 && reqA.every(r => r.images >= 1 && r.auth === `Bearer ${VKEY}` && r.model === 'mock-vision-model') && mock.p1Requests.length === 0, `mock2=${reqA.length} mock=${mock.p1Requests.length}`)
    const lA = located(pA.id)
    check('识别质量', '读图后每道题有框（要求视觉模型给框）：≥ 90% 有框', lA.n >= 20 && lA.withBox / lA.n >= 0.9 && lA.qs.filter(hasBox).every(q => q.bbox_source === 'vision'), `${lA.withBox}/${lA.n}`)
    await goto(`#/paper/${pA.id}`)
    await T('recognition-card').waitFor({ timeout: 15000 })
    const cardA = clean(await txt('recognition-card'))
    check('识别方式', '试卷详情写「第 1 页：AI 读图」和为什么（这台电脑没装中文识别，所以交给 AI 读图）', /第 1 页：AI 读图/.test(cardA) && /没装中文识别/.test(cardA), cardA.slice(0, 200))
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_base_url: '' }), SECRET, null)
  }
  const nameB = 'g4-2025-page1-期末B.png'
  {
    // B：没有视觉模型 → 只能用本机文字；试卷标「识别可能不完整」，详情里说明没装中文语言包
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: '', vision_base_url: '' }), SECRET, null)
    const pB = await seedWin(nameB, 'B')
    await parseAi(pB.id)
    const doneB = await waitParsed(nameB)
    const pgB = pagesOf(pB.id)[0]
    check('识别质量', '没有视觉模型：仍用本机文字解析成功，记下「识别效果不好但没有视觉模型」，没有发图', doneB.status === 'reviewing' && pgB.recognizer === 'win-ocr' && pgB.rec_reason === 'no-vision-model' && mock.p1Requests.every(r => r.images === 0), `${doneB.status} ${pgB.recognizer}/${pgB.rec_reason}`)
    const lst = await api(() => window.api.papers.list())
    check('识别方式', 'papers:list 带 rec_low，试卷库用它标「识别可能不完整」', lst.find(p => p.id === pB.id)?.rec_low === 1 && !(lst.find(p => p.id === parsed.png.id)?.rec_low > 0), String(lst.find(p => p.id === pB.id)?.rec_low))
    await goto('#/'); await T('dropzone').waitFor()
    const row = page().locator(`tr[data-row-key="${pB.id}"]`)
    await row.waitFor({ timeout: 15000 })
    check('识别方式', '试卷库这一行有「识别可能不完整」小标签（文字，不只靠颜色）', !!(await waitFor(async () => /识别可能不完整/.test(await row.innerText()), 10000)), clean(await row.innerText()).slice(0, 80))
    await goto(`#/paper/${pB.id}`)
    await T('recognition-card').waitFor({ timeout: 15000 })
    const cardB = clean(await txt('recognition-card'))
    check('识别方式', '详情页写「第 1 页：Windows 自带识别（English）　没装中文语言包，中文可能认不全」，并说明为什么只能用它', /第 1 页：Windows 自带识别（English）/.test(cardB) && /没装中文语言包，中文可能认不全/.test(cardB) && /还没有设置能读图的 AI 模型/.test(cardB) && /这份卷子的识别可能不完整/.test(cardB), cardB.slice(0, 220))
    check('识别方式', 'macOS 上不显示「怎么安装中文识别」（Windows 才有）', process.platform === 'win32' || (await T('install-zh-ocr').count()) === 0)
    await shot9('recognition-card-light')
    await setTheme('dark'); await goto(`#/paper/${pB.id}`); await T('recognition-card').waitFor()
    await shot9('recognition-card-dark')
    await setTheme('light')
    // 审核页顶部也有这张卡
    await goto(`#/review/${pB.id}`)
    await T('review-recognition').waitFor({ timeout: 15000 })
    check('识别方式', '审核页顶部同样有「识别方式」卡', /Windows 自带识别/.test(await txt('review-recognition')))
  }
  {
    // C：一律读图（images_always）：本机识别正常的页也读图
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_policy: 'images_always' }), SECRET, null)
    mock.resetStats()
    const nameC = 'g4-2025-page1-C.png'
    tagged(nameC, 'C'); await L.dropFiles(page(), [path.join(fx, nameC)])
    const pC = await waitExtracted(nameC)
    await parseAi(pC.id)
    const doneC = await waitParsed(nameC)
    const pgC = pagesOf(pC.id)[0]
    check('读图策略', '「图片和扫描件一律交给 AI 读图」：本机识别正常的页也发图', doneC.status === 'reviewing' && mock.p1Requests.length >= 1 && mock.p1Requests.every(r => r.images >= 1) && pgC.recognizer === 'vision-model' && pgC.rec_reason === 'policy-images-always', `${pgC.recognizer}/${pgC.rec_reason}`)
    // D：从不读图（never）：识别再差也不发图
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_policy: 'never' }), SECRET, null)
    mock.resetStats()
    const nameD = 'g4-2025-page1-期末D.png'
    tagged(nameD, 'D'); await L.dropFiles(page(), [path.join(fx, nameD)])
    const pD = await waitExtracted(nameD)
    writeDb(d => { d.prepare("UPDATE pages SET ocr_lang = 'en-US', ocr_conf = 0.8, recognizer = 'win-ocr', quality_json = NULL WHERE paper_id = ?").run(pD.id); garbleCjk(d, pD.id) })
    await parseAi(pD.id)
    const doneD = await waitParsed(nameD)
    const pgD = pagesOf(pD.id)[0]
    check('读图策略', '「从不读图」：识别很差也只用本机文字，不发图，记下原因', doneD.status === 'reviewing' && mock.p1Requests.every(r => r.images === 0) && pgD.recognizer === 'win-ocr' && pgD.rec_reason === 'vision-never', `${pgD.recognizer}/${pgD.rec_reason}`)
  }
  {
    // E：视觉模型第一次没给框 → 带着名单要求补；第二次给全
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-model', vision_policy: 'auto' }), SECRET, null)
    mock.quirks = { visionNoBoxFirst: true }
    const nameE = 'g4-2025-page1-期末E.png'
    const pE = await seedWin(nameE, 'E')
    mock.quirks = { visionNoBoxFirst: true }
    await parseAi(pE.id)
    const doneE = await waitParsed(nameE)
    const reqE = mock.p1Requests
    const lE = located(pE.id)
    check('视觉要框', '视觉模型有题没给框：第一次的结果不直接收，带着「哪些题没给 anchor」再要一次，补全后入库', doneE.status === 'reviewing' && reqE.length === 2 && /anchor/.test(reqE[1].retryFeedback) && /位置|框/.test(reqE[1].retryFeedback) && lE.withBox / lE.n >= 0.9, `请求 ${reqE.length} 次；有框 ${lE.withBox}/${lE.n}；${reqE[1]?.retryFeedback.slice(0, 60)}`)
    mock.quirks = {}
  }
  {
    // F：读图 403 → 改用本机文字，不让整份卷子失败；解析记录里能看到
    await saveCfg(cfgFor(mock, { auto_parse: false, vision_model: 'mock-vision-403', vision_policy: 'auto' }), SECRET, null)
    mock.forbidModels = ['mock-vision-403']
    const nameF = 'g4-2025-page1-期末F.png'
    const pF = await seedWin(nameF, 'F')
    mock.forbidModels = ['mock-vision-403']
    await parseAi(pF.id)
    const doneF = await waitParsed(nameF)
    const pgF = pagesOf(pF.id)[0]
    const bF = withDb(ud, d => d.prepare('SELECT mode, model, ok, err_code FROM parse_batches WHERE paper_id = ? ORDER BY id').all(pF.id))
    check('读图 403', '视觉模型 403：这页改用本机识别的文字，卷子仍解析成功，原因记为「读图时没有权限」', doneF.status === 'reviewing' && pgF.recognizer === 'win-ocr' && pgF.rec_reason === 'vision-forbidden', `${doneF.status} ${pgF.recognizer}/${pgF.rec_reason}`)
    check('读图 403', '批次明细里：读图那批失败（forbidden），随后文本那批成功', bF.length === 2 && bF[0].mode === 'vision' && bF[0].ok === 0 && bF[0].err_code === 'forbidden' && bF[1].mode === 'text' && bF[1].ok === 1, JSON.stringify(bF))
    await goto(`#/paper/${pF.id}`)
    await T('recognition-card').waitFor({ timeout: 15000 })
    check('读图 403', '详情页的原因：AI 读图时这个密钥没有权限，已改用本机识别的文字', /AI 读图时这个密钥没有权限/.test(await txt('recognition-card')))
    mock.forbidModels = []
  }

  // ───────────────────────── 6. 拆题模型与写报告模型分开；批次明细；建议换模型 ─────────────────────────
  {
    await saveCfg(cfgFor(mock, { auto_parse: false, model: 'mock-report-model', parse_model: PARSE_M, vision_model: '', vision_policy: 'auto' }), SECRET, null)
    mock.reset()
    const nameG = 'g4-2025-page1-G.png'
    tagged(nameG, 'G'); await L.dropFiles(page(), [path.join(fx, nameG)])
    const pG = await waitExtracted(nameG)
    mock.script([{ type: 'length', times: 1, only: 'p1' }])
    await parseAi(pG.id)
    const doneG = await waitParsed(nameG)
    const reqG = mock.p1Requests
    check('模型拆分', '拆题请求用的是「拆题用的模型」（推理型 mock-reasoning-parse），不是写报告的 mock-report-model', doneG.status === 'reviewing' && reqG.length >= 2 && reqG.every(r => r.model === PARSE_M), reqG.map(r => r.model).join())
    const batches = withDb(ud, d => d.prepare('SELECT * FROM parse_batches WHERE paper_id = ? ORDER BY id').all(pG.id))
    check('批次明细', '写长度截断后加长重试成功的批次：parse_batches 记录 truncated=1、escalated=1、尝试 ≥ 2 次、模型、耗时', batches.length === 1 && batches[0].truncated === 1 && batches[0].escalated === 1 && batches[0].attempts >= 2 && batches[0].model === PARSE_M && batches[0].ok === 1 && batches[0].ms > 0 && batches[0].mode === 'text', JSON.stringify(batches[0]))
    const usage = withDb(ud, d => d.prepare("SELECT model, kind FROM ai_usage WHERE paper_id = ? AND kind LIKE 'parse-%'").all(pG.id))
    check('模型拆分', '用量记录里拆题的调用记在拆题模型名下', usage.length >= 2 && usage.every(u => u.model === PARSE_M), JSON.stringify(usage))
    check('模型拆分', '解析记录的 AI 模型是拆题模型', paperRowById(pG.id).ai_model === PARSE_M, paperRowById(pG.id).ai_model)
  }
  function paperRowById(id) { return withDb(ud, d => d.prepare('SELECT * FROM papers WHERE id = ?').get(id)) }
  {
    // 建议换模型：最近 10 批里 ≥ 3 批写不完 → 设置页出现建议条；只提示、不改配置；可以「以后不再提示」
    writeDb(d => { for (let i = 0; i < 10; i++) d.prepare("INSERT INTO parse_batches (paper_id, seq, mode, model, attempts, truncated, escalated, ms, ok) SELECT id, ?, 'text', ?, 2, ?, ?, 95000, 1 FROM papers LIMIT 1").run(100 + i, PARSE_M, i < 4 ? 1 : 0, i < 4 ? 1 : 0) })
    const cfgBefore = JSON.stringify(await api(() => window.api.ai.getConfig()))
    await goto('#/settings?admin=1&tab=ai'); await T('ai-settings').waitFor()
    await T('model-hint').waitFor({ timeout: 15000 })
    const h = clean(await txt('model-hint'))
    check('建议换模型', '设置页出现建议条：写明模型名、最近几批里几批被重试、建议换成更快的拆题模型；程序不会自己换', new RegExp(PARSE_M).test(h) && /换成更快/.test(h) && /不会自己换/.test(h), h.slice(0, 200))
    check('建议换模型', '只提示、不自动切换：配置一字未改', JSON.stringify(await api(() => window.api.ai.getConfig())) === cfgBefore)
    await shot9('model-hint-light', 'model-hint')
    await goto('#/queue'); await T('queue-model-hint').waitFor({ timeout: 15000 })
    check('建议换模型', '处理队列页顶部也有同样的建议条（去设置 / 以后不再提示）', /mock-reasoning-parse/.test(await txt('queue-model-hint')) && /不会自己换模型/.test(await txt('queue-model-hint')))
    await shot9('queue-model-hint-light', 'queue-model-hint')
    await goto('#/settings?admin=1&tab=ai'); await T('model-hint').waitFor({ timeout: 15000 })
    await T('model-hint-dismiss').click()
    check('建议换模型', '点「以后不再提示」后建议条消失，刷新页面也不再出现', await waitFor(async () => (await T('model-hint').count()) === 0, 8000) && (await (async () => { await page().reload(); await T('ai-settings').waitFor(); await sleep(800); return (await T('model-hint').count()) === 0 })()))
    // 9 批不触发
    writeDb(d => { d.prepare("DELETE FROM settings WHERE key LIKE 'parse_hint_off:%'").run(); d.prepare("DELETE FROM parse_batches WHERE model = 'mock-reasoning-parse' AND seq < 108").run() })
    const hint9 = await api(() => window.api.ai.modelHint())
    check('建议换模型', '批次不足 10 个不下结论', hint9.suggest === false && hint9.total < 10, JSON.stringify(hint9))
  }
  {
    // 推理型拆题模型：设置页保存前就给预防性提示（深度思考型，较慢）
    await saveCfg(cfgFor(mock, { auto_parse: false, model: 'deepseek-v4-pro', parse_model: '', vision_model: 'mock-vision-model' }), SECRET, null)
    await goto('#/settings?admin=1&tab=ai'); await page().reload(); await T('ai-settings').waitFor()
    await T('parse-model-slow-tip').waitFor({ timeout: 15000 })
    const tag = clean(await T('model-speed-tag').first().innerText())
    check('建议换模型', '拆题用的是深度思考型模型时，设置页写明「深度思考型（较慢）」并预先建议换快速的', /深度思考型/.test(tag) && /换成快速的/.test(await txt('parse-model-slow-tip')), tag)
    await shot9('settings-split-light', 'parse-model-hint')
    await setTheme('dark'); await goto('#/settings?admin=1&tab=ai'); await T('ai-settings').waitFor(); await sleep(600)
    await shot9('settings-split-dark', 'parse-model-hint')
    await setTheme('light')
  }

  // ───────────────────────── 7. 收尾 ─────────────────────────
  check('截图', '新界面状态的浅色 / 深色截图已存到 docs/screenshots/m9a-*.png', fs.readdirSync(shots).filter(f => /^m9a-.*\.png$/.test(f)).length >= 10, fs.readdirSync(shots).filter(f => /^m9a-/.test(f)).join(' '))
  check('控制台', '整个测试里页面没有未捕获的错误', ctx.consoleErrors.filter(e => !/DevTools|Autofill|Failed to load resource/.test(e)).length === 0, JSON.stringify(ctx.consoleErrors).slice(0, 300))
  await mock2.stop()
}

const out = path.join(__dirname, 'last-result-m9a.json')
const dumpFailure = async () => {
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
}
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  await dumpFailure()
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 1)
})
