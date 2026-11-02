// M10b（1.3.0-beta.3）端到端：老师版报告升级。全程 mock AI（不调用真实服务）。
//   · 提示词：p3_teacher 升到 v3.0；自定义过 p3_teacher 的用户保持自己的版本，设置页标「默认版已更新，可对比」
//   · 分段生成：主文 + 易错题集（程序拼）+ 口诀（AI）+ 变形题（出题 → 程序校验 → 第二次独立解答）；每段单独失败、单独重试、状态各自显示
//   · 卡片：口诀大招 / 答题卡（界面、复制到微信、Word、PDF、Markdown 同一套语法），答题卡不含学生信息，只放老师逐题勾「我核对过」的题
//   · 复制 / 保存成图片（2 倍清晰度）
//   · AI 内容守则：价格 / 夸大说法被去掉；变形题不外发原卷题干；已核对的报告不能再单独重试；其他读者版本不受影响
// 截图：docs/screenshots/m10b-*.png（浅色 + 深色）。
// 用法：npm run test:e2e:m10b   （沙箱外运行：Electron、本地端口都被沙箱限制）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const { DatabaseSync } = require('node:sqlite')
const JSZip = require('jszip')
const { execFileSync } = require('node:child_process')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, api, cfgFor, saveCfg, startMock, open, shots, stubSave, pdfInfo, L, root } = M

