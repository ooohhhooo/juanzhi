// M2 端到端：AI 解析（mock 服务）、处理队列、审核页、AI/提示词设置。
// 用 playwright-core 启动 out/ 里的真实 Electron；AI 请求走 tests/mock-ai 的本地 OpenAI 兼容服务。
// 用法：npm run test:e2e:m2   （需在沙箱外运行：Vision OCR 与本地端口监听都被沙箱限制）
const L = require('./lib.cjs')
const { startMock } = require('../mock-ai/server.cjs')
const { check, sleep, waitFor, launch, dropFiles, listPapers, paperByFile, waitStatus, copyWithTag, cropPage, ocrText, stableBox, docsPrompt, withDb, root, fs, path, os } = L
const { execFileSync } = require('node:child_process')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-m2-'))
const shots = path.join(root, 'docs/screenshots')
const cropDir = path.join(work, 'crops')
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(cropDir, { recursive: true })
const SECRET = 'sk-e2e-SECRET-20261025-abcdef'
const pdf25 = path.join(root, 'samples/g4-2025.pdf')
const pdf26 = path.join(root, 'samples/g4-2026.pdf')
const png1 = path.join(root, 'samples/g4-2025-page1.png')
const clean = e => String(e).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '')

const ctx = { mock: null, app: null, page: null, ud: path.join(work, 'userData'), fx: path.join(work, 'fixtures') }
fs.mkdirSync(ctx.fx, { recursive: true })

const cfgFor = (mock, over = {}) => ({
  provider: 'custom', base_url: mock.baseUrl, model: 'mock-text-model', vision_model: 'mock-vision-model',
  concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 8192, ...over
})
const saveCfg = (page, cfg, key) => page.evaluate(([c, k]) => (k === undefined ? window.api.ai.saveConfig(c) : window.api.ai.saveConfig(c, k)), [cfg, key])
const parse = (page, id, stage) => page.evaluate(([i, s]) => window.api.parse.start(i, s).then(() => 'ok', e => String(e)), [id, stage])
const getQs = (page, id) => page.evaluate(i => window.api.questions.list(i), id)
const p1count = () => ctx.mock.p1Requests.length

// ───────────────────────── 阶段 0：v4 → v5 增量迁移 ─────────────────────────
async function phaseMigration() {
  const ud = path.join(work, 'userData-mig')
  // 用 M1 提交（7211fc1）里真实的 v1–v4 迁移代码建一个 v4 库（不是把 v5 库「退化」出来的），
  // 再放入「老版本留下的数据」：一道题 + 它的知识点标注 + 老师自建的知识点 + 老师改过名的同代码节点
  let db
  try {
    db = L.buildRealV4Db(path.join(ud, 'workbench-data', 'db.sqlite'))
  } catch (e) {
    check('迁移 v5', '用 7211fc1 的真实 v1–v4 迁移建出 v4 库', false, e.message)
    return
  }
  const v4cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name)
  check('迁移 v5', '前提：用 git 里 7211fc1 的真实迁移代码建出了 v4 库（questions 还没有 M2 的列）', db.prepare('PRAGMA user_version').get().user_version === 4 && !v4cols.includes('ord') && !v4cols.includes('no_label'), v4cols.join(','))
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(`
    INSERT INTO kps (code, parent_code, name, level, sort) VALUES ('CUSTOM.MINE', NULL, '老师自己建的节点', 1, 5), ('GR.NOUN.PLURAL', NULL, '我改过名的复数', 1, 6);
    INSERT INTO papers (id, title, file_name, file_hash, status) VALUES ('33333333-3333-4333-8333-333333333333', '旧卷', 'old.pdf', 'h-old', 'extracted');
    INSERT INTO questions (id, paper_id, no, section, qtype, stem, difficulty) VALUES ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 7, '二', 'MC', '旧题干', 3);
    INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES ('44444444-4444-4444-8444-444444444444', 'CUSTOM.MINE', 1);
  `)
  db.close()
  const r = await launch({ userDataDir: ud })
  await r.app.close()
  withDb(ud, d => {
    const uv = d.prepare('PRAGMA user_version').get().user_version
    const qcols = d.prepare('PRAGMA table_info(questions)').all().map(c => c.name)
    const q = d.prepare("SELECT * FROM questions WHERE id LIKE '4444%'").get()
    const kpLink = d.prepare("SELECT COUNT(*) c FROM question_kps WHERE question_id LIKE '4444%'").get().c
    const mine = d.prepare("SELECT name, builtin FROM kps WHERE code = 'CUSTOM.MINE'").get()
    const renamed = d.prepare("SELECT name FROM kps WHERE code = 'GR.NOUN.PLURAL'").get()
    const nKps = d.prepare('SELECT COUNT(*) c FROM kps').get().c
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    const oth = d.prepare("SELECT 1 FROM qtypes WHERE code = 'OTHER'").get()
    check('迁移 v5', '带数据的真实 v4 库升级到最新版本（现为 v9，M3 在 v5 之后新增了 v6、v7、v8，M4 新增 v9）：版本号、v5 的新列、新表齐全', uv === 9 && ['ord', 'no_label', 'flags_json', 'bbox_source'].every(c => qcols.includes(c)) && ['materials', 'parse_runs', 'ai_usage'].every(t => tables.includes(t)), `v${uv}`)
    check('迁移 v5', '旧题目与它的知识点标注原样保留（没有因重建表被外键级联清空）', q?.stem === '旧题干' && q.no === 7 && kpLink === 1)
    check('迁移 v5', '老师自建的知识点保留；与种子同代码的节点不被覆盖（INSERT OR IGNORE）；其余种子补齐', mine?.name === '老师自己建的节点' && mine.builtin === 0 && renamed?.name === '我改过名的复数' && nKps >= 140 && !!oth, `共 ${nKps} 个节点`)
  })
}

// ───────────────────────── 阶段 1：全新库、种子、AI 设置、密钥安全 ─────────────────────────
async function phaseSetup() {
  ctx.mock = await startMock({ apiKey: SECRET })
  const r = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, r)
  const { page, mock } = ctx

  withDb(ctx.ud, d => {
    const uv = d.prepare('PRAGMA user_version').get().user_version
    const kps = d.prepare('SELECT * FROM kps').all()
    const bad = kps.filter(k => k.level > 3 || (k.parent_code && !kps.some(p => p.code === k.parent_code)))
    const qts = d.prepare('SELECT * FROM qtypes').all()
    check('知识点树', `全新库 v${uv}：种子树 ${kps.length} 个节点（80–150）、最多 3 层、父节点都存在、代码唯一`, uv === 9 && kps.length >= 80 && kps.length <= 150 && bad.length === 0 && new Set(kps.map(k => k.code)).size === kps.length, `${kps.length} 个`)
    check('知识点树', '每个节点都有名称与引入年级；题型表含 OTHER 兜底与 6 种听力题型', kps.every(k => k.name && k.intro_grade >= 3) && qts.some(q => q.code === 'OTHER') && qts.filter(q => q.group === 'listening').length === 6, `${qts.length} 种题型`)
    ctx.kpCount0 = kps.length
  })

  // 设置页：走真实界面填写 AI 配置
  await page.evaluate(() => { location.hash = '#/settings' })
  await page.waitForSelector('[data-testid=ai-settings]')
  await page.locator('[data-testid=ai-provider]').click()
  await page.locator('.ant-select-item-option', { hasText: 'DeepSeek' }).click()
  const dsUrl = await page.locator('[data-testid=ai-base-url]').inputValue()
  const dsModel = await page.locator('[data-testid=ai-model] input').inputValue()
  const dsVision = await page.locator('[data-testid=ai-vision-model] input').inputValue()
  check('AI 设置', '选 DeepSeek 预设：Base URL / 文本模型 / 视觉模型自动填入，默认不是已下线的 deepseek-chat', dsUrl === 'https://api.deepseek.com' && dsModel === 'deepseek-v4-pro' && dsVision === 'deepseek-flash' && !/chat/.test(dsModel), `${dsUrl} ${dsModel} ${dsVision}`)
  const presets = await page.evaluate(() => window.api.ai.presets())
  check('AI 设置', '预设含 DeepSeek / 通义千问 / 豆包 / Kimi / 智谱 / 自定义，且无一以 deepseek-chat 为默认', ['deepseek', 'qwen', 'doubao', 'kimi', 'zhipu', 'custom'].every(id => presets.some(p => p.id === id)) && !presets.some(p => /deepseek-chat/.test(p.model + p.visionModel)))

  await page.locator('[data-testid=ai-provider]').click()
  await page.locator('.ant-select-item-option', { hasText: '自定义' }).click()
  await page.locator('[data-testid=ai-base-url]').fill(mock.baseUrl)
  await page.locator('[data-testid=ai-model] input').fill('mock-text-model')
  await page.locator('[data-testid=ai-vision-model] input').fill('mock-vision-model')
  await page.locator('[data-testid=ai-key]').fill(SECRET)
  // 先测再存：用输入框里的值测试连接
  await page.locator('[data-testid=ai-test]').click()
  await page.waitForSelector('[data-testid=ai-test-result]')
  const okText = await page.locator('[data-testid=ai-test-result]').innerText()
  check('AI 设置', '「测试连接」用界面当前值（尚未保存）连通 mock，提示成功', /成功/.test(okText) && mock.requests.at(-1)?.auth === `Bearer ${SECRET}`, okText.replace(/\n/g, ' '))
  await page.locator('[data-testid=ai-test-vision]').click()
  await page.waitForFunction(() => /视觉模型：/.test(document.querySelector('[data-testid=ai-test-result]')?.innerText || ''))
  check('AI 设置', '「测试视觉模型」发出带图片的请求', mock.requests.at(-1)?.images === 1 && mock.requests.at(-1)?.model === 'mock-vision-model')
  const dim = mock.requests.at(-1)?.imageDims?.[0]
  check('AI 设置', '视觉测试用的图是 128×128（1×1 的图会被部分服务商拒收，让人误以为配置错了）', !!dim && dim.w >= 64 && dim.h >= 64, JSON.stringify(dim))
  ctx.pv = (await page.evaluate(() => window.api.ai.prompts())).defaultVersion
  check('提示词版本', '内置提示词版本号为 v1.1（示例代码换成树里真实代码后升了一版）', /^v1\.1$/.test(ctx.pv), ctx.pv)
  await page.locator('[data-testid=ai-key]').fill('sk-wrong-key')
  await page.locator('[data-testid=ai-test]').click()
  await page.waitForFunction(() => /失败/.test(document.querySelector('[data-testid=ai-test-result]')?.innerText || ''))
  const badText = await page.locator('[data-testid=ai-test-result]').innerText()
  check('AI 设置', '密钥错误时给出明确中文原因（401 → API Key 无效）', /API Key 无效/.test(badText), badText.replace(/\n/g, ' '))
  await page.locator('[data-testid=ai-key]').fill(SECRET)
  await page.locator('[data-testid=ai-save]').click()
  await page.waitForSelector('.ant-message-notice')
  await sleep(300)
  await page.screenshot({ path: path.join(shots, 'm2-01-settings-ai.png') })

  // 密钥安全
  const view = await page.evaluate(() => window.api.ai.getConfig())
  check('密钥安全', 'getConfig 只返回 hasKey，整个返回值里没有密钥', view.hasKey === true && !JSON.stringify(view).includes(SECRET) && !('apiKey' in view) && !('api_key' in view), JSON.stringify(view).slice(0, 160))
  const rdGet = await page.evaluate(() => Promise.all(['ai_api_key', 'ai_key_enc', 'ai_config', 'schema_version'].map(k => window.api.settings.get(k).then(v => 'resolved:' + JSON.stringify(v), e => 'rejected'))))
  const rdSet = await page.evaluate(() => Promise.all(['ai_api_key', 'ai_key_enc'].map(k => window.api.settings.set(k, 'x').then(() => 'resolved', e => 'rejected'))))
  check('密钥安全', 'settings.get / set 通用接口读不到、写不进密钥与 AI 配置（白名单外全部拒绝）', rdGet.every(x => x === 'rejected') && rdSet.every(x => x === 'rejected'), rdGet.join(',') + ' | ' + rdSet.join(','))
  const surface = await page.evaluate(() => ({
    keys: Object.keys(window.api).flatMap(k => typeof window.api[k] === 'object' ? Object.keys(window.api[k]).map(m => `${k}.${m}`) : [k]),
    dom: document.documentElement.innerHTML + [...document.querySelectorAll('input')].map(i => i.value).join('|'),
    ls: JSON.stringify(Object.entries(localStorage))
  }))
  check('密钥安全', '渲染端 API 面上没有任何读取密钥的方法；保存后输入框已清空，页面 DOM / localStorage 里没有密钥', !surface.keys.some(k => /getKey|apiKey|secret/i.test(k)) && !surface.dom.includes(SECRET) && !surface.ls.includes(SECRET), `${surface.keys.length} 个 API`)
  const keyInput = await page.locator('[data-testid=ai-key]').inputValue()
  check('密钥安全', '保存后密钥输入框为空（占位符提示「已保存」）', keyInput === '' && /已保存/.test(await page.locator('[data-testid=ai-key]').getAttribute('placeholder')))
  await sleep(500)
  const files = ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'].map(f => path.join(ctx.ud, 'workbench-data', f)).filter(f => fs.existsSync(f))
  const leaked = files.filter(f => fs.readFileSync(f).includes(SECRET))
  const enc = withDb(ctx.ud, d => ({ k: d.prepare("SELECT value_json FROM settings WHERE key = 'ai_key_enc'").get(), c: d.prepare("SELECT value_json FROM settings WHERE key = 'ai_config'").get() }))
  check('密钥安全', '数据库文件（含 WAL）里搜不到明文密钥；密文由 safeStorage 加密落盘，配置里不含密钥', leaked.length === 0 && !!enc.k && enc.k.value_json.length > 40 && !enc.c.value_json.includes(SECRET), `扫描 ${files.length} 个文件，密文 ${enc.k?.value_json.length} 字符`)
  // 密钥只发往当初配套的服务：改地址必须同时重输密钥；测试新地址也不会借用已存的密钥
  const cur = await page.evaluate(() => window.api.ai.getConfig())
  const { hasKey, keyStorage, ...plain } = cur
  mock.resetStats()
  const redirected = await page.evaluate(c => window.api.ai.saveConfig({ ...c, base_url: 'http://127.0.0.1:9/v1' }).then(() => 'resolved', e => String(e)), plain)
  const redirTest = await page.evaluate(() => window.api.ai.test({ kind: 'text', cfg: { base_url: 'http://127.0.0.1:9/v1' } }))
  check('密钥安全', '页面脚本想把已存密钥「改发」到别的地址会被拒绝（保存要求同时重输密钥；测试新地址不借用已存密钥）', /重新输入 API Key/.test(redirected) && redirTest.ok === false && /API Key/.test(redirTest.message) && (await page.evaluate(() => window.api.ai.getConfig())).base_url === mock.baseUrl, redirected.slice(-40))

  // 保存密钥必须有地址；清空地址也不能带着已存密钥溜过去（审核 P1-5）
  const noUrlKey = await page.evaluate(c => window.api.ai.saveConfig({ ...c, base_url: '' }, 'sk-whatever-123456').then(() => 'resolved', e => String(e)), plain)
  const clearUrl = await page.evaluate(c => window.api.ai.saveConfig({ ...c, base_url: '' }).then(() => 'resolved', e => String(e)), plain)
  check('密钥安全', '没有 Base URL 时不能保存 API Key；已存密钥时把地址清空也被拒（要求重输密钥）', /先填写 Base URL/.test(noUrlKey) && /重新输入 API Key/.test(clearUrl) && (await page.evaluate(() => window.api.ai.getConfig())).base_url === mock.baseUrl, `${noUrlKey.slice(-30)} | ${clearUrl.slice(-40)}`)
  const badUrlTest = await page.evaluate(() => window.api.ai.test({ kind: 'text', cfg: { base_url: 'file:///etc/passwd' }, apiKey: 'sk-x' }))
  check('密钥安全', '连接测试只接受 http(s) 地址（file:// 之类被拒，不会让主进程去请求任意 URL）', badUrlTest.ok === false && /http/.test(badUrlTest.message), badUrlTest.message)
  // 明文 http 警告
  await page.evaluate(() => { location.hash = '#/settings' })
  await page.waitForSelector('[data-testid=ai-base-url]')
  await page.locator('[data-testid=ai-base-url]').fill('http://api.example.com/v1')
  const warnShown = await page.locator('[data-testid=ai-http-warning]').isVisible()
  await page.locator('[data-testid=ai-base-url]').fill(mock.baseUrl)
  const warnLocal = await page.locator('[data-testid=ai-http-warning]').count()
  check('密钥安全', '地址是明文 http（非本机）时设置页提示「API Key 会明文传输」；本机地址不提示', warnShown && warnLocal === 0)
  const logs = ctx.consoleErrors.join('\n')
  check('密钥安全', '渲染端控制台没有出现密钥', !logs.includes(SECRET))
}

