// 分享卡片换模板（M11l）：内容少的口诀卡放大居中；右侧「模板」下拉框换一个模板，同样内容立刻重画（不调用 AI）。全程 mock AI，内容虚构。
// 用法：node tests/e2e/run-m11l.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const crypto = require('node:crypto')
const { check, waitFor, fs, path, work, SECRET, ctx, T, goto, cfgFor, saveCfg, startMock, open, closeApp, L, dataDirOf } = M

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-m11l')
fs.mkdirSync(SHOTS, { recursive: true })
const count = id => T(id).count()
const outDir = () => path.join(dataDirOf(), 'agent-outputs')
const images = () => (fs.existsSync(outDir()) ? fs.readdirSync(outDir()) : []).flatMap(sid => { const f = path.join(outDir(), sid, 'index.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items.filter(i => i.type === 'image').map(i => ({ ...i, abs: path.join(outDir(), sid, i.file) })) : [] })
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  await open(path.join(work, 'userM11l'), { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/assistant'); await T('assistant-page').waitFor()
  await T('assistant-mode').click(); await ctx.page.locator('.ant-dropdown [data-testid=assistant-mode-direct]').click()
  await T('assistant-input').fill('请帮我做一张口诀卡')
  await T('assistant-send').click()
  await waitFor(async () => (await count('assistant-stop')) === 0, 90000)
  check('出卡', '做出了一张口诀卡', await waitFor(async () => images().length === 1, 20000))
  const first = images()[0]
  fs.copyFileSync(first.abs, path.join(SHOTS, 'm11l-before.png'))
  const h0 = hash(first.abs)
  if (await waitFor(async () => (await count('side-unfold')) === 1, 3000)) await T('side-unfold').click()
  check('换模板', '卡片下面有「模板」下拉框，当前是默认模板', await waitFor(async () => (await count('out-card-template-select')) === 1, 10000) && (await T('out-card-template-select').inputValue()) === first.card.templateId)
  const before = mock.agentRequests.length
  await T('out-card-template-select').selectOption('stu-a07')
  check('换模板', '换成 stu-a07 后图片重画、索引里记下新模板', await waitFor(async () => { const i = images()[0]; return i.card.templateId === 'stu-a07' && hash(i.abs) !== h0 }, 20000), JSON.stringify(images()[0]?.card))
  check('换模板', '换模板没有调用 AI', mock.agentRequests.length === before)
  check('换模板', '还是只有一张卡（原地替换）', images().length === 1)
  fs.copyFileSync(images()[0].abs, path.join(SHOTS, 'm11l-after.png'))
  await ctx.page.screenshot({ path: path.join(SHOTS, 'm11l-panel.png') })
  await closeApp()
  await mock.close?.()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-m11l.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  L.finish(path.join(__dirname, 'last-result-m11l.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