const writeDb = (ud, fn) => { const d = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite')); d.exec('PRAGMA busy_timeout=5000'); d.exec('PRAGMA foreign_keys=ON'); try { return fn(d) } finally { d.close() } }
const reports = () => withDb(ctx.ud, d => d.prepare('SELECT * FROM reports ORDER BY created_at, rowid').all())
const lastReport = () => reports()[reports().length - 1]
const partsOf = id => withDb(ctx.ud, d => d.prepare('SELECT * FROM report_parts WHERE report_id = ?').all(id))
const variantsOf = id => withDb(ctx.ud, d => d.prepare('SELECT * FROM report_variants WHERE report_id = ? ORDER BY seq').all(id))
const partStatus = (id) => Object.fromEntries(partsOf(id).map(p => [p.part, p.status]))
const setTheme = async (mode) => { await goto('#/'); await ctx.page.evaluate(m => localStorage.setItem('ewb-theme-pref', m), mode); await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }) }
const shot10 = name => ctx.page.screenshot({ path: path.join(shots, `m10b-${name}.png`) })
const pngSize = f => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
const clipImage = () => ctx.app.evaluate(async ({ clipboard }) => {
  const items = await clipboard.read()
  const it = items.find(i => i.types.includes('image/png'))
  if (!it) return null
  const buf = Buffer.from(await (await it.getType('image/png')).arrayBuffer())
  return { len: buf.length, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
})

/** 在报告页选老师版并生成，等整条链路（主文 + 附加段）结束，返回新报告行 */
async function genTeacher({ waitMs = 90000 } = {}) {
  const before = reports().length
  await goto('#/report'); await T('report-page').waitFor()
  if (await T('report-dismiss').count()) await T('report-dismiss').click()
  await T('reader-teacher').locator('xpath=ancestor::label').click()
  await waitFor(async () => (await T('report-generate').count()) > 0, 15000)
  await T('report-generate').click()
  const ok = await waitFor(async () => reports().length > before && (await T('report-running').count()) === 0, waitMs)
  await waitFor(async () => (await T('report-parts').count()) > 0 && (await T('report-body').count()) > 0 && /老师版/.test(await T('report-title').innerText().catch(() => '')), 20000)
  return { ok: !!ok, row: lastReport() }
}

async function main() {
  // ───────────────────────── 夹具：多年级、多学年的卷子（见 fixtures-m3），全部是已审核的；给每道题一个参考答案 ─────────────────────────
  ctx.mock = await startMock({ apiKey: SECRET })
  const mock = ctx.mock
  const ud = path.join(work, 'userM10b')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  writeDb(ud, db => db.exec("UPDATE questions SET answer = 'B'"))
  await open(ud)
  const page = ctx.page
  await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(300, 300); w.setContentSize(1500, 1000) })
  await saveCfg(cfgFor(mock), SECRET)
  await setFilter({ grade: '4' }, '#/report')
  await T('report-page').waitFor()
  const reqCount = () => ({ p3: mock.p3Requests.length, tricks: mock.tricksRequests.length, vgen: mock.variantGenRequests.length, vcheck: mock.variantCheckRequests.length })

  // ───────────────────────── 1. 提示词：v3.0、自定义的保持不变并标「默认版已更新」 ─────────────────────────
  {
    const pv = await api(() => window.api.ai.prompts())
    const view = id => pv.items.find(i => i.id === id && i.part === 'system')
    check('提示词', '老师版 p3_teacher 内置版本升到 v3.0；新增口诀 / 出题 / 独立解答三个提示词；其他提示词（如 P1）版本仍是 v2.0', view('p3_teacher').version === 'v3.0' && ['p3_tricks', 'p4_variant_gen', 'p4_variant_check'].every(i => view(i)?.version === 'v3.0') && view('p1_text').version === 'v2.0' && pv.defaultVersion === 'v2.0')
    check('提示词', '默认（没有自定义）时没有任何「默认版已更新」标记', pv.items.every(i => !i.defaultUpdated))
    check('提示词', '内置 p3_teacher system / user 与 docs/prompts/v3-老师版升级.md 逐字一致；是新结构（做题方法 + 学习进步建议），旧的「易错点（按重要程度排序）」已不在默认版里', view('p3_teacher').defaultText === L.docsPrompt('p3_teacher', 'system') && /做题方法/.test(view('p3_teacher').defaultText) && !/易错点（按重要程度排序）/.test(view('p3_teacher').defaultText))
    // 模拟 beta.3 之前自定义过 p3_teacher：直接写进 settings（没有「基于哪一版」的记录）
    const CUSTOM = view('p3_teacher').defaultText + '\n【E2E 自定义标记：保持这个版本】'
    writeDb(ud, db => db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('ai_prompts', ?)").run(JSON.stringify({ 'p3_teacher.system': CUSTOM })))
    const pv2 = await api(() => window.api.ai.prompts())
    const c = pv2.items.find(i => i.id === 'p3_teacher' && i.part === 'system')
    check('提示词', '自定义过 p3_teacher 的用户：保持他自己的版本（文本不变、仍是已自定义），并被标记「默认版已更新」；user 部分没改过，不受影响', c.isCustom && c.text === CUSTOM && c.defaultUpdated && c.version === 'v3.0' && !pv2.items.find(i => i.id === 'p3_teacher' && i.part === 'user').defaultUpdated)
    await goto('#/settings'); await page.waitForSelector('[data-testid=prompt-settings]')
    const body = await T('prompt-settings').innerText()
    check('提示词', '设置页提示词管理里，老师版那一组标着「默认版已更新，可对比」', /P3 考情分析报告：老师版[\s\S]*默认版已更新，可对比/.test(body))
    await page.getByText('P3 考情分析报告：老师版').first().click()
    await T('prompt-compare-p3_teacher-system').waitFor({ state: 'attached' }).catch(() => {})
    await page.getByText('看新的内置默认版（v3.0）和你的版本对比').first().click()
    await T('prompt-compare-p3_teacher-system').waitFor({ timeout: 8000 })
    check('提示词', '展开「看新的内置默认版和你的版本对比」：能看到新默认版全文，并写明“你一直在用自己的版本，没有被换掉”', /没有被换掉/.test(await txt('prompt-compare-p3_teacher-system')) && (await T('prompt-compare-p3_teacher-system').locator('textarea').inputValue()) === view('p3_teacher').defaultText)
    await ctx.page.screenshot({ path: path.join(shots, 'm10b-prompt-updated-light.png') })

    // 用自定义版本生成：发给 AI 的 system 就是他的版本；报告的提示词版本标「v2.0+自定义·…」（基于升级前的默认版）
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    const g = await genTeacher()
    const rq = mock.p3Requests[mock.p3Requests.length - 1]
    check('提示词', '自定义用户生成老师版：发给 AI 的 system = 他自己的版本；报告里记的提示词版本是「v2.0+自定义·…」（基于哪一版内置默认也留痕）', g.ok && rq.system === CUSTOM && /^v2\.0\+自定义·[0-9a-f]{6}$/.test(g.row.prompt_version), g.row && g.row.prompt_version)
    // 恢复默认后标记消失
    await api(() => window.api.ai.resetPrompt('p3_teacher', 'system'))
    const pv3 = await api(() => window.api.ai.prompts())
    check('提示词', '点「恢复默认」后：换成新默认版，「默认版已更新」标记消失', pv3.items.every(i => !i.defaultUpdated) && pv3.items.find(i => i.id === 'p3_teacher' && i.part === 'system').text === pv3.items.find(i => i.id === 'p3_teacher' && i.part === 'system').defaultText)
    // 重新保存自定义版：视为已看过新版，标记也不再出现
    await api(t => window.api.ai.savePrompt('p3_teacher', 'system', t), CUSTOM)
    check('提示词', '现在才保存的自定义版：记下的是当前默认版 v3.0，不再标「已更新」', (await api(() => window.api.ai.prompts())).items.every(i => !i.defaultUpdated))
    await api(() => window.api.ai.resetPrompt('p3_teacher', 'system'))
  }

  // ───────────────────────── 2. 默认老师版：分段生成 ─────────────────────────
  mock.resetStats()
  await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
  const g1 = await genTeacher()
  const R1 = g1.row
  const md1 = R1.markdown
  const n = reqCount()
  check('分段生成', '老师版一次生成 = 4 次独立的 AI 调用：主文 1 + 口诀 1 + 出题 1 + 第二次独立解答 1', g1.ok && n.p3 === 1 && n.tricks === 1 && n.vgen === 1 && n.vcheck === 1, JSON.stringify(n))
  check('分段生成', '主文 / 口诀 / 出题 / 独立解答的 system 与 docs/prompts/v3-老师版升级.md 逐字一致；user 的占位符填满、没有残留 {{ }}',
    mock.p3Requests[0].system === L.docsPrompt('p3_teacher', 'system') && mock.tricksRequests[0].system === L.docsPrompt('p3_tricks', 'system') && mock.variantGenRequests[0].system === L.docsPrompt('p4_variant_gen', 'system') && mock.variantCheckRequests[0].system === L.docsPrompt('p4_variant_check', 'system')
    && [mock.p3Requests[0], mock.tricksRequests[0], mock.variantGenRequests[0], mock.variantCheckRequests[0]].every(r => !/\{\{|\}\}/.test(r.user)))
  const st = partStatus(R1.id)
  check('分段生成', '库里 report_parts：main / errors / tricks / variants 四段，状态都是 ok；主文带模型名和提示词版本 v3.0', JSON.stringify(Object.keys(st).sort()) === JSON.stringify(['errors', 'main', 'tricks', 'variants']) && Object.values(st).every(s => s === 'ok') && partsOf(R1.id).find(p => p.part === 'main').prompt_version === 'v3.0' && partsOf(R1.id).find(p => p.part === 'tricks').prompt_version === 'v3.0')
  const heads = md1.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3))
  check('老师版结构', '报告结构：易错题集（AI 估计）→ 易错知识点 → 做题方法 → 3 道同类变形题 → 学习进步建议；说明在最前面；叫「易错题集」不叫「错题集」', JSON.stringify(heads) === JSON.stringify(['易错题集（AI 估计）', '易错知识点', '做题方法', '3 道同类变形题', '学习进步建议']) && !/(^|[^易])错题集/.test(md1) && md1.indexOf('> 说明') < md1.indexOf('## 易错题集'), JSON.stringify(heads))
  const errSec = md1.slice(md1.indexOf('## 易错题集'), md1.indexOf('## 做题方法'))
  const nItems = (errSec.match(/^### \d+\. /gm) ?? []).length / 2
  check('老师版结构', '易错题集 / 易错知识点由程序拼：每个易错点有原卷例题（[卷名 · 题号]，≤ 2 道）、题型、AI 估计的易错原因；老师审核过的题给参考答案；易错知识点有白话 / 例句 / 出现份数', nItems >= 2 && /\*\*原卷例题\*\*：\[[^\]]+ · [^\]]+\]/.test(errSec) && /\*\*题型\*\*/.test(errSec) && /\*\*易错原因（AI 估计）\*\*/.test(errSec) && /答案 B/.test(errSec) && /\*\*出现\*\*：\d+\/\d+ 份卷子/.test(errSec) && errSec.split('\n').filter(l => /^- \*\*原卷例题\*\*/.test(l)).every(l => (l.match(/\[[^\]]+ · [^\]]+\]/g) ?? []).length <= 2), `${nItems} 个易错点`)
  const tricks = (md1.match(/^::: trick/gm) ?? []).length
  check('老师版结构', '口诀大招：每个易错点一张卡片；「例」的英文句子由程序取自证据（AI 没写英文句子）', tricks === nItems && /\*\*例\*\*：[A-Za-z]/.test(md1) && !/"trick":.*[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}/.test(mock.tricksRequests[0].user), `${tricks} 张`)
  check('AI 内容守则', '出题的输入只有考点、白话释义、例词、例句和题型：不含任何原卷题干；独立解答的输入里没有出题答案和讲解', (() => {
    const stems = withDb(ud, d => d.prepare("SELECT stem FROM questions WHERE stem IS NOT NULL AND stem <> ''").all().map(r => r.stem))
    const gen = mock.variantGenRequests[0].user, chk = mock.variantCheckRequests[0].user
    return stems.length > 3 && stems.every(s => !gen.includes(s)) && /【考点】/.test(gen) && !/答案|讲解|explanation|answer/i.test(chk)
  })())
  const vs = variantsOf(R1.id)
  check('变形题', '3 道变形题入库：status = checked（独立解答一致），teacher_ok = 0；两道选择题的答案位置被程序调开（不全是 B）；check_json 里有第二次解答', vs.length === 3 && vs.every(v => v.status === 'checked' && v.teacher_ok === 0) && new Set(vs.filter(v => v.qtype === 'choice').map(v => v.answer)).size === 2 && vs.every(v => JSON.parse(v.check_json).second), vs.map(v => v.answer).join(','))
  const usage = withDb(ud, d => d.prepare("SELECT kind, COUNT(*) c FROM ai_usage WHERE ok = 1 AND kind IN ('p3_tricks','p4_variant_gen','p4_variant_check') GROUP BY kind").all())
  check('分段生成', 'ai_usage 里口诀 / 出题 / 独立解答各记了一次用量（可在设置里看到花费）', usage.length === 3 && usage.every(u => u.c >= 1))
  // 没有勾任何题时：答题卡不存在，报告里写明
  check('答题卡门槛', '一道题都还没勾「我核对过」时：报告里没有答题卡，写明“答题卡还没有题目”；变形题核对区列出 3 道题、写明还差几题', !/^::: answercard/m.test(md1) && /答题卡还没有题目/.test(md1) && (await T('variants-left').innerText()).includes('还有 3 道题没核对') && (await page.locator('[data-testid^=variant-][data-status]').count()) === 3)
  check('界面', '报告页分段状态：易错题集与易错知识点 / 口诀大招 / 同类变形题与答题卡 各一行，状态「已生成」，各有「重新生成这一部分」', await page.locator('[data-testid=report-parts] li').count() === 3 && (await T('report-parts').innerText()).split('已生成').length === 4 && (await page.locator('[data-testid^=part-retry-]').count()) === 3)
  check('界面', '口诀卡渲染成卡片（带「口诀大招」横幅、大字口诀、例句、出自考点）；每张卡下面有「保存图片」「复制图片」', (await page.locator('[data-testid=card-trick]').count()) === tricks && /口诀大招/.test(await page.locator('[data-testid=card-trick]').first().innerText()) && (await page.locator('[data-testid^=card-save-trick-]').count()) === tricks && (await page.locator('[data-testid^=card-copy-trick-]').count()) === tricks)

  // ───────────────────────── 3. 逐题勾「我核对过」→ 答题卡 ─────────────────────────
  const tick = async (seq) => { await T(`variant-tick-${seq}`).locator('xpath=ancestor::label').click() }
  await tick(1)
  await waitFor(async () => (await page.locator('[data-testid=card-answer-item]').count()) === 1, 8000)
  const md1b = lastReport().markdown
  check('答题卡门槛', '勾第 1 题的「我核对过」后：答题卡出现，只有这一道题；库里 teacher_ok = 1、报告 Markdown 里有 ::: answercard 块；提示还差 2 题', (await page.locator('[data-testid=card-answer-item]').count()) === 1 && /^::: answercard/m.test(md1b) && variantsOf(R1.id)[0].teacher_ok === 1 && (await T('variants-left').innerText()).includes('还有 2 道题没核对'))
  await tick(2); await tick(3)
  await waitFor(async () => (await page.locator('[data-testid=card-answer-item]').count()) === 3, 8000)
  const md2 = lastReport().markdown
  const cardText = await T('card-answer').innerText()
  check('答题卡', '三题都勾后：答题卡 3 道题，左侧编号徽标 1–3，选择题 ○A ○B ○C ○D，填空题有虚线作答框；顶部是留给学生手写的空白「姓名 / 日期」横线，没有任何具体学生信息', (await page.locator('[data-testid=card-answer] .ewb-ans__no').allInnerTexts()).join(',') === '1,2,3' && /○ A\. .*○ B\. .*○ C\. .*○ D\./s.test(cardText) && (await page.locator('[data-testid=card-answer] .ewb-ans__box').count()) === 1 && (await page.locator('[data-testid=card-answer] .ewb-ans__line').count()) === 2 && /姓名/.test(cardText) && /日期/.test(cardText), cardText.slice(0, 120))
  check('答题卡', '卡片带「AI 出题」标签和页脚“使用前请老师先做一遍”；答题卡里没有答案和讲解（它们在下面“参考答案与讲解（教师用）”一节）', /AI 出题/.test(cardText) && /使用前请老师先做一遍/.test(cardText) && !/参考答案|答案：/.test(cardText) && /### 参考答案与讲解（教师用）/.test(md2) && /\*\*答案\*\*/.test(md2))
  const cw = await T('card-answer').locator('.ewb-card').evaluate(el => Math.round(el.getBoundingClientRect().width))
  check('答题卡', '卡片最宽 720px（右栏装不下时自动收窄，不出现横向滚动）；图片导出时固定 720px 宽（见下面的图片检查）', cw <= 720 && cw >= 560 && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), `${cw}px`)
  const vOpt = JSON.parse(variantsOf(R1.id)[1].options_json)
  check('答题卡', '答题卡上第 2 题的选项顺序就是库里（程序调整过位置后）的顺序，正确答案字母指向同一个选项', (await T('card-answer').locator('[data-testid=card-answer-item]').nth(1).innerText()).includes(`○ ${'ABCD'[vOpt.indexOf('goes')]}. goes`))
  check('界面', '变形题核对区：每道题显示「AI 出题」、题型、「第二次 AI 解答一致」、教师用的参考答案；全部勾完写明“所有可用的题都核对过了”', (await T('variants-left').innerText()).includes('所有可用的题都核对过了') && (await page.locator('[data-testid=variants-panel]').innerText()).includes('第二次 AI 解答一致') && (await page.locator('[data-testid^=variant-answer-]').count()) === 3)

  // ───────────────────────── 4. 复制 / 保存成图片（2 倍清晰度） ─────────────────────────
  {
    const f = path.join(work, 'answer-card.png')
    await stubSave(f)
    await T('card-save-answercard-0').click()
    await waitFor(async () => fs.existsSync(f), 20000)
    const sz = fs.existsSync(f) ? pngSize(f) : { w: 0, h: 0 }
    check('图片', '「保存图片」：写出 PNG；宽度 1504 像素 = (720 + 两侧白边) × 2（2 倍清晰度），高度符合内容', M.isPng(f) && sz.w === 1504 && sz.h > 500 && sz.h < 3000, `${sz.w}×${sz.h}`)
    fs.copyFileSync(f, path.join(shots, 'm10b-card-answer-image.png'))
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('旧的剪贴板内容'))
    await T('card-copy-answercard-0').click()
    const clip = await waitFor(async () => { const c = await clipImage(); return c && c.len > 1000 ? c : null }, 20000)
    check('图片', '「复制图片」：剪贴板里是 PNG 图片（非空，宽 1504），不是文字', !!clip && clip.w === 1504 && clip.h === sz.h, JSON.stringify(clip))
    const f2 = path.join(work, 'trick-card.png')
    await stubSave(f2)
    await T('card-save-trick-0').click()
    await waitFor(async () => fs.existsSync(f2), 20000)
    const sz2 = fs.existsSync(f2) ? pngSize(f2) : { w: 0, h: 0 }
    check('图片', '口诀卡同样能存成 2 倍图片（宽 1504），比答题卡矮', sz2.w === 1504 && sz2.h > 200 && sz2.h < sz.h, `${sz2.w}×${sz2.h}`)
    fs.copyFileSync(f2, path.join(shots, 'm10b-card-trick-image.png'))
  }

  // ───────────────────────── 5. 复制到微信 / 导出 Word、PDF、Markdown ─────────────────────────
  {
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('旧的剪贴板内容'))
    await T('report-copy-wechat').click()
    await waitFor(async () => (await ctx.app.evaluate(({ clipboard }) => clipboard.readText())) !== '旧的剪贴板内容', 8000)
    const wx = await ctx.app.evaluate(({ clipboard }) => clipboard.readText())
    check('复制到微信', '卡片转成纯文本：「【口诀大招】…」「【答题卡】姓名：______ 日期：______ 1. … ○A ○B」；没有 Markdown 记号，答题卡部分不含答案', /【口诀大招】/.test(wx) && /【答题卡】姓名：______/.test(wx) && /○A\. .*○B\./.test(wx) && !/:::|\*\*|\{choice/.test(wx), wx.slice(0, 160))
    const docx = path.join(work, 'teacher.docx'), pdf = path.join(work, 'teacher.pdf'), md = path.join(work, 'teacher.md')
    await stubSave(docx); await T('report-export-docx').click(); await T('report-export-result').waitFor({ timeout: 30000 })
    const z = await JSZip.loadAsync(fs.readFileSync(docx))
    const xml = await z.file('word/document.xml').async('string')
    check('Word', 'Word 导出：口诀卡（淡琥珀横幅、深琥珀边框、斜体例句）+ 答题卡（徽标列深色底、虚线作答区、选择题 ○A○B○C○D、空白姓名 / 日期），和界面同一套颜色', xml.includes('w:fill="FFF1CC"') && xml.includes('w:fill="1C1B2E"') && xml.includes('w:val="dashed"') && xml.includes('<w:i/>') && /○ A\./.test(xml) && /姓名 ______/.test(xml) && (xml.match(/<w:tbl>/g) ?? []).length === tricks + 1)
    await stubSave(pdf); await T('report-export-pdf').click(); await waitFor(async () => fs.existsSync(pdf) && fs.statSync(pdf).size > 5000, 30000)
    const pi = await pdfInfo(pdf)
    pi.text = pi.text.normalize('NFKC')   // PDF 里的中文有时是康熙部首（⼝⼤⽼），规范化后再比
    check('PDF', 'PDF 导出：含「口诀大招」「答题卡」「易错题集」「参考答案与讲解」，姓名 / 日期横线', /口诀大招/.test(pi.text) && /答题卡/.test(pi.text) && /易错题集/.test(pi.text) && /参考答案与讲解/.test(pi.text) && /姓名/.test(pi.text), `${pi.pages} 页`)
    await stubSave(md); await T('report-export-md').click(); await waitFor(async () => fs.existsSync(md), 20000)
    const mdt = fs.readFileSync(md, 'utf8')
    check('Markdown', 'Markdown 导出：卡片保持容器块语法（::: trick / ::: answercard），其他工具读到也是普通文字', /^::: trick 口诀大招/m.test(mdt) && /^::: answercard 答题卡 \| 同类变形题/m.test(mdt) && /\{choice: /.test(mdt))
    // Word 样张用 macOS Quick Look 渲染一次（只是另一个渲染器的参考，不等于真 Word / WPS）
    try {
      const sample = path.join(work, 'cards-sample.docx')
      execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(__dirname, 'word-cards-sample.mjs'), sample], { cwd: root })
      execFileSync('qlmanage', ['-t', '-s', '1400', '-o', work, sample], { stdio: 'ignore', timeout: 60000 })
      const out = path.join(work, 'cards-sample.docx.png')
      if (fs.existsSync(out)) { fs.copyFileSync(out, path.join(shots, 'm10b-word-cards-quicklook.png')); check('Word 渲染', 'Word 样张（只含两张卡片）用 macOS Quick Look 渲染成图，已存 docs/screenshots/m10b-word-cards-quicklook.png（真 Word / WPS 仍需人工打开检查）', M.isPng(out)) }
    } catch (e) { check('Word 渲染', 'Quick Look 渲染 Word 样张（本机没有时跳过，不算失败）', true, `跳过：${String(e.message).slice(0, 60)}`) }
  }

  // ───────────────────────── 6. 截图：浅色 + 深色 ─────────────────────────
  for (const mode of ['light', 'dark']) {
    await setTheme(mode)
    await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
    await page.locator(`[data-testid=report-item-${R1.id}]`).click()
    await T('report-parts').waitFor()
    await T('report-parts').scrollIntoViewIfNeeded()
    await sleep(500)
    await shot10(`report-parts-${mode}`)
    await T('variants-panel').scrollIntoViewIfNeeded(); await sleep(300)
    await T('variants-panel').screenshot({ path: path.join(shots, `m10b-variants-${mode}.png`) })
    await T('card-answer').scrollIntoViewIfNeeded(); await sleep(300)
    await T('card-answer').screenshot({ path: path.join(shots, `m10b-card-answer-${mode}.png`) })
    await page.locator('[data-testid=card-trick]').first().screenshot({ path: path.join(shots, `m10b-card-trick-${mode}.png`) })
    const paper = await T('card-answer').locator('.ewb-card').evaluate(el => getComputedStyle(el).backgroundColor)
    check('截图', `${mode}：卡片永远是白纸（和原卷一样，深色模式里也不变）；截图已存 m10b-*-${mode}.png`, paper === 'rgb(255, 255, 255)', paper)
  }
  await setTheme('light')

  // ───────────────────────── 7. 单段失败 + 单段重试（不影响主文和其他段） ─────────────────────────
  mock.resetStats()
  mock.quirks = { p4: { variantDisagree: 2 } }
  mock.script([{ type: '500', times: 3, only: 'tricks' }])   // 口诀这一段连续失败（客户端自己重试 2 次也失败）
  await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
  const g2 = await genTeacher()
  const R2 = g2.row
  mock.quirks = {}
  const st2 = partStatus(R2.id)
  check('单段失败', '口诀这一段失败：主文 / 易错题集 / 变形题照常成功，整份报告仍然入库（可用）', g2.ok && st2.main === 'ok' && st2.errors === 'ok' && st2.tricks === 'failed' && st2.variants === 'ok', JSON.stringify(st2))
  const tp = partsOf(R2.id).find(p => p.part === 'tricks')
  check('单段失败', '失败的段记下白话原因和技术详情（给管理员看）；报告 Markdown 里留一行占位“这一部分没有生成”，没有口诀卡', !!tp.message && /AI 服务暂时不可用|重试/.test(tp.message) && !!tp.detail && /「口诀大招」这一部分没有生成/.test(R2.markdown) && !/^::: trick/m.test(R2.markdown), tp.message)
  check('单段失败', '界面上这一段单独显示「没有生成」+ 原因 + 「重试这一部分」；其他段仍是「已生成」', /没有生成/.test(await txt('part-tricks')) && (await T('part-retry-tricks').innerText()).includes('重试这一部分') && /已生成/.test(await txt('part-errors')) && /已生成/.test(await txt('part-variants')))
  const vs2 = variantsOf(R2.id)
  check('变形题', '第二次独立解答与出题答案不一致的那一题（第 2 题）标 flagged「答案有争议」，其余 checked；界面写明“答案有争议”并给出第二次解答', vs2.map(v => v.status).join() === 'checked,flagged,checked' && (await T('variant-2').innerText()).includes('答案有争议') && /第二次 AI 解答给出的是/.test(await txt('variant-2')))
  // 只重试口诀这一段
  const before = reqCount()
  const beforeRows = withDb(ud, d => d.prepare('SELECT id, teacher_ok FROM report_variants WHERE report_id = ?').all(R2.id))
  await tick(3)   // 先勾第 3 题：重试口诀不能把它清掉
  await waitFor(async () => variantsOf(R2.id)[2].teacher_ok === 1, 8000)
  await T('part-retry-tricks').click()
  await waitFor(async () => partStatus(R2.id).tricks === 'ok', 30000)
  await waitFor(async () => (await page.locator('[data-testid=card-trick]').count()) > 0, 10000)
  const after = reqCount()
  check('单段重试', '只重试口诀：只多了 1 次口诀调用，主文 / 出题 / 解答都没有再调用；口诀卡出现，占位说明消失', after.tricks === before.tricks + 1 && after.p3 === before.p3 && after.vgen === before.vgen && after.vcheck === before.vcheck && !/这一部分没有生成/.test(lastReport().markdown) && /^::: trick/m.test(lastReport().markdown), JSON.stringify({ before, after }))
  check('单段重试', '变形题行没动（id 不变、已勾的核对还在）；各段状态都是 ok', variantsOf(R2.id).map(v => v.id).join() === beforeRows.map(v => v.id).join() && variantsOf(R2.id)[2].teacher_ok === 1 && Object.values(partStatus(R2.id)).every(s => s === 'ok'))
  // 争议题：勾上 = 仍然使用，进答题卡并在教师用讲解里留痕
  await tick(2)
  await waitFor(async () => (await page.locator('[data-testid=card-answer-item]').count()) === 2, 8000)
  check('答题卡门槛', '争议题勾了「我核对过」就是“仍然使用”：进答题卡，教师用的讲解里留下“第二次解答与出题答案不一致，老师确认后仍使用”', /第二次解答与出题答案不一致，老师确认后仍使用/.test(lastReport().markdown) && (await page.locator('[data-testid=card-answer-item]').count()) === 2)
  // 已核对的报告不能再单独重试
  await T('report-confirm').click()
  await T('confirm-dialog').waitFor()
  for (const cb of await T('confirm-dialog').locator('[data-testid=verify-ok]').all()) await cb.click()
  await T('confirm-ok').click()
  await waitFor(async () => !!withDb(ud, d => d.prepare('SELECT confirmed_at c FROM reports WHERE id = ?').get(R2.id).c), 8000)
  await waitFor(async () => (await T('part-retry-tricks').isDisabled()), 8000)
  const rr = await api(id => window.api.report.retryPart(id, 'tricks', crypto.randomUUID()), R2.id)
  check('单段重试', '报告已核对后：各段的重试按钮灰掉；绕过界面直接调接口也被拒绝（已核对的报告不能再改）', rr.ok === false && /已经核对过了/.test(rr.message) && (await T('part-retry-variants').isDisabled()), JSON.stringify(rr))
  const tk = await api(id => window.api.report.variantTick(id, `${id}-v1`, false).then(() => 'ok', e => String(e.message)), R2.id)
  check('答题卡门槛', '核对后老师仍可调整逐题的勾选（勾选是老师自己的决定，不受报告已核对限制）', tk === 'ok')
  await api(id => window.api.report.variantTick(id, `${id}-v1`, true), R2.id)

  // ───────────────────────── 8. AI 内容守则：价格 / 夸大 / 剔除 / 取消 / 变形题整段失败再重试 ─────────────────────────
  mock.resetStats()
  mock.quirks = { p3: { overclaim: true }, p4: { trickPrice: true, variantPrice: true } }
  await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
  const g3 = await genTeacher()
  const R3 = g3.row
  mock.quirks = {}
  check('AI 内容守则', '主文里含价格 / 夸大说法（“报名后保证孩子提高 20 分”）的句子被整句删掉并提示；报告里没有「报名」「保证」', g3.ok && !/报名|保证/.test(R3.markdown) && JSON.parse(R3.warnings_json).some(w => /含价格 \/ 夸大的说法，已删掉/.test(w)), JSON.parse(R3.warnings_json).join('|'))
  const tr3 = (R3.markdown.match(/^::: trick/gm) ?? []).length
  check('AI 内容守则', '口诀里含价格 / 营销说法的那一条被去掉（卡片比易错点少 1 张），并提示', tr3 === nItems - 1 && !/立减|提分/.test(R3.markdown) && JSON.parse(R3.warnings_json).some(w => /口诀含价格/.test(w)), `${tr3} 张`)
  const vs3 = variantsOf(R3.id)
  check('变形题', '讲解里带“报名”的那一题被程序剔除（status = dropped），写明原因；界面标「已剔除」且没有勾选框，接口也不允许勾', vs3[0].status === 'dropped' && /价格|夸大/.test(JSON.parse(vs3[0].check_json).problems.join()) && (await T('variant-1').innerText()).includes('已剔除') && (await T('variant-tick-1').count()) === 0
    && /没有通过程序校验/.test(await api(id => window.api.report.variantTick(id, `${id}-v1`, true).then(() => 'ok', e => String(e.message)), R3.id)))
  // 取消：口诀这一段挂起时点取消
  mock.resetStats()
  mock.script([{ type: 'hang', ms: 25000, only: 'tricks' }])
  await goto('#/report'); await T('report-page').waitFor()
  const cBefore = reports().length
  await T('reader-teacher').locator('xpath=ancestor::label').click()
  await T('report-generate').click()
  await waitFor(async () => mock.tricksRequests.length >= 1, 60000)
  await T('report-cancel').click()
  await waitFor(async () => (await T('report-running').count()) === 0, 20000)
  await waitFor(async () => reports().length > cBefore, 5000)
  const R4 = lastReport()
  const st4 = partStatus(R4.id)
  const m4 = Object.fromEntries(partsOf(R4.id).map(p => [p.part, p.message]))
  check('取消', '取消发生在附加段：主文和已完成的易错题集保留，报告入库；当前段记「已取消」、没来得及跑的段记“已取消，这一部分没有生成”，之后都能单独重试', st4.main === 'ok' && st4.errors === 'ok' && st4.tricks === 'failed' && st4.variants === 'failed' && /已取消/.test(m4.tricks) && /已取消，这一部分没有生成/.test(m4.variants), JSON.stringify(st4))
  mock.clearScript()
  mock.quirks = { p4: { variantBadJson: true } }
  await waitFor(async () => (await T('part-retry-tricks').count()) > 0, 10000)
  await T('part-retry-tricks').click()
  await waitFor(async () => partStatus(R4.id).tricks === 'ok', 30000)
  await T('part-retry-variants').click()
  await waitFor(async () => (await T('part-retry-variants').isEnabled()) && partStatus(R4.id).variants === 'failed', 30000)
  const pv4 = partsOf(R4.id).find(p => p.part === 'variants')
  check('单段失败', '变形题出题输出不是 JSON：这一段失败，白话原因 + 可重试；变形题表里没有半截数据', pv4.status === 'failed' && /没有给出可以读取的题目/.test(pv4.message) && variantsOf(R4.id).length === 0 && /「同类变形题与答题卡」这一部分没有生成/.test(lastReport().markdown) && partStatus(R4.id).tricks === 'ok')
  mock.quirks = {}
  await T('part-retry-variants').click()
  await waitFor(async () => partStatus(R4.id).variants === 'ok', 30000)
  check('单段重试', '改好后重试变形题：3 道题入库，答题卡区回到“还没有题目”（新题要重新逐题核对），其余段不变', variantsOf(R4.id).length === 3 && variantsOf(R4.id).every(v => v.teacher_ok === 0) && /答题卡还没有题目/.test(lastReport().markdown) && Object.values(partStatus(R4.id)).every(s => s === 'ok'))
  check('单段重试', '数据变了（报告已过期）时不能单独重试：避免新数据的口诀接在旧主文上', await (async () => {
    writeDb(ud, db => { db.exec("UPDATE questions SET error_reason = error_reason || '（改）' WHERE error_prone = 1") })
    await waitFor(async () => (await api(id => window.api.report.get(id), R4.id)).status === 'stale', 10000)
    const r = await api(id => window.api.report.retryPart(id, 'tricks', crypto.randomUUID()), R4.id)
    writeDb(ud, db => { db.exec("UPDATE questions SET error_reason = REPLACE(error_reason, '（改）', '')") })
    return r.ok === false && /重新生成整份报告/.test(r.message)
  })())

  // ───────────────────────── 9. 其他读者版本和旧报告不受影响 ─────────────────────────
  mock.resetStats()
  await setFilter({ grade: '4' }, '#/report'); await T('report-page').waitFor()
  await T('reader-full').locator('xpath=ancestor::label').click()
  const fb = reports().length
  await T('report-generate').click()
  await waitFor(async () => reports().length > fb && (await T('report-running').count()) === 0, 60000)
  const RF = lastReport()
  const df = await api(id => window.api.report.get(id), RF.id)
  check('其他版本不变', '完整数据版：只调用 1 次 AI（没有口诀 / 变形题）；没有 report_parts 行；详情里 parts / variants 为空；界面没有分段状态区', reqCount().p3 === 1 && reqCount().tricks + reqCount().vgen + reqCount().vcheck === 0 && partsOf(RF.id).length === 0 && df.parts.length === 0 && df.variants.length === 0 && (await T('report-parts').count()) === 0 && RF.options_json === null)
  check('其他版本不变', '完整数据版的报告结构、提示词、核对流程照旧（仍有「教学建议」最后一节）', /^## 教学建议/m.test(RF.markdown) && mock.p3Requests[0].system === L.docsPrompt('p3_report', 'system'))
  // 旧的老师版报告（beta.3 之前生成的：没有分段行）：直接塞一行，确认能正常读、导出
  writeDb(ud, db => db.prepare(`INSERT INTO reports (id, kind, filter_json, markdown, model, title, refs_json, warnings_json, fingerprint, cache_key, template_sig, prompt_version, reader, verify_json)
    VALUES (?, 'report', '{}', ?, 'old-model', '旧老师版', '[]', '[]', 'x', 'x', 'x', 'v2.0', 'teacher', '[]')`).run('00000000-0000-4000-8000-00000000a001', '# 旧老师版\n\n## 易错点（按重要程度排序）\n### 1. 甲\n- **错在哪**：x\n\n## 备课建议\n1. 练。'))
  const old = await api(() => window.api.report.get('00000000-0000-4000-8000-00000000a001'))
  check('旧报告', '没有分段的旧老师版：parts / variants 为空，正文原样，可以复制 / 导出；删句、核对流程照旧', old && old.parts.length === 0 && old.variants.length === 0 && /备课建议/.test(old.markdown) && (await api(() => window.api.report.copyWechat('00000000-0000-4000-8000-00000000a001').then(() => 'ok', e => String(e.message)))) === 'ok')
  const rOld = await api(() => window.api.report.retryPart('00000000-0000-4000-8000-00000000a001', 'tricks', crypto.randomUUID()))
  check('旧报告', '旧报告没有分段，单段重试接口老实拒绝', rOld.ok === false && /没有这一部分/.test(rOld.message))

  // ───────────────────────── 10. 安全：密钥不外泄，页面没有错误 ─────────────────────────
  const leaked = L.procOutput.join('').includes(SECRET)
  check('安全', '整个测试里主进程的输出没有出现 API Key', !leaked)
  check('控制台', '整个测试里页面没有未捕获的错误', ctx.consoleErrors.filter(e => !/DevTools|Autofill/.test(e)).length === 0, JSON.stringify(ctx.consoleErrors).slice(0, 300))
}

const out = path.join(__dirname, 'last-result-m10b.json')
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