// ─────────────────────────── 阶段占位：后面的阶段追加在这里 ───────────────────────────

// ───────────────────────── 阶段 2：暂停/并发/自动解析 + 入库内容 + bbox 位置 ─────────────────────────
async function phaseParse() {
  const { page, mock, app } = ctx
  await saveCfg(page, cfgFor(mock))
  const copy26 = copyWithTag(pdf26, path.join(ctx.fx, 'g4-2026-copy.pdf'), 'copy')
  ctx.copy26 = copy26

  // 暂停：拖入 3 份，队列不开始
  await page.evaluate(() => { location.hash = '#/queue' })
  await page.waitForSelector('[data-testid=pause-queue]')
  await page.locator('[data-testid=pause-queue]').click()
  await page.waitForSelector('[data-testid=paused-banner]')
  mock.delayMs = 6000
  await dropFiles(page, [pdf26, pdf25, copy26])
  await waitFor(async () => (await listPapers(page)).length >= 3, 15000)
  await page.evaluate(() => { location.hash = '#/queue' })
  await sleep(2500)
  const paused = await listPapers(page)
  const nPages = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM pages').get().c)
  check('处理队列', '暂停后拖入 3 份：都停在「排队中」，没有开始提取，也没有请求 AI', paused.length === 3 && paused.every(p => p.status === 'imported') && nPages === 0 && p1count() === 0, paused.map(p => p.status).join(','))
  const bannerOk = await page.locator('[data-testid=paused-banner]').isVisible()
  await page.screenshot({ path: path.join(shots, 'm2-02-queue-paused.png') })

  // 继续：自动提取 → 自动解析；并发上限 2
  await page.locator('[data-testid=resume-queue]').click()
  let maxRunning = 0
  let sawParsingUi = ''
  let sawBadge = ''
  const t0 = Date.now()
  let shotDone = false
  const done = await waitFor(async () => {
    const q = await page.evaluate(() => window.api.queue.state())
    maxRunning = Math.max(maxRunning, q.parse.running.length)
    const txt = await page.locator('[data-testid="qstate-g4-2026.pdf"]').innerText().catch(() => '')
    if (q.parse.running.length > 0 && !sawBadge) sawBadge = (await page.locator('[data-testid=badge-queue]').innerText().catch(() => '')).trim()
    if (/AI 解析中/.test(txt) && !sawParsingUi) sawParsingUi = txt.replace(/\n/g, ' ')
    if (q.parse.running.length === 2 && /AI 解析中/.test(txt) && !shotDone) { shotDone = true; await page.screenshot({ path: path.join(shots, 'm2-03-queue-running.png') }) }
    const ps = await listPapers(page)
    return ps.length === 3 && ps.every(p => p.status === 'reviewing') ? ps : null
  }, 150000, 250)
  check('处理队列', '恢复后 3 份自动走完「提取 → AI 解析 → 待审核」', !!done, `${Math.round((Date.now() - t0) / 1000)} 秒`)
  check('处理队列', '同时解析上限 2：请求最大并发 = 2、队列里同时运行的解析任务最多 2 份（第 3 份排队等待）', mock.maxInflight === 2 && maxRunning === 2, `mock 最大并发 ${mock.maxInflight}，队列最多 ${maxRunning} 份在跑`)
  check('处理队列', '队列页实时显示「AI 解析中」与进度', /AI 解析中/.test(sawParsingUi), sawParsingUi.slice(0, 80))
  mock.delayMs = 0
  const q0 = bannerOk
  check('处理队列', '暂停时页面有明确的「队列已暂停」提示与「继续处理」按钮', q0)
  check('处理队列', '侧栏「处理队列」图标上有进行中数量徽标', /^[1-3]$/.test(sawBadge), `徽标=${sawBadge}`)

  const byName = Object.fromEntries((done || []).map(p => [p.file_name, p]))
  ctx.p26 = byName['g4-2026.pdf']; ctx.p25 = byName['g4-2025.pdf']; ctx.p26c = byName['g4-2026-copy.pdf']

  // 入库内容
  withDb(ctx.ud, d => {
    for (const p of [ctx.p26, ctx.p25, ctx.p26c]) {
      const qs = d.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY ord').all(p.id)
      const orphans = d.prepare(`SELECT COUNT(*) c FROM question_kps qk JOIN questions q ON q.id = qk.question_id LEFT JOIN kps k ON k.code = qk.kp_code WHERE q.paper_id = ? AND k.code IS NULL`).get(p.id).c
      const links = d.prepare(`SELECT COUNT(*) c FROM question_kps qk JOIN questions q ON q.id = qk.question_id WHERE q.paper_id = ?`).get(p.id).c
      const noPrimary = d.prepare(`SELECT COUNT(*) c FROM questions q WHERE q.paper_id = ? AND (SELECT COUNT(*) FROM question_kps WHERE question_id = q.id AND is_primary = 1) <> 1`).get(p.id).c
      const badType = d.prepare(`SELECT COUNT(*) c FROM questions q LEFT JOIN qtypes t ON t.code = q.qtype WHERE q.paper_id = ? AND t.code IS NULL`).get(p.id).c
      check('入库', `${p.file_name}：拆出 36 道题，知识点标注 ${links} 条，全部在知识点树里，每题恰有 1 个主知识点，题型都在题型表里`, qs.length === 36 && orphans === 0 && noPrimary === 0 && badType === 0 && links >= 36, `题=${qs.length} 孤儿标注=${orphans} 无主知识点=${noPrimary}`)
      const noBox = qs.filter(q => !q.bbox_json)
      const failed = qs.filter(q => JSON.parse(q.flags_json).includes('locate_failed'))
      check('入库', `${p.file_name}：36 道题全部定位成功（bbox 非空、来源 text-anchor、无 locate_failed）`, noBox.length === 0 && failed.length === 0 && qs.every(q => q.bbox_source === 'text-anchor'), `无 bbox=${noBox.length} 失败=${failed.length}`)
      const mats = d.prepare('SELECT COUNT(*) c FROM materials WHERE paper_id = ?').get(p.id).c
      check('入库', `${p.file_name}：词库与阅读短文作为材料入库（2 份），题目引用了它们`, mats === 2 && qs.filter(q => q.material_id).length === 10, `材料=${mats}`)
    }
    const q26 = n => d.prepare('SELECT * FROM questions WHERE paper_id = ? AND no_label = ?').get(ctx.p26.id, String(n))
    check('入库', '页码正确：第 1–25 题在第 1 页，第 26–36 题在第 2 页', [1, 12, 25].every(n => q26(n).page_idx === 1) && [26, 30, 36].every(n => q26(n).page_idx === 2))
    const kpCount = d.prepare('SELECT COUNT(*) c FROM kps').get().c
    const sug = q26(22)
    const q30 = q26(30)
    const q30k = d.prepare('SELECT kp_code, is_primary FROM question_kps WHERE question_id = ?').all(q30.id)
    check('kp_suggestion', 'AI 的新增知识点建议单独存放、状态 pending；知识点树节点数没变，也没有以建议命名的节点（不自动写树）',
      sug.kp_suggestion === '购物：尺码询问' && sug.kp_suggestion_status === 'pending' && kpCount === ctx.kpCount0 && !d.prepare("SELECT 1 FROM kps WHERE name LIKE '%尺码%'").get(), `kps ${ctx.kpCount0} → ${kpCount}`)
    check('入库', '模型编造的知识点代码（RD.INFER.OPINION）不进库：退回最近的真实祖先 RD.INFER，记 kp_invalid，原代码留作「待归类」建议',
      q30k.length === 1 && q30k[0].kp_code === 'RD.INFER' && q30.kp_suggestion === '待归类：RD.INFER.OPINION' && JSON.parse(q30.flags_json).includes('kp_invalid') && !d.prepare("SELECT 1 FROM kps WHERE code = 'RD.INFER.OPINION'").get())
    const pp = d.prepare('SELECT * FROM papers WHERE id = ?').get(ctx.p26.id)
    const pp25 = d.prepare('SELECT * FROM papers WHERE id = ?').get(ctx.p25.id)
    check('元数据', '用户没填的元数据由 AI 预填（年级 4、下学期、2025 学年、期末、教材、满分），并记为「AI 猜测」', pp.grade === '4' && pp.semester === '下' && pp.school_year_start === 2025 && pp.exam_type === '期末' && pp.textbook === '人教PEP版' && pp.total_score === 100 && JSON.parse(pp.ai_meta_json).includes('grade') && pp25.school_year_start === 2024, `${pp.grade}/${pp.semester}/${pp.school_year_start}/${pp.exam_type}/${pp.textbook}; ai=${pp.ai_meta_json}`)
    check('提示词版本', `每份试卷记录解析用的模型与提示词版本（内置 ${ctx.pv}）`, pp.prompt_version === ctx.pv && pp.ai_model === 'mock-text-model' && !!pp.parsed_at, `${pp.ai_model} / ${pp.prompt_version}`)
    const u = d.prepare('SELECT COUNT(*) n, SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(cached_tokens) k FROM ai_usage WHERE paper_id = ?').get(ctx.p26.id)
    check('token 用量', '每次调用的 token 用量写入 ai_usage（含缓存命中数）', u.n >= 1 && u.p > 0 && u.c > 0, JSON.stringify(u))
    const allUsage = d.prepare('SELECT SUM(cached_tokens) k FROM ai_usage').get().k
    check('token 用量', '缓存命中数的记录链路：mock 按「同一 system 见过没」模拟 prompt_cache_hit_tokens，证明该字段被解析并落库（⚠️ 不代表真实服务商的命中率）', allUsage > 0, `cached=${allUsage}（mock 模拟值）`)
  })

  // 发给模型的内容
  const req26 = mock.p1Requests.find(r => r.fileName === 'g4-2026.pdf')
  const sysFile = docsPrompt('p1_text', 'system')   // 直接从 docs 取，不经过资源文件
  check('提示词', 'system 部分与 docs/prompts 里 P1 文本版逐字一致（直接从 docs 取，不是资源文件），且所有 P1 请求的 system 彼此相同（利于前缀缓存）', req26.system === sysFile && mock.p1Requests.every(r => r.system === req26.system), `system ${req26.system.length} 字`)
  check('提示词', 'user 部分：行带 [页-行] 标签；康熙部首已归一（"第二学期"）；知识点树与题型表按运行时数据渲染；批次信息正确',
    req26.user.includes('[1-04]1. A. farm B. car C. warm') && req26.user.includes('第二学期四年级英语期末试卷') && !/[⼀-⿟]/.test(req26.user) &&
    req26.user.includes('GR.TENSE.PAST.IRREG | 时态/一般过去时/不规则动词过去式 | 5 |') && /\nOTHER \| 其他 \|/.test(req26.user) && req26.user.includes('第 1/1 批，本批为试卷第 1–2 页（全卷共 2 页）') && req26.user.includes('（无，本批是第一批）') && !/\{\{[A-Z_]+\}\}/.test(req26.user),
    req26.user.match(/本批信息：.*/)?.[0])
  check('提示词', '请求参数：response_format=json_object、纯文本无图片、max_tokens 已给足', mock.p1Requests.every(r => r.jsonMode && r.images === 0 && r.maxTokens >= 8192))

  // bbox 位置：用页面图 + 真实 OCR 反向验证
  const dir26 = path.join(ctx.ud, 'workbench-data', 'files', ctx.p26.id)
  const bboxOf = n => withDb(ctx.ud, d => { const q = d.prepare('SELECT bbox_json, page_idx FROM questions WHERE paper_id = ? AND no_label = ?').get(ctx.p26.id, String(n)); return { bbox: JSON.parse(q.bbox_json), page: q.page_idx } })
  const sq = s => s.replace(/\s+/g, '').toLowerCase()
  const cases = [
    [9, ['tom', 'farm'], ['wear', 'howmuch']],
    [10, ['wear', 'dress'], ['tom', 'howmuch']],
    [15, ['weshould', 'important'], ['用所给词', '三']], // 大题最后一题：不吞掉下一个大题标题
    [16, ['lookatthe'], ['thoseare']],                  // 同一行的两道题：左半
    [17, ['thoseare'], ['lookatthe']],                  //                右半
    [18, ['mysister'], ['than']],
    [19, ['thanmybrother'], ['mysister']],
    [32, ['did,what', 'weekend'], ['33.are']],         // 折行的题从行中间起：矩形框会带上同一行左边的上一题，但不会吞下一题
    [30, ['whatdoesamythink', 'coldindecember'], ['29.who']],
    [36, ['mylastweekend'], ['plant']]
  ]
  let allOk = true
  const details = []
  for (const [n, must, mustNot] of cases) {
    const { bbox, page: pg } = bboxOf(n)
    const png = path.join(dir26, `page-${pg}.png`)
    const out = await cropPage(app, png, bbox, path.join(cropDir, `q${n}.png`), 0.002)
    const txt = sq(ocrText(out))
    const ok = must.every(w => txt.includes(sq(w))) && mustNot.every(w => !txt.includes(sq(w)))
    if (!ok) allOk = false
    details.push(`Q${n}${ok ? '✓' : '✗(' + txt.slice(0, 50) + ')'}`)
  }
  // 留几张裁图当证据（页面图按 bbox 裁出来的样子）
  for (const n of [9, 16, 17, 32]) fs.copyFileSync(path.join(cropDir, `q${n}.png`), path.join(shots, `m2-crop-text-q${n}.png`))
  check('bbox 位置', '把页面图按 bbox 裁出来再做真实 OCR：每题的框里有本题的文字、没有相邻题的文字（含同一行两道题、大题边界）', allOk, details.join(' '))
  const b9 = bboxOf(9).bbox, b17 = bboxOf(17).bbox, b16 = bboxOf(16).bbox
  check('bbox 位置', '数值核对（PDF 文本层真实坐标）：Q9 的框 y≈0.444、高≈1 行；Q17 的框从行中间开始，与 Q16 的框不重叠',
    Math.abs(b9[1] - (0.444 - 0.004)) < 0.006 && b9[3] > 0.022 && b9[3] < 0.034 && b17[0] > 0.3 && b16[0] + b16[2] <= b17[0] + 0.012 && b16[1] === b17[1], `Q9=${b9} Q16=${b16} Q17=${b17}`)
}


// ───────────────────────── 阶段 3：元数据只填空白、故障场景与重试、分阶段重试、取消 ─────────────────────────
async function phaseFailures() {
  const { page, mock, app } = ctx
  const metaFile = copyWithTag(pdf26, path.join(ctx.fx, 'g4-2026-meta.pdf'), 'meta')
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))
  mock.resetStats()
  await dropFiles(page, [metaFile])
  const ex = await waitStatus(page, 'g4-2026-meta.pdf', ['extracted', 'failed'], 90000)
  await sleep(1500)
  check('自动解析', '关闭「提取后自动解析」：提取完成后停在「已提取」，不会偷偷调用 AI', ex?.status === 'extracted' && (await paperByFile(page, 'g4-2026-meta.pdf')).status === 'extracted' && p1count() === 0)
  const id = ex.id
  ctx.metaId = id
  await page.evaluate(i => window.api.papers.update(i, { textbook: '自填教材', semester: '上' }), id)

  // 通过界面点「开始 AI 解析」
  await page.evaluate(() => { location.hash = '#/queue' })
  await page.waitForSelector('[data-testid=pause-queue], [data-testid=resume-queue]')
  await page.getByText(/需处理/).first().click()
  const row = page.locator('tr', { hasText: 'g4-2026-meta.pdf' })
  await row.locator('[data-testid=start-parse]').click()
  const parsed = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 60000)
  check('元数据', '只预填用户留空的字段：用户填过的学期「上」与教材不被 AI 覆盖，空着的年级由 AI 预填；标题仍是文件名时也预填', parsed?.status === 'reviewing' && parsed.semester === '上' && parsed.textbook === '自填教材' && parsed.grade === '4' && /2025-2026/.test(parsed.title),
    `${parsed?.status} 学期=${parsed?.semester} 教材=${parsed?.textbook} 年级=${parsed?.grade} 标题=${parsed?.title}`)
  const ai = JSON.parse(parsed.ai_meta_json)
  check('元数据', '「AI 猜测」只标 AI 填的字段（年级等），不标用户填的学期与教材', ai.includes('grade') && !ai.includes('semester') && !ai.includes('textbook'), parsed.ai_meta_json)
  // 详情页、编辑弹窗里也带「AI 猜测」；用户只改了一个字段，只有那个字段的标记消失（审核第四节：原先只断言了试卷库）
  await page.evaluate(i => { location.hash = '#/paper/' + i }, id)
  await page.waitForSelector('text=解析')
  const detailGuess = await page.locator('[data-testid=ai-guess]').count()
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  await page.locator('tbody tr').first().locator('.anticon-edit').click()
  await page.waitForSelector('.ant-modal [data-testid=ai-guess]')
  const modalGuess = await page.locator('.ant-modal [data-testid=ai-guess]').count()
  await page.keyboard.press('Escape')
  check('元数据', '详情页与编辑弹窗里 AI 预填的字段也带「AI 猜测」标记', detailGuess >= 3 && modalGuess >= 4, `详情页 ${detailGuess} 个，弹窗 ${modalGuess} 个`)
  const cur0 = await page.evaluate(i => window.api.papers.get(i), id)
  const keep = { grade: cur0.grade, semester: cur0.semester, school_year_start: cur0.school_year_start, exam_type: cur0.exam_type, textbook: cur0.textbook, total_score: cur0.total_score, title: cur0.title }
  const a1 = await page.evaluate(([i, k]) => window.api.papers.update(i, { ...k, school: '某某小学' }), [id, keep])
  const ai1 = JSON.parse(a1.ai_meta_json)
  const a2 = await page.evaluate(([i, k]) => window.api.papers.update(i, { ...k, grade: '5', school: '某某小学' }), [id, keep])
  const ai2 = JSON.parse(a2.ai_meta_json)
  check('元数据', '编辑表单一次提交全部字段时，只有值真正改变的字段才失去「AI 猜测」标记（只改学校 → 标记全留；改年级 → 仅年级的标记消失）', ai1.includes('grade') && ai1.includes('exam_type') && !ai2.includes('grade') && ai2.includes('exam_type') && ai2.includes('school_year_start'), `${JSON.stringify(ai1)} → ${JSON.stringify(ai2)}`)
  await page.evaluate(([i, k]) => window.api.papers.update(i, { grade: k.grade }), [id, keep])
  const reqM = mock.p1Requests.at(-1)
  check('元数据', '用户已填的元数据作为 {{KNOWN_META}} 发给模型（学期=上；教材=自填教材），没填的不出现', /用户已填元数据[^\n]*：学期=上；教材=自填教材\n/.test(reqM.user) && !/年级=/.test(reqM.user.match(/用户已填元数据[^\n]*/)[0]), reqM.user.match(/用户已填元数据[^\n]*/)[0])
  await page.evaluate(() => { location.hash = '#/' })
  await sleep(500)
  await page.locator('tr', { hasText: '自填教材' }).first().waitFor().catch(() => {})
  await page.screenshot({ path: path.join(shots, 'm2-04-library-ai-guess.png') })
  const guessTags = await page.locator('[data-testid=ai-guess]').count()
  check('元数据', '试卷库里 AI 预填的字段带「AI 猜测」标记', guessTags >= 3, `${guessTags} 个标记`)

  // 通用：运行一次带故障脚本的解析
  const bad = x => !/Error|undefined|\[object|at .*\(/.test(x) && /[一-龥]/.test(x)
  async function run(label, script, { stage = 'ai', want, batchPages, timeoutSec, key } = {}) {
    mock.resetStats()
    mock.script(script)
    const r = await parse(page, id, stage)
    const p = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 90000)
    return { r, p, reqs: mock.p1Requests.slice() }
  }
  const recover = async () => { mock.clearScript(); mock.apiKey = SECRET; const r = await parse(page, id, 'ai'); await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing'], 60000); return r }

  // 空 content
  let o = await run('empty×6', [{ type: 'empty', times: 6 }])
  check('故障：空内容', '模型连续返回空 content：先同参数重试、再对半拆小重试，仍不行 → failed，原因是中文提示', o.p.status === 'failed' && /空内容/.test(o.p.error) && bad(o.p.error) && o.p.error_stage === 'parse', `${o.p.error}（${o.reqs.length} 次请求）`)
  // 在队列页看到错误并用界面重试
  await page.evaluate(() => { location.hash = '#/queue' })
  await page.getByText(/需处理/).first().click()
  const errRow = page.locator('tr', { hasText: 'g4-2026-meta.pdf' })
  await errRow.locator('[data-testid=paper-error]').waitFor({ timeout: 10000 })
  const uiErr = await errRow.locator('[data-testid=paper-error]').innerText()
  await page.screenshot({ path: path.join(shots, 'm2-05-queue-failed.png') })
  check('故障：空内容', '队列页展示失败原因（含失败阶段）与「重试」入口', /AI 解析失败：.*空内容/.test(uiErr) && (await errRow.locator('[data-testid=retry-parse]').count()) === 1 && (await errRow.locator('[data-testid=retry-menu]').count()) === 1, uiErr.replace(/\n/g, ' '))
  mock.clearScript()
  await errRow.locator('[data-testid=retry-parse]').click()
  const again = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 60000)
  check('故障：空内容', '点「重试 AI 解析」（不重新提取）后成功，回到待审核', again.status === 'reviewing' && again.error === null)

  o = await run('empty×2', [{ type: 'empty', times: 2 }])
  const halves = o.reqs.filter(r => /已拆小/.test(r.batchLine))
  check('故障：空内容', '空 content 重试一次仍空 → 对半拆小（第 1、2 页各发一批）→ 成功，题目数不变', o.p.status === 'reviewing' && o.reqs.length === 4 && halves.length === 2 && halves[0].pages.join() === '1' && halves[1].pages.join() === '2' && (await getQs(page, id)).questions.length === 36, `请求 ${o.reqs.length} 次：${o.reqs.map(r => r.batchLine.replace(/（全卷.*/, '')).join(' | ')}`)

  // 非法 JSON
  o = await run('badjson×8', [{ type: 'badjson', times: 8 }])
  check('故障：非法 JSON', '模型连续返回非法 JSON → failed，提示「输出不是合法的 JSON」并指出哪一页', o.p.status === 'failed' && /不是合法的 JSON/.test(o.p.error) && /第 1 页/.test(o.p.error) && bad(o.p.error) && !/position|Unterminated|Unexpected/.test(o.p.error), o.p.error)
  // 审核 P1-1：解析失败的试卷再拖进同一个文件，不能被当作「提取失败」删掉（页面、旧题目、审核成果都在）
  const qBeforeRe = (await getQs(page, id)).questions.length
  await dropFiles(page, [metaFile])
  const dupBox = await page.waitForSelector('[data-testid=duplicate-confirm]', { timeout: 10000 }).catch(() => null)
  const dupTxt = dupBox ? await dupBox.innerText() : ''
  await page.getByRole('button', { name: /跳\s*过/ }).click().catch(() => {})
  await sleep(500)
  const stillThere = (await listPapers(page)).filter(p => p.file_name === 'g4-2026-meta.pdf')
  check('P1-1 再导入', '解析失败的试卷再导入同一文件：弹「内容相同」确认并提示去队列重试；原试卷、页面、旧题目都还在，没有被删掉重建',
    !!dupBox && /处理队列/.test(dupTxt) && stillThere.length === 1 && stillThere[0].id === id && stillThere[0].status === 'failed' && (await getQs(page, id)).questions.length === qBeforeRe && qBeforeRe === 36 && (await page.evaluate(i => window.api.papers.pages(i), id)).length === 2,
    `${stillThere.length} 条，${qBeforeRe} 题；${dupTxt.replace(/\n/g, ' ').slice(0, 70)}`)
  // 复审 N7：失败但保留着旧题（含已审核的）的试卷，「重新提取」「从头重试」要先弹确认并说明会清掉多少题
  const q1fail = (await getQs(page, id)).questions[0]
  await page.evaluate(i => window.api.questions.update(i, { reviewed: true }), q1fail.id)
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  // N10（M4 统一入口）：试卷库里失败的卷子和处理队列用同一组重试入口；「从头重试」在下拉里（以前是单独的「重新提取」图标）
  await page.locator('tbody tr').first().locator('[data-testid=retry-menu]').click()
  await page.getByText('从头重试（重新提取文字再解析）').click()
  const dlg1 = await page.waitForSelector('[data-testid=discard-confirm]', { timeout: 8000 }).catch(() => null)
  const dlg1Txt = dlg1 ? await dlg1.innerText() : ''
  await page.getByRole('button', { name: /取\s*消/ }).click().catch(() => {})
  await sleep(600)
  const afterCancel1 = await paperByFile(page, 'g4-2026-meta.pdf')
  check('N7 重新提取确认', '试卷库里对「AI 解析失败但保留着旧题」的试卷点「重新提取」：先弹确认，写明「36 道题、其中 1 道已审核」并提示旧题会丢；取消后什么都没变', !!dlg1 && /36/.test(dlg1Txt) && /其中 1 道已审核/.test(dlg1Txt) && /AI 解析失败/.test(dlg1Txt) && afterCancel1.status === 'failed' && (await getQs(page, id)).questions.length === 36 && (await page.evaluate(i => window.api.papers.pages(i), id)).length === 2, dlg1Txt.replace(/\n/g, ' ').slice(0, 90))
  await page.evaluate(() => { location.hash = '#/queue' })
  await page.getByText(/需处理/).first().click()
  await page.locator('tr', { hasText: 'g4-2026-meta.pdf' }).locator('[data-testid=retry-menu]').click()
  await page.getByText('从头重试（重新提取文字再解析）').click()
  const dlg2 = await page.waitForSelector('[data-testid=discard-confirm]', { timeout: 8000 }).catch(() => null)
  const dlg2Txt = dlg2 ? await dlg2.innerText() : ''
  await page.getByRole('button', { name: /取\s*消/ }).click().catch(() => {})
  await sleep(600)
  check('N7 重新提取确认', '处理队列的「从头重试」同样先确认；取消后试卷仍是 failed、旧题目还在', !!dlg2 && /36/.test(dlg2Txt) && /其中 1 道已审核/.test(dlg2Txt) && (await paperByFile(page, 'g4-2026-meta.pdf')).status === 'failed' && (await getQs(page, id)).questions.length === 36, dlg2Txt.replace(/\n/g, ' ').slice(0, 90))
  await recover()
  o = await run('badjson×1', [{ type: 'badjson', times: 1 }])
  check('故障：非法 JSON', '第一次非法 JSON → 带着错误信息让模型重来一次 → 成功（第二次请求的末尾是反馈消息，共 4 条消息）', o.p.status === 'reviewing' && o.reqs.length === 2 && /不是合法的 JSON/.test(o.reqs[1].retryFeedback) && o.reqs[1].messageCount === 4, `${o.reqs.length} 次；反馈=${o.reqs[1]?.retryFeedback.slice(0, 40)}`)

  // 结构不符
  o = await run('schema×8', [{ type: 'schema', times: 8 }])
  check('故障：结构不符', '模型返回的 JSON 不符合 Schema（难度 9）→ failed，提示具体字段 questions[0].difficulty', o.p.status === 'failed' && /结构不符合要求/.test(o.p.error) && /questions\[0\]\.difficulty/.test(o.p.error) && bad(o.p.error), o.p.error.replace(/\n/g, ' '))
  await recover()
  o = await run('schema×1', [{ type: 'schema', times: 1 }])
  check('故障：结构不符', 'zod 校验失败时带着错误信息重试一次 → 成功', o.p.status === 'reviewing' && o.reqs.length === 2 && /questions\[0\]\.difficulty/.test(o.reqs[1].retryFeedback), `${o.reqs.length} 次`)

  // 429
  o = await run('429×1', [{ type: '429', times: 1, retryAfter: 1 }])
  check('故障：429', '遇到一次 429：按 Retry-After 退避后自动重试成功，用户无感', o.p.status === 'reviewing' && o.reqs.length === 2)
  o = await run('429×10', [{ type: '429', times: 10, retryAfter: 1 }])
  check('故障：429', '429 持续：重试 3 次（共 4 次请求）后 failed，提示「请求太频繁/额度不足（HTTP 429）」', o.p.status === 'failed' && o.reqs.length === 4 && /429/.test(o.p.error) && /太频繁/.test(o.p.error) && bad(o.p.error), o.p.error)
  await recover()
  o = await run('503×1', [{ type: '503', times: 1 }])
  check('故障：5xx', '服务端 503 一次：指数退避后重试成功', o.p.status === 'reviewing' && o.reqs.length === 2)

  // 超时
  await saveCfg(page, cfgFor(mock, { auto_parse: false, timeout_sec: 2 }))
  o = await run('hang×1', [{ type: 'hang', times: 1, ms: 8000 }])
  check('故障：超时', '一次请求挂起超过超时时间：自动重试，成功', o.p.status === 'reviewing' && o.reqs.length === 2)
  o = await run('hang×6', [{ type: 'hang', times: 6, ms: 8000 }])
  check('故障：超时', '持续无响应：重试用尽（4 次）后 failed，提示「模型响应超时」', o.p.status === 'failed' && o.reqs.length === 4 && /超时/.test(o.p.error) && bad(o.p.error), o.p.error)
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))
  await recover()

  // 被截断的批次
  o = await run('truncated×1', [{ type: 'truncated', times: 1 }])
  check('故障：批次被截断', '输出被长度上限截断（finish_reason=length）：不硬解析残缺 JSON，把批次对半拆小重试 → 成功', o.p.status === 'reviewing' && o.reqs.length === 3 && o.reqs[1].pages.join() === '1' && o.reqs[2].pages.join() === '2' && (await getQs(page, id)).questions.length === 36, o.reqs.map(r => r.pages.join('-')).join(' / '))
  o = await run('truncated×10', [{ type: 'truncated', times: 10 }])
  check('故障：批次被截断', '单页也被截断 → failed，提示「输出被长度上限截断」并指明页码', o.p.status === 'failed' && /第 1 页/.test(o.p.error) && /长度上限/.test(o.p.error) && bad(o.p.error), o.p.error)
  await recover()

  // 鉴权失败
  mock.apiKey = 'sk-rotated-by-provider'
  o = await run('401', [])
  check('故障：密钥失效', '服务商返回 401 → failed，提示「API Key 无效或没有权限」，不做无谓重试（只请求 1 次）', o.p.status === 'failed' && /API Key 无效/.test(o.p.error) && o.reqs.length === 1, o.p.error)
  const okAfter = await recover()
  check('故障：密钥失效', '密钥恢复后点重试即成功', okAfter === 'ok')

  // 服务商不支持 response_format
  o = await run('response_format', [{ type: 'bad_response_format', times: 1 }])
  check('故障：参数不兼容', '服务商拒绝 response_format → 自动去掉该参数重试，成功', o.p.status === 'reviewing' && o.reqs.length === 2 && o.reqs[0].jsonMode === true && o.reqs[1].jsonMode === false)
  o = await run('fenced', [{ type: 'fenced', times: 1 }])
  check('故障：围栏 JSON', '模型把 JSON 包在 ```json 围栏里（提示词已禁止，但真实模型偶尔会）：程序能容忍，一次请求即成功', o.p.status === 'reviewing' && o.reqs.length === 1 && (await getQs(page, id)).questions.length === 36)
  // 服务商在 400 里回显密钥：展示给用户、写进库的文案都不能含密钥
  o = await run('400echo', [{ type: '400echo', times: 1 }])
  const leakRows = withDb(ctx.ud, d => ({ pe: d.prepare('SELECT error FROM papers WHERE id = ?').get(id).error, re: d.prepare("SELECT error FROM parse_runs WHERE paper_id = ? ORDER BY id DESC LIMIT 1").get(id).error }))
  check('密钥安全', '服务商 400 响应里回显了密钥：papers.error 与 parse_runs.error 里都已脱敏（审核 P2-2）', o.p.status === 'failed' && !JSON.stringify(leakRows).includes(SECRET) && /已隐藏/.test(o.p.error), o.p.error.slice(0, 120))
  await recover()

  // 题目被批次边界切开
  await saveCfg(page, cfgFor(mock, { auto_parse: false, batch_pages: 1 }))
  mock.splitLast = true
  o = await run('split', [])
  mock.splitLast = false
  const qsSplit = (await getQs(page, id)).questions
  const q25 = qsSplit.find(q => q.no === '25')
  check('跨批合并', '按页分批（每批 1 页）：第 1 批末尾的未完成题带入 PREV_CONTEXT，第 2 批续写，合并为完整的一条（36 题而非 37）',
    o.p.status === 'reviewing' && o.reqs.length === 2 && o.reqs[1].hasPrevUnfinished && /未完成的题：section=四；no=25；page=1/.test(o.reqs[1].user) && qsSplit.length === 36 && q25.stem === "—What's the weather like? —____" && q25.page_idx === 1 && q25.bbox && !q25.flags.includes('stem_incomplete'),
    `请求 ${o.reqs.length} 次；Q25=${q25?.stem}`)
  check('跨批合并', '材料 id 前缀按批次区分（b1-、b2-），续写题沿用上一批的材料 id', o.reqs[0].prefix === 'b1' && o.reqs[1].prefix === 'b2' && q25.material_id === 'b1-m1' && qsSplit.find(q => q.no === '26').material_id === 'b2-m1')
  // 审核 P1-4：真实模型会犯的错——续写时漏设 continued_from_prev
  mock.splitLast = true
  mock.quirks = { noFlag: true }
  o = await run('split-noflag', [])
  const qsNoFlag = (await getQs(page, id))
  const q25b = qsNoFlag.questions.find(q => q.no === '25')
  check('跨批合并', '模型漏设 continued_from_prev：仍按续写合并（完整的后半不被丢弃），36 题、Q25 题干完整，并在 AI 备注里提示老师核对',
    o.p.status === 'reviewing' && qsNoFlag.questions.length === 36 && q25b.stem === "—What's the weather like? —____" && !q25b.flags.includes('stem_incomplete') && qsNoFlag.notes.some(n => /没有标注续写/.test(n)),
    `题数=${qsNoFlag.questions.length} Q25=${q25b?.stem} 备注=${qsNoFlag.notes.join('|').slice(0, 60)}`)
  // 后一批干脆没有给出续写的那条：残缺题（不是最后一题）必须被标出来、标黄
  mock.quirks = { dropContinued: true }
  o = await run('split-dropped', [])
  const qsDrop = (await getQs(page, id))
  const q25c = qsDrop.questions.find(q => q.no === '25')
  check('跨批合并', '残缺的跨批题没被续上：即使它不是最后一题，也标 stem_incomplete 并降低置信度（审核页标黄），不再静默当作完整题',
    qsDrop.questions.length === 36 && q25c.flags.includes('stem_incomplete') && q25c.confidence < qsDrop.lowConfidence && qsDrop.questions.at(-1).no === '36' && !qsDrop.questions.at(-1).flags.includes('stem_incomplete'),
    `Q25 flags=${q25c?.flags} 置信度=${q25c?.confidence}`)
  mock.splitLast = false
  mock.quirks = {}
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))
  // anchor 带 OCR 式错字 → 模糊匹配仍能定位；页码写错 → 仍能找到真实位置
  mock.quirks = { typo: true }
  o = await run('typo', [])
  const qsTypo = (await getQs(page, id)).questions
  check('定位容错', 'anchor 里夹了错字（模型照抄 OCR 错误/手滑）：模糊匹配仍定位成功，并标 locate_fuzzy 供老师抽查',
    o.p.status === 'reviewing' && qsTypo.filter(q => q.bbox).length >= 34 && qsTypo.filter(q => q.flags.includes('locate_fuzzy')).length >= 10, `有框 ${qsTypo.filter(q => q.bbox).length}/36，模糊 ${qsTypo.filter(q => q.flags.includes('locate_fuzzy')).length}`)
  mock.quirks = { badPage: true }
  o = await run('badpage', [])
  const qsBad = (await getQs(page, id)).questions
  check('定位容错', '模型把页码写错（超出本批范围）：仍能按 anchor 找到真实页码与位置（Q1 在第 1 页，Q36 在第 2 页，全部有框）',
    o.p.status === 'reviewing' && qsBad.every(q => q.bbox) && qsBad.find(q => q.no === '1').page_idx === 1 && qsBad.find(q => q.no === '36').page_idx === 2, `有框 ${qsBad.filter(q => q.bbox).length}/36`)
  mock.quirks = {}
  mock.clearScript()
  await parse(page, id, 'ai')
  await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing'], 60000)
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))

  // 分阶段重试
  const qlBefore = await getQs(page, id)
  const idsBefore = qlBefore.questions.map(q => q.id)
  const runBeforeLoc = qlBefore.run
  mock.resetStats()
  await parse(page, id, 'locate')
  const locP = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 30000)
  const idsLoc = (await getQs(page, id)).questions.map(q => q.id)
  check('分阶段重试', '「仅重新定位」沿用上次 AI 结果：不再请求模型，题目重新生成，仍是 36 题', locP.status === 'reviewing' && p1count() === 0 && idsLoc.length === 36 && idsLoc[0] !== idsBefore[0], `请求 ${p1count()} 次`)
  const runAfterLoc = (await getQs(page, id)).run
  check('分阶段重试', '「仅重新定位」不改动被复用的那条解析记录：它仍是同一条、状态仍是 done，审核页顶栏的提示词版本不会因此丢失或错位（复审 N4）', runAfterLoc?.status === 'done' && runAfterLoc.id === runBeforeLoc?.id && !!runAfterLoc.prompt_version, JSON.stringify(runAfterLoc))
  mock.resetStats()
  await parse(page, id, 'ai')
  await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 30000)
  check('分阶段重试', '「重新 AI 解析」重新请求模型（不重新提取）', p1count() === 1)
  const exBefore = (await paperByFile(page, 'g4-2026-meta.pdf')).extracted_at
  await sleep(1100)
  mock.resetStats()
  await parse(page, id, 'extract')
  await waitFor(async () => (await paperByFile(page, 'g4-2026-meta.pdf')).status === 'extracting' || (await paperByFile(page, 'g4-2026-meta.pdf')).status === 'imported', 5000)
  const midQs = await getQs(page, id)
  check('分阶段重试', '「从头重试」：重新提取时旧页面与旧题目一并清掉（不留指向旧页面的题目）', midQs.questions.length === 0)
  const fin = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 90000)
  check('分阶段重试', '「从头重试」即使关了自动解析也会在提取后接着解析，最终回到待审核且 extracted_at 更新', fin.status === 'reviewing' && fin.extracted_at !== exBefore && p1count() === 1 && (await getQs(page, id)).questions.length === 36, `${exBefore} → ${fin.extracted_at}`)

  // 取消
  mock.delayMs = 5000
  mock.resetStats()
  await parse(page, id, 'ai')
  await waitStatus(page, 'g4-2026-meta.pdf', ['parsing'], 10000)
  await waitFor(() => mock.requests.length >= 1, 10000)
  await page.evaluate(i => window.api.parse.cancel(i), id)
  const canc = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed', 'extracted'], 15000)
  mock.delayMs = 0
  check('取消', '解析中取消：回到开始前的状态（待审核，旧题目保留），不算失败', canc.status === 'reviewing' && canc.error === null && (await getQs(page, id)).questions.length === 36, canc.status)
  const listAfterCancel = await getQs(page, id)
  check('审核页', '取消/失败的运行不会成为审核页顶栏显示的「解析记录」：取最近一次成功的，提示词版本与试卷记录一致（审核 P2-8）', listAfterCancel.run?.status === 'done' && listAfterCancel.run.prompt_version === canc.prompt_version, JSON.stringify(listAfterCancel.run).slice(0, 100))
  // 取消后 parse_runs 留痕
  withDb(ctx.ud, d => {
    const runs = d.prepare('SELECT status, COUNT(*) n FROM parse_runs WHERE paper_id = ? GROUP BY status').all(id)
    check('解析记录', 'parse_runs 记录每次解析（done / failed / cancelled / superseded 等），可追溯', runs.some(r => r.status === 'done') && runs.some(r => r.status === 'failed') && runs.some(r => r.status === 'cancelled'), runs.map(r => `${r.status}×${r.n}`).join(' '))
  })
}


// ───────────────────────── 阶段 4：视觉版（OCR 不可用的应用副本）─────────────────────────
async function phaseVision() {
  const { mock } = ctx
  await ctx.app.close()
  const noOcrApp = path.join(work, 'app-no-ocr')
  fs.mkdirSync(noOcrApp, { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(noOcrApp, 'package.json'))
  fs.cpSync(path.join(root, 'out'), path.join(noOcrApp, 'out'), { recursive: true })
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(noOcrApp, 'node_modules'), 'junction')
  const ud3 = path.join(work, 'userData-vision')
  const r = await launch({ appDir: noOcrApp, userDataDir: ud3 })
  const { page, app } = r
  mock.apiKey = SECRET
  mock.resetStats()
  await saveCfg(page, cfgFor(mock, { vision_model: '' }), SECRET)
  await dropFiles(page, [png1])
  const f1 = await waitStatus(page, 'g4-2025-page1.png', ['failed', 'reviewing'], 60000)
  check('视觉版', 'OCR 失败的页面 + 没配视觉模型：failed，提示需要视觉模型并指明页码，没有请求 AI', f1?.status === 'failed' && /第 1 页/.test(f1.error) && /视觉模型/.test(f1.error) && p1count() === 0, f1?.error)
  const pg = await page.evaluate(i => window.api.papers.pages(i), f1.id)
  check('视觉版', '该页确实是 OCR 失败（text_source=ocr_failed），页面图片仍保存', pg[0].text_source === 'ocr_failed' && !!pg[0].image_rel)

  await saveCfg(page, cfgFor(mock))
  mock.resetStats()
  check('视觉版', '补上视觉模型后点重试', (await parse(page, f1.id, 'ai')) === 'ok')
  const v = await waitStatus(page, 'g4-2025-page1.png', ['reviewing', 'failed'], 60000)
  const rq = mock.p1Requests[0]
  const visSys = docsPrompt('p1_vision', 'system')
  check('视觉版', '请求走视觉模型：用视觉版 system 提示词、页面图片以 data URL 的 image_url 发送、user 里有「共 1 张图，依次为试卷第 1 页」',
    v.status === 'reviewing' && mock.p1Requests.length === 1 && rq.model === 'mock-vision-model' && rq.system === visSys && rq.images === 1 && /^data:image\/(png|jpeg);base64/.test(rq.imageUrls[0]) && rq.user.includes('共 1 张图，依次为试卷第 1 页') && !rq.user.includes('【OCR 文本】'),
    `${v.status} ${rq?.model} images=${rq?.images}`)
  const dim = rq.imageDims[0]
  check('视觉版', '页面图过大时先缩小再发：g4-2025-page1.png 是 1190×1684，发给模型的是长边 1600 的 JPEG（体积小很多），归一化 bbox 不受影响', dim.type === 'jpeg' && Math.max(dim.w, dim.h) === 1600 && Math.abs(dim.w / dim.h - 1190 / 1684) < 0.01, JSON.stringify(dim))
  withDb(ud3, d => {
    const qs = d.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY ord').all(f1.id)
    const orphan = d.prepare(`SELECT COUNT(*) c FROM question_kps qk JOIN questions q ON q.id = qk.question_id LEFT JOIN kps k ON k.code = qk.kp_code WHERE q.paper_id = ? AND k.code IS NULL`).get(f1.id).c
    check('视觉版', '25 道题入库，bbox 全部来自视觉模型（bbox_source=vision），知识点都在树里', qs.length === 25 && qs.every(q => q.bbox_source === 'vision' && q.bbox_json && q.page_idx === 1) && orphan === 0, `${qs.length} 题`)
    const p = d.prepare('SELECT * FROM papers WHERE id = ?').get(f1.id)
    check('提示词版本', '记录用的模型（仅视觉模型）与提示词版本', p.ai_model === 'mock-vision-model' && p.prompt_version === ctx.pv, `${p.ai_model} / ${p.prompt_version}`)
  })

  // 用真实 OCR 反向验证视觉 bbox
  const png = path.join(ud3, 'workbench-data', 'files', f1.id, 'page-1.png')
  const sq = s => s.replace(/\s+/g, '').toLowerCase()
  const cases = [[2, ['sheep'], ['skirt']], [6, ['artroom'], ['whattime']], [12, ['lookatthesheep'], ['wherearemy']], [13, ["it's6:30", 'getup'], ['wherearemy']]]
  const details = []
  let ok = true
  for (const [n, must, mustNot] of cases) {
    const box = withDb(ud3, d => JSON.parse(d.prepare('SELECT bbox_json FROM questions WHERE paper_id = ? AND no_label = ?').get(f1.id, String(n)).bbox_json))
    const out = await cropPage(app, png, box, path.join(cropDir, `v${n}.png`), 0.002)
    const txt = sq(ocrText(out))
    const good = must.every(w => txt.includes(sq(w))) && mustNot.every(w => !txt.includes(sq(w)))
    if (!good) ok = false
    details.push(`Q${n}${good ? '✓' : '✗(' + txt.slice(0, 40) + ')'}`)
  }
  for (const n of [2, 6, 13]) fs.copyFileSync(path.join(cropDir, `v${n}.png`), path.join(shots, `m2-crop-vision-q${n}.png`))
  check('bbox 位置', '视觉版 bbox 同样经页面图裁剪 + 真实 OCR 验证：框里是本题、不含下一题', ok, details.join(' '))

  // 审核页截图（视觉版，带框）
  await page.evaluate(i => { location.hash = '#/review/' + i }, f1.id)
  await page.waitForSelector('[data-testid=bbox-current]', { timeout: 15000 })
  await page.locator('[data-testid=q-item]').nth(5).click()
  await page.waitForFunction(() => /第 6 题/.test(document.querySelector('[data-testid=form-title]')?.textContent || ''))
  await sleep(700)
  await page.screenshot({ path: path.join(shots, 'm2-09-review-vision.png') })
  await app.close()
  mock.resetStats()
  // 回到主应用
  const main = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, main)
}

// ───────────────────────── 阶段 5：提示词管理 ─────────────────────────
async function phasePrompts() {
  const { page, mock } = ctx
  const id = ctx.metaId
  mock.apiKey = SECRET
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))
  await page.evaluate(() => { location.hash = '#/settings' })
  await page.waitForSelector('[data-testid=prompt-settings]')
  await page.getByText('P1 解析（文本版）').first().click()
  const ta = page.locator('[data-testid=prompt-text-p1_text-system]')
  await ta.waitFor()
  const def = await ta.inputValue()
  check('提示词管理', '设置页能看到内置 P1 文本版 system 提示词，标记为「内置默认」', def.startsWith('你是一名资深的小学英语教研员') && (await page.locator('[data-testid=prompt-p1_text-system]').innerText()).includes('内置默认'))
  const MARK = '【E2E自定义标记：回答请保持简洁】'
  await ta.fill(def + '\n' + MARK)
  await page.locator('[data-testid=prompt-save-p1_text-system]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=prompt-p1_text-system]')?.innerText.includes('已自定义'))
  await page.screenshot({ path: path.join(shots, 'm2-10-settings-prompts.png') })
  mock.resetStats()
  await parse(page, id, 'ai')
  const p1 = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 60000)
  const req = mock.p1Requests[0]
  check('提示词管理', '改写后的 system 提示词下次解析就用上，并记录版本为「<版本>+自定义·哈希」', p1.status === 'reviewing' && req.system.endsWith(MARK) && new RegExp(`^${ctx.pv.replace('.', '\\.')}\\+自定义·[0-9a-f]{6}$`).test(p1.prompt_version), p1.prompt_version)
  await page.locator('[data-testid=prompt-reset-p1_text-system]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=prompt-p1_text-system]')?.innerText.includes('内置默认'))
  check('提示词管理', '「恢复默认」后文本回到内置版本', (await ta.inputValue()) === def)
  mock.resetStats()
  await parse(page, id, 'ai')
  const p2 = await waitStatus(page, 'g4-2026-meta.pdf', ['reviewing', 'failed'], 60000)
  check('提示词管理', '恢复默认后再解析：system 回到内置文本，版本记回内置版本', p2.prompt_version === ctx.pv && !mock.p1Requests[0].system.includes(MARK) && mock.p1Requests[0].system === def)
  const rej = await page.evaluate(() => window.api.ai.savePrompt('p1_text', 'user', '只有一句话，没有任何占位符').then(() => 'ok', e => String(e)))
  check('提示词管理', '缺少必需占位符（{{OCR_TEXT}} 等）的 user 提示词被拒绝保存，并说明缺哪个', /缺少必需的占位符/.test(rej) && /OCR_TEXT/.test(rej), clean(rej).slice(0, 80))
  const noJson = await page.evaluate(() => window.api.ai.savePrompt('p1_text', 'system', '你是一名教研员。请把试卷拆成题目并标注知识点。').then(() => 'ok', e => String(e)))
  check('提示词管理', 'P1 的 system 提示词里去掉「JSON」字样的修改被拒绝（服务商的 JSON 模式要求提示词里提到 json）', /JSON/.test(noJson) && !/^ok/.test(noJson), clean(noJson).slice(0, 60))
  const views = await page.evaluate(async () => {
    const base = (await window.api.ai.prompts()).items.find(i => i.id === 'p1_text' && i.part === 'user').defaultText
    await window.api.ai.savePrompt('p1_text', 'user', base + '\n{{FOO_BAR}}')
    const v = (await window.api.ai.prompts()).items.find(i => i.id === 'p1_text' && i.part === 'user')
    await window.api.ai.resetPrompt('p1_text', 'user')
    return v
  })
  check('提示词管理', '提示词里拼错的 {{占位符}} 会被标出来', views.unknownPlaceholders.join() === 'FOO_BAR' && views.isCustom)
}


// ───────────────────────── 阶段 6：审核页（三栏、快捷键、框拖拽、编辑持久化、拆分合并、采纳建议、整份确认）─────────────────────────
async function phaseReview() {
  let { page, app } = ctx
  const id = ctx.p26.id
  const title = () => page.locator('[data-testid=form-title]').innerText()
  const items = () => page.locator('[data-testid=q-item]')
  const dbq = n => withDb(ctx.ud, d => d.prepare('SELECT * FROM questions WHERE paper_id = ? AND no_label = ?').get(id, String(n)))
  const selectQ = async n => {
    await items().nth(n - 1).click()
    await page.waitForFunction(t => new RegExp(`第 ${t} 题`).test(document.querySelector('[data-testid=form-title]')?.textContent || ''), n)
  }

  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  await page.evaluate(i => { location.hash = '#/review/' + i }, id)
  await page.waitForSelector('[data-testid=q-item]', { timeout: 15000 })
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=page-image]'); return i && i.complete && i.naturalWidth > 0 })
  await sleep(600)
  const n = await items().count()
  const warnIdx = await page.$$eval('[data-testid=q-item]', els => els.map((e, i) => (e.getAttribute('data-warn') === '1' ? i + 1 : 0)).filter(Boolean))
  check('审核页', '三栏布局：左侧列出 36 道题；低置信度/有待处理建议的题标黄（Q22 有新增知识点建议、Q30 知识点代码无效）', n === 36 && warnIdx.join() === '22,30', `题数 ${n}，标黄 ${warnIdx}`)
  const bg = await page.$$eval('[data-testid=q-item]', els => [els[0], els[21]].map(e => getComputedStyle(e).backgroundColor))
  check('审核页', '标黄的题背景是黄色（rgb(255, 251, 230)），普通题不是', bg[1].includes('255, 251, 230') || bg[1].includes('255, 241, 184'), bg.join(' | '))
  check('审核页', '默认选中第一道待确认的题，右侧表单显示它的标注', /第 1 题/.test(await title()))
  await page.screenshot({ path: path.join(shots, 'm2-06-review.png') })

  // bbox 叠加位置：叠加层矩形与数据库里的归一化 bbox 在图片上一致
  const geo = await page.evaluate(() => {
    const b = document.querySelector('[data-testid=bbox-current]').getBoundingClientRect()
    const i = document.querySelector('[data-testid=page-image]').getBoundingClientRect()
    return { bx: (b.left - i.left) / i.width, by: (b.top - i.top) / i.height, bw: b.width / i.width, bh: b.height / i.height }
  })
  const q1 = JSON.parse(dbq(1).bbox_json)
  const close = (a, b) => Math.abs(a - b) < 0.006
  check('审核页', '中间栏：当前题的框叠在原卷页面上，位置/大小与库里的 bbox 一致（误差 < 0.6%）', close(geo.bx, q1[0]) && close(geo.by, q1[1]) && close(geo.bw, q1[2]) && close(geo.bh, q1[3]), `屏幕 ${[geo.bx, geo.by, geo.bw, geo.bh].map(v => v.toFixed(3))} 库 ${q1}`)

  // 快捷键
  await page.keyboard.press('j')
  const t2 = await title()
  await page.keyboard.press('j')
  const t3 = await title()
  await page.keyboard.press('k')
  const t2b = await title()
  check('审核页', '快捷键：J 下一题、K 上一题', /第 2 题/.test(t2) && /第 3 题/.test(t3) && /第 2 题/.test(t2b), `${t2} → ${t3} → ${t2b}`)
  await page.keyboard.press('k')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-testid=q-item]').getAttribute('data-reviewed') === '1')
  await page.waitForFunction(() => /第 2 题/.test(document.querySelector('[data-testid=form-title]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {})
  const afterEnter = await title()
  await sleep(500)
  check('审核页', 'Enter 确认当前题并跳到下一题；确认状态写入数据库', /第 2 题/.test(afterEnter) && dbq(1).reviewed === 1, afterEnter)

  // 左栏筛选 / 侧栏自动收起 / 翻页与滚动 / 其他题的框 / 材料折叠 / 缩放
  const siderW = (await page.locator('.ant-layout-sider').boundingBox()).width
  check('审核页', '进入审核页后主侧栏自动收起（给原卷页面让位）', siderW < 100, `${Math.round(siderW)}px`)
  await page.getByText(/需关注 \d+/).first().click()
  const nAttn = await items().count()
  await page.getByText(/待确认 \d+/).first().click()
  const nTodo = await items().count()
  await page.getByText(/全部 \d+/).first().click()
  check('审核页', '左栏筛选：「需关注」只剩 2 题（Q22、Q30），「待确认」= 36 − 已确认 1 = 35，「全部」36', nAttn === 2 && nTodo === 35 && (await items().count()) === 36, `需关注 ${nAttn} / 待确认 ${nTodo}`)
  await selectQ(26)
  await page.waitForFunction(() => /第 2 \/ 2 页/.test(document.querySelector('[data-testid=page-indicator]')?.textContent || ''))
  await page.locator('[data-testid=question-form] .ant-collapse-header').first().click()
  await sleep(400)
  const matTxt = await page.locator('[data-testid=question-form] .ant-collapse').first().innerText()
  check('审核页', '选中第 26 题：中栏自动翻到第 2 页；表单里可展开它引用的阅读短文', /Hi, I'm Amy/.test(matTxt))
  const dashed = await page.locator('[data-testid=page-canvas] > div[title^="第"]').count()
  await page.locator('input[type=checkbox]').first().uncheck()
  const dashedOff = await page.locator('[data-testid=page-canvas] > div[title^="第"]').count()
  await page.locator('input[type=checkbox]').first().check()
  check('审核页', '「显示其他题的框」：本页其他题的虚线框可显示/隐藏', dashed >= 8 && dashedOff === 0, `${dashed} → ${dashedOff}`)
  await selectQ(36)
  await sleep(1500)
  const vis = await page.evaluate(() => { const b = document.querySelector('[data-testid=bbox-current]').getBoundingClientRect(); const c = document.querySelector('[data-testid=page-scroll]').getBoundingClientRect(); return b.top >= c.top - 1 && b.bottom <= c.bottom + 1 })
  check('审核页', '选中靠页面底部的第 36 题：框被自动滚进中栏可视区域', vis)
  const wFit = (await page.locator('[data-testid=page-canvas]').boundingBox()).width
  await page.getByText('150%', { exact: true }).click()
  await sleep(300)
  const w150 = (await page.locator('[data-testid=page-canvas]').boundingBox()).width
  await page.getByText('200%', { exact: true }).click()
  await sleep(300)
  const w200 = (await page.locator('[data-testid=page-canvas]').boundingBox()).width
  const box200 = await page.evaluate(() => { const b = document.querySelector('[data-testid=bbox-current]').getBoundingClientRect(); const i = document.querySelector('[data-testid=page-image]').getBoundingClientRect(); return { rx: (b.left - i.left) / i.width, w: b.width / i.width } })
  await page.getByText('适应宽度', { exact: true }).click()
  await sleep(300)
  check('审核页', '缩放 150% / 200%：页面按比例放大，框仍按归一化坐标贴在原位', w150 / wFit > 1.3 && w200 / w150 > 1.2 && box200.rx > 0 && box200.w > 0, `${Math.round(wFit)} → ${Math.round(w150)} → ${Math.round(w200)}`)
  await selectQ(9)

  // 编辑 Q9：题干 / 难度 / 题型 / 主知识点 / 易错原因；输入框里敲 j、k 不能切题
  await selectQ(9)
  const stem = page.locator('[data-testid=f-stem]')
  await stem.fill('Tom ____ a big farm. (E2E 改过) jk')
  check('审核页', '在输入框里敲 j / k 只是输入文字，不会切换题目', /第 9 题/.test(await title()))
  await page.locator('[data-testid=f-difficulty] li.ant-rate-star').nth(4).click()
  await page.locator('[data-testid=f-qtype]').click()
  await page.keyboard.type('FILL')
  await page.locator('.ant-select-item-option', { hasText: '填空（FILL）' }).first().click()
  await page.locator('[data-testid=f-kp-main]').click()
  await page.keyboard.type('不规则动词过去式')
  await page.locator('.ant-select-tree-node-content-wrapper', { hasText: '不规则动词过去式' }).first().click()
  await page.locator('[data-testid=f-error-reason]').fill('E2E：has 的第三人称')
  await sleep(1300)
  const q9 = dbq(9)
  const q9k = withDb(ctx.ud, d => d.prepare('SELECT kp_code, is_primary FROM question_kps WHERE question_id = ?').all(q9.id))
  check('审核页', '右侧编辑（题干、难度、题型、主知识点、易错原因）自动保存到数据库，并标记为已编辑',
    q9.stem.startsWith('Tom ____ a big farm. (E2E 改过)') && q9.difficulty === 5 && q9.qtype === 'FILL' && q9k.find(k => k.is_primary)?.kp_code === 'GR.TENSE.PAST.IRREG' && q9.error_reason === 'E2E：has 的第三人称' && q9.edited === 1,
    `${q9.difficulty} ${q9.qtype} ${JSON.stringify(q9k)}`)
  check('审核页', '难度旁标注「估计」（不是学生得分统计）', (await page.locator('[data-testid=question-form]').innerText()).includes('估计'))

  // 拖动框：移动 + 缩放
  await page.locator('[data-testid=bbox-current]').scrollIntoViewIfNeeded()
  const before = JSON.parse(q9.bbox_json)
  const imgW = (await stableBox(page.locator('[data-testid=page-image]'))).width
  let bb = await stableBox(page.locator('[data-testid=bbox-current]'))
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.down()
  await page.mouse.move(bb.x + bb.width / 2 + 25, bb.y + bb.height / 2 + 5, { steps: 4 })
  await page.mouse.move(bb.x + bb.width / 2 + 50, bb.y + bb.height / 2 + 10, { steps: 4 })
  await page.mouse.up()
  await sleep(1200)
  const moved = JSON.parse(dbq(9).bbox_json)
  check('审核页', '拖动框：松手后新位置写入数据库（右移约 50px ≈ 图宽的比例），来源标为 manual', Math.abs((moved[0] - before[0]) - 50 / imgW) < 0.008 && dbq(9).bbox_source === 'manual' && close(moved[2], before[2]), `${before} → ${moved}`)
  bb = await stableBox(page.locator('[data-testid=bbox-current]'))
  const se = await stableBox(page.locator('[data-testid=box-handle-se]'))
  await page.mouse.move(se.x + 5, se.y + 5)
  await page.mouse.down()
  await page.mouse.move(se.x + 25, se.y + 15, { steps: 5 })
  await page.mouse.up()
  await sleep(1200)
  let resized = JSON.parse(dbq(9).bbox_json)
  check('审核页', '拖右下角手柄缩放：宽高增大且左上角不动', resized[2] > moved[2] + 0.01 && resized[3] > moved[3] + 0.003 && close(resized[0], moved[0]) && close(resized[1], moved[1]), `${moved} → ${resized}`)
  // 其余 7 个手柄：逐个拖一下，核对方向
  const dragHandle = async (mode, dx, dy) => {
    const before = JSON.parse(dbq(9).bbox_json)
    const h = await stableBox(page.locator(`[data-testid=box-handle-${mode}]`))
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2 + dx / 2, h.y + h.height / 2 + dy / 2, { steps: 3 })
    await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 3 })
    await page.mouse.up()
    await sleep(900)
    return [before, JSON.parse(dbq(9).bbox_json)]
  }
  const gt = (a, b) => a > b + 0.004, lt = (a, b) => a < b - 0.004, same = (a, b) => Math.abs(a - b) <= 0.004
  const dirs = []
  let [b0, b1] = await dragHandle('n', 0, -8);  dirs.push(['n', lt(b1[1], b0[1]) && gt(b1[3], b0[3]) && same(b1[0], b0[0]) && same(b1[2], b0[2])])
  ;[b0, b1] = await dragHandle('s', 0, 8);   dirs.push(['s', gt(b1[3], b0[3]) && same(b1[1], b0[1]) && same(b1[0], b0[0])])
  ;[b0, b1] = await dragHandle('e', 12, 0);  dirs.push(['e', gt(b1[2], b0[2]) && same(b1[0], b0[0]) && same(b1[3], b0[3])])
  ;[b0, b1] = await dragHandle('w', -12, 0); dirs.push(['w', lt(b1[0], b0[0]) && gt(b1[2], b0[2]) && same(b1[1], b0[1])])
  ;[b0, b1] = await dragHandle('nw', -10, -8); dirs.push(['nw', lt(b1[0], b0[0]) && lt(b1[1], b0[1]) && gt(b1[2], b0[2]) && gt(b1[3], b0[3])])
  ;[b0, b1] = await dragHandle('ne', 10, -8);  dirs.push(['ne', gt(b1[2], b0[2]) && lt(b1[1], b0[1]) && gt(b1[3], b0[3]) && same(b1[0], b0[0])])
  ;[b0, b1] = await dragHandle('sw', -10, 8);  dirs.push(['sw', lt(b1[0], b0[0]) && gt(b1[3], b0[3]) && gt(b1[2], b0[2]) && same(b1[1], b0[1])])
  check('审核页', '8 个缩放手柄（n/s/e/w/nw/ne/sw + 之前验证的 se）逐个真实拖动，方向与另一侧边不动均正确', dirs.every(d => d[1]), dirs.map(d => `${d[0]}${d[1] ? '✓' : '✗'}`).join(' '))
  resized = JSON.parse(dbq(9).bbox_json)
  await page.screenshot({ path: path.join(shots, 'm2-07-review-bbox-drag.png') })

  // 关掉应用再打开：改动都在
  await page.waitForTimeout(300)
  await app.close()
  const re = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, re); page = re.page; app = re.app
  await page.evaluate(i => { location.hash = '#/review/' + i }, id)
  await page.waitForSelector('[data-testid=q-item]', { timeout: 15000 })
  await selectQ(9)
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=page-image]'); return i && i.complete && i.naturalWidth > 0 })
  const shown = {
    stem: await page.locator('[data-testid=f-stem]').inputValue(),
    reason: await page.locator('[data-testid=f-error-reason]').inputValue(),
    attr: await page.locator('[data-testid=bbox-current]').getAttribute('data-bbox'),
    reviewed1: await items().first().getAttribute('data-reviewed')
  }
  check('审核页', '重启应用后重新打开审核页：题干、易错原因、拖动后的框、确认状态都还在', shown.stem.startsWith('Tom ____ a big farm. (E2E 改过)') && shown.reason === 'E2E：has 的第三人称' && shown.attr === resized.join(',') && shown.reviewed1 === '1', JSON.stringify(shown).slice(0, 160))

  // 拆分 / 合并
  await selectQ(10)
  const stem10 = await page.locator('[data-testid=f-stem]').inputValue()
  await page.locator('[data-testid=split-q]').click()
  await page.locator('[data-testid=split-first-stem]').fill(stem10)
  await page.locator('[data-testid=split-second-stem]').fill('E2E 拆出来的新题干')
  await page.locator('[data-testid=split-ok]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=q-item]').length === 37)
  await page.waitForFunction(() => /第 11 题/.test(document.querySelector('[data-testid=form-title]')?.textContent || ''))
  const splitInfo = withDb(ctx.ud, d => ({
    n: d.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(id).c,
    row: d.prepare("SELECT ord, no_label, stem FROM questions WHERE paper_id = ? AND stem = 'E2E 拆出来的新题干'").get(id),
    ords: d.prepare('SELECT ord FROM questions WHERE paper_id = ? ORDER BY ord').all(id).map(r => r.ord),
    kps: d.prepare("SELECT COUNT(*) c FROM question_kps qk JOIN questions q ON q.id = qk.question_id WHERE q.paper_id = ? AND q.stem = 'E2E 拆出来的新题干'").get(id).c
  }))
  check('审核页', '拆分：一题变两题（紧跟在原题之后），序号连续，新题沿用知识点', splitInfo.n === 37 && splitInfo.row?.ord === 11 && splitInfo.ords.every((o, i) => o === i + 1) && splitInfo.kps >= 1, JSON.stringify(splitInfo.row))
  // 合并回去：选中拆分前的原题（第 10 题），与它的下一题（刚拆出来的那道）合并，应当恢复原状
  const opts10Before = withDb(ctx.ud, d => JSON.parse(d.prepare("SELECT options FROM questions WHERE paper_id = ? AND no_label = '10'").get(id).options))
  await selectQ(10)
  // 双击：第二下发生在第一次合并还没做完时（按钮此时被禁用），不能把后面的第 11 题也并进来（合并不可撤销）
  await page.locator('[data-testid=merge-q]').dblclick()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=q-item]').length === 36)
  await sleep(1200)
  const mergedStem = stem10 + '\nE2E 拆出来的新题干'
  const mergeInfo = withDb(ctx.ud, d => ({ n: d.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(id).c, row: d.prepare("SELECT stem, options, ord FROM questions WHERE paper_id = ? AND no_label = '10'").get(id), ords: d.prepare('SELECT ord FROM questions WHERE paper_id = ? ORDER BY ord').all(id).map(r => r.ord), q11: d.prepare("SELECT stem FROM questions WHERE paper_id = ? AND no_label = '11'").get(id)?.stem }))
  check('审核页', '合并（连点两下也只合并一次，复审 N8）：把拆开的两题合并回去 → 回到 36 题、序号连续，题干 = 原题干 + 换行 + 被合并题干，选项与原题一致，第 11 题没被动',
    mergeInfo.n === 36 && mergeInfo.row.stem === mergedStem && JSON.stringify(JSON.parse(mergeInfo.row.options)) === JSON.stringify(opts10Before) && mergeInfo.ords.every((o, i) => o === i + 1) && /How much/.test(mergeInfo.q11 || ''), JSON.stringify(mergeInfo.row).slice(0, 100))
  // 审核 P1-3：合并后右侧表单要显示合并后的内容（而不是合并前的旧草稿），随后改选项也不会把旧选项写回库
  const formStem = await page.locator('[data-testid=f-stem]').inputValue()
  const formOpts = await page.locator('[data-testid^=f-option-]').count()
  await page.locator('[data-testid=f-option-0]').fill('A. E2E-改过的选项')
  await sleep(1200)
  const afterOpt = withDb(ctx.ud, d => JSON.parse(d.prepare("SELECT options FROM questions WHERE paper_id = ? AND no_label = '10'").get(id).options))
  check('P1-3 合并后表单', '合并后表单立即显示合并后的题干与选项；再改一个选项，库里只有这一项变，其余选项没有被旧草稿覆盖', formStem === mergedStem && formOpts === opts10Before.length && afterOpt.length === opts10Before.length && afterOpt[0] === 'A. E2E-改过的选项' && afterOpt[1] === opts10Before[1], `表单题干=${formStem.slice(0, 30)}… 选项数=${formOpts}`)

  // kp_suggestion：采纳 / 忽略
  const kpBefore = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM kps').get().c)
  await selectQ(22)
  await page.screenshot({ path: path.join(shots, 'm2-08-review-suggestion.png') })
  check('审核页', '有新增知识点建议的题：右侧显示「AI 建议新增知识点」和采纳/忽略，并说明不会自动改树', (await page.locator('[data-testid=kp-suggestion]').innerText()).includes('购物：尺码询问') && (await page.locator('[data-testid=kp-suggestion]').innerText()).includes('不会被自动修改'))
  await page.locator('[data-testid=kp-approve]').click()
  const nameInit = await page.locator('[data-testid=kp-approve-name]').inputValue()
  await page.locator('[data-testid=kp-approve-ok]').click()
  await page.waitForFunction(() => /已采纳/.test(document.querySelector('[data-testid=kp-suggestion]')?.textContent || ''), null, { timeout: 10000 })
  withDb(ctx.ud, d => {
    const node = d.prepare("SELECT * FROM kps WHERE name = '购物：尺码询问'").get()
    const links = d.prepare("SELECT kp_code, is_primary FROM question_kps qk JOIN questions q ON q.id = qk.question_id WHERE q.paper_id = ? AND q.no_label = '22'").all(id)
    const after = d.prepare('SELECT COUNT(*) c FROM kps').get().c
    check('kp_suggestion', '采纳（老师点击）才在树里新建节点：挂在 FN.SHOP 下、builtin=0；本题主知识点换成新节点，原主知识点降为次知识点；建议状态变 approved',
      nameInit === '购物：尺码询问' && node && node.parent_code === 'FN.SHOP' && node.level === 3 && node.builtin === 0 && after === kpBefore + 1 && links.find(l => l.is_primary)?.kp_code === node.code && links.some(l => l.kp_code === 'FN.SHOP' && !l.is_primary) && dbq(22).kp_suggestion_status === 'approved',
      `${node?.code} 节点数 ${kpBefore}→${after}`)
  })
  await selectQ(30)
  await page.locator('[data-testid=kp-reject]').click()
  await page.waitForFunction(() => /已忽略/.test(document.querySelector('[data-testid=kp-suggestion]')?.textContent || ''))
  check('kp_suggestion', '忽略：状态变 rejected，知识点树不变', dbq(30).kp_suggestion_status === 'rejected' && withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM kps').get().c) === kpBefore + 1)

  // 确认整份试卷 → done
  await page.locator('[data-testid=finish-paper]').click()
  await page.locator('[data-testid=finish-ok]').click()
  const done = await waitStatus(page, 'g4-2026.pdf', ['done'], 15000)
  await page.waitForSelector('text=重新打开审核')
  const allRev = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ? AND reviewed = 0').get(id).c)
  await page.screenshot({ path: path.join(shots, 'm2-11-review-done.png') })
  check('审核页', '确认整份试卷：未逐题确认的题一并标为已确认，试卷状态变为 done（已完成）', done?.status === 'done' && allRev === 0)
  await page.evaluate(() => { location.hash = '#/review' })
  await page.getByText(/已完成/).first().click()
  await page.waitForSelector('text=2025-2026学年第二学期')
  const listTxt = await page.locator('.ant-table-tbody').innerText()
  check('审核页', '审核列表的「已完成」页签里能看到这份试卷', /2025-2026/.test(listTxt))
  // 审核 P2-6：已完成的试卷里内容又被改了 → 回到待审核；只切换「已确认」不算内容改动
  const q1id = dbq(1).id
  await page.evaluate(i => window.api.questions.update(i, { reviewed: false }), q1id)
  const stAfterFlag = withDb(ctx.ud, d => d.prepare('SELECT status FROM papers WHERE id = ?').get(id).status)
  await page.evaluate(i => window.api.questions.update(i, { difficulty: 2 }), q1id)
  const stAfterEdit = withDb(ctx.ud, d => d.prepare('SELECT status FROM papers WHERE id = ?').get(id).status)
  check('审核页', '已完成（done）的试卷：只改「已确认」标记仍是 done；改了内容（难度）就回到「待审核」，状态与内容保持一致', stAfterFlag === 'done' && stAfterEdit === 'reviewing', `${stAfterFlag} → ${stAfterEdit}`)
  await page.evaluate(i => window.api.questions.confirmPaper(i, true), id)
}


// ───────────────────────── 阶段 7：解析中被强杀 → 重启后不卡在「解析中」─────────────────────────
async function phaseCrash() {
  let { page, app, mock } = ctx
  mock = ctx.mock
  const crashFile = copyWithTag(pdf25, path.join(ctx.fx, 'g4-2025-crash.pdf'), 'crash')
  mock.resetStats()
  await saveCfg(page, cfgFor(mock, { auto_parse: false }))
  await dropFiles(page, [crashFile])
  const ex = await waitStatus(page, 'g4-2025-crash.pdf', ['extracted'], 90000)
  // 这份没有题目；先让它解析一次拿到旧题目，再在「重新解析」中途强杀，旧题目必须还在
  await parse(page, ex.id, 'ai')
  await waitStatus(page, 'g4-2025-crash.pdf', ['reviewing'], 60000)
  const nBefore = (await getQs(page, ex.id)).questions.length
  // 再来一份从未解析过的，杀在它第一次解析的中途
  const fresh = copyWithTag(pdf26, path.join(ctx.fx, 'g4-2026-crash.pdf'), 'crash2')
  await dropFiles(page, [fresh])
  const ex2 = await waitStatus(page, 'g4-2026-crash.pdf', ['extracted'], 90000)
  mock.delayMs = 15000
  mock.resetStats()
  await parse(page, ex.id, 'ai')
  await parse(page, ex2.id, 'ai')
  await waitFor(async () => (await paperByFile(page, 'g4-2025-crash.pdf')).status === 'parsing' && (await paperByFile(page, 'g4-2026-crash.pdf')).status === 'parsing', 15000)
  await waitFor(() => mock.requests.length >= 2, 10000)
  process.kill(app.process().pid, 'SIGKILL')
  await sleep(1500)
  mock.delayMs = 0
  const re = await launch({ userDataDir: ctx.ud })
  Object.assign(ctx, re); page = re.page
  const a = await paperByFile(page, 'g4-2025-crash.pdf')
  const b = await paperByFile(page, 'g4-2026-crash.pdf')
  check('崩溃恢复', '解析中被强杀（kill -9）后重启：不卡在「AI 解析中」——已有旧题目的回到待审核（旧题目完好），从未解析过的回到已提取，都可以再点解析',
    a.status === 'reviewing' && (await getQs(page, a.id)).questions.length === nBefore && b.status === 'extracted' && (await getQs(page, b.id)).questions.length === 0, `${a.status}/${b.status}`)
  withDb(ctx.ud, d => {
    const runs = d.prepare("SELECT status, COUNT(*) n FROM parse_runs WHERE paper_id IN (?, ?) AND status = 'interrupted' GROUP BY status").all(a.id, b.id)
    check('崩溃恢复', '被中断的解析记录标为 interrupted', runs.length === 1 && runs[0].n === 2, JSON.stringify(runs))
  })
  check('崩溃恢复', '恢复后可以正常重新解析', (await parse(page, b.id, 'ai')) === 'ok' && (await waitStatus(page, 'g4-2026-crash.pdf', ['reviewing', 'failed'], 60000)).status === 'reviewing')
}


// ───────────────────────── 阶段 6b：questions 接口的规则（拆分/合并/删除/重新提取）─────────────────────────
async function phaseApiRules() {
  const { page } = ctx
  const id = ctx.p26c.id    // g4-2026-copy：待审核，未被审核页测试动过
  const ql = () => getQs(page, id)
  const find = (l, no) => l.questions.find(q => q.no === no)
  let l = await ql()
  const q22 = find(l, '22')
  const sp = await page.evaluate(([i, st]) => window.api.questions.split(i, { first: { stem: st, options: [] }, second: { no_label: '22b', stem: '新拆出的', options: [] } }), [q22.id, q22.stem])
  l = await ql()
  const a22 = find(l, '22'), b22 = find(l, '22b')
  check('审核页', '拆分时 kp_suggestion 只留在原题，新题不再复制一条待采纳建议；新题置信度压到 0.69 以下需要关注', a22.kp_suggestion === '购物：尺码询问' && a22.kp_suggestion_status === 'pending' && b22.kp_suggestion === '' && b22.kp_suggestion_status === null && b22.confidence <= 0.69 && l.questions.length === 37 && !!sp, `原题=${a22.kp_suggestion_status} 新题=${JSON.stringify(b22.kp_suggestion)} ${b22.confidence}`)
  const q23 = find(l, '23'), q24 = find(l, '24')
  await page.evaluate(i => window.api.questions.merge(i), q23.id)
  l = await ql()
  const m23 = find(l, '23')
  check('审核页', '合并不丢知识点：被合并题（Q24）的主/次知识点并入次知识点，本题主知识点不变；序号连续', m23.kp_main === 'FN.SHOP.PRICE' && m23.kp_secondary.includes('GR.SENT.YESNO.BE') && m23.kp_secondary.includes('FN.DIALOG') && l.questions.map(q => q.ord).every((o, i) => o === i + 1) && !find(l, '24'), `主=${m23.kp_main} 次=${m23.kp_secondary}`)
  await page.evaluate(i => window.api.questions.merge(i), a22.id)   // 22 与 22b 合并回去：建议保留
  l = await ql()
  check('审核页', '合并时 kp_suggestion 不丢：保留一条（本题有就用本题的）', find(l, '22').kp_suggestion === '购物：尺码询问' && find(l, '22').kp_suggestion_status === 'pending' && !find(l, '22b'))
  const n0 = l.questions.length
  await page.evaluate(i => window.api.questions.remove(i), find(l, '5').id)
  l = await ql()
  check('审核页', '删除一题：序号连续（在同一事务里完成）', l.questions.length === n0 - 1 && l.questions.map(q => q.ord).every((o, i) => o === i + 1))

  // 审核 P2-9：重新提取后，旧的 AI 结果不能再被「仅重新定位」复用
  await page.evaluate(i => window.api.papers.reprocess(i), id)
  const ex = await waitStatus(page, 'g4-2026-copy.pdf', ['extracted', 'failed'], 90000)
  const runs = withDb(ctx.ud, d => d.prepare('SELECT status, result_json FROM parse_runs WHERE paper_id = ?').all(id))
  const r = await parse(page, id, 'locate')
  const f = await waitStatus(page, 'g4-2026-copy.pdf', ['failed', 'reviewing'], 30000)
  check('P2-9 过期结果', '重新提取后旧的可复用解析结果作废（result_json 清空、done 的记录变 superseded，失败/取消的历史保留），「仅重新定位」不会拿旧文字的 anchor 去套新页面，而是明确提示没有可复用的结果',
    ex.status === 'extracted' && runs.length > 0 && runs.every(x => x.result_json === null) && !runs.some(x => ['done', 'ai_done', 'running'].includes(x.status)) && runs.some(x => x.status === 'superseded') && f.status === 'failed' && /没有可复用/.test(f.error), `${runs.map(x => x.status)} | ${f.error}`)
}

// ───────────────────────── 阶段 8：没配 AI 时的重试（审核 P1-2）─────────────────────────
async function phaseNoAi() {
  await ctx.app.close()
  const ud = path.join(work, 'userData-noai')
  let r = await launch({ userDataDir: ud })
  let { app, page } = r
  ctx.mock.resetStats()
  const f = copyWithTag(pdf26, path.join(ctx.fx, 'g4-2026-noai.pdf'), 'noai')
  await dropFiles(page, [f])
  await waitFor(async () => ['imported', 'extracting'].includes((await paperByFile(page, 'g4-2026-noai.pdf'))?.status), 15000, 15)
  process.kill(app.process().pid, 'SIGKILL')
  await sleep(1500)
  r = await launch({ userDataDir: ud }); app = r.app; page = r.page
  const failed = await paperByFile(page, 'g4-2026-noai.pdf')
  check('P1-2 没配 AI 的重试', '前提：AI 没配置（getConfig.hasKey=false），提取被强杀后试卷为 failed，error_stage=extract', failed.status === 'failed' && failed.error_stage === 'extract' && !(await page.evaluate(() => window.api.ai.getConfig())).hasKey, `${failed.status}/${failed.error_stage}`)
  await page.evaluate(() => { location.hash = '#/queue' })
  await page.getByText(/需处理/).first().click()
  await page.locator('tr', { hasText: 'g4-2026-noai.pdf' }).locator('[data-testid=retry-extract]').click()
  const ok = await waitStatus(page, 'g4-2026-noai.pdf', ['extracted', 'failed'], 90000)
  const toasts = (await page.locator('.ant-message-notice').allInnerTexts()).join(' ')
  check('P1-2 没配 AI 的重试', '队列页点「重试（重新提取）」：不再被「尚未配置 AI 服务」挡住，提取成功，停在「已提取」，也没有去请求 AI', ok.status === 'extracted' && !/尚未配置/.test(toasts) && ctx.mock.p1Requests.length === 0, `${ok.status} ${toasts.slice(0, 50)}`)
  const aiTry = await page.evaluate(i => window.api.parse.start(i, 'ai').then(() => 'ok', e => String(e)), ok.id)
  check('P1-2 没配 AI 的重试', '真要调模型的阶段（重新 AI 解析）仍然检查配置，并给出明确提示', /尚未配置 AI 服务/.test(aiTry), clean(aiTry).slice(0, 60))
  await app.close()
}

// ───────────────────────── 阶段 9：密钥「不改发」守卫的边界 + 不跟随重定向 + 400 回显脱敏 ─────────────────────────
async function phaseKeyGuard() {
  const { mock } = ctx
  const SECRET2 = 'sk-e2e-GUARD-9988776655-xyz'
  ctx.secret2 = SECRET2
  mock.clearScript()
  const other = await startMock({ apiKey: 'other-server-key' })   // 另一个「主机」：任何到达它的请求都算密钥外发
  const ud = path.join(work, 'userData-guard')
  mock.apiKey = SECRET2
  mock.resetStats()
  let r = await launch({ userDataDir: ud })
  await saveCfg(r.page, cfgFor(mock), SECRET2)
  // 不跟随重定向：服务端 307 到别的主机，Authorization 不能跟过去
  mock.script([{ type: 'redirect', times: 5, to: `${other.baseUrl}/chat/completions` }])
  const t1 = await r.page.evaluate(() => window.api.ai.test({ kind: 'text' }))
  mock.clearScript()
  check('密钥安全', '服务端 307 重定向到别的主机：客户端不跟随，请求根本没到那台主机（Authorization 不会被带过去），用户看到连接失败', t1.ok === false && other.requests.length === 0, `${t1.message.slice(0, 50)}；对方收到 ${other.requests.length} 个请求`)
  mock.script([{ type: '400echo', times: 1 }])
  const t2 = await r.page.evaluate(() => window.api.ai.test({ kind: 'text' }))
  check('密钥安全', '服务商 400 里回显了密钥：连接测试给用户看的文案已脱敏', t2.ok === false && !t2.message.includes(SECRET2) && /已隐藏/.test(t2.message), t2.message.slice(0, 100))
  await r.app.close()
  // 老版本留下的状态：已存了密钥但 base_url 是空的（审核 P1-5：守卫不能因此失效）
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
  db.exec(`UPDATE settings SET value_json = json_set(value_json, '$.base_url', '') WHERE key = 'ai_config'`)
  db.close()
  r = await launch({ userDataDir: ud })
  const view = await r.page.evaluate(() => window.api.ai.getConfig())
  const evil = `${other.baseUrl}`
  const plain = (({ hasKey, keyStorage, ...rest }) => rest)(view)
  const save1 = await r.page.evaluate(c => window.api.ai.saveConfig(c).then(() => 'resolved', e => String(e)), { ...plain, base_url: evil })
  const test1 = await r.page.evaluate(c => window.api.ai.test({ kind: 'text', cfg: { base_url: c } }), evil)
  const save2 = await r.page.evaluate(c => window.api.ai.saveConfig(c).then(() => 'resolved', e => String(e)), plain)
  check('密钥安全', '已存密钥而地址为空（老状态）：页面脚本不带密钥就把地址改到别的主机 → 保存被拒、测试被拒，对方主机没收到任何请求；连「保持为空」也要求重输密钥',
    view.hasKey === true && view.base_url === '' && /重新输入 API Key/.test(save1) && test1.ok === false && /API Key/.test(test1.message) && /重新输入 API Key/.test(save2) && other.requests.length === 0, `${save1.slice(-30)} | ${test1.message.slice(0, 30)} | 对方 ${other.requests.length}`)
  const fixed = await r.page.evaluate(([c, u, k]) => window.api.ai.saveConfig({ ...c, base_url: u }, k).then(v => v.base_url, e => String(e)), [plain, mock.baseUrl, SECRET2])
  check('密钥安全', '用户同时重新输入地址与密钥即可恢复正常', fixed === mock.baseUrl, fixed)
  await r.app.close()
  // 复审 N1：库里有密文、但当前解不开（钥匙串暂时不可用之类）——守卫看的是「库里有没有密文」，不能因此放行
  const db2 = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
  db2.exec(`UPDATE settings SET value_json = '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' WHERE key = 'ai_key_enc'`)
  db2.close()
  r = await launch({ userDataDir: ud })
  const v3 = await r.page.evaluate(() => window.api.ai.getConfig())
  const p3 = (({ hasKey, keyStorage, ...rest }) => rest)(v3)
  const save3 = await r.page.evaluate(c => window.api.ai.saveConfig(c).then(() => 'resolved', e => String(e)), { ...p3, base_url: evil })
  check('密钥安全', '库里有密文但当前解不开（hasKey 显示为否）：不带密钥把地址改到别的主机仍被拒（守卫看「库里有没有密文」，不看能不能解密）', v3.hasKey === false && /重新输入 API Key/.test(save3) && other.requests.length === 0, `${save3.slice(-30)} | 对方 ${other.requests.length}`)
  await r.app.close()
  mock.apiKey = SECRET
  await other.stop()
}

// ───────────────────────── 阶段 10：全程密钥扫描（数据库表、数据库文件、应用进程输出）─────────────────────────
async function phaseFinalScan() {
  const secrets = [SECRET, ctx.secret2].filter(Boolean)
  const uds = [ctx.ud, path.join(work, 'userData-vision'), path.join(work, 'userData-guard'), path.join(work, 'userData-noai')].filter(u => fs.existsSync(path.join(u, 'workbench-data', 'db.sqlite')))
  const hits = []
  for (const ud of uds) {
    for (const f of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']) {
      const file = path.join(ud, 'workbench-data', f)
      if (fs.existsSync(file) && secrets.some(sec => fs.readFileSync(file).includes(sec))) hits.push(`${path.basename(ud)}/${f}`)
    }
    withDb(ud, d => {
      for (const t of ['papers', 'parse_runs', 'ai_usage', 'questions', 'materials', 'settings']) {
        const dump = JSON.stringify(d.prepare(`SELECT * FROM ${t}`).all())
        if (secrets.some(sec => dump.includes(sec))) hits.push(`${path.basename(ud)}.${t}`)
      }
    })
  }
  const out = L.procOutput.join('')
  check('密钥安全', `全程扫描：${uds.length} 个数据目录的数据库文件与 papers / parse_runs / ai_usage / questions / materials / settings 各表内容里都没有明文密钥`, hits.length === 0, hits.join(', '))
  check('密钥安全', `全程扫描：所有应用进程的 stdout/stderr（共 ${Math.round(out.length / 1024)} KB）里没有密钥`, !secrets.some(sec => out.includes(sec)))
}

//PHASES

async function main() {
  // 调试用：EWB_E2E_ONLY=phaseNoAi,phaseKeyGuard 只跑指定阶段（仍先做 phaseSetup 以启动 mock 与应用）。正式验证一律不设
  const only = process.env.EWB_E2E_ONLY?.split(',')
  if (!only) await phaseMigration()
  await phaseSetup()
  for (const fn of EXTRA_PHASES) if (!only || only.includes(fn.name)) await fn()
}
const EXTRA_PHASES = []
EXTRA_PHASES.push(phaseParse)
EXTRA_PHASES.push(phaseFailures)
EXTRA_PHASES.push(phaseVision)
EXTRA_PHASES.push(phasePrompts)
EXTRA_PHASES.push(phaseReview)
EXTRA_PHASES.push(phaseApiRules)
EXTRA_PHASES.push(phaseCrash)
EXTRA_PHASES.push(phaseNoAi)
EXTRA_PHASES.push(phaseKeyGuard)
EXTRA_PHASES.push(phaseFinalScan)
//REGISTER

main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(path.join(__dirname, 'last-result-m2.json')) ? 1 : 0)
}, e => {
  console.error('E2E 异常:', e)
  check('E2E', '测试脚本未异常退出', false, e.message)
  process.exit(L.finish(path.join(__dirname, 'last-result-m2.json')) ? 1 : 1)
})
